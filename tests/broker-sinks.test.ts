/**
 * Tests for the broker sinks (extensions/broker-sinks.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "../extensions/request-broker.ts";
import { installBrokerSinks, setBrokerContext } from "../extensions/broker-sinks.ts";
import { runAskUserQuestionTUI } from "../extensions/ask-user-question-tui.ts";

vi.mock("../extensions/ask-user-question-tui.ts", () => ({
	runAskUserQuestionTUI: vi.fn(),
}));

describe("Broker Sinks", () => {
	let broker: RequestBroker;
	let piMock: any;

	beforeEach(() => {
		broker = new RequestBroker({ coalesceMs: 0 });
		piMock = {
			registerTool: vi.fn(),
			getAllTools: () => [],
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;

		installBrokerSinks({ pi: piMock, broker });
	});

	afterEach(() => {
		setBrokerContext(undefined);
		vi.restoreAllMocks();
	});

	it("calls runAskUserQuestionTUI when in TUI mode", async () => {
		const resultAnswers = [{ questionIndex: 0, kind: "option" as const, answer: "yes" }];
		vi.mocked(runAskUserQuestionTUI).mockResolvedValue({
			answers: resultAnswers,
			cancelled: false,
		});

		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext;
		setBrokerContext(ctx);

		const askPromise = broker.ask({
			runId: "run-1",
			kind: "human",
			questions: [{ question: "Ready?", header: "Q1", options: [{ label: "yes" }] }],
			expectsReply: true,
		});

		// Trigger broker tick to deliver batch to sink
		broker.tick();

		const reply = await askPromise;
		expect(runAskUserQuestionTUI).toHaveBeenCalled();
		expect(reply.source).toBe("human");
		expect(reply.answers?.questions).toEqual(resultAnswers);
	});

	it("serializes dialogs across separate broker batches", async () => {
		let finishFirst!: (value: any) => void;
		vi.mocked(runAskUserQuestionTUI).mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
			.mockResolvedValueOnce({answers: [{questionIndex: 0, kind: "option", answer: "second"}], cancelled: false});
		setBrokerContext({mode: "tui", hasUI: true, ui: {}} as unknown as ExtensionContext);
		const first = broker.ask({runId: "r1",kind: "human",questions:[{question:"First?",header:"First"}],expectsReply:true});
		broker.tick(); await Promise.resolve();
		const second = broker.ask({runId: "r2",kind: "human",questions:[{question:"Second?",header:"Second"}],expectsReply:true});
		broker.tick(); await Promise.resolve();
		expect(runAskUserQuestionTUI).toHaveBeenCalledTimes(1);
		finishFirst({answers:[{questionIndex:0,kind:"option",answer:"first"}],cancelled:false});
		expect((await first).text).toBe("first");
		expect((await second).text).toBe("second");
		expect(runAskUserQuestionTUI).toHaveBeenCalledTimes(2);
	});

	it("falls back to sequential prompts in non-TUI mode with UI", async () => {
		const select = vi.fn().mockResolvedValue("yes");
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { select },
		} as unknown as ExtensionContext;
		setBrokerContext(ctx);

		const askPromise = broker.ask({
			runId: "run-1",
			kind: "human",
			questions: [{ question: "Ready?", header: "Q1", options: [{ label: "yes" }] }],
			expectsReply: true,
		});

		broker.tick();

		const reply = await askPromise;
		expect(select).toHaveBeenCalled();
		expect(reply.source).toBe("human");
		expect(reply.answers?.questions[0].answer).toBe("yes");
	});

	it("cancels the request when in headless mode", async () => {
		const ctx = {
			mode: "print",
			hasUI: false,
		} as unknown as ExtensionContext;
		setBrokerContext(ctx);

		const askPromise = broker.ask({
			runId: "run-1",
			kind: "human",
			questions: [{ question: "Ready?", header: "Q1" }],
			expectsReply: true,
		});

		broker.tick();

		const reply = await askPromise;
		expect(reply.source).toBe("cancelled");
	});
});
