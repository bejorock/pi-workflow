import { describe, it, expect, vi, afterEach } from "vitest";
import { WorkflowController, SupervisorReminders } from "../extensions/workflow-controller.ts";
import { RequestBroker } from "../extensions/request-broker.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { installResultDelivery } from "../extensions/result-delivery.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function setup() {
 const broker=new RequestBroker({coalesceMs:0});const manager=new WorkflowManager();
 const controller=new WorkflowController(manager,broker);
 const abort=new AbortController();controller.begin("r","test",abort);
 manager.registerRun("r",{name:"test"},abort);
 return {broker,manager,controller,abort};
}
const ask=(broker:RequestBroker,id="q",runId="r")=>broker.ask({id,runId,kind:"supervisor",questions:[{question:"Choose an approach?",header:"Decision"}],expectsReply:true});
afterEach(()=>vi.useRealTimers());

describe("foreground workflow controller",()=>{
 it("returns supervisor attention, retains identity and waits for stored completion",async()=>{
  const {broker,controller}=setup();
  const answer=ask(broker);
  const first=await controller.wait("r");
  expect(first.status).toBe("supervisor");expect(first.text).toContain("Choose an approach?");
  expect(broker.listPending()[0].inlineDelivered).toBe(true);
  const repeat=await controller.wait("r");
  expect(repeat.text).not.toContain("Choose an approach?");expect(repeat.text).toContain("already delivered");
  broker.resolve("q",{source:"supervisor",text:"proceed"});expect((await answer).text).toBe("proceed");
  controller.complete({runId:"r",name:"test",text:"FINAL"});
  expect((await controller.wait("r")).text).toBe("FINAL");
  expect((await controller.wait("r")).status).toBe("already_delivered");
  expect(controller.takeUndeliveredReports()).toEqual([]);
 });
 it("collects multiple outstanding questions and forbids a second workflow while waiting/paused",async()=>{
  const {broker,controller,manager}=setup();
  void ask(broker,"q1");void ask(broker,"q2");manager.pauseRun("r");
  expect(()=>controller.begin("r2","second",new AbortController())).toThrow("Only one active");
  expect((await controller.wait("r")).requestIds).toEqual(["q1","q2"]);
  controller.stopAll();expect(broker.listPending()).toEqual([]);expect(manager.getRun("r")?.status).toBe("stopped");
 });
 it("interruption stops run, cancels broker/UI signals and awaits settlement",async()=>{
  const {broker,controller,abort}=setup();
  const human=broker.ask({id:"h",runId:"r",kind:"human",questions:[{question:"Proceed?",header:"Gate"}],expectsReply:true});
  const uiSignal=broker.signalFor("h")!;
  const parent=new AbortController();
  const done=new Promise<void>(resolve=>abort.signal.addEventListener("abort",()=>setTimeout(()=>{controller.complete({runId:"r",name:"test",text:"STOPPED"});resolve();},10)));
  controller.setDone("r",done);
  const waiting=controller.wait("r",parent.signal);parent.abort();
  expect(uiSignal.aborted).toBe(true);expect((await human).source).toBe("cancelled");
  expect((await waiting).status).toBe("stopped");
  expect(controller.takeUndeliveredReports()).toEqual([]);
 });
 it("retains one slot until old execution settles and isolates late completion",async()=>{
  const {controller}=setup();controller.stop("r");
  expect(()=>controller.begin("next","next",new AbortController())).toThrow("Only one active");
  controller.complete({runId:"r",name:"old",text:"old report"});
  controller.begin("next","next",new AbortController());
  controller.complete({runId:"r",name:"old",text:"late old report"});
  expect(controller.activeRunId()).toBe("next");
 });
 it("suppresses manager follow-ups for controlled runs",()=>{
  const {manager,controller}=setup();const sendMessage=vi.fn();
  installResultDelivery({sendMessage} as never,manager,id=>controller.owns(id));
  controller.complete({runId:"r",name:"test",text:"FINAL"});manager.completeRun("r","done");
  expect(sendMessage).not.toHaveBeenCalled();
  expect(controller.takeUndeliveredReports().map(r=>r.text)).toEqual(["FINAL"]);
  expect(controller.takeUndeliveredReports()).toEqual([]);
 });
});

