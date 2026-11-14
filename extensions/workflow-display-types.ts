/**
 * Workflow display types for real-time TUI monitoring and progress tracking.
 */

/**
 * Workflow metadata shown in the run list and detail panes.
 *
 * Defined here rather than imported from the workflow engine: the display
 * layer outlived the imperative engine, and graph runs supply the same
 * fields.
 */
export interface WorkflowMetaPhase {
	title: string;
}

export interface WorkflowMeta {
	name: string;
	description?: string;
	whenToUse?: string;
	phases?: WorkflowMetaPhase[];
}
import type { AgentHistoryEntry } from "./types.ts";

export type { AgentHistoryEntry };

/**
 * Current status of a single agent in the workflow.
 */
export type AgentStatus = "queued" | "running" | "done" | "error" | "skipped" | "cached";

/**
 * Per-agent snapshot for display.
 */
export interface WorkflowAgentSnapshot {
	/** Sequential agent ID */
	id: number;
	/** Display label for this agent */
	label: string;
	/** Phase this agent belongs to */
	phase?: string;
	/** Original task prompt */
	prompt: string;
	/** Current status */
	status: AgentStatus;
	/** Result preview (truncated) */
	resultPreview?: string;
	/** Error message if failed */
	error?: string;
	/** Output tokens used */
	outputTokens?: number;
	/** Input tokens used */
	inputTokens?: number;
	/** Wall-clock duration */
	durationMs?: number;
	/** Model used */
	model?: string;
	/** Number of turns */
	turns?: number;
	/** Number of tool uses */
	toolUses?: number;
	/** Full result value */
	result?: unknown;
	/** Error code if failed */
	errorCode?: string;
	/** Whether failure is recoverable */
	recoverable?: boolean;
	/** Path to the child transcript JSONL file for live streaming */
	transcriptPath?: string;
	/**
	 * Path to this agent's persisted pi session JSONL, when the node is an
	 * agent. The /workflows navigator uses this to let the user inspect the
	 * agent's full conversation (Decision 1 session persistence).
	 */
	sessionId?: string;
	/** Live history events (tool calls, diffs, outputs) */
	history?: AgentHistoryEntry[];
}

/**
 * Per-phase snapshot for display.
 */
export interface WorkflowPhaseSnapshot {
	/** Phase name */
	title?: string;
	/** Sequential phase index */
	index: number;
	/** Phase status */
	status: "pending" | "active" | "completed";
	/** Agents in this phase */
	agents: WorkflowAgentSnapshot[];
}

/**
 * Complete workflow run snapshot for display.
 */
export interface WorkflowSnapshot {
	/** Workflow metadata */
	meta: WorkflowMeta;
	/** Overall run status */
	status: "running" | "completed" | "error" | "cancelled";
	/** Phases in the workflow */
	phases: WorkflowPhaseSnapshot[];
	/** All agents (flat list) */
	agents: WorkflowAgentSnapshot[];
	/** Total agents spawned so far */
	totalAgents: number;
	/** Total tokens used so far */
	totalTokens: number;
	/** Workflow duration so far */
	durationMs: number;
	/** Final workflow result */
	result?: unknown;
	/** Final error message */
	error?: string;
	/** Log messages */
	logs: string[];
}

/**
 * Options for rendering workflow snapshots.
 */
export interface WorkflowDisplayOptions {
	/** Max lines of output */
	maxHeight?: number;
	/** Max agents to show per phase */
	maxAgents?: number;
	/** Show result previews */
	showResultPreviews?: boolean;
	/** Show token counts */
	showTokens?: boolean;
	/** Show model info */
	showModel?: boolean;
	/** Compact mode (single line per phase) */
	compact?: boolean;
}

/**
 * Summary statistics for a workflow run.
 */
export interface WorkflowStats {
	totalAgents: number;
	completedAgents: number;
	failedAgents: number;
	totalTokens: number;
	totalDurationMs: number;
	averageTokensPerAgent: number;
	averageDurationPerAgent: number;
}
