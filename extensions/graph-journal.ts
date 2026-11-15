/**
 * Graph run journaling and resume.
 *
 * Each node execution is appended to a JSONL file as it completes. Because
 * a graph walk is an ordered sequence of node executions, resume is a
 * replay: re-apply each recorded result to state in order, then continue
 * from wherever the last recorded node routed.
 *
 * This is why graph resume is tractable where the imperative workflow's was
 * not. That design keyed the cache on a hash of (prompt + options), which
 * meant a prompt built from earlier results changed its own key whenever
 * anything upstream changed, and cache hits were both hard to predict and
 * hard to invalidate correctly. A graph has an explicit execution order and
 * stable node ids, so "what already ran" needs no heuristic.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NodeExecution } from "./graph-executor.ts";
import type { GraphState } from "./graph-dsl.ts";
import { rehydrateState } from "./graph-node-runner.ts";

/**
 * Stable, dependency-free string hash (djb2-xor variant).
 * Used to hash script content for resume cache invalidation.
 */
export function hashString(input: string): string {
	let h = 5381;
	for (let i = 0; i < input.length; i++) {
		h = ((h << 5) + h) ^ input.charCodeAt(i);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export interface GraphJournalRunRecord {
	type: "graph_run";
	runId: string;
	/** Invalidates a resume when the script changed. */
	scriptHash: string;
	sourcePath?: string;
	sourceHashAlgorithm?: "sha256";
	name: string;
	description?: string;
	entry: string;
	nodeIds: string[];
	initialState: GraphState;
	startedAt: number;
}

export interface GraphJournalNodeRecord {
	type: "node";
	/** 1-based execution order. A revisited node appears once per visit. */
	step: number;
	/**
	 * Superstep index. Nodes that ran concurrently share a round; this is how
	 * a parallel run is readable from a flat JSONL file. Absent for linear runs.
	 */
	round?: number;
	nodeId: string;
	nodeType: "agent" | "human" | "fn" | "command";
	agentName?: string;
	/** Pi session file path, for agent nodes only. */
	sessionId?: string;
	status: "ok" | "failed" | "skipped";
	result: unknown;
	routedTo: string;
	tokens?: number;
	usage?: NodeExecution["usage"];
	toolCalls?: number;
	error?: string;
	startedAt: number;
	durationMs: number;
}

/**
 * Marks a completed superstep barrier.
 *
 * This is the resume atomicity marker: a round whose nodes were written but
 * whose marker is missing did not finish, so resume re-runs the whole round.
 * It is the parallel equivalent of the linear journal's "re-run a whole node,
 * never resume mid-agent" honesty, lifted one level.
 */
export interface GraphJournalRoundRecord {
	type: "round_complete";
	round: number;
	/** Nodes that ran in this round (concurrently). */
	nodeIds: string[];
	/** Nodes ready to run next. Empty when the run is finishing. */
	nextFrontier: string[];
	/**
	 * Remaining in-degree per node after this round.
	 *
	 * Stored rather than re-derived: wave resets make the counters a function
	 * of the whole routing history, and replaying that is both fiddly and easy
	 * to get subtly wrong. Snapshotting it makes resume exact.
	 */
	remainingInDegree: Record<string, number>;
	/**
	 * Per-source breakdown of the same claims: node → source → pending count.
	 *
	 * Optional and additive: journals written before per-source tracking carry
	 * only `remainingInDegree`, and resume then falls back to the flat total
	 * (folded into one opaque bucket — the pre-fix behaviour). Written by the
	 * executor's `onRoundComplete` since the wave-reset claim fix, so a resumed
	 * run restores exact per-source fidelity instead of a degraded snapshot.
	 */
	remainingClaimsBySource?: Record<string, Record<string, number>>;
}

export interface GraphJournalResultRecord {
	type: "graph_result";
	status: "completed" | "aborted" | "max_iterations" | "paused";
	/** Rounds for a superstep run; node executions for a linear one. */
	iterations: number;
	/** Total node executions. Present for superstep runs. */
	nodeExecutions?: number;
	totalTokens: number;
	durationMs: number;
	error?: string;
}

/** Recorded when a judgement question is submitted to the broker. */
export interface GraphJournalBrokerRequestRecord {
	type: "broker_request";
	requestId: string;
	runId: string;
	nodeId?: string;
	agent?: string;
	kind: "human" | "supervisor" | "state";
	question: string;
	timestamp: number;
}

/** Recorded when the broker resolves a request. */
export interface GraphJournalBrokerAnswerRecord {
	type: "broker_answer";
	requestId: string;
	runId: string;
	source: string;
	answer?: string;
	reason?: string;
	timestamp: number;
}

export interface GraphJournalStateActionRecord {
	type: "state_action";
	runId: string;
	nodeId: string;
	action: "set" | "merge" | "append";
	key?: string;
	value?: unknown;
	meta?: Record<string, unknown>;
	timestamp: number;
}

export type GraphJournalRecord =
	| GraphJournalRunRecord
	| GraphJournalNodeRecord
	| GraphJournalRoundRecord
	| GraphJournalResultRecord
	| GraphJournalBrokerRequestRecord
	| GraphJournalBrokerAnswerRecord
	| GraphJournalStateActionRecord
	| {type: "result_correction"; step: number; nodeId: string; result: unknown; timestamp: number};

export interface GraphResumeState {
	/** Node executions already recorded, in order. */
	executions: GraphJournalNodeRecord[];
	/** State rebuilt by replaying those executions over the initial state. */
	state: GraphState;
	/** Node to continue from, or null when the run already finished. */
	resumeFrom: string | null;
	/** Executions already done, so the iteration cap stays meaningful. */
	completedSteps: number;
	/** False when the script changed since the journal was written. */
	isValid: boolean;
	invalidReason?: string;
}

export function graphScriptHash(script: string): string {
	return createHash("sha256").update(script, "utf8").digest("hex");
}

function journalPath(journalDir: string, runId: string): string {
	return path.join(journalDir, `${runId}.jsonl`);
}

/**
 * Append-only JSONL journal for one graph run.
 *
 * Writes are best-effort: journaling exists to make a run inspectable and
 * resumable, and losing that is strictly better than aborting a run that is
 * otherwise working. Write failures are surfaced via `writeErrors` so a
 * caller can report them without the run dying.
 */
export class GraphJournal {
	readonly filePath: string;
	readonly runId: string;
	readonly writeErrors: string[] = [];

	private totalTokens = 0;
	private nodeCount = 0;

	private constructor(filePath: string, runId: string) {
		this.filePath = filePath;
		this.runId = runId;
	}

	static create(options: {
		journalDir: string;
		runId: string;
		scriptHash: string;
		sourcePath?: string;
		name: string;
		description?: string;
		entry: string;
		nodeIds: string[];
		initialState: GraphState;
		resume?: boolean;
	}): GraphJournal {
		const filePath = journalPath(options.journalDir, options.runId);
		const journal = new GraphJournal(filePath, options.runId);

		try {
			fs.mkdirSync(options.journalDir, { recursive: true });
		} catch (error) {
			journal.writeErrors.push(
				`Could not create journal directory: ${error instanceof Error ? error.message : String(error)}`,
			);
			return journal;
		}

		if (options.resume && fs.existsSync(filePath)) {
			for (const record of readGraphJournal(filePath)) if (record.type === "node") { journal.totalTokens += record.tokens ?? 0; journal.nodeCount++; }
			return journal;
		}
		journal.append({
			type: "graph_run",
			runId: options.runId,
			scriptHash: options.scriptHash,
			sourcePath: options.sourcePath,
			sourceHashAlgorithm: options.scriptHash.length === 64 ? "sha256" : undefined,
			name: options.name,
			description: options.description,
			entry: options.entry,
			nodeIds: options.nodeIds,
			initialState: options.initialState,
			startedAt: Date.now(),
		});

		return journal;
	}

	private append(record: GraphJournalRecord): void {
		try {
			fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
		} catch (error) {
			this.writeErrors.push(error instanceof Error ? error.message : String(error));
		}
	}

	recordNode(execution: NodeExecution): void {
		this.nodeCount += 1;
		this.totalTokens += execution.tokens ?? 0;

		this.append({
			type: "node",
			step: execution.step,
			round: execution.round,
			nodeId: execution.nodeId,
			nodeType: execution.nodeType,
			agentName: execution.agentName,
			status: execution.status,
			result: execution.result,
			routedTo: execution.routedTo,
			tokens: execution.tokens,
			usage: execution.usage,
			toolCalls: execution.toolCalls,
			sessionId: execution.sessionId,
			error: execution.error,
			startedAt: execution.startedAt,
			durationMs: execution.durationMs,
		});
	}

	/** Records a completed superstep barrier. See GraphJournalRoundRecord. */
	recordRoundComplete(info: {
		round: number;
		nodeIds: string[];
		nextFrontier: string[];
		remainingInDegree: Record<string, number>;
		remainingClaimsBySource?: Record<string, Record<string, number>>;
	}): void {
		this.append({
			type: "round_complete",
			round: info.round,
			nodeIds: info.nodeIds,
			nextFrontier: info.nextFrontier,
			remainingInDegree: info.remainingInDegree,
			remainingClaimsBySource: info.remainingClaimsBySource,
		});
	}

	recordResult(result: {
		status: "completed" | "aborted" | "max_iterations" | "paused";
		iterations: number;
		nodeExecutions?: number;
		durationMs: number;
		error?: string;
	}): void {
		this.append({
			type: "graph_result",
			status: result.status,
			iterations: result.iterations,
			nodeExecutions: result.nodeExecutions,
			totalTokens: this.totalTokens,
			durationMs: result.durationMs,
			error: result.error,
		});
	}

	recordBrokerRequest(info: {
		requestId: string;
		runId: string;
		nodeId?: string;
		agent?: string;
		kind: "human" | "supervisor" | "state";
		question: string;
	}): void {
		this.append({
			type: "broker_request",
			requestId: info.requestId,
			runId: info.runId,
			nodeId: info.nodeId,
			agent: info.agent,
			kind: info.kind,
			question: info.question,
			timestamp: Date.now(),
		});
	}

	recordBrokerAnswer(info: {
		requestId: string;
		runId: string;
		source: string;
		answer?: string;
		reason?: string;
	}): void {
		this.append({
			type: "broker_answer",
			requestId: info.requestId,
			runId: info.runId,
			source: info.source,
			answer: info.answer,
			reason: info.reason,
			timestamp: Date.now(),
		});
	}

	recordStateAction(info: {
		runId: string;
		nodeId: string;
		action: "set" | "merge" | "append";
		key?: string;
		value?: unknown;
		meta?: Record<string, unknown>;
	}): void {
		this.append({
			type: "state_action",
			runId: info.runId,
			nodeId: info.nodeId,
			action: info.action,
			key: info.key,
			value: info.value,
			meta: info.meta,
			timestamp: Date.now(),
		});
	}

	get tokens(): number {
		return this.totalTokens;
	}

	get nodes(): number {
		return this.nodeCount;
	}
}

/** Reads a journal file, skipping unparseable lines. */
export function readGraphJournal(filePath: string): GraphJournalRecord[] {
	if (!fs.existsSync(filePath)) return [];

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const records: GraphJournalRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as GraphJournalRecord);
		} catch {
			// A partial final line is expected if the process died mid-write.
			// Everything before it is still usable.
		}
	}

	for (const correction of records) if (correction.type === "result_correction") {
		const node = records.find((record): record is GraphJournalNodeRecord => record.type === "node" && record.step === correction.step);
		if (node && node.status !== "failed") node.result = correction.result;
	}
	return records;
}

