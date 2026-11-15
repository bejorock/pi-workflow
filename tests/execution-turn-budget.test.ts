/**
 * End-to-end turn-budget backstop: exercises the actual parent-side kill
 * logic in execution.ts's turn_end handler by spawning a real fake `pi`
 * binary (same pattern as live-progress.test.ts / execution-agent-end-
 * overflow.test.ts) that emits more turn_end events than the configured
 * budget allows, simulating a model that ignored the child-side soft-block
 * (subagent-prompt-runtime.ts's registerTurnBudget) and kept calling tools.
 *
 * The child-side soft-block itself is unit-tested directly in
 * tests/subagent-prompt-runtime-budgets.test.ts (it runs *inside* the
 * spawned child process, which this file's fake binary doesn't execute —
 * only pi's real runtime does). This file tests the backstop that exists
 * for when that block is ignored or doesn't apply.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSingleAgent } from "../extensions/execution.ts";
import { classifySingleResultFailure } from "../extensions/failure-classifier.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../extensions/pi-spawn.ts";
import type { AgentConfig } from "../extensions/agents.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/tmp/worker.md",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

/**
 * Writes a fake `pi` binary that emits `turnCount` turn_end events (using
 * turnIndex, matching pi's real TurnEndEvent shape), staying alive after the
 * last one instead of exiting — simulating a child that keeps running (as a
 * runaway/looping model would) rather than naturally finishing. This is
 * essential: if the fake binary exited on its own, the race in
 * execution.ts's process-close vs backstop-kill would resolve via normal
 * exit, not via the backstop SIGTERM the test is trying to exercise.
 */
function writeRunawayPiBinary(dir: string, turnCount: number): string {
	const scriptPath = path.join(dir, "fake-pi-runaway.cjs");
	const body = `#!${process.execPath}
let i = 0;
function next() {
	if (i >= ${turnCount}) {
		// Stay alive indefinitely — a real runaway child keeps running past
		// its budget; only the parent's SIGTERM should end this process. If
		// SIGTERM/SIGKILL doesn't arrive, the test's own timeout will catch
		// a hang rather than this looping forever silently.
		return;
	}
	process.stdout.write(JSON.stringify({ type: "turn_end", turnIndex: i, message: { role: "assistant", content: [], stopReason: "end" }, toolResults: [] }) + "\\n");
	i++;
	setTimeout(next, 5);
}
next();
`;
	fs.writeFileSync(scriptPath, body, { mode: 0o755 });
	return scriptPath;
}

/** Writes a fake `pi` binary that emits a small number of turns then exits cleanly — the "healthy, within-budget" control case. */
function writeHealthyPiBinary(dir: string, turnCount: number): string {
	const scriptPath = path.join(dir, "fake-pi-healthy.cjs");
	const body = `#!${process.execPath}
let i = 0;
function next() {
	if (i >= ${turnCount}) {
		process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }) + "\\n");
		process.exit(0);
		return;
	}
	process.stdout.write(JSON.stringify({ type: "turn_end", turnIndex: i, message: { role: "assistant", content: [], stopReason: "end" }, toolResults: [] }) + "\\n");
	i++;
	setTimeout(next, 2);
}
next();
`;
	fs.writeFileSync(scriptPath, body, { mode: 0o755 });
	return scriptPath;
}

