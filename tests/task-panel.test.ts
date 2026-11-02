import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliverResultSummary, registerTaskPanel } from "../extensions/task-panel.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import type { ManagedRun } from "../extensions/workflow-manager.ts";

function fakeUi() {
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ text: string; type?: string }> = [];
	return {
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (text: string, type?: string) => notifications.push({ text, type }),
		} as never,
		statuses,
		notifications,
		current: () => [...statuses.values()].filter(Boolean).join("\n"),
	};
}

function fakePi() {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		events: { emit: vi.fn() },
	} as unknown as ExtensionAPI & {
		sendMessage: ReturnType<typeof vi.fn>;
		events: { emit: ReturnType<typeof vi.fn> };
	};
}

function startRun(manager: WorkflowManager, name = "tdd_feature"): void {
	manager.registerRun("r1", { name, description: "d" });
}

function runNode(
	manager: WorkflowManager,
	id: number,
	label: string,
	opts: { finish?: boolean; status?: "done" | "error"; tokens?: number } = {},
): void {
	manager.markAgentStart("r1", 0, { id, label, prompt: "agent node", status: "running" });
	if (opts.finish !== false) {
		manager.markAgentEnd("r1", id, opts.status ?? "done", "ok", undefined, opts.tokens ?? 100, 10);
	}
}

describe("task panel status line", () => {
	it("names the node currently running rather than a completion ratio", () => {
		// "3/5" implies a pipeline with a known end. A graph revisits nodes,
		// so the denominator grows as it runs and the fraction can appear to
		// go backwards. Mid-run, the useful question is who is working.
		const manager = new WorkflowManager();
		const { ui, current } = fakeUi();
		registerTaskPanel(fakePi(), manager, ui);

		startRun(manager);
		runNode(manager, 1, "architect (architect)");
		runNode(manager, 2, "green (green)", { finish: false });

		expect(current()).toContain("green (green)");
		expect(current()).not.toMatch(/\d+\/\d+ done/);
	});

	it("reports the step count so a loop is visible as progress", () => {
		const manager = new WorkflowManager();
		const { ui, current } = fakeUi();
		registerTaskPanel(fakePi(), manager, ui);

		startRun(manager);
		runNode(manager, 1, "architect (architect)");
		runNode(manager, 2, "green (green)");
		runNode(manager, 3, "architect (architect)");

		expect(current()).toContain("step 3");
	});

	it("falls back to completed steps when nothing is running", () => {
		const manager = new WorkflowManager();
		const { ui, current } = fakeUi();
		registerTaskPanel(fakePi(), manager, ui);

		startRun(manager);
		runNode(manager, 1, "architect (architect)");

		expect(current()).toContain("1 step done");
	});

	it("surfaces errors in the status line", () => {
		const manager = new WorkflowManager();
		const { ui, current } = fakeUi();
		registerTaskPanel(fakePi(), manager, ui);

		startRun(manager);
		runNode(manager, 1, "green (green)", { status: "error" });

		expect(current()).toContain("1 err");
	});

	it("reports concurrent nodes as a count", () => {
		const manager = new WorkflowManager();
		const { ui, current } = fakeUi();
		registerTaskPanel(fakePi(), manager, ui);

		startRun(manager);
		runNode(manager, 1, "a", { finish: false });
		runNode(manager, 2, "b", { finish: false });

		expect(current()).toContain("2 running");
	});

	it("clears the status when the run finishes", () => {
		const manager = new WorkflowManager();
		const { ui, current } = fakeUi();
		registerTaskPanel(fakePi(), manager, ui);

		startRun(manager);
		runNode(manager, 1, "a");
		manager.completeRun("r1", "done");

		expect(current()).toBe("");
	});

	it("shows one human-only toast and relay notification on completion", () => {
		const manager = new WorkflowManager();
		const pi = fakePi();
		const { ui, notifications } = fakeUi();
		registerTaskPanel(pi, manager, ui);

		startRun(manager);
		runNode(manager, 1, "a", { tokens: 42 });
		manager.completeRun("r1", "done");

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toMatchObject({ type: "info" });
		expect(notifications[0].text).toContain('Workflow "tdd_feature" completed');
		expect(pi.events.emit).toHaveBeenCalledWith(
			"herdr-relay:publish",
			expect.objectContaining({
				namespace: "pi-workflow.dev",
				name: "workflow_completed",
				payload: expect.objectContaining({ runId: "r1", tokens: 42 }),
			}),
		);
	});

	it("replaces prior listeners when registered again after a session reload", () => {
		const manager = new WorkflowManager();
		const first = fakePi();
		const second = fakePi();
		const firstUi = fakeUi();
		const secondUi = fakeUi();
		registerTaskPanel(first, manager, firstUi.ui);
		registerTaskPanel(second, manager, secondUi.ui);

		startRun(manager);
		runNode(manager, 1, "a");
		manager.completeRun("r1", "done");

		expect(first.sendMessage).not.toHaveBeenCalled();
		expect(firstUi.notifications).toHaveLength(0);
		expect(secondUi.notifications).toHaveLength(1);
		expect(second.events.emit).toHaveBeenCalledTimes(1);
	});
});

describe("deliverResultSummary", () => {
	function completedRun(logs: string[] = []): ManagedRun {
		const manager = new WorkflowManager();
		manager.registerRun("r1", { name: "tdd_feature", description: "d" });
		for (const line of logs) manager.log("r1", line);
		manager.markAgentStart("r1", 0, { id: 1, label: "architect (architect)", prompt: "p", status: "running" });
		manager.markAgentEnd("r1", 1, "done", "contract", undefined, 500, 10);
		manager.markAgentStart("r1", 0, { id: 2, label: "green (green)", prompt: "p", status: "running" });
		manager.markAgentEnd("r1", 2, "done", "built", undefined, 700, 10);
		return manager.getRun("r1")!;
	}

	it("counts steps rather than agents", () => {
		// A graph that loops runs the same agent more than once, so "5
		// agents" would overstate how many distinct participants took part.
		const summary = deliverResultSummary(completedRun());

		expect(summary).toContain("2 steps");
		expect(summary).not.toContain("2 agents");
	});

	it("includes the path so loops are visible in the summary", () => {
		const summary = deliverResultSummary(
			completedRun(["Path: architect → green → architect → green"]),
		);

		expect(summary).toContain("Path: architect → green → architect → green");
	});

	it("omits the path line when none was logged", () => {
		expect(deliverResultSummary(completedRun())).not.toContain("Path:");
	});

	it("reports a failure with its reason", () => {
		const summary = deliverResultSummary(completedRun(), "technical failure: model unavailable");

		expect(summary).toContain("✗");
		expect(summary).toContain("model unavailable");
	});

	it("uses a singular step label for a one-node run", () => {
		const manager = new WorkflowManager();
		manager.registerRun("r1", { name: "solo", description: "d" });
		manager.markAgentStart("r1", 0, { id: 1, label: "only", prompt: "p", status: "running" });
		manager.markAgentEnd("r1", 1, "done", "ok", undefined, 10, 5);

		expect(deliverResultSummary(manager.getRun("r1")!)).toContain("1 step,");
	});
});
