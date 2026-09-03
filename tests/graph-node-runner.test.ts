import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, END, GraphBuilder, human } from "../extensions/graph-dsl.ts";
import { RequestBroker } from "../extensions/request-broker.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";
import {
	createNodeRunner,
	ESCALATION_PROTOCOL_BLOCK,
	KNOWN_BLOCKED_ON,
	parseAgentResult,
	rehydrateState,
	resolveGraphAgent,
	withEscalationProtocol,
} from "../extensions/graph-node-runner.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import type { SingleResult } from "../extensions/types.ts";

function makeSingleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "test",
		task: "task",
		exitCode: 0,
		usage: { input: 0, output: 0, totalTokens: 0 } as never,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] as never,
		...overrides,
	};
}

function withText(text: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return makeSingleResult({
		messages: [{ role: "assistant", content: [{ type: "text", text }] }] as never,
		...overrides,
	});
}

describe("parseAgentResult", () => {
	it("treats an ordinary reply as ok", () => {
		const result = parseAgentResult("Implemented the feature. Tests pass.", "green");

		expect(result.status).toBe("ok");
		expect(result.blockedOn).toBeUndefined();
		expect(result.agent).toBe("green");
	});

	it("always preserves the full reply text", () => {
		const text = "Some long reply\nwith multiple lines.";
		expect(parseAgentResult(text, "green").text).toBe(text);
	});

	it("detects the escalation block", () => {
		const text = `
I tried to implement this but hit a wall.

STATUS: blocked
BLOCKED_ON: contract
REASON: UserRepo cannot express soft-deletes
EVIDENCE: src/repo.ts:42
PROPOSED_FIX: Add deletedAt to the User type
`;
		const result = parseAgentResult(text, "green");

		expect(result.status).toBe("blocked");
		expect(result.blockedOn).toBe("contract");
		expect(result.reason).toBe("UserRepo cannot express soft-deletes");
		expect(result.evidence).toBe("src/repo.ts:42");
		expect(result.proposedFix).toBe("Add deletedAt to the User type");
	});

	it("detects escalation even when a model prepends an empty <think></think> marker", () => {
		// Live-tested regression: some models prefix every reply with
		// "<think></think>" even when they have nothing to think about, which
		// pushed "STATUS: blocked" off the start of the line and silently
		// defeated the line-anchored regex — the graph routed to END instead
		// of back to the escalation target.
		const text = "<think></think>STATUS: blocked\nBLOCKED_ON: contract\nThe contract is ambiguous.";
		const result = parseAgentResult(text, "green");

		expect(result.status).toBe("blocked");
		expect(result.blockedOn).toBe("contract");
		// The raw text (including the marker) must still be preserved verbatim
		// for prompt interpolation — only the *parser's* view is cleaned.
		expect(result.text).toBe(text);
	});

	it("detects escalation with a non-empty <think>...</think> reasoning block", () => {
		const text = "<think>Let me consider the options here.</think>\nSTATUS: blocked\nBLOCKED_ON: tests";
		const result = parseAgentResult(text, "red");

		expect(result.status).toBe("blocked");
		expect(result.blockedOn).toBe("tests");
	});

	it("tolerates prose around the escalation block", () => {
		// Agents wrap the block in explanation. Rejecting that would push them
		// back toward silently giving up, which is the failure being designed
		// against.
		const text = `Here is what I found after investigating.

STATUS: blocked
BLOCKED_ON: tests

The test asserts behaviour the contract never specified.`;

		const result = parseAgentResult(text, "red");
		expect(result.status).toBe("blocked");
		expect(result.blockedOn).toBe("tests");
	});

	it("normalises the escalation target's case", () => {
		const result = parseAgentResult("STATUS: blocked\nBLOCKED_ON: Contract", "green");
		expect(result.blockedOn).toBe("contract");
	});

	it("preserves an unrecognised escalation target verbatim", () => {
		// Coercing it into a known category would put words in the agent's
		// mouth; an edge can still branch on the raw value.
		const result = parseAgentResult("STATUS: blocked\nBLOCKED_ON: something-else", "green");

		expect(result.blockedOn).toBe("something-else");
		expect(KNOWN_BLOCKED_ON.has(result.blockedOn!)).toBe(false);
	});

	it("does not read escalation fields from a reply that did not escalate", () => {
		// Otherwise prose mentioning "REASON:" could fabricate a blocker.
		const text = "All done. REASON: it was straightforward. BLOCKED_ON: nothing";
		const result = parseAgentResult(text, "green");

		expect(result.status).toBe("ok");
		expect(result.blockedOn).toBeUndefined();
		expect(result.reason).toBeUndefined();
	});

	it("handles an escalation with no optional fields", () => {
		const result = parseAgentResult("STATUS: blocked", "green");

		expect(result.status).toBe("blocked");
		expect(result.blockedOn).toBeUndefined();
	});

	it("ignores a status other than blocked", () => {
		expect(parseAgentResult("STATUS: complete", "green").status).toBe("ok");
	});

	it("handles an empty reply", () => {
		const result = parseAgentResult("", "green");
		expect(result.status).toBe("ok");
		expect(result.text).toBe("");
	});

	describe("string interpolation", () => {
		// A prompt function almost always wants the agent's text, while an edge
		// condition wants the structured fields. Without this, `${state.architect}`
		// would render "[object Object]" and silently feed garbage to the next
		// agent — a failure that looks like a bad model rather than a bad join.
		it("interpolates as the agent's text", () => {
			const result = parseAgentResult("Contract v2: adds deletedAt", "architect");

			expect(`Design:\n${result}`).toBe("Design:\nContract v2: adds deletedAt");
			expect(String(result)).toBe("Contract v2: adds deletedAt");
		});

		it("still exposes structured fields for edge conditions", () => {
			const result = parseAgentResult("STATUS: blocked\nBLOCKED_ON: contract", "green");

			expect(result.status).toBe("blocked");
			expect(result.blockedOn).toBe("contract");
		});

		it("keeps toString out of serialised output", () => {
			// The journal and any structured logging must not carry a function.
			const result = parseAgentResult("hello", "green");
			const round = JSON.parse(JSON.stringify(result));

			expect(round).toEqual({ status: "ok", text: "hello", agent: "green" });
			expect(Object.keys(result)).not.toContain("toString");
		});
	});
});

