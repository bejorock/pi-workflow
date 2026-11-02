/**
 * The body of a graph run, separated from the `workflow` tool that starts it.
 *
 * The tool validates and then detaches: it returns a run id immediately so the
 * turn can end and the user is not blocked. Everything that happens after that
 * point lives here, including building the report that is delivered back into
 * the conversation once the walk finishes.
 *
 * The split exists because the report is no longer a tool result. It arrives
 * later as an injected message, so it has to carry everything the inline result
 * used to carry — path, per-node outcomes, escalations, budget warnings — with
 * no surrounding tool-call context to lean on.
 */

import type { GraphState } from "./graph-dsl.ts";
import {
	formatPath,
	runSuperstepGraph,
	type GraphRunResult,
	type NodeExecution,
	type SuperstepResumeInput,
} from "./graph-executor.ts";
import type { GraphScriptResult } from "./graph-validator.ts";
import { GraphJournal } from "./graph-journal.ts";
import type { RequestBroker } from "./request-broker.ts";
import { ChannelPoller, cleanupChannel, ensureChannel, PI_WORKFLOW_CHANNEL_DIR_ENV, PI_WORKFLOW_RUN_ID_ENV } from "./channel.ts";
import type { ChannelRequest, ChannelReply } from "./channel.ts";
import type { GraphDisplayBridge } from "./graph-display-bridge.ts";
import { GraphRunContext } from "./graph-run-context.ts";
import type { NodeStateBuffers, NodeStateAction } from "./node-state-reducer.ts";
import type { NodeRunner } from "./graph-executor.ts";
import { saveWorkflowScript } from "./workflow-library.ts";
import type { WorkflowMeta } from "./workflow-display-types.ts";

export interface GraphRunReport {
	runId: string;
	name: string;
	status: GraphRunResult["status"];
	iterations: number;
	nodeExecutions: number;
	durationMs: number;
	/** The full human-readable report, delivered back into the conversation. */
	text: string;
	savedAs?: string;
	result: GraphRunResult;
	budget: ReturnType<GraphRunContext["summary"]>["budget"];
}

export interface GraphRunOptions {
	runId: string;
	cwd: string;
	script: string;
	scriptHash: string;
	meta: WorkflowMeta & { name: string; description: string };
	graph: GraphScriptResult["graph"];
	journalDir: string;
	signal?: AbortSignal;
	maxIterations?: number;
	tokenBudget?: number;
	useWorktree?: boolean;
	saveWorkflow?: boolean;
	resume?: SuperstepResumeInput;
	/**
	 * Builds the node runner once the run context exists.
	 *
	 * It is a factory rather than a value because the runner needs the context's
	 * `cwd` (the worktree path when the run is isolated) and its artifact
	 * settings. Passing an already-built runner would silently run every agent
	 * in the project tree, defeating the isolation the caller asked for.
	 */
	makeRunNode: (context: GraphRunContext) => NodeRunner;
	display?: GraphDisplayBridge;
	/** The broker carries judgement requests. Present when background runs need ask_user_question/ask_supervisor. */
	broker?: RequestBroker;
	onNodeStart?: (info: { step: number; nodeId: string; nodeType: string; round?: number }) => void;
	onNodeComplete?: (execution: NodeExecution) => void;
	onRunComplete?: (result: GraphRunResult) => void;
}

