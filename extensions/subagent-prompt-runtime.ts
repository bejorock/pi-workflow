/**
 * Child-side subagent runtime extension.
 *
 * This file is injected as a --extension into every child pi process spawned
 * by the subagent tool. It handles:
 *   - System prompt rewriting (boundary instructions, strip project context/skills/
 *     parent orchestration, structured output notice)
 *   - Stripping parent-only messages from inherited session history
 *   - Registering the structured_output tool when requested
 *   - Registering the tool-budget block interceptor
 *   - Registering the child watchdog
 *   - Setting the session name for intercom routing
 *
 * Child-side prompt rewriting and tool registration runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStructuredOutputToolParameters, STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, validateStructuredOutputValue } from "./structured-output.ts";
import { TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge } from "./tool-budget.ts";
import { TURN_BUDGET_ENV, decodeTurnBudgetEnv, turnBudgetSoftBlockMessage } from "./turn-budget.ts";
import type { ResolvedTurnBudget } from "./types.ts";
import { CHILD_TOOL_DIAGNOSTIC_PATH_ENV, MCP_DIRECT_CHILD_TOOLS_ENV, REQUIRED_CHILD_TOOLS_ENV, registerChildToolAllowlist, writeChildToolDiagnostic, type ChildToolDiagnostic } from "./tool-availability.ts";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_CHILD_INDEX_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./pi-args.ts";
import { registerChildWatchdog } from "./watchdog/child-status.ts";
import type { JsonSchemaObject, ResolvedToolBudget } from "./types.ts";

export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
	"The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
	"You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
	"Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
	"The maxSubagentDepth cap still applies and may block further fanout.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-slash-text-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
/** Matches any skill that would inject conflicting orchestration instructions into a child. */
const CONFLICTING_ORCHESTRATION_SKILL_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) {
			endIndex = index;
		}
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

/**
 * Strips any `pi-subagents` skill block from the inherited prompt.
 *
 * Safety net: if a user has the third-party `pi-subagents` package installed
 * as a global skill, its orchestration instructions would conflict with
 * pi-workflow's own subagent protocol. This strips it so children only see
 * our escalation protocol.
 */
export function stripConflictingOrchestrationSkills(prompt: string): string {
	return prompt
		.replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
		.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => CONFLICTING_ORCHESTRATION_SKILL_PATTERN.test(block) ? "" : block);
}

