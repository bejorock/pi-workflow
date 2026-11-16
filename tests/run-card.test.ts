import {afterEach, describe, expect, it, vi} from "vitest";
import {Type} from "typebox";
import {defineTool} from "@earendil-works/pi-coding-agent";
import {cardLines, projectRunCard, withRunCard} from "../extensions/run-card.ts";
import {WorkflowManager} from "../extensions/workflow-manager.ts";
import {RequestBroker} from "../extensions/request-broker.ts";
import type {AgentProgress} from "../extensions/types.ts";
const context = {} as Parameters<ReturnType<typeof defineTool>["execute"]>[4];
const theme = {fg: (_: string,s: string) => s, bold: (s: string) => s};
const progress = (overrides: Partial<AgentProgress> = {}): AgentProgress => ({index:1,agent:"worker",status:"running",task:"secret task",recentTools:[],recentOutput:["secret reasoning"],toolCount:2,tokens:0,durationMs:2000,diagnostics:{phase:"tool",streamBytes:0,argumentBytes:0,changeEvidence:"unknown"},currentTool:"read",currentPath:"src/auth.ts",lastActivityAt:1000,...overrides});
function setup(kind: "workflow" | "subagent" | "parallel" = "workflow") {
 const manager=new WorkflowManager();manager.registerRun("run-1",{name:"live_demo"},undefined,{runKind:kind});
 manager.markAgentStart("run-1",0,{id:1,label:"worker",status:"running",prompt:"secret task",nodeType:"agent",startedAt:100});
 return manager;
}
afterEach(()=>vi.useRealTimers());
describe("chat run cards",()=>{
 it("projects real activity without thinking, output, arguments or prompts",()=>{
  const m=setup();m.updateAgentProgress("run-1",1,progress());
  m.recordAgentHistory("run-1",1,{role:"assistant",kind:"thinking",text:"SECRET"});
  m.recordAgentHistory("run-1",1,{role:"assistant",kind:"toolCall",toolName:"read",args:"SECRET",text:"SECRET",path:"SECRET"});
  m.recordAgentHistory("run-1",1,{role:"toolResult",toolName:"read",text:"SECRET"});
  const card=projectRunCard(m,"run-1",undefined,4000)!;
  expect(card.rows[0]).toMatchObject({activity:"Running read · src/auth.ts",lastActivityMs:3000,tools:2});
  expect(cardLines(card,true).join("\n")).toContain("read returned");
  expect(JSON.stringify(card)).not.toMatch(/SECRET|secret/);
  expect(cardLines(card,false).join("\n")).not.toMatch(/%|ETA/);
 });
 it("distinguishes human/supervisor waiting and stopping, including parallel child IDs",async()=>{
  const m=setup("parallel"),broker=new RequestBroker();
  const pending=broker.ask({id:"question",runId:"run-1-1",kind:"supervisor",questions:[{question:"secret",header:"Test"}],expectsReply:true});
  expect(projectRunCard(m,"run-1",broker)!.status).toBe("awaiting supervisor");
  broker.cancelRun("run-1-1","end");await pending;
  const human=broker.ask({id:"human",runId:"run-1",kind:"human",expectsReply:true,questions:[{question:"secret",header:"Test",options:[{label:"Yes"}]}]});
  expect(projectRunCard(m,"run-1",broker)!.status).toBe("awaiting your answer");
  m.stopRun("run-1");expect(projectRunCard(m,"run-1",broker)!.status).toBe("stopping");
  broker.cancelRun("run-1","end");await human;
 });
 it("shows bounded compact rows, expanded tool history and stable settled duration",()=>{
  const m=setup();for(let i=2;i<=10;i++)m.markAgentStart("run-1",0,{id:i,label:`node-${i}`,status:i===10?"running":"done",prompt:""});
  const card=projectRunCard(m,"run-1")!;expect(card.finished).toBe(8);expect(card.active).toBe(2);
  expect(cardLines(card,false).length).toBeLessThanOrEqual(8);expect(cardLines(card,true).join("\n")).toContain("node-2");
  m.completeRun("run-1","OK");expect(projectRunCard(m,"run-1",undefined,Date.now()+50000)!.elapsedMs).toBe(m.getRun("run-1")!.snapshot.durationMs);
 });
 it("distinguishes a completed graph from successful execution outcomes",()=>{
  const m=setup();m.markAgentEnd("run-1",1,"done","blocked");
  m.updateAgentField("run-1",1,"result",{status:"blocked",text:"scope incomplete"});m.completeRun("run-1","HOLD");
  const card=projectRunCard(m,"run-1")!;expect(card.status).toContain("blocked / escalated");expect(card.rows[0].activity).toBe("Blocked / escalated");expect(card.finished).toBe(1);
 });
 it("throttles pending updates, cleans timers and preserves model result content/details",async()=>{
  vi.useFakeTimers();const m=setup();let finish!:()=>void;
  const tool=withRunCard(defineTool({name:"probe",label:"Probe",description:"test",parameters:Type.Object({}),async execute(_id,_p,_s,onUpdate){
   onUpdate?.({content:[{type:"text",text:"started"}],details:{runId:"run-1",value:42}});
   await new Promise<void>(r=>finish=r);m.completeRun("run-1","FULL REPORT");
   return {content:[{type:"text" as const,text:"FULL REPORT"}],details:{runId:"run-1",value:42}};
  }}),m);
  const updates: unknown[]=[];const promise=tool.execute("call",{},undefined,u=>updates.push(u),context);
  await vi.advanceTimersByTimeAsync(3100);expect(updates.length).toBe(4);finish();const result=await promise;
  expect(result.content).toEqual([{type:"text",text:"FULL REPORT"}]);expect(result.details).toMatchObject({value:42,runCard:{runId:"run-1",status:"completed"}});
  expect(vi.getTimerCount()).toBe(0);
  const compact=tool.renderResult!(result,{expanded:false,isPartial:false},theme as never,{} as never).render(100).join("\n");
  const expanded=tool.renderResult!(result,{expanded:true,isPartial:false},theme as never,{} as never).render(100).join("\n");
  expect(compact).not.toContain("FULL REPORT");expect(expanded).toContain("FULL REPORT");
 });
 it("keeps yielded questions visible, reattaches by identity and cleans up thrown execution",async()=>{
  vi.useFakeTimers();const m=setup();
  const tool=withRunCard(defineTool({name:"wait",label:"Wait",description:"test",parameters:Type.Object({runId:Type.String()}),async execute(){return {content:[{type:"text" as const,text:"QUESTION: decide"}],details:{runId:"run-1",controllerStatus:"supervisor"}};}}),m,undefined,p=>(p as {runId:string}).runId);
  const result=await tool.execute("call",{runId:"run-1"},undefined,()=>{},context);
  expect(tool.renderResult!(result,{expanded:false,isPartial:false},theme as never,{} as never).render(100).join("\n")).toContain("QUESTION: decide");
  expect(result.details).toMatchObject({runCard:{status:"awaiting supervisor"}});expect(vi.getTimerCount()).toBe(0);
  const broken=withRunCard({...tool,execute:async()=>{throw new Error("probe failure");}},m);
  await expect(broken.execute("bad",{runId:"run-1"},undefined,()=>{},context)).rejects.toThrow("probe failure");expect(vi.getTimerCount()).toBe(0);
 });
 it("does not mix simultaneously observed run identities or add timers headless",async()=>{
  vi.useFakeTimers();const m=setup();m.registerRun("run-2",{name:"other"});
  const tool=withRunCard(defineTool({name:"probe",label:"Probe",description:"test",parameters:Type.Object({runId:Type.String()}),async execute(_id,p){return {content:[{type:"text" as const,text:p.runId}],details:{runId:p.runId}};}}),m,undefined,p=>(p as {runId:string}).runId);
  const [a,b]=await Promise.all([tool.execute("a",{runId:"run-1"},undefined,undefined,context),tool.execute("b",{runId:"run-2"},undefined,undefined,context)]);
  expect(a.details).toMatchObject({runCard:{name:"live_demo"}});expect(b.details).toMatchObject({runCard:{name:"other"}});expect(vi.getTimerCount()).toBe(0);
 });
});
