/**
 * Graph DSL — the builder API exposed inside a graph workflow script.
 *
 * A graph script declares nodes (who does work) and edges (where the result
 * goes next). Coordination lives in the edges: when an implementer reports
 * a blocker, an edge routes back to whoever can resolve it, and that agent
 * sees the blocker in the state it receives. There is no message bus, no
 * dispatcher, and no coordination tools inside the agents — routing plus
 * accumulated state is the whole mechanism.
 *
 * This module is pure: it builds and validates a graph description. It does
 * not spawn agents, touch the filesystem, or execute anything. The executor
 * consumes what `buildGraphFromScript` returns.
 */

/** Terminal target for an edge. Reaching it ends the run. */
export const END: unique symbol = Symbol("END");
export type EndSymbol = typeof END;

/** State accumulated so far, keyed by node id. */
export type GraphState = Record<string, unknown>;

/** Builds a node's prompt from the state available when it runs. */
export type PromptFn = (state: GraphState) => string;

/** A pure synchronous function node — no agent, no LLM, instant execution. */
export type FnNodeFn = (state: GraphState) => string;

/**
 * Builds a command node's shell command from the state available when it
 * runs — the same shape as an agent node's PromptFn.
 */
export type CommandFn = (state: GraphState) => string;

export interface CommandNodeOptions {
	/** Working directory for the command. Defaults to the run's cwd. */
	cwd?: string;
	/** Wall-clock cap in ms. Default 30000, same as acceptance verify commands. */
	timeoutMs?: number;
	/** Extra environment variables merged over the host's. */
	env?: Record<string, string>;
	/**
	 * When true, `result.status` reads "ok" even on a nonzero exit code.
	 * Purely a convenience for a conditional edge that only cares the command
	 * ran, not whether it exited clean (e.g. a best-effort cleanup step). Does
	 * not change routing by itself: a direct edge fires regardless of status
	 * either way, and a conditional edge still sees the real exit code in
	 * `result.data.exitCode`. Default false.
	 */
	allowFailure?: boolean;
}

/**
 * Chooses the next node from the current node's result.
 *
 * Pure by construction: the sandbox exposes nothing with side effects, so a
 * condition can only inspect state and return a target.
 */
export type EdgeConditionFn = (state: GraphState, result: unknown) => string | EndSymbol;

export type ArtifactKind = "plan" | "contract";

export interface HumanNodeOptions {
	/** Presented as a fixed set of choices rather than free text. */
	options?: string[];
	/**
	 * Answer to use when running without a UI. Without this a headless run
	 * would have to either hang or invent an answer; both are worse than an
	 * explicit default the author chose.
	 */
	default?: string;
	/**
	 * Artifacts to preview in the interactive human dialog (e.g. ['plan', 'contract']).
	 * When provided, the dialog renders the latest plan/contract documents
	 * in the preview pane so the reviewer can inspect them before deciding.
	 */
	artifacts?: ArtifactKind[];
}

export interface AgentNodeDef {
	type: "agent";
	agentName: string;
	promptFn: PromptFn;
}

export interface HumanNodeDef {
	type: "human";
	promptFn: PromptFn;
	options?: string[];
	default?: string;
	artifacts?: ArtifactKind[];
}

/**
 * A pure synchronous function node.
 *
 * Runs instantly with no LLM call, no subprocess, no cost. The function
 * receives the current graph state and returns a string that becomes the
 * node's result text — identical in shape to an agent result so downstream
 * prompts and edges work unchanged.
 *
 * Primary use case: a zero-cost hub node for conditional fan-out.
 *
 *   g.node('dispatch', (state) => 'ready');  // fan-out hub
 *   g.edge('gate', (state, result) => plan.get('sprint-plan').ok ? 'dispatch' : 'gate');
 *   g.edge('dispatch', 'scout1');
 *   g.edge('dispatch', 'scout2');
 */
export interface FnNodeDef {
	type: "fn";
	fn: FnNodeFn;
}

/**
 * A declarative shell command node.
 *
 * Two forms, deliberately ranked:
 *
 * 1. **Static (default, preferred):** `command("npm test")` — a literal
 *    string fixed at script-authoring time. A human reviewing the script sees
 *    the exact command that will execute, with nothing else reachable. When a
 *    command needs to vary by state, the preferred pattern is an edge
 *    choosing between fixed command nodes, so every variant stays auditable.
 *
 * 2. **Dynamic:** `command((state) => `pytest ${state.scout.data.file}`)` —
 *    a function receiving the full graph state at execution time, identical
 *    in shape to an agent node's prompt function. For when the command
 *    genuinely cannot be enumerated up front.
 *
 *    No escaping or quoting is applied to interpolated values. The string the
 *    function returns is handed to the shell verbatim — anything an agent
 *    placed in state (including shell metacharacters) is executed as-is. That
 *    risk is the script author's to own; route between fixed commands when
 *    possible.
 *
 * Runs synchronously via the host's shell, same execution shape as an
 * acceptance verify command (see acceptance.ts's runVerifyCommand): bounded
 * by a timeout, output captured, never any LLM cost.
 */
