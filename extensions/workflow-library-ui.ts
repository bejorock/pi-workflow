/** Read-only script browser; inspection never imports or executes saved workflows. */
import * as fs from "node:fs";
import * as path from "node:path";
import { constants } from "node:fs";
import { getLanguageFromPath, highlightCode, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BUILTIN_WORKFLOWS_DIR, getUserWorkflowsDir, getWorkflowLibraryDir, listSavedWorkflows, type SavedWorkflowInfo } from "./workflow-library.ts";

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const clean = (s: string) => s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
const oneLine = (s: string) => clean(s).replace(/[\r\n]/g, " ");
const fingerprint = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Validate the exact selected file, rather than resolving meta.name (which may differ from its filename). */
function checkedPath(cwd: string, entry: SavedWorkflowInfo): string {
	const root = path.resolve(entry.source === "project" ? getWorkflowLibraryDir(cwd) : entry.source === "user" ? getUserWorkflowsDir() : BUILTIN_WORKFLOWS_DIR);
	const file = path.resolve(entry.filePath);
	if (path.dirname(file) !== root || !/\.(js|ts)$/.test(file)) throw new Error("Workflow file is outside its library scope.");
	let current = root;
	while (true) {
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink workflow paths are not supported.");
		const parent = path.dirname(current); if (parent === current) break; current = parent;
	}
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Workflow must be a regular file, not a symlink.");
	return file;
}

