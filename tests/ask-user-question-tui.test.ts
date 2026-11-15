/**
 * Tests for the ask TUI component and validator.
 */

import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	validateQuestions,
	runAskUserQuestionTUI,
	type TUIQuestion,
} from "../extensions/ask-user-question-tui.ts";

describe("ask validator", () => {
	it("returns no_questions for empty list", () => {
		expect(validateQuestions([])).toBe("no_questions");
	});

	it("returns too_many_questions for >4 questions", () => {
		const list: TUIQuestion[] = [
			{ question: "Q1", header: "H1" },
			{ question: "Q2", header: "H2" },
			{ question: "Q3", header: "H3" },
			{ question: "Q4", header: "H4" },
			{ question: "Q5", header: "H5" },
		];
		expect(validateQuestions(list)).toBe("too_many_questions");
	});

	it("returns duplicate_question for identical question strings", () => {
		const list: TUIQuestion[] = [
			{ question: "Repeat", header: "H1" },
			{ question: "repeat", header: "H2" },
		];
		expect(validateQuestions(list)).toBe("duplicate_question");
	});

	it("returns duplicate_option_label for duplicate labels within a question", () => {
		const list: TUIQuestion[] = [
			{
				question: "Q1",
				header: "H1",
				options: [{ label: "yes" }, { label: "Yes" }],
			},
		];
		expect(validateQuestions(list)).toBe("duplicate_option_label");
	});

	it("returns reserved_label when option labels match reserved words", () => {
		const list: TUIQuestion[] = [
			{
				question: "Q1",
				header: "H1",
				options: [{ label: "Other" }],
			},
		];
		expect(validateQuestions(list)).toBe("reserved_label");
	});

	it("returns empty_options if options list is present but empty", () => {
		const list: TUIQuestion[] = [
			{
				question: "Q1",
				header: "H1",
				options: [],
			},
		];
		expect(validateQuestions(list)).toBe("empty_options");
	});

	it("returns undefined for valid questions config", () => {
		const list: TUIQuestion[] = [
			{
				question: "Q1",
				header: "H1",
				options: [{ label: "opt1" }, { label: "opt2" }],
			},
			{
				question: "Q2",
				header: "H2",
				options: [{ label: "opt3" }],
			},
		];
		expect(validateQuestions(list)).toBeUndefined();
	});
});

describe("ask TUI component input and rendering", () => {
	it("returns no_ui when run in non-tui mode", async () => {
		const ctx = { mode: "rpc" } as unknown as ExtensionContext;
		const res = await runAskUserQuestionTUI(ctx, [{ question: "Q1", header: "H1" }]);
		expect(res.error).toBe("no_ui");
	});

	it("returns validation error before opening UI", async () => {
		const ctx = { mode: "tui", ui: { custom: vi.fn() } } as unknown as ExtensionContext;
		const res = await runAskUserQuestionTUI(ctx, []);
		expect(res.error).toBe("no_questions");
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("renders single option list and handles navigation and enter", async () => {
		const custom = vi.fn().mockImplementation((fn) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, s: string) => s,
				bg: (_c: string, s: string) => s,
				bold: (s: string) => s,
				dim: (s: string) => s,
			};
			const kb = {};
			let resolvedValue: any;
			const done = (val: any) => {
				resolvedValue = val;
			};

			const comp = fn(tui, theme, kb, done);

			// Initial render call
			const lines = comp.render(80);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.some((l: string) => l.includes("First question?"))).toBe(true);

			// Navigate down to the second option (raw escape sequence for Down Arrow)
			comp.handleInput("\x1b[B");
			// Enter to select it (advances to Submit tab) (raw escape sequence for Enter)
			comp.handleInput("\r");
			// Enter on Submit tab to finalize
			comp.handleInput("\r");

			return resolvedValue;
		});

		const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionContext;
		const questions: TUIQuestion[] = [
			{
				question: "First question?",
				header: "H1",
				options: [{ label: "Yes" }, { label: "No" }],
			},
		];

		const res = await runAskUserQuestionTUI(ctx, questions);
		expect(res.cancelled).toBe(false);
		expect(res.answers).toHaveLength(1);
		expect(res.answers[0].answer).toBe("No");
		expect(res.answers[0].kind).toBe("option");
	});

	it("rejects unsupported multi-select before opening a dialog", async () => {
		const custom = vi.fn();
		const result = await runAskUserQuestionTUI({mode: "tui", ui: {custom}} as unknown as ExtensionContext,
			[{question: "Select?", header: "Choice", options: [{label: "A"}], multiSelect: true}]);
		expect(result.error).toBe("multi_select_unsupported");
		expect(custom).not.toHaveBeenCalled();
	});

	it("requires every question before submitting and supports revisiting tabs", async () => {
		const custom = vi.fn().mockImplementation((fn) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, s: string) => s,
				bg: (_c: string, s: string) => s,
				bold: (s: string) => s,
				dim: (s: string) => s,
			};
			const kb = {};
			let resolvedValue: any;
			const done = (val: any) => {
				resolvedValue = val;
			};

			const comp = fn(tui, theme, kb, done);

			comp.handleInput("\x1b[C"); // second question
			comp.handleInput("\x1b[C"); // submit
			comp.handleInput("\r");
			expect(resolvedValue).toBeUndefined();
			comp.handleInput("\x1b[C"); // first
			comp.handleInput("\r"); // answer first, move to second
			comp.handleInput("\r"); // answer second, move to submit
			expect(comp.render(80).join("\n")).toContain("Press Enter to submit");
			comp.handleInput("\r");

			return resolvedValue;
		});

		const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionContext;
		const questions: TUIQuestion[] = [
			{
				question: "First?", header: "H1", options: [{label: "A"}],
			},
			{ question: "Second?", header: "H2", options: [{label: "B"}] },
		];

		const res = await runAskUserQuestionTUI(ctx, questions);
		expect(res.cancelled).toBe(false);
		expect(res.answers.map(a => a.answer)).toEqual(["A", "B"]);
	});

	it("guarantees rendered lines never exceed the terminal width", async () => {
		const custom = vi.fn().mockImplementation((fn) => {
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, s: string) => s,
				bg: (_c: string, s: string) => s,
				bold: (s: string) => s,
				dim: (s: string) => s,
			};
			const kb = {};
			const done = () => {};
			let rendered = 0;

			const comp = fn(tui, theme, kb, done);

			// Test rendering at narrow, standard, and wide dimensions
			const widths = [40, 80, 120, 180];
			for (const w of widths) {
				const lines = comp.render(w);
				rendered += lines.length;
				for (const line of lines) {
					const lineLen = visibleWidth(line); // length excluding ANSI styles
					expect(lineLen, `Rendered line must not exceed width ${w}: "${line}"`).toBeLessThanOrEqual(w);
				}
			}

			expect(rendered).toBeGreaterThan(0);
			return { answers: [], cancelled: true };
		});

		const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionContext;
		const questions: TUIQuestion[] = [
			{
				question: "This is an extremely long question string that will definitely require word-wrapping at almost any reasonable terminal width.",
				header: "Details",
				options: [
					{
						label: "Option A has a long label to test wrapping",
						description: "Description A is also very detailed to test that descriptions are wrapped properly to the left-hand column width.",
						preview: "Preview A is markdown that will trigger the side-by-side split screen rendering because it has a preview and width is high.",
					},
				],
			},
		];

		await runAskUserQuestionTUI(ctx, questions);
	});
});