function stripChildBoundaryInstructions(prompt: string): string {
	let rewritten = prompt;
	for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS]) {
		rewritten = rewritten.split(boundary).join("");
	}
	return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function rewriteSubagentPrompt(
	prompt: string,
	options: { inheritProjectContext: boolean; inheritSkills: boolean; fanoutChild?: boolean },
): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	rewritten = stripConflictingOrchestrationSkills(rewritten);
	rewritten = stripChildBoundaryInstructions(rewritten);
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : "";
	return `${boundary}${structured}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	if (m?.role !== "custom" || typeof m.customType !== "string") return false;
	return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(messages: unknown[]): unknown[] {
	const preserveCurrentFanoutToolHistory = process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1";
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))) {
			changed = true;
			continue;
		}
		const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		if (stripped !== message) changed = true;
		filtered.push(stripped);
	}
	return changed ? filtered : messages;
}

function readRequiredChildTools(): string[] | undefined {
	const encoded = process.env[REQUIRED_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	const required = JSON.parse(encoded) as unknown;
	if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name)) {
		throw new Error(`Invalid ${REQUIRED_CHILD_TOOLS_ENV} payload.`);
	}
	return required;
}

function readMcpDirectChildTools(): string[] | undefined {
	const encoded = process.env[MCP_DIRECT_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	try {
		const tools = JSON.parse(encoded) as unknown;
		if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string" || !name)) return undefined;
		return tools;
	} catch {
		return undefined;
	}
}

function refreshChildToolDiagnostic(pi: ExtensionAPI): ChildToolDiagnostic | undefined {
	const filePath = process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]?.trim();
	const required = readRequiredChildTools();
	if (!filePath || !required) return undefined;
	const available = pi.getActiveTools();
	return writeChildToolDiagnostic(filePath, required, available, process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim(), readMcpDirectChildTools());
}

export function registerToolBudget(pi: ExtensionAPI, budget: ResolvedToolBudget | undefined): void {
	if (!budget) return;
	let toolCount = 0;
	let softNudged = false;
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string }) => unknown) => void;
	onRuntimeEvent("tool_call", (event) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		toolCount++;
		if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
			softNudged = true;
			try {
				sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
			} catch {
				// Budget nudges are advisory; blocking below remains authoritative.
			}
		}
		if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
		return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
	});
}

/**
 * Child-side turn-budget enforcement, mirroring registerToolBudget's shape:
 * count turns from `turn_end` (turnIndex is 0-based, so turnIndex + 1 =
 * number of turns completed), then once at or past `maxTurns`, block EVERY
 * tool call with a wrap-up instruction so the model finishes normally with
 * real output — no kill in the common case. `graceTurns` intentionally has
 * no effect here: the child-side block already gives the model however many
 * turns it needs to write its final answer once tools are blocked, so
 * graceTurns is reserved for the parent-side hard backstop (execution.ts)
 * that exists only for a model that ignores this block entirely.
 */
export function registerTurnBudget(pi: ExtensionAPI, budget: ResolvedTurnBudget | undefined): void {
	if (!budget) return;
	let turnsCompleted = 0;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { turnIndex?: number }) => unknown) => void;
	onRuntimeEvent("turn_end", (event) => {
		if (typeof event.turnIndex === "number") turnsCompleted = event.turnIndex + 1;
	});
	onRuntimeEvent("tool_call", () => {
		if (turnsCompleted < budget.maxTurns) return undefined;
		return { block: true, reason: turnBudgetSoftBlockMessage(budget, turnsCompleted) };
	});
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	registerChildToolAllowlist(pi);
	registerToolBudget(pi, decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV], { allowZero: process.env[TOOL_BUDGET_ZERO_AUTH_ENV] === "1" }));
	registerTurnBudget(pi, decodeTurnBudgetEnv(process.env[TURN_BUDGET_ENV]));
	registerChildWatchdog(pi);

	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown) => unknown) => void;

	onRuntimeEvent("agent_start", () => {
		refreshChildToolDiagnostic(pi);
	});

	const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (structuredOutputPath && structuredSchemaPath) {
		const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8")) as JsonSchemaObject;
		const parameters = createStructuredOutputToolParameters(schema);
		const registerTool = pi.registerTool as unknown as (tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (_id: string, params: { value: unknown }) => Promise<unknown>;
		}) => void;
		registerTool({
			name: "structured_output",
			label: "Structured Output",
			description: "Submit the required final structured output for this subagent step. This terminates the step.",
			parameters: parameters as never,
			async execute(_id: string, params: { value: unknown }) {
				const validation = await validateStructuredOutputValue(schema, params.value);
				if (validation.status === "invalid") {
					throw new Error(`Structured output validation failed: ${validation.message}`);
				}
				fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
				fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), { mode: 0o600 });
				return {
					content: [{ type: "text", text: "Structured output captured." }],
					details: { path: structuredOutputPath },
					terminate: true,
				};
			},
		});
	}

	onRuntimeEvent("context", (raw: unknown) => {
		const event = raw as { messages: unknown[] };
		const messages = stripParentOnlySubagentMessages(event.messages);
		if (messages === event.messages) return undefined;
		return { messages };
	});

	onRuntimeEvent("before_agent_start", async (raw: unknown) => {
		const event = raw as { systemPrompt: string };
		const required = JSON.parse(process.env.PI_WORKFLOW_NODE_REQUIRED_TOOLS ?? "[]") as string[];
		const missing = required.filter(tool => !pi.getActiveTools().includes(tool));
		if (missing.length) {
			const message = `Node required tools unavailable before provider request: ${missing.join(", ")}`;
			// Pi catches extension-hook exceptions and continues generation. A child
			// must terminate here, rather than merely log a failed preflight.
			if (process.env.PI_SUBAGENT_CHILD === "1") { process.stderr.write(`${message}\n`); process.exit(1); }
			throw new Error(message);
		}
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof (pi as { setSessionName?: (name: string) => void }).setSessionName === "function") {
			(pi as { setSessionName: (name: string) => void }).setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
		let rewritten = event.systemPrompt;
		if (inheritProjectContext !== undefined || inheritSkills !== undefined || fanoutChild !== undefined) {
			rewritten = rewriteSubagentPrompt(event.systemPrompt, {
				inheritProjectContext: inheritProjectContext ?? true,
				inheritSkills: inheritSkills ?? true,
				fanoutChild: fanoutChild === true,
			});
		}
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
