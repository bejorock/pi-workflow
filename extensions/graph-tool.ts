/**
 * The `workflow` tool — graph-based multi-agent coordination.
 *
 * Execution stays background-owned, but every call attaches a foreground
 * controller until completion or supervisor attention. The caller answers via
 * workflow_reply and reattaches with workflow_wait. Interrupting either waiter
 * stops the underlying run; reports/questions have a single delivery owner.
 */

import { WorkflowController } from "./workflow-controller.ts";
import { WorkflowManager as ControllerManager } from "./workflow-manager.ts";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildAgentCatalogSummary } from "./agent-catalog.ts";
import { discoverAgents } from "./agents.ts";
import {
	DEFAULT_MAX_ITERATIONS,
	type GraphRunResult,
	type NodeExecution,
} from "./graph-executor.ts";
import {
	graphScriptHash,
	loadGraphSuperstepResumeState,
} from "./graph-journal.ts";
import type { SuperstepResumeInput } from "./graph-executor.ts";
import { createNodeRunner } from "./graph-node-runner.ts";
import { buildGraphFromScript, GraphValidationError } from "./graph-validator.ts";
import { GraphDisplayBridge } from "./graph-display-bridge.ts";
import type { GraphRunContext } from "./graph-run-context.ts";
import { executeGraphRun, type GraphRunReport } from "./graph-run.ts";
import { loadSavedWorkflowScript } from "./workflow-library.ts";
import type { WorkflowManager } from "./workflow-manager.ts";
import type { RequestBroker } from "./request-broker.ts";
import type { ForkContextOptions } from "./types.ts";
import { runSingleAgent } from "./execution.ts";
import {
	planCreate, planGet, planList, planEdit, planDelete,
	type PlanMeta,
} from "./plan-tool.ts";
import {
	contractCreate, contractGet, contractList, contractEdit,
	contractPropose, contractSupersede,
	type ContractMeta,
} from "./contract-tool.ts";

// ── Sandbox factory helpers ──────────────────────────────────────────────

/**
 * Returns a plain synchronous `plan` object bound to `cwd`, suitable for
 * injection into a graph script sandbox. All functions are synchronous
 * (they use fs.*Sync internally) so they work inside edge conditions and
 * prompt functions without any await.
 */
function makePlanSandbox(cwd: string) {
	return {
		/** Create a new plan. Returns { ok, id?, message } */
		create: (name: string, content: string) => planCreate(cwd, name, content),
		/** Read a plan by id. Returns { ok, id?, content?, message } — ok:false if not found, never throws. */
		get: (id: string) => planGet(cwd, id),
		/** List all plans. Returns { ok, plans?, message } */
		list: () => planList(cwd),
		/** Precision find-and-replace inside a draft plan. */
		edit: (id: string, oldText: string, newText: string) => planEdit(cwd, id, oldText, newText),
		/** Delete a plan by id. */
		delete: (id: string) => planDelete(cwd, id),
	};
}

/**
 * Returns a plain synchronous `contract` object bound to `cwd`, suitable
 * for injection into a graph script sandbox.
 */
function makeContractSandbox(cwd: string) {
	return {
		/** Create a new draft contract. Returns { ok, id?, message } */
		create: (params: Parameters<typeof contractCreate>[1]) => contractCreate(cwd, params),
		/** Read a contract by id. Returns { ok, id?, content?, message } — ok:false if not found, never throws. */
		get: (id: string) => contractGet(cwd, id),
		/** List all contracts. Returns { ok, contracts?, message } */
		list: () => contractList(cwd),
		/** Precision find-and-replace inside a draft contract. */
		edit: (id: string, oldText: string, newText: string) => contractEdit(cwd, id, oldText, newText),
		/** Move a draft contract to proposed. */
		propose: (id: string) => contractPropose(cwd, id),
		/** Supersede a proposed contract with a new draft. */
		supersede: (oldId: string, params: Parameters<typeof contractSupersede>[2]) => contractSupersede(cwd, oldId, params),
	};
}

