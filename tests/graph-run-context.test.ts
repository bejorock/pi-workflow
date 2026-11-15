import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BudgetTracker,
	buildArtifactConfig,
	getGraphArtifactsDir,
	GraphRunContext,
	openWorktreeSession,
} from "../extensions/graph-run-context.ts";
import type { NodeExecution } from "../extensions/graph-executor.ts";

function execution(tokens?: number): NodeExecution {
	return {
		step: 1,
		nodeId: "a",
		nodeType: "agent",
		agentName: "green",
		status: "ok",
		result: "done",
		routedTo: "END",
		startedAt: Date.now(),
		durationMs: 1,
		tokens,
	};
}

describe("BudgetTracker", () => {
	it("treats a missing budget as unlimited", () => {
		const budget = new BudgetTracker();
		budget.record(1_000_000);

		const snapshot = budget.snapshot();
		expect(snapshot.total).toBeNull();
		expect(snapshot.remaining).toBe(Infinity);
		expect(snapshot.level).toBe("ok");
	});

	it("treats zero or negative as unlimited rather than instantly exceeded", () => {
		expect(new BudgetTracker(0).snapshot().total).toBeNull();
		expect(new BudgetTracker(-5).snapshot().total).toBeNull();
	});

	it("accumulates spend", () => {
		const budget = new BudgetTracker(1000);
		budget.record(100);
		budget.record(250);

		expect(budget.spent).toBe(350);
		expect(budget.snapshot().remaining).toBe(650);
	});

	it("ignores missing or non-positive token counts", () => {
		const budget = new BudgetTracker(1000);
		budget.record(undefined);
		budget.record(0);
		budget.record(-10);

		expect(budget.spent).toBe(0);
	});

	it("warns once at 80%", () => {
		const budget = new BudgetTracker(1000);

		expect(budget.record(700)).toBeNull();
		const warning = budget.record(150);
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toMatch(/80%/);

		// A long run must not spam the operator with the same warning.
		expect(budget.record(10)).toBeNull();
	});

	it("warns once when exceeded", () => {
		const budget = new BudgetTracker(1000);
		budget.record(850);

		const warning = budget.record(200);
		expect(warning?.level).toBe("exceeded");
		expect(budget.record(500)).toBeNull();
	});

	it("emits a single warning when one node crosses both thresholds", () => {
		// Crossing 80% and 100% in one step is one event, not two.
		const budget = new BudgetTracker(1000);
		const warning = budget.record(1200);

		expect(warning?.level).toBe("exceeded");
		expect(budget.record(1)).toBeNull();
	});

	it("describes advisory and checkpoint policies without promising interruption or a pause after END", () => {
		const advisory = new BudgetTracker(100).record(120)!;
		expect(advisory.message).toContain("advisory (no checkpoint policy enabled)");
		const checkpoint = new BudgetTracker(100, {onLimit: "pause_before_next_node"});
		expect(checkpoint.record(80)?.level).toBe("warning");
		const warning = checkpoint.record(40)!;
		expect(warning.message).toContain("active work finishes");
		expect(warning.message).toContain("before the next wave if work remains");
		expect(warning.message).not.toContain("not enforced");
		expect(checkpoint.record(10)).toBeNull();
	});

	it("keeps tracking past the limit rather than enforcing it", () => {
		// Budgets are a signal, not a kill switch: aborting at 100% would
		// abandon work already paid for.
		const budget = new BudgetTracker(100);
		budget.record(500);

		const snapshot = budget.snapshot();
		expect(snapshot.spent).toBe(500);
		expect(snapshot.level).toBe("exceeded");
		expect(snapshot.remaining).toBe(0);
	});

	it("reports the consumed fraction", () => {
		const budget = new BudgetTracker(1000);
		budget.record(250);

		expect(budget.snapshot().fraction).toBeCloseTo(0.25);
	});
});

describe("buildArtifactConfig", () => {
	it("enables artifacts by default", () => {
		const config = buildArtifactConfig();

		expect(config).toBeDefined();
		expect(config!.enabled).toBe(true);
		expect(config!.includeInput).toBe(true);
		expect(config!.includeTranscript).toBe(true);
	});

	it("returns undefined when disabled", () => {
		// runSingleAgent gates on the config's presence, so a disabled config
		// would read as "requested but silently dropped".
		expect(buildArtifactConfig({ enabled: false })).toBeUndefined();
	});

	it("honours transcript and retention overrides", () => {
		const config = buildArtifactConfig({ includeTranscript: false, cleanupDays: 30 });

		expect(config!.includeTranscript).toBe(false);
		expect(config!.cleanupDays).toBe(30);
	});
});

describe("getGraphArtifactsDir", () => {
	it("keeps artifacts inside the project", () => {
		// Never ~/.pi/agent/sessions: a run's history belongs with the
		// repository it describes.
		expect(getGraphArtifactsDir("/repo")).toBe(path.join("/repo", ".pi-workflow", "artifacts"));
	});
});

