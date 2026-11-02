/**
 * Core execution logic for running subagents as child pi processes.
 *
 * Subagent execution — spawns child pi processes for single-agent delegation.
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "./child-transcript.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ProtocolOutputLimit,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	type AcceptanceLedger,
	type ControlEvent,
	type MaxOutputConfig,
	type ResolvedAcceptanceConfig,
	type ResolvedTurnBudget,
	type RunSyncOptions,
	truncateOutput,
	checkSubagentDepth,
	getSubagentDepthEnv,
	resolveChildMaxSubagentDepth,
} from "./types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	resolveControlConfig,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "./subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	hasEmptyTerminalAssistantResponse,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "./skills.ts";
import { buildAgentMemoryInjection } from "./agent-memory.ts";
import { generateForkSummary, formatForkContextBlock } from "./fork-context.ts";
import { evaluateCompletionMutationGuard } from "./completion-guard.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import * as fs from "fs";
import { createJsonlWriter, type JsonlWriter } from "./jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "./post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir, resolvePiLaunchToolPlan } from "./pi-args.ts";
import { decodeSubagentCapabilityCeiling, resolveCurrentSubagentCapabilityCeiling, SUBAGENT_CAPABILITY_CEILING_ENV } from "./capability-ceiling.ts";
import { resolveEffectiveThinking } from "./model-info.ts";
import { MISSING_STRUCTURED_OUTPUT_CALL_ERROR, readStructuredOutput } from "./structured-output.ts";
import { readChildToolDiagnosticError } from "./tool-availability.ts";
import { captureSingleOutputSnapshot, extractChildWrittenOutput, formatSavedOutputReference, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "./single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "./model-fallback.ts";
import { classifySingleResultFailure } from "./failure-classifier.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "./long-running-guard.ts";
import { acceptanceFailureMessage, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport } from "./acceptance.ts";
import { appendTurnBudgetSystemPrompt, DEFAULT_TURN_BUDGET, formatTurnBudgetOutput, initialTurnBudgetState, resolveTurnBudgetConfig, turnBudgetDecision, turnBudgetDeferredNote, turnBudgetDeferredState, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "./turn-budget.ts";
import { loadAgentSettings } from "./agent-settings.ts";
import { initialToolBudgetState, toolBudgetState } from "./tool-budget.ts";
import { agentDefinitionDigest, launchBindingDigest } from "./launch-contract.ts";
import { createBoundedByteTail, createBoundedLineReader, formatProtocolOutputLimit, MAX_CHILD_STDERR_BYTES, projectChildLifecycle, type ChildLifecycleAction, type ProtocolOutputLimit as ProtocolOutputLimitType } from "./child-protocol.ts";

import { EventEmitter } from "node:events";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

/** Herdr identity belongs to the interactive parent pane, never a headless child Pi session. */
export const HERDR_CHILD_IDENTITY_ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"HERDR_SESSION",
] as const;

