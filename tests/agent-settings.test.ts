import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyAgentOverride,
	applyAgentSettings,
	loadAgentSettings,
	PROJECT_SETTINGS_RELATIVE_PATH,
} from "../extensions/agent-settings.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import { discoverAgents } from "../extensions/agents.ts";

function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: `# ${name}\n\nOriginal body.`,
		source: "builtin",
		filePath: `/fake/${name}.md`,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

describe("applyAgentOverride", () => {
	it("patches only the fields present in the override", () => {
		const agent = makeAgent("green", { model: "sonnet", tools: ["read", "write"] });
		const result = applyAgentOverride(agent, { model: "opus" });

		expect(result.model).toBe("opus");
		expect(result.tools).toEqual(["read", "write"]);
		expect(result.description).toBe("green description");
	});

	it("replaces the system prompt when systemPrompt is given", () => {
		const agent = makeAgent("green");
		const result = applyAgentOverride(agent, { systemPrompt: "Replaced entirely." });

		expect(result.systemPrompt).toBe("Replaced entirely.");
	});

	it("appends to the system prompt when systemPromptAppend is given", () => {
		const agent = makeAgent("green");
		const result = applyAgentOverride(agent, { systemPromptAppend: "House rule: use tabs." });

		expect(result.systemPrompt).toContain("Original body.");
		expect(result.systemPrompt).toContain("House rule: use tabs.");
		expect(result.systemPrompt.indexOf("Original body.")).toBeLessThan(
			result.systemPrompt.indexOf("House rule"),
		);
	});

	it("applies append after replace when both are given", () => {
		const agent = makeAgent("green");
		const result = applyAgentOverride(agent, {
			systemPrompt: "Base.",
			systemPromptAppend: "Extra.",
		});

		expect(result.systemPrompt).toBe("Base.\n\nExtra.");
	});

	it("does not mutate the input agent", () => {
		const agent = makeAgent("green", { model: "sonnet" });
		applyAgentOverride(agent, { model: "opus", systemPromptAppend: "x" });

		expect(agent.model).toBe("sonnet");
		expect(agent.systemPrompt).toBe("# green\n\nOriginal body.");
	});

	it("overrides budgets and acceptance", () => {
		const agent = makeAgent("green", { turnBudget: { maxTurns: 25, graceTurns: 4 } });
		const result = applyAgentOverride(agent, {
			turnBudget: { maxTurns: 5 },
			acceptance: { level: "strict" },
			acceptanceRole: "read-only",
		});

		expect(result.turnBudget).toEqual({ maxTurns: 5 });
		expect(result.acceptance).toEqual({ level: "strict" });
		expect(result.acceptanceRole).toBe("read-only");
	});
});

describe("applyAgentSettings", () => {
	const roster = [
		makeAgent("planner"),
		makeAgent("green"),
		makeAgent("custom", { source: "project" }),
	];

	it("returns the roster unchanged when there are no settings", () => {
		expect(applyAgentSettings(roster, {})).toHaveLength(3);
	});

	it("drops an agent marked disabled", () => {
		const result = applyAgentSettings(roster, { agents: { green: { disabled: true } } });

		expect(result.map((a) => a.name)).toEqual(["planner", "custom"]);
	});

	it("drops every builtin when disableBuiltins is set, keeping project agents", () => {
		const result = applyAgentSettings(roster, { disableBuiltins: true });

		expect(result.map((a) => a.name)).toEqual(["custom"]);
	});

	it("applies overrides to non-builtin agents too", () => {
		const result = applyAgentSettings(roster, {
			agents: { custom: { description: "patched" } },
		});

		expect(result.find((a) => a.name === "custom")!.description).toBe("patched");
	});

	it("ignores overrides naming an agent that does not exist", () => {
		const result = applyAgentSettings(roster, {
			agents: { nonexistent: { disabled: true } },
		});

		expect(result).toHaveLength(3);
	});
});

