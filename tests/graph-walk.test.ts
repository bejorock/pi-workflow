import { describe, expect, it, vi } from "vitest";
import { agent, END, GraphBuilder, human } from "../extensions/graph-dsl.ts";
import type { BuiltGraph, GraphState } from "../extensions/graph-dsl.ts";
import {
	DEFAULT_MAX_ITERATIONS,
	formatPath,
	GraphExecutionError,
	type NodeRunner,
	totalTokens,
} from "../extensions/graph-executor.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";

/**
 * Builds a runner that returns scripted results per node id.
 *
 * A value may be a constant or a function of (state, callCount), so a node
 * revisited after an escalation can answer differently the second time.
 */
/**
 * A scripted response is either a constant or a function of
 * (state, callCount), so a node revisited after an escalation can answer
 * differently the second time.
 */
type ScriptedFn = (state: GraphState, call: number) => unknown;
type ScriptedResponse = ScriptedFn | string | number | boolean | null | object;

function scriptedRunner(
	responses: Record<string, ScriptedResponse>,
	options: { tokens?: number } = {},
): NodeRunner {
	const calls: Record<string, number> = {};

	return async (node, state) => {
		const call = (calls[node.id] = (calls[node.id] ?? 0) + 1);
		const scripted = responses[node.id];
		const result = typeof scripted === "function" ? (scripted as ScriptedFn)(state, call) : scripted;
		return { result, tokens: options.tokens };
	};
}

function linearGraph(): BuiltGraph {
	const g = new GraphBuilder();
	g.node("a", agent("planner", (s) => `plan ${s.task}`));
	g.node("b", agent("green", (s) => `impl ${s.a}`));
	g.edge("a", "b");
	g.edge("b", END);
	g.run({ task: "ship" });
	return g.build();
}

describe("graph walk: basic traversal", () => {
	it("walks a linear graph and completes", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "PLAN", b: "IMPL" }),
		});

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["a", "b"]);
		expect(result.iterations).toBe(2);
	});

	it("accumulates each node's result into state under its node id", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "PLAN", b: "IMPL" }),
		});

		expect(result.state).toEqual({ task: "ship", a: "PLAN", b: "IMPL" });
	});

	it("preserves the initial state", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "x", b: "y" }),
		});

		expect(result.state.task).toBe("ship");
	});

	it("gives a node access to earlier nodes' results", async () => {
		const seen: GraphState[] = [];
		const runner: NodeRunner = async (node, state) => {
			seen.push({ ...state });
			return { result: `${node.id}-done` };
		};

		await runSuperstepGraph(linearGraph(), { runId: "r1", runNode: runner });

		// The second node must see the first node's result, since that is how
		// one agent builds on another's output.
		expect(seen[0]).toEqual({ task: "ship" });
		expect(seen[1]).toEqual({ task: "ship", a: "a-done" });
	});

	it("builds the prompt from state via the node's prompt function", async () => {
		const prompts: string[] = [];
		const runner: NodeRunner = async (node, state) => {
			if (node.def.type === "agent") prompts.push(node.def.promptFn(state));
			return { result: `${node.id.toUpperCase()}` };
		};

		await runSuperstepGraph(linearGraph(), { runId: "r1", runNode: runner });

		expect(prompts).toEqual(["plan ship", "impl A"]);
	});

	it("reports the final node's result", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "PLAN", b: "FINAL" }),
		});

		expect(result.finalResult).toBe("FINAL");
	});

	it("runs a single-node graph", async () => {
		const g = new GraphBuilder();
		g.node("only", agent("worker", () => "go"));
		g.edge("only", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ only: "done" }),
		});

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["only"]);
	});

	it("honours an explicit entry node", async () => {
		const g = new GraphBuilder();
		g.node("first", agent("x", () => "1"));
		g.node("second", agent("y", () => "2"));
		g.edge("second", "first");
		g.edge("first", END);
		g.start("second");
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ first: "F", second: "S" }),
		});

		expect(result.path).toEqual(["second", "first"]);
	});
});

