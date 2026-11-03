import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateSync } from "node:zlib";
import * as net from "node:net";
import { DashboardProjector } from "../extensions/dashboard-state.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { GraphDisplayBridge } from "../extensions/graph-display-bridge.ts";
import { dashboardLaunchParams, registerWorkspaceDashboard } from "../extensions/workspace-dashboard.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Standalone viewer modules intentionally ship as plain JavaScript.
// @ts-ignore
import { renderGraphPng, layoutGraph, kittyUpload, kittyDelete, isActiveStatus, probeReplyPattern, graphGeometry } from "../extensions/dashboard/graphics.mjs";
// @ts-ignore
import { draw, createViewState, decodeInput, stale, filtered, FramePresenter } from "../extensions/dashboard/viewer.mjs";
// @ts-ignore
import { renderMarkdown, safeText, visibleWidth } from "../extensions/dashboard/markdown.mjs";

function fixture() {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"pi-dashboard-test-"));
 const manager=new WorkflowManager(path.join(cwd,".pi-workflow","runs"));
 return {cwd,manager,dispose:()=>fs.rmSync(cwd,{recursive:true,force:true})};
}

describe("workspace dashboard projection",()=>{
 it("tracks stable graph identities, parallel nodes, visits, and observed routes",()=>{
  const f=fixture();
  try {
   const bridge=new GraphDisplayBridge({manager:f.manager,runId:"r",name:"real",description:"",cwd:f.cwd,script:"unused"});
   const run=f.manager.getRun("r")!;
   run.dashboardGraph={nodes:[{id:"a",label:"a",nodeType:"agent"},{id:"b",label:"b",nodeType:"human"}],edges:[{from:"a",to:"b"}]};
   bridge.nodeStarted({step:1,nodeId:"a",nodeType:"agent"});
   bridge.nodeStarted({step:2,nodeId:"b",nodeType:"human"});
   const projector=new DashboardProjector(f.manager,f.cwd);
   let view=projector.snapshot().runs[0];
   expect(view.nodes.map(n=>n.status)).toEqual(["running","waiting"]);
   bridge.nodeCompleted({step:1,nodeId:"a",nodeType:"agent",status:"ok",result:"fine",routedTo:"b",startedAt:0,durationMs:10});
   bridge.nodeStarted({step:3,nodeId:"a",nodeType:"agent"});
   view=projector.snapshot().runs[0];
   expect(view.nodes.find(n=>n.id==="a")?.visits).toBe(2);
   expect(view.edges).toEqual([{from:"a",to:"b",observed:true}]);
   f.manager.pauseRun("r");
   expect(projector.snapshot().runs[0].nodes.find(n=>n.id==="a")?.status).toBe("paused");
   f.manager.resumeRun("r");
   f.manager.stopRun("r");
   expect(projector.snapshot().runs[0].nodes.find(n=>n.id==="a")?.status).toBe("stopped");
  } finally {f.dispose();}
 });
 it("reads documents and journals without scripts, ignores partial records and external links",()=>{
  const f=fixture();
  try {
   for(const kind of ["runs","plans","contracts"])fs.mkdirSync(path.join(f.cwd,".pi-workflow",kind),{recursive:true});
   fs.writeFileSync(path.join(f.cwd,".pi-workflow/plans/a.md"),"# My plan\n\n- [ ] Task");
   fs.symlinkSync("/etc/passwd",path.join(f.cwd,".pi-workflow/plans/external.md"));
   fs.writeFileSync(path.join(f.cwd,".pi-workflow/contracts/c.md"),"---\nstatus: proposed\ntype: api\nproducer: designer\nconsumer: worker\n---\n# API contract");
   fs.writeFileSync(path.join(f.cwd,".pi-workflow/runs/r.jsonl"),[
    {type:"graph_run",name:"old",nodeIds:["a","b"],startedAt:100},
    {type:"node",nodeId:"a",nodeType:"agent",status:"ok",routedTo:"b,END",tokens:12},
   ].map(x=>JSON.stringify(x)).join("\n")+'\n{"partial":');
   const view=new DashboardProjector(f.manager,f.cwd).snapshot();
   expect(view.plans.map(p=>p.name)).toEqual(["My plan"]);
   expect(view.contracts[0]).toMatchObject({name:"API contract",status:"proposed",type:"api"});
   expect(view.runs[0]).toMatchObject({name:"old",status:"unknown",totalTokens:12});
   expect(view.runs[0].edges.map(e=>e.to)).toEqual(["b","END"]);
  } finally{f.dispose();}
 });
 it("does not include managed runs from another workspace",()=>{
  const f=fixture();try{
   f.manager.registerRun("other",{name:"other"},undefined,{cwd:"/different"});
   expect(new DashboardProjector(f.manager,f.cwd).snapshot().runs).toEqual([]);
  }finally{f.dispose();}
 });
});

