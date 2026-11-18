/** Shared, read-only Markdown viewport for plans and contracts. No resource loading. */
import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const documentText = (text: string): string => stripVTControlCharacters(text)
	.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
const withoutLinks = (text: string) => text.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

/** Strip only a complete leading frontmatter block, never an ordinary Markdown rule. */
export function documentBody(source: string): string {
	const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	// Generated contract frontmatter is a flat key/value map. Preserve ordinary
	// leading horizontal rules, prose and unrecognised YAML rather than lose text.
	if (!block || !block[1].split(/\r?\n/).every(line => !line.trim() || /^[\w-]+:/.test(line))) return source;
	return source.slice(block[0].length);
}

export class DocumentReader {
	sourceView = false;
	private cache?: {source: string; width: number; sourceView: boolean; lines: string[]};
	invalidate(): void { this.cache = undefined; }
	toggle(): void { this.sourceView = !this.sourceView; this.invalidate(); }
	reset(): void { this.sourceView = false; this.invalidate(); }
	private body(source: string, width: number): string[] {
		if (this.cache?.source === source && this.cache.width === width && this.cache.sourceView === this.sourceView) return this.cache.lines;
		const text = documentText(source);
		let lines: string[];
		if (this.sourceView) lines = text.split("\n").flatMap(line => wrapTextWithAnsi(line, width));
		else if (Buffer.byteLength(text) > 128 * 1024) {
			lines = ["Markdown preview exceeds 128 KiB; press v for source."];
		} else {
			try { lines = new Markdown(documentBody(text), 0, 0, getMarkdownTheme()).render(width).map(withoutLinks); }
			catch { lines = ["Markdown preview unavailable; press v for source."]; }
		}
		this.cache = {source, width, sourceView: this.sourceView, lines};
		return lines;
	}
	render(source: string, metadata: string[], width: number, rows: number, scroll: number): {lines: string[]; scroll: number} {
		width = Math.max(1, width); rows = Math.max(1, rows);
		const header = [...metadata.map(documentText), `${this.sourceView ? "Source" : "Markdown"} · v toggle · ↑↓/jk scroll · PgUp/PgDn · esc/← back · q quit`, "─".repeat(width)];
		const body = this.body(source, width);
		const available = Math.max(1, rows - header.length - 1);
		scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - available)));
		return {scroll, lines: [...header, ...body.slice(scroll, scroll + available), `— ${body.length ? scroll + 1 : 0}–${Math.min(body.length, scroll + available)}/${body.length} ${this.sourceView ? "source" : "rendered"} rows —`]
			.map(line => truncateToWidth(line, width, "", true)).slice(0, rows)};
	}
}
