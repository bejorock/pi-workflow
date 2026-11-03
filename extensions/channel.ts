/**
 * Filesystem channel for child→parent IPC.
 *
 * Children are separate OS processes — they share no memory with the parent
 * extension host. The only viable cross-process transport is the filesystem.
 *
 * Layout:
 *   .pi-workflow/channels/<runId>/
 *     requests/<uuid>.json    — child writes, parent reads + deletes
 *     replies/<uuid>.json     — parent writes, child polls + deletes
 *
 * Every file is written atomically (write to .tmp, rename) so a poller never
 * sees a half-written request.
 *
 * The channel directory is passed to children via the
 * `PI_WORKFLOW_CHANNEL_DIR` environment variable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const PI_WORKFLOW_CHANNEL_DIR_ENV = "PI_WORKFLOW_CHANNEL_DIR";
export const PI_WORKFLOW_RUN_ID_ENV = "PI_WORKFLOW_RUN_ID";
/**
 * Set only when a child is spawned as a graph agent() node (never by the
 * plain `subagent` tool, which has no graph node to identify). This is both
 * the per-node scoping key for node_state requests and the signal the
 * node_state tool uses to refuse outside an actual graph run — a plain
 * `subagent` call has PI_WORKFLOW_CHANNEL_DIR/PI_WORKFLOW_RUN_ID set too, so
 * channel presence alone cannot distinguish the two contexts.
 */
export const PI_WORKFLOW_NODE_ID_ENV = "PI_WORKFLOW_NODE_ID";

// ── Layout ──────────────────────────────────────────────────────────────

export function channelDir(projectDir: string, runId: string): string {
	return path.join(projectDir, ".pi-workflow", "channels", runId);
}

function requestsDir(dir: string): string {
	return path.join(dir, "requests");
}

function repliesDir(dir: string): string {
	return path.join(dir, "replies");
}

export function ensureChannel(dir: string): void {
	fs.mkdirSync(requestsDir(dir), { recursive: true });
	fs.mkdirSync(repliesDir(dir), { recursive: true });
}

// ── Atomic JSON ─────────────────────────────────────────────────────────

function writeAtomicJson(filePath: string, data: unknown): void {
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
	fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

// ── Request / Reply types ───────────────────────────────────────────────

export interface ChannelRequest {
	type: "channel.request";
	id: string;
	createdAt: number;
	runId: string;
	nodeId?: string;
	agent?: string;
	kind: "human" | "supervisor" | "state";
	question: string;
	options?: Array<{ label: string; description?: string }>;
	expectsReply: boolean;
	default?: string;
	questions?: Array<{
		question: string;
		header: string;
		options?: Array<{ label: string; description?: string; preview?: string }>;
		multiSelect?: boolean;
	}>;
	/**
	 * Payload for `kind: "state"` requests only — the node_state tool's
	 * dispatched action. `nodeId` above carries the scoping key (the graph
	 * node's own id, from PI_WORKFLOW_NODE_ID), so this only needs the verb
	 * and its arguments.
	 */
	stateAction?: {
		action: "set" | "merge" | "append" | "get" | "list";
		key?: string;
		value?: unknown;
		meta?: Record<string, unknown>;
	};
}

export interface ChannelReply {
	type: "channel.reply";
	requestId: string;
	createdAt: number;
	source: string;
	answer?: string;
	reason?: string;
	answers?: Array<{
		questionIndex: number;
		kind: "option" | "custom" | "chat" | "multi";
		answer: string | null;
		selected?: string[];
		notes?: string;
	}>;
	/**
	 * Reply payload for `kind: "state"` requests. `stateValue` is the reduced
	 * value — for `get`, the single key's current value; for `list`, the
	 * whole accumulator — never the action envelope that produced it.
	 */
	stateOk?: boolean;
	stateValue?: unknown;
	stateError?: string;
}

// ── Child side: write requests, poll for replies ────────────────────────

/**
 * Child-side client. Used by `ask_user_question` and `ask_supervisor` tool
 * implementations running inside a subagent process.
 */
export class ChannelClient {
	readonly dir: string;
	readonly runId: string;

	constructor(dir: string, runId: string) {
		this.dir = dir;
		this.runId = runId;
		ensureChannel(dir);
	}

	/**
	 * Creates a client from env vars. Returns null when the env is not set
	 * (the agent is not running inside a workflow).
	 */
	static fromEnv(): ChannelClient | null {
		const dir = process.env[PI_WORKFLOW_CHANNEL_DIR_ENV];
		const runId = process.env[PI_WORKFLOW_RUN_ID_ENV];
		if (!dir || !runId) return null;
		return new ChannelClient(dir, runId);
	}

	/**
	 * Sends a question and waits for a reply. Blocks the calling tool.
	 *
	 * For `kind: "supervisor"` the default timeout is 11 minutes (slightly past
	 * the broker-side supervisor expiry). For `kind: "human"` there is NO
	 * timeout — the child polls indefinitely until the parent writes a reply
	 * (user answered) or the process is killed (abort / run cancelled). This
	 * prevents the subagent from self-cancelling while the user is simply slow.
	 *
	 * `pollMs` and `timeoutMs` are tuneable for tests.
	 */
	async ask(
		request: Omit<ChannelRequest, "type" | "id" | "createdAt" | "runId">,
		options: { pollMs?: number; timeoutMs?: number } = {},
	): Promise<ChannelReply> {
		const id = randomUUID();
		const full: ChannelRequest = {
			type: "channel.request",
			id,
			createdAt: Date.now(),
			runId: this.runId,
			...request,
		};

		writeAtomicJson(path.join(requestsDir(this.dir), `${id}.json`), full);

		const pollMs = options.pollMs ?? 500;
		// Human questions wait indefinitely — only a reply file or process kill
		// unblocks the child. Supervisor questions expire slightly past the
		// broker-side 10-minute timeout so the broker always fires first.
		const isHuman = request.kind === "human";
		const controlled = process.env.PI_WORKFLOW_CONTROLLED === "1";
		const timeoutMs = options.timeoutMs ?? (isHuman || controlled ? Infinity : 11 * 60 * 1000);
		const deadline = isHuman ? Infinity : Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const replyFile = path.join(repliesDir(this.dir), `${id}.json`);
			const reply = readJson<ChannelReply>(replyFile);
			if (reply) {
				try {
					fs.unlinkSync(replyFile);
				} catch {
					/* best effort */
				}
				return reply;
			}
			await sleep(pollMs);
		}

		return {
			type: "channel.reply",
			requestId: id,
			createdAt: Date.now(),
			source: "timeout",
			reason: "No reply received within the timeout period.",
		};
	}
}

