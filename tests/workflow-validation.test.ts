import {describe,it,expect} from "vitest";
import {validateWorkflow} from "../extensions/workflow-validation.ts";
const script=(join:string)=>`export const meta={name:'diamond',description:'test'};const g=graph();g.node('start',()=>{throw Error('must not execute')});g.node('a',()=> 'a');g.node('b',()=> 'b');g.node('join',()=> 'done');${join}g.edge('start',(s,r)=>r.choice==='a'?'a':'b');g.edge('a','join');g.edge('b','join');g.edge('join',END);g.run({});`;
describe("offline workflow validation and explicit joins",()=>{
 it("supports both conditional branches with selected joins",async()=>{
  const result=await validateWorkflow(script("g.join('join','selected');"),process.cwd(),[{start:{choice:'a'}},{start:{choice:'b'}}]);
  expect(result.valid).toBe(true);expect(result.simulations.map(s=>s.path)).toEqual([["start","a","join"],["start","b","join"]]);
 });
 it("retains strict barriers and diagnoses conditional reconvergence",async()=>{
  const result=await validateWorkflow(script(""),process.cwd(),[{start:{choice:'a'}}]);
  expect(result.valid).toBe(false);expect(result.warnings.join()).toContain("all-predecessor");
 });
 it("keeps selected joins ready across retry cycles",async()=>{
  const source=script("g.join('join','selected');").replace("g.edge('join',END);","g.edge('join',(s,r)=>r.retry?'start':END);");
  // A scenario is constant per node, so exercise bounded retry plus a normal completion separately.
  const result=await validateWorkflow(source,process.cwd(),[{start:{choice:'a'},join:{retry:true}},{start:{choice:'b'},join:{retry:false}}]);
  expect(result.simulations[0].status).toBe('max_iterations');expect(result.simulations[0].path.slice(0,6)).toEqual(['start','a','join','start','a','join']);
  expect(result.simulations[1].status).toBe('completed');
 });
 it("does not weaken genuine parallel AND joins",async()=>{
  const source=script("g.join('join','selected');").replace("g.edge('start',(s,r)=>r.choice==='a'?'a':'b');","g.edge('start','a');g.edge('start','b');");
  const result=await validateWorkflow(source,process.cwd(),[{}]);
  expect(result.simulations[0].path).toEqual(["start","a","b","join"]);
 });
});
