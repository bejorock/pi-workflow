/**
 * Bridges graph runs into the display layer used by /workflows, the task
 * panel, and the workflow_status tool.
 *
 * The display model predates graphs: it thinks in terms of a run containing
 * numbered agents, optionally grouped into phases. A graph is a walk over
 * nodes, so the mapping is:
 *
 *   graph run       -> run
 *   node execution  -> agent entry (one per visit, so loops stay visible)
 *   node id         -> label
 *
 * Phases are left empty. A graph has no linear phase structure, and
 * inventing one would misrepresent a cyclic walk as a pipeline.
 */

import * as path from "node:path";
import type { GraphState } from "./graph-dsl.ts";
import type { NodeExecution } from "./graph-executor.ts";
import type { WorkflowManager } from "./workflow-manager.ts";

/**
 * The subset of a run result the display needs.
 *
 * Both the linear (`GraphRunResult`) and superstep (`SuperstepRunResult`)
 * executors satisfy this, so the bridge works with either without importing
 * both result types.
 */
export interface CompletedRunView {
	path: string[];
	finalResult?: unknown;
	error?: string;
	// Declared so a full result object from either executor assigns cleanly.
	// Unused by the display, which only needs path/finalResult/error.
	status?: string;
	state?: GraphState;
	history?: NodeExecution[];
	iterations?: number;
	nodeExecutions?: number;
	startedAt?: number;
	durationMs?: number;
}

export interface GraphDisplayOptions {
	manager: WorkflowManager;
	runId: string;
	name: string;
	/** Required: the display model treats it as non-optional metadata. */
	description: string;
	script?: string;
	cwd?: string;
	abortController?: AbortController;
}

/**
 * Strips reasoning blocks and markdown scaffolding from an agent's reply.
 *
 * Agent output regularly begins with `<think></think>` or a heading, which
 * would otherwise fill the preview with text that says nothing about what
 * the agent actually concluded.
 */
