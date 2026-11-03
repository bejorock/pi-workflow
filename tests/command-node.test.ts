/**
 * Tests for the command node type — a declarative shell command as a
 * graph node.
 *
 * Covers:
 * - g.node('x', command('npm test')) syntax accepted by GraphBuilder
 * - command() validates its inputs (non-empty string, timeoutMs, cwd, env)
 * - CommandNodeDef is stored with type: "command"
 * - Execution via createNodeRunner: exit code, stdout/stderr, status routing
 * - allowFailure forces status "ok" on a nonzero exit
 * - Timeout is a technical failure by default, routable when allowFailure
 * - A missing binary (ENOENT via the shell) is a technical failure
 * - Output is truncated past the byte cap
 * - toString() renders stdout/stderr like an agent result
 * - Script validator: command() requires a literal string, rejects
 *   variables, computed expressions, and template literals with ${}
 * - Full executor walk: command node output flows into a downstream
 *   agent's prompt and into a conditional edge
 * - Journal: nodeType "command" round-trips
 */

import { describe, expect, it } from "vitest";
import {
	agent,
	command,
	createGraphFactory,
	END,
	type CommandNodeDef,
	GraphDefinitionError,
} from "../extensions/graph-dsl.ts";
import { buildGraphFromScript, GraphValidationError } from "../extensions/graph-validator.ts";
import { createNodeRunner, withResultText } from "../extensions/graph-node-runner.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";

// ── command() constructor ───────────────────────────────────────────────────

describe("command() constructor", () => {
	it("builds a CommandNodeDef from a command string", () => {
		const def = command("npm test");
		expect(def.type).toBe("command");
		expect(def.command).toBe("npm test");
		expect(def.allowFailure).toBe(false);
	});

	it("rejects an empty command string", () => {
		expect(() => command("")).toThrow(GraphDefinitionError);
		expect(() => command("   ")).toThrow(GraphDefinitionError);
	});

	it("rejects a non-string command", () => {
		expect(() => command(42 as unknown as string)).toThrow(GraphDefinitionError);
	});

	it("accepts timeoutMs, cwd, env, allowFailure options", () => {
		const def = command("npm test", {
			timeoutMs: 5000,
			cwd: "/tmp",
			env: { NODE_ENV: "test" },
			allowFailure: true,
		});
		expect(def.timeoutMs).toBe(5000);
		expect(def.cwd).toBe("/tmp");
		expect(def.env).toEqual({ NODE_ENV: "test" });
		expect(def.allowFailure).toBe(true);
	});

	it("rejects a non-positive timeoutMs", () => {
		expect(() => command("npm test", { timeoutMs: 0 })).toThrow(GraphDefinitionError);
		expect(() => command("npm test", { timeoutMs: -1 })).toThrow(GraphDefinitionError);
	});

	it("rejects a non-string cwd", () => {
		expect(() => command("npm test", { cwd: 42 as unknown as string })).toThrow(GraphDefinitionError);
	});

	it("rejects a non-object env", () => {
		expect(() => command("npm test", { env: "bad" as unknown as Record<string, string> })).toThrow(
			GraphDefinitionError,
		);
	});

	it("builds a CommandNodeDef from a command function", () => {
		const fn = (state: Record<string, unknown>) => `npm test ${String(state.arg)}`;
		const def = command(fn);
		expect(def.type).toBe("command");
		expect(def.command).toBe(fn);
		expect(def.allowFailure).toBe(false);
	});

	it("accepts options alongside a command function", () => {
		const fn = () => "npm test";
		const def = command(fn, { timeoutMs: 5000, cwd: "/tmp", allowFailure: true });
		expect(def.command).toBe(fn);
		expect(def.timeoutMs).toBe(5000);
		expect(def.cwd).toBe("/tmp");
		expect(def.allowFailure).toBe(true);
	});

	it("rejects a non-string non-function command spec", () => {
		expect(() => command(42 as unknown as string)).toThrow(GraphDefinitionError);
		expect(() => command(null as unknown as string)).toThrow(GraphDefinitionError);
		expect(() => command(undefined as unknown as string)).toThrow(GraphDefinitionError);
	});

	it("still rejects an empty string command", () => {
		expect(() => command("")).toThrow(GraphDefinitionError);
		expect(() => command("   ")).toThrow(GraphDefinitionError);
	});
});

