/** Read-only projection for the optional terminal dashboard. Never executes workflow scripts. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowManager, ManagedRun } from "./workflow-manager.ts";
import { readPlanMeta, plansDir } from "./plan-tool.ts";
import { readContractMeta, contractsDir } from "./contract-tool.ts";

export interface DashboardNode {
	id: string; label: string; status: string; visits: number; nodeType?: string; preview?: string;
}
export interface DashboardEdge { from: string; to: string; observed?: boolean }
export interface DashboardRun {
	runId: string; name: string; status: string; startedAt: number; updatedAt: number;
	totalTokens: number; durationMs: number; nodes: DashboardNode[]; edges: DashboardEdge[]; logs: string[];
}
export interface DashboardDocument {
	id: string; name: string; content: string; updatedAt: string;
	status?: string; type?: string; producer?: string; consumer?: string;
}
export interface DashboardSnapshot {
	version: 1; cwd: string; updatedAt: number; connected: boolean;
	runs: DashboardRun[]; plans: DashboardDocument[]; contracts: DashboardDocument[];
}

const MAX_FILE = 2 * 1024 * 1024;
function readDocument(file: string): string | undefined {
	try {
		// Do not follow links outside this workspace or read unbounded files.
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_FILE) return undefined;
		return fs.readFileSync(file, "utf8");
	} catch { return undefined; }
}

function liveRun(run: ManagedRun, now: number): DashboardRun {
	const nodes = new Map<string, DashboardNode>();
	for (const n of run.dashboardGraph?.nodes ?? []) nodes.set(n.id, { ...n, status: "queued", visits: 0 });
	const edges = new Map<string, DashboardEdge>();
	for (const e of run.dashboardGraph?.edges ?? []) edges.set(`${e.from}\0${e.to}`, { ...e });
	for (const agent of run.snapshot.agents) {
		// Graph visits have stable ids; ordinary subagent runs retain separate numbered entries.
		const id = agent.nodeId ?? `agent-${agent.id}`;
		const previous = nodes.get(id);
		const status = agent.status === "running"
			? run.status === "paused" ? "paused"
				: run.status !== "running" ? run.status
					: agent.nodeType === "human" ? "waiting" : "running"
			: agent.status;
		nodes.set(id, { id, label: previous?.label ?? agent.label, nodeType: agent.nodeType,
			status, visits: (previous?.visits ?? 0) + 1, preview: agent.error ?? agent.resultPreview });
		for (const to of agent.routedTo?.split(",").map(s => s.trim()).filter(Boolean) ?? []) {
			if (to === "END") nodes.set("END", { id: "END", label: "END", status: "done", visits: 0 });
			edges.set(`${id}\0${to}`, { from: id, to, observed: true });
		}
	}
	return { runId: run.runId, name: run.snapshot.meta.name, status: run.status,
		startedAt: run.startedAt, updatedAt: run.updatedAt, totalTokens: run.snapshot.totalTokens,
		durationMs: ["running", "paused"].includes(run.status) ? now - run.startedAt : run.snapshot.durationMs,
		nodes: [...nodes.values()], edges: [...edges.values()], logs: run.snapshot.logs.slice(-30) };
}

/** Cached journal reads; tolerates a partial last line while another process appends. */
export class DashboardProjector {
	private cache = new Map<string, { mtime: number; size: number; run: DashboardRun }>();
	constructor(private manager: WorkflowManager, private cwd: string) {}

