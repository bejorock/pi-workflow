/**
 * Shared WorkflowManager for tracking active and persisted workflow runs.
 * Emits events for TUI display and `/workflows` navigation.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowSnapshot, WorkflowAgentSnapshot, AgentHistoryEntry } from "./workflow-display-types.ts";
import type { WorkflowMeta } from "./workflow-display-types.ts";

export type RunStatus = "running" | "paused" | "completed" | "error" | "stopped";

/**
 * Cap on runs executing at once.
 *
 * Runs are background-only, so nothing stops the model from starting several.
 * Each one spawns child processes and spends tokens against its own budget,
 * and each competes for the single modal dialog when a node asks the user
 * something. Three is high enough that legitimate concurrent work is not
 * obstructed and low enough that a runaway loop is caught early.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export interface ManagedRun {
	runId: string;
	status: RunStatus;
	snapshot: WorkflowSnapshot;
	startedAt: number;
	updatedAt: number;
	journalDir?: string;
	abortController?: AbortController;
	/**
	 * The raw workflow script source and cwd it ran in, kept in-memory only
	 * (never persisted to the journal) so the /workflows TUI navigator can
	 * offer "save this workflow for reuse" without the caller having to
	 * re-supply the script. Only available for runs still tracked in this
	 * process (i.e. not runs restored from a journal after a restart).
	 */
	script?: string;
	cwd?: string;
	/** Declarative display data only; never serialized executable graph closures. */
	dashboardGraph?: {
		nodes: { id: string; label: string; nodeType: string }[];
		edges: { from: string; to: string }[];
	};
}

export interface PersistedRun {
	runId: string;
	workflowName: string;
	status: RunStatus;
	agents: WorkflowAgentSnapshot[];
	totalTokens: number;
	durationMs: number;
	updatedAt: number;
}

export class WorkflowManager extends EventEmitter {
	private runs = new Map<string, ManagedRun>();
	private journalDir?: string;
	private transcriptWatchers = new Map<string, () => void>();
	private sessionWatchers = new Map<string, () => void>();
	private maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS;

	constructor(journalDir?: string) {
		super();
		this.journalDir = journalDir;
	}

	setJournalDir(dir: string): void {
		this.journalDir = dir;
	}

	getJournalDir(): string | undefined {
		return this.journalDir;
	}

	registerRun(
		runId: string,
		meta: WorkflowMeta,
		abortController?: AbortController,
		source?: { script?: string; cwd?: string },
	): ManagedRun {
		const run: ManagedRun = {
			runId,
			status: "running",
			snapshot: {
				meta,
				status: "running",
				phases: (meta.phases || []).map((p, idx) => ({
					title: p.title,
					index: idx,
					status: "pending",
					agents: [],
				})),
				agents: [],
				totalAgents: 0,
				totalTokens: 0,
				durationMs: 0,
				logs: [],
			},
			startedAt: Date.now(),
			updatedAt: Date.now(),
			journalDir: this.journalDir,
			abortController,
			script: source?.script,
			cwd: source?.cwd,
		};

		this.runs.set(runId, run);
		this.emit("agentStart", { runId });
		return run;
	}

	/**
	 * Get the raw script + cwd a run executed with, if this process still has
	 * it in memory (see ManagedRun.script). Returns undefined for runs that
	 * only exist as persisted journal entries (script text isn't journaled,
	 * only a hash — see journal-types.ts).
	 */
	getRunSource(runId: string): { script: string; cwd: string } | undefined {
		const run = this.runs.get(runId);
		if (!run?.script || !run.cwd) return undefined;
		return { script: run.script, cwd: run.cwd };
	}

	getRun(runId: string): ManagedRun | undefined {
		return this.runs.get(runId);
	}

	updateSnapshot(runId: string, updater: (snapshot: WorkflowSnapshot) => void): void {
		const run = this.runs.get(runId);
		if (!run) return;
		updater(run.snapshot);
		run.updatedAt = Date.now();
		this.emit("agentStart", { runId });
	}

	markAgentStart(runId: string, phaseIndex: number, agent: WorkflowAgentSnapshot): void {
		const run = this.runs.get(runId);
		if (!run) return;

		if (!agent.phase && run.snapshot.phases[phaseIndex]) {
			agent.phase = run.snapshot.phases[phaseIndex].title;
		}

		run.snapshot.agents.push(agent);
		run.snapshot.totalAgents++;
		if (run.snapshot.phases[phaseIndex]) {
			run.snapshot.phases[phaseIndex].agents.push(agent);
			if (run.snapshot.phases[phaseIndex].status === "pending") {
				run.snapshot.phases[phaseIndex].status = "active";
			}
		}
		run.updatedAt = Date.now();
		this.emit("agentStart", { runId, agentId: agent.id });

		if (agent.transcriptPath) {
			this.watchTranscript(runId, agent.id, agent.transcriptPath);
		}
	}

