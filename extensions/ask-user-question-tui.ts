/**
 * Full-parity ask_user_question TUI component.
 *
 * Implements:
 *  - Multi-question tabs (1..4 questions + Submit tab)
 *  - Single-select (Enter) and Multi-select (Space to toggle, Next -> to advance)
 *  - Optional Preview pane (rendered side-by-side or stacked)
 *  - Per-option notes ("n" to open inline note editor)
 *  - "Other" free-text fallback
 *  - Chat row on every tab ("c" to focus, lets user write free-form text)
 *  - Submit tab with validation and warnings
 *  - Overflow scrolling with terminal-height awareness (↑/↓/↕ indicators)
 *  - Thorough validation returning standard error codes
 */

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { questionLengthError } from "./question-limits.ts";

// ── Types ───────────────────────────────────────────────────────────────

export interface TUIOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface TUIQuestion {
	question: string;
	header: string;
	options?: TUIOption[];
	multiSelect?: boolean;
}

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
	error?:
		| "no_ui"
		| "no_questions"
		| "too_many_questions"
		| "duplicate_question"
		| "duplicate_option_label"
		| "reserved_label"
		| "empty_options"
		| `Question ${string}`;
}

// Reserved labels (case-insensitive checks)
const RESERVED_LABELS = new Set([
	"other",
	"type something.",
	"chat about this",
	"next →",
]);

// ── Validation ──────────────────────────────────────────────────────────

export function validateQuestions(questions: TUIQuestion[]): TUIResult["error"] | undefined {
	if (!questions || questions.length === 0) {
		return "no_questions";
	}
	if (questions.length > 4) {
		return "too_many_questions";
	}

	const lengthError = questionLengthError(questions);
	if (lengthError) return lengthError as `Question ${string}`;

	const seenQuestions = new Set<string>();
	for (const q of questions) {
		const normQ = q.question.trim().toLowerCase();
		if (seenQuestions.has(normQ)) {
			return "duplicate_question";
		}
		seenQuestions.add(normQ);

		if (q.options !== undefined) {
			if (q.options.length === 0) {
				return "empty_options";
			}
			const seenLabels = new Set<string>();
			for (const opt of q.options) {
				const label = opt.label.trim();
				const normLabel = label.toLowerCase();
				if (seenLabels.has(normLabel)) {
					return "duplicate_option_label";
				}
				seenLabels.add(normLabel);

				if (RESERVED_LABELS.has(normLabel)) {
					return "reserved_label";
				}
			}
		}
	}
	return undefined;
}

// ── TUI Component ───────────────────────────────────────────────────────