	private historical(file: string, runId: string): DashboardRun | undefined {
		try {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > 32 * MAX_FILE) return undefined;
			const cached = this.cache.get(file);
			if (cached?.mtime === stat.mtimeMs && cached.size === stat.size) return cached.run;
			const run: DashboardRun = { runId, name: runId, status: "unknown", startedAt: 0,
				updatedAt: stat.mtimeMs, totalTokens: 0, durationMs: 0, nodes: [], edges: [], logs: [] };
			const nodes = new Map<string, DashboardNode>();
			const edges = new Map<string, DashboardEdge>();
			for (const line of fs.readFileSync(file, "utf8").split("\n")) {
				let rec;
				try { rec = JSON.parse(line); } catch { continue; }
				if (rec.type === "graph_run") {
					run.name = rec.name ?? runId; run.startedAt = rec.startedAt ?? 0;
					for (const id of rec.nodeIds ?? []) nodes.set(id, { id, label: id, status: "queued", visits: 0 });
				} else if (rec.type === "node") {
					const id = rec.nodeId;
					if (typeof id !== "string") continue;
					nodes.set(id, { id, label: rec.agentName ? `${id} (${rec.agentName})` : id,
						nodeType: rec.nodeType, visits: (nodes.get(id)?.visits ?? 0) + 1,
						status: rec.status === "failed" ? "error" : rec.status === "skipped" ? "skipped" : "done",
						preview: rec.error ?? (typeof rec.result === "string" ? rec.result.slice(0, 2000) : undefined) });
					run.totalTokens += rec.tokens ?? 0;
					for (const to of String(rec.routedTo ?? "").split(",").filter(Boolean)) {
						if (!nodes.has(to)) nodes.set(to, { id: to, label: to, visits: 0, status: to === "END" ? "done" : "queued" });
						edges.set(`${id}\0${to}`, { from: id, to, observed: true });
					}
				} else if (rec.type === "graph_result") {
					run.status = rec.error || rec.status === "max_iterations" ? "error" : rec.status === "aborted" ? "stopped" : "completed";
					run.totalTokens = rec.totalTokens ?? run.totalTokens; run.durationMs = rec.durationMs ?? 0;
					if (rec.error) run.logs.push(rec.error);
				}
			}
			run.nodes = [...nodes.values()]; run.edges = [...edges.values()];
			if (run.status === "unknown") run.logs.push("No final journal record; live ownership is unknown. Only recorded routes are shown.");
			this.cache.set(file, { mtime: stat.mtimeMs, size: stat.size, run });
			return run;
		} catch { return undefined; }
	}

	snapshot(connected = true, now = Date.now()): DashboardSnapshot {
		const runs = new Map<string, DashboardRun>();
		const dir = path.join(this.cwd, ".pi-workflow", "runs");
		try {
			for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"))) {
				const run = this.historical(path.join(dir, f), f.slice(0, -6));
				if (run) runs.set(run.runId, run);
			}
		} catch { /* Workspace need not have any journals. */ }
		// Use only in-memory ids here: listRuns also scans a mutable journalDir.
		for (const run of this.manager.listActiveRuns()) {
			if (run.cwd ? path.resolve(run.cwd) === path.resolve(this.cwd) : run.journalDir === dir) {
				runs.set(run.runId, liveRun(run, now));
			}
		}
		const docs = (kind: "plans" | "contracts"): DashboardDocument[] => {
			try {
				const dir = kind === "plans" ? plansDir(this.cwd) : contractsDir(this.cwd);
				return fs.readdirSync(dir).filter(f => f.endsWith(".md")).flatMap(file => {
					// Check size and symlink policy BEFORE calling metadata helpers.
					const content = readDocument(path.join(dir, file));
					if (content === undefined) return [];
					const id = file.slice(0, -3);
					if (kind === "plans") {
						const meta = readPlanMeta(dir, id);
						return meta ? [{ id, name: meta.name, content, updatedAt: meta.updatedAt }] : [];
					}
					const meta = readContractMeta(dir, id);
					return meta ? [{ id, name: meta.title, content, updatedAt: meta.updated,
						status: meta.status, type: meta.type, producer: meta.producer, consumer: meta.consumer }] : [];
				}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			} catch { return []; }
		};
		return { version: 1, cwd: this.cwd, updatedAt: now, connected,
			runs: [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200), plans: docs("plans"), contracts: docs("contracts") };
	}
}