describe("turn-budget parent-side backstop (execution.ts)", () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-turn-budget-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		process.env = { ...originalEnv };
	});

	it("kills a runaway child once turnIndex+1 reaches maxTurns + graceTurns, and reports it as agent-level (routable)", async () => {
		// maxTurns: 3, graceTurns: 1 -> hard limit at 4 turns completed.
		const scriptPath = writeRunawayPiBinary(tempDir, 10); // would emit far more than 4 if not killed
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "turn-budget-backstop-1",
			turnBudget: { maxTurns: 3, graceTurns: 1 },
		});

		expect(result.turnBudgetExceeded).toBe(true);
		expect(result.error).toContain("turn budget");
		expect(result.error).toContain("4"); // hard-limit turn count in the message

		const classification = classifySingleResultFailure(result, result.exitSignal);
		expect(classification.class).toBe("agent");
		expect(classification.code).toBe("turn-budget-exceeded");
	}, 15000);

	it("does not fire the backstop for a healthy run that stays within budget", async () => {
		const scriptPath = writeHealthyPiBinary(tempDir, 2); // well under maxTurns: 10
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "turn-budget-backstop-2",
			turnBudget: { maxTurns: 10, graceTurns: 2 },
		});

		expect(result.turnBudgetExceeded).toBeUndefined();
		expect(result.exitCode).toBe(0);
	});

	it("accumulates every turn's tokens and normalizes provider cost objects", async () => {
		const binary = path.join(tempDir, "usage.cjs");
		const events = [1, 2].map(i => ({type: "turn_end", message: {role: "assistant", content: [], usage: {input: i * 10, output: i, cacheRead: i * 100, cacheWrite: i * 2, cost: {total: i * 0.1}}}}));
		events.push({type: "agent_end", messages: []} as never);
		fs.writeFileSync(binary, `#!${process.execPath}\nfor(const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`, {mode: 0o755});
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = binary;
		const result = await runSingleAgent(tempDir, makeAgent(), "usage", {runId: "usage"});
		expect(result.usage).toMatchObject({input: 30, output: 3, cacheRead: 300, cacheWrite: 6, totalTokens: 339, turns: 2, costKnown: true});
		expect(result.usage.cost).toBeCloseTo(0.3);
	});

	it("preserves required-tool preflight stderr as a technical failure with diagnostics", async () => {
		const binary = path.join(tempDir, "preflight.cjs");
		fs.writeFileSync(binary, `#!${process.execPath}\nconsole.error('Node required tools unavailable before provider request: missing');process.exit(1);`, {mode: 0o755});
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = binary;
		const result = await runSingleAgent(tempDir, makeAgent(), "preflight", {runId: "preflight"});
		expect(classifySingleResultFailure(result)).toMatchObject({class: "technical", code: "required-tools-unavailable"});
		expect(result.diagnostics).toMatchObject({phase: "provider", failureKind: "process", changeEvidence: "unknown"});
	});

	it.each(["generation", "cancelled", "provider", "process", "schema-only"])("preserves %s failure precedence when structured completion is missing", async (kind) => {
		const binary = path.join(tempDir, "missing-structured.cjs");
		const body = kind === "generation" || kind === "cancelled"
			? `console.log(JSON.stringify({type:"message_start",message:{role:"assistant",content:[]}})); setInterval(() => {}, 1000);`
			: kind === "provider"
				? `console.log(JSON.stringify({type:"error",error:"HTTP 401 unauthorized"})); process.exit(1);`
				: kind === "process" ? `console.error("Node required tools unavailable before provider request: missing"); process.exit(1);` : "process.exit(0);";
		fs.writeFileSync(binary, `#!${process.execPath}\n${body}`, {mode: 0o755});
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = binary;
		process.env.PI_WORKFLOW_GENERATION_TIMEOUT_MS = "300";
		const controller = new AbortController();
		const cancel = kind === "cancelled" ? setTimeout(() => controller.abort(), 100) : undefined;
		const result = await runSingleAgent(tempDir, makeAgent(), "complete", {
			runId: `missing-${kind}`,
			signal: controller.signal,
			structuredOutput: {schema: {type: "object"}, schemaPath: path.join(tempDir, "schema.json"), outputPath: path.join(tempDir, "result.json")},
		});
		if (cancel) clearTimeout(cancel);
		expect(result.structuredOutputFailed).toBe(true);
		expect(result.structuredOutputError).toContain("Missing structured_output call");
		if (kind === "generation") {
			expect(result.error).toContain("Model generation exceeded 300ms");
			expect(result.diagnostics?.failureKind).toBe("timeout");
			expect(classifySingleResultFailure(result)).toMatchObject({class: "agent", code: "timed-out"});
		} else if (kind === "cancelled") {
			expect(result.error).not.toBe(result.structuredOutputError);
			expect(classifySingleResultFailure(result)).toMatchObject({class: "technical", code: "aborted"});
		} else if (kind === "provider") {
			expect(classifySingleResultFailure(result)).toMatchObject({class: "technical", code: "provider-error", reason: "HTTP 401 unauthorized"});
		} else if (kind === "process") {
			expect(classifySingleResultFailure(result)).toMatchObject({class: "technical", code: "required-tools-unavailable"});
		} else {
			expect(result.error).toBe(result.structuredOutputError);
			expect(classifySingleResultFailure(result)).toMatchObject({class: "agent", code: "agent-error"});
		}
	}, 15000);

	it("applies DEFAULT_TURN_BUDGET (maxTurns: 50) when neither the call site nor agent frontmatter set one", async () => {
		const scriptPath = writeHealthyPiBinary(tempDir, 3); // well under the default of 50
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "turn-budget-default-1",
			// No turnBudget passed at all.
		});

		expect(result.turnBudgetExceeded).toBeUndefined();
		expect(result.exitCode).toBe(0);
	});

	it("normalizes an agent-frontmatter turnBudget missing graceTurns instead of producing NaN arithmetic", async () => {
		// Regression test for the bug found while wiring this feature:
		// agent.turnBudget (TurnBudgetConfig) has optional graceTurns; without
		// normalization, budget.maxTurns + budget.graceTurns would be NaN and
		// the backstop condition (turnCount >= NaN) would never be true,
		// silently disabling enforcement for any agent that only sets maxTurns.
		const scriptPath = writeRunawayPiBinary(tempDir, 10);
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "turn-budget-normalize-1",
			turnBudget: { maxTurns: 2 } as { maxTurns: number; graceTurns: number }, // graceTurns deliberately omitted
		});

		expect(result.turnBudgetExceeded).toBe(true);
		expect(result.error).not.toContain("NaN");
	}, 15000);
});
