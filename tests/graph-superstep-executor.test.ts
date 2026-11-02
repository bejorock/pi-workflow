import { describe, expect, it } from "vitest";
import { agent, END, GraphBuilder } from "../extensions/graph-dsl.ts";
import type { BuiltGraph, GraphState } from "../extensions/graph-dsl.ts";
import type { NodeRunner } from "../extensions/graph-executor.ts";
import { runSuperstepGraph, type SuperstepRunOptions } from "../extensions/graph-executor.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";

type ScriptedFn = (state: GraphState, call: number) => unknown;
type ScriptedResponse = ScriptedFn | string | number | boolean | null | object;

/** A runner returning scripted results, optionally varying per visit. */
function scriptedRunner(
	responses: Record<string, ScriptedResponse>,
	options: { tokens?: number; technicalFailure?: string[] } = {},
): NodeRunner {
	const calls: Record<string, number> = {};

	return async (node, state) => {
		const call = (calls[node.id] = (calls[node.id] ?? 0) + 1);
		if (options.technicalFailure?.includes(node.id)) {
			return { result: undefined, technicalFailure: true, error: "spawn failed" };
		}
		const scripted = responses[node.id];
		const result = typeof scripted === "function" ? (scripted as ScriptedFn)(state, call) : scripted;
		return { result, tokens: options.tokens };
	};
}

/** A runner that records the order nodes actually execute, for concurrency checks. */
function tracingRunner(responses: Record<string, ScriptedResponse>): NodeRunner & {
	log: string[];
} {
	const calls: Record<string, number> = {};
	const log: string[] = [];
	const base = scriptedRunner(responses);
	const wrapped: NodeRunner = async (node, state, ctx) => {
		log.push(`start:${node.id}`);
		const out = await base(node, state, ctx);
		log.push(`end:${node.id}`);
		return out;
	};
	return Object.assign(wrapped, { log });
}

/** scout → (researcherA | researcherB) → summarizer → END */
function diamondGraph(): BuiltGraph {
	const g = new GraphBuilder();
	g.node("scout", agent("scout", () => "scout"));
	g.node("researcherA", agent("researcher", () => "A"));
	g.node("researcherB", agent("researcher", () => "B"));
	g.node("summarizer", agent("worker", (s) => `${s.researcherA}+${s.researcherB}`));
	g.edge("scout", "researcherA");
	g.edge("scout", "researcherB"); // fan-out
	g.edge("researcherA", "summarizer");
	g.edge("researcherB", "summarizer"); // fan-in
	g.edge("summarizer", END);
	g.run();
	return g.build();
}

describe("runSuperstepGraph: fan-out and fan-in", () => {
	it("runs the diamond with AND fan-in (summarizer waits for both researchers)", async () => {
		const result = await runSuperstepGraph(diamondGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				scout: "scouted",
				researcherA: "findingsA",
				researcherB: "findingsB",
				summarizer: "summary",
			}),
		});

		expect(result.status).toBe("completed");
		// scout first, researchers concurrently, summarizer last
		expect(result.path[0]).toBe("scout");
		expect(result.path.slice(1, 3).sort()).toEqual(["researcherA", "researcherB"]);
		expect(result.path[3]).toBe("summarizer");
		expect(result.state.researcherA).toBe("findingsA");
		expect(result.state.researcherB).toBe("findingsB");
		expect(result.state.summarizer).toBe("summary");
	});

	it("records rounds: 3 rounds, 4 node executions", async () => {
		const result = await runSuperstepGraph(diamondGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				scout: "s",
				researcherA: "a",
				researcherB: "b",
				summarizer: "z",
			}),
		});

		expect(result.iterations).toBe(3); // rounds
		expect(result.nodeExecutions).toBe(4); // work amount
	});

	it("runs concurrent nodes in the same round (barrier isolation)", async () => {
		const runner = tracingRunner({
			scout: "s",
			researcherA: "a",
			researcherB: "b",
			summarizer: "z",
		});
		await runSuperstepGraph(diamondGraph(), { runId: "r1", runNode: runner });

		// In round 2, both researchers start before either ends: their start
		// events interleave without a matching end in between.
		const aStart = runner.log.indexOf("start:researcherA");
		const bStart = runner.log.indexOf("start:researcherB");
		const aEnd = runner.log.indexOf("end:researcherA");
		const bEnd = runner.log.indexOf("end:researcherB");
		// Both starts come before both ends (concurrent).
		expect(Math.max(aStart, bStart)).toBeLessThan(Math.min(aEnd, bEnd));
	});

	it("a fan-in node never sees partial data", async () => {
		let summarizerState: GraphState | null = null;
		const runner: NodeRunner = async (node, state) => {
			if (node.id === "summarizer") {
				// Snapshot at run time: both researchers must already be in state.
				summarizerState = { ...state };
			}
			return { result: `${node.id}-done` };
		};

		await runSuperstepGraph(diamondGraph(), { runId: "r1", runNode: runner });

		expect(summarizerState).not.toBeNull();
		expect(summarizerState!.researcherA).toBe("researcherA-done");
		expect(summarizerState!.researcherB).toBe("researcherB-done");
	});
});

