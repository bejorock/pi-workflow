/**
 * Tests for pi-args.ts — CLI argument builder
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyThinkingSuffix,
	buildPiArgs,
	resolvePiLaunchToolPlan,
} from "../extensions/pi-args.ts";

describe("pi-args", () => {
	describe("applyThinkingSuffix", () => {
		it("should return model unchanged when thinking is falsy", () => {
			expect(applyThinkingSuffix("google/gemini", undefined)).toBe("google/gemini");
			expect(applyThinkingSuffix("google/gemini", false)).toBe("google/gemini");
			expect(applyThinkingSuffix("google/gemini", "")).toBe("google/gemini");
		});

		it("should append thinking suffix when no existing suffix", () => {
			expect(applyThinkingSuffix("google/gemini", "high")).toBe("google/gemini:high");
		});

		it("should replace existing thinking suffix when replaceExisting is true", () => {
			expect(applyThinkingSuffix("google/gemini:low", "high", true)).toBe("google/gemini:high");
		});

		it("should not duplicate thinking suffix when replaceExisting is false", () => {
			expect(applyThinkingSuffix("google/gemini:low", "high", false)).toBe("google/gemini:low");
		});

		it("should return undefined when model is undefined", () => {
			expect(applyThinkingSuffix(undefined, "high")).toBeUndefined();
		});
	});

	describe("resolvePiLaunchToolPlan", () => {
		it("isolates every child from ambient global extensions", () => {
			const plan = resolvePiLaunchToolPlan({});
			expect(plan.requestedBuiltinTools).toEqual([]);
			expect(plan.declaredBuiltinTools).toEqual([]);
			expect(plan.explicitToolAllowlist).toBe(false);
			expect(plan.fanoutAuthorized).toBe(false);
			expect(plan.disableAmbientExtensions).toBe(true);
			expect(plan.extensionArgs.some((entry) => entry.endsWith("index.ts") || entry.endsWith("index.js"))).toBe(true);
		});

		it("should handle tools array", () => {
			const plan = resolvePiLaunchToolPlan({ tools: ["read", "write", "bash"] });
			expect(plan.requestedBuiltinTools).toEqual(["read", "write", "bash"]);
			expect(plan.declaredBuiltinTools).toEqual(["read", "write", "bash"]);
			expect(plan.explicitToolAllowlist).toBe(true);
			expect(plan.effectiveToolAllowlist).toContain("read");
			expect(plan.effectiveToolAllowlist).toContain("write");
			expect(plan.effectiveToolAllowlist).toContain("bash");
		});

		it("should authorize fanout when subagent tool is present", () => {
			const plan = resolvePiLaunchToolPlan({ tools: ["read", "subagent"] });
			expect(plan.fanoutAuthorized).toBe(true);
		});

		it("should handle extensions", () => {
			const plan = resolvePiLaunchToolPlan({ extensions: ["/path/to/ext.ts"] });
			expect(plan.configuredExtensions).toContain("/path/to/ext.ts");
		});

		it("should handle subagentOnlyExtensions", () => {
			const plan = resolvePiLaunchToolPlan({ subagentOnlyExtensions: ["/path/to/sub.ts"] });
			expect(plan.configuredExtensions).toContain("/path/to/sub.ts");
		});

		it("should handle structured output", () => {
			const plan = resolvePiLaunchToolPlan({ structuredOutput: true });
			expect(plan.internalTools).toContain("structured_output");
			expect(plan.effectiveToolAllowlist).toContain("structured_output");
		});

		it("should handle capability ceiling with allowedTools", () => {
			const plan = resolvePiLaunchToolPlan({
				tools: ["read", "write", "bash", "subagent"],
				capabilityCeiling: { allowedTools: ["read", "write"], denyExtensions: false },
			});
			expect(plan.effectiveToolAllowlist).toContain("read");
			expect(plan.effectiveToolAllowlist).toContain("write");
			expect(plan.effectiveToolAllowlist).not.toContain("bash");
			expect(plan.effectiveToolAllowlist).not.toContain("subagent");
			expect(plan.fanoutAuthorized).toBe(false);
		});

		it("should handle capability ceiling with denyExtensions", () => {
			const plan = resolvePiLaunchToolPlan({
				tools: ["read"],
				extensions: ["/path/to/ext.ts"],
				capabilityCeiling: { denyExtensions: true },
			});
			expect(plan.disableAmbientExtensions).toBe(true);
			expect(plan.configuredExtensions).toEqual([]);
		});

		it("should add read tool when requireReadTool is true", () => {
			const plan = resolvePiLaunchToolPlan({
				tools: ["write"],
				requireReadTool: true,
			});
			expect(plan.declaredBuiltinTools).toContain("read");
			expect(plan.declaredBuiltinTools).toContain("write");
		});
	});

	describe("buildPiArgs", () => {
		const originalEnv = { ...process.env };

		beforeEach(() => {
			// Clean up env vars that might interfere
			delete process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1;
			delete process.env.PI_SUBAGENT_CHILD;
		});

		afterEach(() => {
			process.env = { ...originalEnv };
		});

		it("should build basic args with mode json and prompt", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "Hello world",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});

			expect(result.args).toContain("--mode");
			expect(result.args).toContain("json");
			expect(result.args).toContain("-p");
			expect(result.args).toContain("--no-session");
			expect(result.args).toContain("Task: Hello world");
		});

		it("should add --no-session when sessionEnabled is false", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--no-session");
		});

		it("should add --session when sessionFile is provided", () => {
			const tmpDir = path.join(require("node:os").tmpdir(), "pi-test-session");
			fs.mkdirSync(tmpDir, { recursive: true });
			const sessionFile = path.join(tmpDir, "session.json");

			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: true,
				sessionFile,
				inheritProjectContext: true,
				inheritSkills: true,
			});

			expect(result.args).toContain("--session");
			expect(result.args).toContain(sessionFile);

			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("should add --model when model is provided", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				model: "google/gemini",
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--model");
			expect(result.args).toContain("google/gemini");
		});

		it("should add thinking suffix to model", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				model: "google/gemini",
				thinking: "high",
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("google/gemini:high");
		});

		it("should add --tools when tools are provided", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				tools: ["read", "write"],
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--tools");
			const toolsIndex = result.args.indexOf("--tools");
			expect(result.args[toolsIndex + 1]).toContain("read");
			expect(result.args[toolsIndex + 1]).toContain("write");
			expect(result.args[toolsIndex + 1]).toContain("ask_user_question");
			expect(result.args[toolsIndex + 1]).toContain("ask_supervisor");
		});

		it("should add only internal tools when tools array is empty", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				tools: [],
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--tools");
			const toolsIndex = result.args.indexOf("--tools");
			expect(result.args[toolsIndex + 1]).toBe("ask_user_question,ask_supervisor,plan,contract,node_state");
		});

		it("should add --no-skills when inheritSkills is false", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: false,
			});
			expect(result.args).toContain("--no-skills");
		});

		it("should set PI_SUBAGENT_INHERIT_PROJECT_CONTEXT to 0 when false", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT).toBe("0");
		});

		it("should add --extension for each extension", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				extensions: ["/path/to/ext1.ts", "/path/to/ext2.ts"],
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--extension");
			expect(result.args).toContain("/path/to/ext1.ts");
			expect(result.args).toContain("/path/to/ext2.ts");
		});

		it("should add --no-extensions when extensions is empty array", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				extensions: [],
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--no-extensions");
		});

		it("disables ambient hooks but injects pi-workflow runtime extensions", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--no-extensions");
			const indexExt = result.args.some(
				(arg) => arg.endsWith("index.ts") || arg.endsWith("index.js"),
			);
			expect(indexExt).toBe(true);
			expect(result.args).toContain("--extension");
		});

		it("should inject ask_user_question and ask_supervisor into REQUIRED_CHILD_TOOLS env", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				tools: ["read", "write"],
				inheritProjectContext: true,
				inheritSkills: true,
			});
			const envVal = result.env.PI_SUBAGENT_REQUIRED_CHILD_TOOLS;
			expect(envVal).toBeDefined();
			const parsed = JSON.parse(envVal!);
			expect(parsed).toContain("ask_user_question");
			expect(parsed).toContain("ask_supervisor");
			expect(parsed).toContain("plan");
			expect(parsed).toContain("contract");
		});

		it("should write system prompt to temp file", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				systemPrompt: "You are a helpful assistant.",
				systemPromptMode: "append",
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--append-system-prompt");
			expect(result.tempDir).toBeDefined();
		});

		it("should use --system-prompt when systemPromptMode is replace", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				systemPrompt: "You are a helpful assistant.",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args).toContain("--system-prompt");
		});

		it("should use @file for long tasks", () => {
			const longTask = "A".repeat(9000);
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: longTask,
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.args.some((arg) => arg.startsWith("@"))).toBe(true);
		});

		it("should set PI_SUBAGENT_CHILD env var", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_CHILD).toBe("1");
		});

		it("should set PI_SUBAGENT_FANOUT_CHILD when fanout authorized", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				tools: ["read", "subagent"],
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_FANOUT_CHILD).toBe("1");
		});

		it("should set PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT).toBe("1");
		});

		it("should set PI_SUBAGENT_INHERIT_SKILLS", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: false,
			});
			expect(result.env.PI_SUBAGENT_INHERIT_SKILLS).toBe("0");
		});

		it("should set structured output env vars", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
				structuredOutput: {
					schema: { type: "object" },
					schemaPath: "/tmp/schema.json",
					outputPath: "/tmp/output.json",
				},
			});
			expect(result.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA).toBe("/tmp/schema.json");
			expect(result.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE).toBe("/tmp/output.json");
		});

		it("should set tool budget env var", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
				toolBudget: { hard: 50, block: ["read"] },
			});
			expect(result.env.PI_SUBAGENT_TOOL_BUDGET).toBeDefined();
			expect(JSON.parse(result.env.PI_SUBAGENT_TOOL_BUDGET!)).toEqual({ hard: 50, block: ["read"] });
		});

		it("should set turn budget env var", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
				turnBudget: { maxTurns: 50, graceTurns: 2 },
			});
			expect(result.env.PI_SUBAGENT_TURN_BUDGET).toBeDefined();
			expect(JSON.parse(result.env.PI_SUBAGENT_TURN_BUDGET!)).toEqual({ maxTurns: 50, graceTurns: 2 });
		});

		it("should not set turn budget env var when turnBudget is absent", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_TURN_BUDGET).toBeUndefined();
		});

		it("should set run ID env var", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				runId: "test-run-123",
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_RUN_ID).toBe("test-run-123");
		});

		it("should set child agent name env var", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				childAgentName: "researcher",
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_CHILD_AGENT).toBe("researcher");
		});

		it("should set child index env var", () => {
			const result = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				childIndex: 3,
				inheritProjectContext: true,
				inheritSkills: true,
			});
			expect(result.env.PI_SUBAGENT_CHILD_INDEX).toBe("3");
		});

		describe("pi-permission-system compatibility", () => {
			// @gotgenes/pi-permission-system detects "is this a subagent child?"
			// and forwards `ask` prompts to the parent session's UI by checking
			// a documented set of env vars (see SUBAGENT_ENV_HINT_KEYS and
			// SUBAGENT_PARENT_SESSION_ENV_CANDIDATES in that package). These
			// tests pin the exact contract nicobailon/pi-subagents established
			// and that pi-workflow's buildPiArgs() must keep satisfying so
			// permission forwarding keeps working for child processes.
			it("sets PI_SUBAGENT_CHILD=1 (subagent-detection env hint)", () => {
				const result = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"],
					task: "test",
					sessionEnabled: false,
					inheritProjectContext: true,
					inheritSkills: true,
				});
				expect(result.env.PI_SUBAGENT_CHILD).toBe("1");
			});

			it("sets PI_SUBAGENT_PARENT_SESSION from parentSessionId (ask-forwarding target)", () => {
				const result = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"],
					task: "test",
					sessionEnabled: false,
					inheritProjectContext: true,
					inheritSkills: true,
					parentSessionId: "session-abc-123",
				});
				expect(result.env.PI_SUBAGENT_PARENT_SESSION).toBe("session-abc-123");
			});

			it("falls back to the parent process's own PI_SUBAGENT_PARENT_SESSION when parentSessionId is not given (nested/grandchild forwarding)", () => {
				const prior = process.env.PI_SUBAGENT_PARENT_SESSION;
				process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-session-id";
				try {
					const result = buildPiArgs({
						baseArgs: ["--mode", "json", "-p"],
						task: "test",
						sessionEnabled: false,
						inheritProjectContext: true,
						inheritSkills: true,
					});
					expect(result.env.PI_SUBAGENT_PARENT_SESSION).toBe("inherited-session-id");
				} finally {
					if (prior === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
					else process.env.PI_SUBAGENT_PARENT_SESSION = prior;
				}
			});

			it("sets PI_SUBAGENT_RUN_ID and PI_SUBAGENT_CHILD_AGENT (additional env hints pi-permission-system checks)", () => {
				const result = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"],
					task: "test",
					sessionEnabled: false,
					inheritProjectContext: true,
					inheritSkills: true,
					runId: "run-xyz",
					childAgentName: "researcher",
				});
				expect(result.env.PI_SUBAGENT_RUN_ID).toBe("run-xyz");
				expect(result.env.PI_SUBAGENT_CHILD_AGENT).toBe("researcher");
			});
		});
	});
});
