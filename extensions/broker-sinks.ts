/**
 * Broker sinks: how requests reach whoever answers them.
 *
 * Two sinks, one batch handler. The broker hands a coalesced batch; this
 * module splits it by kind and routes accordingly:
 *
 *  - human → the user's TUI (ctx.ui.select / ctx.ui.input), no timeout
 *  - supervisor → injected into the main agent's conversation via sendMessage,
 *    answered via the workflow_reply tool, 10-minute timeout (broker-owned)
 *
 * Both sinks degrade honestly when there is no UI: a human request falls to
 * its declared default (or cancelled), a supervisor request is skipped.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { RequestBroker, PendingRequest, BrokerResult } from "./request-broker.ts";
import { runAskUserQuestionTUI } from "./ask-user-question-tui.ts";
import { installRelayHookSink } from "./relay-hook.ts";

export interface BrokerSinkOptions {
	pi: ExtensionAPI;
	broker: RequestBroker;
}

/**
 * Wires both sinks into the broker's batch handler and registers the
 * `workflow_reply` tool. Idempotent: calling it twice is a no-op.
 */
export function installBrokerSinks(options: BrokerSinkOptions): void {
	const { pi, broker } = options;
	const relay = installRelayHookSink(pi, broker);

	broker.onBatch((batch) => {
		const human = batch.filter((r) => r.kind === "human");
		relay.offer(human);
		const supervisor = batch.filter((r) => r.kind === "supervisor");

		if (human.length > 0) void handleHumanBatch(pi, broker, human);
		if (supervisor.length > 0) void handleSupervisorBatch(pi, broker, supervisor);
	});

	registerWorkflowReplyTool(pi, broker);
}

/**
 * Renders human requests one at a time (dialogs are modal).
 *
 * No timeout: the user is watching the run. The only escape is explicit —
 * dismissing the dialog (Esc), which the sink reports as a cancellation.
 */