function summariseResult(value: unknown, limit = 400): string {
	if (value === null || value === undefined) return "(no result)";
	const text = typeof value === "string" ? value : String(value);
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Renders the walk with each node's outcome.
 *
 * The path is the most useful thing to report: it shows which agents ran,
 * in what order, and where escalations sent work back.
 */
export function formatHistory(history: NodeExecution[]): string {
	if (history.length === 0) return "(no nodes ran)";

	return history
		.map((execution) => {
			const who = execution.agentName
				? `${execution.nodeId} (${execution.agentName})`
				: execution.nodeId;
			const arrow = execution.routedTo ? ` -> ${execution.routedTo}` : "";
			const marker = execution.status === "failed" ? " [failed]" : "";
			const detail = execution.error ? ` — ${execution.error}` : "";
			return `  ${execution.step}. ${who}${marker}${arrow}${detail}`;
		})
		.join("\n");
}

/**
 * Reports blocked outcomes separately.
 *
 * A blocked agent is the signal this whole design exists to surface: it
 * means an agent hit a real wall and said so instead of faking progress.
 * Burying it in the walk would waste the escalation.
 */
export function formatEscalations(state: GraphState): string {
	const escalations: string[] = [];

	for (const [nodeId, value] of Object.entries(state)) {
		if (!value || typeof value !== "object") continue;
		const result = value as { status?: string; blockedOn?: string; reason?: string };
		if (result.status !== "blocked") continue;

		const target = result.blockedOn ? ` (blocked on: ${result.blockedOn})` : "";
		const reason = result.reason ? ` — ${result.reason}` : "";
		escalations.push(`  ${nodeId}${target}${reason}`);
	}

	return escalations.join("\n");
}

/**
 * Handles a node_state channel request on the host side.
 *
 * Reduces the action into the per-node buffer, journals write actions, and
 * replies — all synchronously. Returns true if the request was a state
 * request (and was fully handled); false otherwise so the caller knows to
 * fall through to the human/supervisor broker bridge.
 *
 * Extracted from the poller's onRequest closure so the isolation property
 * (a state request never reaches the broker) can be tested directly.
 */
export function dispatchStateRequest(
	request: ChannelRequest,
	ctx: {
		runId: string;
		buffers: NodeStateBuffers;
		journal: GraphJournal;
		reply: (requestId: string, payload: Omit<ChannelReply, "type" | "requestId" | "createdAt">) => void;
	},
): boolean {
	if (request.kind !== "state" || !request.stateAction) return false;

	const nodeId = request.nodeId ?? "(unknown)";
	const action: NodeStateAction = request.stateAction;
	const reduced = ctx.buffers.apply(nodeId, action);
	let replyValue: unknown;
	if (reduced.ok) {
		// Journal write actions (set/merge/append) for resume replay.
		// get/list are read-only — nothing to replay.
		if (action.action !== "get" && action.action !== "list") {
			ctx.journal.recordStateAction({
				runId: ctx.runId,
				nodeId,
				action: action.action,
				...(action.key !== undefined ? { key: action.key } : {}),
				...(action.value !== undefined ? { value: action.value } : {}),
				...(action.meta ? { meta: action.meta } : {}),
			});
		}
		replyValue = action.action === "list"
			? ctx.buffers.readAll(nodeId)
			: ctx.buffers.read(nodeId, action.key ?? "");
	}
	ctx.reply(request.id, {
		source: "state",
		stateOk: reduced.ok,
		stateValue: replyValue,
		stateError: reduced.error,
	});
	return true;
}

/**
 * Walks the graph and builds its report.
 *
 * Never throws for an aborted run: a detached run has no tool call to fail,
 * so an abort is reported in the returned text like any other outcome. The
 * caller decides how to surface it.
 */
export async function executeGraphRun(options: GraphRunOptions): Promise<GraphRunReport> {
	const { runId, meta, graph, journalDir, scriptHash, display, broker } = options;
	const nodeIds = [...graph.nodes.keys()];

	// Set up the filesystem channel so child processes can reach the broker.
	const chDir = `${options.cwd}/.pi-workflow/channels/${runId}`;
	ensureChannel(chDir);

	const channelEnv: Record<string, string> = {
		[PI_WORKFLOW_CHANNEL_DIR_ENV]: chDir,
		[PI_WORKFLOW_RUN_ID_ENV]: runId,
	};

	const context = new GraphRunContext({
		cwd: options.cwd,
		runId,
		tokenBudget: options.tokenBudget,
		useWorktree: options.useWorktree,
		extraEnv: channelEnv,
	});

	let poller: ChannelPoller | undefined;
	if (broker) {
		poller = new ChannelPoller(chDir, {
			onRequest: (request) => {
				// node_state dispatch: reduce synchronously, reply, and return before
				// reaching the broker. A state request never enters broker.pending,
				// never triggers supervisor detach, never appears in a batch — it is
				// structurally isolated from human/supervisor handling.
				if (dispatchStateRequest(request, {
					runId,
					buffers: context.nodeStateBuffers,
					journal,
					reply: (id, payload) => poller!.reply(id, payload),
				})) {
					return;
				}

				// Bridge: channel request → broker request → broker answer → channel reply.
				// Pass request.id through so the broker uses the same UUID the child
				// wrote, keeping the id consistent for markInlineDelivered lookups.
				void broker
					.ask({
						id: request.id,
						runId: request.runId,
						nodeId: request.nodeId,
						agent: request.agent,
						kind: request.kind,
						questions: request.questions ?? [
							{
								question: request.question,
								header: request.agent ?? "Workflow Agent",
								options: request.options,
							},
						],
						default: request.default,
						expectsReply: request.expectsReply,
					})
					.then((result) => {
						poller!.reply(request.id, {
							source: result.source,
							answer: result.text,
							reason: result.reason,
							answers: result.answers?.questions,
						});
					});
			},
		});
		poller.start();
	}

	const runNode = options.makeRunNode(context);

	const journal = GraphJournal.create({
		journalDir,
		runId,
		scriptHash,
		name: meta.name,
		description: meta.description,
		entry: graph.entry,
		nodeIds,
		initialState: graph.initialState,
	});

	const onNodeStart = (info: {
		step: number;
		nodeId: string;
		nodeType: string;
		round?: number;
	}): void => {
		const def = graph.nodes.get(info.nodeId)?.def;
		display?.nodeStarted({
			...info,
			agentName: def?.type === "agent" ? def.agentName : undefined,
		});
		options.onNodeStart?.(info);
	};

	const onNodeComplete = (execution: NodeExecution): void => {
		journal.recordNode(execution);
		context.recordNode(execution);
		display?.nodeCompleted(execution);
		options.onNodeComplete?.(execution);
	};

	let result: GraphRunResult;
	/** Node executions. Diverges from iterations only for superstep runs. */
	let nodeExecutions: number;
	try {
		const superstepResult = await runSuperstepGraph(graph, {
			runId,
			signal: options.signal,
			maxIterations: options.maxIterations,
			resume: options.resume,
			runNode,
			onNodeStart,
			onNodeComplete,
			onRoundComplete: (info) => {
				// The barrier marker is what makes a crashed parallel run
				// resumable: it records the frontier and readiness counters.
				journal.recordRoundComplete(info);
				display?.roundComplete(info);
			},
		});
		nodeExecutions = superstepResult.nodeExecutions;
		result = superstepResult;
	} finally {
		context.cleanup();
		poller?.stop();
		cleanupChannel(chDir);
	}

	journal.recordResult({
		status: result.status,
		iterations: result.iterations,
		nodeExecutions,
		durationMs: result.durationMs,
		error: result.error,
	});
	// The detached graph-tool caller stages this rendered report before it
	// completes the display run. Completing here would emit a manager `complete`
	// event before the report exists, then emit it again after staging.
	options.onRunComplete?.(result);

	// Only persist a graph that actually worked: saving a broken one
	// would offer it for reuse under a name that implies it runs.
	let savedAs: string | undefined;
	if (options.saveWorkflow && result.status === "completed") {
		try {
			savedAs = saveWorkflowScript(options.cwd, options.script, meta).name;
		} catch {
			// Reported below; a save failure must not fail the run.
		}
	}

	const summary = context.summary();
	const lines: string[] = [];

	// A superstep run reports both counters: rounds measure how deep the
	// coordination went, node executions measure how much work happened.
	// Collapsing them would make a 5-node round read as a single step.
	const completedSummary = `${nodeExecutions} node execution${nodeExecutions === 1 ? "" : "s"} across ${result.iterations} round${result.iterations === 1 ? "" : "s"}`;
	const heading =
		result.status === "completed"
			? `Graph "${meta.name}" completed in ${completedSummary}.`
			: result.status === "max_iterations"
				? `Graph "${meta.name}" stopped at the round cap.`
				: `Graph "${meta.name}" aborted.`;
	lines.push(heading);

	if (result.error) lines.push(`\n${result.error}`);

	lines.push(`\nPath: ${formatPath(result)}`);
	lines.push(`\nNodes:\n${formatHistory(result.history)}`);

	const escalations = formatEscalations(result.state);
	if (escalations) {
		lines.push(`\nEscalations reported:\n${escalations}`);
	}

	if (result.status === "completed") {
		lines.push(`\nFinal result:\n${summariseResult(result.finalResult)}`);
	}

	for (const warning of summary.warnings) {
		const finalBudget = summary.budget;
		if (finalBudget.total !== null && finalBudget.spent !== warning.spent) {
			lines.push(
				`\n⚠ ${warning.message}\n` +
					`Final token usage: ${finalBudget.spent}/${finalBudget.total} tokens.`,
			);
		} else {
			lines.push(`\n⚠ ${warning.message}`);
		}
	}
	if (summary.worktreeSkipped) {
		lines.push(`\nNote: ${summary.worktreeSkipped}`);
	}
	if (journal.writeErrors.length > 0) {
		lines.push(`\nNote: the run journal could not be written (${journal.writeErrors[0]}).`);
	}

	if (savedAs) {
		lines.push(`\nSaved as "${savedAs}"; re-run it later with loadWorkflow: "${savedAs}".`);
	} else if (options.saveWorkflow && result.status !== "completed") {
		lines.push("\nNot saved: only graphs that complete successfully are persisted.");
	}

	lines.push(`\nRun ID: ${runId}${result.status !== "completed" ? " (resumable)" : ""}`);

	return {
		runId,
		name: meta.name,
		status: result.status,
		iterations: result.iterations,
		nodeExecutions,
		durationMs: result.durationMs,
		text: lines.join("\n"),
		savedAs,
		result,
		budget: summary.budget,
	};
}
