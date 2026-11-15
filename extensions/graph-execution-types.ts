/**
 * Shared vocabulary for graph execution.
 *
 * The graph is walked by the superstep executor in `graph-superstep-executor.ts`;
 * this module holds the types and helpers both it and its callers speak —
 * what a node execution looks like, how a node is run, and how a run ends.
 *
 * There is one execution model. A node produces a result, the result lands in
 * shared state under the node's own id, and edges decide where work goes next.
 * When an implementer reports a blocker, an edge routes back to whoever owns
 * the contract and that agent sees the blocker in the state it receives — no
 * message bus, no dispatcher, no coordination tools inside the agents.
 */

import type { Edge, EndSymbol, GraphNode, GraphState, NodeDef } from "./graph-dsl.ts";
import { END } from "./graph-dsl.ts";
import type { BuiltGraph } from "./graph-dsl.ts";

export type NodeStatus = "ok" | "failed" | "skipped";

export interface NodeExecution {
	/** 1-based position in the walk. A node visited twice appears twice. */
	step: number;
	/** Superstep index (round) when this node ran. Undefined for linear runs. */
	round?: number;
	nodeId: string;
	/** Pi session file this node ran in (agent nodes only). */
	sessionId?: string;
	nodeType: NodeDef["type"];
	/** Agent name for agent nodes; undefined otherwise. */
	agentName?: string;
	status: NodeStatus;
	result: unknown;
	/** Where the edge sent us. "END" when the run finished here. */
	routedTo: string;
	startedAt: number;
	durationMs: number;
	tokens?: number;
	usage?: {input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number};
	toolCalls?: number;
	error?: string;
}

export type GraphRunStatus = "completed" | "aborted" | "max_iterations" | "paused";

export interface GraphRunResult {
	status: GraphRunStatus;
	/** Accumulated state: every visited node's result, keyed by node id. */
	state: GraphState;
	/** Every node execution in order, including repeat visits. */
	history: NodeExecution[];
	/** Node ids in visit order. Repeats included, so cycles are visible. */
	path: string[];
	iterations: number;
	startedAt: number;
	durationMs: number;
	/** Set when status is "aborted". */
	error?: string;
	/** Result of the last node executed, for convenience. */
	finalResult?: unknown;
}

/** Outcome of running one node. */
export interface NodeRunOutcome {
	result: unknown;
	tokens?: number;
	usage?: NodeExecution["usage"];
	toolCalls?: number;
	/**
	 * Marks a failure the graph cannot route around (spawn failure, bad
	 * config). Agent-level failures are NOT technical: an agent reporting it
	 * is blocked is a normal result that edges are expected to handle.
	 */
	technicalFailure?: boolean;
	error?: string;
	/**
	 * Path to the pi session file this node ran in, when the node is an agent.
	 * Absent for human nodes, which share the parent session rather
	 * than owning one. Recorded in the journal for traceability.
	 */
	sessionId?: string;
}

export type NodeRunner = (
	node: GraphNode,
	state: GraphState,
	context: { step: number; runId: string; signal?: AbortSignal },
) => Promise<NodeRunOutcome>;

export const DEFAULT_MAX_ITERATIONS = 45;

/** Reserved state keys the executor writes; node ids may not collide. */
export const RESERVED_STATE_KEYS = new Set(["__error", "__lastNode", "__step"]);

export class GraphExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphExecutionError";
	}
}

export function describeTarget(target: string | EndSymbol): string {
	return target === END ? "END" : String(target);
}

/** Total tokens across every node execution in a run. */
export function totalTokens(result: GraphRunResult): number {
	return result.history.reduce((sum, execution) => sum + (execution.tokens ?? 0), 0);
}

/** Renders the walk as `a -> b -> c -> END`, showing repeats. */
export function formatPath(result: GraphRunResult): string {
	const steps = [...result.path];
	if (result.status === "completed") steps.push("END");
	return steps.join(" -> ");
}
