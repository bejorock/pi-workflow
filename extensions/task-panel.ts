/**
 * Human-only completion toasts and optional relay notifications.
 * Progress belongs to foreground tools and /runs, not a persistent widget.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { runKindLabel, type WorkflowManager, type ManagedRun } from "./workflow-manager.ts";
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
 * Register human-only completion listeners (no progress widget).
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

	// Clear legacy widget keys on reload; foreground tools and /runs own progress.
	for (const run of manager.listActiveRuns()) ui.setStatus(`wf:${run.runId}`, undefined);

	const onComplete = (e: { runId: string; result?: unknown; error?: string }) => {
		if (!e?.runId) return;
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


	manager.on("complete", onComplete);
	manager.on("error", onComplete);
	manager.on("stopped", onComplete);

	const cleanup = () => {
		manager.off("complete", onComplete);
		manager.off("error", onComplete);
		manager.off("stopped", onComplete);

		if (holder.cleanup === cleanup) holder.cleanup = undefined;
	};
	holder.cleanup = cleanup;
	return cleanup;
}

/**
 * Format a completed run for a human notification.
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

	const kind = runKindLabel(run.runKind);
	if (error) {
		return `✗ ${kind} "${name}" failed after ${duration}s (${scale}):\n\nError: ${error}`;
	}

	// The path shows where work actually went, including any loops back.
	const pathLog = run.snapshot.logs.find((line) => line.startsWith("Path: "));
	const pathLine = pathLog ? `\n${pathLog}\n` : "";

	const summaryText = renderWorkflowText(run.snapshot, { compact: true });
	return `✓ ${kind} "${name}" completed in ${duration}s (${scale}).\n${pathLine}\n${summaryText}`;
}