describe("graph walk: conditional routing", () => {
	function branchingGraph(): BuiltGraph {
		const g = new GraphBuilder();
		g.node("check", agent("reviewer", () => "review"));
		g.node("pass", agent("worker", () => "ship"));
		g.node("fix", agent("green", () => "fix"));
		g.edge("check", (_s, result) => ((result as { ok: boolean }).ok ? "pass" : "fix"));
		g.edge("pass", END);
		g.edge("fix", END);
		g.run();
		return g.build();
	}

	it("takes the branch the condition selects", async () => {
		const passed = await runSuperstepGraph(branchingGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ check: { ok: true }, pass: "shipped", fix: "fixed" }),
		});
		const failed = await runSuperstepGraph(branchingGraph(), {
			runId: "r2",
			runNode: scriptedRunner({ check: { ok: false }, pass: "shipped", fix: "fixed" }),
		});

		expect(passed.path).toEqual(["check", "pass"]);
		expect(failed.path).toEqual(["check", "fix"]);
	});

	it("passes both state and the node result to the condition", async () => {
		const seen: { state: GraphState; result: unknown }[] = [];
		const g = new GraphBuilder();
		g.node("a", agent("x", () => "p"));
		g.edge("a", (state, result) => {
			seen.push({ state: { ...state }, result });
			return END;
		});
		g.run({ task: "t" });

		await runSuperstepGraph(g.build(), { runId: "r1", runNode: scriptedRunner({ a: "RESULT" }) });

		expect(seen[0].result).toBe("RESULT");
		// State already contains this node's result when the edge runs, so an
		// edge and a downstream node see the same picture.
		expect(seen[0].state).toEqual({ task: "t", a: "RESULT" });
	});

	it("lets a condition end the run with END", async () => {
		const g = new GraphBuilder();
		g.node("a", agent("x", () => "p"));
		g.node("b", agent("y", () => "q"));
		g.edge("a", (_s, r) => (r === "stop" ? END : "b"));
		g.edge("b", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "stop", b: "never" }),
		});

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["a"]);
	});
});

describe("graph walk: escalation loops", () => {
	/**
	 * The scenario this whole design exists for.
	 *
	 * green hits a wall it cannot solve within the current contract. Instead
	 * of mocking its way to a green test run, it reports blocked. The edge
	 * routes back to architect, who revises the contract; green then sees the
	 * revision in state and succeeds.
	 */
	function tddGraph(): BuiltGraph {
		const g = new GraphBuilder();
		g.node("architect", agent("architect", (s) => `design ${s.task}`));
		g.node("green", agent("green", (s) => `implement against ${s.architect}`));
		g.node("reviewer", agent("reviewer", (s) => `review ${s.green}`));

		g.edge("architect", "green");
		g.edge("green", (_state, result) => {
			const r = result as { status?: string; blockedOn?: string };
			if (r.status === "blocked") return r.blockedOn === "contract" ? "architect" : "reviewer";
			return "reviewer";
		});
		g.edge("reviewer", END);
		g.run({ task: "auth" });
		return g.build();
	}

	it("routes a blocked implementer back to the contract owner and recovers", async () => {
		const result = await runSuperstepGraph(tddGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				architect: (_s, call) => (call === 1 ? "contract v1" : "contract v2 (soft-delete added)"),
				green: (state, call) =>
					call === 1
						? { status: "blocked", blockedOn: "contract", reason: "cannot express soft-delete" }
						: { status: "ok", implementedAgainst: state.architect },
				reviewer: { approved: true },
			}),
		});

		expect(result.status).toBe("completed");
		// The loop is visible in the path: architect runs twice.
		expect(result.path).toEqual(["architect", "green", "architect", "green", "reviewer"]);
	});

	it("shows the revised contract to the retrying implementer", async () => {
		const greenSawOnRetry: unknown[] = [];
		const result = await runSuperstepGraph(tddGraph(), {
			runId: "r1",
			runNode: async (node, state) => {
				if (node.id === "green") {
					greenSawOnRetry.push(state.architect);
					return {
						result:
							greenSawOnRetry.length === 1
								? { status: "blocked", blockedOn: "contract" }
								: { status: "ok" },
					};
				}
				if (node.id === "architect") {
					return { result: greenSawOnRetry.length === 0 ? "v1" : "v2" };
				}
				return { result: { approved: true } };
			},
		});

		expect(result.status).toBe("completed");
		// This is the coordination claim, concretely: the second attempt sees
		// the architect's revision, not the original contract. State flowing
		// through the graph is the entire mechanism.
		expect(greenSawOnRetry).toEqual(["v1", "v2"]);
	});

	it("routes a test-level blocker somewhere different from a contract blocker", async () => {
		// BLOCKED_ON is a closed vocabulary precisely so it can be a routing
		// key rather than prose.
		const result = await runSuperstepGraph(tddGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				architect: "contract",
				green: { status: "blocked", blockedOn: "tests" },
				reviewer: { approved: false },
			}),
		});

		expect(result.path).toEqual(["architect", "green", "reviewer"]);
	});

	it("overwrites a revisited node's state entry with its newest result", async () => {
		const result = await runSuperstepGraph(tddGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				architect: (_s, call) => `contract v${call}`,
				green: (_s, call) => (call === 1 ? { status: "blocked", blockedOn: "contract" } : { status: "ok" }),
				reviewer: { approved: true },
			}),
		});

		expect(result.state.architect).toBe("contract v2");
		// History keeps both visits even though state holds only the latest.
		expect(result.history.filter((h) => h.nodeId === "architect")).toHaveLength(2);
	});
});

