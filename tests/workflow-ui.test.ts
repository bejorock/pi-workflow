import { describe, it, expect, beforeEach } from "vitest";
import {
	NavigatorState,
	NavigatorModel,
	keyToAction,
	renderNavigatorText,
} from "../extensions/workflow-ui.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

describe("NavigatorState", () => {
	let state: NavigatorState;

	beforeEach(() => {
		state = new NavigatorState();
	});

	it("initializes at runs view", () => {
		expect(state.kind).toBe("runs");
		expect(state.cursor).toBe(0);
	});

	it("moves cursor with bounds checking", () => {
		state.move(1, 3);
		expect(state.cursor).toBe(1);

		state.move(1, 3);
		expect(state.cursor).toBe(2);

		// Clamp at max
		state.move(1, 3);
		expect(state.cursor).toBe(2);

		// Move up
		state.move(-1, 3);
		expect(state.cursor).toBe(1);

		// Clamp at 0
		state.move(-5, 3);
		expect(state.cursor).toBe(0);
	});

	it("moves page up and down", () => {
		state.movePage("down", 10, 5);
		expect(state.cursor).toBe(5);

		state.movePage("up", 10, 5);
		expect(state.cursor).toBe(0);
	});

	it("jumps to top and bottom", () => {
		state.jump("bottom", 10);
		expect(state.cursor).toBe(9);

		state.jump("top", 10);
		expect(state.cursor).toBe(0);
	});

	it("drills into runs -> phases -> agents -> detail", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-123", {
			name: "my_workflow",
			phases: [{ title: "Phase 1" }],
		});

		manager.markAgentStart("run-123", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "task 1",
			status: "done",
		});

		const model = new NavigatorModel(manager);

		// Drill into runs -> phases
		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("phases");
		expect(state.runId).toBe("run-123");

		// Drill into phases -> agents
		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("agents");
		expect(state.phase).toBe("Phase 1");

		// Drill into agents -> detail
		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("detail");
		expect(state.agentId).toBe(1);

		// Back to agents
		expect(state.back()).toBe(true);
		expect(state.kind).toBe("agents");

		// Back to phases
		expect(state.back()).toBe(true);
		expect(state.kind).toBe("phases");

		// Back to runs
		expect(state.back()).toBe(true);
		expect(state.kind).toBe("runs");

		// Back at top level returns false
		expect(state.back()).toBe(false);
	});
});

describe("keyToAction", () => {
	it("maps raw terminal input sequences and key names to actions", () => {
		// Raw terminal escape sequences
		expect(keyToAction("\r", "runs")).toEqual({ type: "drill" });
		expect(keyToAction("\n", "runs")).toEqual({ type: "drill" });
		expect(keyToAction("\x1b[A", "runs")).toEqual({ type: "move", delta: -1 });
		expect(keyToAction("\x1b[B", "runs")).toEqual({ type: "move", delta: 1 });
		expect(keyToAction("\x1b", "runs")).toEqual({ type: "back" });

		// Named keys
		expect(keyToAction("up", "runs")).toEqual({ type: "move", delta: -1 });
		expect(keyToAction("k", "runs")).toEqual({ type: "move", delta: -1 });
		expect(keyToAction("down", "runs")).toEqual({ type: "move", delta: 1 });
		expect(keyToAction("j", "runs")).toEqual({ type: "move", delta: 1 });
		expect(keyToAction("enter", "runs")).toEqual({ type: "drill" });
		expect(keyToAction("return", "runs")).toEqual({ type: "drill" });
		expect(keyToAction("escape", "runs")).toEqual({ type: "back" });
		expect(keyToAction("left", "runs")).toEqual({ type: "back" });
		expect(keyToAction("q", "runs")).toEqual({ type: "close" });
		expect(keyToAction("x", "runs")).toEqual({ type: "stop" });
		expect(keyToAction("p", "runs")).toEqual({ type: "pause" });
		expect(keyToAction("r", "runs")).toEqual({ type: "resume" });
	});
});

