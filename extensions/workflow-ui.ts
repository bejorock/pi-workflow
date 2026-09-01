/**
 * Interactive `/workflows` TUI navigator, modeled on Claude Code's view:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail
 *        ◀──esc───        ◀──esc────         ◀──esc────
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: p pause · x stop · r resume · s save workflow script · q quit
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowManager, PersistedRun, ManagedRun } from "./workflow-manager.ts";
import type { WorkflowAgentSnapshot, AgentHistoryEntry, WorkflowPhaseSnapshot } from "./workflow-display-types.ts";
import { saveWorkflowScript } from "./workflow-library.ts";

export type ViewKind = "runs" | "phases" | "agents" | "detail";

export interface StackFrame {
	kind: ViewKind;
	cursor: number;
	runId?: string;
	phase?: string;
	agentId?: number;
}

export class NavigatorState {
	private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
	scroll = 0;
	tailing = false;
	pagerOpen = false;
	private pageSize = 5;

	private top(): StackFrame {
		return this.stack[this.stack.length - 1];
	}

	get kind(): ViewKind {
		return this.top().kind;
	}

	get cursor(): number {
		return this.top().cursor;
	}

	set cursor(val: number) {
		this.top().cursor = val;
	}

	get runId(): string | undefined {
		return this.top().runId;
	}

	get phase(): string | undefined {
		return this.top().phase;
	}

	get agentId(): number | undefined {
		return this.top().agentId;
	}

	get depth(): number {
		return this.stack.length;
	}

	clamp(count: number): void {
		const t = this.top();
		t.cursor = count <= 0 ? 0 : Math.max(0, Math.min(t.cursor, count - 1));
	}

	move(delta: number, count: number): void {
		if (this.kind === "detail") {
			this.pagerOpen = true;
			if (delta < 0) this.tailing = false;
			this.scroll = Math.max(0, this.scroll + delta);
			return;
		}
		if (count <= 0) {
			this.cursor = 0;
			return;
		}
		const t = this.top();
		t.cursor = Math.max(0, Math.min(count - 1, t.cursor + delta));
	}

	setPageSize(rows: number): void {
		this.pageSize = Math.max(1, rows);
	}

	movePage(direction: -1 | 1 | "up" | "down", count: number, pageSize?: number): void {
		const dir = direction === "up" || direction === -1 ? -1 : 1;
		const delta = dir * (pageSize ?? Math.max(1, this.pageSize - 1));
		if (this.kind === "detail") {
			this.pagerOpen = true;
			if (dir < 0) this.tailing = false;
			this.scroll = Math.max(0, this.scroll + delta);
			return;
		}
		if (count > 0) this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
	}

	jump(edge: "start" | "end" | "top" | "bottom", count: number): void {
		const isEnd = edge === "end" || edge === "bottom";
		if (this.kind === "detail") {
			this.pagerOpen = true;
			this.tailing = isEnd;
			this.scroll = isEnd ? Number.MAX_SAFE_INTEGER : 0;
			return;
		}
		this.cursor = !isEnd || count <= 0 ? 0 : count - 1;
	}

	openPager(): boolean {
		if (this.kind !== "detail") return false;
		if (!this.pagerOpen) {
			this.pagerOpen = true;
			this.scroll = 0;
		}
		return true;
	}

	togglePager(): boolean {
		if (this.kind !== "detail") return false;
		if (!this.pagerOpen) return this.openPager();
		this.pagerOpen = false;
		this.scroll = 0;
		this.tailing = false;
		return false;
	}

	toggleTail(): boolean {
		if (this.kind !== "detail") return false;
		this.pagerOpen = true;
		this.tailing = !this.tailing;
		if (this.tailing) this.scroll = Number.MAX_SAFE_INTEGER;
		return this.tailing;
	}

	drill(model: NavigatorModel): boolean {
		const t = this.top();
		if (t.kind === "runs") {
			const runs = model.runs();
			if (t.cursor < runs.length) {
				const run = runs[t.cursor];
				if (!run) return false;

				// Graph runs have no phases, so the phase level would be a single
				// "(no phase)" row the user must click through to reach the nodes
				// they asked for. Skip straight to the node list when there is no
				// real phase structure to navigate.
				const phases = model.phases(run.runId);
				if (phases.length === 1 && phases[0].title === NO_PHASE_TITLE) {
					this.stack.push({
						kind: "agents",
						cursor: 0,
						runId: run.runId,
						phase: phases[0].title,
					});
					return true;
				}

				this.stack.push({ kind: "phases", cursor: 0, runId: run.runId });
				return true;
			}
			return false;
		}

		if (t.kind === "phases" && t.runId) {
			const phases = model.phases(t.runId);
			const ph = phases[t.cursor];
			if (!ph) return false;
			this.stack.push({ kind: "agents", cursor: 0, runId: t.runId, phase: ph.title });
			return true;
		}

		if (t.kind === "agents" && t.runId && t.phase) {
			const agents = model.agents(t.runId, t.phase);
			const ag = agents[t.cursor];
			if (!ag) return false;
			this.scroll = 0;
			this.tailing = false;
			this.pagerOpen = false;
			this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
			return true;
		}

		return false;
	}

	back(): boolean {
		if (this.kind === "detail" && this.pagerOpen) {
			this.pagerOpen = false;
			this.scroll = 0;
			this.tailing = false;
			return true;
		}
		if (this.stack.length <= 1) return false;
		this.stack.pop();
		this.scroll = 0;
		this.tailing = false;
		this.pagerOpen = false;
		return true;
	}
}

export interface RunRow {
	runId: string;
	name: string;
	status: string;
	done: number;
	total: number;
	totalTokens: number;
	durationMs: number;
}

export interface PhaseRow {
	title: string;
	done: number;
	total: number;
	tokens: number;
}

function asText(v: unknown): string {
	return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Render an agent's full result for the pager's Result section. Prefers the
 * untruncated `agent.result` (raw string output, or JSON-stringified for
 * non-string values) over `agent.resultPreview`, which is intentionally
 * clipped to ~60 characters for compact views and log lines.
 */