	markAgentEnd(runId: string, agentId: number, status: "done" | "error" | "skipped", result?: unknown, error?: string, tokens?: number, durationMs?: number): void {
		const key = `${runId}:${agentId}`;
		const stopWatcher = this.transcriptWatchers.get(key);
		if (stopWatcher) {
			stopWatcher();
			this.transcriptWatchers.delete(key);
		}
		const stopSession = this.sessionWatchers.get(key);
		if (stopSession) {
			stopSession();
			this.sessionWatchers.delete(key);
		}

		const run = this.runs.get(runId);
		if (!run) return;

		const agent = run.snapshot.agents.find((a) => a.id === agentId);
		if (agent) {
			agent.status = status;
			if (result !== undefined) {
				agent.result = result;
				agent.resultPreview = preview(result);
			}
			if (error !== undefined) agent.error = error;
			if (tokens !== undefined) {
				agent.outputTokens = tokens;
				run.snapshot.totalTokens += tokens;
			}
			if (durationMs !== undefined) agent.durationMs = durationMs;
		}

		run.updatedAt = Date.now();
		this.emit("agentEnd", { runId, agentId, status });
	}

	recordAgentHistory(runId: string, agentId: number, entry: AgentHistoryEntry): void {
		const run = this.runs.get(runId);
		if (!run) return;

		const agent = run.snapshot.agents.find((a) => a.id === agentId);
		if (agent) {
			if (!agent.history) agent.history = [];
			agent.history.push(entry);
			run.updatedAt = Date.now();
			this.emit("agentHistory", { runId, agentId, history: agent.history });
		}
	}

	/** Update a single field on an agent snapshot (e.g. model from session). */
	updateAgentField<K extends keyof WorkflowAgentSnapshot>(runId: string, agentId: number, field: K, value: WorkflowAgentSnapshot[K]): void {
		const run = this.runs.get(runId);
		if (!run) return;
		const agent = run.snapshot.agents.find((a) => a.id === agentId);
		if (agent) {
			agent[field] = value;
			run.updatedAt = Date.now();
		}
	}