/**
 * Rebuilds the state and resume point for a previous run.
 *
 * Resume is refused when the script hash differs. A changed script may have
 * renamed nodes, rerouted edges, or altered prompts, so replaying old
 * results into it would produce a run that never actually happened.
 */
export function loadGraphResumeState(options: {
	journalDir: string;
	runId: string;
	scriptHash: string;
}): GraphResumeState {
	const empty: GraphResumeState = {
		executions: [],
		state: {},
		resumeFrom: null,
		completedSteps: 0,
		isValid: false,
	};

	const records = readGraphJournal(journalPath(options.journalDir, options.runId));
	if (records.length === 0) {
		return { ...empty, invalidReason: `No journal found for run "${options.runId}".` };
	}

	const meta = records.find((r): r is GraphJournalRunRecord => r.type === "graph_run");
	if (!meta) {
		return { ...empty, invalidReason: "Journal is missing its run header." };
	}

	if (meta.scriptHash !== options.scriptHash) {
		return {
			...empty,
			invalidReason:
				"The graph script changed since this run was journaled, so previous results cannot be reused. Start a new run.",
		};
	}

	const executions = records.filter((r): r is GraphJournalNodeRecord => r.type === "node");

	// state_action records are deliberately NOT replayed here. A completed
	// node's result already carries its folded .data (the node runner drains
	// the buffer into result.data before the executor journals the record), so
	// replaying actions would double-apply them. A node that crashed mid-run
	// has no node record; its in-flight state_action records are discarded,
	// matching the "revisiting a node overwrites its state entry" rule — a
	// node's state is whatever its most recent complete visit produced, true
	// for .text and .data alike. Resume never recovers partial in-flight work.

	// Replay in recorded order. A revisited node overwrites its earlier
	// entry, exactly as it would during a live run.
	const state: GraphState = { ...meta.initialState };
	for (const execution of executions) {
		state[execution.nodeId] = execution.result;
	}

	// Results came back through JSON.parse, so they are plain objects that
	// have lost the toString() making `${state.architect}` render the agent's
	// text. Without this a resumed run silently interpolates "[object Object]"
	// into every prompt built from an earlier node.
	rehydrateState(state);

	const finished = records.find((r): r is GraphJournalResultRecord => r.type === "graph_result");
	const last = executions[executions.length - 1];

	let resumeFrom: string | null;
	if (finished?.status === "completed") {
		resumeFrom = null;
	} else if (!last) {
		resumeFrom = meta.entry;
	} else if (last.routedTo === "END" || last.routedTo === "") {
		// An empty routedTo means the node ran but routing failed or the run
		// aborted there, so that node is where work stopped.
		resumeFrom = last.routedTo === "END" ? null : last.nodeId;
	} else {
		resumeFrom = last.routedTo;
	}

	return {
		executions,
		state,
		resumeFrom,
		completedSteps: executions.length,
		isValid: true,
	};
}

