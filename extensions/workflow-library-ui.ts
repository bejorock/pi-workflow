/** Read-only script browser; inspection never imports or executes saved workflows. */
import * as fs from "node:fs";
import * as path from "node:path";
import { constants } from "node:fs";
import { getLanguageFromPath, highlightCode, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyToAction } from "./workflow-ui.ts";
import { renderNavigatorPanel } from "./navigator-panel.ts";
import { renderWorkflowDiagram, type WorkflowDiagram } from "./workflow-diagram.ts";
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
	focus: "list" | "code" = "list";
	view: "code" | "diagram" = "code";
	horizontal = 0;
	private source = "";
	private diagram?: WorkflowDiagram;
	private layout?: AbortController;
	private generation = 0;
	onChange: () => void = () => {};
	dispose(): void { this.generation++; this.layout?.abort(); this.layout = undefined; }
	private startDiagram(): void {
		if (this.diagram) return;
		this.diagram = {mermaid: "", lines: ["Rendering diagram…"], warnings: []};
		const generation = this.generation;
		this.layout = new AbortController();
		void renderWorkflowDiagram(this.source, this.layout.signal).then(diagram => {
			if (generation !== this.generation) return;
			this.diagram = diagram; this.layout = undefined; this.onChange();
		}).catch(error => {
			if (generation !== this.generation) return;
			this.diagram = {mermaid: "", lines: [clean(String(error))], warnings: []}; this.onChange();
		});
	}
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
		this.loadedPath = undefined; this.scroll = 0; this.horizontal = 0; this.pending = undefined;
	}
	invalidate(): void { this.dirty = true; }
	private loadCode(): void {
		const entry = this.selected;
		if (!this.dirty && this.loadedPath === entry?.filePath && entry) return;
		if (this.loadedPath !== entry?.filePath) { this.scroll = 0; this.horizontal = 0; }
		this.dispose();
		this.loadedPath = entry?.filePath; this.dirty = false; this.code = []; this.source = ""; this.diagram = undefined;
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
				this.source = bytes.subarray(0, count).toString("utf8");
				this.code = this.colorize(clean(this.source), getLanguageFromPath(file));
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
		if (key === "r") { this.refresh(); return false; }
		if (this.focus === "code" && key === "v") {
			this.view = this.view === "code" ? "diagram" : "code";
			this.scroll = 0; this.horizontal = 0; return false;
		}
		if (this.focus === "code" && this.view === "diagram" && (key === "[" || key === "]")) {
			this.horizontal = Math.max(0, this.horizontal + (key === "]" ? 12 : -12)); return false;
		}
		if (key === "d" && this.selected) {
			try {
				if (this.selected.source === "builtin") throw new Error("Bundled workflows are read-only.");
				const file = checkedPath(this.cwd, this.selected);
				this.pending = {entry: {...this.selected}, fingerprint: fingerprint(fs.lstatSync(file))};
			} catch (error) { this.notice = clean(String(error)); }
			return false;
		}
		// Use the very same decoded navigation actions as /runs, including
		// terminal protocols, vim keys and control-key paging.
		const action = keyToAction(key, this.focus === "list" ? "runs" : "detail");
		if (action.type === "close") return true;
		if (action.type === "back") {
			if (this.focus === "list") return true;
			this.focus = "list"; return false;
		}
		if (key === "tab" || key === "\t" || action.type === "drill") {
			if (this.selected) { this.focus = "code"; this.loadCode(); }
			return false;
		}
		const move = action.type === "move" ? action.delta : action.type === "page" ? action.direction * page : 0;
		if (this.focus === "list") {
			if (action.type === "jump") this.cursor = action.edge === "start" ? 0 : Math.max(0, this.entries.length - 1);
			else this.cursor = Math.max(0, Math.min(Math.max(0, this.entries.length - 1), this.cursor + move));
		} else {
			if (action.type === "jump") this.scroll = action.edge === "start" ? 0 : Number.MAX_SAFE_INTEGER;
			else this.scroll = Math.max(0, this.scroll + move);
		}
		return false;
	}
	render(width: number, height: number, theme?: Theme): string[] {
		this.loadCode();
		const w = Math.max(1, width); const rows = Math.max(1, height);
		const fit = (s: string) => truncateToWidth(s, w, "", true);
		const dim = (s: string) => theme ? theme.fg("dim", s) : s;
		const entry = this.selected;
		let content: string[];
		if (this.focus === "list") {
			const count = Math.max(1, rows - 4);
			const start = Math.min(Math.max(0, this.cursor - Math.floor(count / 2)), Math.max(0, this.entries.length - count));
			content = [`Workflows · ${this.entries.length} saved`, ""];
			if (!this.entries.length) content.push("No saved workflows.", dim("Save a script with workflow(saveWorkflow: true)."));
			for (const [i, item] of this.entries.slice(start, start + count).entries()) {
				const selected = start + i === this.cursor;
				const text = `${selected ? "❯" : " "} [${item.source}] ${oneLine(item.name)} · ${oneLine(item.description)}`;
				content.push(selected && theme ? theme.fg("accent", theme.bold(text)) : text);
			}
			content.push(dim("↑↓/jk navigate · enter/→/l open · PgUp/PgDn · r refresh · d delete · q close"));
		} else {
			const details = entry ? [`Workflow: ${oneLine(entry.name)} · ${entry.source}`, oneLine(entry.description),
				`When: ${oneLine(entry.whenToUse ?? "Not specified")}`, `File: ${oneLine(entry.filePath)}`,
				`${entry.sizeBytes} bytes · ${new Date(entry.savedAt).toISOString()} · preview only; never executed`, "─".repeat(w)] : [];
			if (this.view === "diagram") {
				if (this.source) this.startDiagram();
				else this.diagram ??= {mermaid: "", lines: this.code, warnings: []};
				const diagram = this.diagram!;
				const warnings = diagram.warnings.map(text => dim(clean(text)));
				const diagramRows = Math.max(1, rows - details.length - Math.min(warnings.length, 3) - 3);
				this.scroll = Math.min(this.scroll, Math.max(0, diagram.lines.length - diagramRows));
				const maxWidth = Math.max(0, ...diagram.lines.map(line => visibleWidth(line)));
				this.horizontal = Math.min(this.horizontal, Math.max(0, maxWidth - w));
				content = [...details, ...warnings.slice(0, 3),
					...diagram.lines.slice(this.scroll, this.scroll + diagramRows).map(line => sliceByColumn(clean(line), this.horizontal, w)),
					dim(`Diagram rows ${this.scroll + 1}–${Math.min(diagram.lines.length, this.scroll + diagramRows)}/${diagram.lines.length} · columns ${this.horizontal + 1}–${Math.min(maxWidth, this.horizontal + w)}/${maxWidth}`),
					dim("v Code · ↑↓/jk/PgUp/PgDn scroll · [ ] pan · esc/←/h back · q close")];
			} else {
			const codeRows = Math.max(1, rows - details.length - 3);
			// Wrap rather than steal Left/Right from the navigator's back/open keys.
			const codeWidth = Math.max(1, w - 6);
			const body = this.code.flatMap((line, index) => {
				const chunks: string[] = [];
				// sliceByColumn preserves syntax colours across wrapped fragments.
				for (let col = 0; col < Math.max(1, visibleWidth(line)); col += codeWidth) {
					chunks.push(`${col === 0 ? String(index + 1).padStart(4) : "    "}  ${sliceByColumn(line, col, codeWidth)}`);
				}
				return chunks;
			});
			this.scroll = Math.min(this.scroll, Math.max(0, body.length - codeRows));
			content = [...details, ...body.slice(this.scroll, this.scroll + codeRows),
				dim(`Code rows ${body.length ? this.scroll + 1 : 0}–${Math.min(body.length, this.scroll + codeRows)}/${body.length}`),
				dim("v Diagram · ↑↓/jk scroll · PgUp/PgDn · Home/End · esc/←/h back · r refresh · d delete · q close")];
			}
		}
		content.push(this.pending ? `Delete ${oneLine(this.pending.entry.name)} (${this.pending.entry.source})? y confirm · any other key cancels` : oneLine(this.notice));
		return content.map(fit).slice(0, rows);
	}
}

export function openWorkflowLibrary(cwd: string, ui: ExtensionUIContext): Promise<void> {
	const panel = new WorkflowLibraryPanel(cwd);
	return ui.custom<void>((tui, theme, _keys, done) => {
		let focused = false;
		panel.onChange = () => tui.requestRender();
		return {
		dispose: () => panel.dispose(),
		get focused() { return focused; },
		set focused(value: boolean) { focused = value; },
		invalidate: () => panel.invalidate(),
		render(width: number) {
			const inner = Math.max(1, width - 4);
			const height = Math.max(6, Math.max(8, Math.floor(tui.terminal.rows * .92)) - 2);
			return renderNavigatorPanel("workflows", panel.render(inner, height, theme), width, theme, focused);
		},
		handleInput(data: string) {
			if (panel.key(data, Math.max(1, Math.floor(tui.terminal.rows * .92) - 12))) done();
			else tui.requestRender();
		},
	};
	}, {overlay: true, overlayOptions: {anchor: "center", width: "94%", maxHeight: "92%", margin: 1}});
}
