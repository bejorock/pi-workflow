/** Native Pi-style questionnaire: numbered choices, tabs, complete submission, and custom replies. */
import { Key, matchesKey, Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { questionLengthError } from "./question-limits.ts";
import { CHAT_REPLY_LABEL, createMoshiQuestion, questionChoices } from "./moshi-questions.ts";

export interface TUIOption { label: string; description?: string; preview?: string; }
export interface TUIQuestion { question: string; header: string; options?: TUIOption[]; multiSelect?: boolean; }
export interface TUIAnswer {
	questionIndex: number;
	kind: "option" | "custom" | "chat" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
}
export interface TUIResult {
	answers: TUIAnswer[];
	cancelled: boolean;
	error?: "no_ui" | "no_questions" | "too_many_questions" | "duplicate_question" | "duplicate_option_label" |
		"reserved_label" | "empty_options" | "multi_select_unsupported" | `Question ${string}`;
}
const RESERVED = new Set(["other", "type something.", CHAT_REPLY_LABEL.toLowerCase()]);
export function validateQuestions(questions: TUIQuestion[]): TUIResult["error"] | undefined {
	if (!questions?.length) return "no_questions";
	if (questions.length > 4) return "too_many_questions";
	const lengthError = questionLengthError(questions);
	if (lengthError) return lengthError as `Question ${string}`;
	const seen = new Set<string>();
	for (const q of questions) {
		if (q.multiSelect) return "multi_select_unsupported";
		const key = q.question.trim().toLowerCase();
		if (seen.has(key)) return "duplicate_question";
		seen.add(key);
		if (q.options?.length === 0) return "empty_options";
		const labels = new Set<string>();
		for (const option of q.options ?? []) {
			const label = option.label.trim().toLowerCase();
			if (labels.has(label)) return "duplicate_option_label";
			labels.add(label);
			if (RESERVED.has(label)) return "reserved_label";
		}
	}
}
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** The custom-reply row is part of the published choices, so the phone can select it too. */
export async function runAskUserQuestionTUI(
	ctx: ExtensionContext, questions: TUIQuestion[], signal?: AbortSignal, toolUseId = `ask-${randomUUID()}`,
): Promise<TUIResult> {
	if (ctx.mode !== "tui" || !ctx.ui) return { answers: [], cancelled: false, error: "no_ui" };
	const error = validateQuestions(questions);
	if (error) return { answers: [], cancelled: false, error };
	if (signal?.aborted) return { answers: [], cancelled: true };
	const lifecycle = createMoshiQuestion(ctx, toolUseId, questions);
	let cancel: (() => void) | undefined;
	let publishTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await ctx.ui.custom<TUIResult>((tui, theme, _kb, done) => {
			let tab = 0;
			let cursor = 0;
			let previewOffset = 0;
			let finished = false;
			const answers = new Map<number, TUIAnswer>();
			const finish = (cancelled: boolean) => {
				if (finished) return;
				finished = true;
				done({ answers: cancelled ? [] : [...answers.values()].sort((a, b) => a.questionIndex - b.questionIndex), cancelled });
			};
			cancel = () => finish(true);
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) queueMicrotask(cancel);
			const refresh = () => tui.requestRender();
			const moveTab = (next: number) => { tab = next; cursor = 0; previewOffset = 0; refresh(); };
			const allAnswered = () => questions.every((_, i) => answers.has(i));
			return {
				handleInput(data: string) {
					if (finished) return;
					if (matchesKey(data, Key.escape)) { finish(true); return; }
					if (questions.length > 1) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { moveTab((tab + 1) % (questions.length + 1)); return; }
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { moveTab((tab + questions.length) % (questions.length + 1)); return; }
					}
					if (tab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) finish(false);
						return;
					}
					const choices = questionChoices(questions[tab]);
					if (matchesKey(data, Key.up)) { cursor = Math.max(0, cursor - 1); previewOffset = 0; refresh(); return; }
					if (matchesKey(data, Key.down)) { cursor = Math.min(choices.length - 1, cursor + 1); previewOffset = 0; refresh(); return; }
					if (matchesKey(data, Key.pageDown)) { previewOffset += 5; refresh(); return; }
					if (matchesKey(data, Key.pageUp)) { previewOffset = Math.max(0, previewOffset - 5); refresh(); return; }
					if (!matchesKey(data, Key.enter)) return;
					answers.set(tab, { questionIndex: tab, kind: cursor === choices.length - 1 ? "custom" : "option", answer: choices[cursor].label });
					if (questions.length === 1) finish(false);
					else moveTab(tab + 1);
				},
				render(width: number) {
					// Publish only after a real render, never a queued/headless request.
					if (!publishTimer && !finished) publishTimer = setTimeout(() => { if (!finished) lifecycle.open(); }, 100);
					const w = Math.max(1, width);
					const lines: string[] = [theme.fg("accent", "─".repeat(w))];
					const add = (text: string) => lines.push(...wrapTextWithAnsi(text, w));
					if (questions.length > 1) {
						add(` ← ${questions.map((q, i) => `${answers.has(i) ? "■" : "□"} ${clean(q.header)}${i === tab ? " •" : ""}`).join("   ")}   ✓ Submit →`);
						lines.push("");
					}
					if (tab === questions.length) {
						add(theme.fg("accent", " Ready to submit"));
						for (let i = 0; i < questions.length; i++) add(` ${clean(questions[i].header)}: ${clean(answers.get(i)?.answer ?? "(unanswered)")}`);
						add(allAnswered() ? " Press Enter to submit" : " Answer every question before submitting.");
					} else {
						const q = questions[tab];
						add(` ${clean(q.question)}`);
						lines.push("");
						const choices = questionChoices(q);
						for (let i = 0; i < choices.length; i++) {
							add(`${i === cursor ? "> " : "  "}${i + 1}. ${clean(choices[i].label)}`);
							if (choices[i].description) add(`     ${clean(choices[i].description!)}`);
						}
						const option = choices[cursor];
						if ("preview" in option && option.preview) {
							const preview = new Markdown(clean(option.preview), 0, 0, getMarkdownTheme()).render(w);
							const rows = Math.max(2, Math.min(10, Math.floor((tui.terminal?.rows ?? 30) / 3)));
							previewOffset = Math.min(previewOffset, Math.max(0, preview.length - rows));
							lines.push("");
							add(theme.fg("muted", ` Preview (${previewOffset + 1}–${Math.min(preview.length, previewOffset + rows)}/${preview.length}) · PgUp/PgDn`));
							lines.push(...preview.slice(previewOffset, previewOffset + rows));
						}
					}
					lines.push("");
					add(questions.length > 1 ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : " ↑↓ navigate • Enter select • Esc cancel");
					lines.push(theme.fg("accent", "─".repeat(w)));
					return lines.map(line => truncateToWidth(line, w));
				},
				invalidate() {},
			};
		});
		// Retire the native question BEFORE opening an ordinary input dialog.
		// Moshi refuses Chat View prompt submission while pendingPrompt exists.
		if (publishTimer) clearTimeout(publishTimer);
		await lifecycle.close();
		if (result.cancelled || signal?.aborted) return { answers: [], cancelled: true };
		for (const answer of result.answers) {
			if (answer.kind !== "custom") continue;
			const q = questions[answer.questionIndex];
			const text = await ctx.ui.input(`${q.header}: your answer (terminal or Chat View)`, "Describe what you prefer instead", { signal });
			if (!text?.trim() || signal?.aborted) return { answers: [], cancelled: true };
			answer.answer = text.trim();
		}
		return result;
	} finally {
		if (publishTimer) clearTimeout(publishTimer);
		if (cancel) signal?.removeEventListener("abort", cancel);
		await lifecycle.close();
	}
}
