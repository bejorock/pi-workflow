import {agent} from "../extensions/graph-dsl.ts";
import {it,expect,vi} from "vitest";
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {checkNodeContract,prepareNodeInput,selectStateFields} from "../extensions/node-contracts.ts";
it("rejects malformed graph contract declarations early",()=>{
 for(const options of [{outputSchema:false},{outputSchema:null},{requiredTools:'read'},{handoff:[5]},{dependencies:[]}])expect(()=>agent('worker',()=>'',options as never)).toThrow();
});
it("preflights tools without granting excluded access and validates dependency freshness",()=>{
 const dir=mkdtempSync(join(tmpdir(),"node-contract-"));try{
  expect(()=>checkNodeContract(dir,{requiredTools:["edit"]},["read"])).toThrow("excluded");
  writeFileSync(join(dir,"input"),"version1");const hash=createHash("sha256").update("version1").digest("hex");
  checkNodeContract(dir,{dependencies:{input:hash}},undefined);
  writeFileSync(join(dir,"input"),"version2");expect(()=>checkNodeContract(dir,{dependencies:{input:hash}},undefined)).toThrow("Stale");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("bounds projected handoffs without losing full artifact or accepting unsafe fields",()=>{
 const dir=mkdtempSync(join(tmpdir(),"node-handoff-"));try{
  const state={review:{data:{findings:"x".repeat(2000),secret:"omitted"}}};
  const result=prepareNodeInput(dir,"run","review",1,"Task",state,{handoff:["review.data.findings"],maxHandoffChars:400});
  expect(result.prompt.length).toBeLessThanOrEqual(400);expect(readFileSync(result.artifact!,"utf8")).not.toContain("secret");
  expect(()=>selectStateFields(state,["__proto__.constructor"])).toThrow("Unsafe");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