function fullResultText(agent: WorkflowAgentSnapshot): string {
	if (agent.result !== undefined && agent.result !== null) {
		return typeof agent.result === "string" ? agent.result : JSON.stringify(agent.result, null, 2);
	}
	return agent.resultPreview || "";
}

/**
 * Push a (possibly multi-line) block of text into `body` as separate rows.
 *
 * The navigator renderer treats every `body[]` element as exactly one
 * terminal row and draws box borders around it individually. If a single
 * element contains embedded "\n" characters (e.g. multi-line bash output,
 * pretty-printed JSON args, diffs), printing it breaks the box open and
 * spills raw text across the panel instead of staying inside the bordered
 * rows. This helper splits on newlines up front and caps very long blocks
 * so a single tool call/result can't blow out the whole pager.
 */
function pushTextBlock(body: string[], prefix: string, text: string, continuationIndent = "    ", maxLines = 20): void {
	const rawLines = text.split("\n");
	const lines = rawLines.length > maxLines ? rawLines.slice(0, maxLines) : rawLines;
	lines.forEach((line, i) => {
		body.push((i === 0 ? prefix : continuationIndent) + line);
	});
	if (rawLines.length > maxLines) {
		body.push(`${continuationIndent}\u2026 ${rawLines.length - maxLines} more line(s) truncated`);
	}
}

/**
 * Title used when a run has no phase structure at all.
 *
 * Graph runs are always in this state: a graph is a walk over nodes, not a
 * sequence of phases, so synthesising one would misrepresent a cyclic walk
 * as a pipeline.
 */
export const NO_PHASE_TITLE = "(no phase)";

function agentPhaseKey(a: WorkflowAgentSnapshot): string {
	return a.phase != null && String(a.phase).trim() ? asText(a.phase) : NO_PHASE_TITLE;
}

export class NavigatorModel {
	constructor(private manager: WorkflowManager) {}

	runs(): RunRow[] {
		return this.manager.listRuns().map((r) => {
			const agents = r.agents || [];
			const doneCount = agents.filter((a) => a.status === "done").length;
			return {
				runId: r.runId,
				name: asText(r.workflowName),
				status: asText(r.status),
				done: doneCount,
				total: agents.length,
				totalTokens: r.totalTokens || 0,
				durationMs: r.durationMs || 0,
			};
		});
	}