/**
 * The worked example from Decision 6:
 *
 *   planner → workerA → reviewer → END
 *          → workerB → reviewer
 *   reviewer → planner (on blocked) | END
 *   workerB  → reviewer (on ok) | planner (on blocked)
 *
 * workerB escalates on its first run, so reviewer waits until the second pass.
 */
function escalationGraph(): BuiltGraph {
	const g = new GraphBuilder();
	g.node("planner", agent("planner", () => "plan"));
	g.node("workerA", agent("worker", () => "workA"));
	g.node("workerB", agent("worker", () => "workB"));
	g.node("reviewer", agent("reviewer", () => "review"));
	g.edge("planner", "workerA");
	g.edge("planner", "workerB"); // fan-out
	g.edge("workerA", "reviewer");
	g.edge("workerB", (_s, result) =>
		(result as { status?: string }).status === "blocked" ? "planner" : "reviewer",
	);
	g.edge("reviewer", (_s, result) =>
		(result as { status?: string }).status === "blocked" ? "planner" : END,
	);
	g.run();
	return g.build();
}

describe("runSuperstepGraph: wave reset on back-edge", () => {
	it("loops cleanly: workerB escalates, planner re-plans, reviewer waits, then completes", async () => {
		const result = await runSuperstepGraph(escalationGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				planner: "plan",
				workerA: "workA",
				// workerB is blocked on the FIRST call only, ok afterwards.
				workerB: (_s, call) => (call === 1 ? { status: "blocked", blockedOn: "requirements" } : "workB-ok"),
				reviewer: { status: "ok", text: "approved" },
			}),
		});

		expect(result.status).toBe("completed");
		expect(result.state.reviewer).toMatchObject({ status: "ok" });

		// planner runs twice (initial + after escalation); workerB runs twice.
		const plannerVisits = result.history.filter((h) => h.nodeId === "planner");
		const workerBVisits = result.history.filter((h) => h.nodeId === "workerB");
		expect(plannerVisits).toHaveLength(2);
		expect(workerBVisits).toHaveLength(2);

		// reviewer runs exactly once, and only AFTER the second worker pass.
		const reviewerVisits = result.history.filter((h) => h.nodeId === "reviewer");
		expect(reviewerVisits).toHaveLength(1);
		const reviewerStep = reviewerVisits[0].step;
		const secondWorkerBStep = workerBVisits[1].step;
		expect(reviewerStep).toBeGreaterThan(secondWorkerBStep);
	});

	it("a non-escalating diamond completes in a single pass (no resets)", async () => {
		const result = await runSuperstepGraph(escalationGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				planner: "plan",
				workerA: "workA",
				workerB: "workB-ok",
				reviewer: { status: "ok", text: "approved" },
			}),
		});

		expect(result.status).toBe("completed");
		// planner once, each worker once, reviewer once.
		expect(result.history.filter((h) => h.nodeId === "planner")).toHaveLength(1);
		expect(result.history.filter((h) => h.nodeId === "workerB")).toHaveLength(1);
		expect(result.history.filter((h) => h.nodeId === "reviewer")).toHaveLength(1);
		// Rounds: planner | workerA+workerB | reviewer.
		expect(result.iterations).toBe(3);
		expect(result.nodeExecutions).toBe(4);
	});
});

