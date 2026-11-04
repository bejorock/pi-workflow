/** Explicit, terminal-only dashboard. No relay, LLM messages, or workflow controls. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { DashboardProjector } from "./dashboard-state.ts";
import { resolvePiPackageRoot, resolveInstalledPiPackageRoot, PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "./pi-spawn.ts";
import type { WorkflowManager } from "./workflow-manager.ts";

/** Herdr argv-backed launch avoids shell quoting and shell-specific startup files. */
export function dashboardLaunchParams(cwd: string, snapshotPath: string, workspaceId: string, piRoot?: string) {
	return {
		workspace_id: workspaceId, tab_label: "Pi Workspace", focus: true,
		root: { type: "pane", label: "Pi Workspace Dashboard", cwd,
			env: piRoot ? { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: piRoot } : {},
			command: [process.execPath, fileURLToPath(new URL("./dashboard/launch.mjs", import.meta.url)), "--snapshot", snapshotPath] },
	};
}

export function herdrRequest(socketPath: string, method: string, params: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let data = "";
		const finish = (error?: Error, result?: unknown) => {
			socket.destroy();
			if (error) reject(error); else resolve(result);
		};
		socket.setTimeout(5000, () => finish(new Error("Herdr request timed out; inspect the tab before retrying.")));
		socket.on("error", error => finish(error));
		socket.on("connect", () => socket.write(JSON.stringify({ id: "pi-workspace-dashboard", method, params }) + "\n"));
		socket.on("end", () => finish(new Error("Herdr closed the connection without a response.")));
		socket.on("data", chunk => {
			data += chunk.toString();
			if (data.length > 1024 * 1024) return finish(new Error("Herdr response too large."));
			const end = data.indexOf("\n");
			if (end < 0) return;
			try {
				const response = JSON.parse(data.slice(0, end));
				if (response.error) finish(new Error(`Herdr: ${response.error.message ?? response.error.code}`));
				else finish(undefined, response.result);
			} catch (error) { finish(error as Error); }
		});
	});
}

export function registerWorkspaceDashboard(pi: ExtensionAPI, manager: WorkflowManager): void {
	let active: { cwd: string; file: string; dir: string; timer: ReturnType<typeof setInterval>; projector: DashboardProjector } | undefined;
	const stop = () => {
		if (!active) return;
		clearInterval(active.timer);
		try {
			const snapshot = JSON.parse(fs.readFileSync(active.file, "utf8"));
			snapshot.connected = false;
			fs.writeFileSync(active.file + ".tmp", JSON.stringify(snapshot), { mode: 0o600 });
			fs.renameSync(active.file + ".tmp", active.file);
		} catch { /* Viewer detects stale/missing state. */ }
		// A viewer can remain open after reload. Keep its final snapshot readable
		// briefly; an unref'ed cleanup cannot hold Pi open.
		const dir = active.dir;
		setTimeout(() => {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Best-effort temporary cleanup. */ }
		}, 60_000).unref();
		active = undefined;
	};
	pi.on("session_shutdown", async () => stop());
	pi.registerCommand("workspace-dashboard", {
		description: "Open the Kitty graphics workspace viewer in a new Herdr tab (workflows, plans, contracts)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /workspace-dashboard (opens a new Herdr tab)", "warning"); return;
			}
			if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) {
				ctx.ui.notify("Workspace dashboard requires an interactive Pi TUI inside a Herdr pane and a Kitty graphics-capable terminal.", "warning"); return;
			}
			if (process.platform === "win32") {
				ctx.ui.notify("Workspace dashboard currently supports Herdr on Linux/macOS only.", "warning"); return;
			}
			// Snapshot lives in a private temporary directory, not the repository.
			// Repeated opens share the publisher instead of accumulating timers.
			try {
				if (active?.cwd !== ctx.cwd) stop();
				if (!active) {
					const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workspace-dashboard-"));
					fs.chmodSync(dir, 0o700);
					const file = path.join(dir, "snapshot.json");
					const projector = new DashboardProjector(manager, ctx.cwd);
					const publish = () => {
						try {
							fs.writeFileSync(file + ".tmp", JSON.stringify(projector.snapshot()), { mode: 0o600 });
							fs.renameSync(file + ".tmp", file);
						} catch { /* Observer failures cannot affect execution. */ }
					};
					publish();
					const timer = setInterval(publish, 1000); timer.unref();
					active = { cwd: ctx.cwd, dir, file, timer, projector };
				}
				const socket = process.env.HERDR_SOCKET_PATH;
				if (!socket) throw new Error("HERDR_SOCKET_PATH is missing; refusing to target an unrelated default Herdr session.");
				let piRoot = resolvePiPackageRoot();
				if (!piRoot) {
					try { piRoot = resolveInstalledPiPackageRoot(); } catch { /* Local viewer resolution or bootstrap diagnostics remain available. */ }
				}
				await herdrRequest(socket, "layout.apply", dashboardLaunchParams(ctx.cwd, active.file, process.env.HERDR_WORKSPACE_ID, piRoot));
				ctx.ui.notify("Opened Pi Workspace in a Herdr tab. The viewer checks Kitty graphics support there.", "info");
			} catch (error) {
				stop();
				ctx.ui.notify(`Cannot open workspace dashboard: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
