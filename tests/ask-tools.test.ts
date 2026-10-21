/**
 * Tests for ask_user_question and ask_supervisor tools.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
	createAskUserQuestionTool,
	createAskSupervisorTool,
} from "../extensions/ask-tools.ts";
import {
	PI_WORKFLOW_CHANNEL_DIR_ENV,
	PI_WORKFLOW_RUN_ID_ENV,
	ensureChannel,
	ChannelPoller,
} from "../extensions/channel.ts";

describe("Ask Tools in Parent Process (direct UI calling)", () => {
	it("ask_user_question calls custom TUI when in tui mode", async () => {
		const custom = vi.fn().mockImplementation((fn) => {
			const done = vi.fn();
			const tui = { requestRender: vi.fn() };
			const theme = {
				fg: (_c: string, s: string) => s,
				bg: (_c: string, s: string) => s,
				bold: (s: string) => s,
				dim: (s: string) => s,
			};
			const comp = fn(tui, theme, {}, done);
			// Simulate select B
			comp.handleInput("\x1b[B"); // Down to B
			comp.handleInput("\r");     // Enter to select
			comp.handleInput("\r");     // Enter on Submit
			// The runAskUserQuestionTUI resolves with the completed answer
			return {
				answers: [{ questionIndex: 0, kind: "option", answer: "B" }],
				cancelled: false,
			};
		});

		const ctx = {
			mode: "tui",
			ui: { custom },
		} as unknown as ExtensionToolContext;

		const tool = createAskUserQuestionTool();
		const res: any = await tool.execute(
			"call-1",
			{
				questions: [
					{
						question: "Choose?",
						header: "H1",
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			} as never,
			undefined,
			undefined,
			ctx,
		);

		expect(custom).toHaveBeenCalled();
		expect(res.details.answers).toEqual([{ questionIndex: 0, kind: "option", answer: "B" }]);
		expect(res.details.cancelled).toBe(false);
	});

	it("ask_user_question validation failure", async () => {
		const tool = createAskUserQuestionTool();
		const res: any = await tool.execute(
			"call-1",
			{ questions: [] } as never,
			undefined,
			undefined,
			{ mode: "tui", ui: { custom: vi.fn() } } as unknown as ExtensionToolContext,
		);

		expect(res.details.error).toBe("no_questions");
	});

	it("ask_supervisor direct mock fallback in parent", async () => {
		const tool = createAskSupervisorTool();
		const res: any = await tool.execute(
			"call-1",
			{ question: "Q", default: "fallback" } as never,
			undefined,
			undefined,
			{} as never,
		);

		expect(res.details.answer).toBe("fallback");
		expect(res.details.source).toBe("default");
	});
});

describe("Ask Tools in Child Process (filesystem channel routing)", () => {
	let tmpDir: string;
	let chDir: string;
	let poller: ChannelPoller;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-tools-child-"));
		chDir = path.join(tmpDir, "channels", "run-1");
		ensureChannel(chDir);

		process.env[PI_WORKFLOW_CHANNEL_DIR_ENV] = chDir;
		process.env[PI_WORKFLOW_RUN_ID_ENV] = "run-1";
	});

	afterEach(() => {
		delete process.env[PI_WORKFLOW_CHANNEL_DIR_ENV];
		delete process.env[PI_WORKFLOW_RUN_ID_ENV];
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ask_user_question routes request to channel and receives answer", async () => {
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				expect(req.kind).toBe("human");
				expect(req.questions?.[0].question).toBe("Ready?");
				// Reply via poller
				poller.reply(req.id, {
					source: "human",
					answer: "yes indeed",
					answers: [{ questionIndex: 0, kind: "option", answer: "yes indeed" }],
				});
			},
		});

		const tool = createAskUserQuestionTool();
		const toolPromise = tool.execute(
			"call-2",
			{
				questions: [
					{
						question: "Ready?",
						header: "H1",
						options: [{ label: "yes indeed" }],
					},
				],
			} as never,
			undefined,
			undefined,
			{} as never,
		);

		// Allow child to write request
		await sleep(20);
		poller.poll();

		const res: any = await toolPromise;
		expect(res.details.answers).toEqual([{ questionIndex: 0, kind: "option", answer: "yes indeed" }]);
		expect(res.details.cancelled).toBe(false);
	});

	it("ask_supervisor routes request and receives reply", async () => {
		poller = new ChannelPoller(chDir, {
			onRequest: (req) => {
				expect(req.kind).toBe("supervisor");
				expect(req.question).toBe("Proceed?");
				poller.reply(req.id, { source: "supervisor", answer: "ok" });
			},
		});

		const tool = createAskSupervisorTool();
		const toolPromise = tool.execute(
			"call-3",
			{ question: "Proceed?" } as never,
			undefined,
			undefined,
			{} as never,
		);

		await sleep(20);
		poller.poll();

		const res: any = await toolPromise;
		expect(res.details.answer).toBe("ok");
		expect(res.details.source).toBe("supervisor");
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