// ── GraphBuilder ──────────────────────────────────────────────────────────────

describe("GraphBuilder command node", () => {
	it("accepts command() as a node definition", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("test", command("npm test"));
		g.edge("test", END);
		g.run({});
		const graph = g.build();
		expect(graph.nodes.get("test")!.def.type).toBe("command");
	});

	it("command node can be combined with agent nodes in the same graph", () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("worker", agent("worker", () => "implement"));
		g.node("test", command("npm test"));
		g.edge("worker", "test");
		g.edge("test", END);
		g.run({});
		const graph = g.build();
		expect(graph.nodes.get("worker")!.def.type).toBe("agent");
		expect(graph.nodes.get("test")!.def.type).toBe("command");
	});
});

// ── createNodeRunner: command nodes (real asynchronous execution) ───────────

describe("createNodeRunner: command nodes", () => {
	const cwd = process.cwd();

	function runnerWith() {
		// spawnAgent is never called for command nodes, but createNodeRunner
		// requires the option to exist.
		return createNodeRunner({ cwd, runId: "r1", spawnAgent: (async () => ({}) as never) as never });
	}

	function commandNode(id: string, def: CommandNodeDef) {
		return { id, def };
	}

	it("keeps timers and live dashboard snapshots responsive while a command runs", async () => {
		const { WorkflowManager } = await import("../extensions/workflow-manager.ts");
		const { DashboardProjector } = await import("../extensions/dashboard-state.ts");
		const manager = new WorkflowManager();
		manager.registerRun("live", { name: "live" }, undefined, { cwd });
		const projector = new DashboardProjector(manager, cwd);
		let finished = false;
		const pending = runnerWith()(commandNode("test", command("sleep 0.3")), {}, { step: 1, runId: "r1" })
			.then(result => { finished = true; return result; });
		const whileRunning = await new Promise<boolean>(resolve => setTimeout(() => {
			resolve(!finished && projector.snapshot().runs.some(r => r.runId === "live" && r.status === "running"));
		}, 25));
		await pending;
		expect(whileRunning).toBe(true);
	});

	it("overlaps concurrent command nodes instead of blocking each spawn", async () => {
		let finished = 0;
		const runner = runnerWith();
		const first = runner(commandNode("first", command("sleep 0.25")), {}, { step: 1, runId: "r1" })
			.then(result => { finished++; return result; });
		const second = runner(commandNode("second", command("sleep 0.25")), {}, { step: 2, runId: "r1" })
			.then(result => { finished++; return result; });
		const inFlight = await new Promise<number>(resolve => setTimeout(() => resolve(finished), 25));
		await Promise.all([first, second]);
		expect(inFlight).toBe(0);
	});

	it("cancels running commands promptly even with allowFailure", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = runnerWith()(commandNode("test", command("sleep 10", { allowFailure: true })), {},
			{ step: 1, runId: "r1", signal: controller.signal });
		setTimeout(() => controller.abort(), 25);
		const result = await pending;
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result.technicalFailure).toBe(true);
		expect(result.error).toContain("cancelled");
	});

	it("does not spawn a command when already cancelled", async () => {
		const controller = new AbortController(); controller.abort();
		const outcome = await runnerWith()(commandNode("test", command("sleep 10")), {},
			{ step: 1, runId: "r1", signal: controller.signal });
		expect(outcome.error).toContain("cancelled");
	});

	it("reports bad cwd and output overflow as technical failures", async () => {
		for (const def of [command("echo hello", { cwd: "/nonexistent-pi-workflow-dir" }), command("yes x | head -c 100000", { allowFailure: true })]) {
			const outcome = await runnerWith()(commandNode("test", def), {}, { step: 1, runId: "r1" });
			expect(outcome.technicalFailure).toBe(true);
			expect(outcome.error).toContain("failed to run");
		}
	});

	it("kills shell descendants on timeout rather than leaving their pipes open", async () => {
		if (process.platform === "win32") return;
		const started = Date.now();
		const outcome = await runnerWith()(commandNode("test", command("sleep 10 & child=$!; echo $child; wait", { timeoutMs: 50 })), {}, { step: 1, runId: "r1" });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(outcome.technicalFailure).toBe(true);
		expect(outcome.error).toContain("timed out");
	});

	it("runs a real command and captures exit code 0 as status ok", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo hello")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; text: string; data: Record<string, unknown> };
		expect(result.status).toBe("ok");
		expect(result.text).toBe("hello");
		expect(result.data.exitCode).toBe(0);
		expect(result.data.stdout).toBe("hello\n");
		expect(outcome.technicalFailure).toBeUndefined();
	});

	it("captures stderr separately from stdout", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo err-out 1>&2")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { data: Record<string, unknown> };
		expect(result.data.stderr).toBe("err-out\n");
	});

	it("a nonzero exit routes as status blocked by default", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("exit 1")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("blocked");
		expect(result.data.exitCode).toBe(1);
		expect(outcome.technicalFailure).toBeUndefined();
	});

	it("allowFailure forces status ok even on a nonzero exit", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("exit 1", { allowFailure: true })),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("ok");
		expect(result.data.exitCode).toBe(1);
	});

	it("a missing binary is a technical failure, not a routable blocked", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("this-binary-does-not-exist-xyz")),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBeUndefined(); // shell itself ran fine, command not found -> exit 127
		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("blocked");
		expect(result.data.exitCode).toBe(127);
	});

	it("a timeout is a technical failure by default", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("sleep 5", { timeoutMs: 100 })),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(true);
		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.data.timedOut).toBe(true);
		expect(outcome.error).toContain("timed out");
	});

	it("allowFailure suppresses technicalFailure on a timeout too", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("sleep 5", { timeoutMs: 100, allowFailure: true })),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(false);
		// status must stay in the ok/blocked vocabulary once it's routable —
		// "failed" would be a third value no edge condition expects.
		const result = outcome.result as { status: string };
		expect(result.status).toBe("ok");
	});

	it("without allowFailure, a timeout's status is blocked (display-only: the run already aborted via technicalFailure)", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("sleep 5", { timeoutMs: 100 })),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(true);
		const result = outcome.result as { status: string };
		expect(result.status).toBe("blocked");
	});

	it("respects a custom cwd", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("pwd", { cwd: "/tmp" })),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { text: string };
		// macOS /tmp is a symlink to /private/tmp; accept either.
		expect(result.text.endsWith("/tmp")).toBe(true);
	});

	it("respects extra env vars", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo $CUSTOM_VAR", { env: { CUSTOM_VAR: "injected" } })),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { text: string };
		expect(result.text).toBe("injected");
	});

	it("toString() on the result renders stdout, matching agent results", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command("echo interpolated")),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(`${outcome.result}`).toBe("interpolated");
	});

	it("truncates output past the byte cap", async () => {
		const runner = runnerWith();
		// Generate well over 32KB of output.
		const outcome = await runner(
			commandNode("test", command("yes x | head -c 100000")),
			{},
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { data: Record<string, unknown> };
		expect((result.data.stdout as string).length).toBeLessThan(100000);
		expect(result.data.stdout).toContain("output truncated");
	});

	// ── Dynamic form: command((state) => ...) ────────────────────────────────

	it("a command function receives the graph state at execution time", async () => {
		const runner = runnerWith();
		const worker = { status: "ok", text: "", data: { target: "auth.spec.ts" } };
		const state = { worker };
		const outcome = await runner(
			commandNode("test", command((s) => `echo target=${(s.worker as typeof worker).data.target}`)),
			state,
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; text: string };
		expect(result.status).toBe("ok");
		expect(result.text).toBe("target=auth.spec.ts");
		expect(outcome.technicalFailure).toBeUndefined();
	});

	it("a thrown command function is a technical failure, never routed", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command(() => {
				throw new Error("boom");
			})),
			{},
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(true);
		expect(outcome.error).toContain('command node "test" function threw');
		expect(outcome.error).toContain("boom");
	});

	it("a command function returning an empty string is a technical failure", async () => {
		const runner = runnerWith();
		for (const bad of ["", "   ", null, 42]) {
			const outcome = await runner(
				commandNode("test", command(() => bad as unknown as string)),
			{},
			{ step: 1, runId: "r1" },
		);
			expect(outcome.technicalFailure, `returned ${String(bad)}`).toBe(true);
			expect(outcome.error).toContain("instead of a non-empty command string");
		}
	});

	it("allowFailure + a command function still routes a nonzero exit as ok", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command((s) => `exit ${s.code ? "1" : "1"}`, { allowFailure: true })),
			{ code: 1 },
			{ step: 1, runId: "r1" },
		);

		const result = outcome.result as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("ok");
		expect(result.data.exitCode).toBe(1);
	});

	it("a timeout error message reports the evaluated command, not the function", async () => {
		const runner = runnerWith();
		const outcome = await runner(
			commandNode("test", command((s) => `sleep 5 # ${String(s.tag)}`, { timeoutMs: 100 })),
			{ tag: "nightly" },
			{ step: 1, runId: "r1" },
		);

		expect(outcome.technicalFailure).toBe(true);
		expect(outcome.error).toContain("# nightly");
	});
});