export class WorkflowLibraryPanel {
	entries: SavedWorkflowInfo[] = [];
	cursor = 0;
	scroll = 0;
	column = 0;
	focus: "list" | "code" = "list";
	notice = "";
	code: string[] = [];
	pending?: { entry: SavedWorkflowInfo; fingerprint: string };
	private loadedPath?: string;
	private dirty = true;
	constructor(readonly cwd: string, private readonly colorize = highlightCode) { this.refresh(); }
	get selected(): SavedWorkflowInfo | undefined { return this.entries[this.cursor]; }
	refresh(): void {
		const old = this.selected?.filePath;
		try { this.entries = listSavedWorkflows(this.cwd); this.notice = ""; }
		catch (error) { this.entries = []; this.notice = String(error); }
		const index = this.entries.findIndex(e => e.filePath === old);
		this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.entries.length - 1));
		this.loadedPath = undefined; this.scroll = 0; this.column = 0; this.pending = undefined;
	}
	invalidate(): void { this.dirty = true; }
	private loadCode(): void {
		const entry = this.selected;
		if (!this.dirty && this.loadedPath === entry?.filePath && entry) return;
		if (this.loadedPath !== entry?.filePath) { this.scroll = 0; this.column = 0; }
		this.loadedPath = entry?.filePath; this.dirty = false; this.code = [];
		if (!entry) return;
		try {
			const file = checkedPath(this.cwd, entry);
			const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = fs.fstatSync(fd);
				if (stat.size > MAX_SCRIPT_BYTES) throw new Error("Script exceeds the 2 MiB preview limit.");
				const bytes = Buffer.alloc(stat.size + 1);
				const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
				if (count > MAX_SCRIPT_BYTES || count > stat.size) throw new Error("Script changed while reading; refresh to retry.");
				this.code = this.colorize(clean(bytes.subarray(0, count).toString("utf8")), getLanguageFromPath(file));
			} finally { fs.closeSync(fd); }
		} catch (error) { this.code = [clean(String(error))]; }
	}
	/** Returns true only when the overlay should close. */
	key(key: string, page = 15): boolean {
		if (this.pending) {
			if (key === "y") {
				try {
					const {entry, fingerprint: expected} = this.pending;
					if (entry.source === "builtin") throw new Error("Bundled workflows are read-only.");
					const file = checkedPath(this.cwd, entry);
					if (fingerprint(fs.lstatSync(file)) !== expected) throw new Error("Workflow changed; refresh and confirm again.");
					fs.unlinkSync(file); this.refresh(); this.notice = `Deleted ${clean(entry.name)} (${entry.source}).`;
				} catch (error) { this.notice = clean(String(error)); }
			}
			this.pending = undefined; return false;
		}
		if (key === "q" || (key === "escape" && this.focus === "list")) return true;
		if (key === "r") { this.refresh(); return false; }
		if (key === "d" && this.selected) {
			try {
				if (this.selected.source === "builtin") throw new Error("Bundled workflows are read-only.");
				const file = checkedPath(this.cwd, this.selected);
				this.pending = {entry: {...this.selected}, fingerprint: fingerprint(fs.lstatSync(file))};
			} catch (error) { this.notice = clean(String(error)); }
			return false;
		}
		if (key === "tab") this.focus = this.focus === "list" ? "code" : "list";
		else if (key === "escape") this.focus = "list";
		else if (this.focus === "list") {
			if (key === "down" || key === "j") this.cursor = Math.min(Math.max(0, this.entries.length - 1), this.cursor + 1);
			if (key === "up" || key === "k") this.cursor = Math.max(0, this.cursor - 1);
			if (key === "enter" || key === "right") this.focus = "code";
		} else {
			if (key === "down" || key === "j") this.scroll++;
			if (key === "up" || key === "k") this.scroll = Math.max(0, this.scroll - 1);
			if (key === "pageDown") this.scroll += page;
			if (key === "pageUp") this.scroll = Math.max(0, this.scroll - page);
			if (key === "home") this.scroll = 0;
			if (key === "end") this.scroll = this.code.length;
			if (key === "right") this.column += 8;
			if (key === "left") this.column = Math.max(0, this.column - 8);
		}
		return false;
	}
	render(width: number, height: number): string[] {
		this.loadCode();
		const w = Math.max(1, width); const rows = Math.max(1, height);
		const split = w >= 76;
		const leftWidth = split ? Math.min(34, Math.floor(w * .32)) : w;
		const rightWidth = split ? w - leftWidth - 3 : w;
		const bodyRows = Math.max(1, rows - 4);
		const start = Math.max(0, this.cursor - Math.floor(bodyRows / 2));
		const list = Array.from({length: bodyRows}, (_, i) => {
			const entry = this.entries[start + i];
			return entry ? `${start + i === this.cursor ? "›" : " "} [${entry.source}] ${oneLine(entry.name)}` : "";
		});
		if (!this.entries.length) list[0] = "No saved workflows.";
		const entry = this.selected;
		const details = entry ? [oneLine(entry.description), `When: ${oneLine(entry.whenToUse ?? "Not specified")}`, `File: ${oneLine(entry.filePath)}`, `${entry.source} · ${entry.sizeBytes} bytes · ${new Date(entry.savedAt).toISOString()}`, "─".repeat(rightWidth)] : ["Save a script with workflow(saveWorkflow: true)."];
		const codeRows = Math.max(1, bodyRows - details.length);
		this.scroll = Math.min(this.scroll, Math.max(0, this.code.length - codeRows));
		this.column = Math.min(this.column, this.code.reduce((max, line) => Math.max(max, visibleWidth(line) - Math.max(1, rightWidth - 6)), 0));
		const preview = [...details, ...this.code.slice(this.scroll, this.scroll + codeRows).map((line, i) => `${String(this.scroll + i + 1).padStart(4)}  ${sliceByColumn(line, this.column, Math.max(1, rightWidth - 6))}`)];
		const fit = (s: string, n: number) => truncateToWidth(s, n, "", true);
		const content = Array.from({length: bodyRows}, (_, i) => split ? `${fit(list[i], leftWidth)} │ ${fit(preview[i] ?? "", rightWidth)}` : fit(this.focus === "list" ? list[i] : preview[i] ?? "", w));
		return [fit(`Workflows · ${this.entries.length} saved · focus: ${this.focus}`, w),
			fit("↑↓ select/scroll · enter/tab preview · ←→ pan code · PgUp/PgDn · r refresh · d delete · q close", w),
			...content,
			fit(this.pending ? `Delete ${oneLine(this.pending.entry.name)} (${this.pending.entry.source})? y confirm · any other key cancels` : oneLine(this.notice), w),
			fit(`Script lines ${this.code.length ? this.scroll + 1 : 0}–${Math.min(this.code.length, this.scroll + codeRows)}/${this.code.length} · preview only; never executed`, w)
		].slice(0, rows);
	}
}

export function openWorkflowLibrary(cwd: string, ui: ExtensionUIContext): Promise<void> {
	const panel = new WorkflowLibraryPanel(cwd);
	return ui.custom<void>((tui, theme, _keys, done) => ({
		invalidate: () => panel.invalidate(),
		render(width: number) {
			const inner = Math.max(1, width - 4);
			const height = Math.max(5, Math.floor(tui.terminal.rows * .9) - 2);
			return [theme.fg("borderMuted", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
				...panel.render(inner, height).map(line => `│ ${line} │`),
				theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`)];
		},
		handleInput(data: string) {
			if (panel.key(parseKey(data) ?? data, Math.max(1, Math.floor(tui.terminal.rows * .9) - 12))) done();
			else tui.requestRender();
		},
	}), {overlay: true, overlayOptions: {anchor: "center", width: "96%", maxHeight: "94%", margin: 1}});
}