describe("runSuperstepGraph: counters and cap", () => {
	it("maxIterations counts ROUNDS, not node executions", async () => {
		// workerB blocks forever, so the escalation cycle never resolves.
		const result = await runSuperstepGraph(escalationGraph(), {
			runId: "r1",
			maxIterations: 5,
			runNode: scriptedRunner({
				planner: "plan",
				workerA: "workA",
				workerB: { status: "blocked", blockedOn: "requirements" },
				reviewer: { status: "ok" },
			}),
		});

		expect(result.status).toBe("max_iterations");
		expect(result.error).toContain("5 rounds");
		// Exactly 5 rounds ran — the cap is on rounds.
		expect(result.iterations).toBe(5);
		// But more than 5 nodes executed, because parallel rounds run 2 at a time.
		// This divergence is the whole point of the two-counter model.
		expect(result.nodeExecutions).toBeGreaterThan(5);
	});

	it("two counters diverge: a 2-node round counts as 1 round but 2 executions", async () => {
		const result = await runSuperstepGraph(diamondGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				scout: "s",
				researcherA: "a",
				researcherB: "b",
				summarizer: "z",
			}),
		});

		// 3 rounds, 4 executions — the divergence proves they are separate counters.
		expect(result.iterations).toBe(3);
		expect(result.nodeExecutions).toBe(4);
		expect(result.iterations).not.toBe(result.nodeExecutions);
	});
});

describe("runSuperstepGraph: mixed outcomes and failures", () => {
	it("one branch to END and another to a node coexist in a round", async () => {
		// planner → (a → END) and (b → c → END); a terminates, b continues.
		const g = new GraphBuilder();
		g.node("planner", agent("planner", () => "plan"));
		g.node("a", agent("worker", () => "a"));
		g.node("b", agent("worker", () => "b"));
		g.node("c", agent("worker", () => "c"));
		g.edge("planner", "a");
		g.edge("planner", "b");
		g.edge("a", END);
		g.edge("b", "c");
		g.edge("c", END);
		g.run();
		const graph = g.build();

		const result = await runSuperstepGraph(graph, {
			runId: "r1",
			runNode: scriptedRunner({ planner: "plan", a: "a", b: "b", c: "c" }),
		});

		expect(result.status).toBe("completed");
		expect(result.state).toMatchObject({ a: "a", b: "b", c: "c" });
	});

	it("aborts rather than reports success when a selected shared report waits on a skipped fan-in predecessor", async () => {
		const graph = buildGraphFromScript(`export const meta = { name: "skipped_fanin", description: "repro" };
const g = graph();
g.node("scan", agent("scout", () => "scan"));
g.node("review", agent("reviewer", () => "review"));
g.node("report", () => "report");
g.edge("scan", (_s, result) => result === "failed" ? "report" : "review");
g.edge("review", "report");
g.edge("report", END);
g.run({});`).graph;

		const result = await runSuperstepGraph(graph, {
			runId: "r1",
			runNode: scriptedRunner({ scan: "failed", review: "review", report: "report" }),
		});

		expect(result.status).toBe("aborted");
		expect(result.error).toContain("selected nodes still waiting on skipped predecessors: report");
		expect(result.path).toEqual(["scan"]);
	});

	it("a technical failure aborts the whole run", async () => {
		const result = await runSuperstepGraph(diamondGraph(), {
			runId: "r1",
			runNode: scriptedRunner(
				{ scout: "s", researcherA: "a", researcherB: "b", summarizer: "z" },
				{ technicalFailure: ["researcherA"] },
			),
		});

		expect(result.status).toBe("aborted");
		expect(result.error).toContain("researcherA");
	});

});