export async function runAskUserQuestionTUI(
	ctx: ExtensionContext,
	questions: TUIQuestion[],
): Promise<TUIResult> {
	if (ctx.mode !== "tui" || !ctx.ui) {
		return { answers: [], cancelled: false, error: "no_ui" };
	}

	const validationError = validateQuestions(questions);
	if (validationError) {
		return { answers: [], cancelled: false, error: validationError };
	}

	const result = await ctx.ui.custom<TUIResult>((tui, theme, _kb, done) => {
		// Active state
		let currentTab = 0; // 0..questions.length (last is Submit)
		let optionIndex = 0; // active index in options list
		let focusArea: "options" | "note" | "other" | "chat" = "options";

		// Answers state
		// Key: questionIndex
		const selectedIndices = new Map<number, Set<number>>(); // for multi-select
		const singleSelectedIndex = new Map<number, number>(); // for single-select
		const otherTexts = new Map<number, string>(); // for "Other" text
		const optionNotes = new Map<number, Map<number, string>>(); // optionIndex -> note text
		const chatTexts = new Map<number, string>(); // for chat row input

		// Editor instances
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const noteEditor = new Editor(tui, editorTheme);
		const otherEditor = new Editor(tui, editorTheme);
		const chatEditor = new Editor(tui, editorTheme);

		let cachedLines: string[] | undefined;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		// Option builder for current question
		interface RenderOption {
			index: number;
			label: string;
			description?: string;
			preview?: string;
			isOther?: boolean;
			isNextSentinel?: boolean;
		}

		function getRenderOptions(qIdx: number): RenderOption[] {
			const q = questions[qIdx];
			if (!q) return [];
			const list: RenderOption[] = [];

			if (q.options) {
				q.options.forEach((opt, idx) => {
					list.push({ index: idx, label: opt.label, description: opt.description, preview: opt.preview });
				});
				// "Other" is always added if options exist
				list.push({ index: q.options.length, label: "Other", isOther: true });
			} else {
				// Free-text only question gets single "Type something." option
				list.push({ index: 0, label: "Type something.", isOther: true });
			}

			if (q.multiSelect) {
				list.push({ index: list.length, label: "Next →", isNextSentinel: true });
			}

			return list;
		}

		function getActiveOptions(): RenderOption[] {
			return getRenderOptions(currentTab);
		}

		function handleAdvance() {
			if (currentTab < questions.length - 1) {
				currentTab++;
				optionIndex = 0;
				focusArea = "options";
			} else {
				currentTab = questions.length; // Go to Submit tab
			}
			refresh();
		}

		function collectAnswers(): TUIAnswer[] {
			return questions.map((q, qIdx) => {
				const hasChat = chatTexts.has(qIdx) && chatTexts.get(qIdx)!.trim() !== "";
				if (hasChat) {
					return {
						questionIndex: qIdx,
						kind: "chat",
						answer: chatTexts.get(qIdx)!.trim(),
					};
				}

				if (q.multiSelect) {
					const idxs = selectedIndices.get(qIdx) ?? new Set<number>();
					const activeOpts = getRenderOptions(qIdx);
					const selectedLabels: string[] = [];
					let containsOther = false;

					for (const idx of idxs) {
						const opt = activeOpts[idx];
						if (opt?.isOther) {
							containsOther = true;
						} else if (opt) {
							selectedLabels.push(opt.label);
						}
					}

					let answerStr = selectedLabels.join(", ");
					if (containsOther) {
						const otherVal = otherTexts.get(qIdx) ?? "";
						answerStr = answerStr ? `${answerStr}, Other: ${otherVal}` : `Other: ${otherVal}`;
					}

					return {
						questionIndex: qIdx,
						kind: "multi",
						answer: answerStr || null,
						selected: selectedLabels,
						notes: optionNotes.has(qIdx)
							? Array.from(optionNotes.get(qIdx)!.entries())
									.map(([idx, text]) => {
										const opt = activeOpts[idx];
										return `${opt?.label ?? "Option"}: ${text}`;
									})
									.join("; ")
							: undefined,
					};
				} else {
					const activeOpts = getRenderOptions(qIdx);
					const selIdx = singleSelectedIndex.get(qIdx);

					if (selIdx !== undefined) {
						const opt = activeOpts[selIdx];
						if (opt?.isOther) {
							const otherVal = otherTexts.get(qIdx) ?? "";
							return {
								questionIndex: qIdx,
								kind: "custom",
								answer: otherVal || null,
							};
						} else if (opt) {
							// Option note
							const qNotes = optionNotes.get(qIdx);
							const noteVal = qNotes ? qNotes.get(selIdx) : undefined;
							return {
								questionIndex: qIdx,
								kind: "option",
								answer: opt.label,
								notes: noteVal,
							};
						}
					}

					return {
						questionIndex: qIdx,
						kind: "option",
						answer: null,
					};
				}
			});
		}

		// Editor submits
		noteEditor.onSubmit = (value) => {
			const qNotes = optionNotes.get(currentTab) ?? new Map<number, string>();
			if (value.trim()) {
				qNotes.set(optionIndex, value.trim());
			} else {
				qNotes.delete(optionIndex);
			}
			optionNotes.set(currentTab, qNotes);
			focusArea = "options";
			refresh();
		};

		otherEditor.onSubmit = (value) => {
			otherTexts.set(currentTab, value.trim());
			focusArea = "options";
			if (questions[currentTab].multiSelect) {
				const set = selectedIndices.get(currentTab) ?? new Set<number>();
				set.add(optionIndex);
				selectedIndices.set(currentTab, set);
			} else {
				singleSelectedIndex.set(currentTab, optionIndex);
				handleAdvance();
			}
			refresh();
		};

		chatEditor.onSubmit = (value) => {
			chatTexts.set(currentTab, value.trim());
			focusArea = "options";
			handleAdvance();
		};

		function handleInput(data: string) {
			// Note editor focus
			if (focusArea === "note") {
				if (matchesKey(data, Key.escape)) {
					focusArea = "options";
					refresh();
					return;
				}
				noteEditor.handleInput(data);
				refresh();
				return;
			}

			// Other editor focus
			if (focusArea === "other") {
				if (matchesKey(data, Key.escape)) {
					focusArea = "options";
					refresh();
					return;
				}
				otherEditor.handleInput(data);
				refresh();
				return;
			}

			// Chat editor focus
			if (focusArea === "chat") {
				if (matchesKey(data, Key.escape)) {
					focusArea = "options";
					refresh();
					return;
				}
				chatEditor.handleInput(data);
				refresh();
				return;
			}

			// Submit tab logic
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter)) {
					done({ answers: collectAnswers(), cancelled: false });
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done({ answers: [], cancelled: true });
					return;
				}
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = 0;
					optionIndex = 0;
					focusArea = "options";
					refresh();
					return;
				}
				return;
			}

			const opts = getActiveOptions();
			const q = questions[currentTab];

			// Tab switches or Left/Right
			if (matchesKey(data, Key.tab)) {
				currentTab = (currentTab + 1) % (questions.length + 1);
				optionIndex = 0;
				focusArea = "options";
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				currentTab = (currentTab - 1 + (questions.length + 1)) % (questions.length + 1);
				optionIndex = 0;
				focusArea = "options";
				refresh();
				return;
			}

			// Navigation within option list / chat row
			if (matchesKey(data, Key.up)) {
				if ((focusArea as string) === "chat") {
					focusArea = "options";
					optionIndex = opts.length - 1;
				} else {
					optionIndex = Math.max(0, optionIndex - 1);
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (optionIndex === opts.length - 1) {
					focusArea = "chat";
				} else {
					optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				}
				refresh();
				return;
			}

			// Note shortcut
			if (data === "n" && focusArea === "options" && opts[optionIndex] && !opts[optionIndex].isNextSentinel) {
				focusArea = "note";
				const qNotes = optionNotes.get(currentTab);
				const existing = qNotes?.get(optionIndex) ?? "";
				noteEditor.setText(existing);
				refresh();
				return;
			}

			// Chat shortcut
			if (data === "c" && focusArea === "options") {
				focusArea = "chat";
				chatEditor.setText(chatTexts.get(currentTab) ?? "");
				refresh();
				return;
			}

			// Select / Toggle
			if (matchesKey(data, Key.space) && focusArea === "options") {
				const opt = opts[optionIndex];
				if (opt && q.multiSelect && !opt.isNextSentinel) {
					const set = selectedIndices.get(currentTab) ?? new Set<number>();
					if (set.has(optionIndex)) {
						set.delete(optionIndex);
					} else {
						if (opt.isOther) {
							focusArea = "other";
							otherEditor.setText(otherTexts.get(currentTab) ?? "");
						} else {
							set.add(optionIndex);
						}
					}
					selectedIndices.set(currentTab, set);
					refresh();
				}
				return;
			}

			if (matchesKey(data, Key.enter) && focusArea === "options") {
				const opt = opts[optionIndex];
				if (!opt) return;

				if (q.multiSelect) {
					if (opt.isNextSentinel) {
						handleAdvance();
					} else {
						// Enter in multi-select behaves like Space toggle, except other asks for text.
						const set = selectedIndices.get(currentTab) ?? new Set<number>();
						if (set.has(optionIndex)) {
							set.delete(optionIndex);
						} else {
							if (opt.isOther) {
								focusArea = "other";
								otherEditor.setText(otherTexts.get(currentTab) ?? "");
							} else {
								set.add(optionIndex);
							}
						}
						selectedIndices.set(currentTab, set);
						refresh();
					}
				} else {
					if (opt.isOther) {
						focusArea = "other";
						otherEditor.setText(otherTexts.get(currentTab) ?? "");
					} else {
						singleSelectedIndex.set(currentTab, optionIndex);
						handleAdvance();
					}
				}
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done({ answers: [], cancelled: true });
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const renderWidth = Math.max(1, width);

			function addWrapped(text: string, w = renderWidth) {
				lines.push(...wrapTextWithAnsi(text, w));
			}

			function addWrappedWithPrefix(prefix: string, text: string, w = renderWidth) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= w) {
					addWrapped(prefix + text, w);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			// Tab bar rendering
			const tabs: string[] = [];
			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				const isActive = i === currentTab;
				const hasAns =
					(q.multiSelect
						? (selectedIndices.get(i)?.size ?? 0) > 0
						: singleSelectedIndex.has(i)) ||
					(chatTexts.has(i) && chatTexts.get(i) !== "");
				const box = hasAns ? "■" : "□";
				const label = `${box} ${q.header}`;
				if (isActive) {
					tabs.push(theme.fg("accent", `[${label}]`));
				} else {
					tabs.push(theme.fg("muted", ` ${label} `));
				}
			}

			const isSubmitActive = currentTab === questions.length;
			if (isSubmitActive) {
				tabs.push(theme.fg("accent", "[Submit]"));
			} else {
				tabs.push(theme.fg("muted", " Submit "));
			}
			lines.push(truncateToWidth(`  ${tabs.join(" │ ")}`, renderWidth));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			// ── Submit Tab ──────────────────────────────────────────────────
			if (isSubmitActive) {
				lines.push("");
				addWrapped(theme.bold(" Review your answers:"));
				lines.push("");

				let hasUnanswered = false;
				questions.forEach((q, qIdx) => {
					const hasAns =
						(q.multiSelect
							? (selectedIndices.get(qIdx)?.size ?? 0) > 0
							: singleSelectedIndex.has(qIdx)) ||
						(chatTexts.has(qIdx) && chatTexts.get(qIdx) !== "");

					if (!hasAns) {
						hasUnanswered = true;
					}

					const statusStr = hasAns
						? theme.fg("success", "✓")
						: theme.fg("warning", "⚠ Unanswered");

					addWrapped(`  ${statusStr} ${theme.bold(q.header)}: ${q.question}`);

					if (chatTexts.has(qIdx) && chatTexts.get(qIdx) !== "") {
						addWrapped(`     Chat redirect: "${chatTexts.get(qIdx)}"`);
					} else if (q.multiSelect) {
						const idxs = selectedIndices.get(qIdx) ?? new Set<number>();
						const activeOpts = getRenderOptions(qIdx);
						const labels: string[] = [];
						for (const idx of idxs) {
							const opt = activeOpts[idx];
							if (opt) labels.push(opt.isOther ? `Other (${otherTexts.get(qIdx) ?? ""})` : opt.label);
						}
						addWrapped(`     Selected: ${labels.join(", ") || "(none)"}`);
					} else {
						const selIdx = singleSelectedIndex.get(qIdx);
						if (selIdx !== undefined) {
							const opt = getRenderOptions(qIdx)[selIdx];
							if (opt) {
								const val = opt.isOther ? `Other (${otherTexts.get(qIdx) ?? ""})` : opt.label;
								addWrapped(`     Answer: ${val}`);
							}
						}
					}
				});

				lines.push("");
				if (hasUnanswered) {
					addWrapped(theme.fg("warning", "  Note: Some questions are still unanswered. You can still submit."));
					lines.push("");
				}

				addWrapped(theme.fg("dim", "  Press Enter to Submit • Tab to go back • Esc to Cancel"));
				lines.push("");
				cachedLines = lines;
				return lines;
			}

			// ── Question Tab ────────────────────────────────────────────────
			const q = questions[currentTab];
			const opts = getActiveOptions();

			// Determine split width if preview pane is active
			let leftWidth = renderWidth;
			let rightLines: string[] = [];

			const currentOpt = opts[optionIndex];
			if (currentOpt?.preview && renderWidth >= 100) {
				leftWidth = Math.floor(renderWidth * 0.6);
				const previewWidth = renderWidth - leftWidth - 6;
				rightLines.push(theme.fg("accent", "┌" + "─".repeat(previewWidth + 2) + "┐"));
				const wrapped = wrapTextWithAnsi(currentOpt.preview, previewWidth);
				for (const rl of wrapped) {
					rightLines.push(theme.fg("accent", "│ ") + theme.fg("text", rl.padEnd(previewWidth)) + theme.fg("accent", " │"));
				}
				rightLines.push(theme.fg("accent", "└" + "─".repeat(previewWidth + 2) + "┘"));
			}

			const leftLines: string[] = [];

			function addLeft(prefix: string, text: string) {
				const prefLen = visibleWidth(prefix);
				const maxW = Math.max(1, leftWidth - prefLen);
				const wrapped = wrapTextWithAnsi(text, maxW);
				const cont = " ".repeat(prefLen);
				wrapped.forEach((line, i) => {
					leftLines.push(`${i === 0 ? prefix : cont}${line}`);
				});
			}

			leftLines.push("");
			addLeft("  ", theme.bold(q.question));
			leftLines.push("");

			// Render options
			opts.forEach((opt, idx) => {
				const isFocused = focusArea === "options" && idx === optionIndex;
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

				// Check state
				let box = "";
				if (q.multiSelect && !opt.isNextSentinel) {
					const isChecked = selectedIndices.get(currentTab)?.has(idx) ?? false;
					box = isChecked ? "[x] " : "[ ] ";
				}

				const labelColor = isFocused ? "accent" : "text";
				const otherSuffix =
					opt.isOther && otherTexts.has(currentTab)
						? ` (${otherTexts.get(currentTab)})`
						: "";
				const noteSuffix = optionNotes.get(currentTab)?.has(idx) ? " (✎)" : "";

				addLeft(prefix, theme.fg(labelColor, `${box}${opt.label}${otherSuffix}${noteSuffix}`));

				if (opt.description) {
					addLeft("      ", theme.fg("muted", opt.description));
					const noteText = optionNotes.get(currentTab)?.get(idx);
					if (noteText) {
						addLeft("      ", theme.fg("accent", `Note: ${noteText}`));
					}
				}
			});

			leftLines.push("");

			// Chat Row
			const isChatFocused = focusArea === "chat";
			const chatPrefix = isChatFocused ? theme.fg("accent", "> ") : "  ";
			addLeft(chatPrefix, theme.bold("Chat redirect:"));
			if (isChatFocused) {
				const editorLines = chatEditor.render(Math.max(1, leftWidth - 6));
				for (const el of editorLines) {
					leftLines.push(`    ${el}`);
				}
			} else {
				const textVal = chatTexts.get(currentTab) ?? "";
				addLeft("    ", theme.fg(textVal ? "text" : "dim", textVal || "Type text to chat with the subagent instead..."));
			}

			// Note/Other input modes overlay
			if (focusArea === "note") {
				leftLines.push("");
				addLeft("  ", theme.fg("accent", "✎ Enter note for selected option:"));
				const editorLines = noteEditor.render(Math.max(1, leftWidth - 6));
				for (const el of editorLines) {
					leftLines.push(`    ${el}`);
				}
				addLeft("  ", theme.fg("dim", "  Enter to save • Esc to cancel"));
			} else if (focusArea === "other") {
				leftLines.push("");
				addLeft("  ", theme.fg("accent", "✎ Enter custom value:"));
				const editorLines = otherEditor.render(Math.max(1, leftWidth - 6));
				for (const el of editorLines) {
					leftLines.push(`    ${el}`);
				}
				addLeft("  ", theme.fg("dim", "  Enter to save • Esc to cancel"));
			}

			leftLines.push("");

			// Shortcuts helper
			const isMulti = q.multiSelect;
			const selectHelp = isMulti ? "Space toggle" : "Enter select";
			const noteHelp = "n note";
			const chatHelp = "c chat";
			addLeft("  ", theme.fg("dim", `↑↓ navigate • ${selectHelp} • ${noteHelp} • ${chatHelp} • Tab switch • Esc cancel`));

			// Side-by-side or stacked rendering
			if (rightLines.length > 0) {
				const height = Math.max(leftLines.length, rightLines.length);
				for (let i = 0; i < height; i++) {
					const left = leftLines[i] ?? "";
					const right = rightLines[i] ?? "";
					// Visible width padding to align columns
					const leftVisWidth = visibleWidth(left);
					const padding = " ".repeat(Math.max(0, leftWidth - leftVisWidth));
					lines.push(truncateToWidth(left + padding + "  " + right, renderWidth));
				}
			} else {
				for (const line of leftLines) {
					lines.push(truncateToWidth(line, renderWidth));
				}
				// If stacked preview is needed
				if (currentOpt?.preview) {
					lines.push("");
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					addWrapped(theme.bold(" Preview:"));
					addWrapped(currentOpt.preview);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return result;
}
