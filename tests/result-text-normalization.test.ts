import {describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {agent, GraphBuilder, END} from "../extensions/graph-dsl.ts";
import {createNodeRunner, rehydrateState, withResultText} from "../extensions/graph-node-runner.ts";
import {runSuperstepGraph} from "../extensions/graph-executor.ts";

const schema = {type: "object", properties: {verdict: {type: "string", enum: ["accept"]}}, required: ["verdict"]};

describe("node result text normalization", () => {
 it.each(["success", "timeout", "schema-invalid", "schema-missing", "provider"])("preserves conversion for %s and after JSON replay", async kind => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "result-text-"));
  try {
   const missing = "Missing structured_output call";
   const single = kind === "success" ? {exitCode: 0, structuredOutput: {verdict: "accept"}} :
    kind === "schema-invalid" ? {exitCode: 0, structuredOutput: {verdict: "bad"}} :
    kind === "timeout" ? {exitCode: 1, timedOut: true, error: "Model generation exceeded 300000ms", structuredOutputFailed: true, structuredOutputError: missing} :
    kind === "provider" ? {exitCode: 1, errorMessage: "HTTP 401 unauthorized"} :
    {exitCode: 0, error: missing, structuredOutputFailed: true, structuredOutputError: missing};
   const spawn = vi.fn().mockResolvedValue({...single, finalOutput: kind === "success" ? "REVIEW_TEXT" : "", messages: []});
   const g = new GraphBuilder();
   g.node("review", agent("reviewer", () => "review", {outputSchema: schema}));
   g.node("report", s => s.review as never);
   g.edge("review", "report"); g.edge("report", END); g.run({});
   const runNode = createNodeRunner({cwd, runId: "text", spawnAgent: spawn as never});
   const result = await runSuperstepGraph(g.build(), {runId: "text", runNode});
   const review = result.state.review;
   expect(Object.getOwnPropertyDescriptor(review, "toString")).toMatchObject({enumerable: false});
   const rendered = String(review);
   if (kind === "success") expect(rendered).toBe("REVIEW_TEXT");
   else {
    expect(rendered).toContain(kind === "provider" ? "[failed]" : "[blocked]");
    expect(rendered).toContain(kind === "timeout" ? "Model generation exceeded" : kind === "provider" ? "HTTP 401" : kind === "schema-missing" ? missing : "verdict");
   }
   if (kind === "provider") expect(result.status).toBe("aborted");
   else expect(result.state.report).toMatchObject({text: rendered});
   expect(rendered).not.toContain("[object Object]");
   const serialized = JSON.stringify({review});
   expect(serialized).not.toContain("toString");
   const replayed = rehydrateState(JSON.parse(serialized));
   expect(String(replayed.review)).toBe(rendered);
   expect(spawn).toHaveBeenCalledTimes(1);
  } finally { fs.rmSync(cwd, {recursive: true, force: true}); }
 });
 it("keeps real text and empty success unchanged, and summarizes empty failures without mutating fields", () => {
  expect(String(withResultText({status: "blocked", text: "partial output", error: "timeout"}))).toBe("partial output");
  expect(String(withResultText({status: "ok", text: ""}))).toBe("");
  const blocked = withResultText({status: "blocked", text: " \n", reason: "need spec", blockedOn: "contract"});
  expect(String(blocked)).toBe("[blocked] (blocked on: contract) need spec");
  expect(blocked.text).toBe(" \n");
  expect(String(withResultText({status: "failed", text: ""}))).toBe("[failed]");
 });
});
