import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {visibleWidth} from "@earendil-works/pi-tui";
import {WorkflowLibraryPanel, openWorkflowLibrary} from "../extensions/workflow-library-ui.ts";
import {getWorkflowLibraryDir} from "../extensions/workflow-library.ts";
import {renderNavigatorPanel} from "../extensions/navigator-panel.ts";

let cwd: string;
const plain = (s: string) => s.split("\n");
function file(name="fixture",body=""): string {
 const p=path.join(getWorkflowLibraryDir(cwd),`${name}.js`);
 fs.mkdirSync(path.dirname(p),{recursive:true});
 fs.writeFileSync(p,`export const meta = {name:'${name}',description:'Fixture description',whenToUse:'Testing'};\n${body}`);
 return p;
}
function select(panel: WorkflowLibraryPanel, p: string) {panel.cursor=panel.entries.findIndex(e=>e.filePath===p);expect(panel.cursor).toBeGreaterThanOrEqual(0);}
beforeEach(()=>{cwd=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"workflow-panel-"));});
afterEach(()=>fs.rmSync(cwd,{recursive:true,force:true}));

describe("saved workflow library panel",()=>{
 it("shows scoped details and actual highlighted script without executing it",()=>{
  const sentinel=path.join(cwd,"executed");const p=file("fixture",`throw new Error('DO_NOT_EXECUTE');\n// \x1b[31munsafe\x1b[0m\n`);
  const calls:string[]=[];const panel=new WorkflowLibraryPanel(cwd,(s)=>{calls.push(s);return s.split("\n").map(l=>`\x1b[32m${l}\x1b[0m`);});select(panel,p);
  expect(panel.render(120,20).join("\n")).toContain("[project] fixture");panel.key("\r");const rendered=panel.render(120,20).join("\n");expect(rendered).toContain("Fixture description");expect(rendered).toContain("DO_NOT_EXECUTE");expect(rendered).toContain("\x1b[32m");expect(calls[0]).not.toContain("\x1b");expect(fs.existsSync(sentinel)).toBe(false);
 });
 it("scrolls wrapped code, preserves scroll across theme invalidation, and refreshes",()=>{
  const p=file("fixture",Array.from({length:100},(_,i)=>`// row ${i} ${"x".repeat(150)}`).join("\n"));
  const panel=new WorkflowLibraryPanel(cwd,plain);select(panel,p);panel.render(100,18);panel.key("enter");panel.key("pageDown",10);panel.render(100,18);expect(panel.scroll).toBe(10);panel.invalidate();panel.render(100,18);expect(panel.scroll).toBe(10);panel.key("end");panel.render(100,18);expect(panel.scroll).toBeGreaterThan(50);panel.key("home");expect(panel.scroll).toBe(0);
  file("new_fixture");panel.key("r");expect(panel.entries.some(e=>e.name==="new_fixture")).toBe(true);
 });
 it("renders bounded wide and narrow layouts including empty lists",()=>{
  const panel=new WorkflowLibraryPanel(cwd,plain);panel.entries=[];
  expect(panel.render(40,10).join("\n")).toContain("No saved workflows");
  const p=file("unicode","// 🐈漢字".repeat(60));panel.refresh();select(panel,p);
  for(const width of [20,45,80,130]) for(const line of panel.render(width,15)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  panel.key("enter");for(const width of [20,45,80,130]) for(const line of panel.render(width,15)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  expect(panel.render(45,15).join("\n")).toContain("Fixture description");expect(panel.key("escape")).toBe(false);expect(panel.focus).toBe("list");expect(panel.key("escape")).toBe(true);
 });
 it("deletes only the confirmed selected file even when meta.name differs from filename",()=>{
  const p=file("fixture");const target=path.join(path.dirname(p),"different-name.js");fs.renameSync(p,target);const other=path.join(cwd,"source.js");fs.writeFileSync(other,"preserve");
  const panel=new WorkflowLibraryPanel(cwd,plain);select(panel,target);panel.key("d");expect(panel.pending).toBeDefined();panel.key("n");expect(fs.existsSync(target)).toBe(true);panel.key("d");panel.key("y");expect(fs.existsSync(target)).toBe(false);expect(fs.existsSync(other)).toBe(true);expect(panel.notice).toContain("Deleted fixture");
 });
 it("rejects changed files after confirmation and bundled deletion",()=>{
  const p=file();const panel=new WorkflowLibraryPanel(cwd,plain);select(panel,p);panel.key("d");fs.appendFileSync(p,"\n// changed");panel.key("y");expect(fs.existsSync(p)).toBe(true);expect(panel.notice).toContain("changed");
  panel.cursor=panel.entries.findIndex(e=>e.source==="builtin");expect(panel.cursor).toBeGreaterThanOrEqual(0);const bundled=panel.selected!.filePath;panel.key("d");expect(panel.pending).toBeUndefined();expect(panel.notice).toContain("read-only");expect(fs.existsSync(bundled)).toBe(true);
 });
 it("rejects replaced symlinks, out-of-scope files and oversized previews",()=>{
  const p=file();const outside=path.join(cwd,"outside.js");fs.writeFileSync(outside,"keep");const panel=new WorkflowLibraryPanel(cwd,plain);select(panel,p);panel.key("d");fs.unlinkSync(p);fs.symlinkSync(outside,p);panel.key("y");expect(panel.notice).toContain("symlink");expect(fs.readFileSync(outside,"utf8")).toBe("keep");panel.invalidate();panel.key("enter");expect(panel.render(130,20).join("\n")).toContain("symlink");
  panel.entries=[{...panel.entries[panel.cursor],filePath:outside}];panel.cursor=0;panel.key("d");expect(panel.notice).toContain("outside");
  fs.unlinkSync(p);fs.writeFileSync(p," ".repeat(2*1024*1024+1));panel.entries=[{...panel.entries[0],filePath:p}];panel.invalidate();expect(panel.render(130,20).join("\n")).toContain("2 MiB");
 });
 it("uses runs key actions for raw arrow, vim, paging, open and back navigation",()=>{
  for(let i=0;i<35;i++) file(`fixture_${i}`,Array.from({length:100},(_,n)=>`// line ${n}`).join("\n"));
  const panel=new WorkflowLibraryPanel(cwd,plain);panel.key("\x1b[B");expect(panel.cursor).toBe(1);panel.key("j");expect(panel.cursor).toBe(2);panel.key("\x1b[6~",10);expect(panel.cursor).toBe(12);panel.key("\x04",10);expect(panel.cursor).toBe(22);panel.key("g");expect(panel.cursor).toBe(0);panel.key("G");expect(panel.cursor).toBe(panel.entries.length-1);panel.key("g");
  panel.key("l");expect(panel.focus).toBe("code");panel.key("j");expect(panel.scroll).toBe(1);panel.key("\x06",10);expect(panel.scroll).toBe(11);panel.key("\x02",10);expect(panel.scroll).toBe(1);panel.key("h");expect(panel.focus).toBe("list");expect(panel.cursor).toBe(0);panel.key("\x1b[C");expect(panel.focus).toBe("code");panel.key("\x1b[D");expect(panel.focus).toBe("list");expect(panel.key("\x1b")).toBe(true);
 });
 it("shares a width-correct themed shell with runs including focus styling",()=>{
  const colors:string[]=[];const theme={fg:(color:string,s:string)=>{colors.push(color);return s;},bg:(_color:string,s:string)=>s,bold:(s:string)=>s};
  for(const title of ["runs","workflows"]) {
   const lines=renderNavigatorPanel(title,["body"],80,theme as any,true);expect(lines[0]).toContain(` ${title} `);for(const line of lines) expect(visibleWidth(line)).toBe(80);
  }
  expect(colors).toContain("accent");expect(colors).toContain("dim");colors.length=0;
  renderNavigatorPanel("workflows",["body"],80,theme as any,false);expect(colors).toContain("borderMuted");expect(colors).toContain("muted");
 });
 it("switches Diagram/Code with bounded unwrapped panning and unchanged back navigation",async()=>{
  const p=file("diagram",`const g=graph(); g.node('a_very_long_node_name_for_panning',()=> 'x'); g.node('other_long_node_name',()=> 'y'); g.edge('a_very_long_node_name_for_panning','other_long_node_name'); g.edge('other_long_node_name',END);`);
  const panel=new WorkflowLibraryPanel(cwd,plain);select(panel,p);panel.key("enter");panel.key("v");
  expect(panel.view).toBe("diagram");panel.render(60,35);await vi.waitFor(()=>expect(panel.render(60,35).join("\n")).toContain("┌"));let lines=panel.render(60,35);expect(lines.join("\n")).toContain("Diagram rows");panel.key("]");panel.render(30,35);expect(panel.horizontal).toBeGreaterThan(0);
  for(const width of [20,45,100]) for(const line of panel.render(width,25)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  panel.key("[");panel.key("end");expect(panel.render(100,35).join("\n")).toContain("Declared routes");panel.key("v");expect(panel.view).toBe("code");expect(panel.scroll).toBe(0);expect(panel.horizontal).toBe(0);expect(panel.render(100,35).join("\n")).toContain("Code rows");panel.key("h");expect(panel.focus).toBe("list");
 });
 it("opens an overlay without creating a widget and closes on q",async()=>{
  let closed=false;
  const ui={custom:async(factory:any,options:any)=>{expect(options.overlay).toBe(true);const component=factory({terminal:{rows:35},requestRender(){}},{fg:(_n:string,s:string)=>s,bg:(_n:string,s:string)=>s,bold:(s:string)=>s},null,()=>{closed=true;});expect(component.render(100).join("\n")).toContain("Workflows");component.handleInput("\r");expect(component.render(100).join("\n")).toContain("Workflow:");component.handleInput("q");}};
  await openWorkflowLibrary(cwd,ui as any);expect(closed).toBe(true);
 });
});