export interface CommandNodeDef {
	type: "command";
	/** Literal string, or a function evaluated against state when it runs. */
	command: string | CommandFn;
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export type NodeDef = AgentNodeDef | HumanNodeDef | FnNodeDef | CommandNodeDef;

export interface GraphNode {
	id: string;
	def: NodeDef;
}

export type Edge =
	| { type: "direct"; from: string; to: string | EndSymbol }
	| { type: "conditional"; from: string; condition: EdgeConditionFn };

/**
 * What a source node's conditional edges can route to, recovered from the
 * script's AST before the sandbox turns those edges into opaque closures.
 *
 * The executor needs this to answer "could an edge still route here?", which
 * is what distinguishes a node that was actually selected from one that merely
 * has nothing left to wait for.
 */
export interface ConditionalTargetInfo {
	targets: string[];
	usesEnd: boolean;
	/** False when a target could not be read statically; claim conservatively. */
	analysable: boolean;
}

export interface BuiltGraph {
	nodes: Map<string, GraphNode>;
	/** Outgoing edges per source node. An array: a node with >1 edge fans out. */
	edges: Map<string, Edge[]>;
	entry: string;
	initialState: GraphState;
	/**
	 * Per source node, what its conditional edges may select.
	 *
	 * Absent when a graph was built directly rather than from a script (tests,
	 * programmatic use). Consumers must treat a missing entry as unanalysable
	 * and claim conservatively rather than assume "no targets".
	 */
	conditionalTargets?: Map<string, ConditionalTargetInfo>;
}

export class GraphDefinitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphDefinitionError";
	}
}

const NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Node ids double as state keys (`state.planner`), so they must be valid
 * identifiers. Rejecting bad ids here produces a clear definition error
 * instead of a confusing failure later in a prompt function.
 */
function assertValidNodeId(id: unknown): asserts id is string {
	if (typeof id !== "string" || id.length === 0) {
		throw new GraphDefinitionError("Node id must be a non-empty string");
	}
	if (!NODE_ID_PATTERN.test(id)) {
		throw new GraphDefinitionError(
			`Invalid node id "${id}": must start with a letter or underscore and contain only letters, digits, and underscores`,
		);
	}
}

function describeTarget(target: string | EndSymbol): string {
	return target === END ? "END" : `"${String(target)}"`;
}

// --- Node constructors, exposed as sandbox globals ---

export function agent(agentName: string, promptFn: PromptFn): AgentNodeDef {
	if (typeof agentName !== "string" || agentName.trim().length === 0) {
		throw new GraphDefinitionError("agent() requires an agent name");
	}
	if (typeof promptFn !== "function") {
		throw new GraphDefinitionError(
			`agent("${agentName}") requires a prompt function: agent("${agentName}", (state) => "...")`,
		);
	}
	return { type: "agent", agentName: agentName.trim(), promptFn };
}

export function human(prompt: string | PromptFn, options: HumanNodeOptions = {}): HumanNodeDef {
	let promptFn: PromptFn;
	if (typeof prompt === "string") {
		const text = prompt;
		if (text.trim().length === 0) {
			throw new GraphDefinitionError("human() requires a non-empty prompt string");
		}
		promptFn = () => text;
	} else if (typeof prompt === "function") {
		promptFn = prompt;
	} else {
		throw new GraphDefinitionError("human() requires a prompt string or function");
	}
	if (options.options !== undefined) {
		if (!Array.isArray(options.options) || options.options.length === 0) {
			throw new GraphDefinitionError("human() options must be a non-empty array of strings");
		}
		if (!options.options.every((o) => typeof o === "string")) {
			throw new GraphDefinitionError("human() options must all be strings");
		}
	}
	if (options.default !== undefined && typeof options.default !== "string") {
		throw new GraphDefinitionError("human() default must be a string");
	}
	if (options.default !== undefined && options.options && !options.options.includes(options.default)) {
		throw new GraphDefinitionError(
			`human() default "${options.default}" is not one of the provided options`,
		);
	}
	if (options.artifacts !== undefined) {
		if (!Array.isArray(options.artifacts)) {
			throw new GraphDefinitionError("human() artifacts must be an array of 'plan' | 'contract'");
		}
		for (const a of options.artifacts) {
			if (a !== "plan" && a !== "contract") {
				throw new GraphDefinitionError(`human() unknown artifact kind "${a}". Expected 'plan' or 'contract'.`);
			}
		}
	}
	return {
		type: "human",
		promptFn,
		options: options.options ? [...options.options] : undefined,
		default: options.default,
		artifacts: options.artifacts ? [...options.artifacts] : undefined,
	};
}