const GraphToolParams = Type.Object({
	script: Type.Optional(
		Type.String({
			description:
				"Graph workflow script. Must begin with `export const meta = { name, description }`. " +
			"Create a graph with graph(), define nodes with g.node(id, agent(name, promptFn) | human(prompt, opts) | command(cmdString | (state) => cmd, opts) | (state) => result), " +
				"route with g.edge(from, to | (state, result) => target), and start it with g.run({ ... }). " +
				"Required unless loadWorkflow names a saved graph.",
		}),
	),
	args: Type.Optional(
		Type.Any({
			description:
				"Values available to the script as `args`. Must be a JSON object of key/value pairs " +
				"(e.g. args: { caseId: \"8907\" }). Not a JSON string, number, boolean, array, or null.",
		}),
	),
	maxIterations: Type.Optional(
		Type.Number({
			description: `Cap before the run stops. Default ${DEFAULT_MAX_ITERATIONS}. Counts node executions in a linear graph, and rounds (parallel waves) in a graph with fan-out. Raise it for graphs with legitimate long loops.`,
		}),
	),
	tokenBudget: Type.Optional(
		Type.Number({
			description:
				"Soft token budget. Warnings are reported at 80% and when exceeded; the run is never killed.",
		}),
	),
	useWorktree: Type.Optional(
		Type.Boolean({
			description:
				"Run agents inside an isolated git worktree so the project tree is untouched until you review the result. Default false.",
		}),
	),
	resumeRunId: Type.Optional(
		Type.String({
			description:
				"Resume a previous run, skipping nodes that already completed. Requires an unchanged script.",
		}),
	),
	loadWorkflow: Type.Optional(
		Type.String({
			description:
				"Run a previously saved graph by name instead of passing `script`. See /saved-workflows for what exists.",
		}),
	),
	saveWorkflow: Type.Optional(
		Type.Boolean({
			description:
				"Persist this graph under meta.name after a successful run so it can be re-run later with loadWorkflow. Default false.",
		}),
	),
	allowConcurrentDuplicate: Type.Optional(
		Type.Boolean({
			description:
				"Legacy parameter retained for compatibility; cannot bypass the mandatory one-active-workflow limit.",
		}),
	),
});

export interface GraphToolOptions {
	/** Overrides ctx.cwd. Primarily for tests. */
	cwd?: string;
	/** Injected so tests can run graphs without spawning processes. */
	spawnAgent?: typeof runSingleAgent;
	/**
	 * Feeds run progress to /workflows, the task panel, and workflow_status.
	 * Optional so the tool stays usable headless and in tests.
	 */
	workflowManager?: WorkflowManager;
	onRunStart?: (info: { runId: string; name: string; nodeIds: string[] }) => void;
	onNodeStart?: (info: { step: number; nodeId: string; nodeType: string }) => void;
	onNodeComplete?: (execution: NodeExecution) => void;
	onRunComplete?: (result: GraphRunResult) => void;
	/**
	 * Called with the detached run's promise.
	 *
	 * Execution remains independent of the waiting tool so supervisor attention
	 * can yield early. Tests use this handle to observe final engine settlement.
	 */
	onRunDetached?: (info: { runId: string; done: Promise<GraphRunReport | undefined> }) => void;
	/** The broker for judgement requests from child processes. */
	broker?: RequestBroker;
	controller?: WorkflowController;
}