// ── Parent side: poll for requests, write replies ───────────────────────

export interface ParentPollerOptions {
	/** Handler called for each incoming request. */
	onRequest: (request: ChannelRequest) => void;
	/** Polling interval. Default 500ms. */
	pollMs?: number;
}

/**
 * Parent-side poller. Scans the requests directory, calls the handler for
 * each new file, and deletes it so it is not re-processed.
 *
 * Tracks every request ID it has dispatched but not yet replied to.
 * stop(reason) writes a cancelled reply for each outstanding request so
 * children that are polling indefinitely (e.g. human questions) unblock
 * cleanly before the channel directory is deleted.
 */
export class ChannelPoller {
	private readonly dir: string;
	private readonly onRequest: (request: ChannelRequest) => void;
	private readonly pollMs: number;
	private interval: ReturnType<typeof setInterval> | null = null;
	private seen = new Set<string>();
	/** Request IDs dispatched via onRequest but not yet replied to. */
	private pending = new Set<string>();

	constructor(dir: string, options: ParentPollerOptions) {
		this.dir = dir;
		this.onRequest = options.onRequest;
		this.pollMs = options.pollMs ?? 500;
	}

	start(): void {
		if (this.interval) return;
		this.interval = setInterval(() => this.poll(), this.pollMs);
		this.interval.unref?.();
	}

	/**
	 * Stops the polling interval and writes a cancelled reply for every
	 * outstanding request that was dispatched but never replied to.
	 * This unblocks children that are waiting for a reply (e.g. human
	 * questions polling indefinitely) before the channel dir is deleted.
	 */
	stop(reason = "run ended"): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		// Write a cancelled reply for every unresolved request so the child
		// poll loop unblocks instead of spinning against a deleted directory.
		for (const requestId of this.pending) {
			this.reply(requestId, { source: "cancelled", reason });
		}
		this.pending.clear();
	}

	/** Exposed for tests: run one poll cycle synchronously. */
	poll(): void {
		const dir = requestsDir(this.dir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // Directory not yet created; that's fine.
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			if (this.seen.has(entry.name)) continue;

			const filePath = path.join(dir, entry.name);
			const request = readJson<ChannelRequest>(filePath);
			if (!request) continue;

			this.seen.add(entry.name);
			this.pending.add(request.id);
			try {
				fs.unlinkSync(filePath);
			} catch {
				/* best effort */
			}
			this.onRequest(request);
		}
	}

	/**
	 * Writes a reply for a request. The child polls for this file.
	 * Best-effort: if the channel directory has already been cleaned up,
	 * the write fails silently rather than crashing the process.
	 */
	reply(requestId: string, reply: Omit<ChannelReply, "type" | "requestId" | "createdAt">): void {
		const full: ChannelReply = {
			type: "channel.reply",
			requestId,
			createdAt: Date.now(),
			...reply,
		};
		try {
			writeAtomicJson(path.join(repliesDir(this.dir), `${requestId}.json`), full);
		} catch {
			// Channel dir was already cleaned up (run ended). The child process
			// has either already exited or will exit when it can't find the reply.
			// Never let a stale reply attempt crash the parent process.
		}
		this.pending.delete(requestId);
	}
}

// ── Cleanup ─────────────────────────────────────────────────────────────

/**
 * Removes a run's channel directory. Called when a run finishes normally.
 */
export function cleanupChannel(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Startup sweep: cleans up orphaned channel directories left by crashed
 * runs. Called once when the extension loads.
 */
export function sweepOrphanedChannels(projectDir: string): void {
	const channelsRoot = path.join(projectDir, ".pi-workflow", "channels");
	try {
		const entries = fs.readdirSync(channelsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(channelsRoot, entry.name);
			cleanupChannel(dir);
		}
	} catch {
		/* channels dir doesn't exist yet — nothing to sweep */
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
