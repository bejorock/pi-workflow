/**
 * Agent discovery and configuration
 * Agent frontmatter parsing and discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AgentSettings, applyAgentSettings, loadAgentSettings } from "./agent-settings.ts";

export type AgentScope = "user" | "project" | "both";

/**
 * Whether a parsed agent inherits the project's compiled context.
 *
 * Only a `delegate` agent inherits project context; everything
 * else gets a fresh view. Bundled agents in this package are never delegates,
 * so the default is false for all of them.
 */
export function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

/**
 * Source of an agent definition, in ascending order of precedence.
 * A `project` agent shadows a `user` agent of the same name, which in turn
 * shadows a `builtin` one.
 */
export type AgentSource = "builtin" | "user" | "project";

/**
 * Directory holding the agents bundled with this package.
 *
 * Resolved live from this module's location rather than copied into the
 * user's project at install time, so that package upgrades propagate
 * automatically and we never write into a team's repository.
 */
export const BUILTIN_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"bundled-agents",
);

export interface AgentMemoryConfig {
	scope: "project" | "user";
	path: string;
}

export interface AgentAcceptanceConfig {
	level?: string;
	reason?: string;
}

export interface TurnBudgetConfig {
	maxTurns?: number;
	graceTurns?: number;
}

export interface ToolBudgetConfig {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface AgentConfig {
	name: string;
	description: string;
	// Optional frontmatter fields
	package?: string;
	tools?: string[];
	mcpDirectTools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;
	systemPromptMode?: "replace" | "append";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: "fresh" | "fork";
	skills?: string[];
	skillPath?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	async?: boolean;
	timeoutMs?: number;
	turnBudget?: TurnBudgetConfig;
	acceptance?: string | AgentAcceptanceConfig;
	acceptanceRole?: "read-only" | "writer";
	completionGuard?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	toolBudget?: ToolBudgetConfig;
	memory?: AgentMemoryConfig;
	extraFields?: Record<string, string>;
	// Runtime fields
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const KNOWN_FIELDS = new Set([
	"name",
	"package",
	"description",
	"tools",
	"model",
	"fallbackModels",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"defaultContext",
	"async",
	"timeoutMs",
	"turnBudget",
	"acceptance",
	"acceptanceRole",
	"skill",
	"skills",
	"skillPath",
	"extensions",
	"subagentOnlyExtensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
	"maxSubagentDepth",
	"completionGuard",
	"toolBudget",
	"memory",
]);

function parseStringOrArray(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		return value.split(",").map((s) => s.trim()).filter(Boolean);
	}
	if (Array.isArray(value)) {
		return value.map((v) => String(v).trim()).filter(Boolean);
	}
	return undefined;
}

/**
 * Parses a frontmatter value that may arrive either as a JSON string
 * (`turnBudget: {"maxTurns": 5}` when the parser leaves it raw) or as an
 * already-decoded object (when the YAML parser decodes the inline map).
 */
function parseObjectField<T>(raw: unknown): T | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "object") {
		if (Array.isArray(raw)) return undefined;
		return raw as T;
	}
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as T;
	} catch {
		return undefined;
	}
}

function parseTurnBudget(raw: unknown): TurnBudgetConfig | undefined {
	return parseObjectField<TurnBudgetConfig>(raw);
}

function parseToolBudget(raw: unknown): ToolBudgetConfig | undefined {
	return parseObjectField<ToolBudgetConfig>(raw);
}

function parseAcceptance(raw: unknown): string | AgentAcceptanceConfig | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string" && raw.trim()) {
		return raw.trim();
	}
	if (typeof raw === "object" && !Array.isArray(raw)) {
		return raw as AgentAcceptanceConfig;
	}
	return undefined;
}