async function handleHumanBatch(
	pi: ExtensionAPI,
	broker: RequestBroker,
	requests: PendingRequest[],
): Promise<void> {
	const ctx = getCurrentContext(pi);

	for (const request of requests) {
		if (!ctx?.hasUI || !ctx.ui) {
			broker.cancel(request.id, "No UI available; the run has no interactive session.");
			continue;
		}

		// 1. TUI Mode: Renders custom batch questionnaire dialog
		if (ctx.mode === "tui") {
			try {
				const result = await runAskUserQuestionTUI(ctx, request.questions);
				if (result.cancelled) {
					broker.cancel(request.id, "Dismissed by the user.");
				} else {
					broker.resolve(request.id, {
						source: "human",
						text: result.answers[0]?.answer ?? undefined,
						answers: {
							questions: result.answers,
							cancelled: false,
						},
					});
				}
			} catch (error) {
				broker.cancel(
					request.id,
					`Custom TUI dialog failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			continue;
		}

		// 2. Non-TUI fallback (sequential select/input if UI exists)
		if (ctx.hasUI && ctx.ui) {
			try {
				const answers: any[] = [];
				let cancelled = false;

				for (let i = 0; i < request.questions.length; i++) {
					const q = request.questions[i];
					let answer: string | undefined;

					if (q.options && q.options.length > 0) {
						const labels = q.options.map((o) => o.label);
						answer = await ctx.ui.select(
							`${q.question} (${i + 1}/${request.questions.length}) [run: ${shortId(request.runId)}]`,
							labels,
						);
					} else {
						answer = await ctx.ui.input(
							`${q.question} (${i + 1}/${request.questions.length}) [run: ${shortId(request.runId)}]`,
							"Type your answer",
						);
					}

					if (answer === undefined || answer === "") {
						cancelled = true;
						break;
					}

					answers.push({
						questionIndex: i,
						kind: q.options ? "option" : "custom",
						answer: answer || null,
					});
				}

				if (cancelled) {
					broker.cancel(request.id, "Dismissed by the user.");
				} else {
					broker.resolve(request.id, {
						source: "human",
						text: answers[0]?.answer ?? undefined,
						answers: {
							questions: answers,
							cancelled: false,
						},
					});
				}
			} catch (error) {
				broker.cancel(
					request.id,
					`Dialog fallback failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			continue;
		}

		// 3. Headless fallback (use default answers if available)
		broker.cancel(request.id, "Headless fallback: no interactive TUI or CLI UI available.");
	}
}

/**
 * Injects each supervisor question into the main agent's conversation.
 *
 * `triggerTurn: true` makes the main agent actually think about it rather than
 * merely displaying the message. The main agent answers by calling the
 * `workflow_reply` tool, which resolves the broker entry.
 *
 * This only works because the run is in the background: a blocked main agent
 * cannot take a turn. The broker's expiry (10 min) catches the case where the
 * main agent answers in prose instead of calling the tool.
 */
async function handleSupervisorBatch(
	pi: ExtensionAPI,
	broker: RequestBroker,
	requests: PendingRequest[],
): Promise<void> {
	for (const request of requests) {
		if (!request.expectsReply) {
			// Fire-and-forget progress update: deliver and resolve immediately.
			try {
				pi.sendMessage({
					customType: "workflow-progress",
					content: formatProgressMessage(request),
					display: true,
				});
			} catch {
				// Best-effort; a display failure must not crash a run.
			}
			broker.resolve(request.id, { source: "supervisor", text: "delivered" });
			continue;
		}

		// Already embedded inline in the subagent tool result — the main agent
		// already has the question and will call workflow_reply. Sending a second
		// sendMessage would trigger a duplicate turn for the same request.
		if (request.inlineDelivered) continue;

		const message = formatSupervisorQuestion(request);
		try {
			pi.sendMessage(
				{
					customType: "workflow-agent-question",
					content: message,
					display: true,
					details: {
						requestId: request.id,
						runId: request.runId,
						nodeId: request.nodeId,
						agent: request.agent,
					},
				},
				{ triggerTurn: true },
			);
		} catch {
			// If sendMessage fails (stale ctx after /reload), the broker's
			// expiry will catch it — but we can cancel immediately instead.
			broker.cancel(request.id, "Could not deliver the question to the supervisor session.");
		}
	}
}

/**
 * Registers the `workflow_reply` tool for the main agent.
 *
 * The main agent calls this to answer a supervisor question injected by
 * `handleSupervisorBatch`. Without it, the agent would have to answer in prose
 * and the child would sit blocked until expiry.
 */
function registerWorkflowReplyTool(pi: ExtensionAPI, broker: RequestBroker): void {
	const toolExists = (() => {
		try {
			return pi.getAllTools?.()?.some((t: { name?: string }) => t.name === "workflow_reply") === true;
		} catch {
			return false;
		}
	})();
	if (toolExists) return;

	pi.registerTool(
		defineTool({
			name: "workflow_reply",
			label: "Workflow Reply",
			promptSnippet:
				"Answer a workflow-agent-question message from a subagent. Call this tool to reply to a subagent's ask_supervisor question.",
			description:
				"MANDATORY: Answer a question that a workflow subagent asked you via ask_supervisor. " +
				"You will see the question as a [workflow-agent-question] message with a requestId; " +
				"call this tool with that requestId and your answer. " +
				"Do NOT reply in plain text — the subagent is blocked waiting for this tool call.",
			parameters: Type.Object({
				requestId: Type.String({
					description: "The requestId from the [workflow-agent-question] message.",
				}),
				answer: Type.String({
					description: "Your answer to the subagent's question.",
				}),
			}),
			promptGuidelines: [
				"MANDATORY: When you receive a [workflow-agent-question] custom message in the conversation, you MUST answer it by calling the workflow_reply tool with the requestId from that message and your answer. " +
					"Do NOT reply in plain text or in thinking — the subagent is blocked and will time out after 10 minutes if you do not call the tool. " +
					"The answer should be a direct, actionable response to the subagent's question.",
			],
			async execute(_id, params) {
				broker.resolve(params.requestId as string, {
					source: "supervisor",
					text: params.answer as string,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: `Answer delivered to the requesting agent: "${params.answer}"`,
						},
					],
					details: { delivered: true, requestId: params.requestId },
				};
			},
		}),
	);
}

/**
 * Tracks the most recent ExtensionContext for use by the sinks.
 *
 * The context arrives in event handlers (tool_call, session_start, etc.) and
 * changes on /reload. The sinks need it for ctx.ui access, so we stash the
 * latest one.
 */
let latestCtx: ExtensionContext | undefined;

export function setBrokerContext(ctx: ExtensionContext | undefined): void {
	latestCtx = ctx;
}

function getCurrentContext(_pi: ExtensionAPI): ExtensionContext | undefined {
	return latestCtx;
}

function shortId(id: string): string {
	return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function formatProgressMessage(request: PendingRequest): string {
	const who = request.agent ? `Agent "${request.agent}"` : "A workflow agent";
	return `${who} [run: ${shortId(request.runId)}] reports:\n${request.questions[0]?.question ?? "(no message)"}`;
}

function formatSupervisorQuestion(request: PendingRequest): string {
	const who = request.agent ? `Agent "${request.agent}"` : "A workflow agent";
	const question = request.questions[0]?.question ?? "(no question)";
	return [
		`[workflow-agent-question · requestId: ${request.id} · run: ${shortId(request.runId)}]`,
		"",
		`**Mandatory action required:** ${who} is blocked waiting for your answer via \`ask_supervisor\`.`,
		"",
		`You MUST call the \`workflow_reply\` tool with exactly:\n  requestId: "${request.id}"\n  answer: "<your answer>"\nDo NOT reply in plain text — the subagent is blocked and will time out after 10 minutes if you do not use the tool.`,
		"",
		`Question: ${question}`,
	].join("\n");
}

/** A result that can be passed to the journal. */
export type { BrokerResult };
