/** Metadata-only completion correction. Never executes a node or overrides infrastructure failure. */
import {Type} from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import type {WorkflowManager} from "./workflow-manager.ts";
import {validateStructuredOutputValue} from "./structured-output.ts";
export function registerResultCorrectionTool(pi: ExtensionAPI, manager: WorkflowManager): void {
 pi.registerTool({name:"workflow_correct_result",label:"Correct completion metadata",
  description:"Validate and append corrected completion metadata for a settled node with a schema error. No code/tools rerun, no technical-failure override. Does not replay routing or retroactively accept the application.",
  parameters:Type.Object({runId:Type.String({pattern:"^[a-zA-Z0-9_-]+$"}),step:Type.Number({minimum:1}),value:Type.Any()}),
  async execute(_id,params,_signal,_update,ctx){
   const active=manager.getRun(params.runId); if(active?.snapshot.status==="running") throw new Error("Cannot correct an active run.");
   const file=path.join(ctx.cwd,".pi-workflow","runs",`${params.runId}.jsonl`);
   const records=fs.readFileSync(file,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
   if(!records.some(r=>r.type==="graph_result"))throw new Error("Run must be settled before metadata correction.");
   const node=records.find(r=>r.type==="node"&&r.step===params.step);
   if(!node||node.status==="failed"||!node.result?.contractError||!node.result.completionSchema)throw new Error("Only schema-invalid completion metadata may be corrected; technical failures cannot be overridden.");
   const check=await validateStructuredOutputValue(node.result.completionSchema,params.value);
   if(check.status!=="valid")throw new Error(check.message);
   const result={...node.result,status:"ok",data:params.value,contractError:undefined,metadataCorrected:true};
   fs.appendFileSync(file,JSON.stringify({type:"result_correction",step:params.step,nodeId:node.nodeId,result,timestamp:Date.now()})+"\n");
   const live=active?.snapshot.agents.find(a=>a.step===params.step);if(live)manager.updateAgentField(params.runId,live.id,"result",result);
   return {content:[{type:"text",text:"Completion metadata corrected and journaled. No implementation or routing was replayed; inspect the result and explicitly decide how to proceed."}],details:{runId:params.runId,step:params.step,result}};
  }});
}
