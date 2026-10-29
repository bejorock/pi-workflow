/**
 * Tool definitions for user and supervisor communication.
 *
 * Implements:
 *  - ask_user_question: batched multi-question custom TUI, registered for both
 *    parent and child agents.
 *  - ask_supervisor: lets child agents ask the main agent for decisions.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	runAskUserQuestionTUI,
	validateQuestions,
	type TUIQuestion,
	type TUIAnswer,
} from "./ask-user-question-tui.ts";
import { ChannelClient } from "./channel.ts";
import type { RequestBroker } from "./request-broker.ts";

// ── Schemas ──────────────────────────────────────────────────────────────

const TUIOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option, max 60 chars" }),
	description: Type.Optional(Type.String({ description: "Optional description of trade-offs" })),
	preview: Type.Optional(Type.String({ description: "Markdown preview text shown beside/below options" })),
});

const TUIQuestionSchema = Type.Object({
	question: Type.String({ description: "The full question text to display, ending with ?" }),
	header: Type.String({ description: "Short tab label, max 16 chars" }),
	options: Type.Optional(Type.Array(TUIOptionSchema, { description: "Options to choose from" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections" })),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(TUIQuestionSchema, { description: "1 to 4 questions to ask" }),
});

const AskSupervisorParams = Type.Object({
	question: Type.String({ description: "The question to ask the supervisor (main agent)" }),
	expectsReply: Type.Optional(
		Type.Boolean({ description: "Whether you expect a reply or if it is a progress report (default: true)" }),
	),
	default: Type.Optional(Type.String({ description: "Default answer to proceed with on timeout" })),
});

// ── Tool Definitions ────────────────────────────────────────────────────

function formatToolResultText(
	questions: TUIQuestion[],
	answers: TUIAnswer[],
	cancelled: boolean,
): string {
	if (cancelled) {
		return "User cancelled the question.";
	}
	if (!answers || answers.length === 0) {
		return "No answers provided.";
	}

	return (
		"Questions answered successfully:\n" +
		answers
			.map((ans) => {
				const q = questions[ans.questionIndex];
				const header = q ? q.header : `Question ${ans.questionIndex + 1}`;
				const value = ans.answer ?? "(no answer)";
				const noteSuffix = ans.notes ? ` (Note: ${ans.notes})` : "";
				return `- ${header}: ${value}${noteSuffix}`;
			})
			.join("\n")
	);
}

/**
 * The `ask_user_question` tool.
 *
 * Full-parity custom TUI questionnaire. Child agents route through the
 * filesystem channel; a parent may use the shared RequestBroker so optional
 * external interaction sinks receive the same request as the local TUI.
 */