export interface GraphSuperstepResumeState {
	/** Node executions from completed rounds only, in order. */
	executions: GraphJournalNodeRecord[];
	/** State rebuilt by replaying those executions over the initial state. */
	state: GraphState;
	/** Nodes ready to run next. Empty when the run already finished. */
	frontier: string[];
	/** Remaining in-degree snapshot to continue readiness tracking from. */
	remainingInDegree: Record<string, number>;
	/**
	 * Per-source breakdown of the same claims (node → source → pending),
	 * present when the journal recorded it. Absent for legacy journals —
	 * callers then rely on `remainingInDegree` alone and resume keeps the
	 * pre-fix (flat) behaviour.
	 */
	remainingClaimsBySource?: Record<string, Record<string, number>>;
	/** Rounds already completed, so the round cap stays meaningful. */
	completedRounds: number;
	/** Node executions already done (work-amount counter). */
	completedNodeExecutions: number;
	/** Distinct nodes that ran in completed rounds; restores readiness state. */
	executedNodeIds: string[];
	isValid: boolean;
	invalidReason?: string;
}

/**
 * Rebuilds state and the resume frontier for a previous superstep run.
 *
 * Resume is round-atomic: only rounds with a `round_complete` marker count.
 * A round whose nodes were journaled but whose marker is missing did not
 * finish, so its results are discarded and the whole round re-runs. This is
 * the same honesty as the linear journal's "never resume mid-node", applied
 * one level up, and it is why the frontier can be trusted after a crash.
 */