describe("renderNavigatorText", () => {
	it("renders runs list", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-abc", { name: "test_run" });

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		const lines = renderNavigatorText(state, model, 80);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes("test_run"))).toBe(true);
	});

	it("renders empty runs list when no runs", () => {
		const manager = new WorkflowManager();
		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		const lines = renderNavigatorText(state, model, 80);

		expect(lines.some((l) => l.includes("No matching runs"))).toBe(true);
	});

	it("renders two-pane phases and agents view", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-split", {
			name: "split_wf",
			phases: [{ title: "Scan Phase" }, { title: "Audit Phase" }],
		});

		manager.markAgentStart("run-split", 0, {
			id: 1,
			label: "Scout Agent",
			phase: "Scan Phase",
			prompt: "Scan files",
			status: "done",
			outputTokens: 120,
		});

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		state.drill(model); // Move to phases

		const lines = renderNavigatorText(state, model, 80);

		expect(lines.some((l) => l.includes("Phases"))).toBe(true);
		expect(lines.some((l) => l.includes("Scan Phase"))).toBe(true);
		expect(lines.some((l) => l.includes("Scout Agent"))).toBe(true);
	});

	it("renders agent detail view with history stream in full pager", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-detail", {
			name: "detail_wf",
			phases: [{ title: "Phase 1" }],
		});

		manager.markAgentStart("run-detail", 0, {
			id: 1,
			label: "Worker Agent",
			phase: "Phase 1",
			prompt: "Implement feature X",
			status: "running",
		});

		manager.recordAgentHistory("run-detail", 1, {
			role: "assistant",
			kind: "toolCall",
			toolName: "read",
			args: '{"path":"src/index.ts"}',
			text: "Tool call: read",
		});

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		state.drill(model); // phases
		state.drill(model); // agents
		state.drill(model); // detail

		state.togglePager(); // Open full pager

		const lines = renderNavigatorText(state, model, 80);

		expect(lines.some((l) => l.includes("Worker Agent"))).toBe(true);
		expect(lines.some((l) => l.includes("Implement feature X"))).toBe(true);
		expect(lines.some((l) => l.includes("History"))).toBe(true);
		expect(lines.some((l) => l.includes("read"))).toBe(true);
	});

	it("splits multi-line history entries into separate rows instead of embedding raw newlines", () => {
		// Regression test: tool output like `bash: total 60\ndrwxr-xr-x ...`
		// was previously pushed as a single body[] element containing literal
		// "\n" characters. The renderer treats every body[] element as exactly
		// one bordered row, so embedded newlines broke the box border and
		// spilled raw text across the panel (evidence4.png).
		const manager = new WorkflowManager();
		manager.registerRun("run-multiline", {
			name: "multiline_wf",
			phases: [{ title: "Phase 1" }],
		});

		manager.markAgentStart("run-multiline", 0, {
			id: 1,
			label: "Worker Agent",
			phase: "Phase 1",
			prompt: "Implement feature X",
			status: "running",
		});

		const multilineOutput = [
			"total 60",
			"drwxr-xr-x 1 ranalubis ranalubis  166 Aug  3 11:48 .",
			"drwxr-xr-x 1 ranalubis ranalubis   52 Aug  3 11:11 ..",
			"-rw-r--r-- 1 ranalubis ranalubis   83 Aug  3 11:11 package.json",
		].join("\n");

		manager.recordAgentHistory("run-multiline", 1, {
			role: "toolResult",
			toolName: "bash",
			text: multilineOutput,
		});

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		state.drill(model);
		state.drill(model);
		state.drill(model);
		state.togglePager();

		const lines = renderNavigatorText(state, model, 80);

		// No single rendered line should contain an embedded newline.
		for (const line of lines) {
			expect(line.includes("\n")).toBe(false);
		}

		// All four output lines should still be present, just as separate rows.
		expect(lines.some((l) => l.includes("total 60"))).toBe(true);
		expect(lines.some((l) => l.includes("package.json"))).toBe(true);
	});

	it("truncates very long history entries instead of rendering unbounded output", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-huge", {
			name: "huge_wf",
			phases: [{ title: "Phase 1" }],
		});

		manager.markAgentStart("run-huge", 0, {
			id: 1,
			label: "Worker Agent",
			phase: "Phase 1",
			prompt: "Implement feature X",
			status: "running",
		});

		const hugeOutput = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
		manager.recordAgentHistory("run-huge", 1, {
			role: "toolResult",
			toolName: "bash",
			text: hugeOutput,
		});

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		state.drill(model);
		state.drill(model);
		state.drill(model);
		state.togglePager();

		const lines = renderNavigatorText(state, model, 80, 1000);

		expect(lines.length).toBeLessThan(500);
		expect(lines.some((l) => l.includes("truncated"))).toBe(true);
	});

	it("shows the full agent result in the pager, not just the ~60-char resultPreview", () => {
		// Regression test: markAgentEnd() only ever set agent.resultPreview
		// (aggressively truncated to ~60 chars via preview()), never
		// agent.result. The pager's Result section rendered resultPreview even
		// though it had plenty of room to show the full output, so agents
		// with substantial output (e.g. a JSON design doc) appeared to have
		// no real output at all \u2014 only a truncated fragment, with the real
		// text buried at the bottom of the History list.
		const manager = new WorkflowManager();
		manager.registerRun("run-fullresult", {
			name: "fullresult_wf",
			phases: [{ title: "Phase 1" }],
		});

		manager.markAgentStart("run-fullresult", 0, {
			id: 1,
			label: "Worker Agent",
			phase: "Phase 1",
			prompt: "Design the backend",
			status: "running",
		});

		const longResult = JSON.stringify({
			status: "ok",
			design: "Backend REST API with in-memory persistence and seed data",
			endpoints: ["GET /api/pages", "GET /api/pages/search", "GET /api/pages/:id", "POST /api/pages"],
		});
		expect(longResult.length).toBeGreaterThan(60);

		manager.markAgentEnd("run-fullresult", 1, "done", longResult);

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);
		state.drill(model);
		state.drill(model);
		state.drill(model);
		state.togglePager();

		const lines = renderNavigatorText(state, model, 200, 100);
		const rendered = lines.join("\n");

		expect(rendered).toContain(longResult);
		expect(rendered).not.toContain("\u2026");
	});
});

