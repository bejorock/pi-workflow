/**
 * Graph executor — walks a graph in topological rounds (supersteps), with AND
 * fan-in readiness and wave reset on back-edges.
 *
 * There is one execution model. A graph whose nodes each have a single
 * outgoing edge walks one node per round, which is an ordinary sequential
 * walk; a node with several outgoing edges fans out and its branches run
 * concurrently in the same round. Fan-out is a property of the graph, not a
 * separate mode.
 *
 * Model (see docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md, Decisions 5 & 6):
 *
 *   frontier = { entry }
 *   while frontier not empty:
 *     round += 1                          # maxIterations counts ROUNDS
 *     outcomes = await Promise.all(frontier.map(runNode))   # barrier isolation
 *     for each outcome: state[id] = result                # each under its own id
 *     frontier = computeNextFrontier(fired edges)         # in-degree + wave reset
 *
 * Readiness is AND fan-in: a node runs only when ALL its incoming edges'
 * sources have fired toward it. A fan-in node never sees partial data.
 *
 * Wave reset on a back-edge: when an edge fires at a node that already ran
 * (a cycle / escalation), the subgraph downstream of that target is reset —
 * every node there returns to its static in-degree and is forgotten as
 * executed — so the next wave restarts cleanly from the target. Siblings in
 * that subgraph re-run; pi-session resume makes those re-runs cheap.
 *
 * Claims are tracked PER SOURCE, not as one flat counter (see
 * `computeStaticClaims` / `PendingClaims`). A reset restores only the claims
 * whose source is itself inside the reset subgraph — those sources will
 * re-run and re-release. Claims from sources outside the reset subgraph keep
 * whatever state they already had (released or still pending): that source
 * already ran (or hasn't yet) and a reset elsewhere does not change that.
 * Flattening claims to one number per node — the original design — loses
 * exactly this distinction and re-armed already-released claims whenever two
 * back-edges resolved in different rounds, deadlocking a fan-in that should
 * have completed. See docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md.
 *
 * Two counters: `iterations` (rounds) feeds the safety cap; `nodeExecutions`
 * (nodes run) feeds display and budget. They were identical in the linear
 * executor but diverge here because a round can run N nodes.
 */

import type { BuiltGraph, Edge, EndSymbol, GraphState, NodeDef } from "./graph-dsl.ts";
import { END } from "./graph-dsl.ts";
import {
	DEFAULT_MAX_ITERATIONS,
	describeTarget,
	GraphExecutionError,
	type GraphRunStatus,
	type NodeExecution,
	type NodeRunner,
	RESERVED_STATE_KEYS,
} from "./graph-execution-types.ts";

// Re-exported so `graph-executor.ts` remains the single import site for graph
// execution: callers should not need to know that the shared vocabulary lives
// in a separate module from the walk itself.
export type {
	GraphRunResult,
	NodeExecution,
	NodeRunner,
	NodeRunOutcome,
	NodeStatus,
	GraphRunStatus,
} from "./graph-execution-types.ts";
export {
	DEFAULT_MAX_ITERATIONS,
	describeTarget,
	formatPath,
	GraphExecutionError,
	RESERVED_STATE_KEYS,
	totalTokens,
} from "./graph-execution-types.ts";

export interface SuperstepRunOptions {
	runId: string;
	/** Cap on ROUNDS (barriers), not node executions. */
	maxIterations?: number;
	signal?: AbortSignal;
	/** Runs one node. The same NodeRunner the linear executor uses. */
	runNode: NodeRunner;
	/** Called before each node execution. */
	onNodeStart?: (info: {
		step: number;
		nodeId: string;
		nodeType: NodeDef["type"];
		round?: number;
	}) => void;
	/** Called after each node execution, for live display and journaling. */
	onNodeComplete?: (execution: NodeExecution) => void;
	/** Called when a round's barrier completes, with the next frontier snapshot. */
	onRoundComplete?: (info: {
		round: number;
		nodeIds: string[];
		nextFrontier: string[];
		/** Remaining in-degree per node — the readiness ground truth for resume. */
		remainingInDegree: Record<string, number>;
		/**
		 * Per-source breakdown of the same claims: node → source → pending
		 * count. Written so resume can restore per-source fidelity; readers
		 * that only need the flat view (display) ignore it.
		 */
		remainingClaimsBySource?: Record<string, Record<string, number>>;
	}) => void;
	/** Continue a previous run instead of starting from the entry node. */
	resume?: SuperstepResumeInput;
}

