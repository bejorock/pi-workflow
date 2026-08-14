/**
 * Agent settings — lets a team disable or override the agents bundled with
 * this package without forking the .md files.
 *
 * Bundled agents are resolved live from inside the installed package, so a
 * team cannot edit them directly (an upgrade would blow the edit away). The
 * supported ways to adapt a builtin are:
 *
 *   1. Shadow it — author `.pi/agents/<name>.md`, which wins outright.
 *   2. Override it — patch individual fields here, keeping the rest.
 *   3. Disable it — remove it from the roster entirely.
 *
 * Settings are read from two locations, project winning over user:
 *
 *   <cwd>/.pi-workflow/settings.json          (project)
 *   <agentDir>/pi-workflow-settings.json      (user)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

/**
 * Fields of a bundled agent that may be overridden from settings.
 *
 * Deliberately narrower than AgentConfig: `name`, `source`, and `filePath`
 * are identity, not configuration, and allowing them to be rewritten would
 * make the roster incoherent.
 */
export interface AgentOverride {
	disabled?: boolean;
	description?: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	tools?: string[];
	defaultContext?: "fresh" | "fork";
	systemPrompt?: string;
	systemPromptAppend?: string;
	turnBudget?: AgentConfig["turnBudget"];
	toolBudget?: AgentConfig["toolBudget"];
	acceptance?: AgentConfig["acceptance"];
	acceptanceRole?: "read-only" | "writer";
	timeoutMs?: number;
}

export interface AgentSettings {
	/** Remove every bundled agent from the roster. */
	disableBuiltins?: boolean;
	/** Per-agent overrides, keyed by agent name. */
	agents?: Record<string, AgentOverride>;
	/**
	 * Disable the blank-stop guard (auto-"continue" when a model returns an
	 * empty completion). Defaults to enabled when absent. Read once at
	 * process start, so it affects the main agent and every subagent that
	 * loads this extension in a directory where the settings file exists.
	 */
	blankStopGuard?: boolean;
}

export interface ResolvedAgentSettings extends AgentSettings {
	/** Files actually found and parsed, in ascending precedence order. */
	sources: string[];
	/** Files found but unparseable; surfaced rather than silently ignored. */
	errors: { path: string; message: string }[];
}

export const PROJECT_SETTINGS_RELATIVE_PATH = path.join(".pi-workflow", "settings.json");
export const USER_SETTINGS_FILENAME = "pi-workflow-settings.json";

function readSettingsFile(filePath: string): { settings?: AgentSettings; error?: string } {
	if (!fs.existsSync(filePath)) return {};

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	if (!raw.trim()) return { settings: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "expected a JSON object at the top level" };
	}

	return { settings: parsed as AgentSettings };
}

/**
 * Loads and merges user- then project-level settings.
 *
 * Merge is per-agent rather than whole-object: a project may override one
 * field of one agent without having to restate the user's entire config.
 */
export function loadAgentSettings(cwd: string, options: { userSettingsPath?: string } = {}): ResolvedAgentSettings {
	const userPath = options.userSettingsPath ?? path.join(getAgentDir(), USER_SETTINGS_FILENAME);
	const projectPath = path.join(cwd, PROJECT_SETTINGS_RELATIVE_PATH);

	const resolved: ResolvedAgentSettings = { sources: [], errors: [], agents: {} };

	for (const filePath of [userPath, projectPath]) {
		const { settings, error } = readSettingsFile(filePath);
		if (error) {
			resolved.errors.push({ path: filePath, message: error });
			continue;
		}
		if (!settings) continue;

		resolved.sources.push(filePath);

		if (settings.disableBuiltins !== undefined) {
			resolved.disableBuiltins = settings.disableBuiltins;
		}

		if (settings.blankStopGuard !== undefined) {
			resolved.blankStopGuard = settings.blankStopGuard;
		}

		if (settings.agents && typeof settings.agents === "object") {
			for (const [name, override] of Object.entries(settings.agents)) {
				if (!override || typeof override !== "object" || Array.isArray(override)) continue;
				resolved.agents![name] = { ...resolved.agents![name], ...override };
			}
		}
	}

	return resolved;
}

/**
 * Applies a single override on top of a discovered agent.
 *
 * `systemPromptAppend` is kept distinct from `systemPrompt` on purpose: the
 * common case is adding a house rule to a bundled agent, and forcing a team
 * to restate the whole prompt to do that would guarantee prompt drift on
 * every package upgrade.
 */
export function applyAgentOverride(agent: AgentConfig, override: AgentOverride): AgentConfig {
	const next: AgentConfig = { ...agent };

	if (override.description !== undefined) next.description = override.description;
	if (override.model !== undefined) next.model = override.model;
	if (override.fallbackModels !== undefined) next.fallbackModels = [...override.fallbackModels];
	if (override.thinking !== undefined) next.thinking = override.thinking;
	if (override.tools !== undefined) next.tools = [...override.tools];
	if (override.defaultContext !== undefined) next.defaultContext = override.defaultContext;
	if (override.turnBudget !== undefined) next.turnBudget = override.turnBudget;
	if (override.toolBudget !== undefined) next.toolBudget = override.toolBudget;
	if (override.acceptance !== undefined) next.acceptance = override.acceptance;
	if (override.acceptanceRole !== undefined) next.acceptanceRole = override.acceptanceRole;
	if (override.timeoutMs !== undefined) next.timeoutMs = override.timeoutMs;

	if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
	if (override.systemPromptAppend !== undefined) {
		next.systemPrompt = `${next.systemPrompt.trimEnd()}\n\n${override.systemPromptAppend}`;
	}

	return next;
}

/**
 * Applies settings to a discovered roster: drops disabled agents and patches
 * overridden ones.
 *
 * Overrides apply to any source, not just builtins. A project that shadows a
 * builtin and then wants one field tweaked per-developer should not be forced
 * to choose between the two mechanisms. `disableBuiltins` remains scoped to
 * builtins, since disabling agents a team explicitly authored would be
 * surprising.
 */
export function applyAgentSettings(agents: AgentConfig[], settings: AgentSettings): AgentConfig[] {
	const overrides = settings.agents ?? {};
	const result: AgentConfig[] = [];

	for (const agent of agents) {
		if (settings.disableBuiltins && agent.source === "builtin") continue;

		const override = overrides[agent.name];
		if (override?.disabled) continue;

		result.push(override ? applyAgentOverride(agent, override) : agent);
	}

	return result;
}
