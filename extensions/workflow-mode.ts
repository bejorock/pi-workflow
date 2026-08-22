/**
 * "/wf" (and legacy "/workflow") command: switches the session mode between:
 *  - "normal": full write and delegation access.
 *  - "plan": read-only planning and exploration (writes, subagents, and workflows are blocked).
 *  - "workflow": enforced delegation mode (writes and subagent are blocked, workflow is allowed).
 *
 * Implements mode banners, tool block gates, bash write-blocking, and live TUI widgets.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type SessionMode = "normal" | "plan" | "workflow";

export interface WorkflowModeState {
	currentMode: SessionMode;
	toolsBeforeWorkflowMode?: string[];
}

/** Tools explicitly blocked in Plan Mode. */
const PLAN_MODE_DISABLED_TOOLS = new Set<string>([
	"write", "edit",
	"subagent", "subagent_wait",
	"workflow", "workflow_status", "workflow_stop", "workflow_reply",
	"ask_supervisor",
	"list_agents", "list_workflows",
]);

/** Tools explicitly blocked in Workflow Mode. */
const WORKFLOW_MODE_DISABLED_TOOLS = new Set<string>(["write", "edit", "subagent", "subagent_wait"]);

// Reuses the same destructive-bash-pattern approach as plan-mode:
// a bash command is blocked in plan/workflow modes if it matches any mutating pattern below.
const WRITE_BASH_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // redirect overwrite: `> file`
	/>>/, // redirect append
	/\bsed\s+-i\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|apply)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
];

export function isWriteBashCommand(command: string): boolean {
	return WRITE_BASH_PATTERNS.some((p) => p.test(command));
}

const WIDGET_ID = "pi-workflow-mode";

function modeBanner(mode: SessionMode): string {
	const labels: Record<SessionMode, string> = {
		normal: "🟢 NORMAL",
		plan: "🔵 PLAN",
		workflow: "🧪 WORKFLOW",
	};
	return [
		"",
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		`📍 ACTIVE EXECUTION MODE: ${labels[mode]}`,
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"This is your ACTIVE execution mode as of this turn. If any earlier messages in this conversation",
		"mention a different mode, that is STALE — the mode was switched since then. Always obey this active mode's rules.",
	].join("\n");
}

export const NORMAL_MODE_SYSTEM_DIRECTIVE = `## NORMAL MODE ACTIVE

You are in **normal mode** — all tools are fully enabled.
- You have direct filesystem modification access (you can write and edit files directly).
- You can run bash commands freely without write-blocking restrictions.
- You can optionally delegate tasks using the \`subagent\` and \`workflow\` tools.`;

export const PLAN_MODE_SYSTEM_DIRECTIVE = `## PLAN MODE ACTIVE

You are in **plan mode** — read-only planning and investigation.
- Direct file mutations (\`write\`/\`edit\`) are disabled.
- All subagent and workflow tools are disabled (\`subagent\`, \`subagent_wait\`, \`workflow\`, \`workflow_status\`, \`workflow_stop\`, \`workflow_reply\`, \`ask_supervisor\`, \`list_agents\`, \`list_workflows\`).
- Bash is restricted to read-only commands (e.g. \`cat\`, \`grep\`, \`ls\`, \`git status\`, \`git diff\`).
- Focus on planning, discussing architectural designs, researching code, and answering questions. Do not attempt to write code or delegate to agents.`;

export const WORKFLOW_MODE_SYSTEM_DIRECTIVE = `[WORKFLOW MODE ACTIVE]
You must delegate all work through the \`workflow\` tool. Direct filesystem mutation and direct subagent
delegation are unavailable in this mode:

- \`write\` and \`edit\` are disabled — you cannot modify files directly.
- \`subagent\` is disabled — you cannot delegate to a single subagent directly.
- \`bash\` remains available for read-only investigation only (e.g. \`cat\`, \`grep\`, \`ls\`, \`git status\`,
  \`git diff\`, \`git log\`); write-shaped commands (redirects, \`rm\`, \`mv\`, \`sed -i\`, \`git commit\`, package
  installs, etc.) are blocked and will return an error telling you to use \`workflow\` instead.

For any task that requires changing files or delegating to an agent:
1. Use \`read\`/\`bash\` (read-only) first if you need to investigate the codebase.
2. Use the \`list_agents\` tool to discover available subagents and their capabilities.
3. Consult the \`pi-workflow\` skill (or load it) for complete syntax, API reference, closed escalation vocabulary (like \`contract\`, \`tests\`, \`environment\`, \`requirements\`, \`information\`, \`conflict\`), and advanced coordination patterns.
4. Write a graph script and call the \`workflow\` tool — its nodes are subagents that DO have full
   tool access (including write/edit), scoped to their own isolated run. 
   - Define nodes using:
     * \`agent(name, promptFn)\` for subagents.
     * \`human(prompt | promptFn, { options, default })\` to ask the user.
   - Route between them with \`g.edge(from, to)\` or conditional \`g.edge(from, (state, result) => target)\`.
5. Use the \`list_workflows\` tool to see available pre-built and saved workflows (such as "tdd" and "review_loop") that you can run instantly via the \`loadWorkflow\` parameter.
6. Use \`workflow_status\` to inspect a run's progress or investigate a failure, and \`workflow_stop\` to cancel a run that is misbehaving or no longer needed.

If the user's request is purely conversational or a question that needs no file changes or delegation,
just answer directly — workflow mode does not force you to call the \`workflow\` tool for every message,
only when file mutation or delegation is actually needed.`;