export interface SuperstepResumeInput {
	/** State rebuilt from the journal (initial + every recorded result). */
	state: GraphState;
	/** Nodes ready to run next, snapshotted at the last completed round. */
	resumeFromFrontier: string[];
	/** Remaining in-degree per node, snapshotted at the last completed round. */
	remainingInDegree: Record<string, number>;
	/**
	 * Per-source breakdown of the same claims (node → source → pending),
	 * snapshotted at the last completed round by a newer journal. Optional:
	 * legacy snapshots carry only the flat total, and resume then folds that
	 * total into one opaque bucket — old behaviour, exactly.
	 */
	remainingClaimsBySource?: Record<string, Record<string, number>>;
	/** Rounds already completed, so the cap covers the whole run. */
	completedRounds: number;
	/** Node executions already completed (work-amount counter). */
	completedNodeExecutions: number;
	/**
	 * Nodes that already ran in completed rounds.
	 *
	 * Required, not derived from `history`: readiness is "in-degree 0 AND not
	 * yet executed", so an empty executed set would make every settled node
	 * look ready again and re-run the whole graph.
	 */
	executedNodeIds: string[];
	/** Prior executions, prepended to history so the run reads as one walk. */
	history?: NodeExecution[];
}

export interface SuperstepRunResult {
	status: GraphRunStatus;
	state: GraphState;
	history: NodeExecution[];
	/** Node ids in visit order, repeats included. */
	path: string[];
	/** Rounds run (feeds the maxIterations cap). */
	iterations: number;
	/** Total node executions (work amount, for display/budget). */
	nodeExecutions: number;
	startedAt: number;
	durationMs: number;
	error?: string;
	finalResult?: unknown;
}

/** An edge whose claim on `to` was released when `from` ran. */
interface FiredEdge {
	from: string;
	to: string;
	/** True when `from` actually routed here, rather than merely releasing a claim. */
	selected: boolean;
}

/** Outcome of resolving one node's outgoing edges. */
type EdgeResolution =
	| {
			/** Targets actually routed to. These become ready. */
			selected: string[];
			/**
			 * Every target whose claim this node's edges released, chosen or not.
			 *
			 * A conditional edge claimed each node it might select, so all of
			 * those claims must be released once it has decided — otherwise the
			 * ones it passed over would wait forever.
			 */
			resolved: string[];
	  }
	| { error: string };

/**
 * A node's pending claims, broken down by which source each claim came from.
 *
 * `count` is how many still-unresolved edges from that source could route to
 * this node (almost always 1; can exceed 1 only for a duplicate edge — see
 * `computeStaticClaims`). The map's KEY SET is itself meaningful: a source
 * that has released is not removed but zeroed, so "is this source inside the
 * reset subgraph" can still be answered after the fact (see
 * `computeNextFrontier` step 3).
 */
type PendingClaims = Map<string, Map<string, number>>;

/** Sentinel source key used to fold journaled/resumed claims that predate
 * per-source tracking into one opaque bucket (see `runSuperstepGraph`'s
 * resume path). It can never collide with a real node id — `NODE_ID_PATTERN`
 * in graph-dsl.ts requires starting with a letter or underscore and forbids
 * spaces, so a space-containing key is not a valid node id by construction. */
const RESUME_SNAPSHOT_SOURCE = "(resumed)";