describe("runSuperstepGraph: callbacks", () => {
	it("emits onRoundComplete with the frontier snapshot", async () => {
		const rounds: { round: number; nodeIds: string[]; nextFrontier: string[] }[] = [];
		const opts: SuperstepRunOptions = {
			runId: "r1",
			runNode: scriptedRunner({
				scout: "s",
				researcherA: "a",
				researcherB: "b",
				summarizer: "z",
			}),
			onRoundComplete: (info) =>
				rounds.push({
					round: info.round,
					nodeIds: [...info.nodeIds].sort(),
					nextFrontier: [...info.nextFrontier].sort(),
				}),
		};

		await runSuperstepGraph(diamondGraph(), opts);

		expect(rounds).toHaveLength(3);
		expect(rounds[0]).toMatchObject({ round: 1, nodeIds: ["scout"] });
		expect(rounds[0].nextFrontier.sort()).toEqual(["researcherA", "researcherB"]);
		expect(rounds[1].nodeIds.sort()).toEqual(["researcherA", "researcherB"]);
		expect(rounds[1].nextFrontier).toEqual(["summarizer"]);
		expect(rounds[2].nextFrontier).toEqual([]);
	});

	it("tags node executions with their round", async () => {
		const result = await runSuperstepGraph(diamondGraph(), {
			runId: "r1",
			runNode: scriptedRunner({
				scout: "s",
				researcherA: "a",
				researcherB: "b",
				summarizer: "z",
			}),
		});

		const byId = Object.fromEntries(result.history.map((h) => [h.nodeId, h.round]));
		expect(byId.scout).toBe(1);
		expect(byId.researcherA).toBe(2);
		expect(byId.researcherB).toBe(2);
		expect(byId.summarizer).toBe(3);
	});
});

describe("runSuperstepGraph: readiness edge cases", () => {
	it("asymmetric depth diamond: fan-in waits across DIFFERENT rounds", async () => {
		// scout -> a -> sum ;  scout -> b1 -> b2 -> sum
		// 'a' is ready long before b2. AND fan-in must hold sum until b2 lands.
		const g = new GraphBuilder();
		g.node("scout", agent("scout", () => "s"));
		g.node("a", agent("w", () => "a"));
		g.node("b1", agent("w", () => "b1"));
		g.node("b2", agent("w", () => "b2"));
		g.node("sum", agent("w", (s) => `${s.a}|${s.b2}`));
		g.edge("scout", "a"); g.edge("scout", "b1");
		g.edge("a", "sum"); g.edge("b1", "b2"); g.edge("b2", "sum");
		g.edge("sum", END);
		g.run();
		const graph = g.build();

		let sumSaw: GraphState | null = null;
		const runner: NodeRunner = async (n, st) => {
			if (n.id === "sum") sumSaw = { ...st };
			return { result: n.id };
		};
		const res = await runSuperstepGraph(graph, { runId: "x", runNode: runner });
		expect(res.status).toBe("completed");
		// sum must see BOTH, even though 'a' finished a round earlier than b2.
		expect(sumSaw!.a).toBe("a");
		expect(sumSaw!.b2).toBe("b2");
		expect(res.history.filter(h=>h.nodeId==="sum")).toHaveLength(1);
	});

	it("three-way fan-out all converging", async () => {
		const g = new GraphBuilder();
		g.node("s", agent("scout", () => "s"));
		for (const id of ["x","y","z"]) g.node(id, agent("w", () => id));
		g.node("j", agent("w", () => "j"));
		g.edge("s","x"); g.edge("s","y"); g.edge("s","z");
		g.edge("x","j"); g.edge("y","j"); g.edge("z","j");
		g.edge("j", END);
		g.run();
		const res = await runSuperstepGraph(g.build(), { runId:"x", runNode: scriptedRunner({}) });
		expect(res.status).toBe("completed");
		expect(res.iterations).toBe(3);
		expect(res.nodeExecutions).toBe(5);
		expect(res.history.filter(h=>h.nodeId==="j")).toHaveLength(1);
	});

	it("abort signal stops the run", async () => {
		const g = new GraphBuilder();
		g.node("s", agent("scout", () => "s"));
		g.node("a", agent("w", () => "a")); g.node("b", agent("w", () => "b"));
		g.edge("s","a"); g.edge("s","b"); g.edge("a",END); g.edge("b",END);
		g.run();
		const ac = new AbortController();
		ac.abort();
		const res = await runSuperstepGraph(g.build(), { runId:"x", runNode: scriptedRunner({}), signal: ac.signal });
		expect(res.status).toBe("aborted");
		expect(res.nodeExecutions).toBe(0);
	});
});