	phases(runId: string): PhaseRow[] {
		const live = this.manager.getRun(runId);
		const snap = live
			? live.snapshot
			: (() => {
					const p = this.manager.listRuns().find((r) => r.runId === runId);
					return p ? { phases: [] as WorkflowPhaseSnapshot[], agents: p.agents || [] } : undefined;
				})();

		if (!snap) return [];

		const rawPhases = Array.isArray(snap.phases)
			? snap.phases.map((p) => p.title || "")
			: [];
		const order: string[] = rawPhases.map(asText).filter(Boolean);
		const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
		const agents = Array.isArray(snap.agents) ? snap.agents : [];

		for (const a of agents) {
			const key = agentPhaseKey(a);
			if (!byPhase.has(key)) byPhase.set(key, []);
			byPhase.get(key)?.push(a);
			if (!order.includes(key)) order.push(key);
		}

		// Fallback: if no phases pre-declared and no agents yet, return a default phase row
		if (order.length === 0) {
			order.push(NO_PHASE_TITLE);
		}

		return order.map((title) => {
			const ags = byPhase.get(title) ?? [];
			const done = ags.filter((a) => a.status === "done").length;
			const tokens = ags.reduce((sum, a) => sum + (a.outputTokens || 0), 0);
			return {
				title,
				done,
				total: ags.length,
				tokens,
			};
		});
	}

	agents(runId: string, phase: string): WorkflowAgentSnapshot[] {
		const live = this.manager.getRun(runId);
		const snap = live
			? live.snapshot
			: (() => {
					const p = this.manager.listRuns().find((r) => r.runId === runId);
					return p ? { agents: p.agents || [] } : undefined;
				})();

		if (!snap || !Array.isArray(snap.agents)) return [];
		return snap.agents.filter((a) => agentPhaseKey(a) === phase);
	}

	agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined {
		const live = this.manager.getRun(runId);
		if (live) {
			return live.snapshot.agents.find((a) => a.id === agentId);
		}

		const persisted = this.manager.listRuns().find((r) => r.runId === runId);
		return persisted?.agents.find((a) => a.id === agentId);
	}
}

export type NavAction =
	| { type: "move"; delta: number }
	| { type: "page"; direction: -1 | 1 }
	| { type: "jump"; edge: "start" | "end" }
	| { type: "toggleTail" }
	| { type: "togglePager" }
	| { type: "openPager" }
	| { type: "drill" }
	| { type: "back" }
	| { type: "close" }
	| { type: "pause" }
	| { type: "stop" }
	| { type: "resume" }
	| { type: "save" }
	| { type: "none" };

export function keyToAction(data: string, kind: ViewKind): NavAction {
	const keyId = parseKey(data) || data;

	switch (keyId) {
		case "up":
		case "k":
			return { type: "move", delta: -1 };
		case "down":
		case "j":
			return { type: "move", delta: 1 };
		case "pageUp":
		case "ctrl+u":
		case "ctrl+b":
			return { type: "page", direction: -1 };
		case "pageDown":
		case "ctrl+d":
		case "ctrl+f":
			return { type: "page", direction: 1 };
		case "home":
		case "g":
			return { type: "jump", edge: "start" };
		case "end":
		case "G":
		case "shift+g":
			return { type: "jump", edge: "end" };
		case "t":
			return kind === "detail" ? { type: "toggleTail" } : { type: "none" };
		case "return":
		case "enter":
			if (kind === "detail") return { type: "togglePager" };
			return { type: "drill" };
		case "right":
		case "l":
			if (kind === "detail") return { type: "openPager" };
			return { type: "drill" };
		case "escape":
		case "esc":
		case "left":
		case "h":
			return { type: "back" };
		case "q":
			return { type: "close" };
		case "p":
			return { type: "pause" };
		case "x":
			return { type: "stop" };
		case "r":
			return { type: "resume" };
		case "s":
			return { type: "save" };
		default:
			return { type: "none" };
	}
}

// Box border constants (same as reference)
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

export type ThemeLike = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	bg?: (color: string, text: string) => string;
};

const PLAIN: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

/** Alias for backwards compat with tests */
export function renderNavigatorText(state: NavigatorState, model: NavigatorModel, width = 80, viewportRows = 24): string[] {
	return renderNavigatorFrame(state, model, width, PLAIN, viewportRows);
}

