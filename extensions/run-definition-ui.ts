/** Read-only run definition reader, using the library's renderer and navigator keys. */
import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyToAction } from "./workflow-ui.ts";
import { renderWorkflowDiagram, type WorkflowDiagram } from "./workflow-diagram.ts";
const clean = (s: string) => s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
export class RunDefinitionReader {
 view: "diagram" | "code" = "diagram";
 scroll = 0;
 horizontal = 0;
 private diagram?: WorkflowDiagram;
 private code?: string[];
 private abort = new AbortController();
 private disposed = false;
 constructor(readonly runId: string, private source: string | undefined, private changed: () => void) {}
 dispose(): void { this.disposed = true; this.abort.abort(); }
 invalidate(): void { this.code = undefined; }
 /** close returns to run details; q closes the whole navigator. */
 key(data: string, page: number): "back" | "close" | undefined {
  if (data === "v") { this.view = this.view === "diagram" ? "code" : "diagram"; this.scroll = 0; this.horizontal = 0; return; }
  if (this.view === "diagram" && (data === "[" || data === "]")) { this.horizontal = Math.max(0, this.horizontal + (data === "]" ? 12 : -12)); return; }
  const action = keyToAction(data, "detail");
  if (action.type === "back" || action.type === "close") return action.type;
  if (action.type === "jump") this.scroll = action.edge === "start" ? 0 : Number.MAX_SAFE_INTEGER;
  if (action.type === "move") this.scroll = Math.max(0, this.scroll + action.delta);
  if (action.type === "page") this.scroll = Math.max(0, this.scroll + action.direction * page);
 }
 render(width: number, rows: number, theme: Theme): string[] {
  const w = Math.max(1, width); const count = Math.max(1, rows - 4);
  let lines: string[];
  if (this.source === undefined) lines = ["Definition unavailable for this run.", "Older runs may not have a snapshot; missing or mismatched snapshots are not reconstructed from today's library."];
  else if (this.view === "diagram") {
   if (!this.diagram) {
    this.diagram = {mermaid: "", lines: ["Rendering diagram…"], warnings: []};
    void renderWorkflowDiagram(this.source, this.abort.signal).then(result => { if (!this.disposed) { this.diagram = result; this.changed(); } }).catch(error => { if (!this.disposed) { this.diagram = {mermaid: "", lines: [clean(String(error))], warnings: []}; this.changed(); } });
   }
   lines = this.diagram.lines.map(clean);
  } else {
   this.code ??= highlightCode(clean(this.source), "javascript");
   const wrap = Math.max(1, w - 6);
   lines = this.code.flatMap((line, i) => {
    const result: string[] = [];
    for (let col = 0; col < Math.max(1, visibleWidth(line)); col += wrap) result.push(`${col ? "    " : String(i + 1).padStart(4)}  ${sliceByColumn(line, col, wrap)}`);
    return result;
   });
  }
  this.scroll = Math.min(this.scroll, Math.max(0, lines.length - count));
  const max = lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
  this.horizontal = Math.min(this.horizontal, Math.max(0, max - w));
  return [theme.bold(`Run ${this.runId} · ${this.view === "diagram" ? "Diagram" : "Code"}`), theme.fg("dim", "Exact submitted definition · static preview only; never executed"),
   ...lines.slice(this.scroll, this.scroll + count).map(line => sliceByColumn(line, this.view === "diagram" ? this.horizontal : 0, w)),
   theme.fg("dim", `Rows ${this.scroll + 1}–${Math.min(lines.length, this.scroll + count)}/${lines.length} · column ${this.horizontal + 1}`),
   theme.fg("dim", "v Diagram/Code · ↑↓/jk/PgUp/PgDn · [ ] pan · esc/←/h back · q close")].map(line => truncateToWidth(line, w, "", true));
 }
}
