/**
 * Graph run context — budget tracking, artifact configuration, and worktree
 * isolation for a graph run.
 *
 * The executor deliberately knows nothing about any of this: it walks nodes
 * and routes edges. This module supplies the surrounding machinery so the
 * graph tool can hand the node runner a fully configured environment.
 */

import * as path from "node:path";
import type { BudgetPolicy } from "./graph-run.ts";
import type { ArtifactConfig } from "./types.ts";
import type { NodeExecution } from "./graph-executor.ts";
import { NodeStateBuffers } from "./node-state-reducer.ts";
import { cleanupWorktrees, createWorktree, isGitRepo, type Worktree } from "./worktree.ts";

// --- Budget ---------------------------------------------------------------

export type BudgetLevel = "ok" | "warning" | "exceeded";

export interface BudgetSnapshot {
	/** Configured ceiling, or null when unlimited. */
	total: number | null;
	spent: number;
	/** Infinity when unlimited, so callers can compare without null checks. */
	remaining: number;
	level: BudgetLevel;
	/** Fraction of the budget consumed; 0 when unlimited. */
	fraction: number;
}

export interface BudgetWarning {
	level: Exclude<BudgetLevel, "ok">;
	message: string;
	spent: number;
	total: number;
}

/**
 * Tracks token spend across a graph run.
 *
 * Tracking only; the executor owns optional pause-before-next-wave enforcement.
 * Active work is never interrupted. Warnings describe the configured policy
 * and fire once per threshold so a long run does not spam the operator.
 */
export class BudgetTracker {
	readonly total: number | null;
	private spentTokens = 0;
	private warnedAt80 = false;
	private warnedAtLimit = false;

	constructor(total?: number | null, private readonly policy?: BudgetPolicy) {
		this.total = total != null && total > 0 ? total : null;
	}

	/** Records spend and returns a warning the first time a threshold trips. */
	record(tokens: number | undefined): BudgetWarning | null {
		if (!tokens || tokens <= 0) return null;
		this.spentTokens += tokens;

		if (this.total === null) return null;

		if (this.spentTokens >= this.total && !this.warnedAtLimit) {
			this.warnedAtLimit = true;
			// Suppress the 80% warning too: crossing straight past both
			// thresholds in one node should produce one message, not two.
			this.warnedAt80 = true;
			return {
				level: "exceeded",
				message: `Token budget exceeded: ${this.spentTokens}/${this.total} tokens used. ${this.policy?.onLimit === "pause_before_next_node"
					? "Checkpoint policy is enabled: active work finishes, then execution pauses before the next wave if work remains."
					: "The run continues; this token budget is advisory (no checkpoint policy enabled)."}`,
				spent: this.spentTokens,
				total: this.total,
			};
		}

		if (this.spentTokens >= this.total * 0.8 && !this.warnedAt80) {
			this.warnedAt80 = true;
			return {
				level: "warning",
				message: `Token budget at 80%: ${this.spentTokens}/${this.total} tokens used.`,
				spent: this.spentTokens,
				total: this.total,
			};
		}

		return null;
	}

	get spent(): number {
		return this.spentTokens;
	}

	snapshot(): BudgetSnapshot {
		if (this.total === null) {
			return { total: null, spent: this.spentTokens, remaining: Infinity, level: "ok", fraction: 0 };
		}

		const fraction = this.spentTokens / this.total;
		return {
			total: this.total,
			spent: this.spentTokens,
			remaining: Math.max(0, this.total - this.spentTokens),
			level: fraction >= 1 ? "exceeded" : fraction >= 0.8 ? "warning" : "ok",
			fraction,
		};
	}
}

// --- Artifacts ------------------------------------------------------------

export interface ArtifactOptions {
	enabled?: boolean;
	includeTranscript?: boolean;
	cleanupDays?: number;
}

/**
 * Artifacts live under the project, never in ~/.pi/agent/sessions: a run's
 * inputs, outputs, and transcripts belong with the repository they describe.
 */
export function getGraphArtifactsDir(cwd: string): string {
	return path.join(cwd, ".pi-workflow", "artifacts");
}

/**
 * Builds the artifact config for a graph run.
 *
 * Returns undefined when disabled rather than a config with enabled:false,
 * because runSingleAgent gates on the config's presence and passing a
 * disabled config reads as "artifacts requested but silently dropped".
 */
export function buildArtifactConfig(options: ArtifactOptions = {}): ArtifactConfig | undefined {
	if (options.enabled === false) return undefined;

	return {
		enabled: true,
		includeInput: true,
		includeOutput: true,
		includeJsonl: true,
		includeTranscript: options.includeTranscript ?? true,
		includeMetadata: true,
		cleanupDays: options.cleanupDays ?? 7,
	};
}

