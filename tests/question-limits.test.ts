import { describe, it, expect, vi } from "vitest";
import { QUESTION_LIMITS, questionLengthError, questionHeader } from "../extensions/question-limits.ts";
import { validateQuestions } from "../extensions/ask-user-question-tui.ts";
import { human } from "../extensions/graph-dsl.ts";
import { createNodeRunner } from "../extensions/graph-node-runner.ts";
import { RequestBroker } from "../extensions/request-broker.ts";
import { createAskUserQuestionTool } from "../extensions/ask-tools.ts";
import { ChannelClient } from "../extensions/channel.ts";

const valid = () => ({ question: "q".repeat(240), header: "h".repeat(12), options: [{ label: "l".repeat(60), description: "d".repeat(160) }] });
describe("human-facing question limits", () => {
 it("accepts exact boundaries and rejects each overlong field with its limit", () => {
  expect(validateQuestions([valid()])).toBeUndefined();
  for (const field of ["question", "header", "label", "description"] as const) {
   const q = valid();
   if (field === "question" || field === "header") q[field] += "x";
   else q.options[0][field] += "x";
   expect(validateQuestions([q])).toContain(`${field} exceeds ${QUESTION_LIMITS[field]} characters`);
  }
 });
 it("counts Unicode characters, not UTF-16 surrogate halves", () => {
  expect(questionLengthError([{ question: "😀".repeat(240), header: "", options: [{ label: "界".repeat(60) }] }])).toBeUndefined();
  expect(questionHeader("😀".repeat(13))).toBe("😀".repeat(12));
 });
 it("does not cap detailed previews", () => {
  expect(validateQuestions([{ ...valid(), options: [{ label: "Approve", preview: "# Context\n".repeat(1000) }] }])).toBeUndefined();
 });
 it("rejects literal human prompts and option labels without silently rewriting routing values", () => {
  expect(() => human("q".repeat(241), { default: "skip" })).toThrow("240 characters");
  expect(() => human("Choose?", { options: ["x".repeat(61)] })).toThrow("60 characters");
  const def = human("Choose?", { options: ["x".repeat(60)], default: "x".repeat(60) });
  expect(def.default).toBe("x".repeat(60));
 });
 it("rejects expanded dynamic human prompts before asking the broker", async () => {
  const ask = vi.fn();
  const runner = createNodeRunner({ cwd: process.cwd(), runId: "test", spawnAgent: vi.fn(), broker: { ask } as never });
  const outcome = await runner({ id: "gate", def: human(() => "q".repeat(241), { default: "skip" }) }, {}, { step: 1, runId: "test" });
  expect(outcome.technicalFailure).toBe(true);
  expect(outcome.error).toContain("240 characters");
  expect(ask).not.toHaveBeenCalled();
 });
 it("shortens only generated display headers, preserving full node identity and option values", async () => {
  const ask = vi.fn().mockResolvedValue({ source: "human", text: "yes" });
  const runner = createNodeRunner({ cwd: process.cwd(), runId: "test", spawnAgent: vi.fn(), broker: { ask } as never });
  await runner({ id: "long_human_gate_identifier", def: human("Proceed?", { options: ["yes", "no"], default: "no" }) }, {}, { step: 1, runId: "test" });
  expect(ask.mock.calls[0][0]).toMatchObject({ nodeId: "long_human_gate_identifier", questions: [{ header: "long_human_g", options: [{ label: "yes" }, { label: "no" }] }] });
 });
 it("blocks oversized legacy/channel requests at broker ingress, but does not limit supervisor messages", async () => {
  const broker = new RequestBroker();
  const request = { runId: "test", kind: "human" as const, questions: [{ ...valid(), question: "q".repeat(241) }], expectsReply: true };
  const result = await broker.ask(request);
  expect(result.source).toBe("cancelled");expect(result.reason).toContain("240 characters");
  const supervisor = broker.ask({ ...request, id: "supervisor", kind: "supervisor" });
  broker.resolve("supervisor", { source: "supervisor", text: "ok" });
  expect((await supervisor).text).toBe("ok");
 });
 it("validates before creating a child IPC request, and advertises schema limits", async () => {
  const client = vi.spyOn(ChannelClient, "fromEnv");
  try {
   const tool = createAskUserQuestionTool();
   const result = await tool.execute("id", { questions: [{ ...valid(), question: "q".repeat(241) }] } as never, undefined as never, undefined as never, {} as never);
   expect(client).not.toHaveBeenCalled();
   expect(result.isError).toBe(true);
   const schema = tool.parameters as any;
   expect(schema.properties.questions.items.properties.question.maxLength).toBe(240);
   expect(schema.properties.questions.items.properties.header.maxLength).toBe(12);
  } finally { client.mockRestore(); }
 });
});