export function renderNavigatorFrame(
	state: NavigatorState,
	model: NavigatorModel,
	width: number,
	theme: ThemeLike = PLAIN,
	viewportRows = 24,
): string[] {
	const lines: string[] = [];
	state.setPageSize(Math.max(1, viewportRows - 5));
	const dim = (t: string) => theme.fg("dim", t);
	const accent = (t: string) => theme.fg("accent", t);
	const sel = (selected: boolean, text: string) =>
		selected ? accent(theme.bold(`❯ ${text}`)) : `  ${text}`;

	const pushScrollable = (body: string[]) => {
		const viewport = Math.max(1, viewportRows - 4);
		state.setPageSize(viewport);
		const maxScroll = Math.max(0, body.length - viewport);
		if (state.tailing) state.scroll = maxScroll;
		state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
		lines.push(...body.slice(state.scroll, state.scroll + viewport));
		if (body.length > viewport) {
			const end = Math.min(state.scroll + viewport, body.length);
			const up = state.scroll > 0 ? "↑" : " ";
			const down = end < body.length ? "↓" : " ";
			const mode = state.tailing ? " TAIL" : "";
			lines.push(dim(`  [${state.scroll + 1}-${end} / ${body.length}] ${up}${down}${mode}`));
		}
	};

	const pushCompact = (body: string[]) => {
		const viewport = Math.max(1, viewportRows - 3);
		if (body.length <= viewport) {
			lines.push(...body);
			return;
		}
		lines.push(...body.slice(0, Math.max(1, viewport - 1)));
		lines.push(dim("  … enter to open full pager"));
	};

	if (state.kind === "runs") {
		const runs = model.runs();
		state.clamp(runs.length);

		lines.push(theme.bold("Workflows"));

		if (runs.length === 0) {
			lines.push(dim("  No runs yet. Start a workflow."));
		} else {
			for (let i = 0; i < runs.length; i++) {
				const r = runs[i];
				const icon = STATUS_ICON[r.status] ?? "?";
				const meta = `${r.done}/${r.total}${r.totalTokens ? ` · ${compactTokens(r.totalTokens)}t` : ""}`;
				lines.push(sel(i === state.cursor, `${icon} ${r.name}  ${dim(`${r.runId.slice(0, 8)} · ${r.status} · ${meta}`)}`));
			}
		}

		lines.push("");
		lines.push(dim("↑/↓ select · enter open · p pause · x stop · r resume · s save · q quit"));

	} else if ((state.kind === "phases" || state.kind === "agents") && state.runId) {
		const phases = model.phases(state.runId);
		const inAgents = state.kind === "agents";
		let selPhaseIdx = inAgents ? phases.findIndex((p) => p.title === state.phase) : state.cursor;
		if (selPhaseIdx < 0) selPhaseIdx = 0;
		const selPhase = phases[selPhaseIdx];
		const agents = selPhase ? model.agents(state.runId, selPhase.title) : [];

		if (inAgents) state.clamp(agents.length);
		else state.clamp(phases.length);

		// Two-line header
		const runRow = model.runs().find((r) => r.runId === state.runId);
		const runName = runRow ? runRow.name : state.runId ?? "";
		lines.push(accent(theme.bold(truncateToWidth(runName, width))));
		const totalDone = phases.reduce((s, p) => s + p.done, 0);
		const totalAgents = phases.reduce((s, p) => s + p.total, 0);
		const headerUnit =
			phases.length === 1 && phases[0].title === NO_PHASE_TITLE ? "nodes" : "agents";
		lines.push(dim(`${runRow?.status ?? "running"}  ${totalDone}/${totalAgents} ${headerUnit}`));

		// Two-pane split
		const leftW = Math.max(16, Math.min(32, Math.floor(width * 0.36)));
		const rightW = width - leftW + 1;
		const leftInner = leftW - 2;
		const rightInner = rightW - 2;
		const bc = (s: string) => theme.fg("muted", s);
		const bodyCap = Math.max(1, viewportRows - 2 - 2 - 2);

		// Scroll windows
		const leftRows = scrollWindow(phases.length, inAgents ? selPhaseIdx : state.cursor, bodyCap);
		const rightRows = scrollWindow(agents.length, inAgents ? state.cursor : 0, bodyCap);
		const bodyRows = Math.max(1, Math.min(bodyCap, Math.max(leftRows.count, rightRows.count)));

		// Top rule with titles. A phaseless run is a graph walk, so the pane
		// is labelled by what it actually contains rather than by a phase name
		// that carries no information.
		const phaseless = selPhase?.title === NO_PHASE_TITLE;
		const unit = phaseless
			? `${agents.length} ${agents.length === 1 ? "node" : "nodes"}`
			: `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
		const rightTitle = phaseless ? unit : `${selPhase?.title ?? ""} · ${unit}`;
		const leftTitlePad = leftInner - 8;
		// A phaseless run gets one full-width pane: the phase column would
		// hold a single meaningless row and steal a third of the width from
		// the node list, which is the part worth reading.
		const fullInner = width - 2;
		const rightTitlePad = Math.max(
			0,
			(phaseless ? fullInner : rightInner) - visibleWidth(rightTitle) - 2,
		);
		lines.push(
			phaseless
				? bc(`┌`) + bc(`─ `) + dim(rightTitle) + bc(` ` + `─`.repeat(rightTitlePad)) + bc(`┐`)
				: bc(`┌`) + bc(`─`) + bc(` Phases `) + bc(`─`.repeat(Math.max(0, leftTitlePad))) +
					bc(`┬`) + bc(`─ `) + dim(rightTitle) + bc(` ` + `─`.repeat(rightTitlePad)) + bc(`┐`)
		);

		for (let k = 0; k < bodyRows; k++) {
			// Left cell
			let leftCell = " ".repeat(leftInner);
			const li = leftRows.start + k;
			if (li < phases.length) {
				const p = phases[li];
				const selected = !inAgents && li === state.cursor;
				const marker = selected ? theme.fg("accent", theme.bold("❯ ")) : "  ";
				const prog = p.total > 0 ? ` ${p.done}/${p.total}` : "";
				const nameW = leftInner - 2 - visibleWidth(prog);
				const name = truncateToWidth(p.title, Math.max(1, nameW));
				const nameStyled = selected ? theme.fg("accent", theme.bold(name)) : name;
				const progStyled = p.done === p.total && p.total > 0
					? theme.fg("success", prog)
					: p.done > 0 ? theme.fg("warning", prog) : dim(prog);
				leftCell = padRight(marker + nameStyled + progStyled, leftInner);
			}

			// Right cell
			let rightCell = " ".repeat(rightInner);
			const ri = rightRows.start + k;
			if (ri < agents.length) {
				const a = agents[ri];
				const selected = inAgents && ri === state.cursor;
				const marker = selected ? theme.fg("accent", theme.bold("❯ ")) : "  ";
				const dotColor = AGENT_DOT_COLOR[a.status] ?? "dim";
				const dot = theme.fg(dotColor, "●");
				const tokens = a.outputTokens ? dim(` ${compactTokens(a.outputTokens)}t`) : "";
				const modelTag = a.model ? dim(` [${asText(a.model)}]`) : "";
				const labelStyled = selected ? theme.fg("accent", theme.bold(asText(a.label))) : theme.fg("accent", asText(a.label));
				const cellWidth = phaseless ? fullInner : rightInner;
				// The routing target is the point of a graph view, so show it
				// when there is room rather than truncating it away.
				const preview =
					phaseless && a.resultPreview ? dim(`  ${asText(a.resultPreview)}`) : "";
				rightCell = padRight(
					marker + dot + " " + labelStyled + tokens + modelTag + preview,
					cellWidth,
				);
			} else if (k === 0 && agents.length === 0) {
				rightCell = padRight(dim(phaseless ? "  no nodes" : "  no agents"), phaseless ? fullInner : rightInner);
			} else if (phaseless) {
				rightCell = " ".repeat(fullInner);
			}

			lines.push(
				phaseless
					? bc("│") + rightCell + bc("│")
					: bc("│") + leftCell + bc("│") + rightCell + bc("│"),
			);
		}

		lines.push(
			phaseless
				? bc(`└`) + bc(`─`.repeat(fullInner)) + bc(`┘`)
				: bc(`└`) + bc(`─`.repeat(leftInner)) + bc(`┴`) + bc(`─`.repeat(rightInner)) + bc(`┘`),
		);
		lines.push("");
		lines.push(dim(
			inAgents
				? "enter open detail · esc back · ↑/↓ select · s save · q quit"
				: "enter select phase · esc back · ↑/↓ select · s save · q quit"
		));

	} else if (state.kind === "detail" && state.runId && state.agentId !== undefined) {
		const agent = model.agentDetail(state.runId, state.agentId);
		lines.push(theme.bold(agent ? asText(agent.label) : "agent"));

		if (agent) {
			const body: string[] = [];
			if (state.pagerOpen) {
				body.push(dim("Status: ") + asText(agent.status ?? ""));
				if (agent.model) body.push(dim("Model:  ") + asText(agent.model));
				if (agent.outputTokens) body.push(dim("Tokens: ") + String(agent.outputTokens));
				if (agent.sessionId) body.push(dim("Session: ") + asText(path.basename(agent.sessionId)));
				if (agent.error) body.push(dim("Error:  ") + theme.fg("error", asText(agent.error)));
				body.push("");
				body.push(accent(theme.bold("Prompt:")));
				pushTextBlock(body, "  ", asText(agent.prompt || ""));
				body.push("");
				body.push(accent(theme.bold("Result:")));
				// Render the full stored result (not the truncated resultPreview) in
				// the full pager view — there is room to show the complete agent
				// output here, whereas resultPreview is intentionally clipped to ~60
				// chars for compact views/log lines.
				const resultText = agent.error
					? theme.fg("error", asText(agent.error))
					: asText(fullResultText(agent) || "(no result yet)");
				pushTextBlock(body, "  ", resultText, "  ", 200);
				if (agent.history && agent.history.length > 0) {
					body.push("");
					body.push(accent(theme.bold("History:")));
					for (const entry of agent.history) {
						if (entry.role === "assistant" && entry.kind === "toolCall") {
							const argsText = entry.args ? ` ${entry.args}` : "";
							pushTextBlock(body, dim(`  → ${entry.toolName}:`), argsText, "      ", 10);
						} else if (entry.role === "assistant" && entry.kind === "thinking") {
							pushTextBlock(body, dim("  [think] "), asText(entry.text || ""), "      ", 20);
						} else if (entry.role === "tool" || entry.role === "toolResult") {
							const errorTag = "isError" in entry && entry.isError ? theme.fg("error", " [error]") : "";
							pushTextBlock(body, dim(`  ← ${entry.toolName}:`) + errorTag + " ", asText(entry.text || ""), "      ", 20);
							if (entry.diff) pushTextBlock(body, dim("  diff: "), entry.diff, "      ", 20);
						} else if (entry.role === "assistant") {
							pushTextBlock(body, dim("  [assistant] "), asText(entry.text || ""), "      ", 20);
						} else if (entry.role === "user") {
							pushTextBlock(body, dim("  [user] "), asText(entry.text || ""), "      ", 20);
						} else {
							const roleLabel = (entry as { role?: string }).role ?? "event";
							pushTextBlock(body, dim(`  [${roleLabel}] `), asText((entry as { text?: string }).text || ""), "      ", 20);
						}
					}
				}
				pushScrollable(body);
			} else {
				// Compact view
				body.push(dim("Status: ") + asText(agent.status ?? ""));
				if (agent.model) body.push(dim("Model:  ") + asText(agent.model));
				if (agent.error) body.push(dim("Error:  ") + theme.fg("error", asText(agent.error)));
				body.push("");
				body.push(accent(theme.bold("Prompt:")));
				const promptLines = asText(agent.prompt || "").split("\n");
				for (const line of promptLines.slice(0, 5)) body.push("  " + line);
				if (promptLines.length > 5) body.push(dim("  … prompt continues in pager"));
				body.push("");
				body.push(accent(theme.bold("Result:")));
				const resultText = agent.error
					? theme.fg("error", asText(agent.error))
					: asText(agent.resultPreview || "(running…)");
				const compactResultLines = resultText.split("\n");
				for (const line of compactResultLines.slice(0, 4)) body.push("  " + line);
				if (compactResultLines.length > 4) body.push(dim("  … result continues in pager"));
				pushCompact(body);
			}
		}
		lines.push("");
		lines.push(dim(state.pagerOpen
			? "↑/↓ scroll · g/G ends · t tail · enter close pager · esc back"
			: "enter open pager · t tail · s save workflow · esc back · q quit"
		));
	}

	return lines;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
	running: "◆",
	paused: "⏸",
	completed: "✓",
	stopped: "⊘",
	cancelled: "⊘",
	error: "✗",
	failed: "✗",
};

const AGENT_DOT_COLOR: Record<string, string> = {
	running: "warning",
	queued: "dim",
	pending: "dim",
	done: "success",
	completed: "success",
	error: "error",
	failed: "error",
	skipped: "dim",
	cached: "dim",
};

function compactTokens(t: number): string {
	if (!t || t <= 0) return "0";
	if (t < 1000) return String(Math.round(t));
	if (t < 1_000_000) {
		const k = t / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return `${(t / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function scrollWindow(total: number, active: number, cap: number): { start: number; count: number; more: boolean } {
	if (total <= cap) return { start: 0, count: total, more: false };
	let start = Math.max(0, Math.min(active - Math.floor(cap / 2), total - cap));
	if (active < start) start = active;
	if (active >= start + cap) start = active - cap + 1;
	return { start, count: cap, more: start + cap < total };
}

/**
 * Save the workflow script for a given run to the project-local library
 * (.pi-workflow/workflows/<meta.name>.js), so it can be re-run later via
 * the workflow tool's `loadWorkflow` parameter without rewriting it.
 *
 * The raw script text is only kept in-memory on the ManagedRun (see
 * WorkflowManager.registerRun/getRunSource) — it is intentionally never
 * written to the journal (only a hash is, for cache invalidation), so this
 * only works for runs still tracked live in this process, not ones
 * restored purely from a persisted journal after a restart.
 */
export async function saveRunWorkflow(manager: WorkflowManager, runId: string, ui: ExtensionUIContext): Promise<void> {
	const run = manager.getRun(runId);
	const source = manager.getRunSource(runId);
	if (!source) {
		ui.notify(
			run
				? "Can't save this workflow: its script is no longer available in memory (only possible right after it starts in this session)."
				: "Can't save this workflow: it's a persisted run from a prior session, and only a hash of its script (not the script itself) is stored in the journal.",
			"warning",
		);
		return;
	}
	const meta = run?.snapshot.meta;
	if (!meta) {
		ui.notify("Can't save this workflow: missing metadata.", "warning");
		return;
	}
	try {
		const saved = saveWorkflowScript(source.cwd, source.script, meta);
		ui.notify(`Saved workflow "${saved.name}" — rerun it anytime with loadWorkflow: "${saved.name}".`, "info");
	} catch (err) {
		ui.notify(`Failed to save workflow: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

export function openWorkflowNavigator(
	_pi: ExtensionAPI,
	manager: WorkflowManager,
	ui: ExtensionUIContext,
): Promise<void> {
	const model = new NavigatorModel(manager);
	const state = new NavigatorState();

	return ui.custom<void>(
		(tui: TUI, theme: Theme, _keybindings, done: (r: undefined) => void) => {
			const rerender = () => tui.requestRender();

			// 125ms Debounce timer for high-frequency history updates
			let historyRenderTimer: ReturnType<typeof setTimeout> | undefined;
			const onHistoryEvent = () => {
				if (historyRenderTimer) return;
				historyRenderTimer = setTimeout(() => {
					historyRenderTimer = undefined;
					rerender();
				}, 125);
			};

			const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
			const onEvent = () => rerender();
			for (const ev of events) manager.on(ev, onEvent);
			manager.on("agentHistory", onHistoryEvent);

			const cleanup = () => {
				for (const ev of events) manager.off(ev, onEvent);
				manager.off("agentHistory", onHistoryEvent);
				if (historyRenderTimer) clearTimeout(historyRenderTimer);
			};

			let _focused = false;
			const component = {
				get focused(): boolean { return _focused; },
				set focused(v: boolean) { _focused = v; },

				render(width: number): string[] {
					const themeAdapter: ThemeLike = {
						fg: (color, s) => theme.fg(color as Parameters<Theme["fg"]>[0], s),
						bold: (s) => theme.bold(s),
						bg: (color, s) => theme.bg(color as Parameters<Theme["bg"]>[0], s),
					};
					const borderColor = (s: string) => _focused ? theme.fg("accent", s) : theme.fg("borderMuted", s);
					const titleColor = (s: string) => _focused ? theme.fg("dim", theme.bold(s)) : theme.fg("muted", s);
					const bgColor = (s: string) => theme.bg("customMessageBg", s) ?? s;
					const innerWidth = Math.max(10, width - BOX_BORDER_OVERHEAD);
					const terminalRows = tui.terminal?.rows ?? 24;
					const overlayRows = Math.max(8, Math.floor(terminalRows * 0.92));
					const contentRows = Math.max(6, overlayRows - 2);
					const raw = renderNavigatorFrame(state, model, innerWidth, themeAdapter, contentRows);
					const title = titleColor(" workflows ");
					const dashes = (n: number) => "\u2500".repeat(Math.max(0, n));
					const topBorder = borderColor("\u256d\u2500") + title + borderColor(dashes(innerWidth - 10)) + borderColor("\u256e");
					const botBorder = borderColor(`\u2570${dashes(innerWidth + 2)}\u256f`);
					const wrapAndBg = (line: string) => {
						const padded = truncateToWidth(line, innerWidth, "", true);
						const fullLine = borderColor(BOX_BORDER_LEFT) + padded + borderColor(BOX_BORDER_RIGHT);
						const trailingPad = width - visibleWidth(fullLine);
						return bgColor(fullLine + (trailingPad > 0 ? " ".repeat(trailingPad) : ""));
					};
					return [bgColor(topBorder), ...raw.map(wrapAndBg), bgColor(botBorder)];
				},

				handleInput(data: string): void {
					const runs = model.runs();
					const count =
						state.kind === "runs"
							? runs.length
							: state.kind === "phases" && state.runId
								? model.phases(state.runId).length
								: state.kind === "agents" && state.runId && state.phase
									? model.agents(state.runId, state.phase).length
									: 1;

					const action = keyToAction(data, state.kind);

					switch (action.type) {
						case "move":
							state.move(action.delta || 0, count);
							rerender();
							break;
						case "page":
							state.movePage(action.direction || 1, count);
							rerender();
							break;
						case "jump":
							state.jump(action.edge || "start", count);
							rerender();
							break;
						case "drill":
							state.drill(model);
							rerender();
							break;
						case "back":
							if (!state.back()) {
								cleanup();
								done(undefined);
							} else {
								rerender();
							}
							break;
						case "close":
							cleanup();
							done(undefined);
							break;
						case "stop": {
							const targetRunId = state.kind === "runs" ? runs[state.cursor]?.runId : state.runId;
							if (targetRunId) manager.stopRun(targetRunId);
							rerender();
							break;
						}
						case "pause": {
							const targetRunId = state.kind === "runs" ? runs[state.cursor]?.runId : state.runId;
							if (targetRunId) manager.pauseRun(targetRunId);
							rerender();
							break;
						}
						case "resume": {
							const targetRunId = state.kind === "runs" ? runs[state.cursor]?.runId : state.runId;
							if (targetRunId) manager.resumeRun(targetRunId);
							rerender();
							break;
						}
						case "save": {
							const targetRunId = state.kind === "runs" ? runs[state.cursor]?.runId : state.runId;
							if (targetRunId) void saveRunWorkflow(manager, targetRunId, ui);
							break;
						}
						case "toggleTail":
							state.toggleTail();
							rerender();
							break;
						case "togglePager":
							state.togglePager();
							rerender();
							break;
						case "openPager":
							state.openPager();
							rerender();
							break;
					}
				},

				invalidate(): void {
					rerender();
				},
				dispose(): void {
					cleanup();
				},
			};
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "94%",
				maxHeight: "92%",
				margin: 1,
			},
		},
	);
}

function statusIcon(status: string): string {
	switch (status) {
		case "running":
			return "▶";
		case "paused":
			return "⏸";
		case "completed":
			return "✓";
		case "stopped":
		case "cancelled":
			return "⊘";
		case "error":
			return "✗";
		default:
			return "·";
	}
}

function agentStatusIcon(status: string): string {
	switch (status) {
		case "running":
			return "●";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "cached":
			return "⟳";
		default:
			return "○";
	}
}

function padRight(str: string, len: number): string {
	const w = visibleWidth(str);
	return w >= len ? str : str + " ".repeat(len - w);
}
