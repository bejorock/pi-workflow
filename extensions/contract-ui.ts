/**
 * /contracts TUI navigator — styled panel matching /plans and /workflows.
 *
 * List view columns: TYPE · STATUS · ID · TITLE · UPDATED
 * Status colours: draft=dim, proposed=warning/yellow, superseded=muted
 * Type badges: api, interface, task, data, other
 *
 * Keys: ↑/↓ j/k navigate · enter/→ open · esc/← back · r refresh · q quit
 * Reader: ↑/↓ j/k scroll · esc/← back · q quit
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DocumentReader } from "./document-reader.ts";
import { parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { listAllContracts, contractsDir, type ContractMeta, type ContractStatus, type ContractType } from "./contract-tool.ts";

// ── Box drawing ──────────────────────────────────────────────────────────
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

// ── Badges ───────────────────────────────────────────────────────────────

function typeBadge(type: ContractType): string {
	const badges: Record<ContractType, string> = {
		api:       "api      ",
		interface: "iface    ",
		task:      "task     ",
		data:      "data     ",
		other:     "other    ",
	};
	return badges[type] ?? "other    ";
}

function statusBadge(status: ContractStatus): string {
	const badges: Record<ContractStatus, string> = {
		draft:      "draft    ",
		proposed:   "proposed ",
		superseded: "supersed.",
	};
	return badges[status] ?? "draft    ";
}

function colorStatus(theme: Theme, status: ContractStatus, text: string): string {
	switch (status) {
		case "draft":      return theme.fg("dim", text);
		case "proposed":   return theme.fg("warning", text);
		case "superseded": return theme.fg("muted", text);
		default:           return text;
	}
}

function colorType(theme: Theme, type: ContractType, text: string): string {
	switch (type) {
		case "api":       return theme.fg("accent", text);
		case "interface": return theme.fg("dim", text);
		case "task":      return theme.fg("success", text);
		case "data":      return theme.fg("warning", text);
		default:          return text;
	}
}

// ── State ────────────────────────────────────────────────────────────────

type ViewKind = "list" | "reader";

interface NavState {
	view: ViewKind;
	cursor: number;
	scroll: number;
	contracts: ContractMeta[];
	selectedId: string | null;
	selectedContent: string | null;
}

function freshState(cwd: string): NavState {
	return { view: "list", cursor: 0, scroll: 0, contracts: listAllContracts(cwd), selectedId: null, selectedContent: null };
}

function readContractContent(cwd: string, id: string): string {
	try {
		return fs.readFileSync(path.join(contractsDir(cwd), `${id}.md`), "utf-8");
	} catch {
		return "(Could not read contract content.)";
	}
}

// ── Content rendering ────────────────────────────────────────────────────

function renderListContent(state: NavState, theme: Theme, innerWidth: number, contentRows: number): string[] {
	const lines: string[] = [];

	if (state.contracts.length === 0) {
		lines.push("");
		lines.push("No contracts yet.");
		lines.push("");
		lines.push('Use the contract tool: contract(action: "create", ...)');
		return lines;
	}

	lines.push("↑/↓ navigate  · enter open  · r refresh  · q quit");
	lines.push("");

	// Column widths
	const typeW  = 9;  // "interface" = 9 chars
	const statW  = 9;  // "proposed " = 9 chars
	const idW    = 26;
	const dateW  = 10;
	const titleW = Math.max(8, innerWidth - typeW - statW - idW - dateW - 8); // 8 for separators

	const header =
		"TYPE     " +
		"  STATUS   " +
		"  " + "ID".padEnd(idW) +
		"  " + "TITLE".padEnd(titleW) +
		"  UPDATED";
	lines.push(header.slice(0, innerWidth));
	lines.push("─".repeat(Math.min(innerWidth, header.length)));

	const maxVisible = Math.max(1, contentRows - lines.length);
	const start = Math.max(0, state.cursor - Math.floor(maxVisible / 2));
	const slice = state.contracts.slice(start, start + maxVisible);

	for (let i = 0; i < slice.length; i++) {
		const c = slice[i];
		const idx = start + i;
		const selected = idx === state.cursor;

		const typeStr  = colorType(theme, c.type, typeBadge(c.type));
		const statStr  = colorStatus(theme, c.status, statusBadge(c.status));
		const idStr    = truncateToWidth(c.id, idW).padEnd(idW);
		const titleStr = truncateToWidth(c.title, titleW).padEnd(titleW);
		const dateStr  = c.updated.slice(0, 10);

		// Build with colours, then apply selection highlight to the plain version
		if (selected) {
			const plain = `${typeBadge(c.type)}  ${statusBadge(c.status)}  ${idStr}  ${titleStr}  ${dateStr}`;
			lines.push(`\x1b[7m${truncateToWidth(plain, innerWidth)}\x1b[0m`);
		} else {
			lines.push(`${typeStr}  ${statStr}  ${idStr}  ${titleStr}  ${dateStr}`);
		}
	}

	return lines;
}

function renderReaderContent(state: NavState, reader: DocumentReader, innerWidth: number, contentRows: number): string[] {
	const contract = state.contracts.find(c => c.id === state.selectedId);
	const result = reader.render(state.selectedContent ?? "", [
		`📄 ${state.selectedId ?? ""}.md`,
		...(contract ? [`${contract.type} · ${contract.status} · v${contract.version} · ${contract.producer} → ${contract.consumer}`,
			`Updated: ${contract.updated.slice(0, 10)}${contract.supersedes ? ` · supersedes ${contract.supersedes}` : ""}`] : []),
	], innerWidth, contentRows, state.scroll);
	state.scroll = result.scroll;
	return result.lines;
}

// ── Key handling ─────────────────────────────────────────────────────────

function handleKey(data: string, state: NavState, cwd: string): { state: NavState; close: boolean } {
	const key = parseKey(data) ?? data;

	if (key === "q" || ((key === "escape" || key === "esc") && state.view === "list")) return { state, close: true };

	if (state.view === "list") {
		const count = state.contracts.length;
		if (key === "up" || key === "k") return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, close: false };
		if (key === "down" || key === "j") return { state: { ...state, cursor: Math.min(Math.max(0, count - 1), state.cursor + 1) }, close: false };
		if ((key === "enter" || key === "return" || key === "right") && count > 0) {
			const c = state.contracts[state.cursor];
			if (c) {
				return { state: { ...state, view: "reader", scroll: 0, selectedId: c.id, selectedContent: readContractContent(cwd, c.id) }, close: false };
			}
		}
		if (key === "r") return { state: { ...state, contracts: listAllContracts(cwd) }, close: false };
	}

	if (state.view === "reader") {
		if (key === "escape" || key === "esc" || key === "left") return { state: { ...state, view: "list", scroll: 0, selectedId: null, selectedContent: null }, close: false };
		if (key === "home") return {state: {...state, scroll: 0}, close: false};
		if (key === "end") return {state: {...state, scroll: Number.MAX_SAFE_INTEGER}, close: false};
		if (key === "pageUp" || key === "pageup") return {state: {...state, scroll: Math.max(0, state.scroll - 15)}, close: false};
		if (key === "pageDown" || key === "pagedown") return {state: {...state, scroll: state.scroll + 15}, close: false};
		if (key === "up" || key === "k") return { state: { ...state, scroll: Math.max(0, state.scroll - 1) }, close: false };
		if (key === "down" || key === "j") return { state: { ...state, scroll: state.scroll + 1 }, close: false };
	}

	return { state, close: false };
}

// ── Public entry point ───────────────────────────────────────────────────

export function openContractsNavigator(
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

					const rawLines = state.view === "list"
						? renderListContent(state, theme, innerWidth, contentRows)
						: renderReaderContent(state, reader, innerWidth, contentRows);

					const panelTitle = state.view === "list"
						? " contracts "
						: ` contract: ${state.selectedId} `;
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
