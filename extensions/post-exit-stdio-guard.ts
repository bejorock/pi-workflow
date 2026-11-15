/** Bounded child shutdown, including descendants retaining inherited output pipes. */
import type { ChildProcess } from "node:child_process";

export const CHILD_KILL_GRACE_MS = 1000;
export const CHILD_DRAIN_GRACE_MS = 1000;

export function attachPostExitStdioGuard(proc: ChildProcess): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const drain = () => {
		timer ??= setTimeout(() => {
			// The direct child has exited. A descendant must not own our completion.
			trySignalChild(proc, "SIGKILL");
			proc.stdout?.destroy();
			proc.stderr?.destroy();
		}, CHILD_DRAIN_GRACE_MS);
	};
	const cleanup = () => { if (timer) clearTimeout(timer); };
	proc.once("exit", drain);
	proc.once("close", cleanup);
	return cleanup;
}

export function trySignalChild(proc: ChildProcess, signal: NodeJS.Signals | number): boolean {
	try {
		if (process.platform !== "win32" && proc.pid) {
			try { process.kill(-proc.pid, signal); return true; } catch { /* direct-child fallback */ }
		}
		return proc.kill(signal);
	} catch { return false; }
}

/** Escalation must not depend on another child event or model turn. */
export function terminateChild(proc: ChildProcess): void {
	trySignalChild(proc, "SIGTERM");
	const timer = setTimeout(() => {
		trySignalChild(proc, "SIGKILL");
		// Even escaped descendants cannot keep the parent waiting on inherited pipes.
		proc.stdout?.destroy();
		proc.stderr?.destroy();
	}, CHILD_KILL_GRACE_MS);
	proc.once("close", () => clearTimeout(timer));
}
