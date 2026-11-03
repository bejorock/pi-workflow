/** Bounded asynchronous shell execution. Never blocks Pi's input/render timers. */
import { spawn } from "node:child_process";

export interface CommandProcessResult {
	stdout: Buffer;
	stderr: Buffer;
	status: number | null;
	error?: Error;
	aborted?: boolean;
}

export function runCommandProcess(command: string, options: {
	cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal;
}): Promise<CommandProcessResult> {
	if (options.signal?.aborted) return Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, aborted: true });
	return new Promise(resolve => {
		const stdout: Buffer[] = [], stderr: Buffer[] = [];
		let outBytes = 0, errBytes = 0, failure: Error | undefined, aborted = false;
		let done = false, timer: ReturnType<typeof setTimeout> | undefined, fallback: ReturnType<typeof setTimeout> | undefined;
		// A separate Unix process group lets timeout/stop kill shell descendants
		// too, rather than orphaning `sleep`, build tools, or inherited pipes.
		const grouped = process.platform !== "win32";
		const child = spawn(command, { cwd: options.cwd, env: options.env, shell: true,
			detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (status: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer); clearTimeout(fallback);
			options.signal?.removeEventListener("abort", abort);
			child.stdout.destroy(); child.stderr.destroy();
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status, error: failure, aborted });
		};
		const terminate = () => {
			try {
				if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* Already exited. */ }
			// An escaped descendant can retain a pipe despite group termination.
			// Do not let it hold a cancelled workflow open indefinitely.
			fallback ??= setTimeout(() => finish(null), 500);
		};
		const abort = () => { aborted = true; terminate(); };
		const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
			if (done || failure || aborted) return;
			const used = stream === "stdout" ? outBytes : errBytes;
			const remaining = Math.max(0, options.maxBuffer - used);
			(stream === "stdout" ? stdout : stderr).push(chunk.subarray(0, remaining));
			if (stream === "stdout") outBytes += chunk.length; else errBytes += chunk.length;
			if (chunk.length > remaining && !failure) {
				failure = Object.assign(new Error(`${stream} exceeded ${options.maxBuffer} byte output limit`), { code: "ENOBUFS" });
				// One bounded sentinel byte lets the caller retain its established
				// UTF-8-safe truncation marker without buffering excess output.
				(stream === "stdout" ? stdout : stderr).push(Buffer.from(" "));
				terminate();
			}
		};
		child.stdout.on("data", chunk => capture("stdout", chunk));
		child.stderr.on("data", chunk => capture("stderr", chunk));
		child.on("error", error => { failure ??= error; finish(null); });
		child.on("close", code => finish(code));
		timer = setTimeout(() => {
			failure ??= Object.assign(new Error(`Command timed out after ${options.timeout}ms`), { code: "ETIMEDOUT" });
			terminate();
		}, options.timeout);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}
