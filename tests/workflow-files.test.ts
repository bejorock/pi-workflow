import {describe,it,expect} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadSavedWorkflowScript,listSavedWorkflows,deleteSavedWorkflow} from "../extensions/workflow-library.ts";
import {graphScriptHash} from "../extensions/graph-journal.ts";
const script="export const meta={name:'file_test',description:'test'};const g=graph();g.node('ok',()=> 'done');g.edge('ok',END);g.run({});";
it("discovers JS-compatible .ts and rejects ambiguous names across operations",()=>{
 const cwd=mkdtempSync(join(tmpdir(),"wf-files-"));const dir=join(cwd,".pi-workflow/workflows");mkdirSync(dir,{recursive:true});
 try{
  writeFileSync(join(dir,"file_test.ts"),script);expect(loadSavedWorkflowScript(cwd,"file_test")).toBe(script);
  expect(listSavedWorkflows(cwd).some(w=>w.filePath.endsWith("file_test.ts"))).toBe(true);
  writeFileSync(join(dir,"file_test.js"),script);
  expect(()=>loadSavedWorkflowScript(cwd,"file_test")).toThrow("Ambiguous");
  expect(()=>listSavedWorkflows(cwd)).toThrow("Ambiguous");
  expect(()=>deleteSavedWorkflow(cwd,"file_test")).toThrow("Ambiguous");
  rmSync(join(dir,"file_test.js"));expect(deleteSavedWorkflow(cwd,"file_test")).toBe(true);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
it("hashes exact source with SHA-256",()=>{expect(graphScriptHash(script)).toHaveLength(64);expect(graphScriptHash(script+"\n")).not.toBe(graphScriptHash(script));});