export function createGraphWorkflowTool(options: GraphToolOptions = {}): ToolDefinition {
	const spawnAgent = options.spawnAgent ?? runSingleAgent;
	const manager = options.workflowManager ?? new ControllerManager();
	const controller = options.controller ?? new WorkflowController(manager, options.broker);

	return defineTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Run a graph of coordinating agents. Nodes are agents; edges decide where each result goes next.",
			"Agents coordinate through routing and shared state: when one reports it is blocked, an edge can send the work back to whoever can resolve it, and that agent sees the blocker in the state it receives.",
			"Use it for multi-step work where the path is not known in advance. For a single delegation, use the subagent tool instead.",
		].join(" "),
		promptSnippet:
			"Run a coordinating graph of agents. Required header: export const meta = { name, description }. Nodes are agent()/human(); edges are direct or (state, result) => target.",
		promptGuidelines: [
			"Workflow automatically waits for completion or supervisor questions. Only one active workflow is allowed, including paused/waiting runs. On supervisor attention answer every request with workflow_reply, then immediately call workflow_wait with the runId. Interrupting workflow or workflow_wait stops the run.",
			"For workflow, write the script as one raw JavaScript string with no Markdown fences or surrounding prose.",
			"For workflow, the first statement must be `export const meta = { name: 'short_snake_case', description: 'what this graph does' }`.",
			"For workflow, available globals are graph, agent, human, END, args, and JSON. There is no fs, process, require, import, fetch, Date, or Math.random — a graph describes routing only.",
			"For workflow, define every node before routing it and make sure some path reaches END. A node normally has one outgoing edge; give it several to fan out and run those branches in parallel.",
			"For workflow, parallel branches run concurrently in rounds. A node with several incoming edges waits for ALL of them before running, so it never sees partial work. Each branch's result lands under its own node id, so give branches distinct ids rather than writing shared state keys.",
			"For workflow, a node's prompt function receives the accumulated state, where each previous node's result is stored under its node id: agent('green', (s) => `Implement:\\n${s.architect}`).",
			"For workflow, use a conditional edge when the next step depends on what an agent produced: g.edge('green', (state, result) => result.status === 'blocked' ? 'architect' : 'reviewer').",
			"For workflow, agent results carry { status, text, blockedOn, reason } — status is 'blocked' when the agent escalated. Interpolating a result into a prompt yields its text.",
			"For workflow, prefer routing a blocked agent back to whoever owns the problem (contract issues to the designer, test issues to whoever wrote them) rather than retrying the same node.",
			"For workflow, cycles are allowed and are how escalation works; the run stops at maxIterations if a loop never resolves.",
			"For workflow, use human(prompt, { options, default }) to ask the user. Keep the expanded prompt <=240 characters and each option <=60 characters (ideally 1–5 words); put long context in plans/contracts via artifacts, not the prompt. Always give human() a default so a headless run cannot hang.",
		],
		parameters: GraphToolParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = options.cwd ?? ctx.cwd;

			// args is the only unstructured parameter (Type.Any), and a model
			// can silently send a JSON string, a number, a boolean, an array,
			// or null. Each of those builds a graph whose prompts read
			// `args.x` as undefined with no error anywhere — e.g. the observed
			// "case undefined" failure. Fail fast here with an actionable
			// message instead.
			//
			// One shape gets a recovery instead of a rejection: a string that
			// decodes to a plain object. Every live reproduction attempted
			// against real model backends sent a genuine object — this branch
			// exists for corruption between validation and here that isn't the
			// model's tool call, e.g. another extension's `tool_call` hook
			// mutating `event.input` in place (pi's contract explicitly allows
			// this and skips re-validation after it). A JSON-encoded object is
			// losslessly recoverable, unlike the other rejected shapes, so this
			// is a targeted decode, not a general leniency — numbers, booleans,
			// null, arrays, and non-object or invalid-JSON strings still fail
			// exactly as before.
			let argsWasDecodedFromString = false;
			if (typeof params.args === "string") {
				let decoded: unknown;
				try {
					decoded = JSON.parse(params.args);
				} catch {
					throw new Error(
						`workflow args must be an object of key/value pairs (e.g. args: { caseId: "8907" }), but received a string that is not valid JSON. ` +
							`Pass the values as an object literal — not a JSON string, number, boolean, array, or null.`,
					);
				}
				if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
					const decodedAs = decoded === null ? "null" : Array.isArray(decoded) ? "an array" : `a ${typeof decoded}`;
					throw new Error(
						`workflow args must be an object of key/value pairs (e.g. args: { caseId: "8907" }), but received a JSON string that decodes to ${decodedAs}. ` +
							`Pass the values as an object literal — not a JSON string, number, boolean, array, or null.`,
					);
				}
				params.args = decoded as Record<string, unknown>;
				argsWasDecodedFromString = true;
			}

			if (params.args !== undefined) {
				const received =
					params.args === null
						? "null"
						: Array.isArray(params.args)
							? "an array"
							: `a ${typeof params.args}`;
				if (typeof params.args !== "object" || params.args === null || Array.isArray(params.args)) {
					throw new Error(
						`workflow args must be an object of key/value pairs (e.g. args: { caseId: "8907" }), but received ${received}. ` +
							`Pass the values as an object literal — not a JSON string, number, boolean, array, or null.`,
					);
				}
			}

			let script: string;
			if (params.loadWorkflow) {
				const saved = loadSavedWorkflowScript(cwd, params.loadWorkflow);
				if (!saved) {
					throw new Error(
						`No saved workflow named "${params.loadWorkflow}". Use /saved-workflows to see what exists, or pass a script.`,
					);
				}
				script = saved;
			} else if (params.script) {
				script = params.script;
			} else {
				throw new Error("workflow requires either `script` or `loadWorkflow`.");
			}

			const scriptHash = graphScriptHash(script);

			// Validate first: a bad script must cost nothing.
			let built: ReturnType<typeof buildGraphFromScript>;
			try {
				built = buildGraphFromScript(script, {
					args: params.args,
					sandboxExtras: {
						plan: makePlanSandbox(cwd),
						contract: makeContractSandbox(cwd),
					},
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const roster =
					error instanceof GraphValidationError
						? `\n\n${buildAgentCatalogSummary(discoverAgents(cwd, "both").agents)}`
						: "";
				// Throw rather than returning isError: the agent loop derives a
				// tool result's error status from whether execute() threw and
				// ignores a returned isError field, so returning one would report
				// this failure to the model as a success containing error text.
				throw new Error(`Graph was not run.\n\n${message}${roster}`);
			}

			const { meta, graph } = built;
			const nodeIds = [...graph.nodes.keys()];

			// Check the roster before detaching. Once the run is in the background
			// its failures are reported in a message rather than by failing this
			// call, and a misspelled agent name is exactly the kind of mistake the
			// model should be told about immediately, while it can still fix it.
			{
				const named = new Set<string>();
				for (const node of graph.nodes.values()) {
					if (node.def.type === "agent") named.add(node.def.agentName);
				}
				if (named.size > 0) {
					const roster = discoverAgents(cwd, "both").agents;
					const known = new Set(roster.map((a) => a.name));
					const unknown = [...named].filter((name) => !known.has(name)).sort();
					if (unknown.length > 0) {
						const available = roster.map((a) => a.name).sort().join(", ") || "(none)";
						const subject =
							unknown.length === 1
								? `Unknown agent "${unknown[0]}"`
								: `Unknown agents ${unknown.map((n) => `"${n}"`).join(", ")}`;
						throw new Error(
							`Graph was not run.\n\n${subject}. Available agents: ${available}.`,
						);
					}
				}
			}
			const runId = params.resumeRunId ?? `graph-${Date.now()}`;
			const journalDir = `${cwd}/.pi-workflow/runs`;

			// Resolve resume before doing any work, so a stale resume fails fast.
			const alreadyComplete = {
				content: [
					{
						type: "text" as const,
						text: `Run "${params.resumeRunId}" already completed; there is nothing to resume.`,
					},
				],
				details: { resumed: false, alreadyComplete: true },
			};

			let superstepResume: SuperstepResumeInput | undefined;

			if (params.resumeRunId) {
				// Superstep resume is round-atomic: it continues from the frontier
				// snapshotted at the last completed barrier.
				const resumeState = loadGraphSuperstepResumeState({
					journalDir,
					runId: params.resumeRunId,
					scriptHash,
				});

				if (!resumeState.isValid) {
					throw new Error(`Cannot resume: ${resumeState.invalidReason}`);
				}
				if (resumeState.frontier.length === 0) return alreadyComplete;

				superstepResume = {
					state: resumeState.state,
					resumeFromFrontier: resumeState.frontier,
					remainingInDegree: resumeState.remainingInDegree,
					remainingClaimsBySource: resumeState.remainingClaimsBySource,
					completedRounds: resumeState.completedRounds,
					completedNodeExecutions: resumeState.completedNodeExecutions,
					executedNodeIds: resumeState.executedNodeIds,
				};
			}

			// Point the manager at this run's journal directory so
			// workflow_status and /workflows can look up completed runs by
			// runId even after this process exits (each call may use a
			// different cwd, so this is set per-run rather than once at
			// extension init — see workflow-manager.ts's setJournalDir()).
			options.workflowManager?.setJournalDir(journalDir);

			// Refuse before spawning anything. Both guards report what is already
			// running so the model can decide whether to wait or stop something,
			// rather than being told only that it may not proceed.
			if (options.workflowManager && !params.resumeRunId) {
				const permitted = options.workflowManager.checkCanStart(meta.name, {
					allowDuplicateName: params.allowConcurrentDuplicate,
				});
				if (!permitted.ok) throw new Error(permitted.reason);
			}

			// The run outlives this tool call, so it cannot use the call's signal:
			// that aborts the moment execute() returns. It gets its own controller,
			// which /workflows and stopRun() reach through the manager.
			if (signal?.aborted) throw new Error("Workflow interrupted before start.");
			const runAbort = new AbortController();
			controller.begin(runId, meta.name, runAbort);

			const display = options.workflowManager
				? new GraphDisplayBridge({
						manager: options.workflowManager,
						runId,
						name: meta.name,
						description: meta.description,
						script,
						cwd,
						abortController: runAbort,
					})
				: undefined;

			const managed = options.workflowManager?.getRun(runId);
			if (managed) {
				managed.cwd = cwd;
				const directEdges = [...graph.edges.values()].flat().flatMap(e =>
					e.type === "direct" ? [{ from: e.from, to: typeof e.to === "string" ? e.to : "END" }] : []);
				managed.dashboardGraph = {
					nodes: [
						...[...graph.nodes.values()].map(n => ({ id: n.id, label: n.id, nodeType: n.def.type })),
						...(directEdges.some(e => e.to === "END") ? [{ id: "END", label: "END", nodeType: "end" }] : []),
					],
					edges: directEdges,
				};
			}

			options.onRunStart?.({ runId, name: meta.name, nodeIds });

			const forkContext: ForkContextOptions | undefined = ctx.model
				? {
						sessionManager: ctx.sessionManager,
						modelRegistry: ctx.modelRegistry,
						fallbackModel: ctx.model,
					}
				: undefined;

			// Built per-run rather than once: the runner needs the run context's
			// cwd, which is the worktree path when the run is isolated.
			const makeRunNode = (context: GraphRunContext) =>
				createNodeRunner({
					cwd: context.cwd,
					runId,
					signal: runAbort.signal,
					forkContext,
					parentSessionId:
						ctx.sessionManager?.getSessionId() ?? process.env.PI_SUBAGENT_PARENT_SESSION,
					artifactsDir: context.artifactsDir,
					artifactConfig: context.artifactConfig,
					extraEnv: context.extraEnv,
					spawnAgent: spawnAgent as never,
					broker: options.broker,
					nodeStateBuffers: context.nodeStateBuffers,
				});

			// Start the independently owned engine, then attach the mandatory waiter.
			const done = executeGraphRun({
				runId,
				cwd,
				script,
				scriptHash,
				meta,
				graph,
				journalDir,
				signal: runAbort.signal,
				maxIterations: params.maxIterations,
				tokenBudget: params.tokenBudget,
				useWorktree: params.useWorktree,
				saveWorkflow: params.saveWorkflow,
				resume: superstepResume,
				makeRunNode,
				display,
				broker: options.broker,
				onNodeStart: options.onNodeStart,
				onNodeComplete: options.onNodeComplete,
				onRunComplete: options.onRunComplete,
			})
				.then((report) => {
					// Store completion before manager events; the controller exclusively
					// owns model delivery while widgets/toasts observe normal events.
					controller.complete(report);
					display?.runCompleted(report.result);
					return report;
				})
				.catch((error: unknown) => {
					// A detached run has no tool call left to fail, so a crash has to
					// be reported through the manager or it vanishes silently.
					const message = error instanceof Error ? error.message : String(error);
					controller.complete({ runId, name: meta.name, text: `Workflow ${meta.name} (${runId}) failed: ${message}` });
					display?.runFailed(message);
					return undefined;
				});

			// Never let the detached promise reject unhandled: that crashes the
			// whole pi process, taking the user's session with it.
			void done.catch(() => {});
			controller.setDone(runId, done);
			options.onRunDetached?.({ runId, done });

			// The decode path recovers a losslessly-recoverable shape, but a
			// well-formed tool call should never need it — surface it rather
			// than let it stay silent, in case it's a symptom of something
			// upstream (e.g. another extension's tool_call hook) mutating
			// args between validation and here.
			if (argsWasDecodedFromString) {
				console.warn(
					`[pi-workflow] workflow tool received args as a JSON string for "${meta.name}" (runId: ${runId}) and decoded it. ` +
						"This should not normally happen — args should already be an object by the time a tool call reaches execute(). " +
						"If this keeps happening, something between the model and this tool is stringifying object arguments.",
				);
			}

			const controlled = await controller.wait(runId, signal);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							controlled.text,
							argsWasDecodedFromString
								? "  note: args arrived as a JSON string, not an object, and was decoded. This should not normally happen — pass args as an object literal."
								: undefined,
							`  runId: ${runId}`,
							`  nodes: ${nodeIds.join(" -> ")}`,

						]
							.filter((line): line is string => line !== undefined)
							.join("\n"),
					},
				],
				details: {
					runId,
					name: meta.name,
					background: false,
					status: controlled.status,
					requestIds: controlled.requestIds,
					nodeIds,
					resumed: Boolean(params.resumeRunId),
					argsWasDecodedFromString,
				},
			};
		},
	});
}