describe("graph walk: termination safety", () => {
	function infiniteGraph(): BuiltGraph {
		const g = new GraphBuilder();
		g.node("a", agent("x", () => "a"));
		g.node("b", agent("y", () => "b"));
		g.edge("a", "b");
		g.edge("b", () => "a");
		g.run();
		return g.build();
	}

	it("stops a non-terminating graph at the iteration cap", async () => {
		const result = await runSuperstepGraph(infiniteGraph(), {
			runId: "r1",
			maxIterations: 6,
			runNode: scriptedRunner({ a: "a", b: "b" }),
		});

		expect(result.status).toBe("max_iterations");
		expect(result.iterations).toBe(6);
	});

	it("names the cycling path so the loop is diagnosable", async () => {
		const result = await runSuperstepGraph(infiniteGraph(), {
			runId: "r1",
			maxIterations: 6,
			runNode: scriptedRunner({ a: "a", b: "b" }),
		});

		expect(result.error).toMatch(/Recent path:/);
		expect(result.error).toMatch(/a cycle never resolves/);
	});

	it("defaults to a sane cap", async () => {
		const result = await runSuperstepGraph(infiniteGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "a", b: "b" }),
		});

		expect(result.iterations).toBe(DEFAULT_MAX_ITERATIONS);
	});

	it("rejects a nonsensical cap", async () => {
		await expect(
			runSuperstepGraph(linearGraph(), { runId: "r1", maxIterations: 0, runNode: scriptedRunner({}) }),
		).rejects.toThrow(GraphExecutionError);
	});

	it("allows a cycle that does terminate", async () => {
		const g = new GraphBuilder();
		g.node("work", agent("worker", () => "w"));
		g.edge("work", (_s, r) => ((r as { attempt: number }).attempt >= 3 ? END : "work"));
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ work: (_s, call) => ({ attempt: call }) }),
		});

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(3);
	});
});

