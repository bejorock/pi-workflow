import {describe,it,expect} from "vitest";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {inspectResults} from "../extensions/result-inspection.ts";
import {WorkflowManager} from "../extensions/workflow-manager.ts";
import {WorkflowController} from "../extensions/workflow-controller.ts";

describe("durable outcome inspection",()=>{
 it("preserves delivery and engine outcomes separately",async()=>{
  const c=new WorkflowController(new WorkflowManager());c.begin("r","test",new AbortController());
  c.complete({runId:"r",name:"test",text:"aborted",status:"aborted"});
  expect(await c.wait("r")).toMatchObject({status:"completed",runStatus:"aborted",runId:"r"});
 });
 it("rehydrates full results and stable node visits from journals",()=>{
  const dir=mkdtempSync(join(tmpdir(),"inspect-"));
  try{
   writeFileSync(join(dir,"r.jsonl"),[
    {type:"graph_run",name:"test"},
    {type:"node",nodeId:"review",step:1,nodeType:"agent",status:"ok",result:{status:"ok",data:{verdict:"changes",findings:["x".repeat(200)]}}},
    {type:"node",nodeId:"review",step:2,nodeType:"agent",status:"ok",result:{status:"ok",data:{verdict:"accepted"}}},
    {type:"graph_result",status:"completed"},
   ].map(x=>JSON.stringify(x)).join("\n"));
   const manager=new WorkflowManager();manager.setJournalDir(dir);
   const agents=manager.listRuns()[0].agents;
   const result=inspectResults(agents,{nodeId:"review",limit:1,fields:["result.data.findings","applicationVerdict"]});
   expect(result.total).toBe(2);expect(result.nextOffset).toBe(1);
   expect(result.entries[0]).toMatchObject({applicationVerdict:"changes","result.data.findings":["x".repeat(200)]});
   expect(inspectResults(agents,{nodeId:"review",step:2}).entries[0]).toMatchObject({applicationVerdict:"accepted",executionStatus:"done",agentOutcome:"ok"});
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it("bounds oversized responses explicitly and refuses prototype traversal",()=>{
  const agents=[{id:1,label:"x",prompt:"",status:"done" as const,result:{text:"x".repeat(110000)}}];
  expect(inspectResults(agents,{}).entries[0]).toMatchObject({resultOmitted:true});
  expect(inspectResults(agents,{fields:["constructor.name"]}).entries[0]).toEqual({"constructor.name":undefined});
 });
});
