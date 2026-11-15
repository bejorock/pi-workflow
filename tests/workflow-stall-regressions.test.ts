import {afterEach, describe, expect, it, vi} from "vitest";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GraphBuilder, agent, END, human} from "../extensions/graph-dsl.ts";
import {runSuperstepGraph} from "../extensions/graph-executor.ts";
import {createNodeRunner} from "../extensions/graph-node-runner.ts";
import {runSingleAgent} from "../extensions/execution.ts";
import {createGraphWorkflowTool} from "../extensions/graph-tool.ts";
import {WorkflowController} from "../extensions/workflow-controller.ts";
import {WorkflowManager} from "../extensions/workflow-manager.ts";
import type {AgentConfig} from "../extensions/agents.ts";
const dirs: string[]=[];
const temporary=()=>{const d=mkdtempSync(join(tmpdir(),"pi-stall-test-"));dirs.push(d);return d;};
afterEach(()=>{vi.unstubAllEnvs(); for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const agentConfig: AgentConfig={name:"worker",description:"fixture",systemPrompt:"Return a result",source:"user",filePath:"/tmp/worker.md",inheritProjectContext:false,inheritSkills:false};
async function fixture(body:string, options: Omit<Parameters<typeof runSingleAgent>[3], "runId">={}) {
 const cwd=temporary(); const bin=join(cwd,"pi.cjs");
 writeFileSync(bin,`#!${process.execPath}\n${body}\n`,{mode:0o755});vi.stubEnv("PI_SUBAGENT_PI_BINARY",bin);
 return runSingleAgent(cwd,agentConfig,"test",{runId:"stall-regression",context:"fresh",...options});
}
const emit=(event:object)=>`console.log(${JSON.stringify(JSON.stringify(event))});`;

describe("bounded child completion",()=>{
 it("escalates cancellation when a child ignores SIGTERM",async()=>{
  const abort=new AbortController(); let started=false;
  const result=await fixture(`process.on('SIGTERM',()=>{});${emit({type:"turn_end",turnIndex:0})}setInterval(()=>{},1000);`,{
   signal:abort.signal,onEvent:()=>{if(!started){started=true;abort.abort();}}
  });
  expect(started).toBe(true);expect(result.interrupted).toBe(true);expect(result.exitCode).toBe(130);
 },8000);
 it("completes after direct child exit even with inherited open pipes",async()=>{
  const result=await fixture(`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});${emit({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"done"}]}]})}process.exit(0);`);
  expect(result.exitCode).toBe(0);expect(result.finalOutput).toBe("done");
 },8000);
 it("drains a settled child that has an extension keeping it alive",async()=>{
  const result=await fixture(`${emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"settled"}]}})}${emit({type:"agent_settled"})}process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  expect(result.exitCode).toBe(0);expect(result.exitSignal).toBeNull();expect(result.finalOutput).toBe("settled");
 },8000);
 it("bounds an unfinished assistant generation without applying a wall clock limit to tools",async()=>{
  vi.stubEnv("PI_WORKFLOW_GENERATION_TIMEOUT_MS","50");
  const result=await fixture(`${emit({type:"message_start",message:{role:"assistant"}})}setInterval(()=>console.log(JSON.stringify({type:'message_update'})),10);`);
  expect(result.timedOut).toBe(true);expect(result.error).toContain("Model generation exceeded 50ms");
 });
 it("preserves a real nonzero exit even after a settled event",async()=>{
  const result=await fixture(`${emit({type:"agent_settled"})}process.exit(7);`);
  expect(result.exitCode).toBe(7);
 });
 it("bounds a provider request that never starts streaming",async()=>{
  vi.stubEnv("PI_WORKFLOW_GENERATION_TIMEOUT_MS","100");
  const result=await fixture(`setInterval(()=>{},1000);`);
  expect(result.timedOut).toBe(true);
  expect(result.error).toContain("Model generation exceeded 100ms");
 });
 it("keeps the watchdog paused until all parallel tools complete",async()=>{
  vi.stubEnv("PI_WORKFLOW_GENERATION_TIMEOUT_MS","500");
  const result=await fixture(`${emit({type:"tool_execution_start",toolName:"ask"})}${emit({type:"tool_execution_start",toolName:"read"})}${emit({type:"tool_execution_end",toolName:"read"})}${emit({type:"message_end",message:{role:"toolResult",content:[]}})}setTimeout(()=>{${emit({type:"agent_settled"})}process.exit(0)},800);`);
  expect(result.timedOut).toBeUndefined();expect(result.exitCode).toBe(0);
 });
 it("does not time out a human/tool wait after the assistant message completed",async()=>{
  vi.stubEnv("PI_WORKFLOW_GENERATION_TIMEOUT_MS","500");
  const result=await fixture(`${emit({type:"message_start",message:{role:"assistant"}})}${emit({type:"message_end",message:{role:"assistant",content:[]}})}${emit({type:"tool_execution_start",toolName:"ask"})}setTimeout(()=>{${emit({type:"agent_settled"})}process.exit(0)},800);`);
  expect(result.timedOut).toBeUndefined();expect(result.exitCode).toBe(0);
 });
});

describe("graph failure ownership",()=>{
 it("cancels a stuck parallel sibling and returns without its cooperation",async()=>{
  const g=new GraphBuilder();for(const id of ["start","bad","stuck"])g.node(id,agent("worker",()=>id));
  g.edge("start","bad");g.edge("start","stuck");g.edge("bad",END);g.edge("stuck",END);g.run();
  let siblingSignal: AbortSignal|undefined;
  const result=await runSuperstepGraph(g.build(),{runId:"round",runNode:async(n,_s,ctx)=>{
   if(n.id==="stuck"){siblingSignal=ctx.signal;return new Promise(()=>{});}
   return n.id==="bad"?{result:null,technicalFailure:true,error:"original failure"}:{result:"ok"};
  }});
  expect(siblingSignal?.aborted).toBe(true);expect(result.status).toBe("aborted");
  expect(result.history.find(n=>n.nodeId==="bad")?.error).toContain("original failure");
  expect(result.error).toContain("original failure");
 },8000);
 it("releases the controller slot when startup callbacks throw",async()=>{
  const manager=new WorkflowManager();const controller=new WorkflowController(manager);let fail=true;
  const tool=createGraphWorkflowTool({cwd:temporary(),controller,onRunStart:()=>{if(fail)throw new Error("startup failed");}});
  const params={script:"export const meta={name:'startup',description:'test'};const g=graph();g.node('one',()=> 'ok');g.edge('one',END);g.run({});"};
  const ctx={sessionManager:{getSessionId:()=>"test"}} as any;
  await expect(tool.execute("first",params as never,undefined,undefined,ctx)).rejects.toThrow("startup failed");
  expect(controller.activeRunId()).toBeUndefined();fail=false;
  const result=await tool.execute("next",params as never,undefined,undefined,ctx);
  expect(result.content[0]).toMatchObject({type:"text",text:expect.stringContaining("completed")});
 });
 it("bounds function nodes while preserving captured closures",async()=>{
  const prefix="closure"; const runner=createNodeRunner({cwd:temporary(),runId:"fn",spawnAgent:vi.fn() as never});
  expect((await runner({id:"ok",def:{type:"fn",fn:()=>prefix}}, {}, {step:1,runId:"fn"})).technicalFailure).toBeUndefined();
  const bad=await runner({id:"loop",def:{type:"fn",fn:()=>{while(true){} }}}, {}, {step:2,runId:"fn"});
  expect(bad.technicalFailure).toBe(true);expect(bad.error).toContain("Script execution timed out");
 });
});
