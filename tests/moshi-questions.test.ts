import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMoshiQuestion, CHAT_REPLY_LABEL } from "../extensions/moshi-questions.ts";
import { runAskUserQuestionTUI } from "../extensions/ask-user-question-tui.ts";
const questions = [{question: "Pick?", header: "Pick", options: [{label: "A", preview: "😀".repeat(3000)}]}];
const ctx = () => ({mode: "tui", cwd: "/tmp/test", sessionManager: {getSessionId: () => "parent-session", getSessionFile: () => "/tmp/session.jsonl"}} as unknown as ExtensionContext);
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("optional native Moshi questions", () => {
 it("publishes ordered native state once, with no approval action, preserving identity and capping UTF-8 preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moshi-question-")); const path = join(dir, "hook.sock");
  const messages: any[] = [];
  const server = createServer(socket => { let data = ""; socket.on("data", b => data += b); socket.on("end", () => { messages.push(JSON.parse(data)); socket.end(); }); });
  await new Promise<void>(r => server.listen(path, r));
  vi.stubEnv("MOSHI_SOCKET_PATH", path); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  try {
   const life = createMoshiQuestion(ctx(), "unique-question", questions);
   life.open(); life.open(); await life.close(); await life.close();
   expect(messages).toHaveLength(2);
   expect(messages[0]).toMatchObject({source: "pi", sessionId: "parent-session", toolName: "ask", eventName: "QuestionAsked", interactivePrompt: {toolUseId: "unique-question"}});
   expect(messages[0].actionId).toBeUndefined();
   const options = messages[0].interactivePrompt.questions[0].options;
   expect(options.at(-1).label).toBe(CHAT_REPLY_LABEL);
   expect(Buffer.byteLength(options[0].preview)).toBeLessThanOrEqual(8192);
   expect(options[0].preview).not.toContain("�");
   expect(messages[1]).toMatchObject({eventName: "QuestionResolved", interactivePrompt: {toolUseId: "unique-question"}});
  } finally { await new Promise<void>(r => server.close(() => r())); rmSync(dir,{recursive:true,force:true}); }
 });
 it("does not require Moshi or session metadata for local operation", async () => {
  vi.stubEnv("MOSHI_SOCKET_PATH", "/nonexistent/moshi.sock");
  const life = createMoshiQuestion({} as ExtensionContext,"id",questions); life.open(); await life.close();
 });
 it("never publishes from a headless child", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const life = createMoshiQuestion({} as ExtensionContext,"id",questions); life.open(); await life.close();
 });
});

describe("custom reply and cancellation", () => {
 const theme = {fg: (_:string,s:string)=>s};
 it("keeps the same tool pending for custom text and returns the text, not the reserved label", async () => {
  vi.stubEnv("MOSHI_SOCKET_PATH", "/nonexistent/moshi.sock");
  const context = ctx();
  const input = vi.fn().mockResolvedValue("Use a canary instead");
  context.ui = {input, custom: vi.fn(fn => new Promise(resolve => {
   const c = fn({requestRender(){}},theme,{},resolve); c.render(80); c.handleInput("\x1b[B"); c.handleInput("\r");
  }))} as any;
  const result = await runAskUserQuestionTUI(context, questions);
  expect(input).toHaveBeenCalledOnce();
  expect(result.answers).toEqual([{questionIndex:0,kind:"custom",answer:"Use a canary instead"}]);
 });
 it("discards all partial answers if custom text is cancelled", async () => {
  vi.stubEnv("MOSHI_SOCKET_PATH", "/nonexistent/moshi.sock");
  const context = ctx();
  context.ui = {input: vi.fn().mockResolvedValue(undefined), custom: vi.fn().mockResolvedValue({answers:[{questionIndex:0,kind:"custom",answer:CHAT_REPLY_LABEL}],cancelled:false})} as any;
  expect(await runAskUserQuestionTUI(context,questions)).toEqual({answers:[],cancelled:true});
 });
 it("aborts an active form without opening a custom input", async () => {
  vi.stubEnv("MOSHI_SOCKET_PATH", "/nonexistent/moshi.sock");
  const controller = new AbortController(); const context = ctx();
  context.ui = {input: vi.fn(),custom: vi.fn(fn => new Promise(resolve => {
   fn({requestRender(){}},theme,{},resolve); controller.abort();
  }))} as any;
  expect(await runAskUserQuestionTUI(context,questions,controller.signal)).toEqual({answers:[],cancelled:true});
  expect(context.ui.input).not.toHaveBeenCalled();
 });
});
