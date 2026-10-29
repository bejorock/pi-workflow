/**
 * The request broker.
 *
 * Every request for judgement — whether from a `human()` node in-process or an
 * `ask_user_question` / `ask_supervisor` tool call from a child process — passes
 * through here. The broker owns the queue, the coalescing window, and the
 * expiry rules; the transports (in-process direct call, filesystem polling)
 * and the sinks (the user's TUI, the main agent's conversation) are adapters.
 *
 * The design has three asymmetries, all deliberate:
 *
 * 1. Human requests never expire; supervisor requests do (10 min).
 *    The user is watching the run and a countdown that silently picks a
 *    default while they're reading the question is hostile. The supervisor
 *    (the main agent) may answer in prose without calling the reply tool, and
 *    nobody is watching a child wait on it.
 *
 * 2. Coalescing batches near-simultaneous asks, not distant ones.
 *    A fan-out where several agents ask at once collapses into one tabbed
 *    dialog. An agent asking 30 seconds later still queues, because batching
 *    it would hold the first asker hostage for an answer that may never come.
 *
 * 3. Cancellation is per-request, not per-batch.
 *    If the user dismisses a dialog or a run aborts, only that request is
 *    cancelled; the rest of the queue is untouched.
 */

/** A single question, in the rpiv-ask-user-question schema. */
export interface BrokerQuestion {
	question: string;
	header: string;
	options?: Array<{ label: string; description?: string; preview?: string }>;
	multiSelect?: boolean;
}

export type RequestKind = "human" | "supervisor" | "state";

export type RequestSource =
	| "human" // a real answer from the user
	| "supervisor" // the main agent answered via workflow_reply
	| "default" // nobody answered; fell to the default
	| "cancelled" // dismissed or aborted
	| "timeout"; // deadline expired (supervisor only)

export interface BrokerAnswer {
	questions: Array<{
		questionIndex: number;
		kind: "option" | "custom" | "chat" | "multi";
		answer: string | null;
		selected?: string[];
		notes?: string;
	}>;
	cancelled: boolean;
}

export interface BrokerResult {
	requestId: string;
	source: RequestSource;
	answers?: BrokerAnswer;
	/** Free-text answer for single-question supervisor requests. */
	text?: string;
	reason?: string;
}

export interface PendingRequest {
	id: string;
	runId: string;
	nodeId?: string;
	agent?: string;
	kind: RequestKind;
	questions: BrokerQuestion[];
	default?: string;
	expectsReply: boolean;
	createdAt: number;
	expiresAt?: number;
	/**
	 * Set when the subagent tool has already embedded the question inline in
	 * its tool-result content. The broker sink skips the redundant sendMessage
	 * for this request so the main agent does not see the same question twice.
	 * The entry stays pending so workflow_reply can still resolve it normally.
	 */
	inlineDelivered?: boolean;
}

export type ResolveFn = (result: BrokerResult) => void;

export interface BrokerOptions {
	/**
	 * Window during which arriving requests join the same dialog as extra tabs.
	 * Default 300ms. Too long holds early askers hostage; too short never
	 * coalesces anything.
	 */
	coalesceMs?: number;
	/** Timeout for supervisor requests. Default 10 minutes. */
	supervisorTimeoutMs?: number;
}

const DEFAULT_COALESCE_MS = 300;
const DEFAULT_SUPERVISOR_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The broker owns no timers of its own. It is driven by a `tick()` call from
 * the sink (the UI loop or a poller), which keeps it testable: a test can
 * advance time by calling `tick()` rather than waiting.
 *
 * Coalescing is implemented as a short hold: when the first request arrives,
 * a batch opens and stays open for `coalesceMs`. Requests arriving in that
 * window join the batch. When the window closes, the batch is handed to the
 * sink for rendering.
 */
export class RequestBroker {
	private pending = new Map<string, { request: PendingRequest; resolve: ResolveFn }>();
	private queue: PendingRequest[] = [];
	private currentBatch: PendingRequest[] | null = null;
	private batchClosesAt = 0;
	private readonly coalesceMs: number;
	private readonly supervisorTimeoutMs: number;
	private nextId = 0;

	/** Set by the sink when it starts processing a batch. */
	private onBatchReady: ((batch: PendingRequest[]) => void) | null = null;

	constructor(options: BrokerOptions = {}) {
		this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
		this.supervisorTimeoutMs = options.supervisorTimeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS;
	}

	/**
	 * Submits a request and returns a promise that resolves with the answer.
	 *
	 * The caller (a `human()` node, an `ask_user_question` tool, an `ask_supervisor`
	 * tool) blocks on this promise — which is correct, because a question is
	 * asked by the thing that needs the answer, and it should not proceed
	 * until it has one.
	 */
	ask(request: Omit<PendingRequest, "id" | "createdAt" | "expiresAt"> & { id?: string }): Promise<BrokerResult> {
		const id = request.id ?? `req-${++this.nextId}`;
		const createdAt = Date.now();
		const expiresAt =
			request.kind === "supervisor" && request.expectsReply
				? createdAt + this.supervisorTimeoutMs
				: undefined;

		const full: PendingRequest = { ...request, id, createdAt, expiresAt };
		const promise = new Promise<BrokerResult>((resolve) => {
			this.pending.set(id, { request: full, resolve });
			this.addToBatch(full);
		});

		return promise;
	}

