/** Workspace-scoped cleanup. Never follows symlinks or trusts paths from journals. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowManager } from "./workflow-manager.ts";

export type CleanupMode = "history" | "files";
export interface CleanupPlan { runIds: string[]; skipped: string[]; paths: string[]; bytes: number; mode: CleanupMode; }
const safeId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id);
function assertSafePath(root: string, target: string): void {
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe cleanup path");
	// Include root and every existing ancestor, not just the leaf.
	let current = root;
	for (const part of ["", ...relative.split(path.sep)]) {
		if (part) current = path.join(current, part);
		if (fs.existsSync(current) || (() => { try { return fs.lstatSync(current).isSymbolicLink(); } catch { return false; } })()) {
			if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink cleanup path: ${current}`);
		}
	}
}
function size(file: string): number {
	const stat = fs.lstatSync(file);
	if (stat.isSymbolicLink()) return stat.size; // rm removes link itself, never its target.
	if (!stat.isDirectory()) return stat.size;
	return fs.readdirSync(file).reduce((n, entry) => n + size(path.join(file, entry)), 0);
}
export function planRunCleanup(manager: WorkflowManager, ids: string[], mode: CleanupMode): CleanupPlan {
	const dir = manager.getJournalDir();
	if (!dir) throw new Error("No workspace run directory available.");
	const root = path.resolve(dir, "..");
	// The scope must be the project's own .pi-workflow directory, never an arbitrary root.
	if (path.basename(root) !== ".pi-workflow" || path.basename(dir) !== "runs") throw new Error("Unexpected run storage directory.");
	assertSafePath(root, path.join(dir, ".hidden-runs.json"));
	assertSafePath(root, path.join(dir, ".hidden-runs.json.tmp"));
	const plan: CleanupPlan = { runIds: [], skipped: [], paths: [], bytes: 0, mode };
	const visible = new Map(manager.listRuns(true).map(run => [run.runId, run]));
	for (const id of [...new Set(ids)]) {
		const run = visible.get(id);
		if (!safeId(id) || !run || !manager.canDeleteRun(id)) { plan.skipped.push(id); continue; }
		const candidates = mode === "history" ? [] : [path.join(dir, `${id}.jsonl`), path.join(dir, `${id}.run.json`), path.join(root, "sessions", id)];
		const artifacts = path.join(root, "artifacts", "runs");
		if (mode === "files") {
			assertSafePath(root, artifacts);
			if (fs.existsSync(artifacts)) {
				// The generated run ID is a complete boundary; exclude another known run's prefix.
				for (const entry of fs.readdirSync(artifacts)) if (entry.startsWith(`${id}-`) && ![...visible.keys()].some(other => other !== id && other.startsWith(`${id}-`) && entry.startsWith(`${other}-`))) candidates.push(path.join(artifacts, entry));
			}
		}
		for (const file of candidates) { assertSafePath(root, file); if (fs.existsSync(file)) { plan.paths.push(file); plan.bytes += size(file); } }
		plan.runIds.push(id);
	}
	return plan;
}
export function executeRunCleanup(manager: WorkflowManager, requested: CleanupPlan): CleanupPlan {
	// Recompute on confirmation. A resumed run cannot be deleted using a stale preview.
	const plan = planRunCleanup(manager, requested.runIds, requested.mode);
	if (plan.runIds.length !== requested.runIds.length) throw new Error("Run state changed; preview cleanup again.");
	if (plan.paths.some(file => !requested.paths.includes(file))) throw new Error("Run files changed; preview cleanup again.");
	for (const file of plan.paths) fs.rmSync(file, { recursive: true, force: true });
	manager.hideRuns(plan.runIds);
	return plan;
}
export function cleanupDescription(plan: CleanupPlan): string {
	return `${plan.runIds.length} run(s), ~${(plan.bytes / 1024 / 1024).toFixed(2)} MiB. ${plan.mode === "files" ? "Delete run journals, local artifacts and child sessions. Checkpoint resume will be lost. Custom artifact directories and untracked legacy subagent files are not included." : "Hide history only; files remain on disk (no space reclaimed)."} Source files, plans, contracts and unrelated sessions are never removed.${plan.skipped.length ? ` ${plan.skipped.length} active/unknown run(s) excluded.` : ""}`;
}