describe("standalone terminal rendering",()=>{
 it("encodes actual PNG frames, animation, and bounded Kitty chunks",()=>{
  const nodes=[{id:"a",status:"running"},{id:"b",status:"queued"}];
  const png=renderGraphPng(nodes,[{from:"a",to:"b"}],240,160,0);
  expect([...png.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
  let offset=8;const chunks:Buffer[]=[];
  while(offset<png.length){const n=png.readUInt32BE(offset);if(png.toString("ascii",offset+4,offset+8)==="IDAT")chunks.push(png.subarray(offset+8,offset+8+n));offset+=n+12;}
  expect(inflateSync(Buffer.concat(chunks)).length).toBe(160*(240*3+1));
  expect(renderGraphPng(nodes,[{from:"a",to:"b"}],240,160,1).equals(png)).toBe(false);
  const stream=kittyUpload(png.toString("base64"),123);
  const payloads=[...stream.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map(m=>m[1]);
  expect(payloads.every(p=>p.length<=4096)).toBe(true);
  expect(Buffer.from(payloads.join(""),"base64").equals(png)).toBe(true);
  expect(kittyDelete(123)).toContain("d=I,i=123");
  expect(isActiveStatus("paused")).toBe(false);
  expect(probeReplyPattern(123).test("\x1b_Gi=9123;OK\x1b\\")).toBe(false);
 });
 it("lays out cycles without inventing routes",()=>{
  const nodes=[{id:"a"},{id:"b"},{id:"c"}];
  const layout=layoutGraph(nodes,[{from:"a",to:"b"},{from:"b",to:"a"}]);
  expect(new Set(layout.positions.map((p:any)=>`${p.x},${p.y}`)).size).toBe(3);
  expect(layout.edgePairs).toHaveLength(2);
 });
 it("keeps card geometry bounded and nonoverlapping across responsive layouts",()=>{
  const nodes=["start","a","b","join","finish","END"].map(id=>({id}));
  const edges=[["start","a"],["start","b"],["a","join"],["b","join"],["join","finish"],["finish","END"]].map(([from,to])=>({from,to}));
  for(const [columns,rows] of [[110,28],[57,15],[70,54]]) {
   const geometry=graphGeometry(nodes,edges,columns,rows,.5);
   for(const card of geometry.cards) {
    expect(card.x).toBeGreaterThanOrEqual(0);expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.x+card.w).toBeLessThanOrEqual(columns);expect(card.y+card.h).toBeLessThanOrEqual(rows);
   }
   const cards=geometry.cards;
   for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++) {
    const a=cards[i],b=cards[j];
    expect(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y).toBe(true);
   }
   expect(geometry.width/geometry.height).toBeCloseTo(columns*.5/rows,2);
  }
 });
 it("keeps settled frames still, distinguishes selected nodes, and preserves loop components",()=>{
  const nodes=[{id:"a",status:"done"},{id:"b",status:"done"},{id:"c",status:"queued"}];
  const edges=[{from:"a",to:"b",observed:true},{from:"b",to:"a",observed:true},{from:"b",to:"c"}];
  const geometry=graphGeometry(nodes,edges,100,28,.5);
  const first=renderGraphPng(nodes,edges,400,224,0,{geometry,selected:0});
  expect(renderGraphPng(nodes,edges,400,224,3,{geometry,selected:0}).equals(first)).toBe(true);
  expect(renderGraphPng(nodes,edges,400,224,0,{geometry,selected:1}).equals(first)).toBe(false);
  const layout=layoutGraph(nodes,edges);
  expect(layout.positions.find((p:any)=>p.id==="a").x).toBe(layout.positions.find((p:any)=>p.id==="b").x);
  expect(layout.positions.find((p:any)=>p.id==="c").x).toBeGreaterThan(layout.positions.find((p:any)=>p.id==="b").x);
 });
 it("renders Markdown, sanitizes terminal controls, and decodes split mouse packets",()=>{
  const source="---\nstatus: proposed\n---\n# Title\n\n**Bold** and `code`\n\n```js\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| one | two |\n\n- [x] done";
  const lines=renderMarkdown(source,60);
  expect(lines.join("\n")).not.toContain("status: proposed");
  expect(lines.join("\n")).toContain("Title");
  expect(lines.every((l:string)=>visibleWidth(l)<=60)).toBe(true);
  expect(safeText("a\x1b_Gpayload\x1b\\\x07")).not.toContain("\x1b");
  const partial=decodeInput("\x1b[<0;10;");expect(partial.events).toEqual([]);
  expect(decodeInput(partial.rest+"5M").events[0]).toMatchObject({mouse:true,x:9,y:4});
  expect(decodeInput("\x1b_Gi=1;OK\x1b\\q").events).toEqual([{key:"q"}]);
 });
 it("does not repaint static documents or clear rows before rewriting them",()=>{
  const snapshot={version:1,cwd:"/tmp",connected:true,updatedAt:Date.now(),runs:[],plans:[{id:"p",name:"Plan",content:"# Heading\n\nSome text"}],contracts:[]};
  const state=createViewState();state.tab=1;
  const presenter=new FramePresenter(100);
  const first=draw(snapshot,state,110,34,0);
  expect(first.rows.every((line:string)=>visibleWidth(line)===110)).toBe(true);
  const output=presenter.present(first);
  expect(output).toContain("\x1b[?2026h");expect(output.endsWith("\x1b[?2026l")).toBe(true);
  expect(output).not.toContain("\x1b[2J");
  expect(presenter.present(draw(snapshot,state,110,34,1))).toBe("");
  state.editing=true;
  const changed=presenter.present(draw(snapshot,state,110,34,2));
  expect((changed.match(/\x1b\[\d+;1H/g)??[]).length).toBeLessThan(4);
 });
 it("stages animation uploads before synchronized swaps without reprinting unchanged text",()=>{
  const snapshot={version:1,cwd:"/tmp",connected:true,updatedAt:Date.now(),plans:[],contracts:[],runs:[{
   runId:"r",name:"Run",status:"running",totalTokens:0,durationMs:100,nodes:[{id:"a",label:"a",status:"running",visits:1}],edges:[],logs:[]}]};
  const state=createViewState(),presenter=new FramePresenter(100);
  presenter.present(draw(snapshot,state,110,34,0));
  const animation=presenter.present(draw(snapshot,state,110,34,1));
  expect(animation.indexOf("a=t,f=100")).toBeLessThan(animation.indexOf("\x1b[?2026h"));
  expect(animation.indexOf("a=p,i=101")).toBeGreaterThan(animation.indexOf("\x1b[?2026h"));
  expect(animation.indexOf("a=d,d=I,i=100")).toBeGreaterThan(animation.indexOf("a=p,i=101"));
  expect(animation).not.toContain("PI WORKSPACE");
  snapshot.runs[0].nodes[0].status="done";
  presenter.present(draw(snapshot,state,110,34,2));
  expect(presenter.present(draw(snapshot,state,110,34,3))).toBe("");
  state.tab=1;
  expect(presenter.present(draw(snapshot,state,110,34,4))).toContain("a=d,d=I");
  expect(presenter.present(draw(snapshot,state,110,34,5))).toBe("");
 });
 it("draws all sections, empty state, narrow terminal, and disconnected state",()=>{
  const s={version:1,cwd:"/tmp",connected:true,updatedAt:Date.now(),runs:[],plans:[{id:"p",name:"Plan",content:"# Heading\n\nText"}],contracts:[]};
  const state=createViewState();
  for(const tab of [0,1,2]) {state.tab=tab;expect(draw(s,state,110,34,0).text).toContain("PI WORKSPACE");}
  expect(draw(s,state,60,20,0).text).toContain("Resize");
  expect(stale({...s,connected:false})).toBe(true);
  expect(filtered(s.plans,"plan")).toHaveLength(1);
 });
});

describe("dashboard command",()=>{
 it("registers command only, and rejects noninteractive use without launching",async()=>{
  let command:any;
  const pi={registerCommand:vi.fn((_name,c)=>command=c),on:vi.fn()} as unknown as ExtensionAPI;
  registerWorkspaceDashboard(pi,new WorkflowManager());
  expect(pi.registerCommand).toHaveBeenCalledWith("workspace-dashboard",expect.anything());
  const notify=vi.fn();await command.handler("",{mode:"rpc",ui:{notify}});
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"),"warning");
 });
 it("publishes privately, launches via the caller socket, and disconnects on shutdown",async()=>{
  const f=fixture();const socketPath=path.join(f.cwd,"herdr.sock");
  let command:any,shutdown:any,received:any;
  const server=net.createServer(socket=>socket.on("data",data=>{
   received=JSON.parse(data.toString());socket.end(JSON.stringify({id:received.id,result:{type:"layout_apply"}})+"\n");
  }));
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  const env={...process.env};
  try {
   process.env.HERDR_ENV="1";process.env.HERDR_PANE_ID="w1:p1";process.env.HERDR_WORKSPACE_ID="w1";process.env.HERDR_SOCKET_PATH=socketPath;
   const pi={registerCommand:vi.fn((_n,c)=>command=c),on:vi.fn((_n,c)=>shutdown=c)} as unknown as ExtensionAPI;
   registerWorkspaceDashboard(pi,f.manager);
   const notify=vi.fn();await command.handler("",{mode:"tui",cwd:f.cwd,ui:{notify}});
   expect(received.method).toBe("layout.apply");
   const file=received.params.root.command.at(-1);
   expect(fs.statSync(path.dirname(file)).mode&0o777).toBe(0o700);
   expect(fs.statSync(file).mode&0o777).toBe(0o600);
   expect(JSON.parse(fs.readFileSync(file,"utf8"))).toMatchObject({connected:true,cwd:f.cwd,version:1});
   await shutdown();
   expect(JSON.parse(fs.readFileSync(file,"utf8"))).toMatchObject({connected:false});
   fs.rmSync(path.dirname(file),{recursive:true,force:true});
  } finally {
   process.env=env;await new Promise<void>(resolve=>server.close(()=>resolve()));f.dispose();
  }
 });
 it("launches argv directly, not a shell or relay",()=>{
  const params=dashboardLaunchParams("/tmp/a 'quoted'", "/tmp/private/snapshot.json","w5");
  expect(params.root.command[0]).toBe(process.execPath);
  expect(params.root.command[1]).toMatch(/dashboard\/viewer.mjs$/);
  expect(params.root.command.slice(-2)).toEqual(["--snapshot","/tmp/private/snapshot.json"]);
  expect(params).toMatchObject({workspace_id:"w5",focus:true,root:{type:"pane",cwd:"/tmp/a 'quoted'"}});
 });
});
