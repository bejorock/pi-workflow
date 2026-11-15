import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildPiArgs } from "../extensions/pi-args.ts";
import { readChildToolAllowlist } from "../extensions/tool-availability.ts";

const sessions: AgentSession[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** A real SDK child lifecycle, including production extension registration,
 * session_start activation, before_agent_start restoration, and tool_call hooks.
 * No provider request or credentials are needed. */
async function startChild(tools?: string[], structured = false) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-policy-test-"));
	dirs.push(cwd);
	const schemaPath = path.join(cwd, "schema.json");
	fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: {}, additionalProperties: false }));
	const launch = buildPiArgs({
		baseArgs: [], task: "test", sessionEnabled: false,
		inheritProjectContext: false, inheritSkills: false,
		tools, extensions: [], cwd,
		...(structured ? { structuredOutput: { schema: { type: "object" }, schemaPath, outputPath: path.join(cwd, "output.json") } } : {}),
	});
	if (launch.tempDir) dirs.push(launch.tempDir);
	for (const [key, value] of Object.entries(launch.env)) vi.stubEnv(key, value);
	const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [
			path.resolve("extensions/subagent-prompt-runtime.ts"),
			path.resolve("extensions/index.ts"),
		],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, resourceLoader: loader, settingsManager,
		sessionManager: SessionManager.inMemory(cwd), tools: structured ? [...(tools ?? []), "structured_output"] : tools,
	});
	sessions.push(session);
	await session.bindExtensions({ mode: "rpc" });
	return { session, launch };
}

describe("real child tool allowlists", () => {
	it.each([
		["ordinary restricted tools", ["grep", "bash", "ls"]],
		["explicit question and artifact tools", ["grep", "ask_supervisor", "ask_user_question", "plan", "contract", "node_state"]],
		["no tools", []],
	] as const)("keeps %s authoritative after startup and mode changes", async (_name, names) => {
		const tools: string[] = [...names];
		const { session, launch } = await startChild(tools);
		expect(session.getActiveToolNames().sort()).toEqual([...tools].sort());
		// Simulate a later extension or mode change trying to widen model access.
		session.setActiveToolsByName([...tools, "ask_supervisor", "ask_user_question", "plan", "contract", "node_state", "workflow"]);
		for (const toolName of ["ask_supervisor", "ask_user_question", "plan", "contract", "node_state", "workflow"]) {
			const result = await session.extensionRunner.emitToolCall({
				type: "tool_call", toolCallId: "policy-check", toolName, input: {},
			});
			if (tools.includes(toolName)) expect(result?.block, toolName).not.toBe(true);
			else expect(result, toolName).toMatchObject({ block: true });
		}
		await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "test" }, { cwd: process.cwd() });
		expect(session.getActiveToolNames().sort()).toEqual([...tools].sort());
		await session.extensionRunner.emit({ type: "agent_start" });
		if (launch.toolDiagnosticPath) {
			expect(JSON.parse(fs.readFileSync(launch.toolDiagnosticPath, "utf8"))).toEqual({ available: expect.arrayContaining(tools), missing: [] });
		}
	}, 30_000);

	it("adds only the requested structured output completion protocol to an empty list", async () => {
		const { session } = await startChild([], true);
		expect(session.getActiveToolNames()).toEqual(["structured_output"]);
		const result = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "output", toolName: "structured_output", input: { value: {} } });
		expect(result?.block).not.toBe(true);
	});

	it("retains default workflow tools when tools is omitted", async () => {
		const { session } = await startChild();
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "ask_supervisor", "ask_user_question", "plan", "contract", "node_state"]));
	});

	it("ignores a parent's policy outside a child and rejects malformed child policy", () => {
		vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
		vi.stubEnv("PI_SUBAGENT_TOOL_ALLOWLIST", '["read"]');
		expect(readChildToolAllowlist()).toBeUndefined();
		vi.stubEnv("PI_SUBAGENT_CHILD", "1");
		vi.stubEnv("PI_SUBAGENT_TOOL_ALLOWLIST", '{"bad":true}');
		expect(() => readChildToolAllowlist()).toThrow("Invalid PI_SUBAGENT_TOOL_ALLOWLIST");
	});
});
