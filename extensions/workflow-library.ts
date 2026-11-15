/**
 * Saved workflow library — persists workflow scripts to
 * `.pi-workflow/workflows/<name>.js` so they can be listed and re-run later
 * via the `workflow` tool's `loadWorkflow` parameter, without the agent (or
 * user) having to re-author the script from scratch each time.
 *
 * One file per `meta.name`; saving again with the same name overwrites the
 * previous version (no history/versioning — keep it simple).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "acorn";
import { Type } from "typebox";
import { extractGraphMeta } from "./graph-validator.ts";
import type { WorkflowMeta } from "./workflow-display-types.ts";

export interface SavedWorkflowInfo {
	/** meta.name of the saved workflow (also the filename stem) */
	name: string;
	description: string;
	whenToUse?: string;
	filePath: string;
	savedAt: number;
	sizeBytes: number;
	source: "builtin" | "user" | "project";
}

export const BUILTIN_WORKFLOWS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"bundled-workflows",
);

export function getUserWorkflowsDir(): string {
	return path.join(getAgentDir(), "workflows");
}

export function getWorkflowLibraryDir(cwd: string): string {
	return path.join(cwd, ".pi-workflow", "workflows");
}

/**
 * Turn a workflow name into a safe filename stem. meta.name is already
 * expected to be short_snake_case by convention, but sanitize defensively
 * in case the script used something unexpected.
 */
export function sanitizeWorkflowName(name: string): string {
	const safe = name.trim().replace(/[^\w.-]+/g, "_");
	return safe || "workflow";
}

function getWorkflowFilePath(cwd: string, name: string): string {
	return path.join(getWorkflowLibraryDir(cwd), `${sanitizeWorkflowName(name)}.js`);
}

/**
 * Save a workflow script to the project-local library, keyed by
 * `meta.name`. Overwrites any prior version saved under the same name.
 * Returns the path the script was written to.
 */
export function saveWorkflowScript(cwd: string, script: string, meta: WorkflowMeta): { filePath: string; name: string } {
	const dir = getWorkflowLibraryDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const name = sanitizeWorkflowName(meta.name);
	const filePath = getWorkflowFilePath(cwd, name);
	if (fs.existsSync(path.join(dir, `${name}.ts`))) throw new Error(`Cannot save ${name}.js: ${name}.ts already exists. Rename or remove one to avoid ambiguity.`);

	const header = [
		"/**",
		" * Saved pi-workflow script \u2014 reusable via the `workflow` tool's",
		` * loadWorkflow: "${name}" parameter (no need to pass \`script\` again).`,
		` * Name: ${meta.name}`,
		` * Description: ${meta.description}`,
		meta.whenToUse ? ` * When to use: ${meta.whenToUse}` : undefined,
		` * Saved: ${new Date().toISOString()}`,
		" */",
	].filter((l): l is string => l !== undefined);

	const content = `${header.join("\n")}\n${script.trim()}\n`;
	fs.writeFileSync(filePath, content, "utf-8");
	return { filePath, name };
}

/**
 * Load a previously saved workflow script by name. Searches in order of precedence:
 * project-local (.pi-workflow/workflows/), user-global (~/.pi/agent/workflows/),
 * and bundled/built-in workflows (bundled-workflows/).
 */
export function resolveSavedWorkflowPath(cwd: string, name: string): string | undefined {
	for (const dir of [getWorkflowLibraryDir(cwd), getUserWorkflowsDir(), BUILTIN_WORKFLOWS_DIR]) {
		const matches = [".js", ".ts"].map(ext => path.join(dir, `${sanitizeWorkflowName(name)}${ext}`)).filter(p => fs.existsSync(p));
		if (matches.length > 1) throw new Error(`Ambiguous saved workflow "${name}": both .js and .ts exist in ${dir}. Rename or remove one.`);
		if (matches.length) return matches[0];
	}
	return undefined;
}
export function loadSavedWorkflowScript(cwd: string, name: string): string | undefined {
	const filePath = resolveSavedWorkflowPath(cwd, name);
	return filePath ? fs.readFileSync(filePath, "utf8") : undefined;
}

