/** Supported offline graph checks. Never spawns agents or executes command/function node bodies. */
import {assertStructuredOutputSchema} from "./structured-output.ts";
import {checkNodeContract} from "./node-contracts.ts";
import {Type} from "typebox";
import {buildGraphFromScript} from "./graph-validator.ts";
import {runSuperstepGraph} from "./graph-executor.ts";
import {discoverAgents} from "./agents.ts";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";

export async function validateWorkflow(script: string, cwd: string, scenarios: Array<Record<string, unknown>> = []) {
 const {graph, meta} = buildGraphFromScript(script);
 const agents = discoverAgents(cwd, "both").agents;
 const known = new Set(agents.map(a => a.name));
 const errors: string[] = [], warnings: string[] = [];
 for (const node of graph.nodes.values()) {
  if (node.def.type === "agent") {
   const def = node.def;
   if (!known.has(def.agentName)) errors.push(`Unknown agent "${def.agentName}" at ${node.id}.`);
   else { try { if (def.outputSchema) await assertStructuredOutputSchema(def.outputSchema); checkNodeContract(cwd, def, agents.find(a => a.name === def.agentName)?.tools); } catch(error) { errors.push(`${node.id}: ${String(error)}`); } }
  }
  const incoming = [...graph.edges.values()].flat().filter(e => e.type === "direct" && e.to === node.id).length;
  if (incoming > 1 && node.join !== "selected" && [...graph.edges.values()].flat().some(e => e.type === "conditional"))
   warnings.push(`Node "${node.id}" has an all-predecessor barrier in a conditional graph. Use g.join("${node.id}", "selected") only for selected-branch reconvergence, or supply scenarios proving all predecessors run.`);
 }
 const simulations = [];
 for (const scenario of scenarios.slice(0,20)) {
  const result = await runSuperstepGraph(graph, {runId: "validation", maxIterations: 30,
   runNode: async node => ({result: Object.hasOwn(scenario,node.id) ? scenario[node.id] : {status:"ok",text:"",data:{}}})});
  simulations.push({status: result.status, path: result.path, error: result.error});
 }
 return {valid: errors.length === 0 && simulations.every(s => s.status === "completed"), name: meta.name,
  errors, warnings, simulations, scope: "Structural checks and supplied bounded scenarios only; arbitrary callback routes are not proven."};
}
export function registerWorkflowValidationTool(pi: ExtensionAPI) {
 pi.registerTool({name:"workflow_validate",label:"Validate workflow",description:"Offline structural/role checks and optional stub-result route scenarios. No agent, command, or function-node execution; no filesystem mutation.",
  parameters:Type.Object({script:Type.String(),scenarios:Type.Optional(Type.Array(Type.Record(Type.String(),Type.Any()),{maxItems:20}))}),
  async execute(_id,params,_signal,_update,ctx){
   try { const result=await validateWorkflow(params.script,ctx.cwd,params.scenarios);return {content:[{type:"text",text:JSON.stringify(result,null,2)}],details:result}; }
   catch(error){return {isError:true,content:[{type:"text",text:String(error)}],details:{valid:false}};}
  }});
}