/**
 * Static claims: how many edges could route to each node, broken down by
 * source.
 *
 * A claim is released when the edge that made it resolves, whatever it chose.
 * Claims answer "is anything still able to route here?" — which, paired with
 * whether an edge actually selected the node, is what readiness needs. Edges to
 * END claim nothing.
 *
 * Per-source (not a flat count): a wave reset needs to know exactly which
 * claims to restore — only the ones whose source will itself re-run — and a
 * flat total cannot answer that (see `computeNextFrontier`).
 */
function computeStaticClaims(graph: BuiltGraph): PendingClaims {
	const claims: PendingClaims = new Map();
	for (const id of graph.nodes.keys()) claims.set(id, new Map());

	const add = (from: string, target: string): void => {
		const bySource = claims.get(target);
		if (!bySource) return;
		// A duplicate edge from the same source legitimately claims more than
		// once: resolveEdges fires that source's edges together and releases
		// every claim it made in one pass (see computeNextFrontier step 4),
		// so over-counting here is exactly cancelled there, never a deadlock.
		bySource.set(from, (bySource.get(from) ?? 0) + 1);
	};

	for (const [from, edgeList] of graph.edges) {
		for (const edge of edgeList) {
			if (edge.type === "direct") {
				// A back-edge does not gate the target's first run: its source
				// sits downstream, so it can only re-enter the target in a later
				// wave, which the wave reset handles. Claiming here would
				// deadlock, since the claim is released only by a node that is
				// itself waiting on the target.
				if (edge.to !== END && !isDownstreamOf(graph, from, edge.to as string)) {
					add(from, edge.to as string);
				}
				continue;
			}

			// A conditional edge claims every node it could select, because its
			// actual choice is not known until it runs and a node must not be
			// treated as settled while an edge might still route to it.
			//
			// Except a back-edge: if the edge's source sits downstream of the
			// target, it cannot fire before the target runs — only re-enter it
			// in a later wave, which the wave reset handles. Claiming there
			// would deadlock, since the claim is released only by a node that
			// is itself waiting on the target.
			for (const target of conditionalTargetsOf(graph, from)) {
				if (isDownstreamOf(graph, from, target)) continue;
				add(from, target);
			}
		}
	}

	return claims;
}

/** Sums a node's per-source claims into the flat total the public API and
 * journal format expose. This is the entire compatibility boundary: nothing
 * outside this file (journal, display, resume input/output) ever sees a
 * per-source breakdown, only this flattened total — unchanged from before
 * per-source tracking existed. */
function totalClaims(bySource: Map<string, number> | undefined): number {
	if (!bySource) return 0;
	let total = 0;
	for (const count of bySource.values()) total += count;
	return total;
}

/**
 * The nodes a conditional edge leaving `from` may select.
 *
 * Falls back to every node reachable from `from` when the targets could not be
 * read statically (a non-inline function, or a computed target). Over-claiming
 * only delays a node until the edge resolves, and is self-cancelling because an
 * edge decrements exactly the set it claimed; under-claiming would let a node
 * run without being routed to, which is the failure this exists to prevent.
 */
/** True when `node` is reachable from `origin`, i.e. `node` runs after it. */
function isDownstreamOf(graph: BuiltGraph, node: string, origin: string): boolean {
	return forwardReach.get(graph)?.get(origin)?.has(node) ?? false;
}

/** Forward reachability, shared by the claim rules. Keyed weakly per graph. */
const forwardReach = new WeakMap<BuiltGraph, Map<string, Set<string>>>();

function conditionalTargetsOf(graph: BuiltGraph, from: string): string[] {
	const info = graph.conditionalTargets?.get(from);
	if (info?.analysable) return info.targets;

	// Unanalysable, or a graph built without script analysis.
	const reachable = fallbackReach.get(graph)?.get(from);
	return reachable ? [...reachable] : [];
}

/**
 * Conservative reach used when a conditional edge cannot be read statically.
 *
 * Every node except strict ancestors of `from`: claiming a node that must run
 * *before* `from` would deadlock, because a claim is only released when the
 * claiming node runs.
 */
