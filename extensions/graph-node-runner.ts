/**
 * Graph node runner — turns a graph node into real work.
 *
 * The executor owns routing and knows nothing about agents; this module
 * owns spawning and knows nothing about routing. They meet at the
 * NodeRunner signature.
 *
 * Agent results are parsed for the escalation protocol the bundled agents
 * are taught to emit (`STATUS: blocked` / `BLOCKED_ON: ...`). That parsing
 * is what turns a prompt-level convention into a routing key an edge can
 * branch on.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import { PI_WORKFLOW_NODE_ID_ENV } from "./channel.ts";
import { classifySingleResultFailure } from "./failure-classifier.ts";
import type { NodeStateBuffers } from "./node-state-reducer.ts";
import type { CommandNodeDef, GraphNode, GraphState } from "./graph-dsl.ts";
import type { NodeRunOutcome, NodeRunner } from "./graph-executor.ts";
import type { RequestBroker } from "./request-broker.ts";
import { plansDir } from "./plan-tool.ts";
import { contractsDir } from "./contract-tool.ts";
import {
	type ArtifactConfig,
	type ForkContextOptions,
	type SingleResult,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "./types.ts";
import { getFinalOutput } from "./utils.ts";

/**
 * Structured view of an agent's reply, after escalation parsing.
 *
 * Carries a toString() so that interpolating a result into a prompt
 * (`${state.architect}`) yields the agent's text rather than
 * "[object Object]". Edge conditions need the structured fields, prompts
 * almost always want the text, and a script author should not have to
 * remember which is which — getting it wrong would silently feed garbage
 * to the next agent.
 */
export interface AgentNodeResult {
	/**
	 * "ok" when the agent completed normally, "blocked" when it reported an
	 * escalation. Edge conditions branch on this.
	 */
	status: "ok" | "blocked";
	/**
	 * Escalation target when blocked. A closed vocabulary so it can be a
	 * routing key: "contract" goes back to whoever designed the interface,
	 * "tests" to whoever wrote them, "environment" to a human.
	 */
	blockedOn?: string;
	reason?: string;
	evidence?: string;
	proposedFix?: string;
	/** Full text of the agent's reply, always present. */
	text: string;
	agent: string;
	/** Set when the agent finished but something went wrong along the way. */
	error?: string;
	usage?: { tokens: number };
	/**
	 * Accumulated per-node state from `node_state` tool calls during this
	 * node's run. Folded in by the node runner at completion from the
	 * NodeStateBuffers drain — empty object when the agent never called
	 * node_state. Downstream nodes read it as `state.<nodeId>.data.<key>`.
	 */
	data?: Record<string, unknown>;
}

const STATUS_LINE = /^\s*STATUS:\s*(\w[\w-]*)\s*$/im;

/** Default wall-clock cap for a command node, mirrors acceptance verify commands. */
const COMMAND_NODE_DEFAULT_TIMEOUT_MS = 30_000;
/** Output cap per stream, mirrors child-transcript.ts's tool payload cap. */
const COMMAND_NODE_MAX_OUTPUT_BYTES = 32 * 1024;
const COMMAND_OUTPUT_TRUNCATION_MARKER = "\n\n… output truncated";

function truncateOutput(text: string, maxBytes = COMMAND_NODE_MAX_OUTPUT_BYTES): string {
	const payload = Buffer.from(text, "utf-8");
	if (payload.length <= maxBytes) return text;
	const markerBytes = Buffer.byteLength(COMMAND_OUTPUT_TRUNCATION_MARKER, "utf-8");
	let end = Math.max(0, maxBytes - markerBytes);
	// Never cut a multi-byte UTF-8 sequence in half.
	while (end > 0 && (payload[end]! & 0xc0) === 0x80) end--;
	return `${payload.subarray(0, end).toString("utf-8")}${COMMAND_OUTPUT_TRUNCATION_MARKER}`;
}

/** Escalation fields, narrowed to the string-valued keys so no cast is needed. */
type EscalationField = "blockedOn" | "reason" | "evidence" | "proposedFix";