// --- Worktree isolation ---------------------------------------------------

export interface WorktreeOptions {
	enabled?: boolean;
	cwd: string;
	runId: string;
}

export interface WorktreeSession {
	/** Directory agents should run in. Falls back to cwd when not isolated. */
	cwd: string;
	worktree?: Worktree;
	/** Why isolation was skipped, when it was requested but unavailable. */
	skippedReason?: string;
	cleanup: () => void;
}

/**
 * Optionally runs a graph inside a git worktree.
 *
 * Degrades to the original cwd rather than failing when the directory is
 * not a git repository or worktree creation fails: isolation is a safety
 * improvement, and refusing to run without it would make the tool unusable
 * in non-git projects for no benefit.
 */
export function openWorktreeSession(options: WorktreeOptions): WorktreeSession {
	const noop = { cwd: options.cwd, cleanup: () => {} };

	if (!options.enabled) return noop;

	if (!isGitRepo(options.cwd)) {
		return { ...noop, skippedReason: "Not a git repository, so the graph runs in the project directory." };
	}

	let worktree: Worktree;
	try {
		worktree = createWorktree(options.cwd, options.runId, 0);
	} catch (error) {
		return {
			...noop,
			skippedReason: `Could not create a worktree (${error instanceof Error ? error.message : String(error)}); the graph runs in the project directory.`,
		};
	}

	return {
		cwd: worktree.path,
		worktree,
		cleanup: () => {
			try {
				cleanupWorktrees(options.cwd, options.runId);
			} catch {
				// Cleanup is best-effort; a leftover worktree is recoverable
				// by hand, whereas throwing here would mask the run's result.
			}
		},
	};
}

// --- Run context ----------------------------------------------------------

export interface GraphRunContextOptions {
	cwd: string;
	runId: string;
	tokenBudget?: number | null;
	budgetPolicy?: BudgetPolicy;
	artifacts?: ArtifactOptions;
	useWorktree?: boolean;
	onWarning?: (warning: BudgetWarning) => void;
	/** Extra env vars to inject into every spawned child. */
	extraEnv?: Record<string, string>;
}

/**
 * Everything a graph run needs beyond the graph itself.
 */
export class GraphRunContext {
	readonly budget: BudgetTracker;
	readonly artifactConfig: ArtifactConfig | undefined;
	readonly artifactsDir: string;
	readonly worktree: WorktreeSession;
	readonly runId: string;
	/** Directory agents actually run in (worktree path when isolated). */
	readonly cwd: string;
	/** Project directory, regardless of isolation. */
	readonly projectCwd: string;
	readonly warnings: BudgetWarning[] = [];
	/** Extra env vars to inject into every spawned child. */
	readonly extraEnv: Record<string, string>;
	/**
	 * Per-node state buffers for the `node_state` tool. Shared between the
	 * channel poller (which reduces incoming actions) and the node runner
	 * (which drains at completion into `result.data`).
	 */
	readonly nodeStateBuffers: NodeStateBuffers;

	private readonly onWarning?: (warning: BudgetWarning) => void;

	constructor(options: GraphRunContextOptions) {
		this.runId = options.runId;
		this.projectCwd = options.cwd;
		this.budget = new BudgetTracker(options.tokenBudget, options.budgetPolicy);
		this.artifactConfig = buildArtifactConfig(options.artifacts);
		// Artifacts stay with the project even when agents run in a worktree,
		// so a run's history survives worktree cleanup.
		this.artifactsDir = getGraphArtifactsDir(options.cwd);
		this.worktree = openWorktreeSession({
			enabled: options.useWorktree,
			cwd: options.cwd,
			runId: options.runId,
		});
		this.cwd = this.worktree.cwd;
		this.onWarning = options.onWarning;
		this.extraEnv = options.extraEnv ?? {};
		this.nodeStateBuffers = new NodeStateBuffers();
	}

	/** Feeds a completed node execution into budget tracking. */
	recordNode(execution: NodeExecution): void {
		const warning = this.budget.record(execution.tokens);
		if (warning) {
			this.warnings.push(warning);
			this.onWarning?.(warning);
		}
	}

	cleanup(): void {
		this.worktree.cleanup();
	}

	summary(): {
		budget: BudgetSnapshot;
		warnings: BudgetWarning[];
		artifactsDir: string | null;
		worktreePath?: string;
		worktreeSkipped?: string;
	} {
		return {
			budget: this.budget.snapshot(),
			warnings: [...this.warnings],
			artifactsDir: this.artifactConfig ? this.artifactsDir : null,
			worktreePath: this.worktree.worktree?.path,
			worktreeSkipped: this.worktree.skippedReason,
		};
	}
}
