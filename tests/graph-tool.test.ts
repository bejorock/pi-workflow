import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { runGraphTool } from "./helpers/run-graph-tool.ts";
import { listGraphRuns } from "../extensions/graph-journal.ts";
import { RequestBroker } from "../extensions/request-broker.ts";
import { trackDetached } from "./helpers/detached.ts";

const META = `export const meta = { name: "test_graph", description: "a test graph" };`;

function reply(text: string) {
	return {
		agent: "x",
		task: "t",
		exitCode: 0,
		usage: { totalTokens: 10 },
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
	};
}

/** Reads the text the model actually receives from the tool call itself. */
function textOf(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
	return (content ?? []).map((part) => part.text ?? "").join("\n");
}

describe("graph workflow tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-graph-tool-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Runs the tool, normalising a thrown failure into a result shape.
	 *
	 * The agent loop marks a tool call failed only when execute() throws — a
	 * returned isError field is ignored — so hard failures throw. Tests assert
	 * on `failed` rather than on a returned flag that the runtime never reads.
	 */
	async function run(script: string, params: Record<string, unknown> = {}, spawn = vi.fn()) {
		const outcome = await runGraphTool(
			{ script, ...params },
			{ cwd: tempDir, spawnAgent: spawn as never },
		);
		return {
			failed: outcome.failed,
			result: outcome.receipt,
			text: outcome.text,
			details: outcome.details,
			receiptText: textOf(outcome.receipt),
		};
	}

	const LINEAR = `${META}
const g = graph();
g.node("plan", agent("planner", (s) => "Plan: " + s.task));
g.node("build", agent("green", (s) => "Build:\\n" + s.plan));
g.edge("plan", "build");
g.edge("build", END);
g.run({ task: args.task });
`;

	describe("validation", () => {
		it("rejects args that are not an object, before building anything", async () => {
			const spawn = vi.fn();
			const script = `${META}
const g = graph();
g.node("a", (s) => "ok");
g.edge("a", END);
g.run({});
`;

			const badArgs: unknown[] = [
				"not json at all", // invalid JSON — no recovery possible
				'"just a string"', // valid JSON, but decodes to a string, not an object
				"[1,2,3]", // valid JSON, decodes to an array
				"null", // valid JSON, decodes to null
				1,
				false,
				null,
				["a", "b"],
			];

			for (const bad of badArgs) {
				const result = await run(script, { args: bad }, spawn);
				expect(result.failed).toBe(true);
				expect(result.text).toMatch(/args must be an object of key\/value pairs/);
				expect(result.text).toMatch(/not a JSON string, number, boolean, array, or null/);
			}

			// The point of validating first: a bad args call costs nothing.
			expect(spawn).not.toHaveBeenCalled();
		});

		it("names the received type in the error for each rejected shape", async () => {
			const script = `${META}
const g = graph();
g.node("a", (s) => "ok");
g.edge("a", END);
g.run({});
`;
			const cases: Array<[unknown, RegExp]> = [
				["not json at all", /string that is not valid JSON/],
				["[1,2,3]", /decodes to an array/],
				["null", /decodes to null/],
				['"hi"', /decodes to a string/],
				[1, /received a number/],
				[false, /received a boolean/],
				[null, /received null/],
				[["a"], /received an array/],
			];
			for (const [bad, pattern] of cases) {
				const result = await run(script, { args: bad }, vi.fn());
				expect(result.failed).toBe(true);
				expect(result.text).toMatch(pattern);
			}
		});

		it("recovers args sent as a JSON string that decodes to a plain object", async () => {
			// The exact production failure shape this guard was built to catch —
			// but recoverable, unlike genuinely malformed input: a JSON-encoded
			// object round-trips losslessly, so this decodes rather than rejects.
			const spawn = vi
				.fn()
				.mockResolvedValue({ exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], durationMs: 1 });
			const script = `${META}
const g = graph();
g.node("a", (s) => "case=" + args.caseId);
g.edge("a", END);
g.run({});
`;
			const result = await run(script, { args: '{"caseId": "8907"}' }, spawn);
			expect(result.failed).toBe(false);
			// The tool must warn this happened rather than staying silent about
			// it, in the call-time receipt text (the report that lands later
			// once the run finishes has no reason to repeat it).
			expect(result.receiptText).toMatch(/arrived as a JSON string/);
			expect(
				(result.result?.details as { argsWasDecodedFromString?: boolean } | undefined)?.argsWasDecodedFromString,
			).toBe(true);
		});

		it("accepts args as an object and as undefined (omitted)", async () => {
			const script = `${META}
const g = graph();
g.node("a", (s) => "ok");
g.edge("a", END);
g.run({});
`;
			// Object with mixed value types must pass validation.
			const withObject = await run(script, { args: { name: "john", age: 13, is_active: true } }, vi.fn());
			expect(withObject.failed).toBe(false);

			// Omitted args stays valid (the schema marks it optional).
			const omitted = await run(script, {}, vi.fn());
			expect(omitted.failed).toBe(false);
		});
		it("rejects a script that reaches for the filesystem, without spawning anything", async () => {
			const spawn = vi.fn();
			const result = await run(`${META}\nconst fs = require("fs");`, {}, spawn);

			expect(result.failed).toBe(true);
			expect(result.text).toMatch(/not available in a graph script/);
			// The point of validating first: a bad script costs nothing.
			expect(spawn).not.toHaveBeenCalled();
		});

		it("rejects a dangling edge before running", async () => {
			const spawn = vi.fn();
			const script = `${META}
const g = graph();
g.node("a", agent("planner", () => "go"));
g.edge("a", "nonexistent");
g.run();
`;
			const result = await run(script, {}, spawn);

			expect(result.failed).toBe(true);
			expect(result.text).toMatch(/undefined node/);
			expect(spawn).not.toHaveBeenCalled();
		});

		it("includes the agent roster when a script fails validation", async () => {
			// The most likely reason a graph fails is naming an agent that does
			// not exist, so the reply should say which ones do.
			const result = await run(`${META}\nconst x = process.env;`);

			expect(result.text).toMatch(/Available agents/);
			expect(result.text).toMatch(/planner/);
		});

		it("rejects a missing meta header", async () => {
			const result = await run(`const g = graph();`);

			expect(result.failed).toBe(true);
			expect(result.text).toMatch(/must be the first statement/);
		});
	});

	describe("execution", () => {
		it("runs a linear graph and reports the path", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const result = await run(LINEAR, { args: { task: "ship" } }, spawn);

			expect(result.failed).toBe(false);
			expect(result.text).toContain("completed in 2 node executions across 2 rounds");
			expect(result.text).toContain("Path: plan -> build -> END");
			expect(spawn).toHaveBeenCalledTimes(2);
		});

		it("passes args into the graph", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			await run(LINEAR, { args: { task: "add auth" } }, spawn);

			expect(spawn.mock.calls[0][2]).toBe("Plan: add auth");
		});

		it("feeds each node's result to the next", async () => {
			const spawn = vi
				.fn()
				.mockResolvedValueOnce(reply("PLAN TEXT"))
				.mockResolvedValueOnce(reply("BUILT"));

			await run(LINEAR, { args: { task: "t" } }, spawn);

			// The second agent's prompt must contain the first agent's output.
			expect(spawn.mock.calls[1][2]).toContain("PLAN TEXT");
		});

		it("returns structured details for programmatic use", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const result = await run(LINEAR, { args: { task: "t" } }, spawn);
			const details = result.details as { status: string; path: string[]; runId: string };

			expect(details.status).toBe("completed");
			expect(details.path).toEqual(["plan", "build"]);
			expect(details.runId).toMatch(/^graph-/);
		});

		it("reports an unknown agent as an error naming it", async () => {
			const script = `${META}
const g = graph();
g.node("a", agent("does_not_exist", () => "go"));
g.edge("a", END);
g.run();
`;
			const result = await run(script);

			// The roster is checked before the run detaches, so a misspelled
			// agent still fails the tool call itself — the model finds out while
			// it can still fix the script, rather than in a later message.
			expect(result.failed).toBe(true);
			expect(result.text).toMatch(/Unknown agent "does_not_exist"/);
		});

		it("stops at the iteration cap and says so", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("again"));
			const script = `${META}
const g = graph();
g.node("loop", agent("worker", () => "go"));
g.edge("loop", () => "loop");
g.run();
`;
			const result = await run(script, { maxIterations: 3 }, spawn);

			expect(result.text).toContain("stopped at the round cap");
			expect(spawn).toHaveBeenCalledTimes(3);
		});
	});

	describe("escalation reporting", () => {
		it("surfaces a blocked agent rather than burying it in the walk", async () => {
			// A blocked agent is the signal the whole design exists to produce:
			// it means an agent hit a wall and said so instead of faking.
			const spawn = vi
				.fn()
				.mockResolvedValueOnce(reply("Contract v1"))
				.mockResolvedValueOnce(
					reply("STATUS: blocked\nBLOCKED_ON: contract\nREASON: cannot express soft-delete"),
				);

			const script = `${META}
const g = graph();
g.node("architect", agent("architect", () => "design"));
g.node("green", agent("green", (s) => "implement " + s.architect));
g.edge("architect", "green");
g.edge("green", END);
g.run();
`;
			const result = await run(script, {}, spawn);

			expect(result.text).toContain("Escalations reported:");
			expect(result.text).toContain("blocked on: contract");
			expect(result.text).toContain("cannot express soft-delete");
		});

		it("routes a blocker back and shows the loop in the path", async () => {
			const spawn = vi
				.fn()
				.mockResolvedValueOnce(reply("Contract v1"))
				.mockResolvedValueOnce(reply("STATUS: blocked\nBLOCKED_ON: contract"))
				.mockResolvedValueOnce(reply("Contract v2"))
				.mockResolvedValueOnce(reply("Implemented."));

			const script = `${META}
const g = graph();
g.node("architect", agent("architect", () => "design"));
g.node("green", agent("green", (s) => "implement " + s.architect));
g.edge("architect", "green");
g.edge("green", (state, result) => result.status === "blocked" ? "architect" : END);
g.run();
`;
			const result = await run(script, {}, spawn);

			expect(result.text).toContain(
				"Path: architect -> green -> architect -> green -> END",
			);
			// The retry saw the revised contract.
			expect(spawn.mock.calls[3][2]).toContain("Contract v2");
		});
	});

	describe("budget", () => {
		it("reports a budget warning without killing the run", async () => {
			const spawn = vi.fn().mockResolvedValue({
				...reply("done"),
				usage: { totalTokens: 900 },
			});

			const result = await run(LINEAR, { args: { task: "t" }, tokenBudget: 1000 }, spawn);

			expect(result.text).toMatch(/Token budget/);
			expect(result.text).toContain("Final token usage: 1800/1000 tokens.");
			// Tracked, not enforced: both nodes still ran.
			expect(spawn).toHaveBeenCalledTimes(2);
			expect(result.text).toContain("completed");
		});

		it("stays quiet when within budget", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const result = await run(LINEAR, { args: { task: "t" }, tokenBudget: 100000 }, spawn);

			expect(result.text).not.toMatch(/Token budget/);
		});
	});

	describe("journaling and resume", () => {
		it("journals the run so it can be listed", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			await run(LINEAR, { args: { task: "t" } }, spawn);

			const runs = listGraphRuns(path.join(tempDir, ".pi-workflow", "runs"));
			expect(runs).toHaveLength(1);
			expect(runs[0].name).toBe("test_graph");
			expect(runs[0].status).toBe("completed");
		});

		it("resumes a failed run without repeating completed nodes", async () => {
			const failing = vi
				.fn()
				.mockResolvedValueOnce(reply("PLAN OK"))
				.mockRejectedValueOnce(new Error("spawn exploded"));

			const first = await run(LINEAR, { args: { task: "t" } }, failing);
			expect(first.details?.status).toBe("aborted");
			// A failed run reports its id as resumable in the message itself,
			// which is the only way a caller learns it — so read it from there
			// rather than from details, exercising the affordance.
			const runId = /Run ID: (\S+)/.exec(first.text)?.[1];
			expect(runId, "failed run must report a resumable run id").toBeTruthy();

			const retry = vi.fn().mockResolvedValue(reply("BUILT"));
			const second = await run(LINEAR, { args: { task: "t" }, resumeRunId: runId }, retry);

			expect(second.text).toContain("completed");
			// Only the failed node re-ran.
			expect(retry).toHaveBeenCalledTimes(1);
			expect(retry.mock.calls[0][2]).toContain("PLAN OK");
		});

		it("refuses to resume when the script changed", async () => {
			const spawn = vi.fn().mockRejectedValue(new Error("boom"));
			const first = await run(LINEAR, { args: { task: "t" } }, spawn);
			const runId = /Run ID: (\S+)/.exec(first.text)?.[1];

			const changed = LINEAR.replace("Plan: ", "Plan v2: ");
			const second = await run(changed, { args: { task: "t" }, resumeRunId: runId }, vi.fn());

			expect(second.failed).toBe(true);
			expect(second.text).toMatch(/script changed/);
		});

		it("reports when there is nothing to resume", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const first = await run(LINEAR, { args: { task: "t" } }, spawn);
			const runId = (first.details as { runId: string }).runId;

			const second = await run(LINEAR, { args: { task: "t" }, resumeRunId: runId }, vi.fn());

			expect(second.text).toMatch(/already completed/);
		});

		it("reports a missing run rather than starting a fresh one", async () => {
			const spawn = vi.fn();
			const result = await run(LINEAR, { args: { task: "t" }, resumeRunId: "nope" }, spawn);

			expect(result.failed).toBe(true);
			expect(spawn).not.toHaveBeenCalled();
		});
	});

	describe("interactive nodes", () => {
		it("calls the broker when one is supplied", async () => {
			const broker = new RequestBroker({ coalesceMs: 0 });
			broker.start(50);
			broker.onBatch((batch) => {
				broker.resolve(batch[0].id, {
					source: "human",
					text: "yes",
					answers: {
						questions: [{ questionIndex: 0, kind: "option", answer: "yes" }],
						cancelled: false,
					},
				});
			});
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const script = `${META}
const g = graph();
g.node("build", agent("green", () => "build"));
g.node("ok", human("Ship it?", { options: ["yes", "no"], default: "no" }));
g.edge("build", "ok");
g.edge("ok", END);
g.run();
`;
			const tracker = trackDetached();
			await runGraphTool(
				{ script },
				{ cwd: tempDir, spawnAgent: spawn as never, broker, ...tracker },
			);
			await tracker.settled();
			broker.stop();
		});

		it("uses the declared default when headless instead of hanging", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const script = `${META}
const g = graph();
g.node("ok", human("Ship it?", { options: ["yes", "no"], default: "no" }));
g.edge("ok", END);
g.run();
`;
			const result = await run(script, {}, spawn);

			expect(result.text).toContain("completed");
		});
	});

	describe("tool surface", () => {
		const tool = createGraphWorkflowTool();


		it("is registered as `workflow`", () => {
			expect(tool.name).toBe("workflow");
		});

		it("throws on failure rather than returning an isError flag", async () => {
			// The agent loop decides a tool call failed by catching an exception
			// from execute(); a returned isError field is never read. Returning
			// one reports the failure to the model as a SUCCESS whose text merely
			// describes an error, which is how a validation failure came to look
			// like a completed run.
			const failing = createGraphWorkflowTool({ cwd: tempDir, spawnAgent: vi.fn() as never });

			await expect(
				failing.execute(
					"id",
					{ script: `${META}\nconst x = process.env;` },
					new AbortController().signal,
					() => {},
					{ cwd: tempDir } as never,
				),
			).rejects.toThrow(/not available in a graph script/);
			// Validation happens before the detach, so a bad script still fails
			// the tool call itself rather than a background run nobody is watching.
		});

		it("returns normally for a successful run", async () => {
			const spawn = vi.fn().mockResolvedValue(reply("done"));
			const result = await run(LINEAR, { args: { task: "t" } }, spawn);

			expect(result.failed).toBe(false);
		});

		it("documents the sandbox limits in its guidelines", () => {
			// The model cannot discover these by trying; they have to be stated.
			const guidelines = (tool.promptGuidelines ?? []).join("\n");

			expect(guidelines).toMatch(/no fs, process, require/);
			expect(guidelines).toMatch(/export const meta/);
			expect(guidelines).toMatch(/END/);
		});

		it("explains how escalation routing works", () => {
			const guidelines = (tool.promptGuidelines ?? []).join("\n");

			expect(guidelines).toMatch(/status === 'blocked'/);
			expect(guidelines).toMatch(/back to whoever owns the problem/);
		});

		it("tells the model to give human nodes a default", () => {
			const guidelines = (tool.promptGuidelines ?? []).join("\n");

			expect(guidelines).toMatch(/default.*headless run cannot hang/);
		});
	});
});
