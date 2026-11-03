/**
 * Background execution: the tool detaches, the report is delivered afterwards,
 * and concurrent runs are capped.
 *
 * The property that matters most here is the first one. A `workflow` call that
 * still blocked would leave the main agent stuck inside it for the whole walk,
 * which is exactly what makes asking it a question impossible. So the tests
 * assert on the *timing* — the call returns while the run is still going — not
 * merely on the shape of what it returns.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { installResultDelivery, stageRunReport } from "../extensions/result-delivery.ts";
import { trackDetached } from "./helpers/detached.ts";

const SCRIPT = `export const meta = { name: "bg_test", description: "background execution" };
const g = graph();
g.node("look", agent("scout", () => "inspect"));
g.edge("look", END);
g.run();`;

function replyingSpawn(text = "agent output") {
	return (async (_cwd: string, agentConfig: { name: string }) => ({
		agent: agentConfig.name,
		task: "t",
		exitCode: 0,
		usage: { totalTokens: 5 },
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
	})) as never;
}

describe("workflow runs in the background", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-bg-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function toolWith(overrides: Record<string, unknown> = {}) {
		const tracker = trackDetached();
		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			spawnAgent: replyingSpawn(),
			...tracker,
			...overrides,
		});
		return { tool, tracker };
	}

	function run(tool: ReturnType<typeof createGraphWorkflowTool>, params: Record<string, unknown> = {}) {
		return tool.execute(
			"call-1",
			{ script: SCRIPT, ...params } as never,
			new AbortController().signal,
			() => {},
			{ cwd: tempDir } as never,
		);
	}

	it("waits for the walk while keeping the event loop responsive", async () => {
		// The spawn never settles until released, so if execute() waited for
		// the run this test would time out rather than fail.
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let spawnStarted = false;

		const { tool, tracker } = toolWith({
			spawnAgent: (async (_cwd: string, agentConfig: { name: string }) => {
				spawnStarted = true;
				await held;
				return {
					agent: agentConfig.name,
					task: "t",
					exitCode: 0,
					usage: { totalTokens: 5 },
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				};
			}) as never,
		});

		let returned = false;
		const pending = run(tool).then(result => { returned = true; return result; });
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(spawnStarted, "the run must already be underway").toBe(true);
		expect(returned).toBe(false);
		release();
		const receipt = await pending;
		expect(receipt.content.map(c => "text" in c ? c.text : "").join("")).toContain("completed");
		expect((receipt.details as { background?: boolean }).background).toBe(false);
		const report = await tracker.settled();
		expect(report?.status).toBe("completed");
	});

	it("returns the final report without a duplicate background delivery instruction", async () => {
		const { tool, tracker } = toolWith();
		const receipt = await run(tool);
		await tracker.settled();

		const text = receipt.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toMatch(/completed/i);
		expect(text).not.toMatch(/end your turn/i);
	});

	it("names the run and its nodes so the receipt is actionable on its own", async () => {
		const { tool, tracker } = toolWith();
		const receipt = await run(tool);
		await tracker.settled();

		const details = receipt.details as { runId: string; name: string; nodeIds: string[] };
		expect(details.name).toBe("bg_test");
		expect(details.runId).toBeTruthy();
		expect(details.nodeIds).toEqual(["look"]);
	});

	it("still fails the tool call for a script that cannot run", async () => {
		// Validation happens before the detach, so the model learns about a bad
		// script while it can still fix it — not in a message half a minute later.
		const { tool } = toolWith();
		await expect(
			run(tool, { script: `export const meta = { name: "x", description: "d" };\nrequire("fs");` }),
		).rejects.toThrow(/not available in a graph script/);
	});
});

describe("delivering a finished run back into the conversation", () => {
	function fakePi() {
		const sent: Array<{ content: string; options?: Record<string, unknown> }> = [];
		const pi = {
			sendMessage: (
				message: { content: string },
				options?: Record<string, unknown>,
			) => {
				sent.push({ content: message.content, options });
			},
		};
		return { pi: pi as unknown as ExtensionAPI, sent };
	}

	it("injects the report and triggers a turn, without interrupting the user", () => {
		const manager = new WorkflowManager();
		const { pi, sent } = fakePi();
		installResultDelivery(pi, manager);

		manager.registerRun("r1", { name: "wf", description: "d" });
		stageRunReport(manager, { runId: "r1", name: "wf", text: "THE FULL REPORT" });
		manager.completeRun("r1", "final");

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toBe("THE FULL REPORT");
		// followUp waits for the user's current turn instead of cutting into it;
		// triggerTurn is what makes the model actually read the report.
		expect(sent[0].options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("delivers the full report for a failed run, not just the error", () => {
		// A failure is when the path and the escalation list are most worth
		// reading, so the report must not be replaced by a one-line message.
		const manager = new WorkflowManager();
		const { pi, sent } = fakePi();
		installResultDelivery(pi, manager);

		manager.registerRun("r2", { name: "wf", description: "d" });
		stageRunReport(manager, { runId: "r2", name: "wf", text: "REPORT WITH PATH AND ESCALATIONS" });
		manager.completeRun("r2", undefined, "spawn died");

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toBe("REPORT WITH PATH AND ESCALATIONS");
	});

	it("falls back to the bare error when a run failed before producing a report", () => {
		const manager = new WorkflowManager();
		const { pi, sent } = fakePi();
		installResultDelivery(pi, manager);

		manager.registerRun("r3", { name: "wf", description: "d" });
		manager.completeRun("r3", undefined, "crashed early");

		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("crashed early");
	});

	it("tells the user a stopped run is resumable", () => {
		const manager = new WorkflowManager();
		const { pi, sent } = fakePi();
		installResultDelivery(pi, manager);

		manager.registerRun("r4", { name: "wf", description: "d" });
		manager.stopRun("r4");

		expect(sent[0].content).toContain("resume");
		expect(sent[0].content).toContain("r4");
	});

	it("registers its listeners exactly once across reloads", () => {
		// The manager outlives /reload because it holds live runs, so installing
		// again on every extension generation would deliver each result N times.
		const manager = new WorkflowManager();
		const first = fakePi();
		const second = fakePi();

		installResultDelivery(first.pi, manager);
		installResultDelivery(second.pi, manager);

		manager.registerRun("r5", { name: "wf", description: "d" });
		stageRunReport(manager, { runId: "r5", name: "wf", text: "ONCE" });
		manager.completeRun("r5", "done");

		// Delivered once in total, and through the *current* generation's pi:
		// the one captured at first install is stale after a reload.
		expect(first.sent).toHaveLength(0);
		expect(second.sent).toHaveLength(1);
		expect(second.sent[0].content).toBe("ONCE");
	});

	it("survives a sendMessage that throws, since a stale ctx must not kill the run", () => {
		const manager = new WorkflowManager();
		const pi = {
			sendMessage: () => {
				throw new Error("stale ctx");
			},
		} as unknown as ExtensionAPI;
		installResultDelivery(pi, manager);

		manager.registerRun("r6", { name: "wf", description: "d" });
		stageRunReport(manager, { runId: "r6", name: "wf", text: "report" });

		expect(() => manager.completeRun("r6", "done")).not.toThrow();
	});
});

describe("concurrent run limits", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-conc-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function scriptNamed(name: string) {
		return `export const meta = { name: "${name}", description: "d" };
const g = graph();
g.node("look", agent("scout", () => "inspect"));
g.edge("look", END);
g.run();`;
	}

	it("refuses a second run of the same workflow, naming the one in flight", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-a", { name: "tdd", description: "d" });

		const verdict = manager.checkCanStart("tdd");

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			// Naming the existing run is what makes the refusal actionable:
			// the caller can wait for it or stop it.
			expect(verdict.reason).toContain("run-a");
			expect(verdict.reason).toContain("allowConcurrentDuplicate");
		}
	});

	it("allows a same-name run when the caller says the duplicate is deliberate", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-a", { name: "tdd", description: "d" });

		expect(manager.checkCanStart("tdd", { allowDuplicateName: true }).ok).toBe(true);
	});

	it("caps concurrent runs and lists what is already running", () => {
		const manager = new WorkflowManager();
		manager.setMaxConcurrentRuns(2);
		manager.registerRun("run-a", { name: "one", description: "d" });
		manager.registerRun("run-b", { name: "two", description: "d" });

		const verdict = manager.checkCanStart("three");

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toContain("run-a");
			expect(verdict.reason).toContain("run-b");
			expect(verdict.reason).toContain("limit 2");
		}
	});

	it("counts only running workflows, so finished ones free their slot", () => {
		const manager = new WorkflowManager();
		manager.setMaxConcurrentRuns(1);
		manager.registerRun("run-a", { name: "one", description: "d" });
		manager.completeRun("run-a", "done");

		expect(manager.checkCanStart("two").ok).toBe(true);
	});

	it("refuses through the tool before spawning anything", async () => {
		const manager = new WorkflowManager();
		manager.registerRun("existing", { name: "dupe", description: "d" });
		const spawn = vi.fn();

		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			workflowManager: manager,
			spawnAgent: spawn as never,
		});

		await expect(
			tool.execute(
				"c",
				{ script: scriptNamed("dupe") } as never,
				new AbortController().signal,
				() => {},
				{ cwd: tempDir } as never,
			),
		).rejects.toThrow(/already running/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("does not apply the same-name guard to a resume", async () => {
		// Resuming a run is by definition the same workflow name as the run it
		// continues, so the duplicate guard would make resume impossible.
		const manager = new WorkflowManager();
		manager.registerRun("existing", { name: "dupe", description: "d" });

		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			workflowManager: manager,
			spawnAgent: replyingSpawn(),
		});

		// Fails on the missing journal, not on the concurrency guard.
		await expect(
			tool.execute(
				"c",
				{ script: scriptNamed("dupe"), resumeRunId: "no-such-run" } as never,
				new AbortController().signal,
				() => {},
				{ cwd: tempDir } as never,
			),
		).rejects.toThrow(/Cannot resume/);
	});
});
