/**
 * pi-workflow - Subagent delegation + dynamic workflow orchestration
 *
 * Tools:
 * - subagent: Delegate tasks to named subagents (single + parallel modes)
 * - workflow: Execute dynamic JavaScript workflows that orchestrate subagents
 *
 * Commands:
 * - /agents: List available subagents
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type AgentToolResult, type ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { buildAgentCatalogGuideline, createListAgentsTool } from "./agent-catalog.ts";
import { createGraphWorkflowTool } from "./graph-tool.ts";
import { installResultDelivery, stageRunReport } from "./result-delivery.ts";
import {
	sweepOrphanedChannels,
	ensureChannel,
	cleanupChannel,
	ChannelPoller,
	PI_WORKFLOW_CHANNEL_DIR_ENV,
	PI_WORKFLOW_RUN_ID_ENV,
} from "./channel.ts";
import { RequestBroker } from "./request-broker.ts";
import {
	createAskUserQuestionTool,
	createAskSupervisorTool,
} from "./ask-tools.ts";
import { createNodeStateTool } from "./node-state-tool.ts";
import { installBrokerSinks, setBrokerContext } from "./broker-sinks.ts";
import { runSingleAgent } from "./execution.ts";
import {
	type SingleResult,
	type ForkContextOptions,
	type AgentHistoryEntry,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	INTERCOM_DETACH_REQUEST_EVENT,
} from "./types.ts";
import { listSavedWorkflows, deleteSavedWorkflow, createListWorkflowsTool } from "./workflow-library.ts";
import { getFinalOutput, formatProgressLine } from "./utils.ts";
import { TechnicalFailureError, type FailureClassification } from "./failure-classifier.ts";
import { WorkflowManager } from "./workflow-manager.ts";
import { openWorkflowNavigator } from "./workflow-ui.ts";
import { registerTaskPanel } from "./task-panel.ts";
import { registerWorkflowMode } from "./workflow-mode.ts";
import { planCreate, planGet, planList, planEdit, planDelete } from "./plan-tool.ts";
import { openPlansNavigator } from "./plan-ui.ts";
import {
	contractCreate, contractGet, contractList, contractEdit, contractPropose, contractSupersede,
} from "./contract-tool.ts";
import { openContractsNavigator } from "./contract-ui.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

interface SubagentDetails {
	mode: "single" | "parallel";
	agentScope: AgentScope;
	results: SingleResult[];
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.error || result.errorMessage || getFinalOutput(result.messages ?? []) || "(no output)";
	}
	return result.finalOutput || getFinalOutput(result.messages ?? []) || "(no output)";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath: path.relative(process.cwd(), filePath) };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

const ContextModeSchema = StringEnum(["fresh", "fork"] as const, {
	description:
		'Context mode: "fork" (default) injects a compaction-style structured summary (Goal/Progress/Key Decisions/etc) ' +
		'of the parent session, not the raw transcript, keeping cost bounded. "fresh" starts with no inherited history.',
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	context: Type.Optional(ContextModeSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both".',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	context: Type.Optional(ContextModeSchema),
});

/**
 * Run a single subagent and return just the output text.
 * Used by the workflow tool's agent() global.
 */
export async function runSubagentForWorkflow(
	cwd: string,
	agent: AgentConfig,
	task: string,
	options: {
		signal?: AbortSignal;
		parentSessionId?: string;
		onEvent?: (event: Record<string, unknown>) => void;
		runId?: string;
		index?: number;
		context?: "fresh" | "fork";
		forkContext?: ForkContextOptions;
		label?: string;
	},
): Promise<string> {
	const runId = options.runId ?? `workflow-${Date.now()}`;
	const artifactsDir = path.join(cwd, ".pi-workflow", "artifacts");
	const result = await runSingleAgent(cwd, agent, task, {
		runId,
		index: options.index,
		signal: options.signal,
		parentSessionId: options.parentSessionId,
		onEvent: options.onEvent,
		context: options.context,
		forkContext: options.forkContext,
		artifactsDir,
		artifactConfig: {
			enabled: true,
			includeInput: true,
			includeOutput: true,
			includeJsonl: true,
			includeTranscript: true,
			includeMetadata: true,
			cleanupDays: 7,
		},
	});
	// A "technical" failure (LLM provider error, process crash, protocol
	// limit, etc. — see failure-classifier.ts) is not something the workflow
	// script should be allowed to silently swallow into a garbage/error-text
	// result: throw so agent() in workflow.ts halts the whole run instead of
	// letting a downstream agent() call consume corrupted input.
	if (result.failureClass === "technical") {
		throw new TechnicalFailureError(
			options.label || agent.name,
			{
				class: "technical",
				code: (result.failureCode as FailureClassification["code"]) ?? "provider-error",
				reason: result.failureReason || result.error || result.errorMessage || "Unknown technical failure",
			},
			runId,
		);
	}
	return getResultOutput(result);
}

const WorkflowStatusParams = Type.Object({
	runId: Type.String({ description: "The workflow run ID to inspect (e.g. as reported in a workflow's failure message or from /workflows)." }),
	agentId: Type.Optional(
		Type.Number({ description: "If provided, return full detail (prompt, result, error, tool-call/output history) for just this one agent. Otherwise returns a summary of all agents in the run." }),
	),
	historyLimit: Type.Optional(
		Type.Number({ description: "Max number of history entries to return per agent when agentId is provided (default 100; entries are chronological, so this trims from the end)." }),
	),
});

