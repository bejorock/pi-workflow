/**
 * Bash-timeout guard: caps unbounded `bash` tool calls with a default
 * timeout, without touching agent/process-level lifetime at all.
 *
 * Motivation (production incident): a subagent's last action was
 * `which python3; find / -name "fitz" 2>/dev/null` — a whole-filesystem
 * search with no timeout. It never returned, so no further turns fired,
 * so nothing in the stack (blank-stop guard, turn budgets, the graph
 * executor) ever got a chance to react. The node stalled forever.
 *
 * The fix is deliberately narrow: pi's `bash` tool already accepts an
 * optional `timeout` (seconds) and implements it cleanly — kills the
 * child's process tree and returns a normal tool-result error
 * ("Command timed out after Ns"), the same shape as "exited with code 1".
 * This guard just fills that field in with a default when the model didn't
 * set one itself; an explicit `timeout` from the model always wins.
 *
 * Deliberately does NOT touch:
 *  - Agent/subagent process lifetime (unbounded by design — see
 *    ask below).
 *  - ask / ask_supervisor: these are custom tools, not
 *    `bash`; this hook is scoped to `toolName === "bash"` and cannot see
 *    or affect them. Human questions stay unbounded on purpose, so an
 *    important request from the agent is never missed because the user
 *    was slow to answer.
 *  - The failure classifier: a bash timeout becomes an ordinary tool
 *    result error, which already flows through the existing "agent-level,
 *    routable" path in failure-classifier.ts. No new classification branch
 *    is needed or added.
 *
 * Registered once per pi process; because pi-workflow injects its own
 * extension path into every spawned child (pi-args.ts runtimeExtensions),
 * this covers the main agent, every subagent, and nested levels — the same
 * process-wide registration pattern as the blank-stop guard.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default bash timeout in seconds when the model didn't specify one. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;

/**
 * Register the bash-timeout guard on a pi instance.
 *
 * @param options.timeoutSeconds — the default to inject. Pass `null` (via
 *   the `enabled` gate below) to disable entirely.
 * @param options.enabled — when false, no hook is registered and the guard
 *   is inert (same as if it had never existed). Defaults to true. Driven by
 *   `.pi-workflow/settings.json` → `bashTimeoutGuard: false`, or a custom
 *   `bashTimeoutSeconds` override.
 */
export function registerBashTimeoutGuard(
	pi: ExtensionAPI,
	options?: { enabled?: boolean; timeoutSeconds?: number },
): void {
	if (options?.enabled === false) return;
	const timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS;
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return;

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		// A model-specified timeout always wins — this only fills the gap
		// left when the model didn't think to set one. No re-validation
		// happens after a tool_call mutation (pi's documented contract), so
		// this is a plain, safe in-place patch.
		if (event.input.timeout === undefined) {
			event.input.timeout = timeoutSeconds;
		}
	});
}