/**
 * Helper to scan a specific directory and parse the workflow scripts inside.
 */
function scanWorkflowDir(dir: string, source: "builtin" | "user" | "project"): SavedWorkflowInfo[] {
	if (!fs.existsSync(dir)) return [];
	const results: SavedWorkflowInfo[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const stem = entry.name.replace(/[.](js|ts)$/, "");
			if (entries.filter(e => e.isFile() && e.name.replace(/[.](js|ts)$/, "") === stem).length > 1) throw new Error(`Ambiguous saved workflow "${stem}" in ${dir}: both .js and .ts exist.`);
			if (!entry.isFile() || !/[.](js|ts)$/.test(entry.name)) continue;
			const filePath = path.join(dir, entry.name);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const meta = extractGraphMeta(
					parse(content, { ecmaVersion: "latest", sourceType: "module" }) as never,
				);
				const stat = fs.statSync(filePath);
				results.push({
					name: meta.name,
					description: meta.description,
					whenToUse: meta.whenToUse,
					filePath,
					savedAt: stat.mtimeMs,
					sizeBytes: stat.size,
					source,
				});
			} catch {
				// Skip files that fail to parse (e.g. hand-edited, corrupted).
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Ambiguous")) throw error;
	}
	return results;
}

/**
 * List all workflows available across all three tiers: project, user, and built-in.
 * Later tiers (project > user > built-in) shadow earlier ones if they share the same name.
 */
export function listSavedWorkflows(cwd: string): SavedWorkflowInfo[] {
	const projectWfs = scanWorkflowDir(getWorkflowLibraryDir(cwd), "project");
	const userWfs = scanWorkflowDir(getUserWorkflowsDir(), "user");
	const builtinWfs = scanWorkflowDir(BUILTIN_WORKFLOWS_DIR, "builtin");

	const merged = new Map<string, SavedWorkflowInfo>();

	// Add in order of ascending precedence so shadowing happens naturally
	for (const wf of builtinWfs) merged.set(wf.name, wf);
	for (const wf of userWfs) merged.set(wf.name, wf);
	for (const wf of projectWfs) merged.set(wf.name, wf);

	return Array.from(merged.values()).sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Delete a saved workflow by name from the project or user scopes.
 * Built-in workflows are read-only and cannot be deleted.
 */
export function deleteSavedWorkflow(cwd: string, name: string): boolean {
	const resolved = resolveSavedWorkflowPath(cwd, name);
	if (!resolved || resolved.startsWith(BUILTIN_WORKFLOWS_DIR + path.sep)) return false;
	fs.unlinkSync(resolved);
	return true;
}

const ListWorkflowsParams = Type.Object({
	detailed: Type.Optional(
		Type.Boolean({
			description: "If true, return the full details of each workflow including size and whenToUse. Default: false.",
		}),
	),
});

export function createListWorkflowsTool() {
	return {
		name: "list_workflows",
		label: "List Workflows",
		description: "List the workflows available for execution, including built-in, user-global, and project-saved scripts.",
		parameters: ListWorkflowsParams,
		async execute(_toolCallId: string, params: { detailed?: boolean }, _signal: any, _onUpdate: any, ctx: any) {
			const saved = listSavedWorkflows(ctx.cwd);
			if (saved.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No workflows available. Save a workflow by calling workflow with saveWorkflow: true.",
						},
					],
					details: { count: 0, workflows: [] },
				};
			}

			const body = params.detailed
				? saved.map((w) => `• ${w.name} (${w.source}):\n  Description: ${w.description}\n  When to use: ${w.whenToUse ?? "N/A"}\n  Saved: ${new Date(w.savedAt).toISOString()}`).join("\n\n")
				: saved.map((w) => `- ${w.name} (${w.source}): ${w.description}`).join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `${saved.length} workflow${saved.length === 1 ? "" : "s"} available:\n\n${body}`,
					},
				],
				details: { count: saved.length, workflows: saved },
			};
		},
	};
}
