/** Chat-only projection: no transcript output, prompts, tool arguments or reasoning in live cards. */
import type { ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { TSchema } from "typebox";
import type { WorkflowManager, RunKind } from "./workflow-manager.ts";
import { runKindLabel } from "./workflow-manager.ts";
import type { RequestBroker } from "./request-broker.ts";

export interface RunCard {
 version: 1; runId: string; name: string; kind: RunKind; status: string; elapsedMs: number;
 tokens: number; finished: number; active: number;
 rows: Array<{label: string; status: string; activity: string; elapsedMs?: number; lastActivityMs?: number; tools?: number}>;
 recent: string[];
}
const clean = (s: string, max = 140) => stripVTControlCharacters(s).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, max);
export function projectRunCard(manager: WorkflowManager, runId: string, broker?: RequestBroker, now = Date.now()): RunCard | undefined {
 const run = manager.getRun(runId); if (!run) return;
 const pending = broker?.listPending().filter(r => r.runId === runId || (run.runKind === "parallel" && r.runId.startsWith(`${runId}-`) && /^\d+$/.test(r.runId.slice(runId.length + 1)))) ?? [];
 let status: string = run.status === "stopped" && !run.settled ? "stopping" : run.status;
 if (run.status === "running") {
  if (pending.some(r => r.kind === "human")) status = "awaiting your answer";
  else if (pending.some(r => r.kind === "supervisor" && r.expectsReply)) status = "awaiting supervisor";
 }
 const recent: string[] = [];
 const rows = run.snapshot.agents.map(a => {
  const progress = a.liveProgress;
  const phase = progress?.phase ?? a.diagnostics?.phase;
  const resultStatus = a.result && typeof a.result === "object" && "status" in a.result ? a.result.status : undefined;
  const blocked = a.status === "done" && resultStatus === "blocked";
  let activity = a.status === "running" ? "Starting" : ({done: "Finished", error: "Failed", skipped: "Skipped", cached: "Cached", queued: "Queued", unknown: "Unknown"}[a.status] ?? a.status);
  if (a.status === "running") {
   activity = phase === "human_wait" ? "Awaiting your answer" : phase === "supervisor_wait" ? "Awaiting supervisor" : phase === "provider" ? "Waiting for provider" : phase === "generation" ? "Generating response" : phase === "tool" ? `Running ${clean(progress?.tool ?? "tool")}` : a.nodeType === "command" ? "Running command" : a.nodeType === "human" ? "Awaiting your answer" : a.nodeType === "fn" ? "Running function" : activity;
   if (progress?.path && phase === "tool") activity += ` · ${clean(progress.path)}`;
  }
  if (blocked) activity = "Blocked / escalated";
  // Only tool names/result status, never arbitrary assistant/thinking/result text.
  for (const h of (a.history ?? []).slice(-12)) {
   if (h.role === "assistant" && h.kind === "toolCall") recent.push(`${clean(a.label)} · ${clean(h.toolName)}`);
   else if (h.role === "toolResult") recent.push(`${clean(a.label)} · ${clean(h.toolName)} ${h.isError ? "failed" : "returned"}`);
  }
  return {label: clean(a.label), status: blocked ? "blocked" : a.status, activity, elapsedMs: a.status === "running" && a.startedAt ? now - a.startedAt : a.durationMs,
   lastActivityMs: progress?.lastActivityAt ? Math.max(0, now - progress.lastActivityAt) : undefined, tools: progress?.tools ?? a.toolUses};
 });
 const blocked = rows.filter(a => a.status === "blocked").length;
 const failed = rows.filter(a => a.status === "error").length;
 if (status === "completed" && blocked) status = `completed · ${blocked} blocked / escalated execution${blocked === 1 ? "" : "s"}`;
 if (status === "completed" && failed) status = `completed · ${failed} failed execution${failed === 1 ? "" : "s"}`;
 return {version: 1, runId, name: clean(run.snapshot.meta.name), kind: run.runKind ?? "unknown", status,
  elapsedMs: run.settled ? run.snapshot.durationMs : Math.max(0, now - run.startedAt), tokens: run.snapshot.totalTokens + run.snapshot.agents.filter(a => a.status === "running").reduce((sum, a) => sum + (a.liveProgress?.tokens ?? 0), 0),
  finished: rows.filter(a => ["done", "error", "blocked", "skipped", "cached"].includes(a.status)).length, active: rows.filter(a => a.status === "running").length,
  rows: rows.slice(-100), recent: recent.slice(-8)};
}
const seconds = (ms: number) => `${Math.max(0, Math.floor(ms / 1000))}s`;
export function cardLines(card: RunCard, expanded: boolean): string[] {
 const selected = expanded ? card.rows : [...card.rows.filter(r => r.status === "running"), ...card.rows.filter(r => r.status !== "running").slice(-3)].slice(0, 5);
 const lines = [`${runKindLabel(card.kind)} · ${card.name} · ${card.status} · ${seconds(card.elapsedMs)}`];
 for (const row of selected) {
  const icon = row.status === "running" ? "●" : row.status === "done" || row.status === "cached" ? "✓" : row.status === "error" ? "✗" : row.status === "blocked" ? "!" : "○";
  lines.push(`${icon} ${row.label} · ${row.activity}${row.elapsedMs !== undefined ? ` · ${seconds(row.elapsedMs)}` : ""}`);
  if (expanded && row.status === "running" && row.lastActivityMs !== undefined) lines.push(`  Last activity ${seconds(row.lastActivityMs)} ago${row.tools !== undefined ? ` · ${row.tools} tool calls` : ""}`);
 }
 if (selected.length < card.rows.length) lines.push(`… ${card.rows.length - selected.length} more executions`);
 lines.push(`${card.finished} finished · ${card.active} active${card.tokens ? ` · ${card.tokens} observed tokens` : ""} · /runs for details`);
 if (expanded) lines.push(`Run: ${card.runId}`, ...card.recent.map(s => `  ${s}`));
 return lines;
}
export const runCardRenderers: ToolRenderers = {
 renderCall(input, theme) {
  const args = (input ?? {}) as Record<string, unknown>;
  const name = typeof args.agent === "string" ? args.agent : typeof args.loadWorkflow === "string" ? args.loadWorkflow : typeof args.runId === "string" ? args.runId : typeof args.id === "string" ? args.id : Array.isArray(args.tasks) ? `${args.tasks.length} tasks` : "Run";
  return new Text(theme.fg("toolTitle", theme.bold(clean(name))), 0, 0);
 },
 renderResult(result, options, theme) {
  const details = result.details as {runCard?: RunCard} | undefined;
  const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  if (!details?.runCard) return new Text(text, 0, 0);
  const lines = cardLines(details.runCard, options.expanded);
  if (!options.isPartial) {
  if (options.expanded || details.runCard.status === "awaiting supervisor") lines.push(`\n${text}`);
  else { if (result.isError) lines.push(clean(text)); lines.push("Expand for full report"); }
 }
  return new Text(lines.map((line, i) => i === 0 ? theme.fg("accent", theme.bold(line)) : line).join("\n"), 0, 0);
 },
};
/** Attach to an explicitly identified run; no global latest-run guessing under parallel calls. */
export function withRunCard<P extends TSchema, D>(tool: ToolDefinition<P, D>, manager: WorkflowManager, broker?: RequestBroker,
 initialId?: (params: Parameters<typeof tool.execute>[1]) => string | undefined): ToolDefinition<P, D> {
 return {...tool, ...runCardRenderers,
 renderCall(args, theme, context) {
  const descriptor = runCardRenderers.renderCall!(args, theme, context);
  return {render: (width: number) => new Text(theme.fg("toolTitle", theme.bold(`${tool.label} · ${descriptor.render(Math.max(1, width))[0] ?? "Run"}`)), 0, 0).render(width), invalidate: () => descriptor.invalidate()};
 }, async execute(id, params, signal, onUpdate, ctx) {
  let runId = initialId?.(params);
  let latest: Awaited<ReturnType<typeof tool.execute>> | undefined;
  let last = 0;
  const attach = (result: Awaited<ReturnType<typeof tool.execute>>) => {
   const details = result.details as Record<string, unknown> | undefined;
   if (typeof details?.runId === "string") runId = details.runId;
   const card = runId ? projectRunCard(manager, runId, broker) : undefined;
   if (!card) return result;
   if (details?.controllerStatus === "supervisor") card.status = "awaiting supervisor";
   if (details?.timedOut) card.status = "wait timed out · execution continues";
   if (details?.waitingCancelled) card.status = "wait interrupted · execution continues";
   return {...result, details: {...details, runCard: card} as D};
  };
  const emit = () => {
   if (!onUpdate || !runId || Date.now() - last < 250) return;
   const card = projectRunCard(manager, runId, broker); if (!card) return;
   last = Date.now();
   onUpdate({content: [{type: "text", text: `${card.name}: ${card.status}; ${card.finished} finished, ${card.active} active`}], details: {...(latest?.details ?? {}), runId, runCard: card} as D});
  };
  const timer = onUpdate ? setInterval(emit, 1000) : undefined;
  try {
   emit();
   const result = await tool.execute(id, params, signal, update => { latest = update; const details = update.details as Record<string, unknown> | undefined; if (typeof details?.runId === "string") runId = details.runId; if (runId) emit(); else onUpdate?.(update); }, ctx);
   return attach(result);
  } finally { if (timer) clearInterval(timer); }
 }};
}