describe("resolveGraphAgent", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-resolve-"));
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves a bundled agent", () => {
		const { agent: found, error } = resolveGraphAgent("green", tempDir);

		expect(error).toBeUndefined();
		expect(found?.name).toBe("green");
		expect(found?.source).toBe("builtin");
	});

	it("prefers a project agent that shadows a bundled one", () => {
		fs.writeFileSync(
			path.join(tempDir, ".pi", "agents", "green.md"),
			`---\nname: green\ndescription: project green\n---\n\n# Green\n\nProject override body.\n`,
		);

		const { agent: found } = resolveGraphAgent("green", tempDir);

		expect(found?.source).toBe("project");
		expect(found?.description).toBe("project green");
	});

	it("returns an error for an unknown agent instead of falling back", () => {
		// The imperative workflow silently substituted a generic agent here,
		// which produced plausible output from the wrong role. A graph naming
		// a nonexistent agent has a bug, and it should say so.
		const { agent: found, error } = resolveGraphAgent("nonexistent_agent", tempDir);

		expect(found).toBeUndefined();
		expect(error).toMatch(/Unknown agent "nonexistent_agent"/);
	});

	it("lists the available agents in the error, so the mistake is fixable", () => {
		const { error } = resolveGraphAgent("typo", tempDir);

		expect(error).toMatch(/Available agents:/);
		expect(error).toMatch(/green/);
		expect(error).toMatch(/architect/);
	});
});

	describe("withEscalationProtocol", () => {
	function makeAgent(systemPrompt: string): AgentConfig {
		return {
			name: "custom",
			description: "a custom agent",
			source: "project",
			filePath: "/tmp/custom.md",
			inheritProjectContext: false,
			inheritSkills: false,
			systemPrompt,
		};
	}

	it("injects the escalation block into an agent that lacks it", () => {
		const agent = makeAgent("# Custom\n\nDo the thing.");
		const result = withEscalationProtocol(agent);

		expect(result.systemPrompt).toContain("STATUS: blocked");
		expect(result.systemPrompt).toContain("BLOCKED_ON:");
		expect(result.systemPrompt).toContain("Do the thing.");
		// The injected text must match what the docs teach, so a model that
		// reads SKILL.md/README and an agent that gets the injection see the
		// same instruction — no conflicting guidance.
		expect(result.systemPrompt).toContain(ESCALATION_PROTOCOL_BLOCK);
	});

	it("works on an agent with no system prompt at all", () => {
		const agent = makeAgent("");
		const result = withEscalationProtocol(agent);

		expect(result.systemPrompt).toBe(ESCALATION_PROTOCOL_BLOCK);
	});

	it("is idempotent: an agent that already has the block is returned unchanged", () => {
		// A bundled agent, or a custom agent whose author followed the docs.
		const agent = makeAgent("# Worker\n\n## Escalation\n\nSTATUS: blocked\nBLOCKED_ON: contract");
		const result = withEscalationProtocol(agent);

		expect(result).toBe(agent);
		expect(result.systemPrompt).not.toContain("Faking completion");
	});

	it("never mutates the original agent object", () => {
		const agent = makeAgent("# Custom\n\nDo the thing.");
		const originalPrompt = agent.systemPrompt;
		withEscalationProtocol(agent);

		expect(agent.systemPrompt).toBe(originalPrompt);
	});
});