/**
 * Wave reset with claims tracked PER SOURCE.
 *
 * The production failure this section pins: a fan-out/fan-in graph where two
 * retry back-edges resolve in DIFFERENT rounds. The flat-counter version of
 * the wave reset restored a fan-in node's full static in-degree on every
 * reset, erasing releases from earlier rounds whose sources had already run
 * — the fan-in node never re-earned those claims, the frontier emptied, and
 * the run "completed" without it ever having run.
 *
 * These graphs are built from a SCRIPT (buildGraphFromScript), not raw
 * GraphBuilder: conditional edge targets are recovered from the AST there,
 * which is the path the real workflow tool always uses. Raw GraphBuilder use
 * falls back to a conservative reach estimate for conditional edges (see
 * tests/graph-conditional-routing.test.ts's documented, unrelated
 * limitation) and would not exercise the fix this section is pinning.
 *
 * plan → 5 × (scout → extract → [pass] → assemble), with conditional
 * extract → retry|assemble back-edges. One track resolves its retry early,
 * another (staggered behind delay nodes) resolves late.
 */
function staggeredResetScript(withPassNodes: boolean): string {
	const mk = (name: string) => (withPassNodes ? `pass_${name}` : "assemble");
	const passNode = (name: string) =>
		withPassNodes ? `g.node("pass_${name}", (s) => "pass");\n` : "";
	const passEdge = (name: string) => (withPassNodes ? `g.edge("pass_${name}", "assemble");\n` : "");

	const fastTracks = ["client", "schulung", "mp"];

	return `export const meta = { name: "staggered_reset", description: "staggered reset repro" };
const g = graph();
g.node("plan", agent("planner", () => "plan"));

g.node("scout_machine", agent("scout", () => "s"));
g.node("extract_machine", agent("w", () => "e"));
g.node("extract_machine_retry", agent("w", () => "r"));
${passNode("machine")}g.edge("plan", "scout_machine");
g.edge("scout_machine", "extract_machine");
g.edge("extract_machine", (s) => ((s.__a_machine || 0) === 0 ? "extract_machine_retry" : "${mk("machine")}"));
g.edge("extract_machine_retry", "extract_machine");
${passEdge("machine")}
${fastTracks
	.map(
		(t) => `
g.node("scout_${t}", agent("scout", () => "s"));
g.node("extract_${t}", agent("w", () => "e"));
${passNode(t)}g.edge("plan", "scout_${t}");
g.edge("scout_${t}", "extract_${t}");
g.edge("extract_${t}", "${mk(t)}");
${passEdge(t)}`,
	)
	.join("\n")}

g.node("scout_messstelle", agent("scout", () => "s"));
g.node("delay1_messstelle", (s) => "d1");
g.node("delay2_messstelle", (s) => "d2");
g.node("extract_messstelle", agent("w", () => "e"));
g.node("extract_messstelle_retry", agent("w", () => "r"));
${passNode("messstelle")}g.edge("plan", "scout_messstelle");
g.edge("scout_messstelle", "delay1_messstelle");
g.edge("delay1_messstelle", "delay2_messstelle");
g.edge("delay2_messstelle", "extract_messstelle");
g.edge("extract_messstelle", (s) => ((s.__a_messstelle || 0) === 0 ? "extract_messstelle_retry" : "${mk("messstelle")}"));
g.edge("extract_messstelle_retry", "extract_messstelle");
${passEdge("messstelle")}
g.node("assemble", agent("w", (s) => "assembled"));
g.edge("assemble", END);
g.run({});
`;
}

/** Runner that fails each extractor once (attempt counter in state), echoing ids. */
function retryOnceRunner(): NodeRunner {
	const attempts: Record<string, number> = {};
	return async (node, state) => {
		const id = node.id;
		if (id.startsWith("extract_") && !id.endsWith("_retry")) {
			const t = id.replace("extract_", "");
			attempts[t] = (attempts[t] ?? 0) + 1;
			(state as Record<string, unknown>)[`__a_${t}`] = attempts[t] - 1;
			return { result: `${t}#${attempts[t]}` };
		}
		return { result: id };
	};
}

