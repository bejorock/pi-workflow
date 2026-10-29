import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RequestBroker, type PendingRequest } from "../extensions/request-broker.ts";
import { canRelayQuestion, installRelayHookSink } from "../extensions/relay-hook.ts";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-relay-hook-"));
const hookPath = path.join(tempRoot, "herdr-relay-acp.ts");
const originalHerdrEnv = process.env.HERDR_ENV;
const originalPaneId = process.env.HERDR_PANE_ID;
const originalHookPath = process.env.PI_WORKFLOW_RELAY_HOOK_PATH;
const originalRelayUrl = process.env.PI_WORKFLOW_RELAY_URL;

function request(overrides: Partial<PendingRequest> = {}): PendingRequest {
	return {
		id: "req-1",
		runId: "run-1",
		kind: "human",
		questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes" }, { label: "No" }] }],
		expectsReply: true,
		createdAt: Date.now(),
		...overrides,
	};
}

function makePi() {
	const handlers = new Map<string, (value: unknown) => void | Promise<void>>();
	return {
		events: {
			on: (event: string, handler: (value: unknown) => void | Promise<void>) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			emit: vi.fn(),
		},
		async emitResult(value: unknown) {
			await handlers.get("herdr-relay:interaction-result")?.(value);
		},
	} as unknown as ExtensionAPI & { emitResult(value: unknown): Promise<void> };
}

beforeEach(() => {
	process.env.PI_WORKFLOW_RELAY_HOOK_PATH = hookPath;
	process.env.PI_WORKFLOW_RELAY_URL = "http://relay.test";
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	fs.rmSync(hookPath, { force: true });
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ body: { cancel: vi.fn() } }));
});

afterEach(() => {
	fs.rmSync(hookPath, { force: true });
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
	if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = originalPaneId;
	if (originalHookPath === undefined) delete process.env.PI_WORKFLOW_RELAY_HOOK_PATH;
	else process.env.PI_WORKFLOW_RELAY_HOOK_PATH = originalHookPath;
	if (originalRelayUrl === undefined) delete process.env.PI_WORKFLOW_RELAY_URL;
	else process.env.PI_WORKFLOW_RELAY_URL = originalRelayUrl;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setHook(present: boolean): void {
	if (present) fs.writeFileSync(hookPath, "// test relay hook\n");
	else fs.rmSync(hookPath, { force: true });
}

describe("optional Herdr relay hook", () => {
	it("recognizes only bounded option questions", () => {
		expect(canRelayQuestion(request())).toBe(true);
		expect(canRelayQuestion(request({ questions: [{ question: "Explain", header: "Text" }] }))).toBe(false);
	});

	it("does not emit when the relay hook is absent", () => {
		setHook(false);
		const pi = makePi();
		const sink = installRelayHookSink(pi, new RequestBroker());
		sink.offer([request()]);
		expect(pi.events.emit).not.toHaveBeenCalled();
	});

	it("maps a valid relay result into the broker answer and dismisses the local modal", async () => {
		setHook(true);
		const pi = makePi();
		const broker = new RequestBroker();
		const sink = installRelayHookSink(pi, broker);
		const pending = request();
		const answer = broker.ask(pending);

		sink.offer([pending]);
		expect(pi.events.emit).toHaveBeenCalledWith("herdr-relay:request-elicitation", expect.objectContaining({ requestId: "piwf:run-1:req-1" }));
		await pi.emitResult({ requestId: "piwf:run-1:req-1", outcome: { action: "accept", content: { q1: "Yes" } } });

		expect(fetch).toHaveBeenCalledWith(
			"http://relay.test/api/pane/w1%3Ap1/keys",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ keys: ["Escape"] }) }),
		);
		await expect(answer).resolves.toMatchObject({ source: "human", text: "Yes" });
	});

	it("ignores a late relay result after the local TUI has already answered", async () => {
		setHook(true);
		const pi = makePi();
		const broker = new RequestBroker();
		const sink = installRelayHookSink(pi, broker);
		const pending = request();
		const answer = broker.ask(pending);
		sink.offer([pending]);
		broker.resolve(pending.id, { source: "human", text: "No" });

		await pi.emitResult({ requestId: "piwf:run-1:req-1", outcome: { action: "accept", content: { q1: "Yes" } } });
		expect(fetch).not.toHaveBeenCalled();
		await expect(answer).resolves.toMatchObject({ source: "human", text: "No" });
	});
});