	/**
	 * Watches an agent node's persisted pi session JSONL and replays its
	 * conversation into that agent's history so the /workflows navigator can
	 * show what each agent actually did — not just its final result.
	 *
	 * The session JSONL is pi's native format (message records with a content
	 * array of text/thinking/toolUse/toolResult blocks), so it is parsed
	 * differently from a child-transcript log.
	 */
	watchSession(runId: string, agentId: number, sessionFile: string): void {
		const run = this.runs.get(runId);
		if (!run) return;

		const agent = run.snapshot.agents.find((a) => a.id === agentId);
		if (!agent) return;

		// A node that is re-run (escalation revisit) reuses the same session
		// file, so stop the prior watcher before starting a new one to avoid
		// double-counting history entries.
		const key = `${runId}:${agentId}`;
		if (this.sessionWatchers.has(key)) this.sessionWatchers.get(key)!();
		this.sessionWatchers.delete(key);

		agent.sessionId = sessionFile;

		let byteOffset = 0;
		const stopped = { value: false };

		const parseSessionRecord = (rec: { type: string; [k: string]: unknown }): AgentHistoryEntry[] => {
			const entries: AgentHistoryEntry[] = [];

			// Extract model from model_change records so the TUI can show
			// which LLM this agent is using.
			if (rec.type === "model_change") {
				const modelId = rec.modelId as string | undefined;
				const provider = rec.provider as string | undefined;
				if (modelId) {
					const label = provider ? `${provider}/${modelId}` : modelId;
					this.updateAgentField(runId, agentId, "model", label);
				}
				return entries;
			}

			if (rec.type !== "message") return entries;
			const msg = rec.message as
				| { role?: string; content?: unknown; timestamp?: number; toolName?: string; toolCallId?: string; isError?: boolean }
				| undefined;
			if (!msg || !msg.role) return entries;
			const ts = typeof rec.timestamp === "number" ? rec.timestamp : msg.timestamp;
			const content = Array.isArray(msg.content) ? msg.content : [];

			// Pi session format: tool results are whole messages with
			// role="toolResult", toolName, isError, and content blocks of
			// type "text".  Handle them at the message level, not inside
			// the block loop.
			if (msg.role === "toolResult") {
				const parts: string[] = [];
				for (const block of content) {
					if (typeof block !== "object" || block === null) continue;
					const b = block as { type?: string; text?: unknown };
					if (b.type === "text") {
						const raw = b.text;
						const text = typeof raw === "string" ? raw : String(raw ?? "");
						if (text) parts.push(text);
					}
				}
				entries.push({
					role: "toolResult",
					toolName: msg.toolName ?? "tool",
					text: parts.join("\n") || "(no output)",
					isError: msg.isError ?? false,
					timestamp: ts,
				});
				return entries;
			}

			for (const block of content) {
				if (typeof block !== "object" || block === null) continue;
				const b = block as {
					type?: string;
					text?: unknown;
					thinking?: string;
					name?: string;
					arguments?: string | object;
					input?: string | object;
					error?: boolean;
				};
				if (b.type === "text") {
					const raw = b.text;
					const text =
						typeof raw === "string"
							? raw
							: Array.isArray(raw)
								? raw.map((t) => String(t)).join("")
								: String(raw ?? "");
					if (!text.trim()) continue;
					if (msg.role === "assistant") {
						entries.push({ role: "assistant", text, timestamp: ts });
					} else {
						entries.push({ role: "user", text, timestamp: ts });
					}
				} else if (b.type === "thinking") {
					const text = typeof b.thinking === "string" ? b.thinking : String(b.thinking ?? "");
					if (text.trim()) entries.push({ role: "assistant", kind: "thinking", text, timestamp: ts });
				} else if (b.type === "toolCall" || b.type === "toolUse") {
					// Pi session format uses "toolCall" with {name, arguments}.
					// Also accept legacy "toolUse" with {name, input}.
					const toolName = b.name ?? "tool";
					const rawArgs = b.arguments ?? b.input;
					let args = "";
					if (typeof rawArgs === "string") args = rawArgs;
					else if (rawArgs !== undefined && rawArgs !== null) {
						try {
							args = JSON.stringify(rawArgs);
						} catch {
							args = String(rawArgs);
						}
					}
					entries.push({
						role: "assistant",
						kind: "toolCall",
						toolName,
						text: `${toolName}(${args.slice(0, 200)})`,
						args,
						timestamp: ts,
					});
				}
			}
			return entries;
		};

		const readNewLines = () => {
			if (stopped.value) return;
			try {
				if (!fs.existsSync(sessionFile)) return;
				const stat = fs.statSync(sessionFile);
				if (stat.size <= byteOffset) return;
				const fd = fs.openSync(sessionFile, "r");
				const length = stat.size - byteOffset;
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, byteOffset);
				fs.closeSync(fd);
				byteOffset = stat.size;
				const content = buffer.toString("utf-8");
				for (const line of content.split("\n")) {
					if (!line.trim()) continue;
					try {
						const rec = JSON.parse(line);
						for (const entry of parseSessionRecord(rec)) {
							this.recordAgentHistory(runId, agentId, entry);
						}
					} catch {
						// Partial final line or non-message record; skip.
					}
				}
			} catch {
				// Best-effort: a missing or unreadable session file leaves the
				// agent's history empty, which is strictly better than crashing
				// the display.
			}
		};