const fallbackReach = new WeakMap<BuiltGraph, Map<string, Set<string>>>();

function primeFallbackReach(
	graph: BuiltGraph,
	forwardReachable: Map<string, Set<string>>,
): void {
	const map = new Map<string, Set<string>>();

	// Claim only what is reachable from the source, following direct edges and
	// any conditional targets that *were* readable. Claiming more than this
	// deadlocks: a claim is released only when the claiming node runs, so
	// claiming a node that has to run first blocks the very edge that would
	// release it.
	for (const from of graph.nodes.keys()) {
		const reach = new Set(forwardReachable.get(from) ?? []);
		reach.delete(from);
		map.set(from, reach);
	}

	fallbackReach.set(graph, map);
	forwardReach.set(graph, forwardReachable);
}

/**
 * Nodes reachable from `start` following DIRECT edges only, including `start`.
 *
 * Used to scope a wave reset: when `start` re-runs, everything downstream of
 * it (whose inputs transitively depend on it) should re-run too. Conditional
 * edges have unknown targets statically, so they are not followed; nodes
 * reachable only through a conditional are handled correctly anyway — they
 * reset themselves when re-targeted (detected as their own back-edge).
 */
function computeForwardReachable(graph: BuiltGraph): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();

	for (const start of graph.nodes.keys()) {
		const reachable = new Set<string>();
		const stack = [start];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (reachable.has(current)) continue;
			reachable.add(current);
			for (const edge of graph.edges.get(current) ?? []) {
				if (edge.type === "direct") {
					if (edge.to !== END) stack.push(edge.to as string);
					continue;
				}
				// Conditional targets are recovered from the script's AST, so a
				// conditional edge contributes to reachability too. Ignoring them
				// would hide back-edges and let a cycle deadlock the claim rules.
				const info = graph.conditionalTargets?.get(current);
				if (info?.analysable) stack.push(...info.targets);
			}
		}
		result.set(start, reachable);
	}

	return result;
}

/**
 * Evaluates a node's outgoing edges to find what it fired toward.
 *
 * A direct edge always fires at its target. A conditional edge fires at the
 * single target its condition returns (or nothing, if it returns END).
 * Targets are de-duplicated: two edges firing at the same node count once for
 * readiness. A throw or an unknown target is a routing error, not an agent
 * problem, and aborts the run.
 */