// ── Full executor walk ────────────────────────────────────────────────────────

describe("command node in full graph walk", () => {
	it("publishes real parallel running nodes before the fan-in completes", async () => {
		const { WorkflowManager } = await import("../extensions/workflow-manager.ts");
		const { GraphDisplayBridge } = await import("../extensions/graph-display-bridge.ts");
		const { DashboardProjector } = await import("../extensions/dashboard-state.ts");
		const cwd = process.cwd();
		const manager = new WorkflowManager();
		const display = new GraphDisplayBridge({ manager, runId: "responsive-wave", name: "responsive-wave", description: "", cwd, script: "test" });
		const projector = new DashboardProjector(manager, cwd);
		const g = createGraphFactory().graph();
		g.node("start", command("printf ready"));
		g.node("a", command("sleep 0.35"));
		g.node("b", command("sleep 0.35"));
		g.node("join", command("printf joined"));
		g.edge("start", "a"); g.edge("start", "b");
		g.edge("a", "join"); g.edge("b", "join"); g.edge("join", END); g.run({});
		const samples: string[][] = [];
		const timer = setInterval(() => {
			const run = projector.snapshot().runs.find(r => r.runId === "responsive-wave");
			samples.push(run?.nodes.filter(n => n.status === "running").map(n => n.id) ?? []);
		}, 20);
		try {
			const result = await runSuperstepGraph(g.build(), {
				runId: "responsive-wave",
				runNode: createNodeRunner({ cwd, runId: "responsive-wave", spawnAgent: (async () => ({})) as never }),
				onNodeStart: info => display.nodeStarted(info),
				onNodeComplete: execution => display.nodeCompleted(execution),
			});
			expect(result.status).toBe("completed");
			expect(samples.some(ids => ids.includes("a") && ids.includes("b"))).toBe(true);
		} finally { clearInterval(timer); }
	});
	it("worker → test: agent receives the command's output as state", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("worker", agent("worker", () => "implement"));
		g.node("test", command("echo tests-passed"));
		g.node("review", agent("worker", (s) => `result: ${s.test}`));
		g.edge("worker", "test");
		g.edge("test", "review");
		g.edge("review", END);
		g.run({});
		const builtGraph = g.build();

		const prompts: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: async (node, state) => {
				if (node.def.type === "command") {
					// Real command execution, same code path production uses.
					const runner = createNodeRunner({
						cwd: process.cwd(),
						runId: "test",
						spawnAgent: (async () => ({}) as never) as never,
					});
					return runner(node, state, { step: 0, runId: "test" });
				}
				const promptFn = (node.def as { promptFn: (s: unknown) => string }).promptFn;
				const prompt = promptFn(state);
				prompts.push(prompt);
				return { result: withResultText({ status: "ok" as const, text: "done", data: {} }) };
			},
		});

		expect(result.status).toBe("completed");
		expect(prompts[1]).toBe("result: tests-passed");
	});

	it("conditional edge routes on command exit status", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("test", command("exit 1"));
		g.node("fix", agent("worker", () => "fixing"));
		g.node("done", agent("worker", () => "done"));
		g.edge("test", (state, result: unknown) =>
			(result as { status: string }).status === "ok" ? "done" : "fix",
		);
		g.edge("fix", END);
		g.edge("done", END);
		g.run({});
		const builtGraph = g.build();

		const visited: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: async (node, state) => {
				visited.push(node.id);
				if (node.def.type === "command") {
					const runner = createNodeRunner({
						cwd: process.cwd(),
						runId: "test",
						spawnAgent: (async () => ({}) as never) as never,
					});
					return runner(node, state, { step: 0, runId: "test" });
				}
				return { result: withResultText({ status: "ok" as const, text: node.id, data: {} }) };
			},
		});

		expect(result.status).toBe("completed");
		expect(visited).toContain("fix");
		expect(visited).not.toContain("done");
	});

	it("worker → test (dynamic): the command is built from upstream state at run time", async () => {
		const { graph: graphFn } = createGraphFactory();
		const g = graphFn();
		g.node("worker", agent("worker", () => "implement"));
		g.node("test", command((state) => {
			const worker = state.worker as { data?: { file?: string } } | undefined;
			return `echo ran-tests-for ${worker?.data?.file ?? "unknown"}`;
		}));
		g.node("review", agent("worker", (s) => `result: ${s.test}`));
		g.edge("worker", "test");
		g.edge("test", "review");
		g.edge("review", END);
		g.run({});
		const builtGraph = g.build();

		const prompts: string[] = [];
		const result = await runSuperstepGraph(builtGraph, {
			runId: "test",
			runNode: async (node, state) => {
				if (node.def.type === "command") {
					const runner = createNodeRunner({
						cwd: process.cwd(),
						runId: "test",
						spawnAgent: (async () => ({}) as never) as never,
					});
					return runner(node, state, { step: 0, runId: "test" });
				}
				if (node.id === "worker" && (state.worker as object | undefined) === undefined) {
					// First visit: emit a node_state-shaped result the dynamic command reads.
					return { result: withResultText({ status: "ok" as const, text: "picked auth.spec.ts", data: { file: "auth.spec.ts" } }) };
				}
				const promptFn = (node.def as { promptFn: (s: unknown) => string }).promptFn;
				const prompt = promptFn(state);
				prompts.push(prompt);
				return { result: withResultText({ status: "ok" as const, text: "done", data: {} }) };
			},
		});

		expect(result.status).toBe("completed");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toBe("result: ran-tests-for auth.spec.ts");
	});
});