		const timer = setInterval(readNewLines, 200);
		this.sessionWatchers.set(key, () => {
			stopped.value = true;
			clearInterval(timer);
			readNewLines();
		});
		readNewLines(); // initial read
	}

	private watchTranscript(runId: string, agentId: number, transcriptPath: string): void {
		const key = `${runId}:${agentId}`;
		if (this.transcriptWatchers.has(key)) return;

		let byteOffset = 0;
		let lineBuffer = "";
		let stopped = false;

		const readNewLines = () => {
			if (stopped) return;
			try {
				if (!fs.existsSync(transcriptPath)) return;
				const stat = fs.statSync(transcriptPath);
				if (stat.size <= byteOffset) return;

				const fd = fs.openSync(transcriptPath, "r");
				const length = stat.size - byteOffset;
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, byteOffset);
				fs.closeSync(fd);

				byteOffset = stat.size;
				const content = lineBuffer + buffer.toString("utf-8");
				const lines = content.split("\n");
				lineBuffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const rec = JSON.parse(line);
						if (rec.recordType === "tool_start" && rec.toolName) {
							const argsPreview = rec.argsPreview || "";
							this.recordAgentHistory(runId, agentId, {
								role: "assistant",
								kind: "toolCall",
								toolName: rec.toolName,
								args: argsPreview,
								text: argsPreview ? `${rec.toolName}(${argsPreview})` : rec.toolName,
								timestamp: rec.ts,
							});
						} else if (rec.recordType === "message" && rec.role === "assistant" && typeof rec.text === "string" && rec.text.trim()) {
							this.recordAgentHistory(runId, agentId, {
								role: "assistant",
								kind: "text",
								text: rec.text,
								timestamp: rec.ts,
							});
						} else if (rec.recordType === "message" && rec.role === "toolResult") {
							this.recordAgentHistory(runId, agentId, {
								role: "toolResult",
								toolName: rec.toolName || "tool",
								text: rec.text || "(no output)",
								isError: rec.isError,
								timestamp: rec.ts,
							});
						}
					} catch {
						// Invalid JSON line, skip
					}
				}
			} catch {
				// Best-effort file read
			}
		};

		// Poll every 200ms
		const timer = setInterval(readNewLines, 200);
		timer.unref?.();

		// Also watch for immediate filesystem change events if supported
		let watcher: fs.FSWatcher | undefined;
		try {
			watcher = fs.watch(path.dirname(transcriptPath), (eventType, filename) => {
				if (filename && transcriptPath.endsWith(filename)) {
					readNewLines();
				}
			});
		} catch {
			// Watcher fallback to polling only
		}

		const stop = () => {
			clearInterval(timer);
			try {
				watcher?.close();
			} catch {
				// Ignore close error
			}
			// Final flush MUST run before `stopped` is set — readNewLines() bails
			// out immediately when `stopped` is true, so setting the flag first
			// would silently turn this into a no-op and drop any transcript lines
			// written in the last poll window (e.g. an agent's final assistant
			// message arriving right as markAgentEnd() fires).
			readNewLines();
			stopped = true;
		};

		this.transcriptWatchers.set(key, stop);
		readNewLines(); // Initial read
	}

	markPhase(runId: string, phaseIndex: number, title?: string): void {
		const run = this.runs.get(runId);
		if (!run) return;

		if (run.snapshot.phases[phaseIndex]) {
			run.snapshot.phases[phaseIndex].status = "active";
			if (title) run.snapshot.phases[phaseIndex].title = title;
		}

		run.updatedAt = Date.now();
		this.emit("phase", { runId, phaseIndex });
	}

	log(runId: string, message: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.snapshot.logs.push(message);
		run.updatedAt = Date.now();
		this.emit("log", { runId, message });
	}

	completeRun(runId: string, result?: unknown, error?: string): void {
		const run = this.runs.get(runId);
		if (!run) return;

		run.status = error ? "error" : "completed";
		run.snapshot.status = error ? "error" : "completed";
		run.snapshot.durationMs = Date.now() - run.startedAt;
		if (error) run.snapshot.error = error;
		else run.snapshot.result = result;

		for (const phase of run.snapshot.phases) {
			if (phase.status !== "pending") phase.status = "completed";
		}

		run.updatedAt = Date.now();
		this.emit(error ? "error" : "complete", { runId, result, error });
	}

	stopRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || (run.status !== "running" && run.status !== "paused")) return false;

		run.status = "stopped";
		run.snapshot.status = "cancelled";
		run.snapshot.durationMs = Date.now() - run.startedAt;
		if (run.abortController) {
			run.abortController.abort();
		}
		run.updatedAt = Date.now();
		this.emit("stopped", { runId });
		return true;
	}

	pauseRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || run.status !== "running") return false;

		run.status = "paused";
		run.updatedAt = Date.now();
		this.emit("paused", { runId });
		return true;
	}

	resumeRun(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run || run.status !== "paused") return false;

		run.status = "running";
		run.updatedAt = Date.now();
		this.emit("resumed", { runId });
		return true;
	}

	listActiveRuns(): ManagedRun[] {
		return Array.from(this.runs.values());
	}

	/** Runs currently executing, as opposed to finished ones still tracked. */
	listRunningRuns(): ManagedRun[] {
		return Array.from(this.runs.values()).filter((r) => r.status === "running");
	}

	setMaxConcurrentRuns(max: number): void {
		this.maxConcurrentRuns = Math.max(1, Math.floor(max));
	}

	getMaxConcurrentRuns(): number {
		return this.maxConcurrentRuns;
	}

	/**
	 * Decides whether another run may start, and says why not when it may not.
	 *
	 * Two separate guards. The cap is about resource exhaustion. The name guard
	 * is about intent: starting a graph that is already running under the same
	 * name is nearly always an accidental double-submit, so it is refused unless
	 * the caller says otherwise. Refusing by returning a reason rather than
	 * throwing keeps the decision testable and lets the caller phrase the error.
	 */
	checkCanStart(name: string, options: { allowDuplicateName?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
		const running = this.listRunningRuns();

		if (!options.allowDuplicateName) {
			const duplicate = running.find((r) => r.snapshot.meta.name === name);
			if (duplicate) {
				return {
					ok: false,
					reason:
						`Workflow "${name}" is already running (runId: ${duplicate.runId}). ` +
						`Wait for it, stop it from /workflows, or pass allowConcurrentDuplicate: true if a second copy is genuinely wanted.`,
				};
			}
		}

		if (running.length >= this.maxConcurrentRuns) {
			const active = running.map((r) => `${r.snapshot.meta.name || "unnamed"} (${r.runId})`).join(", ");
			return {
				ok: false,
				reason:
					`Already running ${running.length} workflow${running.length === 1 ? "" : "s"} (limit ${this.maxConcurrentRuns}): ${active}. ` +
					`Wait for one to finish or stop one from /workflows.`,
			};
		}

		return { ok: true };
	}

	listRuns(): PersistedRun[] {
		const activeList: PersistedRun[] = Array.from(this.runs.values()).map((r) => ({
			runId: r.runId,
			workflowName: r.snapshot.meta.name || "unnamed",
			status: r.status,
			agents: r.snapshot.agents,
			totalTokens: r.snapshot.totalTokens,
			durationMs: r.snapshot.durationMs || Date.now() - r.startedAt,
			updatedAt: r.updatedAt,
		}));

		if (!this.journalDir || !fs.existsSync(this.journalDir)) {
			return activeList;
		}

		// Read historical run files from journalDir
		try {
			const files = fs.readdirSync(this.journalDir).filter((f) => f.endsWith(".jsonl"));
			const activeIds = new Set(activeList.map((r) => r.runId));

			for (const file of files) {
				const runId = file.slice(0, -6);
				if (activeIds.has(runId)) continue;

				const filePath = path.join(this.journalDir, file);
				const run = parsePersistedJournal(filePath, runId);
				if (run) activeList.push(run);
			}
		} catch {
			// ignore directory read errors
		}

		return activeList.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

/**
 * Parses a graph-engine journal file (`graph_run` / `node` / `graph_result`
 * records, see graph-journal.ts) into the flat shape /workflows and
 * workflow_status expect for a run this process never held in memory —
 * either because it was created by a previous CLI invocation, or because
 * this WorkflowManager was never wired up to observe it live.
 *
 * The graph engine is the only thing that writes to journalDir; there is no
 * other journal format on disk to handle.
 */
function parsePersistedJournal(filePath: string, runId: string): PersistedRun | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n").filter(Boolean);
		if (lines.length === 0) return undefined;

		let workflowName = "workflow";
		let status: RunStatus = "completed";
		const agents: WorkflowAgentSnapshot[] = [];
		let totalTokens = 0;
		let durationMs = 0;

		for (const line of lines) {
			const rec = JSON.parse(line);
			if (rec.type === "graph_run") {
				workflowName = rec.name || workflowName;
			} else if (rec.type === "node") {
				const label = rec.agentName ? `${rec.nodeId} (${rec.agentName})` : rec.nodeId;
				const nodeFailed = rec.status === "failed";
				agents.push({
					id: rec.step ?? agents.length + 1,
					label,
					prompt: `${rec.nodeType ?? "agent"} node "${rec.nodeId}"`,
					status: nodeFailed ? "error" : "done",
					resultPreview: preview(rec.result),
					error: nodeFailed ? rec.error : undefined,
					outputTokens: rec.tokens || 0,
					durationMs: rec.durationMs || 0,
				});
				totalTokens += rec.tokens || 0;
				if (nodeFailed) status = "error";
			} else if (rec.type === "graph_result") {
				if (rec.status === "aborted") status = "stopped";
				else if (rec.status === "max_iterations" || rec.error) status = "error";
				else if (rec.status === "completed") status = "completed";
				totalTokens = rec.totalTokens ?? totalTokens;
				durationMs = rec.durationMs ?? durationMs;
			}
		}

		const stats = fs.statSync(filePath);
		return {
			runId,
			workflowName,
			status,
			agents,
			totalTokens,
			durationMs,
			updatedAt: stats.mtimeMs,
		};
	} catch {
		return undefined;
	}
}

function preview(val: unknown, maxLen = 60): string {
	if (val === undefined || val === null) return "";
	const str = typeof val === "string" ? val : JSON.stringify(val);
	return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}