describe("createNodeRunner: agent nodes", () => {
	const cwd = "/nonexistent-project";

	function runnerWith(spawn: ReturnType<typeof vi.fn>) {
		return createNodeRunner({ cwd, runId: "r1", spawnAgent: spawn as never });
	}

	function agentNode(id: string, agentName: string) {
		return { id, def: agent(agentName, (s) => `prompt for ${s.task ?? id}`) };
	}

	it("spawns the named agent and returns a parsed result", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("All done."));
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), { task: "t" }, { step: 1, runId: "r1" });

		expect(spawn).toHaveBeenCalledOnce();
		expect((outcome.result as { status: string }).status).toBe("ok");
		expect((outcome.result as { text: string }).text).toBe("All done.");
	});

	it("passes the prompt built from state", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("a", "green"), { task: "ship auth" }, { step: 1, runId: "r1" });

		expect(spawn.mock.calls[0][2]).toBe("prompt for ship auth");
	});

	it("passes the resolved agent config, not just its name", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		const passedAgent = spawn.mock.calls[0][1];
		expect(passedAgent.name).toBe("green");
		// Frontmatter must survive: this is what makes tool restrictions real.
		expect(passedAgent.tools).toContain("write");
	});

	it("injects PI_WORKFLOW_NODE_ID as the node's own id via extraEnv", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("extract_a", "green"), {}, { step: 1, runId: "r1" });

		const spawnOptions = spawn.mock.calls[0][3];
		expect(spawnOptions.extraEnv).toMatchObject({ PI_WORKFLOW_NODE_ID: "extract_a" });
	});

	it("preserves other extraEnv entries alongside the injected node id", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: spawn as never,
			extraEnv: { PI_WORKFLOW_CHANNEL_DIR: "/tmp/some-channel" },
		});

		await runner(agentNode("extract_b", "green"), {}, { step: 1, runId: "r1" });

		const spawnOptions = spawn.mock.calls[0][3];
		expect(spawnOptions.extraEnv).toMatchObject({
			PI_WORKFLOW_CHANNEL_DIR: "/tmp/some-channel",
			PI_WORKFLOW_NODE_ID: "extract_b",
		});
	});

	it("gives different nodes different node ids", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("extract_a", "green"), {}, { step: 1, runId: "r1" });
		await runner(agentNode("extract_b", "green"), {}, { step: 2, runId: "r1" });

		expect(spawn.mock.calls[0][3].extraEnv).toMatchObject({ PI_WORKFLOW_NODE_ID: "extract_a" });
		expect(spawn.mock.calls[1][3].extraEnv).toMatchObject({ PI_WORKFLOW_NODE_ID: "extract_b" });
	});

	it("folds accumulated node_state data into result.data at completion", async () => {
		const { NodeStateBuffers } = await import("../extensions/node-state-reducer.ts");
		const buffers = new NodeStateBuffers();
		// Simulate the host having received state writes for this node before it finishes.
		buffers.apply("a", { action: "set", key: "invoice_number", value: "INV-4471" });
		buffers.apply("a", { action: "set", key: "vendor", value: "Acme Corp" });

		const spawn = vi.fn().mockResolvedValue(withText("All done."));
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: spawn as never,
			nodeStateBuffers: buffers,
		});

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });
		const result = outcome.result as { data?: Record<string, unknown> };
		expect(result.data).toEqual({ invoice_number: "INV-4471", vendor: "Acme Corp" });
		// Buffer was drained — no leftover state for this node.
		expect(buffers.has("a")).toBe(false);
	});

	it("result.data is an empty object when the agent never called node_state", async () => {
		const { NodeStateBuffers } = await import("../extensions/node-state-reducer.ts");
		const buffers = new NodeStateBuffers();

		const spawn = vi.fn().mockResolvedValue(withText("All done."));
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: spawn as never,
			nodeStateBuffers: buffers,
		});

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });
		const result = outcome.result as { data?: Record<string, unknown> };
		expect(result.data).toEqual({});
	});

	it("result.data is an empty object when nodeStateBuffers is not configured", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("All done."));
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });
		const result = outcome.result as { data?: Record<string, unknown> };
		expect(result.data).toEqual({});
	});

	it("drains data even on agent-level failure (blocked result)", async () => {
		const { NodeStateBuffers } = await import("../extensions/node-state-reducer.ts");
		const buffers = new NodeStateBuffers();
		buffers.apply("a", { action: "set", key: "partial", value: "found" });

		const spawn = vi.fn().mockResolvedValue(withText(
			"STATUS: blocked\nBLOCKED_ON: information\nREASON: missing doc\n",
		));
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: spawn as never,
			nodeStateBuffers: buffers,
		});

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });
		const result = outcome.result as { status: string; data?: Record<string, unknown> };
		expect(result.status).toBe("blocked");
		expect(result.data).toEqual({ partial: "found" });
		expect(buffers.has("a")).toBe(false);
	});

	it("injects the escalation protocol into a custom agent that lacks it", async () => {
		// The whole point of auto-injection: a custom agent authored without
		// the escalation block must still receive it at spawn time, so it can
		// report a blocker the edge can route on.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-inject-"));
		try {
			fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".pi", "agents", "naive.md"),
				"---\nname: naive\ndescription: a custom agent with no escalation block\n---\n\n# Naive\n\nJust do the task.\n",
			);

			const spawn = vi.fn().mockResolvedValue(withText("ok"));
			const runner = createNodeRunner({ cwd: tempDir, runId: "r1", spawnAgent: spawn as never });
			await runner(agentNode("a", "naive"), {}, { step: 1, runId: "r1" });

			const passedAgent = spawn.mock.calls[0][1];
			expect(passedAgent.systemPrompt).toContain("STATUS: blocked");
			expect(passedAgent.systemPrompt).toContain("BLOCKED_ON:");
			// The agent's own body survives alongside the injected block.
			expect(passedAgent.systemPrompt).toContain("Just do the task.");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("injects exactly one escalation block into a bundled agent", async () => {
		// Bundled agents no longer carry the escalation block in their .md —
		// it is auto-injected at spawn time. Verify exactly one copy.
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		const passedPrompt = spawn.mock.calls[0][1].systemPrompt as string;
		const occurrences = passedPrompt.split("## Escalation").length - 1;
		expect(occurrences).toBe(1);
	});

	it("applies the agent's own context mode", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("a", "scout"), {}, { step: 1, runId: "r1" });

		// scout.md declares defaultContext: fresh.
		expect(spawn.mock.calls[0][3].context).toBe("fresh");
	});

	it("surfaces a blocked agent as a routable result", async () => {
		const spawn = vi.fn().mockResolvedValue(
			withText("STATUS: blocked\nBLOCKED_ON: contract\nREASON: interface gap"),
		);
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		// Crucially NOT a technical failure: the graph must be able to route.
		expect(outcome.technicalFailure).toBeFalsy();
		expect(outcome.result).toMatchObject({ status: "blocked", blockedOn: "contract" });
	});

	it("treats an unknown agent as a technical failure", async () => {
		const spawn = vi.fn();
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "no_such_agent"), {}, { step: 1, runId: "r1" });

		expect(outcome.technicalFailure).toBe(true);
		expect(outcome.error).toMatch(/Unknown agent/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("treats a spawn throw as a technical failure", async () => {
		const spawn = vi.fn().mockRejectedValue(new Error("process spawn failed"));
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		expect(outcome.technicalFailure).toBe(true);
		expect(outcome.error).toMatch(/process spawn failed/);
	});

	it("treats an aborted run as a technical failure", async () => {
		const spawn = vi.fn().mockResolvedValue(
			makeSingleResult({ exitCode: 1, stopReason: "aborted", error: "aborted" }),
		);
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		expect(outcome.technicalFailure).toBe(true);
	});

	it("keeps an agent-level failure routable rather than aborting", async () => {
		// A turn-budget exhaustion is the agent running out of room, not the
		// infrastructure breaking. The graph should get a chance to react.
		const spawn = vi.fn().mockResolvedValue(
			withText("Ran out of turns before finishing.", {
				exitCode: 1,
				error: "turn budget exceeded",
			}),
		);
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		expect(outcome.technicalFailure).toBeFalsy();
		expect(outcome.error).toBeTruthy();
		expect(outcome.result).toBeTruthy();
	});

	it("reports token usage", async () => {
		const spawn = vi.fn().mockResolvedValue(
			withText("ok", { usage: { input: 10, output: 5, totalTokens: 15 } as never }),
		);
		const runner = runnerWith(spawn);

		const outcome = await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });

		expect(outcome.tokens).toBe(15);
	});

	it("increments the spawn index across nodes so artifacts stay distinct", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);

		await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1" });
		await runner(agentNode("b", "architect"), {}, { step: 2, runId: "r1" });

		expect(spawn.mock.calls[0][3].index).toBe(1);
		expect(spawn.mock.calls[1][3].index).toBe(2);
	});

	it("forwards the abort signal", async () => {
		const spawn = vi.fn().mockResolvedValue(withText("ok"));
		const runner = runnerWith(spawn);
		const controller = new AbortController();

		await runner(agentNode("a", "green"), {}, { step: 1, runId: "r1", signal: controller.signal });

		expect(spawn.mock.calls[0][3].signal).toBe(controller.signal);
	});
});