describe("loadAgentSettings", () => {
	let tempDir: string;
	let userSettingsPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-settings-"));
		fs.mkdirSync(path.join(tempDir, ".pi-workflow"), { recursive: true });
		userSettingsPath = path.join(tempDir, "user-settings.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProjectSettings(value: unknown): void {
		fs.writeFileSync(
			path.join(tempDir, PROJECT_SETTINGS_RELATIVE_PATH),
			typeof value === "string" ? value : JSON.stringify(value),
		);
	}

	it("returns empty settings when no files exist", () => {
		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.sources).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.agents).toEqual({});
	});

	it("loads project settings", () => {
		writeProjectSettings({ agents: { green: { model: "opus" } } });

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.agents!.green.model).toBe("opus");
		expect(result.sources).toHaveLength(1);
	});

	it("copies blankStopGuard through the merge loop", () => {
		writeProjectSettings({ blankStopGuard: false });

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		// The merge loop must copy this field explicitly — adding it to the
		// interface alone silently drops it, which would make the toggle a
		// no-op that looks shipped.
		expect(result.blankStopGuard).toBe(false);
	});

	it("resolves blankStopGuard as undefined when no file sets it", () => {
		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.blankStopGuard).toBeUndefined();
	});

	it("merges user and project settings per-agent, project winning", () => {
		fs.writeFileSync(
			userSettingsPath,
			JSON.stringify({ agents: { green: { model: "sonnet", timeoutMs: 1000 } } }),
		);
		writeProjectSettings({ agents: { green: { model: "opus" } } });

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		// Project overrides model but does not clobber the user's timeoutMs.
		expect(result.agents!.green.model).toBe("opus");
		expect(result.agents!.green.timeoutMs).toBe(1000);
	});

	it("keeps agents from both scopes", () => {
		fs.writeFileSync(userSettingsPath, JSON.stringify({ agents: { planner: { model: "haiku" } } }));
		writeProjectSettings({ agents: { green: { model: "opus" } } });

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(Object.keys(result.agents!).sort()).toEqual(["green", "planner"]);
	});

	it("reports malformed JSON as an error instead of throwing", () => {
		writeProjectSettings("{ not valid json");

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain("invalid JSON");
	});

	it("rejects a non-object top level", () => {
		writeProjectSettings([1, 2, 3]);

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.errors[0].message).toContain("expected a JSON object");
	});

	it("tolerates an empty file", () => {
		writeProjectSettings("");

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.errors).toEqual([]);
	});

	it("ignores a malformed per-agent override without discarding valid siblings", () => {
		writeProjectSettings({ agents: { green: "not-an-object", planner: { model: "opus" } } });

		const result = loadAgentSettings(tempDir, { userSettingsPath });

		expect(result.agents!.green).toBeUndefined();
		expect(result.agents!.planner.model).toBe("opus");
	});
});

describe("discoverAgents with settings", () => {
	let tempDir: string;
	let builtinDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-discover-settings-"));
		builtinDir = path.join(tempDir, "fake-builtins");
		fs.mkdirSync(builtinDir, { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi-workflow"), { recursive: true });

		for (const name of ["planner", "green"]) {
			fs.writeFileSync(
				path.join(builtinDir, `${name}.md`),
				`---\nname: ${name}\ndescription: builtin ${name}\n---\n\n# ${name}\n\nA prompt body long enough to matter.\n`,
			);
		}
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("honours a disabled builtin from project settings", () => {
		fs.writeFileSync(
			path.join(tempDir, PROJECT_SETTINGS_RELATIVE_PATH),
			JSON.stringify({ agents: { green: { disabled: true } } }),
		);

		const { agents } = discoverAgents(tempDir, "project", { builtinDir });

		expect(agents.map((a) => a.name)).toEqual(["planner"]);
	});

	it("honours a field override from project settings", () => {
		fs.writeFileSync(
			path.join(tempDir, PROJECT_SETTINGS_RELATIVE_PATH),
			JSON.stringify({ agents: { green: { model: "opus", systemPromptAppend: "Use tabs." } } }),
		);

		const { agents } = discoverAgents(tempDir, "project", { builtinDir });
		const green = agents.find((a) => a.name === "green")!;

		expect(green.model).toBe("opus");
		expect(green.systemPrompt).toContain("Use tabs.");
	});

	it("honours disableBuiltins", () => {
		fs.writeFileSync(
			path.join(tempDir, PROJECT_SETTINGS_RELATIVE_PATH),
			JSON.stringify({ disableBuiltins: true }),
		);

		const { agents } = discoverAgents(tempDir, "project", { builtinDir });

		expect(agents).toHaveLength(0);
	});

	it("skips settings entirely when skipSettings is set", () => {
		fs.writeFileSync(
			path.join(tempDir, PROJECT_SETTINGS_RELATIVE_PATH),
			JSON.stringify({ disableBuiltins: true }),
		);

		const { agents } = discoverAgents(tempDir, "project", { builtinDir, skipSettings: true });

		expect(agents).toHaveLength(2);
	});

	it("accepts pre-resolved settings without reading from disk", () => {
		const { agents } = discoverAgents(tempDir, "project", {
			builtinDir,
			settings: { agents: { planner: { disabled: true } } },
		});

		expect(agents.map((a) => a.name)).toEqual(["green"]);
	});
});