export function createAskUserQuestionTool(broker?: RequestBroker): ToolDefinition {
	return defineTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more questions. Can specify options (with descriptions and markdown previews), " +
			"multi-select mode, per-option notes, and a free-text 'Other' choice. Renders a unified tabbed dialog.",
		parameters: AskUserQuestionParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions = params.questions as TUIQuestion[];

			// 1. Child process check
			const client = ChannelClient.fromEnv();
			if (client) {
				const reply = await client.ask({
					kind: "human",
					question: questions[0]?.question ?? "Questionnaire",
					expectsReply: true,
					questions: questions.map((q) => ({
						question: q.question,
						header: q.header,
						options: q.options?.map((o) => ({ label: o.label, description: o.description })),
						multiSelect: q.multiSelect,
					})),
				});

				const cancelled = reply.source === "cancelled" || reply.source === "timeout";
				const replyAnswers = reply.answers ?? [];

				return {
					content: [
						{
							type: "text" as const,
							text: formatToolResultText(questions, replyAnswers, cancelled),
						},
					],
					details: {
						answers: replyAnswers,
						cancelled,
						error: reply.source === "timeout" ? "timeout" : undefined,
					},
				};
			}

			// 2. Parent process: validation first
			const validationError = validateQuestions(questions);
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `Validation failed: ${validationError}` }],
					details: { answers: [], cancelled: false, error: validationError },
				};
			}

			// 3. Parent process: shared broker. This is intentionally after
			// validation and the child check: it preserves the existing tool schema
			// while making direct parent asks visible to optional interaction sinks.
			if (broker) {
				const result = await broker.ask({
					id: `parent-ask:${_id}`,
					runId: "parent",
					kind: "human",
					questions,
					expectsReply: true,
				});
				const cancelled = result.source === "cancelled" || result.source === "timeout";
				const answers = result.answers?.questions ?? [];
				return {
					content: [{ type: "text" as const, text: formatToolResultText(questions, answers, cancelled) }],
					details: {
						answers,
						cancelled,
						error: result.source === "timeout" ? "timeout" : undefined,
					},
				};
			}

			// 4. Parent process: direct TUI fallback (used without a broker)
			if (ctx.mode === "tui" && ctx.ui) {
				const result = await runAskUserQuestionTUI(ctx, questions);
				return {
					content: [
						{
							type: "text" as const,
							text: formatToolResultText(questions, result.answers, result.cancelled),
						},
					],
					details: result,
				};
			}

			// 5. Parent process: non-TUI fallback (sequential select/input if UI exists)
			if (ctx.hasUI && ctx.ui) {
				const answers: TUIAnswer[] = [];
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					let ans: string | undefined;

					if (q.options && q.options.length > 0) {
						ans = await ctx.ui.select(
							`${q.question} (${i + 1}/${questions.length})`,
							q.options.map((o) => o.label),
						);
					} else {
						ans = await ctx.ui.input(`${q.question} (${i + 1}/${questions.length})`);
					}

					if (ans === undefined) {
						return {
							content: [{ type: "text" as const, text: "User cancelled the question." }],
							details: { answers: [], cancelled: true },
						};
					}

					answers.push({
						questionIndex: i,
						kind: q.options ? "option" : "custom",
						answer: ans || null,
					});
				}

				return {
					content: [
						{
							type: "text" as const,
							text: formatToolResultText(questions, answers, false),
						},
					],
					details: { answers, cancelled: false },
				};
			}

			// 6. Parent process: headless fallback (use defaults)
			const answers: TUIAnswer[] = questions.map((q, i) => ({
				questionIndex: i,
				kind: "option",
				answer: null,
			}));

			return {
				content: [
					{
						type: "text" as const,
						text: formatToolResultText(questions, answers, false),
					},
				],
				details: { answers, cancelled: false },
			};
		},
	});
}

/**
 * The `ask_supervisor` tool.
 *
 * Lets a child subagent ask the main agent (the supervisor) for a decision
 * or report progress. The question is injected into the main agent's session
 * and answered via the workflow_reply tool.
 */
export function createAskSupervisorTool(): ToolDefinition {
	return defineTool({
		name: "ask_supervisor",
		label: "Ask Supervisor",
		description:
			"Ask the supervisor (the orchestrator/main agent) for a decision or instruction. " +
			"Use this when you are blocked, need a choice resolved, or need to report progress.",
		parameters: AskSupervisorParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const { question, expectsReply, default: defVal } = params;
			const shouldReply = expectsReply !== false;

			// 1. Child process check
			const client = ChannelClient.fromEnv();
			if (client) {
				// Include agent identity so the parent can route the detach signal correctly
				const childAgent = process.env["PI_SUBAGENT_CHILD_AGENT"];
				const childIndex = process.env["PI_SUBAGENT_CHILD_INDEX"]
					? parseInt(process.env["PI_SUBAGENT_CHILD_INDEX"]!, 10)
					: 0;

				const reply = await client.ask({
					kind: "supervisor",
					question: question as string,
					expectsReply: shouldReply,
					default: defVal as string | undefined,
					agent: childAgent,
					nodeId: childIndex > 0 ? String(childIndex) : undefined,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: reply.answer
								? `Supervisor answered: ${reply.answer}`
								: `Supervisor request completed (${reply.source}).`,
						},
					],
					details: {
						answer: reply.answer ?? null,
						source: reply.source,
						reason: reply.reason,
					},
				};
			}

			// 2. Parent process: mock fallback (supervisor cannot ask itself)
			return {
				content: [
					{
						type: "text" as const,
						text: `Called from supervisor session directly. Answered with default fallback: "${
							defVal ?? "proceed"
						}"`,
					},
				],
				details: {
					answer: defVal ?? "proceed",
					source: "default",
					reason: "Called in parent session; no child channel active.",
				},
			};
		},
	});
}