describe("runSuperstepGraph: wave reset — staggered resets (per-source claims)", () => {
	it("two back-edges in different rounds no longer deadlock the fan-in (pass nodes)", async () => {
		const { graph } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const result = await runSuperstepGraph(graph, {
			runId: "stagger-pass",
			runNode: retryOnceRunner(),
		});

		expect(result.status).toBe("completed");
		expect(result.state.assemble).toBe("assemble");
	});

	it("two back-edges in different rounds no longer deadlock the fan-in (direct conditional edges)", async () => {
		const { graph } = buildGraphFromScript(staggeredResetScript(false), { args: {} });
		const result = await runSuperstepGraph(graph, {
			runId: "stagger-direct",
			runNode: retryOnceRunner(),
		});

		expect(result.status).toBe("completed");
		expect(result.state.assemble).toBe("assemble");
	});

	it("a reset restores only claims whose source re-runs: assemble claims never exceed the truly-pending count", async () => {
		const { graph } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const snapshots: Array<Record<string, number>> = [];
		const result = await runSuperstepGraph(graph, {
			runId: "stagger-claims",
			runNode: retryOnceRunner(),
			onRoundComplete: (info) => snapshots.push(info.remainingInDegree),
		});

		expect(result.status).toBe("completed");
		// After the EARLY reset, the three fast tracks' releases survive it;
		// after the LATE reset, the machine track's release survives too. The
		// flat version snapped back up after the late reset; the fixed one
		// never exceeds what is genuinely still pending.
		for (const snap of snapshots) {
			expect(snap.assemble).toBeLessThanOrEqual(5);
		}
		// The round right before assemble finally runs must show 0 claims.
		const assembleRoundIndex = result.history.find((h) => h.nodeId === "assemble")?.round;
		expect(assembleRoundIndex).toBeDefined();
		const beforeAssemble = snapshots[(assembleRoundIndex as number) - 2];
		expect(beforeAssemble.assemble).toBe(0);
	});

	it("three staggered resets also complete", async () => {
		// machine (early), mp-with-1-hop-delay (middle), messstelle (2-hop
		// delay, late) each retry once — three back-edges resolving in three
		// different rounds.
		const mk = (t: string, delayHops: number): string => {
			let prev = `scout_${t}`;
			const delays = Array.from({ length: delayHops }, (_, i) => `delay${i}_${t}`);
			const delayDecls = delays
				.map((d, i) => `g.node("${d}", (s) => "d");\ng.edge("${i === 0 ? prev : delays[i - 1]}", "${d}");\n`)
				.join("");
			const entryPoint = delays.length > 0 ? delays[delays.length - 1] : prev;
			return `
g.node("scout_${t}", agent("scout", () => "s"));
g.edge("plan", "scout_${t}");
${delayDecls}g.node("extract_${t}", agent("w", () => "e"));
g.node("extract_${t}_retry", agent("w", () => "r"));
g.edge("${entryPoint}", "extract_${t}");
g.edge("extract_${t}", (s) => ((s.__a_${t} || 0) === 0 ? "extract_${t}_retry" : "assemble"));
g.edge("extract_${t}_retry", "extract_${t}");
`;
		};

		const script = `export const meta = { name: "three_stagger", description: "three staggered resets" };
const g = graph();
g.node("plan", agent("planner", () => "plan"));
${mk("machine", 0)}
${mk("mp", 1)}
${mk("messstelle", 2)}
g.node("assemble", agent("w", () => "assembled"));
g.edge("assemble", END);
g.run({});
`;

		const { graph } = buildGraphFromScript(script, { args: {} });
		const result = await runSuperstepGraph(graph, {
			runId: "stagger-3way",
			runNode: retryOnceRunner(),
		});
		expect(result.status).toBe("completed");
		expect(result.state.assemble).toBe("assemble");
	});
});

describe("runSuperstepGraph: duplicate edges from one source", () => {
	it("a duplicate direct edge releases with its source and does not deadlock the target", async () => {
		const g = new GraphBuilder();
		g.node("a", agent("w", () => "a"));
		g.node("b", agent("w", () => "b"));
		g.edge("a", "b");
		g.edge("a", "b"); // duplicate: same source, same target
		g.edge("b", END);
		g.run();

		const result = await runSuperstepGraph(g.build(), {
			runId: "dup",
			runNode: scriptedRunner({ a: "a", b: "b" }),
		});

		// The flat counter deadlocked here: 2 claims, 1 release. Per-source
		// tracking releases every claim a source holds when it fires.
		expect(result.status).toBe("completed");
		expect(result.state.b).toBe("b");
	});
});