describe("graph walk: failure handling", () => {
	it("aborts when the runner throws", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: async (node) => {
				if (node.id === "b") throw new Error("spawn failed");
				return { result: "ok" };
			},
		});

		expect(result.status).toBe("aborted");
		expect(result.error).toMatch(/Node "b" failed: spawn failed/);
	});

	it("aborts on a technical failure without routing", async () => {
		// A technical failure has no meaningful result to route on, unlike an
		// agent reporting that it is blocked.
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: async (node) =>
				node.id === "a"
					? { result: null, technicalFailure: true, error: "model unavailable" }
					: { result: "ok" },
		});

		expect(result.status).toBe("aborted");
		expect(result.error).toMatch(/technical failure: model unavailable/);
		expect(result.path).toEqual(["a"]);
	});

	it("treats an agent-level failure as a routable result, not an abort", async () => {
		// The distinction that makes escalation possible: "I am blocked" is a
		// normal outcome the graph is expected to handle.
		const g = new GraphBuilder();
		g.node("a", agent("green", () => "impl"));
		g.node("recover", agent("architect", () => "revise"));
		g.edge("a", (_s, r) => ((r as { status: string }).status === "blocked" ? "recover" : END));
		g.edge("recover", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ a: { status: "blocked" }, recover: "revised" }),
		});

		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["a", "recover"]);
	});

	it("records a node error while still routing on the result", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: async (node) => ({ result: `${node.id}-partial`, error: "turn budget exceeded" }),
		});

		expect(result.status).toBe("completed");
		expect(result.history[0].status).toBe("failed");
		expect(result.history[0].error).toBe("turn budget exceeded");
	});

	describe("edge condition failures", () => {
		it("aborts when a condition throws", async () => {
			const g = new GraphBuilder();
			g.node("a", agent("x", () => "p"));
			g.edge("a", () => {
				throw new Error("bad routing logic");
			});
			g.run();

			const result = await runSuperstepGraph(g.build(), {
				runId: "r1",
				runNode: scriptedRunner({ a: "r" }),
			});

			expect(result.status).toBe("aborted");
			expect(result.error).toMatch(/Edge condition for node "a" threw: bad routing logic/);
		});

		it("aborts when a condition routes to an unknown node, listing valid targets", async () => {
			const g = new GraphBuilder();
			g.node("a", agent("x", () => "p"));
			g.node("b", agent("y", () => "q"));
			g.edge("a", () => "typo_node");
			g.edge("b", END);
			g.run();

			const result = await runSuperstepGraph(g.build(), {
				runId: "r1",
				runNode: scriptedRunner({ a: "r", b: "s" }),
			});

			expect(result.status).toBe("aborted");
			expect(result.error).toMatch(/routed to unknown node "typo_node"/);
			// Naming the real nodes turns a dead end into a fixable error.
			expect(result.error).toMatch(/Defined nodes: a, b/);
		});

		it("aborts when a condition returns a non-string", async () => {
			const g = new GraphBuilder();
			g.node("a", agent("x", () => "p"));
			g.edge("a", (() => 42) as never);
			g.run();

			const result = await runSuperstepGraph(g.build(), {
				runId: "r1",
				runNode: scriptedRunner({ a: "r" }),
			});

			expect(result.status).toBe("aborted");
			expect(result.error).toMatch(/expected a node name or END/);
		});
	});
});

describe("graph walk: cancellation", () => {
	it("stops before running any node when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const runNode = vi.fn(scriptedRunner({ a: "x", b: "y" }));

		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			signal: controller.signal,
			runNode,
		});

		expect(result.status).toBe("aborted");
		expect(runNode).not.toHaveBeenCalled();
	});

	it("stops between nodes once aborted mid-run", async () => {
		const controller = new AbortController();

		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			signal: controller.signal,
			runNode: async (node) => {
				if (node.id === "a") controller.abort();
				return { result: "ok" };
			},
		});

		expect(result.status).toBe("aborted");
		expect(result.path).toEqual(["a"]);
	});

	it("passes a round cancellation signal through to the runner", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;

		await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			signal: controller.signal,
			runNode: async (_node, _state, ctx) => {
				received = ctx.signal;
				return { result: "ok" };
			},
		});

		expect(received).toBeInstanceOf(AbortSignal);
		expect(received?.aborted).toBe(false);
	});
});