describe("createNodeRunner: interactive nodes", () => {
	const cwd = "/nonexistent-project";

	it("uses the declared default when there is no UI", async () => {
		// Headless must not hang. This is the property that matters most.
		const runner = createNodeRunner({ cwd, runId: "r1", spawnAgent: vi.fn() as never });

		const node = { id: "ask", def: human("Approve?", { options: ["yes", "no"], default: "no" }) };
		const outcome = await runner(node, {}, { step: 1, runId: "r1" });

		expect(outcome.result).toMatchObject({ status: "default", answer: "no" });
	});

	it("marks a headless human node without a default as skipped, not approved", async () => {
		// Silence must never be mistaken for consent.
		const runner = createNodeRunner({ cwd, runId: "r1", spawnAgent: vi.fn() as never });

		const node = { id: "ask", def: human("Approve?") };
		const outcome = await runner(node, {}, { step: 1, runId: "r1" });

		expect(outcome.result).toMatchObject({ status: "skipped" });
		expect((outcome.result as { answer?: string }).answer).toBeUndefined();
	});

	// Live-tested regression: human() node results interpolated
	// into a downstream prompt (`${state.ask}`) rendered as the literal text
	// "[object Object]" instead of the chosen value, because only agent()
	// results were given a toString(). Confirmed against a real model via
	// the workflow tool's input.md artifact before this fix existed.
	it("a human node's result interpolates to its answer, not [object Object]", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: vi.fn() as never,
			broker,
		});

		broker.onBatch((batch) => {
			broker.resolve(batch[0].id, {
				source: "human",
				text: "fast",
				answers: {
					questions: [{ questionIndex: 0, kind: "option", answer: "fast" }],
					cancelled: false,
				},
			});
		});

		const node = { id: "ask", def: human("Pick a mode", { options: ["fast", "thorough"], default: "fast" }) };
		const outcomePromise = runner(node, {}, { step: 1, runId: "r1" });
		broker.tick();
		const outcome = await outcomePromise;

		expect(`${outcome.result}`).toBe("fast");
		expect(`Chosen mode: "${outcome.result}"`).toBe('Chosen mode: "fast"');
	});

	it("a headless human node's default-fallback result also interpolates to its answer", async () => {
		const runner = createNodeRunner({ cwd, runId: "r1", spawnAgent: vi.fn() as never });

		const node = { id: "ask", def: human("Pick a mode", { options: ["fast", "thorough"], default: "fast" }) };
		const outcome = await runner(node, {}, { step: 1, runId: "r1" });

		expect(`${outcome.result}`).toBe("fast");
	});

	it("a headless human node with no default interpolates to an empty string, not [object Object]", async () => {
		const runner = createNodeRunner({ cwd, runId: "r1", spawnAgent: vi.fn() as never });

		const node = { id: "ask", def: human("Approve?") };
		const outcome = await runner(node, {}, { step: 1, runId: "r1" });

		expect(`${outcome.result}`).toBe("");
	});

	it("a human node's result surviving a JSON round-trip (resume) still interpolates correctly", async () => {
		// rehydrateState() re-attaches toString() after journal replay, where
		// JSON.parse has stripped it. Only kicks in for values with a `text`
		// field — verifies human results qualify now too.
		const broker = new RequestBroker({ coalesceMs: 0 });
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: vi.fn() as never,
			broker,
		});

		broker.onBatch((batch) => {
			broker.resolve(batch[0].id, {
				source: "human",
				text: "fast",
				answers: {
					questions: [{ questionIndex: 0, kind: "option", answer: "fast" }],
					cancelled: false,
				},
			});
		});

		const node = { id: "ask", def: human("Pick a mode", { options: ["fast", "thorough"], default: "fast" }) };
		const outcomePromise = runner(node, {}, { step: 1, runId: "r1" });
		broker.tick();
		const outcome = await outcomePromise;

		const roundTripped = JSON.parse(JSON.stringify({ ask: outcome.result }));
		expect(`${roundTripped.ask}`).toBe("[object Object]"); // proves toString() was lost by JSON

		rehydrateState(roundTripped);
		expect(`${roundTripped.ask}`).toBe("fast"); // proves rehydrateState() restores it
	});

	it("routes a human node through the broker when present", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		const runner = createNodeRunner({
			cwd,
			runId: "r1",
			spawnAgent: vi.fn() as never,
			broker,
		});

		broker.onBatch((batch) => {
			expect(batch).toHaveLength(1);
			expect(batch[0].kind).toBe("human");
			expect(batch[0].questions[0].question).toBe("Pick a mode");
			broker.resolve(batch[0].id, {
				source: "human",
				text: "thorough",
				answers: {
					questions: [{ questionIndex: 0, kind: "option", answer: "thorough" }],
					cancelled: false,
				},
			});
		});

		const node = { id: "ask", def: human("Pick a mode", { options: ["fast", "thorough"], default: "fast" }) };
		// Start the broker loop tick manually for the coalescing window
		const outcomePromise = runner(node, {}, { step: 1, runId: "r1" });
		broker.tick();

		const outcome = await outcomePromise;
		expect(outcome.result).toMatchObject({ status: "ok", answer: "thorough" });
		expect(`${outcome.result}`).toBe("thorough");
	});

	it("attaches artifact previews when artifacts option is specified", async () => {
		const broker = new RequestBroker({ coalesceMs: 0 });
		const tempCwd = `/tmp/test-wf-${Date.now()}`;
		fs.mkdirSync(`${tempCwd}/.pi-workflow/plans`, { recursive: true });
		fs.writeFileSync(`${tempCwd}/.pi-workflow/plans/plan-1.md`, "# Sample Plan\nContent here");

		const runner = createNodeRunner({
			cwd: tempCwd,
			runId: "r1",
			spawnAgent: vi.fn() as never,
			broker,
		});

		let brokerReceivedOptions: Array<{ label: string; preview?: string }> | undefined;
		broker.onBatch((batch) => {
			brokerReceivedOptions = batch[0].questions[0].options;
			broker.resolve(batch[0].id, {
				source: "human",
				text: "yes",
				answers: {
					questions: [{ questionIndex: 0, kind: "option", answer: "yes" }],
					cancelled: false,
				},
			});
		});

		const node = {
			id: "ask",
			def: human("Approve?", {
				options: ["yes", "no"],
				artifacts: ["plan"],
				default: "yes",
			}),
		};
		const outcomePromise = runner(node, {}, { step: 1, runId: "r1" });
		broker.tick();
		await outcomePromise;

		expect(brokerReceivedOptions?.[0].preview).toContain("Sample Plan");
		fs.rmSync(tempCwd, { recursive: true, force: true });
	});
});

