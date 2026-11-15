/** Explicit graph input/output contracts. No implicit tool grants or implementation retries. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeOptions, GraphState } from "./graph-dsl.ts";

export function selectStateFields(state: GraphState, fields: string[]): Record<string, unknown> {
	const selected: Record<string, unknown> = Object.create(null);
	for (const field of fields) {
		const parts = field.split(".");
		if (parts.some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))) throw new Error(`Unsafe handoff field: ${field}`);
		let value: unknown = state;
		for (const part of parts) {
			if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Error(`Missing handoff field: ${field}`);
			value = (value as Record<string, unknown>)[part];
		}
		selected[field] = value;
	}
	return selected;
}
export function checkNodeContract(cwd: string, options: AgentNodeOptions, tools: string[] | undefined): void {
	for (const tool of options.requiredTools ?? []) {
		if (tools !== undefined && !tools.includes(tool) && !(tool === "structured_output" && options.outputSchema)) throw new Error(`Required tool '${tool}' is excluded by the agent's explicit tools. Add it to tools; permissions do not grant tools.`);
	}
	for (const [file, expected] of Object.entries(options.dependencies ?? {})) {
		if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Dependency ${file} requires an exact SHA-256 hash.`);
		const actual = createHash("sha256").update(fs.readFileSync(path.resolve(cwd, file))).digest("hex");
		if (actual !== expected) throw new Error(`Stale briefing dependency: ${file}. Reassess the briefing; expected ${expected}, got ${actual}.`);
	}
}
export function prepareNodeInput(cwd: string, runId: string, nodeId: string, step: number, prompt: string, state: GraphState, options: AgentNodeOptions): {prompt: string; artifact?: string} {
	const projection = options.handoff ? JSON.stringify(selectStateFields(state, options.handoff), null, 2) : "";
	const full = prompt + (projection ? `\n\nSelected handoff fields:\n${projection}` : "");
	if (options.maxHandoffChars === undefined || full.length <= options.maxHandoffChars) return {prompt: full};
	const dir = path.join(cwd, ".pi-workflow", "artifacts", "handoffs", runId);
	fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	const artifact = path.join(dir, `${encodeURIComponent(nodeId)}-${step}.md`);
	fs.writeFileSync(artifact, full, {mode: 0o600});
	const suffix = `\n[Handoff bounded; full briefing: ${artifact}]`;
	if (suffix.length >= options.maxHandoffChars) throw new Error("maxHandoffChars is too small to preserve the full-briefing artifact reference.");
	return {prompt: full.slice(0, options.maxHandoffChars - suffix.length) + suffix, artifact};
}
