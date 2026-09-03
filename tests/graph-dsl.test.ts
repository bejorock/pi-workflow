import { describe, expect, it } from "vitest";
import {
	agent,
	createGraphFactory,
	END,
	GraphBuilder,
	GraphDefinitionError,
	human,
} from "../extensions/graph-dsl.ts";

describe("node constructors", () => {
	describe("agent()", () => {
		it("builds an agent node", () => {
			const node = agent("planner", (s) => `Plan: ${s.task}`);

			expect(node.type).toBe("agent");
			expect(node.agentName).toBe("planner");
			expect(node.promptFn({ task: "ship it" })).toBe("Plan: ship it");
		});

		it("trims the agent name", () => {
			expect(agent("  planner  ", () => "x").agentName).toBe("planner");
		});

		it("rejects a missing or empty name", () => {
			expect(() => agent("", () => "x")).toThrow(GraphDefinitionError);
			expect(() => agent("   ", () => "x")).toThrow(/requires an agent name/);
		});

		it("rejects a missing prompt function with an actionable message", () => {
			// @ts-expect-error deliberately wrong arity
			expect(() => agent("planner")).toThrow(/requires a prompt function/);
			// The message should show the correct shape, since this is the most
			// likely mistake when writing a graph by hand.
			// @ts-expect-error deliberately wrong type
			expect(() => agent("planner", "not a function")).toThrow(/agent\("planner", \(state\)/);
		});
	});

	describe("human()", () => {
		it("builds a free-text human node", () => {
			const node = human("Approve this?");

			expect(node.type).toBe("human");
			expect(node.promptFn({})).toBe("Approve this?");
			expect(node.options).toBeUndefined();
		});

		it("builds a human node with a prompt function", () => {
			const node = human((s) => `Output was: ${s.worker}`);

			expect(node.type).toBe("human");
			expect(node.promptFn({ worker: "100%" })).toBe("Output was: 100%");
		});

		it("builds a choice node with a headless default", () => {
			const node = human("Approve?", { options: ["yes", "no"], default: "no" });

			expect(node.options).toEqual(["yes", "no"]);
			expect(node.default).toBe("no");
		});

		it("copies the options array so later mutation cannot alter the graph", () => {
			const options = ["yes", "no"];
			const node = human("Approve?", { options });
			options.push("maybe");

			expect(node.options).toEqual(["yes", "no"]);
		});

		it("rejects an empty prompt", () => {
			expect(() => human("")).toThrow(/requires a non-empty prompt string/);
		});

		it("rejects malformed options", () => {
			expect(() => human("q", { options: [] })).toThrow(/non-empty array/);
			// @ts-expect-error deliberately wrong element type
			expect(() => human("q", { options: [1, 2] })).toThrow(/must all be strings/);
		});

		it("rejects a default that is not among the options", () => {
			// Otherwise a headless run would answer with something the graph's
			// own edges were never written to handle.
			expect(() => human("q", { options: ["yes", "no"], default: "maybe" })).toThrow(
				/not one of the provided options/,
			);
		});

		it("accepts valid artifacts option", () => {
			const node = human("Approve?", { artifacts: ["plan", "contract"] });
			expect(node.artifacts).toEqual(["plan", "contract"]);
		});

		it("rejects invalid artifacts option", () => {
			// @ts-expect-error deliberately invalid artifact
			expect(() => human("q", { artifacts: ["invalid"] })).toThrow(/unknown artifact kind/);
		});
	});
});

describe("GraphBuilder", () => {
	function linearGraph(): GraphBuilder {
		const g = new GraphBuilder();
		g.node("a", agent("planner", () => "a"));
		g.node("b", agent("green", () => "b"));
		g.edge("a", "b");
		g.edge("b", END);
		g.run({ task: "x" });
		return g;
	}

	describe("node()", () => {
		it("registers nodes and treats the first as the entry", () => {
			const built = linearGraph().build();

			expect([...built.nodes.keys()]).toEqual(["a", "b"]);
			expect(built.entry).toBe("a");
		});

		it("rejects a duplicate node id", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));

			expect(() => g.node("a", agent("green", () => "b"))).toThrow(/already defined/);
		});

		it("rejects ids that are not valid state keys", () => {
			const g = new GraphBuilder();

			// Node ids become state keys (state.planner), so they must be
			// identifier-shaped.
			expect(() => g.node("has-dash", agent("x", () => "y"))).toThrow(/Invalid node id/);
			expect(() => g.node("9leading", agent("x", () => "y"))).toThrow(/Invalid node id/);
			expect(() => g.node("", agent("x", () => "y"))).toThrow(/non-empty string/);
		});

		it("accepts underscore and digit ids", () => {
			const g = new GraphBuilder();
			g.node("_private", agent("x", () => "y"));
			g.node("step2", agent("x", () => "y"));

			expect(g.validate().some((e) => e.includes("Invalid node id"))).toBe(false);
		});

		it("rejects a node def that did not come from a constructor", () => {
			const g = new GraphBuilder();

			// @ts-expect-error deliberately wrong type
			expect(() => g.node("a", { notANode: true })).toThrow(/agent\(\)|human\(\)|plain function/);
		});
	});

	describe("edge()", () => {
		it("records direct edges and END edges", () => {
			const built = linearGraph().build();

			expect(built.edges.get("a")?.[0]).toMatchObject({ type: "direct", to: "b" });
			expect(built.edges.get("b")?.[0]).toMatchObject({ type: "direct", to: END });
		});

		it("records a conditional edge without calling it", () => {
			let called = false;
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", () => {
				called = true;
				return END;
			});
			g.run();

			const edge = g.build().edges.get("a")?.[0];
			expect(edge?.type).toBe("conditional");
			// Conditions belong to the executor; building must not evaluate them.
			expect(called).toBe(false);
		});

		it("appends a second edge from the same node as fan-out (superstep mode)", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("b", agent("green", () => "b"));
			g.node("c", agent("red", () => "c"));
			g.edge("a", "b");
			g.edge("a", "c");
			g.edge("b", END);
			g.edge("c", END);
			g.run();

			const built = g.build();
			expect(built.edges.get("a")).toHaveLength(2);
			expect(built.edges.get("a")?.[0]).toMatchObject({ type: "direct", to: "b" });
			expect(built.edges.get("a")?.[1]).toMatchObject({ type: "direct", to: "c" });
		});
	});

	describe("start()", () => {
		it("overrides the implicit first-node entry", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("b", agent("green", () => "b"));
			g.edge("b", "a");
			g.edge("a", END);
			g.start("b");
			g.run();

			expect(g.build().entry).toBe("b");
		});
	});

	describe("run()", () => {
		it("captures the initial state", () => {
			expect(linearGraph().build().initialState).toEqual({ task: "x" });
		});

		it("defaults to empty state", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", END);
			g.run();

			expect(g.build().initialState).toEqual({});
		});

		it("copies the initial state so later mutation cannot leak in", () => {
			const state = { task: "x" };
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", END);
			g.run(state);
			state.task = "mutated";

			expect(g.build().initialState).toEqual({ task: "x" });
		});

		it("rejects a second call", () => {
			const g = linearGraph();

			expect(() => g.run()).toThrow(/only be called once/);
		});

		it("rejects non-object state", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", END);

			expect(() => g.run([1, 2] as never)).toThrow(/must be an object/);
		});
	});

	describe("validate()", () => {
		it("passes a well-formed graph", () => {
			expect(linearGraph().validate()).toEqual([]);
		});

		it("reports an empty graph", () => {
			expect(new GraphBuilder().validate()).toEqual([
				expect.stringContaining("Graph has no nodes"),
			]);
		});

		it("reports a graph that was never run", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", END);

			expect(g.validate()).toContainEqual(expect.stringContaining("never run"));
		});

		it("reports an entry node that does not exist", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", END);
			g.start("ghost");
			g.run();

			expect(g.validate()).toContainEqual(expect.stringContaining('Entry node "ghost" is not defined'));
		});

		it("reports an edge pointing at an undefined node", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", "ghost");
			g.run();

			expect(g.validate()).toContainEqual(expect.stringContaining("points at an undefined node"));
		});

		it("reports a node with no outgoing edge", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("orphan", agent("green", () => "b"));
			g.edge("a", END);
			g.run();

			expect(g.validate()).toContainEqual(expect.stringContaining('Node "orphan" has no outgoing edge'));
		});

		it("reports a fully-direct graph that can never reach END", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("b", agent("green", () => "b"));
			g.edge("a", "b");
			g.edge("b", "a");
			g.run();

			expect(g.validate()).toContainEqual(expect.stringContaining("No path from the entry node reaches END"));
		});

		it("reports an unreachable node", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("island", agent("green", () => "b"));
			g.edge("a", END);
			g.edge("island", END);
			g.run();

			expect(g.validate()).toContainEqual(expect.stringContaining('Node "island" is unreachable'));
		});

		it("does not flag reachability when a conditional edge is present", () => {
			// A conditional target is only known at run time. Guessing would
			// reject valid graphs, so reachability analysis is skipped and the
			// executor's iteration cap becomes the backstop.
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("b", agent("green", () => "b"));
			g.edge("a", (_s, r) => (r === "done" ? END : "b"));
			g.edge("b", "a");
			g.run();

			expect(g.validate()).toEqual([]);
		});

		it("accepts a cycle as long as a conditional edge can break it", () => {
			const g = new GraphBuilder();
			g.node("architect", agent("architect", () => "design"));
			g.node("green", agent("green", () => "implement"));
			g.edge("architect", "green");
			g.edge("green", (_s, r) =>
				(r as { status?: string })?.status === "blocked" ? "architect" : END,
			);
			g.run();

			expect(g.validate()).toEqual([]);
		});

		it("reports every problem at once rather than only the first", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.node("b", agent("green", () => "b"));
			g.edge("a", "ghost");
			g.run();

			const errors = g.validate();
			expect(errors.length).toBeGreaterThan(1);
		});
	});

	describe("build()", () => {
		it("throws a combined error listing each problem", () => {
			const g = new GraphBuilder();
			g.node("a", agent("planner", () => "a"));
			g.edge("a", "ghost");
			g.run();

			expect(() => g.build()).toThrow(GraphDefinitionError);
			expect(() => g.build()).toThrow(/Invalid graph:/);
		});

		it("returns copies so mutating the result cannot corrupt the builder", () => {
			const g = linearGraph();
			const built = g.build();
			built.nodes.delete("a");
			built.initialState.task = "mutated";

			const rebuilt = g.build();
			expect(rebuilt.nodes.has("a")).toBe(true);
			expect(rebuilt.initialState.task).toBe("x");
		});
	});
});

describe("createGraphFactory", () => {
	it("creates a builder and exposes it", () => {
		const { graph, getBuilder } = createGraphFactory();

		expect(getBuilder()).toBeNull();
		const g = graph();
		expect(getBuilder()).toBe(g);
	});

	it("rejects a second graph in the same script", () => {
		// One graph per script keeps the executor from having to guess which
		// graph a script meant to run.
		const { graph } = createGraphFactory();
		graph();

		expect(() => graph()).toThrow(/Only one graph\(\) per script/);
	});

	it("isolates separate factories", () => {
		const first = createGraphFactory();
		const second = createGraphFactory();
		first.graph();

		expect(() => second.graph()).not.toThrow();
	});
});