describe("end to end: escalation through a real runner", () => {
	it("routes a blocked implementer back to the architect and recovers", async () => {
		// The full path with the real parser and real resolution: an agent
		// emits the escalation block as text, the runner parses it into a
		// routing key, and the edge sends it back to the contract owner.
		const replies: Record<string, string[]> = {
			architect: ["Contract v1: UserRepo.findById", "Contract v2: adds deletedAt"],
			green: [
				"Tried to implement.\n\nSTATUS: blocked\nBLOCKED_ON: contract\nREASON: cannot express soft-delete",
				"Implemented against the revised contract. Tests pass.",
			],
			reviewer: ["Looks good. Approved."],
		};
		const calls: Record<string, number> = {};

		// Typed with the full spawn signature so the prompt argument is
		// reachable below; the assertion that green was re-prompted with the
		// revised contract depends on it.
		const spawnAgent = vi.fn(
			async (
				_cwd: string,
				agentConfig: { name: string },
				_prompt: string,
				_options: Record<string, unknown>,
			) => {
				const name = agentConfig.name;
				const index = calls[name] ?? 0;
				calls[name] = index + 1;
				return withText(replies[name][index]);
			},
		);

		const g = new GraphBuilder();
		g.node("architect", agent("architect", (s) => `Design: ${s.task}`));
		g.node("green", agent("green", (s) => `Implement against:\n${s.architect}`));
		g.node("reviewer", agent("reviewer", (s) => `Review:\n${s.green}`));
		g.edge("architect", "green");
		g.edge("green", (_state, result) => {
			const r = result as { status?: string; blockedOn?: string };
			if (r.status === "blocked" && r.blockedOn === "contract") return "architect";
			return "reviewer";
		});
		g.edge("reviewer", END);
		g.run({ task: "soft-delete users" });

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent-project",
				runId: "r1",
				spawnAgent: spawnAgent as never,
			}),
		});

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["architect", "green", "architect", "green", "reviewer"]);

		// The retrying implementer was prompted with the REVISED contract.
		const greenPrompts = spawnAgent.mock.calls
			.filter((call) => call[1].name === "green")
			.map((call) => call[2]);
		expect(greenPrompts[0]).toContain("Contract v1");
		expect(greenPrompts[1]).toContain("Contract v2");
	});

	it("aborts cleanly when a graph names an agent that does not exist", async () => {
		const g = new GraphBuilder();
		g.node("a", agent("hallucinated_agent", () => "go"));
		g.edge("a", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent-project",
				runId: "r1",
				spawnAgent: vi.fn() as never,
			}),
		});

		expect(result.status).toBe("aborted");
		expect(result.error).toMatch(/Unknown agent "hallucinated_agent"/);
	});
});
