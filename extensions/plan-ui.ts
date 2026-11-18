/**
 * /plans TUI navigator — styled panel identical to /workflows.
 *
 * Two-level view:
 *   list ──enter/→──▶ reader
 *        ◀──esc/←────
 *
 * Keys: ↑/↓ (j/k) navigate · enter/→ open · esc/← back · r refresh · q quit
 * In reader: ↑/↓ (j/k) scroll · esc/← back to list · q quit
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DocumentReader } from "./document-reader.ts";
import { listAllPlans, plansDir, type PlanMeta } from "./plan-tool.ts";

// ── Box drawing (matches workflow-ui.ts) ────────────────────────────────
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

// ── State ────────────────────────────────────────────────────────────────

type ViewKind = "list" | "reader";

interface NavState {
	view: ViewKind;
	cursor: number;
	scroll: number;
	plans: PlanMeta[];
	selectedId: string | null;
	selectedContent: string | null;
}

function freshState(cwd: string): NavState {
	return {
		view: "list",
		cursor: 0,
		scroll: 0,
		plans: listAllPlans(cwd),
		selectedId: null,
		selectedContent: null,
	};
}

function readPlanContent(cwd: string, id: string): string {
	try {
		return fs.readFileSync(path.join(plansDir(cwd), `${id}.md`), "utf-8");
	} catch {
		return "(Could not read plan content.)";
	}
}

// ── Content rendering (inner lines, no border) ───────────────────────────

function renderListContent(state: NavState, innerWidth: number, contentRows: number): string[] {
	const lines: string[] = [];

	if (state.plans.length === 0) {
		lines.push("");
		lines.push("No plans yet.");
		lines.push("");
		lines.push('Use the plan tool: plan(action: "create", name: "...", content: "...")');
		return lines;
	}

	lines.push("↑/↓ navigate  · enter open  · r refresh  · q quit");
	lines.push("");

	const idW = 28;
	const nameW = Math.max(10, innerWidth - idW - 14); // 14 = "  " + "  " + date(10)
	const header = "ID".padEnd(idW) + "  " + "NAME".padEnd(nameW) + "  UPDATED";
	lines.push(header);
	lines.push("─".repeat(Math.min(innerWidth, header.length)));

	const maxVisible = Math.max(1, contentRows - lines.length);
	const start = Math.max(0, state.cursor - Math.floor(maxVisible / 2));
	const slice = state.plans.slice(start, start + maxVisible);

	for (let i = 0; i < slice.length; i++) {
		const p = slice[i];
		const idx = start + i;
		const selected = idx === state.cursor;
		const idCol = truncateToWidth(p.id, idW).padEnd(idW);
		const nameCol = truncateToWidth(p.name, nameW).padEnd(nameW);
		const updated = p.updatedAt.slice(0, 10);
		const row = `${idCol}  ${nameCol}  ${updated}`;
		lines.push(selected ? `\x1b[7m${truncateToWidth(row, innerWidth)}\x1b[0m` : row);
	}

	return lines;
}

function renderReaderContent(state: NavState, reader: DocumentReader, innerWidth: number, contentRows: number): string[] {
	const plan = state.plans.find(p => p.id === state.selectedId);
	const result = reader.render(state.selectedContent ?? "", [
		`📄 ${state.selectedId ?? ""}.md`,
		...(plan ? [`Updated: ${plan.updatedAt.slice(0, 10)} · ${plan.sizeBytes} bytes`] : []),
	], innerWidth, contentRows, state.scroll);
	state.scroll = result.scroll;
	return result.lines;
}

// ── Key handling ─────────────────────────────────────────────────────────

function handleKey(
	data: string,
	state: NavState,
	cwd: string,
): { state: NavState; close: boolean } {
	const key = parseKey(data) ?? data;

	if (key === "q" || ((key === "escape" || key === "esc") && state.view === "list")) {
		return { state, close: true };
	}

	if (state.view === "list") {
		const count = state.plans.length;
		if (key === "up" || key === "k") {
			return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, close: false };
		}
		if (key === "down" || key === "j") {
			return { state: { ...state, cursor: Math.min(Math.max(0, count - 1), state.cursor + 1) }, close: false };
		}
		if ((key === "enter" || key === "return" || key === "right") && count > 0) {
			const plan = state.plans[state.cursor];
			if (plan) {
				const content = readPlanContent(cwd, plan.id);
				return {
					state: { ...state, view: "reader", scroll: 0, selectedId: plan.id, selectedContent: content },
					close: false,
				};
			}
		}
		if (key === "r") {
			return { state: { ...state, plans: listAllPlans(cwd) }, close: false };
		}
	}

	if (state.view === "reader") {
		if (key === "escape" || key === "esc" || key === "left") {
			return {
				state: { ...state, view: "list", scroll: 0, selectedId: null, selectedContent: null },
				close: false,
			};
		}
		if (key === "home") return {state: {...state, scroll: 0}, close: false};
		if (key === "end") return {state: {...state, scroll: Number.MAX_SAFE_INTEGER}, close: false};
		if (key === "pageUp" || key === "pageup") return {state: {...state, scroll: Math.max(0, state.scroll - 15)}, close: false};
		if (key === "pageDown" || key === "pagedown") return {state: {...state, scroll: state.scroll + 15}, close: false};
		if (key === "up" || key === "k") {
			return { state: { ...state, scroll: Math.max(0, state.scroll - 1) }, close: false };
		}
		if (key === "down" || key === "j") {
			return { state: { ...state, scroll: state.scroll + 1 }, close: false };
		}
	}

	return { state, close: false };
}

// ── Public entry point ───────────────────────────────────────────────────

export function openPlansNavigator(
	_pi: ExtensionAPI,
	cwd: string,
	ui: ExtensionUIContext,
): Promise<void> {
	let state = freshState(cwd);
	const reader = new DocumentReader();

	return ui.custom<void>(
		(tui: TUI, theme: Theme, _keybindings, done: (r: undefined) => void) => {
			let _focused = false;

			const component = {
				get focused(): boolean { return _focused; },
				set focused(v: boolean) { _focused = v; },

				invalidate(): void { reader.invalidate(); },

				render(width: number): string[] {
					const borderColor = (s: string) =>
						_focused ? theme.fg("accent", s) : theme.fg("borderMuted", s);
					const titleColor = (s: string) =>
						_focused ? theme.fg("dim", theme.bold(s)) : theme.fg("muted", s);
					const bgColor = (s: string) => theme.bg("customMessageBg", s) ?? s;

					const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
					const terminalRows = tui.terminal?.rows ?? 24;
					const overlayRows = Math.max(8, Math.floor(terminalRows * 0.92));
					const contentRows = Math.max(6, overlayRows - 2);

					const rawLines =
						state.view === "list"
							? renderListContent(state, innerWidth, contentRows)
							: renderReaderContent(state, reader, innerWidth, contentRows);

					const panelTitle = state.view === "list" ? " plans " : ` plan: ${state.selectedId} `;
					const title = titleColor(panelTitle);
					const dashes = (n: number) => "─".repeat(Math.max(0, n));
					const topBorder =
						borderColor("╭─") +
						title +
						borderColor(dashes(innerWidth - panelTitle.length)) +
						borderColor("╮");
					const botBorder = borderColor(`╰${dashes(innerWidth + 2)}╯`);

					const wrapAndBg = (line: string) => {
						const padded = truncateToWidth(line, innerWidth, "", true);
						const fullLine = borderColor(BOX_BORDER_LEFT) + padded + borderColor(BOX_BORDER_RIGHT);
						const trailingPad = width - visibleWidth(fullLine);
						return bgColor(fullLine + (trailingPad > 0 ? " ".repeat(trailingPad) : ""));
					};

					return [bgColor(topBorder), ...rawLines.map(wrapAndBg), bgColor(botBorder)].map(line => truncateToWidth(line, width, "", true));
				},

				handleInput(data: string): void {
					if (state.view === "reader" && (parseKey(data) ?? data) === "v") {
						reader.toggle(); state.scroll = 0; tui.requestRender(); return;
					}
					const oldId = state.selectedId;
					const result = handleKey(data, state, cwd);
					state = result.state;
					if (oldId !== state.selectedId) reader.reset();
					if (result.close) {
						done(undefined);
					} else {
						tui.requestRender();
					}
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