/**
 * Declares a command node: runs a shell command, no LLM involved.
 *
 * Two accepted forms (see CommandNodeDef's doc comment for the ranking):
 *
 *   command("npm test")                        // static — auditable default
 *   command((state) => `pytest ${state.x}`)     // dynamic — built from state
 *
 * The static form must be a string literal and the dynamic form a function —
 * this is enforced structurally here, and by the graph script validator,
 * which rejects any other expression (variable, concatenation, call result,
 * or a template literal containing ${}) at parse time so a script author
 * gets the error immediately rather than a confusing runtime failure.
 * Interpolation of state happens inside the function body, never in the
 * direct argument.
 */
export function command(
	commandSpec: string | CommandFn,
	options: CommandNodeOptions = {},
): CommandNodeDef {
	if (typeof commandSpec === "string") {
		if (commandSpec.trim().length === 0) {
			throw new GraphDefinitionError("command() requires a non-empty command string");
		}
	} else if (typeof commandSpec !== "function") {
		throw new GraphDefinitionError(
			'command() requires a command string or a function (state) => "..."',
		);
	}
	if (options.timeoutMs !== undefined && (typeof options.timeoutMs !== "number" || options.timeoutMs <= 0)) {
		throw new GraphDefinitionError("command() timeoutMs must be a positive number");
	}
	if (options.cwd !== undefined && typeof options.cwd !== "string") {
		throw new GraphDefinitionError("command() cwd must be a string");
	}
	if (options.env !== undefined && (typeof options.env !== "object" || options.env === null || Array.isArray(options.env))) {
		throw new GraphDefinitionError("command() env must be an object");
	}
	return {
		type: "command",
		command: commandSpec,
		cwd: options.cwd,
		timeoutMs: options.timeoutMs,
		env: options.env ? { ...options.env } : undefined,
		allowFailure: options.allowFailure === true,
	};
}

// --- Graph builder ---

export class GraphBuilder {
	private readonly nodes = new Map<string, GraphNode>();
	private readonly edges = new Map<string, Edge[]>();
	private entry: string | null = null;
	private initialState: GraphState = {};
	private started = false;

	node(id: string, def: NodeDef | FnNodeFn): this {
		assertValidNodeId(id);
		if (this.nodes.has(id)) {
			throw new GraphDefinitionError(`Node "${id}" is already defined`);
		}
		// Plain function shorthand: g.node('x', (state) => 'result')
		if (typeof def === "function") {
			this.nodes.set(id, { id, def: { type: "fn", fn: def } });
			if (this.entry === null) this.entry = id;
			return this;
		}
		if (!def || typeof def !== "object" || !("type" in def)) {
			throw new GraphDefinitionError(
			`Node "${id}" must be defined with agent(), human(), command(), or a plain function: (state) => "result"`,
			);
		}
		this.nodes.set(id, { id, def });

		// First node declared is the entry unless start() says otherwise.
		// Saves a redundant start() call in the common linear case.
		if (this.entry === null) this.entry = id;
		return this;
	}

	edge(from: string, target: string | EndSymbol | EdgeConditionFn): this {
		assertValidNodeId(from);

		let edge: Edge;
		if (typeof target === "function") {
			edge = { type: "conditional", from, condition: target };
		} else if (target === END) {
			edge = { type: "direct", from, to: END };
		} else {
			assertValidNodeId(target);
			edge = { type: "direct", from, to: target };
		}

		// Multiple outgoing edges from one node is fan-out, which triggers
		// superstep (parallel) execution. Append rather than reject: a graph
		// with any fan-out node runs via the superstep executor.
		const list = this.edges.get(from);
		if (list) list.push(edge);
		else this.edges.set(from, [edge]);
		return this;
	}

	start(id: string): this {
		assertValidNodeId(id);
		this.entry = id;
		return this;
	}

