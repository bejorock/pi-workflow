/** Foreground ownership over the existing background graph engine. */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RequestBroker, PendingRequest } from "./request-broker.ts";
import type { WorkflowManager } from "./workflow-manager.ts";
import type { DeliverableRun } from "./result-delivery.ts";

interface ControlledRun {
	runId: string; name: string; abort: AbortController; done?: Promise<unknown>;
	report?: DeliverableRun; completed: boolean; delivered: boolean; waiting: boolean;
}
export interface ControllerReply {
	text: string; status: "completed" | "supervisor" | "stopped" | "already_delivered";
	requestIds?: string[];
}
export class WorkflowController {
	private runs = new Map<string, ControlledRun>();
	constructor(readonly manager: WorkflowManager, readonly broker?: RequestBroker) {
		manager.on("stopped", ({ runId }: { runId: string }) => {
			if (this.owns(runId)) this.broker?.cancelRun(runId, "Workflow stopped.");
		});
	}

	begin(runId: string, name: string, abort: AbortController): void {
		const active = [...this.runs.values()].find(r => !r.completed || r.waiting);
		if (active) throw new Error(`Only one active workflow is allowed. Run ${active.runId} (${active.name}) is still active; reply and workflow_wait, or stop it first.`);
		this.runs.set(runId, { runId, name, abort, completed: false, delivered: false, waiting: false });
		// Controlled requests deliberately have no wall-clock expiry: investigation
		// may take longer than ten minutes. Idle reminders escalate to a human.
		this.broker?.holdSupervisorExpiry(runId, true);
	}
	owns(runId: string): boolean { return this.runs.has(runId); }
	hasWaiter(runId: string): boolean { return this.runs.get(runId)?.waiting === true; }
	activeRunId(): string | undefined { return [...this.runs.values()].find(r => !r.completed)?.runId; }
	setDone(runId: string, done: Promise<unknown>): void { const run = this.runs.get(runId); if (run) run.done = done; }
	complete(report: DeliverableRun): void {
		const run = this.runs.get(report.runId); if (!run) return;
		run.report = report; run.completed = true;
		this.broker?.cancelRun(run.runId, "Workflow execution settled.");
		this.broker?.holdSupervisorExpiry(run.runId, false);
	}
	stop(runId: string): void {
		const run = this.runs.get(runId); if (!run || run.completed) return;
		run.abort.abort(); this.manager.stopRun(runId);
		this.broker?.cancelRun(runId, "Workflow interrupted.");
	}
	stopAll(): void { for (const run of this.runs.values()) this.stop(run.runId); }
	/** Used only by the idle fallback. Taking a report is exclusive with wait(). */
	takeUndeliveredReports(): DeliverableRun[] {
		const reports: DeliverableRun[] = [];
		for (const run of this.runs.values()) if (run.completed && !run.waiting && !run.delivered && run.report) {
			run.delivered = true; reports.push(run.report);
		}
		return reports;
	}
	async wait(runId: string | undefined, signal?: AbortSignal): Promise<ControllerReply> {
		const id = runId ?? this.activeRunId() ?? [...this.runs.keys()].at(-1);
		const run = id ? this.runs.get(id) : undefined;
		if (!run) throw new Error("No controlled workflow found. Supply the runId returned by workflow.");
		if (run.waiting) throw new Error(`A foreground controller is already waiting on ${run.runId}.`);
		run.waiting = true;
		let interrupted = false;
		const abort = () => { interrupted = true; this.stop(run.runId); };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			for (;;) {
				if (interrupted) {
					await run.done;
					run.delivered = true;
					return { status: "stopped", text: run.report?.text ?? `Workflow ${run.runId} stopped by interruption.` };
				}
				if (run.completed) {
					if (run.delivered) return { status: "already_delivered", text: `Workflow ${run.runId} has finished; its report was already delivered. Use workflow_status for inspection.` };
					run.delivered = true;
					return { status: "completed", text: run.report!.text };
				}
				const pending = this.broker?.listPendingForRun(run.runId).filter(r => r.kind === "supervisor" && r.expectsReply) ?? [];
				if (pending.length) {
					const sections = pending.map(request => {
						if (request.inlineDelivered) return `Request ${request.id} remains unanswered (question already delivered).`;
						this.broker!.markInlineDelivered(request.id);
						return `[workflow-agent-question · requestId: ${request.id} · runId: ${run.runId}]\nAgent: ${request.agent ?? request.nodeId ?? "workflow agent"}\nQuestion: ${request.questions.map(q => q.question).join("\n")}`;
					});
					return { status: "supervisor", requestIds: pending.map(r => r.id), text: sections.join("\n\n") +
						`\n\nMANDATORY: Answer every request using workflow_reply(requestId, answer), not prose. Then immediately call workflow_wait({ runId: "${run.runId}" }). The workflow remains active and owns the only slot.` };
				}
				await new Promise(resolve => setTimeout(resolve, 25));
			}
		} finally {
			run.waiting = false;
			signal?.removeEventListener("abort", abort);
		}
	}
}