function cleanForPreview(text: string): string {
	return (
		text
			.replace(/<think>[\s\S]*?<\/think>/g, " ")
			.replace(/<\/?think>/g, " ")
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/\*\*/g, "")
			.replace(/`/g, "")
			.replace(/\s+/g, " ")
			// Headings must also be stripped after whitespace collapsing: a
			// reply opening with "<think></think>## Answer" leaves the heading
			// mid-line, where the line-anchored pass above cannot see it.
			.replace(/(^|\s)#{1,6}\s+/g, "$1")
			.trim()
	);
}

function previewOf(value: unknown, limit = 60): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : String(value);
	const collapsed = cleanForPreview(text);
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Escalations are the reason this system exists, so a blocked result leads
 * with that fact rather than with whatever prose preceded it.
 */
function resultPreview(result: unknown): string {
	if (result && typeof result === "object") {
		const r = result as { status?: string; blockedOn?: string; reason?: string; answer?: string };
		if (r.status === "blocked") {
			const target = r.blockedOn ? ` on ${r.blockedOn}` : "";
			const why = r.reason ? `: ${previewOf(r.reason, 40)}` : "";
			return `blocked${target}${why}`;
		}
		if (r.answer !== undefined) return `answered "${previewOf(r.answer, 30)}"`;
	}
	return previewOf(result);
}

/**
 * Describes where a node's result went, for display.
 *
 * Routing is the interesting part of a graph run — it is what distinguishes
 * a coordination loop from a pipeline — so it belongs in the label rather
 * than being dropped.
 */
function routeSuffix(execution: NodeExecution): string {
	if (!execution.routedTo) return "";
	return `→ ${execution.routedTo}`;
}

/**
 * Reports graph progress to the display layer.
 *
 * Every method is defensive: display is an observer, and a rendering
 * problem must never take down a run that is otherwise working.
 */
export class GraphDisplayBridge {
	private readonly manager: WorkflowManager;
	private readonly runId: string;
	private readonly cwd?: string;
	/** Display ids are 1-based and increment per visit, not per node. */
	private nextAgentId = 1;
	private readonly activeIds = new Map<number, number>();

	constructor(options: GraphDisplayOptions) {
		this.manager = options.manager;
		this.runId = options.runId;
		this.cwd = options.cwd;

		try {
			this.manager.registerRun(
				options.runId,
				{ name: options.name, description: options.description },
				options.abortController,
				options.script && options.cwd ? { script: options.script, cwd: options.cwd } : undefined,
			);
		} catch {
			// A run that cannot be displayed still needs to execute.
		}
	}

	nodeStarted(info: {
		step: number;
		nodeId: string;
		nodeType: string;
		agentName?: string;
		/** Superstep index. Present only for parallel (superstep) runs. */
		round?: number;
	}): void {
		const id = this.nextAgentId++;
		// Keyed by step, which stays unique per execution even when several
		// nodes run concurrently, so parallel nodes never collide here.
		this.activeIds.set(info.step, id);

		// Every run is round-based now, so tagging each label with its round
		// would add noise to the common one-node-per-round case. Which nodes
		// shared a wave is already reported by roundComplete().
		const label = info.agentName
			? `${info.nodeId} (${info.agentName})`
			: info.nodeType === "fn"
				? `${info.nodeId} [fn]`
				: info.nodeType === "command"
					? `${info.nodeId} [command]`
					: info.nodeId;

		try {
			this.manager.markAgentStart(this.runId, 0, {
				id,
				nodeId: info.nodeId,
				nodeType: info.nodeType,
				label,
				prompt: `${info.nodeType} node "${info.nodeId}"`,
				status: "running",
			});
			// Start watching this agent's session file up front so its
			// conversation streams live into the /workflows detail view while
			// the agent is still working, not only after it finishes. The path
			// is deterministic per (run, node); the watcher skips it until the
			// file appears (pi writes it on spawn). human() nodes
			// don't own a session file, so they are skipped.
			if (info.nodeType === "agent" && this.cwd) {
				const sessionPath = path.join(
					this.cwd,
					".pi-workflow",
					"sessions",
					this.runId,
					`${info.nodeId}.jsonl`,
				);
				this.manager.watchSession(this.runId, id, sessionPath);
			}
		} catch {
			// Ignore display failures.
		}
	}

	/**
	 * Reports a completed superstep barrier.
	 *
	 * A parallel run's shape is invisible from node events alone — this is what
	 * shows which nodes ran together and what the run is waiting on next.
	 */
	roundComplete(info: { round: number; nodeIds: string[]; nextFrontier: string[] }): void {
		const ran = info.nodeIds.join(", ");
		const next =
			info.nextFrontier.length > 0 ? info.nextFrontier.join(", ") : "(none — run finishing)";
		this.log(`Round ${info.round} complete: ran ${ran} → next ${next}`);
	}

	nodeCompleted(execution: NodeExecution): void {
		const id = this.activeIds.get(execution.step) ?? this.nextAgentId++;
		this.activeIds.delete(execution.step);

		const status = execution.status === "failed" ? "error" : "done";
		// Routing goes first: it is what distinguishes a coordination loop from
		// a pipeline, and putting it last meant long agent prose truncated it
		// away exactly when the run was most interesting.
		const route = routeSuffix(execution).trim();
		const body = resultPreview(execution.result);
		const preview = route ? `${route}  ${body}` : body;

		try {
			const agent = this.manager.getRun(this.runId)?.snapshot.agents.find(a => a.id === id);
			if (agent) agent.routedTo = execution.routedTo;
			this.manager.markAgentEnd(
				this.runId,
				id,
				status,
				preview,
				execution.error,
				execution.tokens,
				execution.durationMs,
			);
			// Watch the agent's persisted pi session so the /workflows navigator
			// can surface its conversation on demand. Available only for agent
			// nodes (they own a session file); human nodes have none.
			if (execution.sessionId) {
				this.manager.watchSession(this.runId, id, execution.sessionId);
			}
		} catch {
			// Ignore display failures.
		}
	}

	/**
	 * Accepts either executor's result: only the fields common to both are
	 * used, so the bridge does not care which executor produced the run.
	 */
	runCompleted(result: CompletedRunView): void {
		try {
			// The path is the single most useful line for a human scanning a
			// finished run: it shows which agents ran and where work looped.
			this.manager.log(this.runId, `Path: ${result.path.join(" → ")}`);
			if (result.status === "aborted" || this.manager.getRun(this.runId)?.status === "stopped") {
				this.manager.stopRun(this.runId);
			} else this.manager.completeRun(this.runId, result.finalResult, result.error);
		} catch {
			// Ignore display failures.
		}
	}

	/**
	 * Reports a run that crashed rather than finishing with a result.
	 *
	 * A detached run has no tool call left to fail, so an unexpected throw has
	 * to be recorded here or it disappears entirely: the run would sit at
	 * "running" forever and nothing would ever be delivered.
	 */
	runFailed(error: string): void {
		try {
			this.manager.completeRun(this.runId, undefined, error);
		} catch {
			// Ignore display failures.
		}
	}

	log(message: string): void {
		try {
			this.manager.log(this.runId, message);
		} catch {
			// Ignore display failures.
		}
	}
}