describe("phaseless (graph) runs", () => {
	function managerWithGraphRun(): WorkflowManager {
		const manager = new WorkflowManager();
		manager.registerRun("r1", { name: "graph_run", description: "d" });
		manager.markAgentStart("r1", 0, {
			id: 1,
			label: "look (scout)",
			prompt: "agent node",
			status: "running",
		});
		manager.markAgentEnd("r1", 1, "done", "found files → sum");
		manager.markAgentStart("r1", 0, {
			id: 2,
			label: "sum (researcher)",
			prompt: "agent node",
			status: "running",
		});
		manager.markAgentEnd("r1", 2, "done", "summary → END");
		return manager;
	}

	it("drills from the run list straight to the node list", () => {
		// A graph has no phases, so the phase level would be a single
		// "(no phase)" row the user must click through to reach what they
		// asked for.
		const manager = managerWithGraphRun();
		const model = new NavigatorModel(manager);
		const state = new NavigatorState();

		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("agents");
	});

	it("returns to the run list on back, not to the skipped phase level", () => {
		const manager = managerWithGraphRun();
		const model = new NavigatorModel(manager);
		const state = new NavigatorState();
		state.drill(model);

		expect(state.back()).toBe(true);
		expect(state.kind).toBe("runs");
	});

	it("still drills through phases when a run has real ones", () => {
		const manager = new WorkflowManager();
		manager.registerRun("r2", {
			name: "phased",
			description: "d",
			phases: [{ title: "Research" }, { title: "Build" }],
		});
		const model = new NavigatorModel(manager);
		const state = new NavigatorState();

		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("phases");
	});

	it("labels the pane by nodes rather than by an empty phase name", () => {
		const manager = managerWithGraphRun();
		const model = new NavigatorModel(manager);
		const state = new NavigatorState();
		state.drill(model);

		const text = renderNavigatorText(state, model, 100, 24).join("\n");

		expect(text).toContain("nodes");
		expect(text).not.toContain("(no phase)");
	});

	it("shows each node with its routing target", () => {
		const manager = managerWithGraphRun();
		const model = new NavigatorModel(manager);
		const state = new NavigatorState();
		state.drill(model);

		const text = renderNavigatorText(state, model, 100, 24).join("\n");

		// Routing is what distinguishes a coordination loop from a pipeline,
		// so it has to survive into the display.
		expect(text).toContain("look (scout)");
		expect(text).toContain("sum (researcher)");
	});
});

describe("navigator detail view: session-derived history", () => {
	it("renders every entry kind produced by watchSession", () => {
		const mgr = new WorkflowManager("/tmp");
		mgr.registerRun("r1", { name: "demo", description: "d" });
		mgr.markAgentStart("r1", 0, {
			id: 42,
			label: "planner",
			prompt: "plan",
			status: "running",
		});
		// These are the shapes parseSessionMessage emits from a real pi
		// session JSONL.
		mgr.recordAgentHistory("r1", 42, { role: "user", text: "Task: plan" });
		mgr.recordAgentHistory("r1", 42, { role: "assistant", kind: "thinking", text: "I should think." });
		mgr.recordAgentHistory("r1", 42, { role: "assistant", kind: "toolCall", toolName: "read", text: "read(path)", args: "path=/file" });
		mgr.recordAgentHistory("r1", 42, { role: "toolResult", toolName: "read", text: "file contents" });
		mgr.markAgentEnd("r1", 42, "done");

		const model = new NavigatorModel(mgr);
		const state = new NavigatorState();
		state.cursor = 0;
		state.drill(model); // runs -> agents
		state.cursor = 0;
		state.drill(model); // agents -> detail
		state.openPager();

		const text = renderNavigatorText(state, model, 100, 24).join("\n");

		expect(text).toContain("[user] Task: plan");
		expect(text).toContain("[think] I should think.");
		expect(text).toContain("→ read: path=/file");
		expect(text).toContain("← read: file contents");
	});

	it("shows model in the agent list and detail view", () => {
		const mgr = new WorkflowManager("/tmp");
		mgr.registerRun("r1", { name: "demo", description: "d" });
		mgr.markAgentStart("r1", 0, {
			id: 1,
			label: "planner",
			prompt: "plan",
			status: "running",
			model: "openrouter/test-model",
		});
		mgr.markAgentEnd("r1", 1, "done");

		const model = new NavigatorModel(mgr);
		const state = new NavigatorState();

		// Agent list view shows the model tag
		state.cursor = 0;
		state.drill(model); // runs -> agents
		const listText = renderNavigatorText(state, model, 120, 24).join("\n");
		expect(listText).toContain("openrouter/test-model");

		// Detail pager also shows Model:
		state.cursor = 0;
		state.drill(model); // agents -> detail
		state.openPager();
		const detailText = renderNavigatorText(state, model, 120, 24).join("\n");
		expect(detailText).toContain("Model:");
		expect(detailText).toContain("openrouter/test-model");
	});
});