export function createWorkflowWaitTool(controller: WorkflowController) {
	return defineTool({ name: "workflow_wait", label: "Workflow Wait",
		description: "Wait for the active workflow's final report or supervisor questions. Call immediately after workflow_reply. Interrupting this tool stops the workflow.",
		parameters: Type.Object({ runId: Type.Optional(Type.String({ description: "Workflow identity; defaults to the active workflow." })) }),
		async execute(_id, params, signal) {
			const result = await controller.wait(params.runId, signal);
			return { content: [{ type: "text" as const, text: result.text }], details: { ...result, runId: params.runId ?? controller.activeRunId() } };
		},
	});
}

/** Idle-only fallback and bounded per-request reminders. No modal escalation. */
export class SupervisorReminders {
	private idleAt: number | undefined;
	private pausedAt: number | undefined;
	private tracked = new Map<string, { count: number; eligibleAt: number; exhausted: boolean }>();
	private escalations = new Set<string>();
	private lastTick: number | undefined;
	constructor(private broker: RequestBroker, private controller: WorkflowController,
		private send: (text: string, requests: PendingRequest[], reminder: boolean) => void,
		private notify: (text: string) => void, readonly graceMs = 30_000) {}
	busy(now = Date.now()): void {
		this.idleAt = undefined;
		this.broker.setSupervisorBusy(true);
		this.pausedAt ??= now;
	}
	settled(now = Date.now()): void {
		// Preserve the existing timeout for standalone subagents, but suspend
		// its clock while the supervisor is working rather than expiring mid-search.
		this.broker.setSupervisorBusy(false);
		this.pausedAt = undefined; this.idleAt = now;
	}
	tick(now = Date.now()): void {
		if (this.idleAt === undefined && this.lastTick !== undefined) this.broker.extendSupervisorExpiry(Math.max(0, now - this.lastTick));
		this.lastTick = now;
		const pending = this.broker.listPending().filter(r => r.kind === "supervisor" && r.expectsReply);
		const ids = new Set(pending.map(r => r.id));
		for (const id of this.tracked.keys()) if (!ids.has(id)) this.tracked.delete(id);
		for (const id of this.escalations) if (!ids.has(id)) this.escalations.delete(id);
		// Undelivered requests are handled by the sink if no waiter exists.
		for (const request of pending) if (request.inlineDelivered && !this.tracked.has(request.id) && !this.escalations.has(request.id)) {
			this.tracked.set(request.id, { count: 0, eligibleAt: now, exhausted: false });
		}
		if (this.idleAt === undefined || now - this.idleAt < this.graceMs) return;
		const undelivered = pending.filter(r => !r.inlineDelivered && !this.controller.hasWaiter(r.runId));
		if (undelivered.length) {
			for (const r of undelivered) this.broker.markInlineDelivered(r.id);
			this.send(undelivered.map(r => `[workflow-agent-question · requestId: ${r.id} · runId: ${r.runId}]\n${r.questions.map(q => q.question).join("\n")}\nAnswer via workflow_reply, then workflow_wait.`).join("\n\n"), undelivered, false);
			this.busy(now); return;
		}
		const due = pending.filter(r => {
			const t = this.tracked.get(r.id);
			return t && !this.controller.hasWaiter(r.runId) && now - Math.max(this.idleAt!, t.eligibleAt) >= this.graceMs;
		});
		const reminders = due.filter(r => !this.tracked.get(r.id)!.exhausted);
		if (reminders.length) {
			for (const r of reminders) { const t = this.tracked.get(r.id)!; t.count++; t.eligibleAt = now; if (t.count === 3) t.exhausted = true; }
			this.send(reminders.map(r => `Request ${r.id} (run ${r.runId}) still needs workflow_reply. Reminder ${this.tracked.get(r.id)!.count}/3.`).join("\n") +
				"\nAnswer with workflow_reply, then immediately call workflow_wait for a controlled workflow.", reminders, true);
			this.busy(now); // Give this follow-up a turn before scheduling anything else.
			return;
		}
		for (const r of due) if (this.tracked.get(r.id)!.exhausted) {
			this.tracked.delete(r.id); this.escalations.add(r.id);
			this.notify(`Workflow ${r.runId} is waiting for supervisor request ${r.id} after three reminders. You may remind the agent manually.`);
		}
		for (const report of this.controller.takeUndeliveredReports()) this.send(report.text, [], false);
	}
	clear(): void { this.tracked.clear(); this.escalations.clear(); this.idleAt = undefined; this.pausedAt = undefined; this.lastTick = undefined; this.broker.setSupervisorBusy(false); }
}