export function loadGraphSuperstepResumeState(options: {
	journalDir: string;
	runId: string;
	scriptHash: string;
}): GraphSuperstepResumeState {
	const empty: GraphSuperstepResumeState = {
		executions: [],
		state: {},
		frontier: [],
		remainingInDegree: {},
		completedRounds: 0,
		completedNodeExecutions: 0,
		executedNodeIds: [],
		isValid: false,
	};
	const records = readGraphJournal(journalPath(options.journalDir, options.runId));
	if (records.length === 0) {
		return { ...empty, invalidReason: `No journal found for run "${options.runId}".` };
	}

	const meta = records.find((r): r is GraphJournalRunRecord => r.type === "graph_run");
	if (!meta) {
		return { ...empty, invalidReason: "Journal is missing its run header." };
	}

	if (meta.scriptHash !== options.scriptHash) {
		return {
			...empty,
			invalidReason:
				"The graph script changed since this run was journaled, so previous results cannot be reused. Start a new run.",
		};
	}

	const rounds = records.filter((r): r is GraphJournalRoundRecord => r.type === "round_complete");
	const lastRound = rounds[rounds.length - 1];

	// Only replay nodes from rounds that actually completed. A node from a
	// half-finished round is dropped so the round re-runs as a unit.
	const lastCompletedRound = lastRound?.round ?? 0;
	const executions = records.filter(
		(r): r is GraphJournalNodeRecord =>
			r.type === "node" && (r.round ?? 0) <= lastCompletedRound,
	);

	// state_action records are deliberately NOT replayed (same rationale as
	// the linear resume above): completed nodes carry their folded .data in
	// the node record, and crashed nodes' in-flight actions are discarded so
	// the node re-runs clean.

	const state: GraphState = { ...meta.initialState };
	for (const execution of executions) {
		state[execution.nodeId] = execution.result;
	}

	// Results came back through JSON.parse and lost the toString() that makes
	// `${state.architect}` render the agent's text rather than [object Object].
	rehydrateState(state);

	const finished = records.find((r): r is GraphJournalResultRecord => r.type === "graph_result");

	const latestFinished = records.filter((r): r is GraphJournalResultRecord => r.type === "graph_result").at(-1);
	// A completed run has nothing to resume. Otherwise continue from the last
	// barrier's frontier, or from the entry when no round ever completed.
	let frontier: string[];
	if (latestFinished?.status === "completed") {
		frontier = [];
	} else if (!lastRound) {
		frontier = [meta.entry];
	} else {
		frontier = lastRound.nextFrontier;
	}

	return {
		executions,
		state,
		frontier,
		remainingInDegree: lastRound?.remainingInDegree ?? {},
		remainingClaimsBySource: lastRound?.remainingClaimsBySource,
		completedRounds: lastCompletedRound,
		completedNodeExecutions: executions.length,
		executedNodeIds: [...new Set(executions.map((e) => e.nodeId))],
		isValid: true,
	};
}

/** Lists journaled graph runs, newest first. */
export function listGraphRuns(journalDir: string): {
	runId: string;
	name: string;
	startedAt: number;
	status?: string;
	iterations?: number;
	totalTokens?: number;
}[] {
	if (!fs.existsSync(journalDir)) return [];

	let entries: string[];
	try {
		entries = fs.readdirSync(journalDir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}

	const runs = [];
	for (const entry of entries) {
		const records = readGraphJournal(path.join(journalDir, entry));
		const meta = records.find((r): r is GraphJournalRunRecord => r.type === "graph_run");
		if (!meta) continue;

		const result = records.find((r): r is GraphJournalResultRecord => r.type === "graph_result");
		runs.push({
			runId: meta.runId,
			name: meta.name,
			startedAt: meta.startedAt,
			status: result?.status ?? "incomplete",
			iterations: result?.iterations,
			totalTokens: result?.totalTokens,
		});
	}

	return runs.sort((a, b) => b.startedAt - a.startedAt);
}