function parseMemory(raw: unknown): AgentMemoryConfig | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const mem = raw as Record<string, unknown>;
	if (mem.scope === "project" || mem.scope === "user") {
		return { scope: mem.scope, path: String(mem.path || "") };
	}
	return undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		// Parse array/list fields (comma-separated or YAML list)
		const tools = frontmatter.tools === null ? [] : parseStringOrArray(frontmatter.tools);
		const extensions = parseStringOrArray(frontmatter.extensions);
		const subagentOnlyExtensions = parseStringOrArray(frontmatter.subagentOnlyExtensions);
		const fallbackModels = parseStringOrArray(frontmatter.fallbackModels);
		const skills = parseStringOrArray(frontmatter.skills || frontmatter.skill);
		const skillPath = parseStringOrArray(frontmatter.skillPath);
		const defaultReads = parseStringOrArray(frontmatter.defaultReads);

		// Parse mcpDirectTools from tools (mcp: prefix)
		const mcpDirectTools: string[] = [];
		if (tools) {
			const filteredTools: string[] = [];
			for (const t of tools) {
				if (t.startsWith("mcp:")) {
					mcpDirectTools.push(t.slice(4));
				} else {
					filteredTools.push(t);
				}
			}
			tools.length = 0;
			tools.push(...filteredTools);
		}

		// Parse turnBudget as JSON if it's a string
		const turnBudget = parseTurnBudget(frontmatter.turnBudget);

		// Parse toolBudget as JSON
		const toolBudget = parseToolBudget(frontmatter.toolBudget);

		// Parse acceptance - can be scalar level string or object
		const acceptance = parseAcceptance(frontmatter.acceptance);

		// Parse memory config
		const memory = parseMemory(frontmatter.memory);

		// Parse thinking - can be string or false
		let thinking: string | false | undefined;
		if (frontmatter.thinking === "false") {
			thinking = false;
		} else if (frontmatter.thinking && typeof frontmatter.thinking === "string") {
			thinking = frontmatter.thinking;
		}

		// Parse completionGuard
		let completionGuard: boolean | undefined;
		if (frontmatter.completionGuard === "false") {
			completionGuard = false;
		} else if (frontmatter.completionGuard === "true") {
			completionGuard = true;
		}

		// Parse maxSubagentDepth
		const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
		const maxSubagentDepth =
			Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
				? parsedMaxSubagentDepth
				: undefined;

		// Collect extra fields (not in KNOWN_FIELDS)
		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) {
				if (typeof value === "string") {
					extraFields[key] = value;
				} else if (value !== undefined && value !== null) {
					extraFields[key] = JSON.stringify(value);
				}
			}
		}

		agents.push({
			name: String(frontmatter.name),
			description: String(frontmatter.description),
			package: frontmatter.package ? String(frontmatter.package) : undefined,
			tools,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			extensions,
			subagentOnlyExtensions,
			model: frontmatter.model ? String(frontmatter.model) : undefined,
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			thinking,
			systemPromptMode:
				frontmatter.systemPromptMode === "append" ? "append" :
				frontmatter.systemPromptMode === "replace" ? "replace" :
				undefined,
			inheritProjectContext:
				frontmatter.inheritProjectContext === "true" ? true :
				frontmatter.inheritProjectContext === "false" ? false :
				defaultInheritProjectContext(String(frontmatter.name)),
			inheritSkills:
				frontmatter.inheritSkills === "true" ? true :
				frontmatter.inheritSkills === "false" ? false :
				false,
			defaultContext:
				frontmatter.defaultContext === "fork" ? "fork" :
				frontmatter.defaultContext === "fresh" ? "fresh" :
				undefined,
			skills: skills && skills.length > 0 ? skills : undefined,
			skillPath: skillPath && skillPath.length > 0 ? skillPath : undefined,
			output: frontmatter.output ? String(frontmatter.output) : undefined,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			async: frontmatter.async === "true",
			timeoutMs: typeof frontmatter.timeoutMs === "number" ? frontmatter.timeoutMs :
				typeof frontmatter.timeoutMs === "string" ? Number(frontmatter.timeoutMs) || undefined : undefined,
			turnBudget,
			acceptance,
			acceptanceRole:
				frontmatter.acceptanceRole === "read-only" || frontmatter.acceptanceRole === "writer"
					? frontmatter.acceptanceRole as "read-only" | "writer"
					: undefined,
			completionGuard,
			interactive: frontmatter.interactive === "true",
			maxSubagentDepth,
			toolBudget,
			memory,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export interface DiscoverAgentsOptions {
	/**
	 * Include the agents bundled with this package. Defaults to true.
	 * Set false to inspect only the agents a project/user actually authored.
	 */
	includeBuiltins?: boolean;
	/** Override the bundled agents directory. Primarily for tests. */
	builtinDir?: string;
	/**
	 * Skip loading settings from disk. Defaults to false.
	 * Set true when the caller has already resolved settings, or in tests
	 * that must not depend on the developer's own config.
	 */
	skipSettings?: boolean;
	/** Pre-resolved settings to apply instead of reading from disk. */
	settings?: AgentSettings;
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	options: DiscoverAgentsOptions = {},
): AgentDiscoveryResult {
	const { includeBuiltins = true, builtinDir = BUILTIN_AGENTS_DIR, skipSettings = false } = options;

	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Builtins ship with the package and are always in scope: `scope` selects
	// between user- and project-authored agents, not whether the package's own
	// agents exist.
	const builtinAgents = includeBuiltins ? loadAgentsFromDir(builtinDir, "builtin") : [];
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Later writes win, so insert in ascending precedence:
	// builtin < user < project.
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of builtinAgents) agentMap.set(agent.name, agent);
	if (scope === "both" || scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope === "both" || scope === "project") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	const settings = options.settings ?? (skipSettings ? undefined : loadAgentSettings(cwd));
	const discovered = Array.from(agentMap.values());
	const agents = settings ? applyAgentSettings(discovered, settings) : discovered;

	return { agents, projectAgentsDir };
}