function resolveEdges(
	edges: Edge[],
	nodeId: string,
	state: GraphState,
	result: unknown,
	graph: BuiltGraph,
): EdgeResolution {
	const selected = new Set<string>();
	const resolved = new Set<string>();

	for (const edge of edges) {
		if (edge.type === "direct") {
			if (edge.to !== END) {
				selected.add(edge.to as string);
				resolved.add(edge.to as string);
			}
			continue;
		}

		// This edge claimed every node it might select, so every one of those
		// claims is released now that it has decided — including the ones it
		// passed over, which would otherwise never become ready.
		for (const candidate of conditionalTargetsOf(graph, edge.from)) resolved.add(candidate);

		let target: string | EndSymbol;
		try {
			target = edge.condition(state, result);
		} catch (error) {
			return {
				error: `Edge condition for node "${nodeId}" threw: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (target === END) continue;

		if (typeof target !== "string" || target.length === 0) {
			return {
				error: `Edge condition for node "${nodeId}" returned ${JSON.stringify(target)}; expected a node name or END.`,
			};
		}

		if (!graph.nodes.has(target)) {
			const known = [...graph.nodes.keys()].join(", ");
			return {
				error: `Edge condition for node "${nodeId}" routed to unknown node "${target}". Defined nodes: ${known}.`,
			};
		}

		selected.add(target);
		resolved.add(target);
	}

	return { selected: [...selected], resolved: [...resolved] };
}

/**
 * Computes the next frontier after a round, applying edge firings, AND fan-in
 * readiness, and wave reset on back-edges.
 *
 * Mutates `remainingClaims` (per source), `executed`, and `selected` in place.
 */
function computeNextFrontier(
	firedEdges: FiredEdge[],
	executed: Set<string>,
	selected: Set<string>,
	remainingClaims: PendingClaims,
	staticClaims: PendingClaims,
	forwardReachable: Map<string, Set<string>>,
	entry: string,
): Set<string> {
	// 1. Partition: an edge routed at a node that already ran is a back-edge
	//    (cycle / escalation) and triggers a wave reset. Only a *selected*
	//    edge counts — merely releasing a claim is not a route.
	const resetTargets = new Set<string>();
	const normalFired: FiredEdge[] = [];

	for (const fired of firedEdges) {
		if (fired.selected && executed.has(fired.to)) {
			resetTargets.add(fired.to);
		} else {
			normalFired.push(fired);
		}
	}

	// 2. Union the reset subgraphs: every node downstream of a reset target.
	const resetNodes = new Set<string>();
	for (const target of resetTargets) {
		for (const node of forwardReachable.get(target) ?? []) {
			resetNodes.add(node);
		}
	}

	// 3. Apply the reset. Per node N in the reset subgraph, per incoming
	//    source S of N:
	//      - S inside the reset subgraph  → restore N's claim on S to static
	//        (S will re-run and re-release it)
	//      - S outside the reset subgraph → keep N's claim on S exactly as it
	//        is. S already ran and released (count 0 → stays 0), or S has not
	//        fired yet (pending → stays pending). A reset elsewhere must not
	//        re-arm either.
	//    This per-source split is the fix: the flat-counter version restored
	//    the FULL static total, erasing outside releases that happened in
	//    earlier rounds and could never be re-earned (their source had already
	//    run), permanently over-claiming N after the second of two
	//    differently-timed back-edges — a fan-in node then never became ready
	//    and the run "completed" with it never having run.
	//    The RESUME_SNAPSHOT_SOURCE bucket (a legacy-resumed node's folded
	//    claims) is never inside resetNodes (it is not a node id), so it is
	//    never restored — a resumed run keeps the journal's snapshot for
	//    pre-crash state, which is exactly what the snapshot recorded.
	//    Also forget prior execution/selection so the wave starts clean;
	//    leaving `selected` set would let a node fire without being routed to.
	for (const node of resetNodes) {
		const remaining = remainingClaims.get(node);
		const staticBySource = staticClaims.get(node);
		if (remaining && staticBySource) {
			for (const source of remaining.keys()) {
				if (resetNodes.has(source)) {
					remaining.set(source, staticBySource.get(source) ?? 0);
				}
				// Outside the subgraph (or the resume sentinel): keep as-is.
			}
		}
		executed.delete(node);
		selected.delete(node);
	}
	for (const target of resetTargets) {
		// The escalation target re-runs now: it is routed to and ready.
		const bySource = remainingClaims.get(target);
		if (bySource) for (const source of bySource.keys()) bySource.set(source, 0);
		executed.delete(target);
		selected.add(target);
	}
	// The entry gets no special treatment on reset. Under the old in-degree
	// rule it needed forcing because it had no claims to clear, but now the
	// reset target is explicitly selected, and force-selecting the entry as
	// well would run two nodes where the graph routed to one.

	// 4. Release claims. A source fires all its outgoing edges together, so
	//    one firing releases EVERY claim that source holds on the target —
	//    duplicates included (the counterpart of the duplicate-edge count in
	//    computeStaticClaims). Skip an edge whose SOURCE is in the reset
	//    subgraph: that source will re-run, so its edge has not really
	//    resolved. Skip reset targets, already forced ready above.
	for (const fired of normalFired) {
		if (resetNodes.has(fired.from)) continue;
		if (resetTargets.has(fired.to)) continue;
		const bySource = remainingClaims.get(fired.to);
		if (bySource && bySource.has(fired.from)) {
			bySource.set(fired.from, 0);
		} else if (bySource) {
			// The source never statically claimed this target (possible for a
			// conditional edge routing somewhere new after a resume, or a
			// duplicate edge whose claim was collapsed). Nothing to release.
		}
		// Only an edge that actually routed here marks the node selected.
		if (fired.selected) selected.add(fired.to);
	}

	// 5. Ready = nothing can still route here, something did route here, and it
	//    has not already run this wave.
	//
	//    `selected` is what makes this a graph walk rather than a sweep over
	//    every node: without it, a node whose only incoming edges are
	//    conditional has no claims to wait on and would run immediately,
	//    whether or not any edge chose it.
	const next = new Set<string>();
	for (const [node, bySource] of remainingClaims) {
		if (totalClaims(bySource) === 0 && selected.has(node) && !executed.has(node)) next.add(node);
	}
	return next;
}

/** Flattens per-source claims to the flat per-node totals the journal and
 * public API expose. */
function toRecord(map: PendingClaims): Record<string, number> {
	const record: Record<string, number> = {};
	for (const [k, bySource] of map) record[k] = totalClaims(bySource);
	return record;
}

/** Serialises the per-source breakdown for journaling (resume fidelity). */
function toBySourceRecord(map: PendingClaims): Record<string, Record<string, number>> {
	const record: Record<string, Record<string, number>> = {};
	for (const [node, bySource] of map) {
		const inner: Record<string, number> = {};
		for (const [source, count] of bySource) {
			if (count > 0) inner[source] = count;
		}
		if (Object.keys(inner).length > 0) record[node] = inner;
	}
	return record;
}

/**
 * Runs a superstep (parallel) graph to completion.
 *
 * Node execution is injected via options.runNode, mirroring the linear
 * executor, so this module has no dependency on agent spawning and is testable
 * with scripted results.
 */
export async function runSuperstepGraph(
	graph: BuiltGraph,
	options: SuperstepRunOptions,
): Promise<SuperstepRunResult> {
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		throw new GraphExecutionError("maxIterations must be a positive integer");
	}

	for (const nodeId of graph.nodes.keys()) {
		if (RESERVED_STATE_KEYS.has(nodeId)) {
			throw new GraphExecutionError(`Node id "${nodeId}" is reserved by the executor`);
		}
	}

	// Reachability first: the conservative fallback for unreadable conditional
	// edges is scoped by it, and claims depend on that fallback.
	const forwardReachable = computeForwardReachable(graph);
	primeFallbackReach(graph, forwardReachable);
	const staticClaims = computeStaticClaims(graph);

	const resume = options.resume;
	const startedAt = Date.now();
	const state: GraphState = resume ? { ...resume.state } : { ...graph.initialState };
	const history: NodeExecution[] = resume?.history ? [...resume.history] : [];
	const path: string[] = history.map((execution) => execution.nodeId);

	const remainingClaims: PendingClaims = new Map();
	/** Nodes an edge actually routed to. Ready requires this, not just claims 0. */
	const selected = new Set<string>();
	const executed = new Set<string>();
	let frontier: Set<string>;
	let iterations: number;
	let nodeExecutions: number;
	let finalResult: unknown = resume ? history[history.length - 1]?.result : undefined;

	if (resume) {
		// Resume seeds claims from whatever the journal snapshot carried:
		// per-source detail when the run journaled it (post-fix runs), or the
		// legacy flat total folded into one opaque sentinel bucket when it did
		// not. The sentinel can never be inside a reset subgraph (it is not a
		// node id), so a legacy-resumed node keeps the snapshotted total for
		// its pre-crash life — exactly the old behaviour, no better, no worse.
		for (const id of graph.nodes.keys()) remainingClaims.set(id, new Map());
		for (const [k, v] of Object.entries(resume.remainingInDegree)) {
			const bySource = remainingClaims.get(k);
			if (!bySource || v <= 0) continue;
			bySource.set(RESUME_SNAPSHOT_SOURCE, v);
		}
		// Per-source detail from a newer journal replaces the flat snapshot.
		// Sources present there are authoritative; the sentinel bucket is
		// dropped entirely (it exists only for legacy snapshots).
		for (const [k, bySource] of Object.entries(resume.remainingClaimsBySource ?? {})) {
			const target = remainingClaims.get(k);
			if (!target) continue;
			target.clear();
			for (const [source, count] of Object.entries(bySource)) {
				if (count > 0) target.set(source, count);
			}
		}
		// The frontier was computed before the crash, so those nodes were
		// selected by definition.
		for (const nodeId of resume.resumeFromFrontier) selected.add(nodeId);
		frontier = new Set(resume.resumeFromFrontier);
		iterations = resume.completedRounds;
		nodeExecutions = resume.completedNodeExecutions;
		// Restore which nodes are already settled. Without this every node whose
		// in-degree reached 0 would be considered ready again.
		for (const nodeId of resume.executedNodeIds) executed.add(nodeId);
		// The frontier is explicitly the nodes to re-run, so they must not count
		// as settled (a crashed round's nodes are journaled but not complete).
		for (const nodeId of resume.resumeFromFrontier) executed.delete(nodeId);
	} else {
		// Copy the static per-source claims: each node starts with every claim
		// its incoming edges statically hold, keyed by source.
		for (const [id, bySource] of staticClaims) {
			remainingClaims.set(
				id,
			new Map((function* () {
					for (const [source, count] of bySource) yield [source, count] as const;
				})()),
			);
		}
		// The entry is unconditionally ready: nothing routes to it to begin with.
		remainingClaims.get(graph.entry)?.clear();
		selected.add(graph.entry);
		frontier = new Set([graph.entry]);
		iterations = 0;
		nodeExecutions = 0;
	}

	let status: GraphRunStatus = "completed";
	let error: string | undefined;

	const finish = (): SuperstepRunResult => ({
		status,
		state,
		history,
		path,
		iterations,
		nodeExecutions,
		startedAt,
		durationMs: Date.now() - startedAt,
		error,
		finalResult,
	});

	while (frontier.size > 0) {
		if (options.signal?.aborted) {
			status = "aborted";
			error = "Graph run was aborted";
			break;
		}

		// The cap counts rounds (barriers), not node executions. A stuck cycle
		// climbs rounds regardless of how many nodes each round runs.
		if (iterations >= maxIterations) {
			status = "max_iterations";
			const tail = path.slice(-6).join(" -> ");
			error = `Graph exceeded ${maxIterations} rounds without reaching END. Recent path: ${tail}. If this is a legitimate long run, raise maxIterations; otherwise a cycle never resolves.`;
			break;
		}

		iterations += 1;
		const round = iterations;
		const roundNodeIds = [...frontier];
		const stepBase = nodeExecutions;

		// Fire every ready node concurrently. Writes are deferred until after
		// the barrier resolves, so no node sees another's result from this round.
		const roundResults = await Promise.all(
			roundNodeIds.map(async (nodeId, index) => {
				// Frontier nodes always come from the graph's validated node set.
				const node = graph.nodes.get(nodeId)!;
				const step = stepBase + index + 1;
				options.onNodeStart?.({ step, nodeId, nodeType: node.def.type, round });
				const nodeStartedAt = Date.now();
				try {
					const outcome = await options.runNode(node, state, {
						step,
						runId: options.runId,
						signal: options.signal,
					});
					return { nodeId, node, step, nodeStartedAt, outcome };
				} catch (error) {
					return {
						nodeId,
						node,
						step,
						nodeStartedAt,
						runnerError: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);

		let aborted = false;
		const firedEdges: FiredEdge[] = [];

		for (const r of roundResults) {
			const { nodeId, node } = r;

			nodeExecutions += 1;
			executed.add(nodeId);
			path.push(nodeId);
			const agentName = node.def.type === "agent" ? node.def.agentName : undefined;

			if ("runnerError" in r) {
				const execution: NodeExecution = {
					step: r.step,
					round,
					nodeId,
					nodeType: node.def.type,
					agentName,
					status: "failed",
					result: undefined,
					routedTo: "",
					startedAt: r.nodeStartedAt,
					durationMs: Date.now() - r.nodeStartedAt,
					error: r.runnerError,
				};
				history.push(execution);
				options.onNodeComplete?.(execution);
				aborted = true;
				status = "aborted";
				error = `Node "${nodeId}" failed: ${r.runnerError}`;
				continue;
			}

			const outcome = r.outcome;
			// Write before routing so an edge condition sees the same state a
			// downstream node will. Each node writes under its own id (Decision 4).
			state[nodeId] = outcome.result;
			finalResult = outcome.result;

			if (outcome.technicalFailure) {
				const execution: NodeExecution = {
					step: r.step,
					round,
					nodeId,
					nodeType: node.def.type,
					agentName,
					status: "failed",
					result: outcome.result,
					routedTo: "",
					startedAt: r.nodeStartedAt,
					durationMs: Date.now() - r.nodeStartedAt,
					tokens: outcome.tokens,
					error: outcome.error,
					sessionId: outcome.sessionId,
				};
				history.push(execution);
				options.onNodeComplete?.(execution);
				aborted = true;
				status = "aborted";
				error = `Node "${nodeId}" hit a technical failure: ${outcome.error ?? "unknown error"}`;
				continue;
			}

			const resolved = resolveEdges(
				graph.edges.get(nodeId) ?? [],
				nodeId,
				state,
				outcome.result,
				graph,
			);

			if ("error" in resolved) {
				const execution: NodeExecution = {
					step: r.step,
					round,
					nodeId,
					nodeType: node.def.type,
					agentName,
					status: "ok",
					result: outcome.result,
					routedTo: "",
					startedAt: r.nodeStartedAt,
					durationMs: Date.now() - r.nodeStartedAt,
					tokens: outcome.tokens,
					error: resolved.error,
				};
				history.push(execution);
				options.onNodeComplete?.(execution);
				aborted = true;
				status = "aborted";
				error = resolved.error;
				continue;
			}

			for (const target of resolved.resolved) {
				firedEdges.push({
					from: nodeId,
					to: target,
					selected: resolved.selected.includes(target),
				});
			}

			const routedTo =
				resolved.selected.length > 0 ? resolved.selected.map(describeTarget).join(",") : "END";
			const execution: NodeExecution = {
				step: r.step,
				round,
				nodeId,
				nodeType: node.def.type,
				agentName,
				status: outcome.error ? "failed" : "ok",
				result: outcome.result,
				routedTo,
				startedAt: r.nodeStartedAt,
				durationMs: Date.now() - r.nodeStartedAt,
				tokens: outcome.tokens,
				error: outcome.error,
				sessionId: outcome.sessionId,
			};
			history.push(execution);
			options.onNodeComplete?.(execution);
		}

		if (aborted) break;

		frontier = computeNextFrontier(
			firedEdges,
			executed,
			selected,
			remainingClaims,
			staticClaims,
			forwardReachable,
			graph.entry,
		);

		// An empty frontier is successful only when every selected node either
		// executed or deliberately reached END. If a selected node still has
		// unresolved claims from a branch that was never routed to, this is a
		// conditional fan-in deadlock — never report it as a completed workflow.
		if (frontier.size === 0 && (!resume || resume.remainingClaimsBySource !== undefined)) {
			const stranded = [...selected].filter((nodeId) => !executed.has(nodeId));
			if (stranded.length > 0) {
				status = "aborted";
				error = `Graph reached an empty frontier with selected nodes still waiting on skipped predecessors: ${stranded.join(", ")}. Use separate terminal report nodes or remove the unintended fan-in.`;
			}
		}

		options.onRoundComplete?.({
			round,
			nodeIds: roundNodeIds,
			nextFrontier: [...frontier],
			remainingInDegree: toRecord(remainingClaims),
			remainingClaimsBySource: toBySourceRecord(remainingClaims),
		});
	}

	return finish();
}
