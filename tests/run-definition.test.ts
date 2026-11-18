import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {Theme,ExtensionUIContext,ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {visibleWidth} from "@earendil-works/pi-tui";
import {writeRunDefinition,readRunDefinition} from "../extensions/run-definition.ts";
import {WorkflowManager} from "../extensions/workflow-manager.ts";
import {graphScriptHash} from "../extensions/graph-journal.ts";
import {planRunCleanup,executeRunCleanup} from "../extensions/run-cleanup.ts";
import {openWorkflowNavigator} from "../extensions/workflow-ui.ts";
import {RunDefinitionReader} from "../extensions/run-definition-ui.ts";
let cwd:string,dir:string;
const source=`export const meta={name:'inline_snapshot',description:'fixture'}; const g=graph();g.node('first',()=> 'NEVER_EXECUTE');g.edge('first',END);g.run();`;
const theme={fg:(_c:string,s:string)=>s,bg:(_c:string,s:string)=>s,bold:(s:string)=>s} as Theme;
function journal(id:string,script=source){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`${id}.jsonl`),JSON.stringify({type:'graph_run',runId:id,scriptHash:graphScriptHash(script),name:'inline_snapshot'})+'\n'+JSON.stringify({type:'graph_result',status:'completed',totalTokens:0,durationMs:1})+'\n');}
beforeEach(()=>{cwd=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'run-def-'));dir=path.join(cwd,'.pi-workflow','runs');});
afterEach(()=>fs.rmSync(cwd,{recursive:true,force:true}));
describe('run definition snapshots',()=>{
 it('preserves exact source across restart and rejects mismatched or missing snapshots',()=>{
  writeRunDefinition(dir,'graph-one',source);journal('graph-one');
  const manager=new WorkflowManager(dir);expect(manager.getRunSource('graph-one')).toEqual({script:source,cwd});
  expect(fs.statSync(path.join(dir,'graph-one.definition.js')).mode&0o777).toBe(0o600);
  expect(()=>writeRunDefinition(dir,'graph-one',source+'changed')).toThrow('differs');
  fs.writeFileSync(path.join(dir,'graph-one.definition.js'),source+'changed');expect(manager.getRunSource('graph-one')).toBeUndefined();
  journal('graph-old');expect(manager.getRunSource('graph-old')).toBeUndefined();
 });
 it('refuses symlinks, traversal, unbounded source and changed source while allowing an identical resume',()=>{
  writeRunDefinition(dir,'graph-one',source);expect(()=>writeRunDefinition(dir,'graph-one',source)).not.toThrow();
  expect(()=>writeRunDefinition(dir,'../escape',source)).toThrow();expect(()=>writeRunDefinition(dir,'too-big','a'.repeat(2097153))).toThrow();
  const outside=path.join(cwd,'outside');fs.writeFileSync(outside,source);fs.symlinkSync(outside,path.join(dir,'linked.definition.js'));
  journal('linked');expect(readRunDefinition(dir,'linked')).toBeUndefined();expect(()=>writeRunDefinition(dir,'linked',source)).toThrow();expect(fs.readFileSync(outside,'utf8')).toBe(source);
 });
 it('keeps snapshots on history hiding and includes exact snapshots in confirmed full cleanup',()=>{
  writeRunDefinition(dir,'graph-one',source);journal('graph-one');const manager=new WorkflowManager(dir);
  executeRunCleanup(manager,planRunCleanup(manager,['graph-one'],'history'));expect(fs.existsSync(path.join(dir,'graph-one.definition.js'))).toBe(true);
  const plan=planRunCleanup(manager,['graph-one'],'files');expect(plan.paths).toContain(path.join(dir,'graph-one.definition.js'));
  fs.writeFileSync(path.join(dir,'unrelated.definition.js'),'keep');executeRunCleanup(manager,plan);expect(fs.existsSync(path.join(dir,'graph-one.definition.js'))).toBe(false);expect(fs.readFileSync(path.join(dir,'unrelated.definition.js'),'utf8')).toBe('keep');
 });
 it('uses one navigator overlay with diagram/code/back navigation after restart',async()=>{
  writeRunDefinition(dir,'graph-one',source);journal('graph-one');const manager=new WorkflowManager(dir);
  let component:{render(w:number):string[];handleInput(k:string):void;dispose():void}|undefined;let done=false;
  const ui={custom:async(factory:Function)=>{component=factory({terminal:{rows:40},requestRender:()=>{}},theme,{},()=>{done=true;});}} as unknown as ExtensionUIContext;
  await openWorkflowNavigator({} as ExtensionAPI,manager,ui);const c=component!;
  expect(c.render(100).join('\n')).toContain('inline_snapshot');c.handleInput('v');expect(c.render(100).join('\n')).toContain('Diagram');
  await vi.waitFor(()=>expect(c.render(100).join('\n')).toContain('┌'));
  c.handleInput('v');expect(c.render(100).join('\n')).toContain('NEVER_EXECUTE');for(const line of c.render(25))expect(visibleWidth(line)).toBeLessThanOrEqual(25);
  c.handleInput('\x1b');expect(c.render(100).join('\n')).toContain('Runs ·');expect(done).toBe(false);c.handleInput('q');expect(done).toBe(true);c.dispose();
 });
 it('shows an honest unavailable view for legacy runs and cancels pending layouts',()=>{
  const reader=new RunDefinitionReader('old',undefined,()=>{});expect(reader.render(100,20,theme).join('\n')).toContain('Definition unavailable');expect(reader.key('\x1b',10)).toBe('back');reader.dispose();
  const redraw=vi.fn();const pending=new RunDefinitionReader('new',source,redraw);pending.render(100,20,theme);pending.dispose();expect(redraw).not.toHaveBeenCalled();
 });
});