const FIELD_PATTERNS: [EscalationField, RegExp][] = [
	["blockedOn", /^\s*BLOCKED_ON:\s*(.+)$/im],
	["reason", /^\s*REASON:\s*(.+)$/im],
	["evidence", /^\s*EVIDENCE:\s*(.+)$/im],
	["proposedFix", /^\s*PROPOSED_FIX:\s*(.+)$/im],
];

/** Escalation targets the bundled agents are taught to use. */
export const KNOWN_BLOCKED_ON = new Set([
	"contract",
	"tests",
	"environment",
	"requirements",
	"information",
	"conflict",
]);

/**
 * The escalation block injected into every workflow agent's system prompt.
 *
 * A custom agent authored without this block has no way to signal a blocker
 * the graph can route on, and gets forwarded as if it succeeded when it
 * hits a wall. Injecting here makes the protocol universal — bundled agents
 * already carry it (and are skipped by the dedup check), so this is the
 * safety net for user-authored agents that do not.
 *
 * The wording is kept identical to the `## Escalation` section documented in
 * SKILL.md and README.md, so a model that reads the docs and an agent that
 * receives the injection see the same instruction — no conflicting guidance.
 */
export const ESCALATION_PROTOCOL_BLOCK = `## Escalation

If you can't complete the task, say so instead of faking it:

STATUS: blocked
BLOCKED_ON: requirements | environment | conflict | contract | tests | information
REASON: <specifically what you hit>
EVIDENCE: <error output, file:line>
PROPOSED_FIX: <what would unblock you>

Reporting a blocker with a clear reason is a successful outcome. Faking completion is the only real failure.

## Tool Usage Restrictions vs Escalation
You have access to ask_user_question and ask_supervisor tools. However:
- DO NOT use ask_user_question or ask_supervisor to debug code errors, write implementations, or perform tasks. Those MUST be escalated by reporting STATUS: blocked.
- ask_user_question is strictly for choices requiring external human values/preferences (e.g. choosing between design trade-offs).
- ask_supervisor is strictly for high-level guidance or progress reports.
- Any technical failure, compilation error, or missing tool/file capability MUST be escalated via STATUS: blocked so the graph can route it.`;

/**
 * Returns an agent config with the escalation protocol in its system prompt.
 *
 * Idempotent: if the prompt already teaches the protocol (bundled agents,
 * or a custom agent whose author followed the docs), it is returned
 * unchanged. Otherwise the block is appended to a *clone* — the discovered
 * agent object is never mutated, so the injection cannot leak into other
 * call sites or persist across discovery passes.
 */
export function withEscalationProtocol(agent: AgentConfig): AgentConfig {
	if (agent.systemPrompt?.includes("STATUS: blocked")) return agent;
	const systemPrompt = agent.systemPrompt
		? `${agent.systemPrompt}\n\n${ESCALATION_PROTOCOL_BLOCK}`
		: ESCALATION_PROTOCOL_BLOCK;
	return { ...agent, systemPrompt };
}

/**
 * Extracts the escalation protocol from an agent's reply.
 *
 * Deliberately lenient about surrounding prose: agents wrap the block in
 * explanation, and rejecting that would push them back toward silently
 * giving up. Deliberately strict about the vocabulary: an unrecognised
 * BLOCKED_ON is preserved verbatim so an edge can still see it, rather than
 * being coerced into a category the agent did not choose.
 */
/**
 * Attaches the text-returning toString() to an agent result.
 *
 * Non-enumerable so it never lands in JSON.stringify output or the journal,
 * while still making `${state.architect}` interpolate to the agent's text.
 *
 * Exported because results also arrive from JSON.parse on resume, where the
 * prototype is lost. Without re-attaching, a resumed run silently renders
 * "[object Object]" into every prompt built from an earlier node.
 */
export function withResultText<T extends { text?: unknown }>(result: T): T {
	Object.defineProperty(result, "toString", {
		value: function toString(this: { text?: unknown }) {
			return typeof this.text === "string" ? this.text : "";
		},
		enumerable: false,
		writable: true,
		configurable: true,
	});
	return result;
}

/**
 * Re-attaches result behaviour to a state object rebuilt from JSON.
 *
 * Journal replay produces plain objects, so anything that looked like an
 * agent result needs its toString() back before prompts are built from it.
 */