describe("idle-aware supervisor reminders",()=>{
 it("never interrupts investigation; sends three reminders then one human notification; new requests restart",async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);
  const {broker,controller}=setup();const send=vi.fn(),notify=vi.fn();
  const reminders=new SupervisorReminders(broker,controller,send,notify,30);
  void ask(broker);broker.markInlineDelivered("q");
  reminders.busy(0);reminders.tick(10000);expect(send).not.toHaveBeenCalled();
  let now=10000;
  for(let n=1;n<=3;n++) {
   reminders.settled(now);reminders.tick(now+29);expect(send).toHaveBeenCalledTimes(n-1);
   reminders.tick(now+31);expect(send).toHaveBeenCalledTimes(n);expect(notify).not.toHaveBeenCalled();
   reminders.tick(now+999);expect(send).toHaveBeenCalledTimes(n);now+=1000;
  }
  reminders.settled(now);reminders.tick(now+31);expect(notify).toHaveBeenCalledTimes(1);
  for(let j=0;j<10;j++)reminders.tick(now+1000+j*1000);
  expect(send).toHaveBeenCalledTimes(3);expect(notify).toHaveBeenCalledTimes(1);
  broker.resolve("q",{source:"supervisor",text:"yes"});reminders.tick(now+12000);
  const next=ask(broker,"new");broker.markInlineDelivered("new");
  now+=13000;reminders.settled(now);reminders.tick(now);reminders.tick(now+31);
  expect(send.mock.calls.at(-1)?.[0]).toContain("Reminder 1/3");
  broker.resolve("new",{source:"supervisor",text:"yes"});await next;
 });
 it("reply, stop and expiry prevent further reminders",async()=>{
  const {broker,controller}=setup();const send=vi.fn(),notify=vi.fn();
  const reminders=new SupervisorReminders(broker,controller,send,notify,10);
  void ask(broker);broker.markInlineDelivered("q");reminders.settled(0);reminders.tick(0);
  broker.resolve("q",{source:"supervisor",text:"yes"});reminders.tick(100);expect(send).not.toHaveBeenCalled();
  void ask(broker,"next");broker.markInlineDelivered("next");reminders.tick(100);controller.stopAll();
  reminders.tick(1000);expect(send).not.toHaveBeenCalled();expect(notify).not.toHaveBeenCalled();
 });
 it("fallback claims undelivered questions and reports only once",async()=>{
  const {broker,controller}=setup();const send=vi.fn();const reminders=new SupervisorReminders(broker,controller,send,vi.fn(),10);
  void ask(broker);reminders.settled(0);reminders.tick(11);
  expect(send).toHaveBeenCalledTimes(1);expect(broker.listPending()[0].inlineDelivered).toBe(true);
  const wait=await controller.wait("r");expect(wait.text).not.toContain("Choose an approach?");
  broker.resolve("q",{source:"supervisor",text:"yes"});controller.complete({runId:"r",name:"test",text:"FINAL"});
  reminders.settled(20);reminders.tick(31);expect(send).toHaveBeenCalledTimes(2);
  expect((await controller.wait("r")).status).toBe("already_delivered");
 });
 it("does not timeout controlled requests during long investigations",()=>{
  vi.useFakeTimers();vi.setSystemTime(0);
  const {broker}=setup();void ask(broker);
  vi.setSystemTime(60*60*1000);broker.tick();expect(broker.hasPending("q")).toBe(true);
 });
});

it("production workflow call waits, yields for supervisor, and wait resumes without duplicate reports",async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"pi-controller-"));
 const manager=new WorkflowManager(),broker=new RequestBroker(),controller=new WorkflowController(manager,broker);
 let id="";
 const spawn=vi.fn(async()=>{
  const answer=await broker.ask({id:"real-request",runId:id,kind:"supervisor",questions:[{question:"Proceed?",header:"Gate"}],expectsReply:true});
  return {agent:"worker",task:"test",exitCode:0,messages:[{role:"assistant",content:[{type:"text",text:answer.text}]}]};
 });
 try {
  const tool=createGraphWorkflowTool({cwd,workflowManager:manager,broker,controller,spawnAgent:spawn as never,onRunStart:r=>id=r.runId});
  const response=await tool.execute("test",{script:"export const meta={name:'controlled',description:'test'}; const g=graph(); g.node('a',agent('worker',()=> 'test'));g.edge('a',END);g.run({});"} as never,new AbortController().signal,undefined,{cwd} as never);
  expect((response.details as any).status).toBe("supervisor");
  broker.resolve("real-request",{source:"supervisor",text:"proceed"});
  expect((await controller.wait(id)).text).toContain("completed");expect(controller.takeUndeliveredReports()).toEqual([]);
 } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});
