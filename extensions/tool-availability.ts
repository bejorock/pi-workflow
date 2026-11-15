/**
 * Tool availability — environment variable keys for communicating required
 * child tools and diagnostic paths to child processes.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_TOOL_DIAGNOSTIC_PATH_ENV = "PI_SUBAGENT_CHILD_TOOL_DIAGNOSTIC_PATH";
export const MCP_DIRECT_CHILD_TOOLS_ENV = "PI_SUBAGENT_MCP_DIRECT_CHILD_TOOLS";
export const REQUIRED_CHILD_TOOLS_ENV = "PI_SUBAGENT_REQUIRED_CHILD_TOOLS";
export const CHILD_TOOL_ALLOWLIST_ENV = "PI_SUBAGENT_TOOL_ALLOWLIST";

/** Undefined means defaults; [] deliberately grants no model tools. */
export function readChildToolAllowlist(): string[] | undefined {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return undefined;
	const encoded = process.env[CHILD_TOOL_ALLOWLIST_ENV];
	if (encoded === undefined) return undefined;
	try {
		const names: unknown = JSON.parse(encoded);
		if (Array.isArray(names) && names.every(name => typeof name === "string" && name)) {
			return [...new Set(names as string[])];
		}
	} catch {
		// Malformed policy must fail closed rather than restoring default tools.
	}
	throw new Error(`Invalid ${CHILD_TOOL_ALLOWLIST_ENV} payload.`);
}

/** Reapply after extension startup, and block calls even if an extension later
 * activates an undeclared tool. This scopes model access, not extension code's
 * OS permissions (e.g. an allowed bash tool is not a security sandbox).
 */
export function registerChildToolAllowlist(pi: ExtensionAPI): void {
	const names = readChildToolAllowlist();
	if (names === undefined) return;
	const allowed = new Set(names);
	const apply = () => pi.setActiveTools(names);
	pi.on("before_agent_start", apply);
	pi.on("tool_call", event => {
		if (!allowed.has(event.toolName)) {
			return { block: true, reason: `Tool '${event.toolName}' is not in this agent's tools allowlist.` };
		}
	});
}

export interface ChildToolDiagnostic {
	available: string[];
	missing: string[];
}

export function writeChildToolDiagnostic(
	filePath: string,
	required: string[],
	available: string[],
	_agentName?: string,
	_mcpTools?: string[],
): ChildToolDiagnostic {
	const missing = required.filter((r) => !available.includes(r));
	const diagnostic: ChildToolDiagnostic = { available, missing };
	try {
		fs.writeFileSync(filePath, JSON.stringify(diagnostic));
	} catch {
		// Best effort
	}
	return diagnostic;
}

export function readChildToolDiagnosticError(toolDiagnosticPath: string | undefined): string | undefined {
	if (!toolDiagnosticPath) return undefined;
	try {
		const content = JSON.parse(fs.readFileSync(toolDiagnosticPath, "utf-8")) as ChildToolDiagnostic;
		if (content.missing.length > 0) {
			return `Missing required tools: ${content.missing.join(", ")}`;
		}
	} catch {
		// No diagnostic file or parse error — ignore
	}
	return undefined;
}