describe("graph walk: observability", () => {
	it("records one history entry per execution, including repeats", async () => {
		const g = new GraphBuilder();
		g.node("loop", agent("worker", () => "w"));
		g.edge("loop", (_s, r) => ((r as { n: number }).n >= 2 ? END : "loop"));
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ loop: (_s, call) => ({ n: call }) }),
		});

		expect(result.history).toHaveLength(2);
		expect(result.history.map((h) => h.step)).toEqual([1, 2]);
	});

	it("captures node type and agent name", async () => {
		const g = new GraphBuilder();
		g.node("ask", human("Approve?", { default: "no" }));
		g.node("work", agent("worker", () => "w"));
		g.edge("ask", "work");
		g.edge("work", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ ask: "yes", work: "done" }),
		});

		expect(result.history.map((h) => h.nodeType)).toEqual(["human", "agent"]);
		expect(result.history.map((h) => h.agentName)).toEqual([undefined, "worker"]);
	});

	it("records where each node routed", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "x", b: "y" }),
		});

		expect(result.history.map((h) => h.routedTo)).toEqual(["b", "END"]);
	});

	it("emits start and complete callbacks in order", async () => {
		const events: string[] = [];

		await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "x", b: "y" }),
			onNodeStart: (info) => events.push(`start:${info.nodeId}`),
			onNodeComplete: (execution) => events.push(`done:${execution.nodeId}`),
		});

		expect(events).toEqual(["start:a", "done:a", "start:b", "done:b"]);
	});

	it("reports a completed node even when the run then aborts on routing", async () => {
		// Without this the operator would see a node vanish rather than a node
		// that ran and then failed to route.
		const g = new GraphBuilder();
		g.node("a", agent("x", () => "p"));
		g.edge("a", () => "ghost");
		g.run();

		const completed: string[] = [];
		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "r" }),
			onNodeComplete: (execution) => completed.push(execution.nodeId),
		});

		expect(result.status).toBe("aborted");
		expect(completed).toEqual(["a"]);
		expect(result.history[0].error).toMatch(/unknown node/);
	});

	it("sums tokens across executions", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: scriptedRunner({ a: "x", b: "y" }, { tokens: 150 }),
		});

		expect(totalTokens(result)).toBe(300);
	});

	it("formats the path, showing cycles", async () => {
		const g = new GraphBuilder();
		g.node("a", agent("x", () => "1"));
		g.node("b", agent("y", () => "2"));
		g.edge("a", "b");
		g.edge("b", (_s, r) => ((r as { done: boolean }).done ? END : "a"));
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "r1",
			runNode: scriptedRunner({
				a: "A",
				b: (_s, call) => ({ done: call >= 2 }),
			}),
		});

		expect(formatPath(result)).toBe("a -> b -> a -> b -> END");
	});

	it("times each node and the run", async () => {
		const result = await runSuperstepGraph(linearGraph(), {
			runId: "r1",
			runNode: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return { result: "ok" };
			},
		});

		expect(result.durationMs).toBeGreaterThan(0);
		expect(result.history[0].durationMs).toBeGreaterThan(0);
	});
});

describe("graph walk: guards", () => {
	it("rejects a node id that collides with a reserved state key", async () => {
		const g = new GraphBuilder();
		g.node("__error", agent("x", () => "p"));
		g.edge("__error", END);
		g.run();

		await expect(runSuperstepGraph(g.build(), { runId: "r1", runNode: scriptedRunner({}) })).rejects.toThrow(
			/reserved/,
		);
	});

	it("does not mutate the graph's initial state object", async () => {
		const graph = linearGraph();
		await runSuperstepGraph(graph, { runId: "r1", runNode: scriptedRunner({ a: "x", b: "y" }) });

		// Re-running must start clean, so the same graph can be reused.
		expect(graph.initialState).toEqual({ task: "ship" });
	});
});
