/**
 * Background-run UX task panel:
 *  - Displays a live status bar under the chat input while dynamic workflows run.
 *  - Automatically updates as agents start, complete, or report progress.
 *  - Shows a human-only completion toast and optional relay notification when background runs finish.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager, ManagedRun } from "./workflow-manager.ts";
import { renderWorkflowText } from "./workflow-display.ts";

export interface TaskPanelOptions {
	cwd?: string;
}

interface TaskPanelHolder {
	cleanup?: () => void;
}

function holderOf(manager: WorkflowManager): TaskPanelHolder {
	return manager as unknown as TaskPanelHolder;
}

/**
 * Register background task panel listeners and status line updates.
 *
 * The workflow manager survives Pi reload/session replacement, while a TUI
 * context does not. Replace the old listeners before installing this
 * generation's listeners so a completed run has one compact panel notice.
 */
export function registerTaskPanel(
	pi: ExtensionAPI,
	manager: WorkflowManager,
	ui: ExtensionUIContext,
	_opts: TaskPanelOptions = {},
): () => void {
	const holder = holderOf(manager);
	holder.cleanup?.();

	const activeKeys = new Set<string>();

	const updateStatus = (runId: string) => {
		const run = manager.getRun(runId);
		if (!run) return;

		const key = `wf:${runId}`;
		if (run.status === "running") {
			activeKeys.add(key);
			const agents = run.snapshot.agents;
			const done = agents.filter((a) => a.status === "done").length;
			const errors = agents.filter((a) => a.status === "error").length;
			const active = agents.filter((a) => a.status === "running");

			// A graph reports which node is running rather than a completion
			// ratio. "3/5" implies a pipeline with a known end; a graph revisits
			// nodes, so the denominator grows as it runs and the fraction can
			// appear to go backwards. The useful question mid-run is "who is
			// working now", and after a loop, "how many steps has this taken".
			const position =
				active.length === 1
					? `${active[0].label}`
					: active.length > 1
						? `${active.length} running`
						: `${done} step${done === 1 ? "" : "s"} done`;

			const errorPart = errors ? `, ${errors} err` : "";
			const statusText = `▶ ${run.snapshot.meta.name}: ${position}${errorPart} · step ${agents.length} · ${run.snapshot.totalTokens}t`;
			ui.setStatus(key, statusText);
		} else {
			ui.setStatus(key, undefined);
			activeKeys.delete(key);
		}
	};

	const onRunEvent = (e: { runId: string }) => {
		if (e?.runId) updateStatus(e.runId);
	};

	const onComplete = (e: { runId: string; result?: unknown; error?: string }) => {
		if (!e?.runId) return;
		updateStatus(e.runId);

		const run = manager.getRun(e.runId);
		if (!run) return;

		const failed = Boolean(e.error) || run.status !== "completed";
		const text = deliverResultSummary(run, failed ? (e.error ?? "workflow stopped") : undefined);
		ui.notify(text, failed ? "error" : "info");

		// The relay hook is optional. This namespaced, bounded notification is
		// for a future mobile client and never creates transcript/LLM context.
		try {
			pi.events.emit("herdr-relay:publish", {
				namespace: "pi-workflow.dev",
				name: failed ? "workflow_failed" : "workflow_completed",
				payload: {
					runId: e.runId,
					name: run.snapshot.meta.name || "workflow",
					status: failed ? run.status : "completed",
					steps: run.snapshot.agents.length,
					tokens: run.snapshot.totalTokens,
					durationMs: run.snapshot.durationMs,
				},
			});
		} catch {
			// No relay hook / stale extension must not affect workflow reporting.
		}
	};

	const events = ["agentStart", "agentEnd", "phase", "log", "paused", "resumed"];
	// agentStart fires per node visit, so a revisited node refreshes the
	// panel and the running label tracks the walk rather than freezing on the
	// first occurrence.
	for (const ev of events) {
		manager.on(ev, onRunEvent);
	}
	manager.on("complete", onComplete);
	manager.on("error", onComplete);
	manager.on("stopped", onComplete);

	const cleanup = () => {
		for (const ev of events) {
			manager.off(ev, onRunEvent);
		}
		manager.off("complete", onComplete);
		manager.off("error", onComplete);
		manager.off("stopped", onComplete);

		for (const key of activeKeys) {
			ui.setStatus(key, undefined);
		}
		activeKeys.clear();
		if (holder.cleanup === cleanup) holder.cleanup = undefined;
	};
	holder.cleanup = cleanup;
	return cleanup;
}

/**
 * Format a completed workflow run result for conversation delivery.
 */
export function deliverResultSummary(run: ManagedRun, error?: string): string {
	const name = run.snapshot.meta.name || "workflow";
	const duration = (run.snapshot.durationMs / 1000).toFixed(1);
	const steps = run.snapshot.agents.length;
	const tokens = run.snapshot.totalTokens;

	// Counted as steps rather than agents: a graph that loops runs the same
	// agent more than once, so "5 agents" would overstate how many distinct
	// participants were involved.
	const scale = `${steps} step${steps === 1 ? "" : "s"}, ${tokens}t`;

	if (error) {
		return `✗ Workflow "${name}" failed after ${duration}s (${scale}):\n\nError: ${error}`;
	}

	// The path shows where work actually went, including any loops back.
	const pathLog = run.snapshot.logs.find((line) => line.startsWith("Path: "));
	const pathLine = pathLog ? `\n${pathLog}\n` : "";

	const summaryText = renderWorkflowText(run.snapshot, { compact: true });
	return `✓ Workflow "${name}" completed in ${duration}s (${scale}).\n${pathLine}\n${summaryText}`;
}