	private addToBatch(request: PendingRequest): void {
		if (this.currentBatch === null) {
			this.currentBatch = [request];
			this.batchClosesAt = Date.now() + this.coalesceMs;
		} else {
			this.currentBatch.push(request);
		}
	}

	/**
	 * Advances the broker by one tick.
	 *
	 * Closes the coalescing window if it has elapsed and hands the batch to the
	 * sink. Expires supervisor requests whose deadline has passed. Returns the
	 * number of actions taken so a poller can back off when idle.
	 */
	tick(): number {
		let actions = 0;

		// Close the coalescing window.
		if (this.currentBatch !== null && Date.now() >= this.batchClosesAt) {
			const batch = this.currentBatch;
			this.currentBatch = null;
			actions++;
			this.onBatchReady?.(batch);
		}

		// Expire supervisor requests.
		for (const [id, { request, resolve }] of this.pending) {
			if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) {
				this.pending.delete(id);
				actions++;
				resolve({
					requestId: id,
					source: "timeout",
					text: request.default,
					reason: `No supervisor answer within ${Math.round(this.supervisorTimeoutMs / 1000)}s; proceed on your best judgement or emit BLOCKED_ON.`,
				});
			}
		}

		return actions;
	}

	/**
	 * Registers the sink: the function that renders a batch of requests.
	 *
	 * The broker does not know about `ctx.ui` or `sendMessage`. It hands the
	 * sink a batch and expects each request in it to be resolved via
	 * `resolve()` or `cancel()` by the sink.
	 */
	onBatch(handler: (batch: PendingRequest[]) => void): void {
		this.onBatchReady = handler;
	}

	/**
	 * Resolves a request with an answer.
	 *
	 * Called by the user sink when the user submits the dialog, or by the
	 * supervisor sink when the main agent calls `workflow_reply`.
	 */
	resolve(requestId: string, result: Omit<BrokerResult, "requestId">): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		this.pending.delete(requestId);
		entry.resolve({ requestId, ...result });
	}

	/** Whether a request still awaits an answer (used by optional answer sinks). */
	hasPending(requestId: string): boolean {
		return this.pending.has(requestId);
	}

	/**
	 * Marks a supervisor request as already delivered inline (embedded in the
	 * subagent tool result). The broker sink will skip the redundant sendMessage
	 * for this request while still leaving it pending so workflow_reply can
	 * resolve it and the child gets its answer.
	 */
	markInlineDelivered(requestId: string): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		entry.request.inlineDelivered = true;
	}

	/**
	 * Cancels a request: dismissed dialog, aborted run, etc.
	 *
	 * A human request with a `default` resolves with it; without one, it
	 * resolves cancelled. A supervisor request always resolves cancelled —
	 * there is no sensible default for "should I proceed?".
	 */
	cancel(requestId: string, reason = "cancelled"): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		this.pending.delete(requestId);
		const { request } = entry;

		if (request.kind === "human" && request.default !== undefined) {
			entry.resolve({
				requestId,
				source: "default",
				text: request.default,
				reason,
			});
		} else {
			entry.resolve({
				requestId,
				source: "cancelled",
				reason,
			});
		}
	}

	/**
	 * Cancels every pending request for a run (e.g. when it aborts).
	 */
	cancelRun(runId: string, reason = "run aborted"): void {
		const ids = [...this.pending.entries()]
			.filter(([, { request }]) => request.runId === runId)
			.map(([id]) => id);
		for (const id of ids) this.cancel(id, reason);
	}

	/** Requests awaiting an answer, for the `/wf` status widget. */
	listPending(): PendingRequest[] {
		return [...this.pending.values()].map((e) => e.request);
	}

	listPendingForRun(runId: string): PendingRequest[] {
		return [...this.pending.values()]
			.filter((e) => e.request.runId === runId)
			.map((e) => e.request);
	}

	private intervalId: ReturnType<typeof setInterval> | null = null;

	/**
	 * Starts the tick loop that drives coalescing windows and expiry checks.
	 *
	 * `unref`ed so it never keeps the process alive on its own. The interval is
	 * fast enough (200ms) to close a 300ms coalescing window within the same
	 * human-perceptible moment, but slow enough to be invisible.
	 */
	start(intervalMs = 200): void {
		if (this.intervalId) return;
		this.intervalId = setInterval(() => this.tick(), intervalMs);
		this.intervalId.unref?.();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** For tests: whether the broker has no outstanding requests. */
	isIdle(): boolean {
		return this.pending.size === 0 && this.currentBatch === null;
	}
}