export function rehydrateState(state: Record<string, unknown>): Record<string, unknown> {
	for (const value of Object.values(state)) {
		if (value && typeof value === "object" && !Array.isArray(value) && "text" in value) {
			withResultText(value as { text?: unknown });
		}
	}
	return state;
}

/**
 * Strips reasoning-trace markers some models prepend to every reply (e.g.
 * `<think></think>` before the actual content, or `<think>...</think>` with
 * a real trace inside). Escalation parsing is line-anchored (`^STATUS:`), so
 * a leading marker on the same line as STATUS silently defeats it — the
 * agent's escalation gets treated as an ordinary completion and the graph
 * routes to END instead of back to whoever owns the problem. Stripping here,
 * once, at the one place that decides routing, is cheaper than teaching
 * every regex about `<think>`.
 */
function stripThinkingMarkers(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
}

export function parseAgentResult(text: string, agentName: string): AgentNodeResult {
	const result: AgentNodeResult = withResultText({ status: "ok", text, agent: agentName });
	const searchText = stripThinkingMarkers(text);

	const statusMatch = STATUS_LINE.exec(searchText);
	if (statusMatch && statusMatch[1].toLowerCase() === "blocked") {
		result.status = "blocked";
	}

	// Only populate escalation fields when the agent actually escalated, so a
	// passing mention of "REASON:" in ordinary prose cannot fake a blocker.
	if (result.status === "blocked") {
		for (const [field, pattern] of FIELD_PATTERNS) {
			const match = pattern.exec(searchText);
			if (match) {
				const value = match[1].trim();
				if (value) result[field] = value;
			}
		}
		if (result.blockedOn) result.blockedOn = result.blockedOn.toLowerCase();
	}

	return result;
}

export interface ResolveAgentResult {
	agent?: AgentConfig;
	error?: string;
}

/**
 * Resolves an agent by name.
 *
 * Unlike the imperative workflow's resolver, an unknown name is an error
 * rather than a silent fallback to a generic agent. A graph that names a
 * nonexistent agent has a bug in it, and running something else instead
 * produces a plausible-looking result from the wrong role — the most
 * expensive kind of failure to notice.
 */
export function resolveGraphAgent(
	agentName: string,
	cwd: string,
	options: { agentScope?: "user" | "project" | "both" } = {},
): ResolveAgentResult {
	const { agents } = discoverAgents(cwd, options.agentScope ?? "both");
	const found = agents.find((a) => a.name === agentName);

	if (found) return { agent: found };

	const available = agents.map((a) => a.name).sort().join(", ") || "(none)";
	return {
		error: `Unknown agent "${agentName}". Available agents: ${available}.`,
	};
}

export interface AgentSpawnOptions {
	cwd: string;
	runId: string;
	signal?: AbortSignal;
	parentSessionId?: string;
	forkContext?: ForkContextOptions;
	onEvent?: (event: Record<string, unknown>) => void;
	artifactsDir?: string;
	/**
	 * Required for artifacts to actually be written: runSingleAgent gates on
	 * this, not on artifactsDir. Passing a directory without a config writes
	 * nothing, silently.
	 */
	artifactConfig?: ArtifactConfig;
	agentScope?: "user" | "project" | "both";
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	preferredModelProvider?: string;
	/** Extra environment variables injected into each spawned child. */
	extraEnv?: Record<string, string>;
}

export type SpawnAgentFn = (
	cwd: string,
	agent: AgentConfig,
	prompt: string,
	options: Record<string, unknown>,
) => Promise<SingleResult>;

/**
 * What a human node produced, and how.
 *
 * `source` is not decoration: an edge that cannot tell "the human chose
 * hold" from "nobody was watching, so hold was assumed" would convert
 * absence into consent. A handler that resolved the default internally and
 * returned a bare string would erase that difference before the runner
 * could record it.
 */
export interface HumanHandlerResult {
	answer: string;
	source: "human" | "default" | "none";
}

export interface CreateNodeRunnerOptions extends AgentSpawnOptions {
	spawnAgent: SpawnAgentFn;
	broker?: RequestBroker;
	/**
	 * Per-node state buffers for the `node_state` tool. When provided, the
	 * runner drains each node's accumulated state into `result.data` at
	 * completion. When absent (e.g. tests that don't exercise node_state),
	 * `result.data` is an empty object and the tool is effectively inert.
	 */
	nodeStateBuffers?: NodeStateBuffers;
}