describe("openWorktreeSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-worktree-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function initRepo(dir: string): void {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "file.txt"), "content");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	}

	it("is a no-op when not requested", () => {
		const session = openWorktreeSession({ enabled: false, cwd: tempDir, runId: "r1" });

		expect(session.cwd).toBe(tempDir);
		expect(session.worktree).toBeUndefined();
	});

	it("degrades to the project directory outside a git repository", () => {
		// Refusing to run without isolation would make the tool unusable in
		// non-git projects for no benefit.
		const session = openWorktreeSession({ enabled: true, cwd: tempDir, runId: "r1" });

		expect(session.cwd).toBe(tempDir);
		expect(session.skippedReason).toMatch(/Not a git repository/);
	});

	it("creates an isolated worktree in a git repository", () => {
		initRepo(tempDir);

		const session = openWorktreeSession({ enabled: true, cwd: tempDir, runId: "r1" });

		try {
			expect(session.worktree).toBeDefined();
			expect(session.cwd).not.toBe(tempDir);
			expect(fs.existsSync(session.cwd)).toBe(true);
			// The worktree is a real checkout, so agents see the code.
			expect(fs.existsSync(path.join(session.cwd, "file.txt"))).toBe(true);
		} finally {
			session.cleanup();
		}
	});

	it("removes the worktree on cleanup", () => {
		initRepo(tempDir);
		const session = openWorktreeSession({ enabled: true, cwd: tempDir, runId: "r1" });
		const worktreePath = session.cwd;

		session.cleanup();

		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	it("does not throw when cleanup fails", () => {
		initRepo(tempDir);
		const session = openWorktreeSession({ enabled: true, cwd: tempDir, runId: "r1" });
		session.cleanup();

		// A second cleanup has nothing to remove; throwing here would mask
		// the run's actual result.
		expect(() => session.cleanup()).not.toThrow();
	});
});

describe("GraphRunContext", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-runctx-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("exposes artifacts, budget, and cwd", () => {
		const context = new GraphRunContext({ cwd: tempDir, runId: "r1", tokenBudget: 5000 });

		expect(context.cwd).toBe(tempDir);
		expect(context.artifactConfig?.enabled).toBe(true);
		expect(context.artifactsDir).toBe(path.join(tempDir, ".pi-workflow", "artifacts"));
		expect(context.budget.total).toBe(5000);
	});

	it("accumulates node spend and surfaces warnings", () => {
		const warnings: string[] = [];
		const context = new GraphRunContext({
			cwd: tempDir,
			runId: "r1",
			tokenBudget: 1000,
			onWarning: (w) => warnings.push(w.level),
		});

		context.recordNode(execution(500));
		context.recordNode(execution(400));

		expect(context.budget.spent).toBe(900);
		expect(warnings).toEqual(["warning"]);
	});

	it("records warnings for later reporting", () => {
		const context = new GraphRunContext({ cwd: tempDir, runId: "r1", tokenBudget: 100 });
		context.recordNode(execution(200));

		expect(context.warnings).toHaveLength(1);
		expect(context.summary().warnings[0].level).toBe("exceeded");
	});

	it("tolerates nodes that report no tokens", () => {
		// Human nodes have no token cost.
		const context = new GraphRunContext({ cwd: tempDir, runId: "r1", tokenBudget: 1000 });
		context.recordNode(execution(undefined));

		expect(context.budget.spent).toBe(0);
	});

	it("reports a null artifacts dir when artifacts are disabled", () => {
		const context = new GraphRunContext({
			cwd: tempDir,
			runId: "r1",
			artifacts: { enabled: false },
		});

		expect(context.artifactConfig).toBeUndefined();
		expect(context.summary().artifactsDir).toBeNull();
	});

	it("keeps artifacts in the project even when agents run in a worktree", () => {
		execFileSync("git", ["init", "-q"], { cwd: tempDir });
		execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "t"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "f.txt"), "x");
		execFileSync("git", ["add", "."], { cwd: tempDir });
		execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: tempDir });

		const context = new GraphRunContext({ cwd: tempDir, runId: "r1", useWorktree: true });

		try {
			// Agents run in the worktree...
			expect(context.cwd).not.toBe(tempDir);
			expect(context.projectCwd).toBe(tempDir);
			// ...but the run's history must survive worktree removal.
			expect(context.artifactsDir.startsWith(tempDir)).toBe(true);
			expect(context.artifactsDir).not.toContain(context.cwd);
		} finally {
			context.cleanup();
		}
	});

	it("summarises the run", () => {
		const context = new GraphRunContext({ cwd: tempDir, runId: "r1", tokenBudget: 1000 });
		context.recordNode(execution(300));

		const summary = context.summary();
		expect(summary.budget.spent).toBe(300);
		expect(summary.budget.level).toBe("ok");
		expect(summary.artifactsDir).toContain(".pi-workflow");
	});

	it("cleans up without throwing when no worktree was created", () => {
		const context = new GraphRunContext({ cwd: tempDir, runId: "r1" });

		expect(() => context.cleanup()).not.toThrow();
	});
});

describe("artifact wiring regression", () => {
	it("passes artifactConfig through to the spawner, not just artifactsDir", async () => {
		// runSingleAgent gates artifact writing on artifactConfig. An earlier
		// version threaded only artifactsDir, so every graph run silently
		// produced no artifacts while looking correctly configured.
		const { createNodeRunner } = await import("../extensions/graph-node-runner.ts");
		const { agent } = await import("../extensions/graph-dsl.ts");

		const spawn = vi.fn().mockResolvedValue({
			agent: "green",
			task: "t",
			exitCode: 0,
			usage: { totalTokens: 10 },
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
		});

		const runner = createNodeRunner({
			cwd: "/nonexistent-project",
			runId: "r1",
			spawnAgent: spawn as never,
			artifactsDir: "/tmp/artifacts",
			artifactConfig: buildArtifactConfig(),
		});

		await runner({ id: "a", def: agent("green", () => "go") }, {}, { step: 1, runId: "r1" });

		const passed = spawn.mock.calls[0][3] as Record<string, unknown>;
		expect(passed.artifactsDir).toBe("/tmp/artifacts");
		expect(passed.artifactConfig).toBeDefined();
		expect((passed.artifactConfig as { enabled: boolean }).enabled).toBe(true);
	});
});
