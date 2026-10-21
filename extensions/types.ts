/**
 * Type definitions for pi-workflow subagent execution
 */

import * as os from "node:os";
import * as path from "node:path";
import type { EventEmitter } from "node:events";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export type ReadonlySessionManager = ExtensionContext["sessionManager"];
import type { AgentConfig } from "./agents.ts";
import type { ModelScopeConfig } from "./model-scope.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "./capability-ceiling.ts";

/**
 * Read-only handles needed to resolve `context: "fork"` subagents: a
 * compaction-style summary of the parent session, generated on demand.
 * Fully optional — when absent, fork requests gracefully fall back to fresh.
 */
export interface ForkContextOptions {
	sessionManager: ReadonlySessionManager;
	modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		/**
		 * Headers come back as `ProviderHeaders` (`Record<string, string | null>`):
		 * a `null` value is a header-deletion marker, not a real value. Consumers
		 * that forward these to a plain `Record<string, string>` API (like
		 * generateSummaryWithUsage) must filter nulls out first.
		 */
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	/** Fallback model used for summarization when no explicit preference is configured. */
	fallbackModel?: Model<Api>;
}

function resolveTempScopeId() {
	const env = process.env;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${value.trim().replace(/[^A-Za-z0-9._-]+/g, "-")}`;
	}
	try {
		const username = os.userInfo?.().username;
		if (username) return `user-${username.trim().replace(/[^A-Za-z0-9._-]+/g, "-")}`;
	} catch {}
	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${homedir.trim().replace(/[^A-Za-z0-9._-]+/g, "-")}`;
	return "shared";
}

export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `pi-workflow-${resolveTempScopeId()}`);

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type JsonSchemaObject = Record<string, unknown>;

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

export type AgentHistoryEntry =
	| { role: "user"; text: string; timestamp?: number }
	| { role: "assistant"; text: string; kind?: "text"; timestamp?: number }
	| { role: "assistant"; kind: "toolCall"; toolName: string; args?: string; path?: string; text: string; timestamp?: number }
	| { role: "tool"; toolName: string; text: string; diff?: string; timestamp?: number }
	| { role: "toolResult"; toolName: string; text: string; isError?: boolean; diff?: string; timestamp?: number }
	| { role: "assistant"; kind: "error"; text: string; timestamp?: number }
	| { role: "assistant"; kind: "thinking"; text: string; timestamp?: number };

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TurnBudgetConfig {
	maxTurns: number;
	graceTurns?: number;
}

export interface ResolvedTurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export interface ToolBudgetConfig {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface ResolvedToolBudget {
	soft?: number;
	hard: number;
	block: readonly string[] | string[] | "*";
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
	outcome: ToolBudgetOutcome;
	toolCount: number;
	softReachedAt?: number;
	hardReachedAt?: number;
	blockedTool?: string;
}

export type TurnBudgetOutcome = "within-budget" | "wrap-up-requested" | "termination-deferred" | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
	outcome: TurnBudgetOutcome;
	turnCount: number;
	wrapUpRequestedAtTurn?: number;
	terminationDeferredAtTurn?: number;
	exceededAtTurn?: number;
}

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export type AcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified";

export type AcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface AcceptanceGate {
	id: string;
	must: string;
	evidence?: AcceptanceEvidenceKind[];
	severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
	agent?: string;
	focus?: string;
	required?: boolean;
}

export interface AcceptanceConfig {
	level?: AcceptanceLevel;
	criteria?: Array<string | AcceptanceGate>;
	evidence?: AcceptanceEvidenceKind[];
	verify?: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules?: string[];
	reason?: string;
}

export type AcceptanceInput = Exclude<AcceptanceLevel, "none"> | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
	id: string;
	must: string;
	evidence: AcceptanceEvidenceKind[];
	severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
	level: Exclude<AcceptanceLevel, "auto">;
	explicit: boolean;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	evidence: AcceptanceEvidenceKind[];
	verify: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules: string[];
	reason?: string;
}

export interface AcceptanceReport {
	criteriaSatisfied?: Array<{
		id?: string;
		status: "satisfied" | "not-satisfied" | "not-applicable";
		evidence: string;
	}>;
	changedFiles?: string[];
	testsAddedOrUpdated?: string[];
	commandsRun?: Array<{
		command: string;
		result: "passed" | "failed" | "not-run";
		summary: string;
	}>;
	validationOutput?: string[];
	residualRisks?: string[];
	noStagedFiles?: boolean;
	diffSummary?: string;
	reviewFindings?: string[];
	manualNotes?: string;
	notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	id: string;
	status: AcceptanceRuntimeCheckStatus;
	message: string;
}

export interface AcceptanceVerifyResult {
	id: string;
	command: string;
	cwd?: string;
	exitCode: number | null;
	status: "passed" | "failed" | "timed-out" | "allowed-failure";
	stdout?: string;
	stderr?: string;
	durationMs: number;
}

export interface AcceptanceReviewResult {
	status: "review-required" | "reviewed" | "blockers";
	findings: Array<{
		severity: "blocker" | "non-blocking";
		file?: string;
		issue: string;
		rationale: string;
	}>;
}

export type AcceptanceEvidenceStatus =
	| "pending"
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "rejected";

export type AcceptanceLedgerStatus =
	| AcceptanceEvidenceStatus
	| "review-required"
	| "reviewed"
	| "accepted";