/** Clone an environment without parent Herdr pane identity for a spawned child. */
export function stripHerdrPaneIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const childEnv = { ...env };
	for (const key of HERDR_CHILD_IDENTITY_ENV_KEYS) delete childEnv[key];
	return childEnv;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function withRunContext<T extends SingleResult>(result: T, context: RunSyncOptions["context"]): T {
	if (!context) return result;
	result.context = context;
	return result;
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function formatTimeoutMessage(timeoutMs: number): string {
	return `Subagent timed out after ${timeoutMs}ms.`;
}

function resolveAttemptTimeout(options: RunSyncOptions): { timeoutMs: number; remainingMs: number; message: string } | undefined {
	if (options.timeoutMs === undefined) return undefined;
	const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
	return {
		timeoutMs: options.timeoutMs,
		remainingMs: Math.max(0, deadlineAt - Date.now()),
		message: formatTimeoutMessage(options.timeoutMs),
	};
}

function buildPendingAcceptanceLedger(acceptance: ResolvedAcceptanceConfig): AcceptanceLedger {
	return {
		status: "pending",
		evidenceStatus: "pending",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		modelCandidates?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		jsonlWriter?: JsonlWriter;
		artifactPaths?: ArtifactPaths;
		transcriptWriter?: ChildTranscriptWriter;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
		/** Parent session file path, when context: "fork" successfully resolved a summary. Env escape hatch for the child. */
		forkParentSessionFile?: string;
	},
): Promise<SingleResult> {
	const effectiveThinking = options.thinkingOverride ?? agent.thinking;
	const modelArg = applyThinkingSuffix(model, effectiveThinking, options.thinkingOverride !== undefined);
	const resolvedThinking = resolveEffectiveThinking(modelArg, effectiveThinking);
	const { args, env: sharedEnv, tempDir, toolDiagnosticPath, capabilityAudit } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: modelArg,
		thinking: effectiveThinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		systemPrompt: appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget),
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		parentSessionId: options.parentSessionId,
		structuredOutput: options.structuredOutput,
		toolBudget: options.toolBudget,
		allowZeroToolBudget: options.allowZeroToolBudget,
		turnBudget: options.turnBudget,
		waitToolEnabled: options.waitToolEnabled,
		capabilityCeiling: options.capabilityCeiling,
	});

	const effectiveSystemPrompt = appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget);
	const toolPlan = resolvePiLaunchToolPlan({
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		structuredOutput: Boolean(options.structuredOutput),
		capabilityCeiling: options.capabilityCeiling,
		inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
	});
	const launchContractDigest = launchBindingDigest({
		definitionDigest: agentDefinitionDigest(agent),
		task: shared.originalTask ?? task,
		...(modelArg ? { model: modelArg } : {}),
		modelCandidates: shared.modelCandidates,
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		systemPrompt: effectiveSystemPrompt,
		systemPromptMode: agent.systemPromptMode ?? "append",
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: shared.resolvedSkillNames ?? [],
		tools: toolPlan.effectiveToolAllowlist,
		extensions: toolPlan.extensionArgs,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(options.outputPath ? { outputPath: options.outputPath } : {}),
		outputMode: options.outputMode ?? "inline",
		...(options.structuredOutput ? { structuredOutputSchema: options.structuredOutput.schema } : {}),
	});
	const result: SingleResult = withRunContext({
		agent: agent.name,
		task: shared.originalTask ?? task,
		...(options.agentContract ? { agentContract: options.agentContract } : {}),
		launchContractDigest,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		...(resolvedThinking ? { thinking: resolvedThinking } : {}),
		artifactPaths: shared.artifactPaths,
		transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
		...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
		...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
		...(capabilityAudit ? { capabilityAudit } : {}),
	}, options.context ?? agent.defaultContext);
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = resolveControlConfig(options.controlConfig).config;
	let interruptedByControl = false;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const turnBudget = options.turnBudget;
	let turnBudgetExceededFired = false;
	const attemptTimeout = resolveAttemptTimeout(options);
	if (attemptTimeout?.remainingMs === 0) {
		cleanupTempDir(tempDir);
		result.exitCode = 1;
		result.timedOut = true;
		result.error = attemptTimeout.message;
		result.finalOutput = attemptTimeout.message;
		return result;
	}

	const spawnEnv = stripHerdrPaneIdentity({
		...process.env,
		...sharedEnv,
		...getSubagentDepthEnv(options.maxSubagentDepth),
		...(shared.forkParentSessionFile ? { PI_FORK_PARENT_SESSION_FILE: shared.forkParentSessionFile } : {}),
		...(options.extraEnv ?? {}),
	});
	// A child Pi process has its own session file, not an independently managed
	// Herdr pane. Do not let global Herdr/mobile hooks bind that child session
	// to the parent's pane: a rejected binding can leave a reconnect timer alive
	// forever after the child settles. Ambient provider extensions stay enabled.

	// Intercom events for conditional detach-on-ask.
	// When a child calls ask_supervisor (expectsReply: true), the parent's
	// ChannelPoller emits INTERCOM_DETACH_REQUEST_EVENT; we listen for it
	// and trigger an early return (detach) so the parent's await unblocks
	// while the child keeps running. Only enabled when allowIntercomDetach is true.
	const intercomEvents = options.intercomEvents ?? new EventEmitter();
	let detachedByIntercom = false;
	let detachResolve: ((receipt: SingleResult) => void) | null = null;
	const detachPromise = new Promise<SingleResult>((resolve) => {
		detachResolve = resolve;
	});

	if (options.allowIntercomDetach) {
		intercomEvents.on(INTERCOM_DETACH_REQUEST_EVENT, (payload: any) => {
			if (detachedByIntercom) return;
			// Verify this detach request is for our run/agent/index
			if (payload.runId !== options.runId) return;
			// Agent check: allow if payload.agent is not provided (backward compat)
			if (payload.agent !== undefined && payload.agent !== agent.name) return;
			if (typeof payload.childIndex === "number" && payload.childIndex !== (options.index ?? 0)) return;

			const receiptProgress = snapshotProgress(progress);
			receiptProgress.status = "detached";
			receiptProgress.durationMs = Date.now() - startTime;
			const receipt = snapshotResult(result, receiptProgress);
			receipt.exitCode = -2;
			receipt.detached = true;
			receipt.detachedReason = "supervisor request";
			receipt.supervisorQuestion = payload.question;
			receipt.supervisorRequestId = payload.requestId;
			receipt.finalOutput = "Detached for supervisor coordination before task completion.";
			receipt.outputMode = options.outputMode ?? "inline";
			receipt.progressSummary = {
				toolCount: receiptProgress.toolCount,
				tokens: receiptProgress.tokens,
				durationMs: receiptProgress.durationMs,
			};

			detachedByIntercom = true;
			detachResolve?.(receipt);

			// Emit response so the poller knows we accepted
			intercomEvents.emit(INTERCOM_DETACH_RESPONSE_EVENT, {
				requestId: payload.requestId,
				accepted: true,
				runId: options.runId,
				agent: agent.name,
				childIndex: options.index ?? 0,
			});
		});
	}

	const spawnSpec = getPiSpawnCommand(args);
	const proc = spawn(spawnSpec.command, spawnSpec.args, {
		cwd: options.cwd ?? runtimeCwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: spawnEnv,
	});

	const stdoutReader = createBoundedLineReader({
		stream: "stdout",
		onLine: (line) => {
			try {
				const event = JSON.parse(line);
				options.onEvent?.(event);
				if (event.type === "message_end" || event.type === "tool_result_end") {
					result.messages?.push(event.message);
					if (event.message?.role === "assistant") {
						appendRecentOutput(progress, extractTextFromContent(event.message));
					}
				}
				if (event.type === "error") {
					result.errorMessage = event.error || event.message;
					result.stopReason = "error";
				}
				if (event.type === "turn_end") {
					result.usage = event.message?.usage || result.usage;
					result.stopReason = event.message?.stopReason || "end";
					// pi's real TurnEndEvent carries `turnIndex` (0-based), not
					// `turnCount` — turnIndex + 1 is the number of turns completed
					// so far. (`event.turnCount` is kept as a back-compat read for
					// fixtures/tests that predate this fix; real pi never sets it.)
					if (typeof event.turnIndex === "number") progress.turnCount = event.turnIndex + 1;
					else if (event.turnCount !== undefined) progress.turnCount = event.turnCount;
					progress.tokens = (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
					if (turnBudget && !turnBudgetExceededFired && (progress.turnCount ?? 0) >= turnBudget.maxTurns + turnBudget.graceTurns) {
						// Hard backstop: the child-side soft-block (subagent-prompt-runtime.ts)
						// should already have stopped the model from calling further tools at
						// maxTurns, letting it wrap up normally within the grace turns. This
						// only fires if the model ignored that block and kept going anyway.
						turnBudgetExceededFired = true;
						result.turnBudgetExceeded = true;
						result.error = turnBudgetExceededMessage(turnBudget, progress.turnCount ?? 0);
						trySignalChild(proc, "SIGTERM");
					}
				}
				if (event.type === "agent_end") {
					// event.messages replays the *entire* session history in one event —
					// every message_end/tool_result_end we've already collected above,
					// plus nothing else (agent-loop builds this array from the exact
					// same stream of events). It exists as a safety net for the rare
					// case the incremental collector missed something, not as the
					// primary source. Prefer the incremental array: it's known-complete
					// by construction and, unlike this one event, was never at risk of
					// exceeding the per-line protocol limit (each message_end/
					// tool_result_end line is bounded by a single message's size; this
					// line is bounded by the whole session's size and grows without
					// bound as a long, image-heavy run progresses).
					if ((!result.messages || result.messages.length === 0) && event.messages && event.messages.length > 0) {
						result.messages = event.messages;
					}
				}
				if (event.type === "abort") {
					result.stopReason = "aborted";
				}
				if (event.type === "tool_execution_start") {
					progress.toolCount++;
					const toolName: string = event.toolName || event.tool || "unknown";
					const toolArgs: string = extractToolArgsPreview(event);
					progress.currentTool = toolName;
					progress.currentToolArgs = toolArgs;
					progress.currentToolStartedAt = Date.now();
					progress.recentTools.push({
						tool: toolName,
						args: toolArgs,
						endMs: Date.now(),
					});
					progress.recentTools = progress.recentTools.slice(-20);
				}
				if (event.type === "tool_execution_end") {
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					progress.currentToolStartedAt = undefined;
				}
				if (event.type === "agent_end" || event.type === "agent_settled") {
					const action = projectChildLifecycle(event);
					if (action === "start-drain") {
						// Start draining output
					}
				}
				shared.transcriptWriter?.writeChildEvent(event);
				shared.jsonlWriter?.write({ type: "child_event", event, ts: Date.now() });
				if (
					options.onProgress &&
					(event.type === "tool_execution_start" ||
						event.type === "tool_execution_end" ||
						event.type === "turn_end" ||
						event.type === "message_end")
				) {
					progress.durationMs = Date.now() - startTime;
					progress.lastActivityAt = Date.now();
					options.onProgress(snapshotProgress(progress));
				}
			} catch {
				// Non-JSON lines are ignored
			}
		},
		onLimit: (limit: ProtocolOutputLimitType) => {
			result.protocolError = limit;
			result.error = formatProtocolOutputLimit(limit);
		},
	});

	const stderrReader = createBoundedByteTail();
	proc.stdout.on("data", (chunk) => stdoutReader.push(chunk));
	proc.stderr.on("data", (chunk) => {
		stderrReader.push(chunk);
	});

	proc.stdout.on("end", () => stdoutReader.end());

	const abortHandler = () => {
		trySignalChild(proc, "SIGTERM");
	};
	options.signal?.addEventListener("abort", abortHandler);
	options.interruptSignal?.addEventListener("abort", abortHandler);

	let timedOutMidRun = false;
	const timeoutHandle = attemptTimeout
		? setTimeout(() => {
			timedOutMidRun = true;
			trySignalChild(proc, "SIGKILL");
		}, attemptTimeout.remainingMs)
		: undefined;

	let exitCode: number | null = null;
	let exitSignal: string | null = null;

	// Shared process-close promise so both the race and the background
	// completion monitor can listen without double-registering.
	const procClosePromise = new Promise<number | null>((resolve) => {
		proc.on("close", (code, signal) => {
			resolve(code);
			exitSignal = signal;
		});
		proc.on("error", () => {
			resolve(1);
		});
	});

	try {
		// Race between process exit and intercom detach.
		// If detach wins, we return the detached receipt immediately while
		// the child keeps running in the background.
		const raceResult = await Promise.race([
			procClosePromise,
			detachPromise.then((detachedReceipt) => {
				// Detached: clean up timeout/abort handlers but DON'T kill the child.
				// The child keeps running and will poll for the supervisor reply.
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", abortHandler);
				options.interruptSignal?.removeEventListener("abort", abortHandler);

				// Start background completion monitoring for the detached child.
				// The child process is still alive; stdout/stderr listeners are still
				// accumulating events into `result`. When the child finally exits,
				// we process its final output and fire onDetachedExit so the caller
				// can do bookkeeping (mark the agent done, clean up the channel, etc).
				void (async () => {
					try {
						const childExitCode = await procClosePromise;

						// Build a final result from the accumulated state
						progress.status = "completed";
						progress.durationMs = Date.now() - startTime;
						result.exitCode = childExitCode ?? 1;
						result.exitSignal = exitSignal;
						result.finalOutput = getFinalOutput(result.messages ?? []);

						// Truncate
						const mo: Required<MaxOutputConfig> = {
							bytes: options.maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT.bytes,
							lines: options.maxOutput?.lines ?? DEFAULT_MAX_OUTPUT.lines,
						};
						const trunc = truncateOutput(result.finalOutput || "", { bytes: mo.bytes, lines: mo.lines }, shared.artifactPaths?.outputPath);
						result.finalOutput = trunc.text;

						shared.transcriptWriter?.close();

						// Snapshot for the callback — the caller gets the real final result
						const finalResult = snapshotResult(result, snapshotProgress(progress));
						finalResult.detached = undefined;
						finalResult.detachedReason = "supervisor request";
						options.onDetachedExit?.(finalResult);
					} catch {
						// Background completion is best-effort; the detached receipt
						// was already delivered to the caller.
					}
				})();

				return detachedReceipt;
			}),
		]);

		if (raceResult && typeof raceResult === "object" && "detached" in raceResult) {
			// Detached receipt returned — return it immediately to unblock the parent.
			// The child continues running in the background; onDetachedExit will fire later.
			return raceResult as SingleResult;
		}

		exitCode = raceResult as number | null;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		options.signal?.removeEventListener("abort", abortHandler);
		options.interruptSignal?.removeEventListener("abort", abortHandler);
	}

	// Attached completion path (child exited before detach fired)
	progress.status = "completed";
	progress.durationMs = Date.now() - startTime;
	result.exitCode = exitCode ?? 1;
	result.exitSignal = exitSignal;

	if (timedOutMidRun) {
		// Fixes a pre-existing gap: this path previously only SIGKILLed the
		// child without setting timedOut/error, so the resulting SIGKILL
		// exitSignal fell through to FATAL_KILL_SIGNALS in the classifier and
		// was reported as "likely an out-of-memory kill or crash" — a
		// misleading technical-failure abort for what is actually an ordinary,
		// routable agent-level timeout. See failure-classifier.ts's timedOut
		// check, which is ordered before that signal check specifically to
		// catch this.
		result.timedOut = true;
		result.error = attemptTimeout?.message ?? formatTimeoutMessage(options.timeoutMs ?? 0);
	}

	if (options.signal?.aborted) {
		result.interrupted = true;
		result.exitCode = 130;
	}

	if (result.stopReason === "aborted") {
		result.exitCode = 130;
	}

	// Parse structured output
	if (options.structuredOutput) {
		const structured = await readStructuredOutput(options.structuredOutput);
		if (structured.error) {
			result.structuredOutputFailed = true;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	// Resolve single output
	if (options.outputPath) {
		const resolved = resolveSingleOutput(
			options.outputPath,
			getFinalOutput(result.messages ?? []),
			shared.outputSnapshot,
		);
		result.finalOutput = resolved.fullOutput;
		if (resolved.savedPath) {
			result.savedOutputPath = resolved.savedPath;
			result.outputReference = formatSavedOutputReference(resolved.savedPath, resolved.fullOutput);
		}
		if (resolved.saveError) {
			result.outputSaveError = resolved.saveError;
		}
	} else {
		result.finalOutput = getFinalOutput(result.messages ?? []);
	}

	// Truncate output. Coalesce to Required<MaxOutputConfig> so the optional
	// fields on MaxOutputConfig do not leak as `number | undefined` into a
	// function that requires concrete numbers.
	const maxOutput: Required<MaxOutputConfig> = {
		bytes: options.maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT.bytes,
		lines: options.maxOutput?.lines ?? DEFAULT_MAX_OUTPUT.lines,
	};
	const truncated = truncateOutput(result.finalOutput || "", { bytes: maxOutput.bytes, lines: maxOutput.lines }, shared.artifactPaths?.outputPath);
	result.finalOutput = truncated.text;
	if (truncated.truncated) {
		result.truncation = {
			text: truncated.text,
			truncated: true,
			originalBytes: truncated.originalBytes,
			originalLines: truncated.originalLines,
			artifactPath: truncated.artifactPath,
		};
	}

	if (result.turnBudgetExceeded && result.error) {
		// Fold in whatever partial output the child produced before the
		// backstop kill — result.finalOutput is already fully assembled at
		// this point (from incrementally-collected messages), so the model's
		// last, ignored wrap-up attempt (if any) is preserved rather than
		// lost behind the budget-exceeded message alone.
		result.error = formatTurnBudgetOutput(result.error, result.finalOutput || "");
	}

	// Evaluate acceptance
	if (options.acceptance) {
		const effective = resolveEffectiveAcceptance({
			agentName: agent.name,
			acceptance: options.acceptance,
			acceptanceContext: options.acceptanceContext,
		});
		const acceptanceLedger = await evaluateAcceptance({
			acceptance: effective,
			output: result.finalOutput || "",
			cwd: options.cwd ?? runtimeCwd,
		});
		result.acceptance = acceptanceLedger;
		if (acceptanceLedger.status === "rejected") {
			result.error = acceptanceFailureMessage(acceptanceLedger);
		}
	}

	// Write artifacts
	if (shared.artifactPaths) {
		try {
			writeArtifact(shared.artifactPaths.inputPath, `Task: ${task}\n\nAgent: ${agent.name}`);
			writeArtifact(shared.artifactPaths.outputPath, result.finalOutput || "");
			writeMetadata(shared.artifactPaths.metadataPath, {
				agent: agent.name,
				task,
				exitCode: result.exitCode,
				model: result.model,
				turns: result.usage.turns,
				tokens: result.usage,
				acceptance: result.acceptance,
			});
		} catch {
			// Artifact writing is best-effort
		}
	}

	shared.transcriptWriter?.close();

	return result;
}

export async function runSingleAgent(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	callOptions: RunSyncOptions,
): Promise<SingleResult> {
	// Turn budget: resolved once here, at the single choke point every
	// subagent spawn path (graph nodes and plain `subagent` tool calls alike)
	// funnels through. This matters for three reasons:
	//
	// 1. Coverage: graph-node-runner.ts explicitly forwards
	//    resolved.agent.turnBudget into callOptions, but the plain `subagent`
	//    tool call sites in index.ts never did — agent frontmatter turnBudget
	//    was silently ignored there. Reading `agent.turnBudget` directly here
	//    (not just callOptions.turnBudget) closes that gap for every caller at
	//    once, instead of requiring each call site to remember to forward it.
	//
	// 2. Normalization: both callOptions.turnBudget and agent.turnBudget carry
	//    an OPTIONAL graceTurns (TurnBudgetConfig, straight from parsed
	//    frontmatter) — a custom agent declaring only
	//    `turnBudget: {"maxTurns": 10}` would otherwise carry graceTurns:
	//    undefined all the way into arithmetic (maxTurns + graceTurns) below
	//    and produce NaN. Harmless while turnBudget was purely advisory;
	//    load-bearing now that it's enforced. resolveTurnBudgetConfig fills
	//    in DEFAULT_TURN_BUDGET_GRACE_TURNS, idempotently, for any shape.
	//
	// 3. Default: only applies when nothing above declared one. Precedence:
	//    explicit callOptions.turnBudget > agent frontmatter > project/user
	//    settings' defaultTurnBudget > DEFAULT_TURN_BUDGET.
	//    `defaultTurnBudget: null` in settings disables the default outright,
	//    restoring pre-feature unbounded behavior for agents with no
	//    frontmatter turnBudget.
	let resolvedTurnBudget: ResolvedTurnBudget | undefined;
	const declaredTurnBudget = callOptions.turnBudget ?? agent.turnBudget;
	if (declaredTurnBudget !== undefined) {
		const { turnBudget: normalized } = resolveTurnBudgetConfig(declaredTurnBudget, "turnBudget");
		resolvedTurnBudget = normalized ?? (declaredTurnBudget as ResolvedTurnBudget);
	} else {
		const settings = loadAgentSettings(runtimeCwd);
		if (settings.defaultTurnBudget === null) {
			resolvedTurnBudget = undefined;
		} else if (settings.defaultTurnBudget !== undefined) {
			const { turnBudget: parsed } = resolveTurnBudgetConfig(settings.defaultTurnBudget, "defaultTurnBudget");
			resolvedTurnBudget = parsed ?? DEFAULT_TURN_BUDGET;
		} else {
			resolvedTurnBudget = DEFAULT_TURN_BUDGET;
		}
	}
	const options: RunSyncOptions = resolvedTurnBudget === callOptions.turnBudget ? callOptions : { ...callOptions, turnBudget: resolvedTurnBudget };

	// PI_SUBAGENT_DEPTH tracks how many subagent layers deep the *current*
	// process already is; checked before spawning another layer so a chain
	// of subagents delegating to more subagents cannot recurse unbounded.
	// options.maxSubagentDepth is this call's own ceiling (usually the
	// parent's, tightened by the calling agent's maxSubagentDepth frontmatter
	// — see resolveChildMaxSubagentDepth() at each spawn site); depth itself
	// always comes from the environment the current process was launched
	// with, not from options, since a process cannot lie about its own depth.
	const depthCheck = checkSubagentDepth(options.maxSubagentDepth);
	if (depthCheck.blocked) {
		return {
			agent: agent.name,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			stopReason: "error",
			error:
				`Nested subagent call blocked (depth=${depthCheck.depth}, max=${depthCheck.maxDepth}). ` +
				"This process is already at the maximum subagent nesting depth. " +
				"Complete the current task directly instead of delegating further.",
		};
	}

	const modelCandidates = buildModelCandidates(
		agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		{ scope: options.modelScope },
	);

	const resolvedSkillNames = options.skills ?? agent.skills;
	const skillsWarning = resolvedSkillNames ? undefined : undefined;

	const artifactPaths = options.artifactConfig?.enabled
		? getArtifactPaths(
			options.artifactsDir ?? path.join(runtimeCwd, ".pi-workflow", "artifacts"),
			options.runId,
			agent.name,
			options.index,
		)
		: undefined;

	const transcriptWriter = artifactPaths ? createChildTranscriptWriter({ transcriptPath: artifactPaths.transcriptPath }) : undefined;
	const jsonlWriter = artifactPaths ? createJsonlWriter(artifactPaths.jsonlPath) : undefined;

	const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);

	const { prompt: systemPrompt, notes: contextNotes, parentSessionFile: forkParentSessionFile } = await buildSystemPrompt(agent, runtimeCwd, options);

	const shared = {
		sessionEnabled: Boolean(options.sessionFile || options.sessionDir),
		systemPrompt,
		resolvedSkillNames,
		modelCandidates,
		skillsWarning,
		jsonlPath: artifactPaths?.jsonlPath,
		jsonlWriter,
		artifactPaths,
		transcriptWriter,
		attemptNotes: [...contextNotes] as string[],
		outputSnapshot,
		originalTask: task,
		forkParentSessionFile,
	};

	let lastResult: SingleResult | undefined;
	let currentModels = [...modelCandidates];
	let attempt = 0;

	while (true) {
		const currentModel = currentModels[attempt] ?? currentModels[currentModels.length - 1];
		if (!currentModel && attempt > 0) {
			// No more models to try
			break;
		}

		try {
			lastResult = await runSingleAttempt(
				runtimeCwd,
				agent,
				task,
				currentModel,
				options,
				shared,
			);
		} catch (error) {
			lastResult = {
				agent: agent.name,
				task,
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				model: currentModel,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		if (lastResult.exitCode === 0) {
			break;
		}

		// Check for retryable model failure
		const errorText = lastResult.error || lastResult.stopReason || "";
		if (isRetryableModelFailure(errorText) && attempt + 1 < currentModels.length) {
			attempt++;
			shared.attemptNotes.push(formatModelAttemptNote(
				{ model: currentModel ?? "unknown", success: false, error: errorText, exitCode: lastResult.exitCode },
				currentModels[attempt],
			));
			continue;
		}

		break;
	}

	jsonlWriter?.close();

	const finalResult = lastResult ?? {
		agent: agent.name,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "No model candidates available",
	};

	if (finalResult.exitCode !== 0 || finalResult.error || finalResult.errorMessage) {
		const classification = classifySingleResultFailure(finalResult, finalResult.exitSignal);
		finalResult.failureClass = classification.class;
		finalResult.failureReason = classification.reason;
		finalResult.failureCode = classification.code;
		// A degraded-to-"none" classification (currently: an agent_end protocol
		// limit where the incremental messages already have everything, see
		// failure-classifier.ts) means the run genuinely succeeded. Clear the
		// error-shaped fields here rather than leaving them for every consumer
		// of SingleResult to separately learn "error set but failureClass none
		// means fine actually" — index.ts, graph-node-runner.ts, and the
		// workflow/graph display all key off result.error/protocolError
		// directly in places, not just failureClass, so a stray error string
		// would still surface as a failure in the UI/journal without this.
		if (classification.class === "none") {
			finalResult.error = undefined;
			finalResult.errorMessage = undefined;
			finalResult.protocolError = undefined;
		}
	} else {
		finalResult.failureClass = "none";
	}

	return finalResult;
}

export async function buildSystemPrompt(agent: AgentConfig, cwd: string, options: RunSyncOptions): Promise<{ prompt: string; notes: string[]; parentSessionFile?: string }> {
	let prompt = agent.systemPrompt || "";
	const notes: string[] = [];
	let parentSessionFile: string | undefined;

	// Resolve and inject fork/fresh context. context: "fork" produces a
	// compaction-style structured summary of the parent session (not the raw
	// transcript) to keep cost bounded regardless of parent session length.
	// Falls back to fresh (no injection) when forkContext handles are absent
	// or summarization fails — never throws. Default is "fork" when unspecified.
	const effectiveContext = options.context ?? agent.defaultContext ?? "fork";
	if (effectiveContext === "fork") {
		if (options.forkContext) {
			const forkResult = await generateForkSummary({
				sessionManager: options.forkContext.sessionManager,
				modelRegistry: options.forkContext.modelRegistry,
				fallbackModel: options.forkContext.fallbackModel,
				signal: options.signal,
			});
			if (forkResult) {
				prompt = prependContext(prompt, formatForkContextBlock(forkResult));
				parentSessionFile = forkResult.parentSessionFile;
			} else {
				notes.push("Requested context: \"fork\" but parent session summary could not be generated; running with fresh context instead.");
			}
		} else {
			notes.push("Requested context: \"fork\" but no parent session handles were available; running with fresh context instead.");
		}
	}

	// Inject acceptance prompt
	if (options.acceptance) {
		const effective = resolveEffectiveAcceptance({
			agentName: agent.name,
			acceptance: options.acceptance,
			acceptanceContext: options.acceptanceContext,
		});
		prompt = appendSystemPrompt(prompt, formatAcceptancePrompt(effective));
	}

	// Inject memory
	if (agent.memory) {
		const memoryInjection = await buildAgentMemoryInjection(agent.memory, cwd);
		if (memoryInjection) {
			prompt = appendSystemPrompt(prompt, memoryInjection);
		}
	}

	// Inject skills
	if (options.skills && options.skills.length > 0) {
		const skillInjection = await buildSkillInjection(options.skills, cwd);
		if (skillInjection) {
			prompt = appendSystemPrompt(prompt, skillInjection);
		}
	}

	// Inject completion guard
	if (agent.completionGuard) {
		prompt = appendSystemPrompt(prompt, "## Completion guard\nOnly declare completion when you have fully addressed the task. Do not stop prematurely.");
	}

	return { prompt, notes, parentSessionFile };
}

function appendSystemPrompt(base: string, addition: string): string {
	return base ? `${base}\n\n${addition}` : addition;
}

/** Put context BEFORE the task instruction so the agent reads context first. */
function prependContext(task: string, context: string): string {
	return context ? `${context}\n\n${task}` : task;
}
