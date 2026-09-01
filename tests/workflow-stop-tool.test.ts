/**
 * Tests for the `workflow_stop` tool (extensions/index.ts), which lets an
 * agent cancel a running workflow the same way the /workflows TUI's `x` key
 * does — without needing the interactive navigator.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWorkflowStopTool } from "../extensions/index.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

function makeMockPi() {
	const tools = new Map<string, any>();
	return {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		tools,
	} as unknown as ExtensionAPI & { tools: Map<string, any> };
}

function makeCtx(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

describe("workflow_stop tool", () => {
	let tempDir: string;
	let manager: WorkflowManager;
	let pi: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-stop-test-"));
		manager = new WorkflowManager(tempDir);
		pi = makeMockPi();
		registerWorkflowStopTool(pi as unknown as ExtensionAPI, manager);
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function getTool() {
		const tool = pi.tools.get("workflow_stop");
		if (!tool) throw new Error("workflow_stop tool was not registered");
		return tool;
	}

	it("registers a tool named workflow_stop", () => {
		expect(pi.tools.has("workflow_stop")).toBe(true);
	});

	it("lists running workflows when called with no runId", async () => {
		manager.registerRun("run-1", { name: "wf_one", description: "d" });
		manager.registerRun("run-2", { name: "wf_two", description: "d" });

		const result = await getTool().execute("call-1", {}, undefined, undefined, makeCtx(tempDir));

		expect(result.details.running.length).toBe(2);
		expect(result.content[0].text).toContain("run-1");
		expect(result.content[0].text).toContain("run-2");
	});

	it("reports no workflows running when nothing is active", async () => {
		const result = await getTool().execute("call-1", {}, undefined, undefined, makeCtx(tempDir));
		expect(result.details.running).toEqual([]);
		expect(result.content[0].text).toContain("No workflows are currently running");
	});

	it("stops a running workflow tracked live in this process", async () => {
		const abortController = new AbortController();
		manager.registerRun("run-1", { name: "wf_one", description: "d" }, abortController);

		const result = await getTool().execute("call-1", { runId: "run-1" }, undefined, undefined, makeCtx(tempDir));

		expect(result.details.stopped).toBe(true);
		expect(result.content[0].text).toContain("Stopped workflow");
		expect(manager.getRun("run-1")?.status).toBe("stopped");
		expect(abortController.signal.aborted).toBe(true);
	});

	it("reports (without erroring destructively) when the run is not currently running", async () => {
		manager.registerRun("run-1", { name: "wf_one", description: "d" });
		manager.stopRun("run-1"); // now "stopped", not "running"

		const result = await getTool().execute("call-1", { runId: "run-1" }, undefined, undefined, makeCtx(tempDir));

		expect(result.details.stopped).toBe(false);
		expect(result.content[0].text).toContain("is not running");
	});

	it("errors clearly for an unknown runId", async () => {
		const result = await getTool().execute("call-1", { runId: "does-not-exist" }, undefined, undefined, makeCtx(tempDir));

		expect(result.isError).toBe(true);
		expect(result.details.found).toBe(false);
		expect(result.content[0].text).toContain("No workflow run found");
	});

	it("reports a persisted-only run (from another process) as not stoppable here", async () => {
		// Simulate a run this process never held in memory: only a journal file.
		fs.writeFileSync(
			path.join(tempDir, "run-other-process.jsonl"),
			[
				JSON.stringify({ type: "graph_run", runId: "run-other-process", name: "cross_process_wf", entry: "step1", nodeIds: ["step1"], startedAt: Date.now() }),
				JSON.stringify({ type: "node", step: 1, nodeId: "step1", nodeType: "agent", agentName: "scout", status: "ok", result: { status: "ok", text: "done" }, routedTo: "END", tokens: 10, startedAt: Date.now(), durationMs: 5 }),
			].join("\n"),
		);

		const result = await getTool().execute("call-1", { runId: "run-other-process" }, undefined, undefined, makeCtx(tempDir));

		expect(result.details.stopped).toBe(false);
		expect(result.details.persisted).toBe(true);
		// This journal has no graph_result record, so the manager treats it as
		// still "running" — but it's not tracked live, so it can't be aborted.
		expect(result.content[0].text).toContain("cannot be stopped from here");
	});
});
