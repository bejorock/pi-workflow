import {it,expect} from "vitest";
import {GraphBuilder,END} from "../extensions/graph-dsl.ts";
import {runSuperstepGraph} from "../extensions/graph-executor.ts";
it("pauses only after a full parallel wave and resumes without replaying nodes",async()=>{
 const g=new GraphBuilder();for(const id of ["start","a","b","join"])g.node(id,()=>id);
 g.edge("start","a");g.edge("start","b");g.edge("a","join");g.edge("b","join");g.edge("join",END);g.run({});
 let checkpoint:any;const calls:string[]=[];
 const first=await runSuperstepGraph(g.build(),{runId:"budget",runNode:async n=>{calls.push(n.id);return {result:n.id,tokens:10,toolCalls:2};},
  shouldPause:history=>history.reduce((sum,n)=>sum+(n.tokens??0),0)>=20,onRoundComplete:info=>checkpoint=info});
 expect(first.status).toBe("paused");expect(calls).toEqual(["start","a","b"]);expect(checkpoint.nextFrontier).toEqual(["join"]);
 const next=await runSuperstepGraph(g.build(),{runId:"resume",runNode:async n=>{calls.push(n.id);return {result:n.id};},resume:{state:first.state,resumeFromFrontier:checkpoint.nextFrontier,remainingInDegree:checkpoint.remainingInDegree,remainingClaimsBySource:checkpoint.remainingClaimsBySource,completedRounds:first.iterations,completedNodeExecutions:first.nodeExecutions,executedNodeIds:first.path,history:first.history}});
 expect(next.status).toBe("completed");expect(calls).toEqual(["start","a","b","join"]);
});