export interface AcceptanceLedger {
	status: AcceptanceLedgerStatus;
	evidenceStatus: AcceptanceEvidenceStatus;
	explicit: boolean;
	effectiveAcceptance: ResolvedAcceptanceConfig;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	childReport?: AcceptanceReport;
	childReportParseError?: string;
	runtimeChecks: AcceptanceRuntimeCheck[];
	verifyRuns: AcceptanceVerifyResult[];
	reviewResult?: AcceptanceReviewResult;
	parentDecision?: {
		status: "accepted" | "rejected";
		at: string;
		reason?: string;
	};
}

export interface ProtocolOutputLimit {
	code: "protocol_output_limit";
	stream: "stdout" | "stderr";
	limitBytes: number;
	observedBytes: number;
	diagnosticPrefix: string;
	diagnosticTail: string;
}

export interface SingleResult {
	agent: string;
	task: string;
	context?: "fresh" | "fork";
	exitCode: number;
	detached?: boolean;
	detachedReason?: string;
	/** The supervisor question that caused the detach, if any. Included so
	 * the caller (e.g., the subagent tool result) can present it inline
	 * rather than waiting for a separate workflow-agent-question message
	 * that may not arrive before the model acts on the tool result. */
	supervisorQuestion?: string;
	/** The requestId of the supervisor question, for the workflow_reply tool. */
	supervisorRequestId?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	stopReason?: "end" | "error" | "aborted";
	errorMessage?: string;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	error?: string;
	protocolError?: ProtocolOutputLimit;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	structuredOutput?: unknown;
	structuredOutputFailed?: boolean;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	agentContract?: { version: 1 };
	launchContractDigest?: string;
	progressSummary?: { toolCount: number; tokens: number; durationMs: number };
	transcriptPath?: string;
	transcriptError?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	/** POSIX signal that terminated the child process, if any (e.g. "SIGKILL" from an OOM kill). */
	exitSignal?: string | null;
	/**
	 * Classification of this result's failure, if any: "technical" (LLM
	 * provider error, process crash, infra problem — should abort a workflow)
	 * vs "agent" (the agent ran but its own work has errors, e.g. failed
	 * tests — should NOT abort a workflow) vs "none" (success). Populated by
	 * runSingleAgent() via classifySingleResultFailure().
	 */
	failureClass?: "technical" | "agent" | "none";
	failureReason?: string;
	failureCode?: string;
}

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	transcriptPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	dir?: "project" | "session" | "temp";
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeTranscript?: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export type ControlEventType = "active_long_running" | "needs_attention" | "idle" | "error";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: string[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: string[];
}

export interface ControlEvent {
	type: ControlEventType;
	from?: string;
	to: string;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
	reason?: string;
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export interface RunSyncOptions {
	parentSessionId?: string;
	onEvent?: (event: Record<string, unknown>) => void;
	/**
	 * Fired on meaningful lifecycle events (tool start, turn end, message end)
	 * with a snapshot of the current AgentProgress. Lets a caller show a live
	 * "what is this subagent doing right now" status line while it runs —
	 * without needing to poll the .jsonl session file or /workflows.
	 */
	onProgress?: (progress: AgentProgress) => void;
	context?: "fresh" | "fork";
	/** Read-only handles for resolving `context: "fork"` via compaction-style summary. */
	forkContext?: ForkContextOptions;
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	enforceHardTurnLimit?: boolean;
	toolBudget?: ResolvedToolBudget;
	allowZeroToolBudget?: boolean;
	allowIntercomDetach?: boolean;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	waitToolEnabled?: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	nestedRoute?: NestedRouteInfo;
	modelOverride?: string;
	thinkingOverride?: AgentConfig["thinking"];
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	preferredModelProvider?: string;
	modelScope?: ModelScopeConfig;
	skills?: string[];
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	/**
	 * Intercom wiring, forwarded to the child process as environment.
	 *
	 * Read by execution.ts and consumed by pi-args.ts, but not currently set
	 * by any caller in this package: reserved for future intercom routing.
	 */
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	/** Event emitter for intercom detach signals (conditional detach-on-ask). */
	intercomEvents?: EventEmitter;
	/** Control-event policy. Defaults to DEFAULT_CONTROL_CONFIG when unset. */
	controlConfig?: ControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	/**
	 * Called when a detached child process finally exits.
	 *
	 * When `allowIntercomDetach` is true and the child calls `ask_supervisor`,
	 * `runSingleAttempt` returns a detached receipt immediately (so the parent's
	 * turn unblocks) while the child keeps running. This callback fires when
	 * that child process eventually exits — whether it gets a supervisor reply,
	 * times out, or errors. The caller should do final bookkeeping here:
	 * mark the agent as done, deliver the final result, clean up channels, etc.
	 */
	onDetachedExit?: (result: SingleResult) => void;
	agentContract?: { version: 1 };
	/** Extra environment variables injected into the child process. */
	extraEnv?: Record<string, string>;
	acceptance?: AcceptanceInput;
	acceptanceContext?: {
		mode?: "single" | "parallel" | "chain";
		async?: boolean;
		dynamic?: boolean;
		dynamicGroup?: boolean;
	};
}

// ============================================================================
// Intercom Events
// ============================================================================

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

export const DEFAULT_TURN_BUDGET_GRACE_TURNS = 1;

export const DEFAULT_TOOL_BUDGET_BLOCK = ["read", "grep", "find", "ls"] as const;

export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

function normalizeNonNegativeInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	return normalizeNonNegativeInteger(value);
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}