function usageTokens(result: SingleResult): number | undefined {
	const usage = result.usage as { totalTokens?: number } | undefined;
	return usage?.totalTokens;
}

/**
 * Builds the NodeRunner the executor calls for each node.
 */
export function createNodeRunner(options: CreateNodeRunnerOptions): NodeRunner {
	let spawnIndex = 0;

	return async function runNode(
		node: GraphNode,
		state: GraphState,
		context: { step: number; runId: string; signal?: AbortSignal },
	): Promise<NodeRunOutcome> {
		const signal = context.signal ?? options.signal;

		switch (node.def.type) {
			case "fn": {
				// Pure synchronous function node — no LLM, no subprocess.
				// Runs instantly; result shape is identical to an agent result
				// so downstream prompts and edges work unchanged.
				let text: string;
				try {
					text = String(node.def.fn(state));
				} catch (error) {
					return {
						result: withResultText({ status: "ok", text: "", data: {} }),
						technicalFailure: true,
						error: `fn node "${node.id}" threw: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				return {
					result: withResultText({ status: "ok", text, data: {} }),
				};
			}

			case "command":
				return runCommandNode(node.id, node.def, state, options.cwd);

			case "agent":
				return runAgentNode(node, node.def.agentName, node.def.promptFn(state), signal);

			case "human": {
				const def = node.def;
				const prompt = def.promptFn(state);

				// Prepare artifact preview if requested
				let artifactPreview: string | undefined;
				if (def.artifacts && def.artifacts.length > 0) {
					const sections: string[] = [];
					for (const art of def.artifacts) {
						if (art === "plan") {
							const pDir = plansDir(options.cwd);
							if (fs.existsSync(pDir)) {
								const files = fs.readdirSync(pDir).filter((f) => f.endsWith(".md"));
								for (const f of files) {
									try {
										const content = fs.readFileSync(path.join(pDir, f), "utf-8");
										sections.push(`### 📋 Plan: ${f.slice(0, -3)}\n\n${content}`);
									} catch {
										// ignore unreadable files
									}
								}
							}
						} else if (art === "contract") {
							const cDir = contractsDir(options.cwd);
							if (fs.existsSync(cDir)) {
								const files = fs.readdirSync(cDir).filter((f) => f.endsWith(".md"));
								for (const f of files) {
									try {
										const content = fs.readFileSync(path.join(cDir, f), "utf-8");
										sections.push(`### 📜 Contract: ${f.slice(0, -3)}\n\n${content}`);
									} catch {
										// ignore unreadable files
									}
								}
							}
						}
					}
					if (sections.length > 0) {
						artifactPreview = sections.join("\n\n---\n\n");
					}
				}

				// Route through RequestBroker if present (for background execution / IPC).
				if (options.broker) {
					const optionsList = def.options?.map((o, idx) => ({
						label: o,
						// Attach artifact preview to the first option (typically "Approve") if present
						preview: idx === 0 && artifactPreview ? artifactPreview : undefined,
					}));

					const result = await options.broker.ask({
						runId: context.runId,
						nodeId: node.id,
						kind: "human",
						questions: [
							{
								question: prompt,
								header: node.id,
								options: optionsList,
							},
						],
						default: def.default,
						expectsReply: true,
					});

					if (result.source === "cancelled") {
						return {
							result: withResultText({
								status: "skipped",
								text: "",
								reason: result.reason ?? "Cancelled by user.",
								prompt,
							}),
						};
					}

					const answer = result.text ?? def.default;
					const status = result.source === "default" ? "default" : "ok";

					return {
						result: withResultText({
							status,
							text: answer ?? "",
							answer,
							prompt,
							...(status === "ok"
								? {}
								: {
										reason: "No answer was given; fell back to the node's default.",
									}),
						}),
					};
				}

				// Headless fallback when no broker is available.
				const answer = def.default;
				return {
					result: withResultText({
						status: def.default !== undefined ? "default" : "skipped",
						// `text` mirrors `answer` so interpolating a human node's
						// result into a downstream prompt (`${state.ask}`) yields
						// the chosen value instead of "[object Object]" — the same
						// contract agent() results carry. `answer` stays for callers
						// that want the structured field by name.
						text: answer ?? "",
						answer,
						reason:
							def.default !== undefined
								? "No UI available; used the node's default answer."
								: "No UI available and no default was set.",
						prompt,
					}),
				};
			}
		}
	};

	async function runCommandNode(
		nodeId: string,
		def: CommandNodeDef,
		state: GraphState,
		defaultCwd: string,
	): Promise<NodeRunOutcome> {
		const timeout = def.timeoutMs ?? COMMAND_NODE_DEFAULT_TIMEOUT_MS;
		const cwd = def.cwd ?? defaultCwd;
		const env = { ...process.env, ...(def.env ?? {}) };

		// Dynamic form: evaluate the command function against the current graph
		// state — the same state a prompt function would receive. A throw or a
		// non-string/empty result is a bug in the script, not a routable outcome:
		// like a prompt function that throws, it is classified technical so the
		// graph aborts with a clear message instead of routing on garbage.
		let commandString: string;
		if (typeof def.command === "function") {
			let evaluated: unknown;
			try {
				evaluated = def.command(state);
			} catch (error) {
				return {
					result: withResultText({
						status: "blocked",
						text: "",
						data: { exitCode: null, stdout: "", stderr: "" },
					}),
					technicalFailure: true,
					error: `command node "${nodeId}" function threw: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (typeof evaluated !== "string" || evaluated.trim().length === 0) {
				return {
					result: withResultText({
						status: "blocked",
						text: "",
						data: { exitCode: null, stdout: "", stderr: "" },
					}),
					technicalFailure: true,
					error: `command node "${nodeId}" function returned ${evaluated === null ? "null" : typeof evaluated} instead of a non-empty command string`,
				};
			}
			commandString = evaluated;
		} else {
			commandString = def.command;
		}

		// spawnSync does NOT throw for ENOENT, a bad cwd, a timeout, or an
		// overflowed maxBuffer — all of those land in result.error with
		// status/signal null. try/catch alone would never see them; result.error
		// must be checked explicitly, which is what distinguishes "infrastructure
		// could not even run the command" from "the command ran and exited
		// nonzero" below.
		const spawnResult = spawnSync(commandString, {
			cwd,
			env,
			timeout,
			shell: true,
			encoding: "utf-8",
			maxBuffer: COMMAND_NODE_MAX_OUTPUT_BYTES,
		});

		const timedOut = spawnResult.error !== undefined && (spawnResult.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		const stdout = truncateOutput(spawnResult.stdout ?? "");
		const stderr = truncateOutput(spawnResult.stderr ?? "");
		const text = stdout.trim() || stderr.trim() || "";

		if (timedOut) {
			// allowFailure makes this routable instead of aborting the run, so its
			// status must stay in the "ok" | "blocked" vocabulary an edge condition
			// is written against — "failed" would be a third value no edge expects.
			// Without allowFailure this is a technicalFailure and the run aborts
			// before any edge sees the result, so the status value in that branch
			// is display-only.
			return {
				result: withResultText({
					status: def.allowFailure ? "ok" : "blocked",
					text,
					data: { exitCode: null, stdout, stderr, timedOut: true },
				}),
				technicalFailure: !def.allowFailure,
				error: `command node "${nodeId}" timed out after ${timeout}ms: ${commandString}`,
			};
		}

		// Any other spawn-level error (ENOENT on the shell, bad cwd, ENOBUFS from
		// exceeding the output cap) is infrastructure, not something the command
		// itself did — there is no exit code to route on, so this always aborts
		// the run regardless of allowFailure, same as an agent's technical failure.
		if (spawnResult.error !== undefined) {
			return {
				result: withResultText({ status: "failed", text, data: { exitCode: null, stdout, stderr } }),
				technicalFailure: true,
				error: `command node "${nodeId}" failed to run: ${spawnResult.error.message}`,
			};
		}

		const exitCode = spawnResult.status;
		const succeeded = exitCode === 0;

		// A nonzero exit is a routable outcome by default — same status vocabulary
		// as an agent's escalation ( "ok" | "blocked" ) so an edge written for
		// agent results also reads a command node's result without special-casing
		// it. allowFailure additionally forces "ok" for authors who only care
		// that the command ran, not whether it exited clean.
		const status = succeeded || def.allowFailure ? "ok" : "blocked";
		return {
			result: withResultText({
				status,
				text,
				data: { exitCode, stdout, stderr, timedOut: false },
			}),
		};
	}

	async function runAgentNode(
		node: GraphNode,
		agentName: string,
		prompt: string,
		signal: AbortSignal | undefined,
	): Promise<NodeRunOutcome> {
		const resolved = resolveGraphAgent(agentName, options.cwd, {
			agentScope: options.agentScope,
		});

		if (!resolved.agent) {
			// Configuration error, not something an agent can be asked to fix.
			return { result: null, technicalFailure: true, error: resolved.error };
		}

		spawnIndex += 1;

		// `withEscalationProtocol` is applied unconditionally (deduped for bundled
		// agents), so the spawn path above is the only place sessionFile lives.
		const agentWithProtocol = withEscalationProtocol(resolved.agent);
		const sessionFile = path.join(
			options.cwd,
			".pi-workflow",
			"sessions",
			options.runId,
			`${node.id}.jsonl`,
		);
		let single: SingleResult;
		try {
			// First spawn of this node in this run? The fork summary
			// (a compaction of the orchestrator's parent session) bootstraps the
			// agent's context exactly as today. A REVISIT, by contrast, resumes an
			// existing session, so the agent walks in with its own full history
			// already in the transcript — re-injecting a parent summary would be
			// noise (and risk a prompt-length runaway).
			const sessionExists = fs.existsSync(sessionFile);
			const forkContext = sessionExists ? undefined : options.forkContext;

			single = await options.spawnAgent(options.cwd, agentWithProtocol, prompt, {
				runId: options.runId,
				index: spawnIndex,
				signal,
				parentSessionId: options.parentSessionId,
				forkContext,
				sessionFile,
				onEvent: options.onEvent,
				artifactsDir: options.artifactsDir,
				artifactConfig: options.artifactConfig,
				context: resolved.agent.defaultContext ?? "fork",
				availableModels: options.availableModels,
				preferredModelProvider: options.preferredModelProvider,
				turnBudget: resolved.agent.turnBudget,
				toolBudget: resolved.agent.toolBudget,
				timeoutMs: resolved.agent.timeoutMs,
				// This node's own id, so the child-side node_state tool can scope its
				// requests to this node's accumulator (and so it can tell it is
				// actually running as a graph node, not a plain subagent call).
				extraEnv: { ...options.extraEnv, [PI_WORKFLOW_NODE_ID_ENV]: node.id },
				maxSubagentDepth: resolveChildMaxSubagentDepth(
					resolveCurrentMaxSubagentDepth(),
					resolved.agent.maxSubagentDepth,
				),
			});
		} catch (error) {
			return {
				result: null,
				technicalFailure: true,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const sessionId = sessionFile;
		const text = getFinalOutput(single.messages ?? []) || single.error || "";
		const tokens = usageTokens(single);

		// Only classify when something actually went wrong; a clean run is
		// never a failure.
		if (single.exitCode !== 0 || single.error || single.errorMessage) {
			const classification = classifySingleResultFailure(single);

			if (classification.class === "technical") {
				// Infrastructure failed. There is no agent judgement to route on.
				// Drain the buffer for cleanup even though the graph aborts.
				options.nodeStateBuffers?.drain(node.id);
				return {
					result: { status: "failed", agent: agentName, text, error: classification.reason },
					technicalFailure: true,
					error: classification.reason,
					tokens,
				};
			}

			// An agent-level failure is a routable outcome, not an abort. The
			// agent tried and could not finish; an edge decides what happens.
			const parsed = parseAgentResult(text, agentName);
			parsed.data = options.nodeStateBuffers?.drain(node.id) ?? {};
			return {
				result: { ...parsed, error: classification.reason, usage: tokens ? { tokens } : undefined },
				error: classification.reason,
				tokens,
				sessionId,
			};
		}

		const parsed = parseAgentResult(text, agentName);
		if (tokens) parsed.usage = { tokens };
		parsed.data = options.nodeStateBuffers?.drain(node.id) ?? {};
		return { result: parsed, tokens, sessionId };
	}
}