describe("runSuperstepGraph: resume claim fidelity", () => {
	it("onRoundComplete emits per-source claim detail alongside the flat total", async () => {
		const { graph } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const bySourceSnapshots: Array<Record<string, Record<string, number>> | undefined> = [];
		const flatSnapshots: Array<Record<string, number>> = [];
		const first = await runSuperstepGraph(graph, {
			runId: "resume-detail",
			runNode: retryOnceRunner(),
			onRoundComplete: (info) => {
				bySourceSnapshots.push(info.remainingClaimsBySource);
				flatSnapshots.push(info.remainingInDegree);
			},
		});
		expect(first.status).toBe("completed");
		expect(bySourceSnapshots.some((s) => s !== undefined)).toBe(true);

		// The flat journal field and the sum of the per-source field agree —
		// the compatibility invariant between the two journal formats.
		for (let i = 0; i < bySourceSnapshots.length; i++) {
			const bySource = bySourceSnapshots[i];
			if (!bySource?.assemble) continue;
			const summed = Object.values(bySource.assemble).reduce((a, b) => a + b, 0);
			expect(summed).toBe(flatSnapshots[i].assemble);
		}
	});

	it("resume without per-source detail (legacy journal) folds to the flat total and still runs", async () => {
		// Legacy journals have only remainingInDegree. Resume must still work
		// exactly as before the fix: the flat total becomes one opaque bucket.
		const { graph: graph1 } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const flatSnapshots: Array<Record<string, number>> = [];
		const first = await runSuperstepGraph(graph1, {
			runId: "resume-legacy",
			runNode: retryOnceRunner(),
			onRoundComplete: (info) => flatSnapshots.push(info.remainingInDegree),
		});
		expect(first.status).toBe("completed");

		// Simulate a legacy resume from round 2 (frontier = extract tracks),
		// passing ONLY the flat snapshot as the resume input — no
		// remainingClaimsBySource, as a pre-fix journal would have.
		const { graph: graph2 } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const result = await runSuperstepGraph(graph2, {
			runId: "resume-legacy-2",
			resume: {
				state: first.state,
				resumeFromFrontier: [
					"extract_machine",
					"extract_client",
					"extract_schulung",
					"extract_mp",
					"delay1_messstelle",
				],
				remainingInDegree: flatSnapshots[1],
				completedRounds: 2,
				completedNodeExecutions: 6,
				executedNodeIds: [
					"plan",
					"scout_machine",
					"scout_client",
					"scout_schulung",
					"scout_mp",
					"scout_messstelle",
				],
			},
			runNode: retryOnceRunner(),
		});

		// Legacy resume keeps pre-fix behaviour: no per-source detail, so this
		// snapshot's frontier runs onward. The run must complete.
		expect(result.status).toBe("completed");
		expect(result.state.assemble).toBe("assemble");
	});

	it("a fresh (non-legacy) resume seeded with per-source detail also completes", async () => {
		const { graph: graph1 } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const bySourceSnapshots: Array<Record<string, Record<string, number>> | undefined> = [];
		const flatSnapshots: Array<Record<string, number>> = [];
		const executedByRound: string[][] = [];
		const first = await runSuperstepGraph(graph1, {
			runId: "resume-fresh",
			runNode: retryOnceRunner(),
			onRoundComplete: (info) => {
				bySourceSnapshots.push(info.remainingClaimsBySource);
				flatSnapshots.push(info.remainingInDegree);
				executedByRound.push(info.nodeIds);
			},
		});
		expect(first.status).toBe("completed");

		const { graph: graph2 } = buildGraphFromScript(staggeredResetScript(true), { args: {} });
		const executedNodeIds = [...new Set(executedByRound.slice(0, 2).flat())];
		const result = await runSuperstepGraph(graph2, {
			runId: "resume-fresh-2",
			resume: {
				state: first.state,
				resumeFromFrontier: [
					"extract_machine",
					"extract_client",
					"extract_schulung",
					"extract_mp",
					"delay1_messstelle",
				],
				remainingInDegree: flatSnapshots[1],
				remainingClaimsBySource: bySourceSnapshots[1],
				completedRounds: 2,
				completedNodeExecutions: executedNodeIds.length,
				executedNodeIds,
			},
			runNode: retryOnceRunner(),
		});

		expect(result.status).toBe("completed");
		expect(result.state.assemble).toBe("assemble");
	});
});