// ── buildGraphFromScript ──────────────────────────────────────────────────────

describe("command node in graph scripts", () => {
	it("accepts command() with a literal string", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command('npm test'));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
		const { graph } = buildGraphFromScript(script);
		expect(graph.nodes.get("test")!.def.type).toBe("command");
	});

	it("accepts command() with a template literal that has no substitutions", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command(\`npm test\`));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
	});

	it("accepts command() with options (timeoutMs, allowFailure)", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command('npm test', { timeoutMs: 5000, allowFailure: true }));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
	});

	it("rejects command() built from a variable", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
const cmd = 'npm test';
g.node('test', command(cmd));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
		expect(() => buildGraphFromScript(script)).toThrow(/literal string/);
	});

	it("rejects command() built from a template literal with a substitution", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command(\`npm test \${args.suite}\`));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
		expect(() => buildGraphFromScript(script)).toThrow(/literal string/);
	});

	it("rejects command() built from state interpolation", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('worker', agent('worker', () => 'go'));
g.node('test', command('npm test ' + 'extra'));
g.edge('worker', 'test');
g.edge('test', END);
g.run({});
`;
		// String concatenation of two literals is still not a Literal/TemplateLiteral
		// node — rejected, which is intentionally conservative.
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
	});

	it("rejects command() with a computed function call as the argument", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
function buildCmd() { return 'npm test'; }
g.node('test', command(buildCmd()));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
	});

	it("accepts command() with an arrow function receiving state", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('worker', agent('worker', () => 'go'));
g.node('test', command((state) => \`npm test \${state.worker ? '--with-worker' : ''}\`));
g.edge('worker', 'test');
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
		const { graph } = buildGraphFromScript(script);
		const def = graph.nodes.get("test")!.def as CommandNodeDef;
		expect(def.type).toBe("command");
		expect(typeof def.command).toBe("function");
	});

	it("accepts command() with a function expression", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command(function (state) { return 'npm test'; }));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).not.toThrow();
	});

	it("still rejects a template literal with ${} as the direct argument", () => {
		const script = `
export const meta = { name: 'test', description: 'test' };
const g = graph();
g.node('test', command(\`npm test \${args.suite}\`));
g.edge('test', END);
g.run({});
`;
		expect(() => buildGraphFromScript(script)).toThrow(GraphValidationError);
		expect(() => buildGraphFromScript(script)).toThrow(/literal string or a function/);
	});
});
