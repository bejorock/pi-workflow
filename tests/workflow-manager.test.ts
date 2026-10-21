import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { trackDetached } from "./helpers/detached.ts";

describe("WorkflowManager", () => {
	let tempDir: string;
	let manager: WorkflowManager;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `wf-mgr-test-${Date.now()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		manager = new WorkflowManager(tempDir);
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers active run and emits agentStart event", () => {
		let eventFired = false;
		manager.on("agentStart", () => {
			eventFired = true;
		});

		const run = manager.registerRun("run-1", { name: "test_workflow", description: "test" });

		expect(run.runId).toBe("run-1");
		expect(run.status).toBe("running");
		expect(eventFired).toBe(true);
		expect(manager.getRun("run-1")).toBe(run);
	});

	it("tracks phase transitions", () => {
		manager.registerRun("run-1", {
			name: "test",
			phases: [{ title: "Phase 1" }, { title: "Phase 2" }],
		});

		manager.markPhase("run-1", 0, "Phase 1");
		const run = manager.getRun("run-1");
		expect(run?.snapshot.phases[0].status).toBe("active");
	});

	it("tracks agent progress and completion", () => {
		manager.registerRun("run-1", { name: "test" });

		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
		});

		const run = manager.getRun("run-1");
		expect(run?.snapshot.agents.length).toBe(1);

		manager.markAgentEnd("run-1", 1, "done", "result ok", undefined, 150, 1000);

		expect(run?.snapshot.agents[0].status).toBe("done");
		expect(run?.snapshot.agents[0].outputTokens).toBe(150);
		expect(run?.snapshot.totalTokens).toBe(150);
	});

	it("completes run with success", () => {
		let completed = false;
		manager.on("complete", () => {
			completed = true;
		});

		manager.registerRun("run-1", { name: "test" });
		manager.completeRun("run-1", { success: true });

		const run = manager.getRun("run-1");
		expect(run?.status).toBe("completed");
		expect(run?.snapshot.status).toBe("completed");
		expect(completed).toBe(true);
	});

	it("completes run with error", () => {
		let errored = false;
		manager.on("error", () => {
			errored = true;
		});

		manager.registerRun("run-1", { name: "test" });
		manager.completeRun("run-1", undefined, "Failed execution");

		const run = manager.getRun("run-1");
		expect(run?.status).toBe("error");
		expect(run?.snapshot.status).toBe("error");
		expect(errored).toBe(true);
	});

	it("watches transcript JSONL file and emits history entries", async () => {
		const transcriptPath = path.join(tempDir, "transcript.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

		manager.registerRun("run-1", { name: "test" });

		let historyEmitted = false;
		manager.on("agentHistory", (evt) => {
			if (evt.agentId === 1) historyEmitted = true;
		});

		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		// Write transcript records
		const record1 = {
			version: 1,
			recordType: "tool_start",
			toolName: "bash",
			argsPreview: "echo hello",
			ts: Date.now(),
		};
		const record2 = {
			version: 1,
			recordType: "message",
			role: "assistant",
			text: "I ran the command",
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record1)}\n${JSON.stringify(record2)}\n`);

		// Wait for poll interval
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-1");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history).toBeDefined();
		expect(agent?.history?.length).toBeGreaterThanOrEqual(2);
		const firstEntry = agent?.history?.[0];
		expect(firstEntry && "toolName" in firstEntry ? firstEntry.toolName : undefined).toBe("bash");
		expect(agent?.history?.[1].text).toBe("I ran the command");
		expect(historyEmitted).toBe(true);

		manager.markAgentEnd("run-1", 1, "done");
	});

	it("does not drop the final transcript line written right before markAgentEnd (poll-race regression)", async () => {
		// Regression test for a real bug found via a user's actual workflow run:
		// stop() set `stopped = true` BEFORE calling readNewLines() as its
		// "final flush", but readNewLines()'s very first line was `if (stopped)
		// return`, making the flush a permanent no-op. Any transcript line
		// written in the window between the last 200ms poll tick and
		// markAgentEnd() being called (e.g. the agent's final assistant
		// message, which is exactly when markAgentEnd() typically fires) was
		// silently dropped and never appeared in agent.history or the pager.
		const transcriptPath = path.join(tempDir, "transcript-race.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

		manager.registerRun("run-1", { name: "test" });
		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		// No wait for the poll interval here — write the final line and
		// immediately call markAgentEnd(), exactly like the real race: the
		// child process's last message_end event arrives, gets written to the
		// transcript file, and the workflow tool calls markAgentEnd() right
		// after, all faster than the next 200ms poll tick.
		const finalRecord = {
			version: 1,
			recordType: "message",
			role: "assistant",
			text: "Here is my final answer that must not be dropped",
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(finalRecord)}\n`);

		manager.markAgentEnd("run-1", 1, "done", "final answer");

		const run = manager.getRun("run-1");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history).toBeDefined();
		expect(agent?.history?.some((h) => "text" in h && h.text === "Here is my final answer that must not be dropped")).toBe(true);
	});

	it("records toolCall entries with args populated (not undefined)", async () => {
		const transcriptPath = path.join(tempDir, "transcript-args.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-args", { name: "test" });
		manager.markAgentStart("run-args", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		const record = {
			version: 1,
			recordType: "tool_start",
			toolName: "read",
			argsPreview: '{"path":"foo.ts"}',
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-args");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		const entry = agent?.history?.[0];
		expect(entry).toBeDefined();
		expect(entry?.role).toBe("assistant");
		if (entry?.role === "assistant" && entry.kind === "toolCall") {
			expect(entry.args).toBe('{"path":"foo.ts"}');
			expect(entry.toolName).toBe("read");
		} else {
			throw new Error("expected toolCall entry");
		}

		manager.markAgentEnd("run-args", 1, "done");
	});

	it("records toolResult entries with actual text (not '[]')", async () => {
		const transcriptPath = path.join(tempDir, "transcript-result.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-result", { name: "test" });
		manager.markAgentStart("run-result", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		// This simulates what child-transcript.ts now correctly writes after the
		// extractTextFromContent(message) fix — real file contents, not "[]".
		const record = {
			version: 1,
			recordType: "message",
			role: "toolResult",
			toolName: "read",
			text: "export function foo() {}",
			isError: false,
			ts: Date.now(),
		};
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-result");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		const entry = agent?.history?.[0];
		expect(entry).toBeDefined();
		expect(entry?.role).toBe("toolResult");
		expect(entry?.text).toBe("export function foo() {}");
		expect(entry?.text).not.toBe("[]");

		manager.markAgentEnd("run-result", 1, "done");
	});

	it("records assistant text messages (not just tool calls)", async () => {
		const transcriptPath = path.join(tempDir, "transcript-text.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-text", { name: "test" });
		manager.markAgentStart("run-text", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		const toolRecord = { version: 1, recordType: "tool_start", toolName: "bash", argsPreview: "ls", ts: Date.now() };
		const textRecord = { version: 1, recordType: "message", role: "assistant", text: "Here is my plan for the task.", ts: Date.now() };
		fs.writeFileSync(transcriptPath, `${JSON.stringify(toolRecord)}\n${JSON.stringify(textRecord)}\n`);
		await new Promise((r) => setTimeout(r, 350));

		const run = manager.getRun("run-text");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history?.length).toBe(2);
		const textEntry = agent?.history?.find((e) => e.role === "assistant" && "kind" in e && e.kind === "text");
		expect(textEntry).toBeDefined();
		expect(textEntry?.text).toBe("Here is my plan for the task.");

		manager.markAgentEnd("run-text", 1, "done");
	});

	it("does not record duplicate entries for the same transcript line", async () => {
		const transcriptPath = path.join(tempDir, "transcript-dedup.jsonl");
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		manager.registerRun("run-dedup", { name: "test" });
		manager.markAgentStart("run-dedup", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "do work",
			status: "running",
			transcriptPath,
		});

		const record = { version: 1, recordType: "tool_start", toolName: "bash", argsPreview: "echo hi", ts: Date.now() };
		fs.writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);

		// Wait through multiple poll cycles — the byte offset tracking should
		// prevent re-reading the same line more than once.
		await new Promise((r) => setTimeout(r, 700));

		const run = manager.getRun("run-dedup");
		const agent = run?.snapshot.agents.find((a) => a.id === 1);
		expect(agent?.history?.length).toBe(1);

		manager.markAgentEnd("run-dedup", 1, "done");
	});

	it("pauses, resumes, and stops active run", () => {
		const abortController = new AbortController();
		manager.registerRun("run-1", { name: "test" }, abortController);

		expect(manager.pauseRun("run-1")).toBe(true);
		expect(manager.getRun("run-1")?.status).toBe("paused");

		expect(manager.resumeRun("run-1")).toBe(true);
		expect(manager.getRun("run-1")?.status).toBe("running");

		expect(manager.stopRun("run-1")).toBe(true);
		expect(manager.getRun("run-1")?.status).toBe("stopped");
		expect(abortController.signal.aborted).toBe(true);
	});

	it("lists both active and persisted runs from journal directory", () => {
		manager.registerRun("run-active", { name: "active_wf" });

		// Create a mock journal file in the real graph-engine format (the only
		// format the graph tool ever writes — see graph-journal.ts).
		const journalPath = path.join(tempDir, "run-persisted.jsonl");
		fs.writeFileSync(
			journalPath,
			JSON.stringify({ type: "graph_run", runId: "run-persisted", name: "persisted_wf", entry: "step1", nodeIds: ["step1"], startedAt: Date.now() }) +
				"\n" +
				JSON.stringify({ type: "node", step: 1, nodeId: "step1", nodeType: "agent", agentName: "scout", status: "ok", result: { status: "ok", text: "done" }, routedTo: "END", tokens: 200, startedAt: Date.now(), durationMs: 10 }) +
				"\n" +
				JSON.stringify({ type: "graph_result", status: "completed", iterations: 1, totalTokens: 200, durationMs: 10 }),
		);

		const runs = manager.listRuns();
		expect(runs.length).toBe(2);

		const names = runs.map((r) => r.workflowName);
		expect(names).toContain("active_wf");
		expect(names).toContain("persisted_wf");

		const persisted = runs.find((r) => r.workflowName === "persisted_wf");
		expect(persisted?.status).toBe("completed");
		expect(persisted?.totalTokens).toBe(200);
		expect(persisted?.agents.length).toBe(1);
		expect(persisted?.agents[0].label).toBe("step1 (scout)");
	});

	it("populates the manager when the graph workflow tool executes", async () => {
		// This is the wiring behind /workflows, the task panel, and
		// workflow_status. When the graph tool replaced the imperative one it
		// was registered without a manager, so every one of those surfaces
		// reported "No runs yet" forever while runs completed normally —
		// invisible to any test that exercised the tool in isolation.
		const { createGraphWorkflowTool } = await import("../extensions/graph-tool.ts");
		const tracker = trackDetached();
		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			workflowManager: manager,
			...tracker,
			spawnAgent: (async () => ({
				agent: "scout",
				task: "t",
				exitCode: 0,
				usage: { totalTokens: 5 },
				messages: [{ role: "assistant", content: [{ type: "text", text: "agent output" }] }],
			})) as never,
		});

		const script = `export const meta = { name: "integration_test", description: "test" };
const g = graph();
g.node("look", agent("scout", () => "inspect"));
g.edge("look", END);
g.run();`;

		await tool.execute("call-1", { script }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as unknown as ExtensionToolContext);
		// The run outlives the tool call, so wait for it before reading state.
		await tracker.settled();

		const runs = manager.listRuns();
		expect(runs.length).toBe(1);
		expect(runs[0].workflowName).toBe("integration_test");
		expect(runs[0].status).toBe("completed");
		expect(runs[0].agents.length).toBe(1);
		expect(runs[0].agents[0].label).toBe("look (scout)");
		expect(runs[0].agents[0].status).toBe("done");
	});

	it("a fresh WorkflowManager (simulating a new process) can look up a completed run by runId", async () => {
		// Live-tested regression: the graph tool computes journalDir per-run
		// (cwd-derived) but never called manager.setJournalDir(), so
		// workflow_status's cross-process lookup (getRun() -> listRuns()
		// journal scan) silently found nothing for any run outside the
		// process that created it — even though the journal file was right
		// there on disk.
		const { createGraphWorkflowTool } = await import("../extensions/graph-tool.ts");
		const tracker = trackDetached();
		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			workflowManager: manager,
			...tracker,
			spawnAgent: (async () => ({
				agent: "scout",
				task: "t",
				exitCode: 0,
				usage: { totalTokens: 5 },
				messages: [{ role: "assistant", content: [{ type: "text", text: "agent output" }] }],
			})) as never,
		});

		const script = `export const meta = { name: "cross_process_test", description: "test" };
const g = graph();
g.node("look", agent("scout", () => "inspect"));
g.edge("look", END);
g.run();`;

		const result = await tool.execute("call-1", { script }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as unknown as ExtensionToolContext);
		await tracker.settled();
		const runId = (result.details as { runId: string }).runId;

		// A brand-new manager, with nothing in memory — exactly what
		// workflow_status sees when called from a separate `pi` invocation
		// than the one that ran the workflow.
		const freshManager = new WorkflowManager();
		freshManager.setJournalDir(`${tempDir}/.pi-workflow/runs`);

		const found = freshManager.listRuns().find((r) => r.runId === runId);
		expect(found).toBeDefined();
		expect(found?.workflowName).toBe("cross_process_test");
		expect(found?.status).toBe("completed");
	});

	it("records one manager entry per node visit, so loops stay visible", async () => {
		const { createGraphWorkflowTool } = await import("../extensions/graph-tool.ts");
		// Count per agent, not globally: green must block on ITS first call,
		// which is the second spawn overall.
		const calls: Record<string, number> = {};
		const tracker = trackDetached();
		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			workflowManager: manager,
			...tracker,
			spawnAgent: (async (_cwd: string, agentConfig: { name: string }) => {
				const name = agentConfig.name;
				calls[name] = (calls[name] ?? 0) + 1;
				const blocked = name === "green" && calls[name] === 1;
				return {
					agent: name,
					task: "t",
					exitCode: 0,
					usage: { totalTokens: 5 },
					messages: [
						{
							role: "assistant",
							content: [
								{ type: "text", text: blocked ? "STATUS: blocked\nBLOCKED_ON: contract" : "done" },
							],
						},
					],
				};
			}) as never,
		});

		const script = `export const meta = { name: "loop_test", description: "escalation" };
const g = graph();
g.node("architect", agent("architect", () => "design"));
g.node("green", agent("green", (s) => "build " + s.architect));
g.edge("architect", "green");
g.edge("green", (state, result) => result.status === "blocked" ? "architect" : END);
g.run();`;

		await tool.execute("call-2", { script }, undefined, undefined, {
			cwd: tempDir,
			sessionManager: { getSessionId: () => "s1" },
		} as unknown as ExtensionToolContext);
		await tracker.settled();

		const runs = manager.listRuns();
		// architect, green, architect, green — collapsing repeats would hide
		// the escalation loop, which is the thing worth seeing.
		expect(runs[0].agents.length).toBe(4);
		expect(runs[0].agents.map((a) => a.label)).toEqual([
			"architect (architect)",
			"green (green)",
			"architect (architect)",
			"green (green)",
		]);
	});

	it("getRunSource returns the script/cwd a run was registered with", () => {
		manager.registerRun("run-1", { name: "test" }, undefined, { script: "export const meta = {};", cwd: "/tmp/project" });
		expect(manager.getRunSource("run-1")).toEqual({ script: "export const meta = {};", cwd: "/tmp/project" });
	});

	it("getRunSource returns undefined when a run was registered without source info", () => {
		manager.registerRun("run-1", { name: "test" });
		expect(manager.getRunSource("run-1")).toBeUndefined();
	});

	it("getRunSource returns undefined for an unknown runId", () => {
		expect(manager.getRunSource("does-not-exist")).toBeUndefined();
	});

	it("watchSession replays a node's pi session conversation into history", async () => {
		manager.registerRun("run-1", { name: "s", description: "d" });
		manager.markAgentStart("run-1", 0, {
			id: 1,
			label: "planner",
			prompt: "plan",
			status: "running",
		});

		// A slice of real pi session JSONL: user prompt, an assistant message
		// with thinking + text + a tool call, and a tool result as a content
		// block (pi nests tool results inside assistant messages).
		const sessionFile = path.join(tempDir, "planner.jsonl");
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: 1000, cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: 1001,
					message: { role: "user", content: [{ type: "text", text: "Task: plan a todo app" }] },
				}),
				JSON.stringify({
					type: "message",
					timestamp: 1002,
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "The user wants a plan." },
							{ type: "text", text: "A todo app needs add/view/toggle/delete." },
							{ type: "toolCall", name: "read", arguments: { path: "/file" } },
						],
					},
				}),
				// Pi session format: tool results are separate messages with
				// role="toolResult", not content blocks inside an assistant message.
				JSON.stringify({
					type: "message",
					timestamp: 1003,
					message: {
						role: "toolResult",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "TODO.md" }],
					},
				}),
			].join("\n"),
		);

		manager.watchSession("run-1", 1, sessionFile);

		await new Promise((r) => setTimeout(r, 500));

		const history = manager.getRun("run-1")?.snapshot.agents[0]?.history ?? [];

		expect(history).toHaveLength(5);
		expect(history[0]).toMatchObject({ role: "user", text: "Task: plan a todo app" });
		expect(history[1]).toMatchObject({ role: "assistant", kind: "thinking" });
		expect(history[2]).toMatchObject({ role: "assistant", text: "A todo app needs add/view/toggle/delete." });
		expect(history[3]).toMatchObject({ role: "assistant", kind: "toolCall", toolName: "read" });
		expect(history[4]).toMatchObject({ role: "toolResult", toolName: "read", text: "TODO.md" });

		// Stopping the run tears the watcher down without leaking.
		manager.markAgentEnd("run-1", 1, "done");
	});
});
