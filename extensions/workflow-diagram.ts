/** Conservative source preview. Never imports or evaluates workflow definitions/callbacks. */
import { parse, type Node } from "acorn";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractConditionalTargets } from "./graph-edge-targets.ts";

type Ast = Node & Record<string, unknown>;
export interface WorkflowDiagram { mermaid: string; lines: string[]; warnings: string[]; }
const label = (value: string) => value.replace(/[^\x20-\x7e]/g, "?").replace(/["\\\[\]{}<>|&;]/g, "_").slice(0, 60);
const node = (v: unknown): Ast | undefined => v && typeof v === "object" && "type" in v ? v as Ast : undefined;
const literal = (v: unknown): string | undefined => { const n = node(v); return n?.type === "Literal" && typeof n.value === "string" ? n.value : undefined; };
const end = (v: unknown) => { const n = node(v); return n?.type === "Identifier" && n.name === "END"; };

export function previewWorkflowDiagram(source: string): WorkflowDiagram {
	const warnings: string[] = [];
	const empty = (message: string): WorkflowDiagram => ({mermaid: "", lines: [message, "Use Code to inspect the original script."], warnings});
	if (Buffer.byteLength(source) > 128 * 1024) return empty("Diagram unavailable: source exceeds the 128 KiB diagram limit.");
	try {
		const ast = parse(source, {ecmaVersion: "latest", sourceType: "module"}) as unknown as Ast;
		const body = ast.body as Ast[];
		const graphs: string[] = [];
		for (const statement of body) {
			if (statement.type !== "VariableDeclaration") continue;
			for (const decl of statement.declarations as Ast[]) {
				const init = node(decl.init); const callee = node(init?.callee); const id = node(decl.id);
				if (init?.type === "CallExpression" && callee?.type === "Identifier" && callee.name === "graph" && id?.type === "Identifier") graphs.push(String(id.name));
			}
		}
		if (graphs.length !== 1) return empty("Diagram unavailable: expected one top-level graph() declaration.");
		warnings.push("Only literal top-level declarations are shown; helpers, arguments and definition side effects are not evaluated.");
		const calls: {statement: Ast; args: Ast[]; method: string}[] = [];
		for (const statement of body) {
			const expression = node(statement.expression); const callee = node(expression?.callee);
			const object = node(callee?.object); const property = node(callee?.property);
			if (statement.type === "ExpressionStatement" && expression?.type === "CallExpression" && callee?.type === "MemberExpression" && !callee.computed && object?.type === "Identifier" && object.name === graphs[0] && property?.type === "Identifier" && ["node", "edge", "run"].includes(String(property.name))) {
				calls.push({statement, args: expression.arguments as Ast[], method: String(property.name)});
			} else if (statement.type !== "ExportNamedDeclaration" || !node(statement.declaration) || node(statement.declaration)?.type !== "VariableDeclaration") {
				// Definitions may build additional topology in loops, helpers, aliases or assignments.
				if (statement.type !== "VariableDeclaration" && statement.type !== "EmptyStatement") warnings.push("Additional definition code is not evaluated; topology may be incomplete.");
			}
		}
		const nodes = new Map<string, string>();
		for (const call of calls.filter(c => c.method === "node")) {
			const id = literal(call.args[0]);
			if (!id || nodes.has(id)) { warnings.push("Computed or duplicate node declarations are not shown."); continue; }
			const def = call.args[1]; const callee = node(def?.callee);
			const kind = def?.type === "CallExpression" && callee?.type === "Identifier" ? String(callee.name) : "fn";
			nodes.set(id, ["agent", "human", "command"].includes(kind) ? kind : "fn");
		}
		if (!nodes.size) return empty("Diagram unavailable: no literal top-level node declarations.");
		if (nodes.size > 24 || calls.filter(c => c.method === "edge").length > 64) return empty("Diagram unavailable: preview limit is 24 nodes / 64 edge declarations.");
		warnings.push("Static map only: conditional links are possible routes, not an execution trace or approval.");
		const ids = new Map([...nodes.keys()].map((id, i) => [id, `N${i}`]));
		const lines = ["graph TD", ...[...nodes].map(([id, kind]) => `  ${ids.get(id)}["${label(id)} (${kind})"]`)];
		let hasEnd = false; let dynamic = 0; let route = 0;
		const routeList: string[] = [];
		const link = (from: string, target: string | undefined, conditional: boolean) => {
			const to = target === undefined ? "FINISH" : ids.get(target);
			if (!to) { warnings.push("An edge refers to a node not declared in this preview."); return; }
			if (target === undefined) hasEnd = true;
			routeList.push(`${label(from)} -> ${target === undefined ? "END" : label(target)}${conditional ? ` (possible) [route ${route + 1}]` : ""}`);
			// Separate conditional route markers avoid the renderer merging opposing
			// forward/retry arrows into an ambiguous single connector.
			if (conditional) {
				const marker = `R${route++}`;
				lines.push(`  ${marker}["possible route ${route}"]`, `  ${ids.get(from)} --> ${marker}`, `  ${marker} --> ${to}`);
			} else lines.push(`  ${ids.get(from)} --> ${to}`);
		};
		for (const call of calls.filter(c => c.method === "edge")) {
			const from = literal(call.args[0]); const target = literal(call.args[1]);
			if (!from || !ids.has(from)) { warnings.push("Computed or unknown edge sources are not shown."); continue; }
			if (target !== undefined) link(from, target, false);
			else if (end(call.args[1])) link(from, undefined, false);
			else {
				const found = extractConditionalTargets(call.statement, new Set(nodes.keys())).get(from);
				for (const to of found?.targets ?? []) link(from, to, true);
				if (found?.usesEnd) link(from, undefined, true);
				if (!found?.analysable || (!found.targets.length && !found.usesEnd)) {
					lines.push(`  D${dynamic}["Dynamic route: unknown"]`, `  ${ids.get(from)} --> D${dynamic++}`);
					routeList.push(`${label(from)} -> UNKNOWN (dynamic)`);
					warnings.push("Dynamic routing is unresolved; no destination has been invented.");
				}
			}
		}
		if (hasEnd) lines.splice(nodes.size + 1, 0, '  FINISH["End of graph"]');
		if (source.includes("args") || body.some(s => s.type === "VariableDeclaration" && (s.declarations as Ast[]).some(d => node(d.init)?.type === "CallExpression" && node(node(d.init)?.callee)?.name !== "graph"))) warnings.push("Arguments and helper definitions are not evaluated.");
		if (routeList.length + dynamic > 96 || lines.length > 350) return empty("Diagram unavailable: expanded routing exceeds the 96-route preview limit.");
		const mermaid = lines.join("\n");
		return {mermaid, lines: ["Declared routes (direction reference):", ...routeList, "", "Preview notes:", ...new Set(warnings)], warnings: [...new Set(warnings)]};
	} catch (error) { return empty(`Diagram unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}

/** A disposable process prevents pathological third-party layout/OOM from freezing or crashing Pi. */
export async function renderWorkflowDiagram(source: string, signal?: AbortSignal, timeoutMs = 2000): Promise<WorkflowDiagram> {
 const preview = previewWorkflowDiagram(source);
 if (!preview.mermaid || signal?.aborted) return preview;
 return new Promise(resolve => {
  const worker = spawn(process.execPath, ["--max-old-space-size=128", fileURLToPath(new URL("./workflow-diagram-renderer.mjs", import.meta.url))], {stdio: ["pipe", "pipe", "pipe"], env: {...process.env, NODE_OPTIONS: ""}});
  let output = ""; let finished = false;
  const finish = (message: {rendered?: string; error?: string}) => {
   if (finished) return;
   finished = true;
   clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.kill("SIGKILL");
   const drawing = message.rendered?.split("\n");
   resolve({...preview, lines: [...(drawing && drawing.length <= 2000 ? drawing : [message.error ?? "Diagram exceeds the row limit."]), "", ...preview.lines]});
  };
  const abort = () => finish({error: "Diagram preview cancelled."});
  const timer = setTimeout(() => finish({error: "Diagram layout timed out; use the route list or Code."}), timeoutMs);
  worker.stdout.on("data", chunk => {
   output += chunk.toString();
   if (output.length > 2_000_000) finish({error: "Diagram output exceeds the preview limit."});
  });
  worker.stderr.resume(); // Bound memory; never print third-party diagnostics into Pi's TUI.
  worker.stdin.on("error", () => {}); // A killed renderer may close stdin before consuming its input.
  worker.once("error", error => finish({error: `Diagram unavailable: ${error.message}`}));
  worker.once("close", () => {
   if (finished) return;
   try { const result = JSON.parse(output); finish(typeof result.rendered === "string" || typeof result.error === "string" ? result : {error: "Invalid diagram output."}); }
   catch { finish({error: "Diagram renderer exited; use the route list or Code."}); }
  });
  worker.stdin.end(preview.mermaid);
  signal?.addEventListener("abort", abort, {once: true});
  if (signal?.aborted) abort();
 });
}
