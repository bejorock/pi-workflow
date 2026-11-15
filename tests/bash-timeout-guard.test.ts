import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BASH_TIMEOUT_SECONDS, registerBashTimeoutGuard } from "../extensions/bash-timeout-guard.ts";

/**
 * Minimal fake ExtensionAPI: captures the `tool_call` handler so tests can
 * invoke it directly with hand-built events, the same pattern used by
 * tests/blank-stop-guard.test.ts for turn_end/agent_end.
 */
function makeFakePi() {
	const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
	const pi = {
		on: vi.fn((event: string, handler: (e: unknown) => unknown) => {
			(handlers[event] ??= []).push(handler);
		}),
	};
	return { pi: pi as unknown as Parameters<typeof registerBashTimeoutGuard>[0], handlers };
}

function bashEvent(input: { command: string; timeout?: number }) {
	return { type: "tool_call" as const, toolCallId: "tc-1", toolName: "bash" as const, input };
}

describe("registerBashTimeoutGuard", () => {
	it("registers a tool_call handler when enabled (default)", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi);
		expect(handlers["tool_call"]).toHaveLength(1);
	});

	it("does not register any handler when enabled: false", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi, { enabled: false });
		expect(handlers["tool_call"]).toBeUndefined();
	});

	it("injects the default timeout (600s) into a bash call with no timeout", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi);
		const event = bashEvent({ command: "find / -name fitz" });
		handlers["tool_call"]![0](event);
		expect(event.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
		expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(600);
	});

	it("never overrides a model-specified timeout", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi);
		const event = bashEvent({ command: "npm run build", timeout: 3600 });
		handlers["tool_call"]![0](event);
		expect(event.input.timeout).toBe(3600);
	});

	it("preserves an explicit zero timeout from the model (falsy but defined)", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi);
		// Not a realistic value (pi's own schema requires > 0), but the guard's
		// job is only to fill an *absent* timeout, not to second-guess a
		// present one — that validation belongs to pi's tool, not this guard.
		const event = bashEvent({ command: "echo hi", timeout: 0 });
		handlers["tool_call"]![0](event);
		expect(event.input.timeout).toBe(0);
	});

	it("respects a custom timeoutSeconds override", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi, { timeoutSeconds: 120 });
		const event = bashEvent({ command: "long-running-thing" });
		handlers["tool_call"]![0](event);
		expect(event.input.timeout).toBe(120);
	});

	it("does not register a handler when timeoutSeconds is invalid (<=0 or non-finite)", () => {
		const zero = makeFakePi();
		registerBashTimeoutGuard(zero.pi, { timeoutSeconds: 0 });
		expect(zero.handlers["tool_call"]).toBeUndefined();

		const negative = makeFakePi();
		registerBashTimeoutGuard(negative.pi, { timeoutSeconds: -5 });
		expect(negative.handlers["tool_call"]).toBeUndefined();

		const nan = makeFakePi();
		registerBashTimeoutGuard(nan.pi, { timeoutSeconds: Number.NaN });
		expect(nan.handlers["tool_call"]).toBeUndefined();
	});

	it("ignores non-bash tool calls entirely (does not mutate their input)", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi);
		const readEvent = { type: "tool_call" as const, toolCallId: "tc-2", toolName: "read" as const, input: { path: "foo.txt" } };
		const before = JSON.stringify(readEvent);
		handlers["tool_call"]![0](readEvent);
		expect(JSON.stringify(readEvent)).toBe(before);
	});

	it("never touches a custom tool (e.g. ask-shaped event)", () => {
		const { pi, handlers } = makeFakePi();
		registerBashTimeoutGuard(pi);
		const askEvent = {
			type: "tool_call" as const,
			toolCallId: "tc-3",
			toolName: "ask",
			input: { questions: [{ question: "Which approach?" }] },
		};
		const before = JSON.stringify(askEvent);
		handlers["tool_call"]![0](askEvent);
		expect(JSON.stringify(askEvent)).toBe(before);
	});
});