export function summarizeHistoryEntry(entry: AgentHistoryEntry): string {
	if (entry.role === "assistant" && entry.kind === "toolCall") {
		return `\u2192 ${entry.toolName}${entry.args ? `(${entry.args})` : ""}`;
	}
	if (entry.role === "toolResult") {
		const tag = entry.isError ? " [error]" : "";
		return `\u2190 ${entry.toolName}${tag}: ${(entry.text || "").slice(0, 500)}`;
	}
	if (entry.role === "tool") {
		return `\u2190 ${entry.toolName}: ${(entry.text || "").slice(0, 500)}`;
	}
	if (entry.role === "assistant") return `[assistant] ${(entry.text || "").slice(0, 1000)}`;
	return `[user] ${(entry.text || "").slice(0, 500)}`;
}

export function registerWorkflowStatusTool(pi: ExtensionAPI, workflowManager: WorkflowManager) {
	pi.registerTool({
		name: "workflow_status",
		label: "Workflow Status",
		description: [
			"Investigate a workflow run's status, errors, and agent history programmatically \u2014 without needing the interactive /workflows TUI.",
			"Use this after a workflow tool call reports a failure (especially a technical failure) to inspect exactly which agent failed, why, and what it was doing.",
			"Call with just runId for a summary of every agent's status/error. Call with runId + agentId for one agent's full prompt, result, error, and tool-call/output history.",
		].join(" "),
		parameters: WorkflowStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const run = workflowManager.getRun(params.runId);
			if (!run) {
				// A process that never itself executed a workflow (e.g. a fresh
				// session asking about a run from an earlier CLI invocation) has
				// no journalDir set yet — the graph tool only sets it as a side
				// effect of running. Compute it the same way graph-tool.ts does,
				// so a cross-process lookup works even when nothing has run here.
				if (!workflowManager.getJournalDir() && ctx.cwd) {
					workflowManager.setJournalDir(`${ctx.cwd}/.pi-workflow/runs`);
				}
				const persisted = workflowManager.listRuns().find((r) => r.runId === params.runId);
				if (!persisted) {
					return {
						content: [{ type: "text", text: `No workflow run found with runId "${params.runId}". It may have completed and been pruned, or the ID is incorrect.` }],
						details: { found: false },
					};
				}
				const lines = [
					`Workflow "${persisted.workflowName}" (${params.runId}) \u2014 status: ${persisted.status}`,
					`Total tokens: ${persisted.totalTokens}, duration: ${persisted.durationMs}ms`,
					"",
					"Agents:",
					...persisted.agents.map((a) => `  #${a.id} [${a.status}] ${a.label}${a.error ? ` \u2014 ERROR: ${a.error}` : ""}`),
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: { found: true, persisted: true, run: persisted } };
			}

			const snapshot = run.snapshot;

			if (params.agentId !== undefined) {
				const agent = snapshot.agents.find((a) => a.id === params.agentId);
				if (!agent) {
					return {
						content: [{ type: "text", text: `No agent with id ${params.agentId} found in run "${params.runId}". Known agent IDs: ${snapshot.agents.map((a) => a.id).join(", ") || "(none)"}` }],
						details: { found: false },
					};
				}
				const limit = params.historyLimit ?? 100;
				const history = (agent.history ?? []).slice(0, limit);
				const truncatedNote = (agent.history?.length ?? 0) > limit ? `\n\n... (${(agent.history?.length ?? 0) - limit} more history entries not shown; increase historyLimit to see more)` : "";
				const resultText = agent.result !== undefined && agent.result !== null
					? (typeof agent.result === "string" ? agent.result : JSON.stringify(agent.result, null, 2))
					: (agent.resultPreview || "(no result yet)");
				const lines = [
					`Agent #${agent.id} "${agent.label}" (phase: ${agent.phase ?? "(none)"}) \u2014 status: ${agent.status}`,
					agent.model ? `Model: ${agent.model}` : undefined,
					agent.sessionId ? `Session file: ${agent.sessionId}` : undefined,
					agent.error ? `Error: ${agent.error}` : undefined,
					"",
					"Prompt:",
					agent.prompt || "(none)",
					"",
					"Result:",
					resultText,
					"",
					`History (${history.length}${(agent.history?.length ?? 0) > history.length ? ` of ${agent.history?.length}` : ""} entries):`,
					...history.map((e) => "  " + summarizeHistoryEntry(e)),
				].filter((l): l is string => l !== undefined);
				return {
					content: [{ type: "text", text: lines.join("\n") + truncatedNote }],
					details: { found: true, agent },
				};
			}

			const lines = [
				`Workflow "${snapshot.meta.name}" (${params.runId}) \u2014 status: ${snapshot.status}`,
				snapshot.error ? `Run error: ${snapshot.error}` : undefined,
				`Total agents: ${snapshot.totalAgents}, tokens: ${snapshot.totalTokens}`,
				"",
				"Agents:",
				...snapshot.agents.map((a) => {
					const errSuffix = a.error ? ` \u2014 ERROR: ${a.error}` : "";
					const resultSuffix = !a.error && a.resultPreview ? ` \u2014 ${a.resultPreview}` : "";
					return `  #${a.id} [${a.status}] ${a.label} (phase: ${a.phase ?? "(none)"})${errSuffix}${resultSuffix}`;
				}),
				"",
				"Pass agentId to this tool to get one agent's full prompt, result, and tool-call/output history.",
			].filter((l): l is string => l !== undefined);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { found: true, run: snapshot },
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	const globalWorkflowManager = new WorkflowManager();

	// --- Subagent Tool ---
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array).",
			`Discovers agents from both ${path.join(getAgentDir(), "agents")} (user) and ${CONFIG_DIR_NAME}/agents (project).`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const forkContext: ForkContextOptions | undefined = ctx.model
				? { sessionManager: ctx.sessionManager, modelRegistry: ctx.modelRegistry, fallbackModel: ctx.model }
				: undefined;
			// This process's own ceiling, so a delegating agent's maxSubagentDepth
			// frontmatter can only ever tighten it for its own children, never
			// loosen it past what this process was itself launched with.
			const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth();

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode (single: agent+task, or parallel: tasks array).\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Confirm project agents if needed
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`This will run agents from project directory: ${dir}\nAgents: ${names}\n\nAllow?`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Project-local agent execution cancelled." }],
							details: makeDetails("single")([]),
						};
					}
				}
			}

			// Parallel mode
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many tasks. Maximum: ${MAX_PARALLEL_TASKS}, got: ${params.tasks.length}` },
						],
						details: makeDetails("parallel")([]),
					};
				}

				const runId = `subagent-parallel-${Date.now()}`;
				const chDir = path.join(ctx.cwd, ".pi-workflow", "channels", runId);
				ensureChannel(chDir);

				const poller = new ChannelPoller(chDir, {
					onRequest: (request) => {
						// Defensive: a state request should never arrive here (node_state's
						// client-side check refuses when PI_WORKFLOW_NODE_ID is absent),
						// but handle it cleanly rather than letting it reach the broker.
						if (request.kind === "state") {
							poller.reply(request.id, {
								source: "state",
								stateOk: false,
								stateError: "node_state is not available outside a workflow graph run.",
							});
							return;
						}
						// A supervisor request that expects a reply cannot be answered
						// while this tool call is still blocking the main agent's turn —
						// the reply would queue behind this very call. Emit the detach
						// signal so runSingleAgent returns early (the child process keeps
						// running and polling; only the parent's await unblocks).
						if (request.kind === "supervisor" && request.expectsReply) {
							intercomDetachEmitter.emit(INTERCOM_DETACH_REQUEST_EVENT, {
								requestId: request.id,
								runId: request.runId,
								agent: request.agent,
								childIndex: request.nodeId ? parseInt(request.nodeId, 10) : 0,
								question: request.questions?.[0]?.question ?? request.question ?? "",
							});
						}

						void globalBroker.ask({
							id: request.id,
							runId: request.runId,
							nodeId: request.nodeId,
							agent: request.agent,
							kind: request.kind,
							questions: request.questions ?? [
								{
									question: request.question,
									header: request.agent ?? "Subagent",
									options: request.options,
								},
							],
							default: request.default,
							expectsReply: request.expectsReply,
						}).then((result) => {
							poller.reply(request.id, {
								source: result.source,
								answer: result.text,
								reason: result.reason,
								answers: result.answers?.questions,
							});
						});
					},
				});
				poller.start();

				globalWorkflowManager.registerRun(runId, {
					name: "subagent (parallel)",
					description: `${params.tasks.length} tasks`,
					phases: [{ title: "execution" }],
				});

				const liveResults: Array<{ agent: string; task: string; status: "running" | "done" | "error"; line?: string }> =
					params.tasks.map((t) => ({ agent: t.agent, task: t.task, status: "running" }));
				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					const running = liveResults.filter((r) => r.status === "running").length;
					const done = liveResults.length - running;
					const lines = liveResults.map((r) => {
						const icon = r.status === "running" ? "⏳" : r.status === "error" ? "✗" : "✓";
						return `${icon} ${r.agent}${r.status === "running" && r.line ? `: ${r.line}` : ""}`;
					});
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${liveResults.length} done\n${lines.join("\n")}` }],
						details: makeDetails("parallel")([]),
					});
				};

				let results: SingleResult[];
				try {
					results = await mapWithConcurrencyLimit(
						params.tasks,
						MAX_CONCURRENCY,
						async (t, _index) => {
							const agent = agents.find((a) => a.name === t.agent);
							if (!agent) {
								return {
									agent: t.agent,
									task: t.task,
									exitCode: 1,
									messages: [],
									usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
									error: `Unknown agent: ${t.agent}`,
								} as SingleResult;
							}

							const taskId = _index + 1;
							const sessionDir = path.join(ctx.cwd, ".pi-workflow", "sessions", runId);
							fs.mkdirSync(sessionDir, { recursive: true });
							const sessionFile = path.join(sessionDir, `task-${taskId}.jsonl`);

							const agentSnap = {
								id: taskId,
								label: `${t.agent} (task ${taskId})`,
								status: "running" as const,
								prompt: t.task,
							};
							globalWorkflowManager.markAgentStart(runId, 0, agentSnap);
							globalWorkflowManager.watchSession(runId, taskId, sessionFile);

							const taskStartTime = Date.now();
							liveResults[_index] = { agent: t.agent, task: t.task, status: "running" };
							emitParallelUpdate();
							const r = await runSingleAgent(
								ctx.cwd,
								agent,
								t.task,
								{
									runId: `${runId}-${taskId}`,
									index: taskId,
									cwd: t.cwd,
									signal,
									parentSessionId: ctx.sessionManager.getSessionId(),
									context: t.context,
									forkContext,
									sessionFile,
									extraEnv: {
										[PI_WORKFLOW_CHANNEL_DIR_ENV]: chDir,
										// Each task's own runId (not the shared batch runId) so the
										// detach match in execution.ts (payload.runId === options.runId)
										// lines up: this child's requests report `${runId}-${taskId}`.
										[PI_WORKFLOW_RUN_ID_ENV]: `${runId}-${taskId}`,
									},
									maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agent.maxSubagentDepth),
									allowIntercomDetach: true,
									intercomEvents: intercomDetachEmitter,
									onProgress: (progress) => {
										liveResults[_index] = { agent: t.agent, task: t.task, status: "running", line: formatProgressLine(progress) };
										emitParallelUpdate();
									},
								},
							);
							liveResults[_index] = {
								agent: t.agent,
								task: t.task,
								status: isFailedResult(r) ? "error" : "done",
							};
							emitParallelUpdate();

							const isErr = isFailedResult(r);
							globalWorkflowManager.markAgentEnd(
								runId,
								taskId,
								isErr ? "error" : "done",
								isErr ? undefined : getResultOutput(r),
								r.error,
								(r.usage?.input ?? 0) + (r.usage?.output ?? 0),
								Date.now() - taskStartTime
							);

							return r;
						},
					);
				} finally {
					poller.stop();
					cleanupChannel(chDir);
				}

				const firstError = results.find((r) => isFailedResult(r))?.error;
				globalWorkflowManager.completeRun(runId, undefined, firstError);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = getResultOutput(r);
					const status = isFailedResult(r)
						? `✗ failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "✓ completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// Single mode
			if (params.agent && params.task) {
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available agents: ${available}` }],
						details: makeDetails("single")([]),
					};
				}

				const runId = `subagent-${Date.now()}`;
				const chDir = path.join(ctx.cwd, ".pi-workflow", "channels", runId);
				ensureChannel(chDir);

				const poller = new ChannelPoller(chDir, {
					onRequest: (request) => {
						// Defensive: a state request should never arrive here (node_state's
						// client-side check refuses when PI_WORKFLOW_NODE_ID is absent),
						// but handle it cleanly rather than letting it reach the broker.
						if (request.kind === "state") {
							poller.reply(request.id, {
								source: "state",
								stateOk: false,
								stateError: "node_state is not available outside a workflow graph run.",
							});
							return;
						}
						// A supervisor request that expects a reply cannot be answered
						// while this tool call is still blocking the main agent's turn —
						// the reply would queue behind this very call. Emit the detach
						// signal so runSingleAgent returns early (the child process keeps
						// running and polling; only the parent's await unblocks).
						if (request.kind === "supervisor" && request.expectsReply) {
							intercomDetachEmitter.emit(INTERCOM_DETACH_REQUEST_EVENT, {
								requestId: request.id,
								runId: request.runId,
								agent: request.agent,
								childIndex: request.nodeId ? parseInt(request.nodeId, 10) : 0,
								question: request.questions?.[0]?.question ?? request.question ?? "",
							});
						}

						void globalBroker.ask({
							id: request.id,
							runId: request.runId,
							nodeId: request.nodeId,
							agent: request.agent,
							kind: request.kind,
							questions: request.questions ?? [
								{
									question: request.question,
									header: request.agent ?? "Subagent",
									options: request.options,
								},
							],
							default: request.default,
							expectsReply: request.expectsReply,
						}).then((result) => {
							poller.reply(request.id, {
								source: result.source,
								answer: result.text,
								reason: result.reason,
								answers: result.answers?.questions,
							});
						});
					},
				});
				poller.start();

				globalWorkflowManager.registerRun(runId, {
					name: `subagent: ${agent.name}`,
					description: params.task,
					phases: [{ title: "execution" }],
				});

				const sessionDir = path.join(ctx.cwd, ".pi-workflow", "sessions", runId);
				fs.mkdirSync(sessionDir, { recursive: true });
				const sessionFile = path.join(sessionDir, `${agent.name}.jsonl`);

				const agentSnap = {
					id: 1,
					label: `${agent.name} (delegate)`,
					status: "running" as const,
					prompt: params.task,
				};
				globalWorkflowManager.markAgentStart(runId, 0, agentSnap);
				globalWorkflowManager.watchSession(runId, 1, sessionFile);

				const taskStartTime = Date.now();
				let result: SingleResult | undefined;
				try {
					result = await runSingleAgent(
						ctx.cwd,
						agent,
						params.task,
						{
							runId,
							cwd: params.cwd,
							signal,
							parentSessionId: ctx.sessionManager.getSessionId(),
							context: params.context,
							forkContext,
							sessionFile,
							extraEnv: {
								[PI_WORKFLOW_CHANNEL_DIR_ENV]: chDir,
								[PI_WORKFLOW_RUN_ID_ENV]: runId,
							},
							maxSubagentDepth: resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agent.maxSubagentDepth),
							allowIntercomDetach: true,
							intercomEvents: intercomDetachEmitter,
							onDetachedExit: (finalResult) => {
								// Background completion: the child finally exited after
								// we returned a detached receipt. Clean up and report.
								poller.stop();
								cleanupChannel(chDir);

								const isErr = isFailedResult(finalResult);
								globalWorkflowManager.markAgentEnd(
									runId,
									1,
									isErr ? "error" : "done",
									isErr ? undefined : getResultOutput(finalResult),
									finalResult.error,
									(finalResult.usage?.input ?? 0) + (finalResult.usage?.output ?? 0),
									Date.now() - taskStartTime
								);
								globalWorkflowManager.completeRun(
									runId,
									isErr ? undefined : getResultOutput(finalResult),
									finalResult.error,
								);
								// Stage a report so the result-delivery listener can
								// inject the child's final output back into the main
								// agent's conversation as a follow-up message.
								stageRunReport(globalWorkflowManager, {
									runId,
									name: `subagent: ${agent.name}`,
									text: `Agent "${agent.name}" completed.\n\nResult: ${getResultOutput(finalResult)}`,
								});
							},
							onProgress: onUpdate
								? (progress) => {
										onUpdate({
											content: [{ type: "text", text: `${agent.name}: ${formatProgressLine(progress)}` }],
											details: makeDetails("single")([]),
										});
									}
								: undefined,
						},
					);
				} finally {
					// Only clean up if the child was NOT detached. When detached,
					// the child is still alive and needs the channel; cleanup
					// happens in onDetachedExit instead.
					if (!result?.detached) {
						poller.stop();
						cleanupChannel(chDir);
					}
				}

				// Detached: the child is still running. Return a receipt that
				// includes the actual question text so the main agent can answer
				// immediately via workflow_reply — the separate
				// workflow-agent-question message from the broker may not arrive
				// before the model sees this tool result, which caused hesitation
				// ("reply or not?").
				if (result.detached && result.supervisorQuestion) {
					// Mark the broker entry as already delivered so handleSupervisorBatch
					// does not fire a duplicate sendMessage for the same question.
					if (result.supervisorRequestId) {
						globalBroker.markInlineDelivered(result.supervisorRequestId);
					}
					return {
						content: [{
							type: "text",
							text: `[workflow-agent-question · agent: "${agent.name}" · requestId: "${result.supervisorRequestId}" · run: ${runId}]
\n## Action Required\n\nYou MUST call \`workflow_reply\` with the requestId and your answer. Do NOT reply in plain text — the subagent is blocked and will time out after 10 minutes.\n\n## How to reply\n\n\`\`\`\nworkflow_reply({\n  requestId: "${result.supervisorRequestId}",\n  answer: "<your answer here>"\n})\n\`\`\`\n\n## Question\n\n${result.supervisorQuestion}`,
						}],
						details: makeDetails("single")([result]),
					};
				}
				if (result.detached) {
					return {
						content: [{ type: "text", text: `Agent "${agent.name}" detached for supervisor coordination. Reply with workflow_reply when ready.` }],
						details: makeDetails("single")([result]),
					};
				}

				const isError = isFailedResult(result);
				globalWorkflowManager.markAgentEnd(
					runId,
					1,
					isError ? "error" : "done",
					isError ? undefined : getResultOutput(result),
					result.error,
					(result.usage?.input ?? 0) + (result.usage?.output ?? 0),
					Date.now() - taskStartTime
				);
				globalWorkflowManager.completeRun(runId, isError ? undefined : getResultOutput(result), result.error);

				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},
	});

	// --- Workflow Tool ---
	// Graph-based coordination: nodes are agents, edges decide where each
	// result goes next. Replaces the imperative agent()/parallel() script.
	//
	// The broker carries judgement requests between processes. ask_user_question,
	// ask_supervisor, and (after re-routing) the human() node all pass through
	// here. The sinks route each request to whoever can answer it: the user's
	// TUI for human questions, the main agent's conversation for supervisor ones.
	const globalBroker = new RequestBroker();
	installBrokerSinks({ pi, broker: globalBroker });
	globalBroker.start();

	// Captured at session_start; used by tools/commands that need the working dir.
	let sessionCwd: string | undefined;

	// Event emitter for cross-component intercom detach signals.
	// When a child calls ask_supervisor (expectsReply: true), the ChannelPoller
	// emits INTERCOM_DETACH_REQUEST_EVENT here; execution.ts listens and returns
	// a detached receipt early, unblocking the parent while the child keeps running.
	const intercomDetachEmitter = new EventEmitter();

	// The manager is passed in so runs appear in /workflows, the task panel,
	// and workflow_status. Without it the tool still runs, but every one of
	// those surfaces reports an empty run list.
	const workflowTool = createGraphWorkflowTool({ workflowManager: globalWorkflowManager, broker: globalBroker });
	pi.registerTool(workflowTool);
	registerWorkflowStatusTool(pi, globalWorkflowManager);

	// Runs are background-only, so a graph's report is not a tool result. It is
	// injected into the conversation when the walk finishes; without this, a
	// finished run would be visible only in /workflows and the model would never
	// learn what it produced.
	installResultDelivery(pi, globalWorkflowManager);

	// --- Agent Catalog ---
	pi.registerTool(createListAgentsTool());

	// --- Workflow Catalog ---
	pi.registerTool(createListWorkflowsTool());

	// --- Ask Tools (User & Supervisor communication) ---
	pi.registerTool(createAskUserQuestionTool());
	pi.registerTool(createAskSupervisorTool());
	pi.registerTool(createNodeStateTool());

	// --- Plan Tool ---
	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Create, read, edit, list, or delete plans stored as Markdown files in " +
			".pi-workflow/plans/. Available in all modes including plan mode. " +
			"Actions: create | get | edit | list | delete. " +
			"Use `list` first to discover existing plan ids.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["create", "get", "edit", "list", "delete"],
					description:
						"create: write a new plan. get: read plan content. " +
						"edit: precision find-and-replace (oldText must be unique in the file). " +
						"list: enumerate all plans. delete: remove a plan.",
				},
				name: { type: "string", description: "Human-readable plan title (required for create). Used to derive the plan id slug." },
				id: { type: "string", description: "Plan id slug (returned by create/list). Required for get, edit, delete." },
				content: { type: "string", description: "Full Markdown content (required for create)." },
				oldText: { type: "string", description: "Exact text to replace (required for edit). Must match exactly once in the plan." },
				newText: { type: "string", description: "Replacement text (required for edit)." },
			},
			required: ["action"],
		},
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const reply = (text: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } =>
				({ content: [{ type: "text" as const, text }], details: {} });

			const cwd = sessionCwd;
			if (!cwd) return reply("Error: no working directory available.");

			const action = String(params.action ?? "");
			const name = String(params.name ?? "");
			const id = String(params.id ?? "");
			const content = String(params.content ?? "");
			const oldText = String(params.oldText ?? "");
			const newText = String(params.newText ?? "");

			let result;
			switch (action) {
				case "create": result = planCreate(cwd, name, content); break;
				case "get":    result = planGet(cwd, id); break;
				case "list":   result = planList(cwd); break;
				case "edit":   result = planEdit(cwd, id, oldText, newText); break;
				case "delete": result = planDelete(cwd, id); break;
				default:       result = { ok: false as const, error: `Unknown action "${action}". Use: create | get | edit | list | delete.` };
			}

			if (!result.ok) return reply(`Error: ${result.error}`);

			const parts: string[] = [result.message];
			if (result.id) parts.push(`id: ${result.id}`);
			if (result.content !== undefined) parts.push("", result.content);
			if (result.plans !== undefined) {
				if (result.plans.length === 0) {
					parts.push('No plans yet. Use action: "create" to create the first one.');
				} else {
					parts.push("");
					for (const p of result.plans) {
						parts.push(`• ${p.id}  —  ${p.name}`);
						parts.push(`  updated: ${p.updatedAt}  size: ${p.sizeBytes}B`);
					}
				}
			}

			return reply(parts.join("\n"));
		},
	});

	// --- Contract Tool ---
	pi.registerTool({
		name: "contract",
		label: "Contract",
		description:
			"Create, read, edit, list, propose, or supersede contracts stored as Markdown files in " +
			".pi-workflow/contracts/. Contracts formally document agreements between agents (API, " +
			"interface, task, data). Lifecycle: draft → proposed → superseded. Only draft contracts " +
			"can be edited. Use supersede to create a new version of an existing contract. " +
			"Actions: create | get | list | edit | propose | supersede.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["create", "get", "list", "edit", "propose", "supersede"],
					description:
						"create: write a new draft contract. get: read full content. " +
						"list: enumerate all contracts with type/status. " +
						"edit: precision find-and-replace (draft only). " +
						"propose: mark a draft as proposed (ready for review). " +
						"supersede: create a new version, mark old as superseded.",
				},
				name: { type: "string", description: "Contract title (required for create, supersede). Used to derive the id slug." },
				id: { type: "string", description: "Contract id slug (required for get, edit, propose, supersede)." },
				type: {
					type: "string",
					enum: ["api", "interface", "task", "data", "other"],
					description: "Contract type (required for create): api | interface | task | data | other.",
				},
				producer: { type: "string", description: "Agent or party that produces/delivers (required for create)." },
				consumer: { type: "string", description: "Agent or party that consumes/depends on this contract (required for create)." },
				content: { type: "string", description: "Full Markdown body (required for create, supersede)." },
				oldText: { type: "string", description: "Exact text to replace (required for edit). Must match exactly once." },
				newText: { type: "string", description: "Replacement text (required for edit)." },
			},
			required: ["action"],
		},
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const reply = (text: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } =>
				({ content: [{ type: "text" as const, text }], details: {} });

			const cwd = sessionCwd;
			if (!cwd) return reply("Error: no working directory available.");

			const action  = String(params.action  ?? "");
			const name    = String(params.name    ?? "");
			const id      = String(params.id      ?? "");
			const type    = String(params.type    ?? "other") as import("./contract-tool.ts").ContractType;
			const producer = String(params.producer ?? "");
			const consumer = String(params.consumer ?? "");
			const content = String(params.content ?? "");
			const oldText = String(params.oldText ?? "");
			const newText = String(params.newText ?? "");

			let result;
			switch (action) {
				case "create":    result = contractCreate(cwd, { name, type, producer, consumer, content }); break;
				case "get":       result = contractGet(cwd, id); break;
				case "list":      result = contractList(cwd); break;
				case "edit":      result = contractEdit(cwd, id, oldText, newText); break;
				case "propose":   result = contractPropose(cwd, id); break;
				case "supersede": result = contractSupersede(cwd, id, { name, content }); break;
				default:          result = { ok: false as const, error: `Unknown action "${action}". Use: create | get | list | edit | propose | supersede.` };
			}

			if (!result.ok) return reply(`Error: ${result.error}`);

			const parts: string[] = [result.message];
			if (result.id) parts.push(`id: ${result.id}`);
			if (result.content !== undefined) parts.push("", result.content);
			if (result.contracts !== undefined) {
				if (result.contracts.length === 0) {
					parts.push('No contracts yet. Use action: "create" to create the first one.');
				} else {
					parts.push("");
					for (const c of result.contracts) {
						parts.push(`• [${c.type}] [${c.status}] ${c.id}  —  ${c.title}`);
						parts.push(`  producer: ${c.producer}  consumer: ${c.consumer}  v${c.version}  updated: ${c.updated.slice(0, 10)}`);
					}
				}
			}

			return reply(parts.join("\n"));
		},
	});

	// --- Subagent Wait Tool ---
	// Lets the main agent optionally wait for a detached subagent to finish,
	// or check status of background runs.
	pi.registerTool(defineTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		promptSnippet: "Wait for or check status of detached background subagents",
		description: [
			"Wait for a detached subagent to finish, or check status of background runs.",
			"After a subagent detaches for ask_supervisor, the child keeps running in the background.",
			"Use this tool to optionally block and wait for it to complete, or get its current status.",
			"",
			"- { id: \"runId\" } — wait for the specific subagent run to finish (returns its result)",
			"- { timeoutMs: 300000 } — stop waiting after N ms (default: 600000, max: 3600000)",
			"- { status: true } or no params — check status of all subagent runs without waiting",
		].join("\n"),
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "The runId of a detached subagent to wait for (from the subagent tool result)" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Maximum time to wait in ms (default: 600000, max: 3600000)" })),
			status: Type.Optional(Type.Boolean({ description: "If true, just check status without waiting" })),
		}),
		async execute(_id, params, _signal, onUpdate) {
			const runId: string | undefined = params.id;
			const maxTimeout = 3600000;
			const timeoutMs = Math.min(params.timeoutMs ?? 600000, maxTimeout);
			const checkStatus = params.status === true;

			if (checkStatus || !runId) {
				// Status check mode
				const runs = globalWorkflowManager.listRuns();
				if (runs.length === 0) {
					return {
						content: [{ type: "text", text: "No subagent runs found." }],
						details: { runs: [] },
					};
				}
				const lines = runs.map((r) => {
					const agents = r.agents?.map((a) => {
						const statusIcon = a.status === "running" ? "⏳" : a.status === "done" ? "✓" : a.status === "error" ? "✗" : "·";
						return `${statusIcon} ${a.label || a.id}`;
					}).join(", ") || "(no agents)";
					return `- ${r.runId}: [${r.status}] ${r.workflowName || ""}\n  agents: ${agents}`;
				});
				return {
					content: [{ type: "text", text: `Background subagent runs:\n\n${lines.join("\n")}` }],
					details: { runs: runs.map((r) => ({ runId: r.runId, status: r.status, name: r.workflowName })) },
				};
			}

			// Wait mode: wait for the specific run to complete
			const run = globalWorkflowManager.getRun(runId);
			if (!run) {
				return {
					content: [{ type: "text", text: `No subagent run found with id "${runId}". Use subagent_wait({ status: true }) to list active runs.` }],
					details: { error: "run_not_found" },
					isError: true,
				};
			}

			if (run.status === "completed" || run.status === "error") {
				return {
					content: [{ type: "text", text: `Subagent run ${runId} has already completed with status: ${run.status}.` }],
					details: { runId, status: run.status, result: run.snapshot.result },
				};
			}

			// Wait for the run to complete
			return new Promise((resolve) => {
				const startTime = Date.now();
				const timeout = setTimeout(() => {
					globalWorkflowManager.removeListener("complete", onComplete);
					globalWorkflowManager.removeListener("error", onError);
					onUpdate?.({ content: [{ type: "text", text: `Still waiting... (${Math.round((Date.now() - startTime) / 1000)}s)` }], details: undefined });
					resolve({
						content: [{ type: "text", text: `Subagent run ${runId} timed out after ${timeoutMs}ms. It may still be running in the background. Use subagent_wait({ status: true }) to check.` }],
						details: { runId, timedOut: true, status: "running" },
					});
				}, timeoutMs);

				const onComplete = (data: { runId: string }) => {
					if (data.runId !== runId) return;
					clearTimeout(timeout);
					const updated = globalWorkflowManager.getRun(runId);
					const output = updated?.snapshot.result || "completed";
					resolve({
						content: [{ type: "text", text: `Subagent run ${runId} completed.\n\nOutput: ${typeof output === "string" ? output : JSON.stringify(output)}` }],
						details: { runId, status: "completed", result: updated?.snapshot.result },
					});
				};

				const onError = (data: { runId: string; error?: string }) => {
					if (data.runId !== runId) return;
					clearTimeout(timeout);
					resolve({
						content: [{ type: "text", text: `Subagent run ${runId} failed: ${data.error || "unknown error"}` }],
						details: { runId, status: "error", error: data.error },
					} as AgentToolResult<unknown>);
				};

				globalWorkflowManager.on("complete", onComplete);
				globalWorkflowManager.on("error", onError);
			});
		},
	}));

	/**
	 * Injects the live agent roster into the delegation tools' guidelines.
	 *
	 * Discovery has always worked, but nothing told the model which agents
	 * exist: /agents renders to the human's screen, and the tool guidelines
	 * never enumerated the roster. Since resolveAgent() silently falls back to
	 * a generic agent for an unknown name, a guessed name produced a plausible
	 * wrong run rather than an error.
	 *
	 * Re-registering a tool refreshes it in place, so this runs at session_start
	 * once the cwd is known, and again whenever the roster may have changed.
	 */
	const refreshAgentCatalogGuidelines = (cwd: string): void => {
		let guideline: string;
		try {
			guideline = buildAgentCatalogGuideline(discoverAgents(cwd, "both").agents);
		} catch {
			// Never let a malformed agent file take down tool registration.
			return;
		}

		pi.registerTool({
			...workflowTool,
			promptGuidelines: [...(workflowTool.promptGuidelines ?? []), guideline],
		});
	};

	// --- Commands ---
	pi.registerCommand("workflows", {
		description: "Open the interactive /workflows navigator overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /workflows navigator requires an interactive TUI session.", "warning");
				return;
			}
			// Same cross-process gap as workflow_status: without a workflow
			// having run in this process yet, journalDir is unset and the
			// navigator would show "no runs" despite completed runs sitting
			// on disk from earlier sessions.
			if (!globalWorkflowManager.getJournalDir() && ctx.cwd) {
				globalWorkflowManager.setJournalDir(`${ctx.cwd}/.pi-workflow/runs`);
			}
			await openWorkflowNavigator(pi, globalWorkflowManager, ctx.ui);
		},
	});

	pi.registerCommand("plans", {
		description: "Open the interactive /plans navigator — browse and read plans in .pi-workflow/plans/",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /plans navigator requires an interactive TUI session.", "warning");
				return;
			}
			const cwd = ctx.cwd ?? sessionCwd;
			if (!cwd) {
				ctx.ui.notify("No working directory available.", "warning");
				return;
			}
			await openPlansNavigator(pi, cwd, ctx.ui);
		},
	});

	pi.registerCommand("contracts", {
		description: "Open the interactive /contracts navigator — browse contracts in .pi-workflow/contracts/",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /contracts navigator requires an interactive TUI session.", "warning");
				return;
			}
			const cwd = ctx.cwd ?? sessionCwd;
			if (!cwd) {
				ctx.ui.notify("No working directory available.", "warning");
				return;
			}
			await openContractsNavigator(pi, cwd, ctx.ui);
		},
	});

	pi.registerCommand("saved-workflows", {
		description: "List saved workflows (or `/saved-workflows delete <name>` to remove one)",
		handler: async (args, ctx) => {
			const runCwd = ctx.cwd;
			const trimmed = (args || "").trim();
			if (trimmed.startsWith("delete ")) {
				const name = trimmed.slice("delete ".length).trim();
				if (!name) {
					ctx.ui.notify("Usage: /saved-workflows delete <name>", "warning");
					return;
				}
				const removed = deleteSavedWorkflow(runCwd, name);
				ctx.ui.notify(removed ? `Deleted saved workflow "${name}".` : `No saved workflow named "${name}" found.`, removed ? "info" : "warning");
				return;
			}

			const saved = listSavedWorkflows(runCwd);
			if (saved.length === 0) {
				ctx.ui.notify(
					'No saved workflows yet. Run the workflow tool with saveWorkflow: true to persist a script to .pi-workflow/workflows/ for reuse via loadWorkflow.',
					"info",
				);
				return;
			}

			const lines = ["Saved workflows (.pi-workflow/workflows/):", ""];
			for (const wf of saved) {
				const savedAgo = new Date(wf.savedAt).toISOString();
				lines.push(`• ${wf.name}`);
				lines.push(`  ${wf.description}`);
				if (wf.whenToUse) lines.push(`  When to use: ${wf.whenToUse}`);
				lines.push(`  Saved: ${savedAgo} · ${wf.sizeBytes}B · loadWorkflow: "${wf.name}"`);
				lines.push("");
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Create agent files in ~/.pi/agent/agents/*.md or .pi/agents/*.md", "info");
				return;
			}

			const lines = ["Available subagents:", ""];
			for (const agent of agents) {
				const parts = [`• ${agent.name}`];
				if (agent.package) parts.push(`(pkg: ${agent.package})`);
				if (agent.model) parts.push(`[model: ${agent.model}]`);
				if (agent.tools) parts.push(`[tools: ${agent.tools.join(", ")}]`);
				if (agent.thinking) parts.push(`[thinking: ${agent.thinking}]`);
				if (agent.extensions !== undefined) {
					parts.push(`[extensions: ${agent.extensions.length || "none"}]`);
				}
				if (agent.subagentOnlyExtensions) {
					parts.push(`[subagent-exts: ${agent.subagentOnlyExtensions.join(", ")}]`);
				}
				if (agent.skills) parts.push(`[skills: ${agent.skills.join(", ")}]`);
				if (agent.async) parts.push(`[async]`);
				if (agent.memory) parts.push(`[memory: ${agent.memory.scope}/${agent.memory.path}]`);
				const source = agent.source === "project" ? " (project)" : "";
				lines.push(parts.join(" ") + source);
				lines.push(`  ${agent.description}`);
				lines.push("");
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// --- Workflow-only mode: /workflow on|off ---
	registerWorkflowMode(pi, { workflowToolName: workflowTool.name, subagentToolName: "subagent" });

	// --- Session start: activate workflow tool & task panel ---
	pi.on("session_start", (_event, ctx) => {
		setBrokerContext(ctx);
		if (ctx?.cwd) sessionCwd = ctx.cwd;
		const active = pi.getActiveTools();
		// Activate workflow_reply so its promptGuidelines (which tell the model
		// it MUST call the tool when it sees a workflow-agent-question message)
		// are included in the system prompt. Without this, the guidelines are
		// invisible to the model even though the tool is registered/callable.
		const toActivate = [workflowTool.name];
		if (!active.includes("workflow_reply")) toActivate.push("workflow_reply");
		if (!active.includes("subagent")) toActivate.push("subagent");
		if (!active.includes("ask_user_question")) toActivate.push("ask_user_question");
		if (!active.includes("ask_supervisor")) toActivate.push("ask_supervisor");
		if (!active.includes("subagent_wait")) toActivate.push("subagent_wait");
		if (!active.includes("plan")) toActivate.push("plan");
		if (!active.includes("contract")) toActivate.push("contract");
		if (toActivate.some((t) => !active.includes(t))) {
			pi.setActiveTools([...new Set([...active, ...toActivate])]);
		}
		if (ctx?.cwd) {
			refreshAgentCatalogGuidelines(ctx.cwd);
			sweepOrphanedChannels(ctx.cwd);
		}
		if (ctx && ctx.ui) {
			registerTaskPanel(pi, globalWorkflowManager, ctx.ui);
		}
	});
}