	/**
	 * Records the initial state and marks the graph ready to run.
	 *
	 * Does not execute: the sandbox only builds a description, and the
	 * executor runs it afterwards with real agent-spawning capability.
	 */
	run(initialState: GraphState = {}): this {
		if (this.started) {
			throw new GraphDefinitionError("run() may only be called once");
		}
		if (initialState !== undefined && initialState !== null) {
			if (typeof initialState !== "object" || Array.isArray(initialState)) {
				throw new GraphDefinitionError("run() initial state must be an object");
			}
		}
		this.started = true;
		this.initialState = { ...(initialState ?? {}) };
		return this;
	}

	wasStarted(): boolean {
		return this.started;
	}

	/** Structural validation. Returns every problem found, not just the first. */
	validate(): string[] {
		const errors: string[] = [];

		if (this.nodes.size === 0) {
			errors.push("Graph has no nodes. Define at least one with g.node(id, agent(...)).");
			return errors;
		}

		if (!this.started) {
			errors.push("Graph was never run. Call g.run({ ... }) at the end of the script.");
		}

		if (this.entry === null) {
			errors.push("Graph has no entry node. Call g.start(nodeId).");
		} else if (!this.nodes.has(this.entry)) {
			errors.push(`Entry node "${this.entry}" is not defined.`);
		}

		for (const [from, edgeList] of this.edges) {
			if (!this.nodes.has(from)) {
				errors.push(`Edge is defined from unknown node "${from}".`);
			}
			for (const edge of edgeList) {
				if (edge.type === "direct" && edge.to !== END && !this.nodes.has(edge.to)) {
					errors.push(`Edge "${from}" -> ${describeTarget(edge.to)} points at an undefined node.`);
				}
			}
		}

		for (const id of this.nodes.keys()) {
			if (!this.edges.has(id)) {
				errors.push(
					`Node "${id}" has no outgoing edge. Every node needs one; use g.edge("${id}", END) to finish there.`,
				);
			}
		}

		// Reachability is checked only when every edge is direct. A single
		// conditional edge makes the reachable set undecidable without running
		// the condition, and guessing would reject valid graphs. The executor's
		// iteration cap is the backstop for a graph that never terminates.
		if (errors.length === 0 && this.entry !== null) {
			const allEdges = [...this.edges.values()].flat();
			const conditionals = allEdges.filter((e) => e.type === "conditional");
			if (conditionals.length === 0) {
				if (!this.canReachEnd(this.entry)) {
					errors.push(
						"No path from the entry node reaches END. The graph would loop forever; add an edge to END.",
					);
				}
				for (const id of this.nodes.keys()) {
					if (!this.isReachable(this.entry, id)) {
						errors.push(`Node "${id}" is unreachable from the entry node "${this.entry}".`);
					}
				}
			}
		}

		return errors;
	}

	private canReachEnd(from: string): boolean {
		const seen = new Set<string>();
		const stack = [from];

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (seen.has(current)) continue;
			seen.add(current);

			const edgeList = this.edges.get(current);
			if (!edgeList) continue;
			for (const edge of edgeList) {
				if (edge.type === "conditional") return true;
				if (edge.to === END) return true;
				stack.push(edge.to as string);
			}
		}

		return false;
	}

	private isReachable(from: string, target: string): boolean {
		if (from === target) return true;

		const seen = new Set<string>();
		const stack = [from];

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (seen.has(current)) continue;
			seen.add(current);

			const edgeList = this.edges.get(current);
			if (!edgeList) continue;
			for (const edge of edgeList) {
				if (edge.type === "conditional") continue;
				if (edge.to === END) continue;
				if (edge.to === target) return true;
				stack.push(edge.to as string);
			}
		}

		return false;
	}

	build(): BuiltGraph {
		const errors = this.validate();
		if (errors.length > 0) {
			throw new GraphDefinitionError(`Invalid graph:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
		}

		// Copy edge arrays so the returned graph cannot be mutated through the
		// builder afterwards.
		const edges = new Map<string, Edge[]>();
		for (const [from, list] of this.edges) edges.set(from, [...list]);

		return {
			nodes: new Map(this.nodes),
			edges,
			entry: this.entry!,
			initialState: { ...this.initialState },
		};
	}

}

/**
 * Creates the graph builder. One graph per script: a second call is a
 * definition error, so the executor never has to guess which graph to run.
 */
export function createGraphFactory(): { graph: () => GraphBuilder; getBuilder: () => GraphBuilder | null } {
	let builder: GraphBuilder | null = null;

	return {
		graph: () => {
			if (builder !== null) {
				throw new GraphDefinitionError("Only one graph() per script is allowed");
			}
			builder = new GraphBuilder();
			return builder;
		},
		getBuilder: () => builder,
	};
}