function getWidgetLines(mode: SessionMode): string[] {
	switch (mode) {
		case "normal":
			return ["\x1b[32m🟢 Normal · all tools enabled\x1b[0m"];
		case "plan":
			return ["\x1b[34m🔵 Plan · write tools blocked (read-only)\x1b[0m"];
		case "workflow":
			return ["\x1b[35m🧪 Workflow · enforced delegation (workflow tool only)\x1b[0m"];
	}
}

function updateWidget(ctx: ExtensionContext, mode: SessionMode): void {
	if (ctx?.ui?.setWidget) {
		ctx.ui.setWidget(WIDGET_ID, getWidgetLines(mode), { placement: "belowEditor" });
	}
}

export function registerWorkflowMode(
	pi: ExtensionAPI,
	options: { workflowToolName?: string; subagentToolName?: string } = {},
): WorkflowModeState {
	const state: WorkflowModeState = { currentMode: "normal" };

	function getActiveModeTools(mode: SessionMode, activeToolNames: string[]): string[] {
		const disabled = mode === "plan" ? PLAN_MODE_DISABLED_TOOLS : (mode === "workflow" ? WORKFLOW_MODE_DISABLED_TOOLS : new Set<string>());
		const kept = activeToolNames.filter((name) => !disabled.has(name));
		// Make sure core workflow tools are available if the mode is workflow
		if (mode === "workflow") {
			return [...new Set([...kept, "workflow", "workflow_status", "workflow_stop", "list_agents", "list_workflows"])];
		}
		if (mode === "plan") {
			// Plan mode: read-only investigation only, no subagent/workflow tools at all
			return kept;
		}
		return [...new Set([...kept, "write", "edit", "subagent", "workflow", "workflow_status", "workflow_stop"])];
	}

	function setMode(mode: SessionMode, ctx?: ExtensionContext): void {
		if (mode === state.currentMode) return;

		// If transitioning from normal, save the tools snapshot
		if (state.currentMode === "normal" && state.toolsBeforeWorkflowMode === undefined) {
			try {
				state.toolsBeforeWorkflowMode = pi.getActiveTools?.() ?? [];
			} catch {
				state.toolsBeforeWorkflowMode = [];
			}
		}

		state.currentMode = mode;

		const baseTools = state.toolsBeforeWorkflowMode ?? [];
		const activeTools = getActiveModeTools(mode, baseTools);
		try {
			pi.setActiveTools?.(activeTools);
		} catch {
			// best-effort
		}

		if (mode === "normal") {
			state.toolsBeforeWorkflowMode = undefined;
		}

		if (ctx) {
			updateWidget(ctx, mode);
			if (ctx.ui?.setStatus) {
				const label = mode === "normal" ? undefined : (mode === "plan" ? "🔵 PLAN" : "🧪 WORKFLOW");
				ctx.ui.setStatus("workflow-mode", label ? ctx.ui.theme?.fg?.("warning", label) ?? label : undefined);
			}
		}
	}

	const handleModeSwitch = (mode: SessionMode, label: string, infoMsg: string, ctx: any) => {
		setMode(mode, ctx);
		ctx.ui.notify(`Mode: ${label} \u2014 ${infoMsg}`, "info");
		if (ctx.hasUI) {
			updateWidget(ctx, mode);
			pi.sendMessage?.({
				customType: "mode-switch-notice",
				content: [{ type: "text", text: `[MODE SWITCHED \u2192 ${label}] ${infoMsg}. Previous mode context is now STALE.` }],
				display: true,
			});
		}
	};

	// --- Command: /wf [normal|plan|workflow|status] ---
	pi.registerCommand("wf", {
		description: "Switch session execution mode: /wf [normal|plan|workflow|status]",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "normal" || arg === "build") {
				handleModeSwitch("normal", "NORMAL", "all tools fully enabled", ctx);
				return;
			}
			if (arg === "plan") {
				handleModeSwitch("plan", "PLAN", "write/edit/delegation blocked (read-only)", ctx);
				return;
			}
			if (arg === "workflow" || arg === "on") {
				handleModeSwitch("workflow", "WORKFLOW", "enforced delegation mode (workflow tool only)", ctx);
				return;
			}
			if (arg === "off") {
				handleModeSwitch("normal", "NORMAL", "all tools fully enabled", ctx);
				return;
			}
			if (arg === "" || arg === "status") {
				ctx.ui.notify(`Active execution mode is ${state.currentMode.toUpperCase()}. Usage: /wf [normal|plan|workflow]`, "info");
				return;
			}
			ctx.ui.notify(`Unknown argument "${args}". Usage: /wf [normal|plan|workflow]`, "warning");
		},
	});

	// --- Hook: tool_call (block writes/mutations in plan/workflow modes) ---
	const disabledInWorkflow = new Set<string>(["write", "edit", "subagent", "subagent_wait"]);
	if (options.subagentToolName) disabledInWorkflow.add(options.subagentToolName);

	const disabledInPlan = new Set<string>([
		"write", "edit",
		"subagent", "subagent_wait",
		"workflow", "workflow_status", "workflow_stop", "workflow_reply",
		"ask_supervisor",
		"list_agents", "list_workflows",
	]);
	if (options.subagentToolName) disabledInPlan.add(options.subagentToolName);

	pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
		if (state.currentMode === "normal") return;

		// 1. Plan Mode blocks
		if (state.currentMode === "plan") {
			if (disabledInPlan.has(event.toolName)) {
				return {
					block: true,
					reason: `Plan mode is active: "${event.toolName}" is disabled. Switch to normal or workflow mode using /wf to run code or delegate tasks.`,
				};
			}
			if (event.toolName === "bash") {
				const command = String(event.input?.command ?? "");
				if (isWriteBashCommand(command)) {
					return {
						block: true,
						reason: `Plan mode is active: bash is read-only (this command looks like a write/mutation). Switch to normal or workflow mode to modify files.\nCommand: ${command}`,
					};
				}
			}
		}

		// 2. Workflow Mode blocks
		if (state.currentMode === "workflow") {
			if (disabledInWorkflow.has(event.toolName)) {
				return {
					block: true,
					reason: `Workflow mode is active: "${event.toolName}" is disabled. Use the workflow tool to delegate this work to a subagent instead.`,
				};
			}
			if (event.toolName === "bash") {
				const command = String(event.input?.command ?? "");
				if (isWriteBashCommand(command)) {
					return {
						block: true,
						reason: `Workflow mode is active: bash is read-only (this command looks like a write/mutation). Use the workflow tool instead.\nCommand: ${command}`,
					};
				}
			}
		}
	});

	// --- Hook: before_agent_start (system prompt mode directives & banner) ---
	pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
		let directive = "";
		if (state.currentMode === "normal") {
			directive = NORMAL_MODE_SYSTEM_DIRECTIVE;
		} else if (state.currentMode === "plan") {
			directive = PLAN_MODE_SYSTEM_DIRECTIVE;
		} else if (state.currentMode === "workflow") {
			directive = WORKFLOW_MODE_SYSTEM_DIRECTIVE;
		}

		// Compact skill hints injected into every turn so the agent is aware
		// these skills exist without being forced to read them.
		const hints: string[] = [];

		// pi-plans: always injected (plan tool works in all modes)
		hints.push("Skill available: `pi-plans` — use the `plan` tool to record plans in .pi-workflow/plans/ (works in all modes). Typically produced by the planner agent. Any agent can read. Type `/plans` to browse.");

		// pi-contracts: always injected (contract tool works in all modes)
		hints.push("Skill available: `pi-contracts` — use the `contract` tool to document formal agreements (API, interface, task, data) in .pi-workflow/contracts/. Typically produced by the architect agent. Lifecycle: draft → proposed → superseded. Always `propose` when done — consumers only act on proposed contracts. Type `/contracts` to browse.");

		// pi-workflow: only in normal and workflow modes (not needed in plan mode)
		if (state.currentMode === "normal" || state.currentMode === "workflow") {
			hints.push("Skill available: `pi-workflow` — subagent delegation and multi-agent workflow orchestration via the `subagent` and `workflow` tools.");
		}

		const skillHints = hints.length > 0 ? `\n\n<!-- skills -->${hints.map((h) => `\n- ${h}`).join("")}\n<!-- /skills -->` : "";

		return {
			systemPrompt: `${event.systemPrompt}\n\n${directive}${skillHints}${modeBanner(state.currentMode)}`,
		};
	});

	// --- Hooks: UI session widgets ---
	pi.on("session_start", (_event, ctx) => {
		if (ctx) {
			updateWidget(ctx, state.currentMode);
			if (ctx.ui?.setStatus && state.currentMode !== "normal") {
				const label = state.currentMode === "plan" ? "🔵 PLAN" : "🧪 WORKFLOW";
				ctx.ui.setStatus("workflow-mode", ctx.ui.theme?.fg?.("warning", label) ?? label);
			}
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx) updateWidget(ctx, state.currentMode);
	});

	// Compatibility shim property
	Object.defineProperty(state, "enabled", {
		get() { return this.currentMode === "workflow"; },
		set(val: boolean) { setMode(val ? "workflow" : "normal"); },
		enumerable: true,
		configurable: true,
	});

	return state;
}
