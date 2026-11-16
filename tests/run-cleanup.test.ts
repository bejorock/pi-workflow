import {afterEach, describe, expect, it} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {WorkflowManager} from "../extensions/workflow-manager.ts";
import {planRunCleanup, executeRunCleanup} from "../extensions/run-cleanup.ts";
import {NavigatorModel, NavigatorState, renderNavigatorText} from "../extensions/workflow-ui.ts";
const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true});});
function fixture() {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"runs-cleanup-test-")); roots.push(cwd);
 const dir=path.join(cwd,".pi-workflow","runs");
 const manager=new WorkflowManager(dir);
 const start=(id:string,kind:"workflow"|"subagent"|"parallel"="workflow")=>manager.registerRun(id,{name:id},undefined,{cwd,runKind:kind});
 const file=(relative:string,content="owned")=>{const p=path.join(cwd,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);return p;};
 return {cwd,dir,manager,start,file};
}
describe("unified run persistence and cleanup",()=>{
 it("persists explicit kinds for direct, parallel and graph runs; filters without prefix guesses",()=>{
  const f=fixture(); for(const [id,kind] of [["one","workflow"],["two","subagent"],["three","parallel"]] as const){f.start(id,kind);f.manager.completeRun(id);}
  const restored=new WorkflowManager(f.dir); expect(restored.listRuns().map(r=>r.runKind).sort()).toEqual(["parallel","subagent","workflow"]);
  const model=new NavigatorModel(restored);expect(model.runs()).toHaveLength(3);model.cycleFilter();expect(model.runs().map(r=>r.runId)).toEqual(["one"]);model.cycleFilter();expect(model.runs().map(r=>r.runKind).sort()).toEqual(["parallel","subagent"]);
  expect(renderNavigatorText(new NavigatorState(),model,120).join("\n")).toContain("[Subagent]");
 });
 it("infers only graph journal evidence for legacy types",()=>{
  const f=fixture();f.file(".pi-workflow/runs/misleading-subagent.jsonl",JSON.stringify({type:"graph_run",name:"old"})+"\n"+JSON.stringify({type:"graph_result",status:"completed"}));
  expect(f.manager.listRuns()[0].runKind).toBe("workflow");
 });
 it("hides history across reload without deleting files; later files cleanup can reclaim hidden runs",()=>{
  const f=fixture();f.start("graph-100");f.manager.completeRun("graph-100");const artifact=f.file(".pi-workflow/artifacts/runs/graph-100-worker/events.jsonl");
  executeRunCleanup(f.manager,planRunCleanup(f.manager,["graph-100"],"history"));expect(f.manager.listRuns()).toEqual([]);expect(fs.existsSync(artifact)).toBe(true);
  const restored=new WorkflowManager(f.dir);expect(restored.listRuns()).toEqual([]);
  executeRunCleanup(restored,planRunCleanup(restored,["graph-100"],"files"));expect(fs.existsSync(artifact)).toBe(false);
 });
 it("re-exposes a hidden run on explicit resume registration and refuses corrupt liveness metadata",()=>{
  const f=fixture();f.start("graph-7");f.manager.completeRun("graph-7");executeRunCleanup(f.manager,planRunCleanup(f.manager,["graph-7"],"history"));
  f.start("graph-7");expect(f.manager.listRuns().map(run=>run.runId)).toEqual(["graph-7"]);expect(f.manager.canDeleteRun("graph-7")).toBe(false);
  f.manager.completeRun("graph-7");f.file(".pi-workflow/runs/graph-7.run.json","{broken");expect(f.manager.canDeleteRun("graph-7")).toBe(false);
 });
 it("deletes only selected owned files, reports bytes and retains source, plans, contracts, sibling runs",()=>{
  const f=fixture();f.start("graph-100");f.manager.completeRun("graph-100");f.start("graph-100-other");f.manager.completeRun("graph-100-other");
  const owned=[f.file(".pi-workflow/runs/graph-100.jsonl",JSON.stringify({type:"graph_result",status:"completed"})),f.file(".pi-workflow/sessions/graph-100/node.jsonl"),f.file(".pi-workflow/artifacts/runs/graph-100-worker-1/output.md")];
  const retained=[f.file("source.ts"),f.file(".pi-workflow/plans/p.md"),f.file(".pi-workflow/contracts/c.md"),f.file(".pi-workflow/sessions/unrelated/a.jsonl"),f.file(".pi-workflow/artifacts/runs/graph-100-other-worker/output.md")];
  const plan=planRunCleanup(f.manager,["graph-100"],"files");expect(plan.bytes).toBeGreaterThan(10);executeRunCleanup(f.manager,plan);
  for(const p of owned)expect(fs.existsSync(p)).toBe(false);for(const p of retained)expect(fs.existsSync(p)).toBe(true);
  expect(new WorkflowManager(f.dir).listRuns().map(r=>r.runId)).toEqual(["graph-100-other"]);
 });
 it("protects running, manual-paused, stopping and resumed runs at confirmation",()=>{
  const f=fixture();f.start("running");f.start("paused");f.manager.pauseRun("paused");f.start("stopping");f.manager.stopRun("stopping");
  expect(planRunCleanup(f.manager,["running","paused","stopping"],"files").runIds).toEqual([]);
  f.start("checkpoint");f.manager.pauseRun("checkpoint");f.manager.settleRun("checkpoint");
  const plan=planRunCleanup(f.manager,["checkpoint"],"files");expect(plan.runIds).toEqual(["checkpoint"]);
  f.manager.resumeRun("checkpoint");expect(()=>executeRunCleanup(f.manager,plan)).toThrow("Run state changed");
 });
 it("protects externally resumed summary metadata even with a stale terminal journal",()=>{
  const f=fixture();f.start("graph-42");f.manager.completeRun("graph-42");f.file(".pi-workflow/runs/graph-42.jsonl",JSON.stringify({type:"graph_result",status:"completed"}));
  const other=new WorkflowManager(f.dir);other.registerRun("graph-42",{name:"resuming"},undefined,{cwd:f.cwd,runKind:"workflow"});
  expect(planRunCleanup(f.manager,["graph-42"],"files").runIds).toEqual([]);
 });
 it("rejects traversal and symlinked storage roots, leaf directories and tombstones",()=>{
  const f=fixture();f.start("good");f.manager.completeRun("good");expect(planRunCleanup(f.manager,["../bad"],"files").runIds).toEqual([]);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),"runs-outside-"));roots.push(outside);fs.writeFileSync(path.join(outside,"keep"),"safe");
  fs.mkdirSync(path.join(f.cwd,".pi-workflow","sessions"));fs.symlinkSync(outside,path.join(f.cwd,".pi-workflow","sessions","good"));
  expect(()=>planRunCleanup(f.manager,["good"],"files")).toThrow("symlink");expect(fs.readFileSync(path.join(outside,"keep"),"utf8")).toBe("safe");
  fs.unlinkSync(path.join(f.cwd,".pi-workflow","sessions","good"));fs.symlinkSync(path.join(outside,"keep"),path.join(f.dir,".hidden-runs.json"));expect(()=>planRunCleanup(f.manager,["good"],"history")).toThrow("symlink");
 });
 it("rechecks path safety after preview and fails closed on added files",()=>{
  const f=fixture();f.start("good");f.manager.completeRun("good");const plan=planRunCleanup(f.manager,["good"],"files");f.file(".pi-workflow/sessions/good/new.jsonl");
  expect(()=>executeRunCleanup(f.manager,plan)).toThrow("Run files changed");expect(f.manager.listRuns()).toHaveLength(1);
 });
});
