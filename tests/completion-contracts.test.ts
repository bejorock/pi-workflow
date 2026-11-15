import {it,expect,vi} from "vitest";
import * as fs from "node:fs";import * as os from "node:os";import * as path from "node:path";
import {agent,GraphBuilder,END} from "../extensions/graph-dsl.ts";
import {createNodeRunner} from "../extensions/graph-node-runner.ts";
import {registerResultCorrectionTool} from "../extensions/result-correction.ts";
import {WorkflowManager} from "../extensions/workflow-manager.ts";
import {readGraphJournal} from "../extensions/graph-journal.ts";
const schema={type:"object",properties:{verdict:{type:"string",enum:["accept","reject"]}},required:["verdict"],additionalProperties:false};
function node(options:Record<string,unknown>){const g=new GraphBuilder();g.node("review",agent("reviewer",()=>"review",options));g.edge("review",END);g.run({start:"review"});return g.build().nodes.get("review")!;}
it("folds validated structured data and marks invalid capture blocked without rerunning",async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"completion-"));try{
  const spawn=vi.fn().mockResolvedValue({exitCode:0,messages:[],structuredOutput:{verdict:"accept"},usage:{totalTokens:3}});
  const run=createNodeRunner({cwd,runId:"test",spawnAgent:spawn as never});
  const result=await run(node({outputSchema:schema}),{}, {step:1,runId:"test"});
  expect(result.result).toMatchObject({status:"ok",data:{verdict:"accept"}});expect(spawn.mock.calls[0][3].structuredOutput.schema).toEqual(schema);
  spawn.mockResolvedValue({exitCode:0,messages:[],structuredOutput:{verdict:"unknown"}});
  const bad=await run(node({outputSchema:schema}),{}, {step:2,runId:"test"});expect(bad.result).toMatchObject({status:"blocked",completionSchema:schema});
  expect(spawn).toHaveBeenCalledTimes(2);
  spawn.mockResolvedValue({exitCode:1,messages:[],errorMessage:"HTTP 401 unauthorized",stopReason:"error",structuredOutput:{verdict:"accept"}});
  const failure=await run(node({outputSchema:schema}),{}, {step:3,runId:"test"});expect(failure.technicalFailure).toBe(true);
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
it.each(["timeout", "provider", "schema-only"])("does not expose %s as correctable execution metadata", async(kind)=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"completion-"));try{
  const missing="Missing structured_output call";
  const spawn=vi.fn().mockResolvedValue({exitCode:kind==="schema-only"?0:1,messages:[],structuredOutputFailed:true,structuredOutputError:missing,
   ...(kind==="timeout"?{timedOut:true,error:"Model generation exceeded 300000ms without completing an assistant message."}:kind==="provider"?{errorMessage:"HTTP 401 unauthorized"}:{error:missing})});
  const run=createNodeRunner({cwd,runId:"test",spawnAgent:spawn as never});
  const result=await run(node({outputSchema:schema}),{}, {step:1,runId:"test"});
  expect(result.result).toMatchObject({structuredOutputError:missing});
  if(kind==="schema-only"){
   expect(result.result).toMatchObject({status:"blocked",contractError:missing,completionSchema:schema});
   expect(result.error).toBeUndefined();
  }else{
   expect(result.result).not.toHaveProperty("contractError");
   expect(result.result).not.toHaveProperty("completionSchema");
   expect(result.error).toContain(kind==="timeout"?"Model generation exceeded":"HTTP 401");
   expect(Boolean(result.technicalFailure)).toBe(kind==="provider");
  }
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
it("bounds final message handoff and keeps full output in an artifact",async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"completion-"));try{
  const text="original ".repeat(1000);const spawn=vi.fn().mockResolvedValue({exitCode:0,messages:[{role:"assistant",content:[{type:"text",text}]}]});
  const run=createNodeRunner({cwd,runId:"test",spawnAgent:spawn as never});const result=await run(node({maxHandoffChars:400}),{}, {step:1,runId:"test"});
  const value=result.result as {text:string;outputArtifact:string};expect(value.text.length).toBeLessThanOrEqual(400);expect(fs.readFileSync(value.outputArtifact,"utf8")).toBe(text);
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
it("corrects schema-only completion metadata, preserving technical failures and requiring a settled journal",async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"correct-"));try{
  const dir=path.join(cwd,".pi-workflow/runs");fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,"run.jsonl");
  const records=[{type:"node",step:1,nodeId:"review",status:"ok",result:{status:"blocked",contractError:"invalid",completionSchema:schema}},{type:"graph_result",status:"completed"}];
  fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join("\n")+"\n");let tool:any;
  registerResultCorrectionTool({registerTool:(t:any)=>tool=t} as never,new WorkflowManager());
  const call=(value:unknown)=>tool.execute("id",{runId:"run",step:1,value},undefined,undefined,{cwd});
  await expect(call({verdict:"nonsense"})).rejects.toThrow();await call({verdict:"accept"});
  expect(readGraphJournal(file).find(r=>r.type==="node")).toMatchObject({result:{data:{verdict:"accept"},metadataCorrected:true}});
  records[0].status="failed";fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join("\n")+"\n");await expect(call({verdict:"accept"})).rejects.toThrow("technical");
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
