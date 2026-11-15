/** Bounded, identical node-result inspection for live and journal-rehydrated runs. */
import type { WorkflowAgentSnapshot } from "./workflow-display-types.ts";

export interface ResultSelection {
 agentId?: number; nodeId?: string; step?: number; fields?: string[];
 offset?: number; limit?: number; historyLimit?: number;
}
function field(value: unknown, path: string): unknown {
 let current = value;
 for (const key of path.split(".")) {
  if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
  current = (current as Record<string, unknown>)[key];
 }
 return current;
}
export function inspectResults(agents: WorkflowAgentSnapshot[], selection: ResultSelection) {
 const matching = agents.filter(a => (selection.agentId === undefined || a.id === selection.agentId) &&
  (selection.nodeId === undefined || a.nodeId === selection.nodeId) && (selection.step === undefined || (a.step ?? a.id) === selection.step));
 const offset = Math.max(0, Math.floor(selection.offset ?? 0));
 const limit = Math.max(1, Math.min(100, Math.floor(selection.limit ?? 20)));
 const historyLimit = Math.max(0, Math.min(1000, Math.floor(selection.historyLimit ?? 100)));
 const entries = matching.slice(offset, offset + limit).map(a => {
  const value = {...a, history: a.history?.slice(-historyLimit || (a.history.length + 1)),
   historyTotal: a.history?.length ?? 0, historyTruncated: (a.history?.length ?? 0) > historyLimit,
   executionStatus: a.status, agentOutcome: field(a.result, "status"),
   // Verdict is agent/application data, never inferred from successful execution.
   applicationVerdict: field(a.result, "data.verdict") ?? field(a.result, "verdict")};
  const selected = selection.fields?.length ? Object.fromEntries(selection.fields.map(key => [key, field(value, key)])) : value;
  const text = JSON.stringify(selected);
  // Do not silently drop result fields or pretend a preview is the full result.
  if (text.length > 100_000) return {id: a.id, nodeId: a.nodeId, step: a.step ?? a.id, resultOmitted: true,
   reason: "Result exceeds 100000 characters; request narrower fields or inspect the journal/session artifact.", sessionId: a.sessionId};
  return selected;
 });
 return {found: matching.length > 0, entries, total: matching.length, offset, limit,
  nextOffset: offset + entries.length < matching.length ? offset + entries.length : undefined};
}
