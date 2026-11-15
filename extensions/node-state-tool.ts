/**
 * node_state tool — durable per-node accumulator for long-running agents.
 *
 * Lets an agent running *as a graph node* (not a plain `subagent` call) write
 * incremental findings to a durable, reducer-folded buffer mid-run, so that
 * values discovered before a context compaction survive to the final result.
 *
 * Dispatch/reducer shaped (five verbs, closed vocabulary) — the host applies
 * a fixed reducer, never agent-supplied code. Scoped per node: every call is
 * tagged with the graph node's own id (PI_WORKFLOW_NODE_ID), so parallel
 * nodes never share a buffer and there is no write race to reason about.
 *
 * The accumulated buffer is folded into the node's `result.data` at node
 * completion, so downstream nodes read it as plain `state.<nodeId>.data.<key>`
 * — no tool call needed to read a completed node's data.
 *
 * Workflow-only: refuses with a clear error if PI_WORKFLOW_NODE_ID is absent
 * (main agent context, or a plain `subagent` tool call — which has a channel
 * dir but no node id, so channel presence alone cannot distinguish the two).
 * This is the deliberate asymmetry with ask_supervisor, which *is* available
 * to plain subagent calls.
 *
 * See .pi-workflow/plans/state-tool-durable-node-memory.md for full design.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChannelClient, PI_WORKFLOW_NODE_ID_ENV } from "./channel.ts";

// A short timeout: writes/reads resolve as soon as the host's synchronous
// reduce returns. Unlike ask (no timeout) or ask_supervisor
// (11 min fallback past the broker's 10-min expiry), node_state has nothing
// to wait on except the host process, so a generous-but-bounded deadline
// surfaces a wedged host rather than blocking the agent forever.
const NODE_STATE_TIMEOUT_MS = 5 * 1000;

const NodeStateParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("set"),
			Type.Literal("merge"),
			Type.Literal("append"),
			Type.Literal("get"),
			Type.Literal("list"),
		],
		{
			description:
				"set: overwrite a key (last-write-wins). " +
				"merge: shallow-merge an object into an existing/new key. " +
				"append: push a value onto an array at a key. " +
				"get: read one key's current value. " +
				"list: read the whole accumulator.",
		},
	),
	key: Type.Optional(
		Type.String({
			description: "Required for set/merge/append/get. Ignored for list.",
		}),
	),
	value: Type.Optional(
		Type.Unknown({
			description:
				"Required for set/merge/append (merge must be an object; append adds one element). " +
				"Ignored for get/list.",
		}),
	),
	meta: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Optional provenance/context stored alongside the value (set/merge/append only).",
		}),
	),
});

/**
 * Builds the `node_state` tool. Registered unconditionally (so the tool is
 * present in every agent's tool list) but refuses at execute() time unless
 * PI_WORKFLOW_NODE_ID is set — i.e. the agent is actually running as a graph
 * node, not in the main session or a plain `subagent` call.
 */
export function createNodeStateTool(): ToolDefinition {
	return defineTool({
		name: "node_state",
		label: "Node State",
		description: [
			"Accumulate intermediate findings into a durable, per-node buffer that survives context compaction.",
			"Workflow-only: available inside a workflow graph run (as an agent() node), not in standalone subagent calls.",
			"Private while running: set/merge/append/get/list touch ONLY this node's own buffer — never another node's data.",
			"Public once done: when this node completes, its buffer is folded into its result as data, readable by all nodes as s.<thisNodeId>.data.<key> in prompts/edges.",
			"So get/list are for your own in-flight bookkeeping; cross-node handoff happens via graph state, not this tool.",
			"Five actions: set | merge | append | get | list. Use it the moment you find a value — do not wait until the end.",
		].join(" "),
		parameters: NodeStateParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const action = params.action as "set" | "merge" | "append" | "get" | "list";
			const key = params.key as string | undefined;
			const value = params.value;
			const meta = params.meta as Record<string, unknown> | undefined;

			// Workflow-only gate. Channel presence alone is insufficient: a plain
			// `subagent` tool call also sets PI_WORKFLOW_CHANNEL_DIR/PI_WORKFLOW_RUN_ID
			// (verified in index.ts's single/parallel spawn paths). Only the graph
			// node runner sets PI_WORKFLOW_NODE_ID, so its presence is the one signal
			// that distinguishes a real graph node from any other child context.
			const client = ChannelClient.fromEnv();
			const nodeId = process.env[PI_WORKFLOW_NODE_ID_ENV];
			if (!client || !nodeId) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"node_state is only available inside a workflow graph run, as an agent() node — " +
								"not in standalone subagent calls or the main session. " +
								"If you need to persist intermediate work here, write to a file or report it in your final output instead.",
						},
					],
					details: { refused: true, reason: "not a graph node" },
				};
			}

			const reply = await client.ask(
				{
					kind: "state",
					// The channel protocol's human/supervisor fields are unused for state,
					// but `question` is required by the type; a short label is enough.
					question: `node_state ${action}${key ? ` ${key}` : ""}`,
					expectsReply: true,
					nodeId,
					agent: process.env["PI_SUBAGENT_CHILD_AGENT"],
					stateAction: { action, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}), ...(meta ? { meta } : {}) },
				},
				{ timeoutMs: NODE_STATE_TIMEOUT_MS },
			);

			const ok = reply.stateOk === true;
			const replyValue = reply.stateValue;

			const text = ok
				? describeOutcome(action, key, replyValue)
				: `node_state ${action} failed: ${reply.stateError ?? reply.reason ?? "unknown error"}`;

			return {
				content: [{ type: "text" as const, text }],
				details: {
					action,
					key,
					ok,
					value: ok ? replyValue : undefined,
					error: ok ? undefined : (reply.stateError ?? reply.reason ?? undefined),
				},
			};
		},
	});
}

function describeOutcome(
	action: string,
	key: string | undefined,
	value: unknown,
): string {
	switch (action) {
		case "set":
			return `node_state: set ${key ?? "(no key)"} = ${summarizeValue(value)}.`;
		case "merge":
			return `node_state: merged into ${key ?? "(no key)"}.`;
		case "append":
			return `node_state: appended to ${key ?? "(no key)"}.`;
		case "get":
			return `node_state: ${key} = ${summarizeValue(value)}.`;
		case "list":
			return `node_state: ${summarizeKeys(value)} keys accumulated.`;
		default:
			return `node_state: ${action} completed.`;
	}
}

/** Compact, non-exposing value summary for the tool's reply text. */
function summarizeValue(value: unknown): string {
	if (value === undefined) return "(unset)";
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
	if (typeof value === "object") {
		if (Array.isArray(value)) return `array(${value.length})`;
		return `object(${Object.keys(value).length} keys)`;
	}
	return String(value);
}

function summarizeKeys(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return String(Object.keys(value as Record<string, unknown>).length);
	}
	return "0";
}
