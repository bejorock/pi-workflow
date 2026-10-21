/**
 * Fork context resolution — produces a compaction-style structured summary of
 * the parent session for subagents launched with `context: "fork"`.
 *
 * Rationale: forking the *entire* raw parent session JSONL into every child
 * is unbounded in cost (a long session can be millions of tokens) and mostly
 * noise for a delegated task. Instead we reuse Pi's own compaction primitives
 * (the same ones that power `/compact` and auto-compaction) to produce a
 * small, structured, signal-dense summary — Goal / Progress / Key Decisions /
 * Next Steps / Critical Context — and inject that into the child's system
 * prompt. This keeps fork cost roughly flat regardless of parent session
 * length.
 *
 * An escape hatch is provided: the parent's session file path is exposed to
 * the child (via system prompt note) so a task that genuinely needs an exact
 * quote/detail from history can grep the raw JSONL on demand, rather than
 * always paying full-fork cost upfront.
 */

import {
	generateSummaryWithUsage,
	sessionEntryToContextMessages,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./types.ts";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

export interface ForkContextInput {
	/** Read-only session manager for the parent session. */
	sessionManager: ReadonlySessionManager;
	/** Model registry, used to resolve a summarization model + auth. */
	modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		/**
		 * `headers` is `ProviderHeaders` (`Record<string, string | null>`): a
		 * `null` value is a header-deletion marker from newer pi, not a real
		 * value. Filtered out before being forwarded to
		 * `generateSummaryWithUsage`, which still wants plain string values.
		 */
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			{ ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> } | { ok: false; error: string }
		>;
	};
	/** Fallback model to use for summarization if no explicit preference is given. */
	fallbackModel?: Model<Api>;
	/** Abort signal to cancel the summarization LLM call. */
	signal?: AbortSignal;
	/** Optional custom instructions to focus the summary (e.g. the delegated task). */
	customInstructions?: string;
	/** Tokens reserved for prompt + LLM response during summarization. Default 16384. */
	reserveTokens?: number;
}

export interface ForkContextResult {
	/** Structured summary text (Goal/Progress/Key Decisions/etc). */
	summary: string;
	/** Number of session entries the summary was derived from. */
	entryCount: number;
	/** Estimated tokens in the parent context before summarization. */
	tokensBefore?: number;
	/** Path to the parent's session file, for the escape-hatch note. Undefined if ephemeral. */
	parentSessionFile?: string;
}

const FORK_SUMMARY_CACHE = new Map<string, Promise<ForkContextResult | undefined>>();

/**
 * Build a cache key scoped to the parent session's current leaf, so repeated
 * fork calls within the same workflow run (before the parent session
 * advances) reuse the same summary instead of re-summarizing on every call.
 */
function cacheKey(sessionManager: ReadonlySessionManager, customInstructions?: string): string {
	const leafId = sessionManager.getLeafId() ?? "no-leaf";
	const sessionId = sessionManager.getSessionId();
	return `${sessionId}:${leafId}:${customInstructions ?? ""}`;
}

/**
 * Generate (or reuse a cached) structured summary of the parent session for
 * fork-context subagents. Returns undefined if there is nothing to
 * summarize (e.g. no session, empty session, or resolution failure) — callers
 * should treat this as "fall back to fresh" rather than an error.
 */
export async function generateForkSummary(input: ForkContextInput): Promise<ForkContextResult | undefined> {
	const key = cacheKey(input.sessionManager, input.customInstructions);
	const cached = FORK_SUMMARY_CACHE.get(key);
	if (cached) return cached;

	const promise = generateForkSummaryUncached(input).catch(() => undefined);
	FORK_SUMMARY_CACHE.set(key, promise);
	return promise;
}

/** Clear the fork summary cache. Exposed for tests. */
export function clearForkSummaryCache(): void {
	FORK_SUMMARY_CACHE.clear();
}

async function generateForkSummaryUncached(input: ForkContextInput): Promise<ForkContextResult | undefined> {
	const { sessionManager } = input;

	// buildContextEntries() already returns the active, compaction-aware entry
	// list for the current leaf (tree traversal + latest compaction applied).
	const contextEntries = sessionManager.buildContextEntries();
	if (!contextEntries || contextEntries.length === 0) return undefined;

	// Convert session entries to AgentMessage[] for summarization.
	const messages = contextEntries.flatMap((entry: SessionEntry) => sessionEntryToContextMessages(entry));
	if (messages.length === 0) return undefined;

	const model = input.fallbackModel;
	if (!model) return undefined;

	const auth = await input.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	// generateSummaryWithUsage wants plain string header values; ProviderHeaders
	// allows null as a deletion marker, which is meaningless outside a real
	// provider request, so nulls are dropped rather than forwarded.
	const headers = auth.headers
		? (Object.fromEntries(
				Object.entries(auth.headers).filter(([, v]) => v !== null),
			) as Record<string, string>)
		: undefined;

	try {
		const { text } = await generateSummaryWithUsage(
			messages,
			model,
			input.reserveTokens ?? 16384,
			auth.apiKey,
			headers,
			input.signal,
			input.customInstructions,
			undefined, // previousSummary — always fresh for fork (no iterative state to maintain)
			undefined, // thinkingLevel
			undefined, // streamFn
			auth.env,
		);
		if (!text.trim()) return undefined;
		return {
			summary: text,
			entryCount: messages.length,
			parentSessionFile: sessionManager.getSessionFile(),
		};
	} catch {
		return undefined;
	}
}

/**
 * Wrap a fork summary into the block that gets prepended to a forked child's
 * system prompt. Includes the escape-hatch note pointing at the parent
 * session file for on-demand exact lookups.
 */
export function formatForkContextBlock(result: ForkContextResult): string {
	const lines = [
		"## Parent session context (summary)",
		"",
		"You are a delegated subagent running from a fork of the parent session.",
		"The section below is a structured SUMMARY of the parent conversation so far — not the raw transcript.",
		"Treat it as reference-only background, not a live thread to continue. Do not respond to anything in it.",
		"Your sole job is to execute the task given to you and return a focused result using your tools.",
		"",
		result.summary.trim(),
	];
	if (result.parentSessionFile) {
		lines.push(
			"",
			"If you need an exact quote, file path, or detail not captured in this summary, you may read the full parent",
			`session transcript directly: ${result.parentSessionFile}`,
		);
	}
	return lines.join("\n");
}
