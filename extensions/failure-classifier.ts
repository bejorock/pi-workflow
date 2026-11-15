/**
 * Failure classification for subagent runs.
 *
 * Distinguishes *technical* failures (LLM provider errors, process crashes,
 * infrastructure problems) from *agent-level* outcomes (the agent completed
 * its turn, but its own work contains errors — e.g. it ran tests and the
 * tests failed, or it wrote code with a bug). Only technical failures should
 * ever cause a workflow to auto-abort; agent-level "failures" are just part
 * of the agent's normal output and the workflow should keep going.
 *
 * Reuses the retryable-model-failure pattern list from model-fallback.ts as
 * a base (same signal: "this smells like infrastructure, not agent work"),
 * but is evaluated at a different point for a different purpose — not
 * "should I retry this same model" but "should the whole workflow stop".
 */

import { isRetryableModelFailure } from "./model-fallback.ts";
import type { SingleResult } from "./types.ts";

export type FailureClass = "technical" | "agent" | "none";

export interface FailureClassification {
	class: FailureClass;
	reason: string;
	/** Machine-friendly category for programmatic handling / tests. */
	code:
		| "ok"
		| "provider-error"
		| "process-killed"
		| "protocol-limit"
		| "aborted"
		| "no-model-available"
		| "required-tools-unavailable"
		| "agent-error"
		| "timed-out"
		| "turn-budget-exceeded";
}

/** Exit signals that indicate the OS killed the process (OOM-killer, etc). */
const FATAL_KILL_SIGNALS = new Set(["SIGKILL", "SIGSEGV", "SIGABRT", "SIGBUS"]);

/** Extra technical-failure patterns not covered by isRetryableModelFailure
 * (that list is specifically about *retryable* provider errors; some
 * technical failures are not retryable but are still clearly infra, not
 * agent-level, e.g. malformed request / internal errors). */
const ADDITIONAL_TECHNICAL_PATTERNS = [
	/internal server error/i,
	/\b500\b/,
	/out of memory/i,
	/heap.*(?:exhaust|overflow|out of memory)/i,
	/enomem/i,
	/econnreset/i,
	/econnrefused/i,
	/epipe/i,
	/no model candidates available/i,
	/no more models to try/i,
];

/**
 * Thrown by runSubagentForWorkflow() when a subagent's failure is classified
 * as "technical" (LLM provider error, process crash, infra problem). Unlike
 * an agent-level failure (which is swallowed by agent()'s existing
 * try/catch and returned as an error-string result so the workflow keeps
 * going), a TechnicalFailureError is meant to propagate: it re-throws out of
 * agent(), aborts the whole workflow run (which SIGTERMs sibling
 * subagents), and surfaces a clear "why did this fail" message to whatever
 * called the workflow tool.
 */
export class TechnicalFailureError extends Error {
	readonly agentLabel: string;
	readonly failureCode: FailureClassification["code"];
	readonly failureReason: string;
	readonly runId?: string;

	constructor(agentLabel: string, classification: FailureClassification, runId?: string) {
		super(`Subagent "${agentLabel}" hit a technical failure (${classification.code}): ${classification.reason}`);
		this.name = "TechnicalFailureError";
		this.agentLabel = agentLabel;
		this.failureCode = classification.code;
		this.failureReason = classification.reason;
		this.runId = runId;
	}
}

/**
 * Classify a completed (non-zero-exit) SingleResult as a technical failure
 * or an agent-level outcome.
 *
 * Callers should only invoke this for results where exitCode !== 0 or an
 * error is otherwise present; a clean success is always "none".
 */
export function classifySingleResultFailure(result: SingleResult, exitSignal?: string | null): FailureClassification {
	// Checked before aborted/FATAL_KILL_SIGNALS deliberately: both a bash-call
	// timeout kill (bash-timeout-guard.ts) and a turn-budget backstop kill
	// (execution.ts's turn_end handler) terminate the child process the same
	// way a technical abort does — SIGTERM/SIGKILL, exitSignal set, sometimes
	// stopReason "aborted" too — but both are *routable, agent-level* outcomes
	// by design (the graph edge / calling agent decides what happens next),
	// never a reason to hard-abort the whole workflow. Without this ordering,
	// a turn-budget kill would be misclassified as "process-killed (likely an
	// OOM crash)" or "aborted", exactly the bug found in the pre-existing
	// timeout path this fix also covers.
	if (result.timedOut) {
		return { class: "agent", reason: result.error || "Subagent timed out.", code: "timed-out" };
	}
	if (result.turnBudgetExceeded) {
		return { class: "agent", reason: result.error || "Subagent exceeded its turn budget.", code: "turn-budget-exceeded" };
	}

	if (result.stopReason === "aborted" || result.interrupted) {
		return { class: "technical", reason: "The run was aborted (user cancellation or workflow-level abort).", code: "aborted" };
	}

	if (exitSignal && FATAL_KILL_SIGNALS.has(exitSignal)) {
		return {
			class: "technical",
			reason: `The subagent process was killed by signal ${exitSignal} (likely an out-of-memory kill or crash).`,
			code: "process-killed",
		};
	}

	if (result.protocolError) {
		// The one line pi-workflow deliberately does NOT bound tightly is
		// agent_end: it replays the entire session's messages as a single
		// JSON line, so its size grows with session length (most visibly,
		// with how many images an agent read) rather than staying bounded
		// like every other event line. If that line trips the limit, it is
		// not a sign of anything broken — execution.ts already collected
		// every one of those same messages incrementally, one small event
		// at a time, before agent_end ever arrived (see the agent_end
		// handler in execution.ts for why the two are guaranteed to carry
		// identical content). So when result.messages is already populated,
		// the run genuinely completed and this is not a technical failure —
		// it would be wrong to abort a workflow over a redundant, oversized
		// replay of data we already have safely in hand.
		const diagnostics = `${result.protocolError.diagnosticPrefix ?? ""}${result.protocolError.diagnosticTail ?? ""}`;
		const isAgentEndReplay = diagnostics.includes('"type":"agent_end"') || diagnostics.includes('"type": "agent_end"');
		if (isAgentEndReplay && result.messages && result.messages.length > 0) {
			return { class: "none", reason: "", code: "ok" };
		}
		return {
			class: "technical",
			reason: `Protocol output limit exceeded: ${result.protocolError.code} on ${result.protocolError.stream}.`,
			code: "protocol-limit",
		};
	}

	const errorText = result.error || result.errorMessage || "";

	if (/Node required tools unavailable before provider request:/.test(errorText)) {
		return {class: "technical", reason: errorText, code: "required-tools-unavailable"};
	}

	if (/no model candidates available/i.test(errorText) || /no more models to try/i.test(errorText)) {
		return { class: "technical", reason: errorText || "No model candidates were available to run this agent.", code: "no-model-available" };
	}

	if (result.exitCode === 0 && !errorText) {
		return { class: "none", reason: "", code: "ok" };
	}

	if (errorText) {
		if (isRetryableModelFailure(errorText) || ADDITIONAL_TECHNICAL_PATTERNS.some((p) => p.test(errorText))) {
			return { class: "technical", reason: errorText, code: "provider-error" };
		}
	}

	// Acceptance rejection (agent's own output failed validation) and
	// tool-execution failures (e.g. "bash failed (exit 1): ...") are
	// agent-level: the agent ran, it just didn't produce a passing result.
	// A non-zero exit with no other technical markers falls back to
	// agent-level too, since we'd rather under-abort than over-abort and
	// kill sibling agents on an ambiguous signal.
	return { class: "agent", reason: errorText || `Agent exited with code ${result.exitCode}.`, code: "agent-error" };
}
