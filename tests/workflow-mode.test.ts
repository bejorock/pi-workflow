/**
 * Tests for the /wf (and legacy /workflow) execution mode switcher (extensions/workflow-mode.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, beforeEach } from "vitest";
import {
	registerWorkflowMode,
	isWriteBashCommand,
	WORKFLOW_MODE_SYSTEM_DIRECTIVE,
	PLAN_MODE_SYSTEM_DIRECTIVE,
	NORMAL_MODE_SYSTEM_DIRECTIVE,
} from "../extensions/workflow-mode.ts";

// --- Pure helper function tests -------------------------------------------

describe("isWriteBashCommand", () => {
	it("blocks common mutation commands", () => {
		expect(isWriteBashCommand("rm -rf /tmp/foo")).toBe(true);
		expect(isWriteBashCommand("mv a.txt b.txt")).toBe(true);
		expect(isWriteBashCommand("cp a.txt b.txt")).toBe(true);
		expect(isWriteBashCommand("mkdir foo")).toBe(true);
		expect(isWriteBashCommand("touch foo.txt")).toBe(true);
		expect(isWriteBashCommand("chmod +x foo.sh")).toBe(true);
		expect(isWriteBashCommand("sed -i 's/a/b/' file.txt")).toBe(true);
		expect(isWriteBashCommand("echo hi > file.txt")).toBe(true);
		expect(isWriteBashCommand("echo hi >> file.txt")).toBe(true);
		expect(isWriteBashCommand("npm install lodash")).toBe(true);
		expect(isWriteBashCommand("git commit -m 'wip'")).toBe(true);
		expect(isWriteBashCommand("git push origin main")).toBe(true);
		expect(isWriteBashCommand("git checkout -b feature")).toBe(true);
		expect(isWriteBashCommand("sudo apt install curl")).toBe(true);
		expect(isWriteBashCommand("kill -9 1234")).toBe(true);
	});

	it("allows read-only commands", () => {
		expect(isWriteBashCommand("cat file.txt")).toBe(false);
		expect(isWriteBashCommand("grep -r foo .")).toBe(false);
		expect(isWriteBashCommand("ls -la")).toBe(false);
		expect(isWriteBashCommand("git status")).toBe(false);
		expect(isWriteBashCommand("git log --oneline")).toBe(false);
		expect(isWriteBashCommand("git diff")).toBe(false);
		expect(isWriteBashCommand("npm list")).toBe(false);
		expect(isWriteBashCommand("curl https://example.com")).toBe(false);
		expect(isWriteBashCommand("find . -name '*.ts'")).toBe(false);
		expect(isWriteBashCommand("echo hello")).toBe(false);
		expect(isWriteBashCommand("wc -l file.txt")).toBe(false);
	});
});

// --- registerWorkflowMode() integration tests using a mock pi -------------

interface MockCommandHandler {
	description: string;
	handler: (args: string, ctx: ReturnType<typeof makeMockCtx>) => Promise<void>;
}

interface ToolCallBlockResult {
	block: true;
	reason: string;
}

interface SystemPromptResult {
	systemPrompt: string;
}

function makeMockPi() {
	const commands: Record<string, MockCommandHandler> = {};
	const toolCallHandlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => Promise<ToolCallBlockResult | undefined>> = [];
	const beforeAgentStartHandlers: Array<(event: { systemPrompt: string }) => Promise<SystemPromptResult | undefined>> = [];
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "workflow", "workflow_status", "workflow_stop"];

	const mock = {
		commands,
		registerCommand(name: string, opts: MockCommandHandler) {
			commands[name] = opts;
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (event === "tool_call") toolCallHandlers.push(handler as typeof toolCallHandlers[number]);
			if (event === "before_agent_start") beforeAgentStartHandlers.push(handler as typeof beforeAgentStartHandlers[number]);
			if (event === "session_start" || event === "agent_settled") {
				// Stub for widget trigger hooks
			}
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(tools: string[]) {
			activeTools = [...tools];
		},
		get activeTools() {
			return activeTools;
		},
		async fireToolCall(event: { toolName: string; input: Record<string, unknown> }) {
			for (const h of toolCallHandlers) {
				const result = await h(event);
				if (result) return result;
			}
			return undefined;
		},
		async fireBeforeAgentStart(event: { systemPrompt: string }) {
			for (const h of beforeAgentStartHandlers) {
				const result = await h(event);
				if (result) return result;
			}
			return undefined;
		},
	};
	return mock;
}

function asExtensionAPI(mock: ReturnType<typeof makeMockPi>): ExtensionAPI {
	return mock as unknown as ExtensionAPI;
}

function makeMockCtx() {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Record<string, string | undefined> = {};
	const widgets: Record<string, { lines: string[]; options?: Record<string, unknown> }> = {};
	return {
		notifications,
		statuses,
		widgets,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses[key] = value;
			},
			setWidget: (id: string, lines: string[], options?: Record<string, unknown>) => {
				widgets[id] = { lines, options };
			},
			theme: { fg: (_name: string, text: string) => text },
		},
	};
}

describe("registerWorkflowMode /wf modes", () => {
	let pi: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		pi = makeMockPi();
	});

	it("registers /wf command", () => {
		registerWorkflowMode(asExtensionAPI(pi));
		expect(pi.commands.wf).toBeDefined();
	});

	it("/wf plan restricts active tools (read-only plan mode)", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();

		await pi.commands.wf.handler("plan", ctx);

		expect(pi.activeTools).not.toContain("write");
		expect(pi.activeTools).not.toContain("edit");
		expect(pi.activeTools).not.toContain("subagent");
		expect(pi.activeTools).not.toContain("subagent_wait");
		expect(pi.activeTools).not.toContain("workflow");
		expect(pi.activeTools).not.toContain("workflow_status");
		expect(pi.activeTools).not.toContain("workflow_reply");
		expect(pi.activeTools).not.toContain("ask_supervisor");
		expect(pi.activeTools).not.toContain("list_agents");
		expect(pi.activeTools).not.toContain("list_workflows");
		expect(pi.activeTools).toContain("read");
		expect(pi.activeTools).toContain("bash");
		expect(ctx.notifications[0].message).toContain("PLAN");
		expect(ctx.widgets["pi-workflow-mode"].lines[0]).toContain("Plan");
	});

	it("/wf workflow restricts active tools (workflow mode)", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();

		await pi.commands.wf.handler("workflow", ctx);

		expect(pi.activeTools).not.toContain("write");
		expect(pi.activeTools).not.toContain("edit");
		expect(pi.activeTools).not.toContain("subagent");
		expect(pi.activeTools).not.toContain("subagent_wait");
		expect(pi.activeTools).toContain("workflow");
		expect(pi.activeTools).toContain("workflow_status");
		expect(pi.activeTools).toContain("workflow_stop");
		expect(pi.activeTools).toContain("read");
		expect(pi.activeTools).toContain("bash");
		expect(ctx.notifications[0].message).toContain("WORKFLOW");
		expect(ctx.widgets["pi-workflow-mode"].lines[0]).toContain("Workflow");
	});

	it("/wf normal restores all tools", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();
		const before = pi.activeTools;

		await pi.commands.wf.handler("plan", ctx);
		expect(pi.activeTools).not.toContain("write");

		await pi.commands.wf.handler("normal", ctx);
		expect(pi.activeTools.sort()).toEqual(before.sort());
		expect(ctx.notifications[1].message).toContain("NORMAL");
		expect(ctx.widgets["pi-workflow-mode"].lines[0]).toContain("Normal");
	});

	it("blocks write and edit tool calls while in workflow or plan modes", async () => {
		const state = registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();

		// Workflow mode blocks
		await pi.commands.wf.handler("workflow", ctx);
		expect(state.currentMode).toBe("workflow");
		let result = await pi.fireToolCall({ toolName: "write", input: { path: "foo.txt", content: "x" } });
		expect(result?.block).toBe(true);

		// Plan mode blocks
		await pi.commands.wf.handler("plan", ctx);
		expect(state.currentMode).toBe("plan");
		result = await pi.fireToolCall({ toolName: "write", input: { path: "foo.txt", content: "x" } });
		expect(result?.block).toBe(true);
	});

	it("blocks all subagent/workflow tools in plan mode, but allows workflow tools in workflow mode", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();

		// Plan mode blocks all subagent/workflow-related tools
		await pi.commands.wf.handler("plan", ctx);
		let res = await pi.fireToolCall({ toolName: "workflow", input: { script: "" } });
		expect(res?.block).toBe(true);
		res = await pi.fireToolCall({ toolName: "workflow_reply", input: { requestId: "x", answer: "y" } });
		expect(res?.block).toBe(true);
		res = await pi.fireToolCall({ toolName: "workflow_stop", input: { runId: "x" } });
		expect(res?.block).toBe(true);
		res = await pi.fireToolCall({ toolName: "ask_supervisor", input: { question: "q" } });
		expect(res?.block).toBe(true);
		res = await pi.fireToolCall({ toolName: "subagent_wait", input: { status: true } });
		expect(res?.block).toBe(true);
		res = await pi.fireToolCall({ toolName: "list_agents", input: {} });
		expect(res?.block).toBe(true);
		res = await pi.fireToolCall({ toolName: "list_workflows", input: {} });
		expect(res?.block).toBe(true);

		// Workflow mode allows workflow/workflow_status but blocks subagent_wait
		await pi.commands.wf.handler("workflow", ctx);
		res = await pi.fireToolCall({ toolName: "workflow", input: { script: "" } });
		expect(res).toBeUndefined();
		res = await pi.fireToolCall({ toolName: "workflow_stop", input: { runId: "x" } });
		expect(res).toBeUndefined();
		res = await pi.fireToolCall({ toolName: "subagent_wait", input: { status: true } });
		expect(res?.block).toBe(true);
	});

	it("blocks write-shaped bash commands but allows read-only bash in both plan and workflow modes", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();

		// Workflow mode
		await pi.commands.wf.handler("workflow", ctx);
		let res = await pi.fireToolCall({ toolName: "bash", input: { command: "rm -rf foo" } });
		expect(res?.block).toBe(true);

		res = await pi.fireToolCall({ toolName: "bash", input: { command: "git status" } });
		expect(res).toBeUndefined();

		// Plan mode
		await pi.commands.wf.handler("plan", ctx);
		res = await pi.fireToolCall({ toolName: "bash", input: { command: "rm -rf foo" } });
		expect(res?.block).toBe(true);

		res = await pi.fireToolCall({ toolName: "bash", input: { command: "git status" } });
		expect(res).toBeUndefined();
	});

	it("injects mode-specific system prompts and banners correctly", async () => {
		registerWorkflowMode(asExtensionAPI(pi));
		const ctx = makeMockCtx();

		// Normal Mode
		await pi.commands.wf.handler("normal", ctx);
		let startRes = await pi.fireBeforeAgentStart({ systemPrompt: "Base prompt." });
		expect(startRes?.systemPrompt).toContain(NORMAL_MODE_SYSTEM_DIRECTIVE);
		expect(startRes?.systemPrompt).toContain("ACTIVE EXECUTION MODE: 🟢 NORMAL");

		// Plan Mode
		await pi.commands.wf.handler("plan", ctx);
		startRes = await pi.fireBeforeAgentStart({ systemPrompt: "Base prompt." });
		expect(startRes?.systemPrompt).toContain(PLAN_MODE_SYSTEM_DIRECTIVE);
		expect(startRes?.systemPrompt).toContain("ACTIVE EXECUTION MODE: 🔵 PLAN");

		// Workflow Mode
		await pi.commands.wf.handler("workflow", ctx);
		startRes = await pi.fireBeforeAgentStart({ systemPrompt: "Base prompt." });
		expect(startRes?.systemPrompt).toContain(WORKFLOW_MODE_SYSTEM_DIRECTIVE);
		expect(startRes?.systemPrompt).toContain("ACTIVE EXECUTION MODE: 🧪 WORKFLOW");
	});
});
