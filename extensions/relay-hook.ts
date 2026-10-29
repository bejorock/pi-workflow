/**
 * Optional bridge to Herdr Mobile Relay's generated Pi hook.
 *
 * The relay plugin owns authentication and the private hook socket. This
 * extension uses Pi's shared event bus for structured questions and, only
 * after a verified relay answer wins, the relay's loopback pane-key endpoint
 * to dismiss the matching local Pi modal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrokerAnswer, PendingRequest, RequestBroker } from "./request-broker.ts";

const DEFAULT_RELAY_HOOK_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "herdr-relay-acp.ts");
const RELAY_RESULT_EVENT = "herdr-relay:interaction-result";
const RELAY_ELICITATION_EVENT = "herdr-relay:request-elicitation";
const RELAY_INTERACTION_TTL_MS = 5 * 60 * 1000;
const DISMISS_TIMEOUT_MS = 2_000;

interface RelayOutcome {
	action?: unknown;
	content?: unknown;
}

interface RelayInteractionResult {
	requestId?: unknown;
	outcome?: RelayOutcome;
}

interface RelayQuestionProperty {
	type: "string" | "array";
	title: string;
	description: string;
	oneOf?: Array<{ const: string; title: string; description?: string }>;
	items?: { type: "string"; oneOf: Array<{ const: string; title: string; description?: string }> };
	minItems?: number;
	maxItems?: number;
}

interface PendingRelayRequest {
	request: PendingRequest;
	timer: ReturnType<typeof setTimeout>;
}

export interface RelayHookSink {
	/** Mirrors compatible questions; callers always retain their normal local sink. */
	offer(requests: PendingRequest[]): void;
}

function relayHookPath(): string {
	// Test-only override; production users rely on the plugin's generated global extension.
	return process.env.PI_WORKFLOW_RELAY_HOOK_PATH || DEFAULT_RELAY_HOOK_PATH;
}

function relayBaseUrl(): string {
	const configured = process.env.PI_WORKFLOW_RELAY_URL?.trim();
	if (configured) return configured.replace(/\/$/, "");
	const port = process.env.COLLIE_PORT?.trim() || "8787";
	return `http://127.0.0.1:${port}`;
}

function relayAvailable(): boolean {
	return (
		process.env.HERDR_ENV === "1" &&
		typeof process.env.HERDR_PANE_ID === "string" &&
		process.env.HERDR_PANE_ID.length > 0 &&
		fs.existsSync(relayHookPath())
	);
}

/** Only bounded choices can be represented without losing Pi TUI Other/chat/notes features. */
export function canRelayQuestion(request: PendingRequest): boolean {
	return (
		request.kind === "human" &&
		request.questions.length >= 1 &&
		request.questions.length <= 4 &&
		request.questions.every(
			(question) =>
				Array.isArray(question.options) &&
				question.options.length >= 1 &&
				question.options.length <= 32 &&
				question.options.every(
					(option) =>
						typeof option.label === "string" &&
						option.label.length > 0 &&
						option.label.length <= 128 &&
						(option.description === undefined || option.description.length <= 512),
				),
		)
	);
}

function relayRequestId(request: PendingRequest): string {
	const run = request.runId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80);
	const id = request.id.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 32);
	return `piwf:${run}:${id}`.slice(0, 128);
}

function toRelaySchema(request: PendingRequest): { properties: Record<string, RelayQuestionProperty>; required: string[] } {
	const properties: Record<string, RelayQuestionProperty> = {};
	const required: string[] = [];
	request.questions.forEach((question, index) => {
		const key = `q${index + 1}`;
		const choices = (question.options ?? []).map((option) => ({
			const: option.label,
			title: option.label,
			...(option.description ? { description: option.description } : {}),
		}));
		properties[key] = question.multiSelect
			? { type: "array", title: question.header, description: question.question, items: { type: "string", oneOf: choices }, minItems: 1, maxItems: choices.length }
			: { type: "string", title: question.header, description: question.question, oneOf: choices };
		required.push(key);
	});
	return { properties, required };
}

function answersFromOutcome(request: PendingRequest, outcome: RelayOutcome | undefined): BrokerAnswer | undefined {
	if (outcome?.action !== "accept" || !outcome.content || typeof outcome.content !== "object" || Array.isArray(outcome.content)) return undefined;
	const content = outcome.content as Record<string, unknown>;
	const answers: BrokerAnswer["questions"] = [];
	for (let index = 0; index < request.questions.length; index++) {
		const question = request.questions[index];
		const value = content[`q${index + 1}`];
		const allowed = new Set((question.options ?? []).map((option) => option.label));
		if (question.multiSelect) {
			if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && allowed.has(item))) return undefined;
			const selected = value as string[];
			if (new Set(selected).size !== selected.length) return undefined;
			answers.push({ questionIndex: index, kind: "multi", answer: selected.join(", "), selected });
		} else {
			if (typeof value !== "string" || !allowed.has(value)) return undefined;
			answers.push({ questionIndex: index, kind: "option", answer: value });
		}
	}
	return { questions: answers, cancelled: false };
}

/**
 * Closes Pi's local custom question dialog after a remote answer wins. The
 * relay calls Herdr's pane.send_keys internally; this direct loopback request
 * never exposes a new network listener and failures are harmless because the
 * workflow answer is already structurally valid.
 */
async function dismissLocalQuestion(): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId || typeof fetch !== "function") return;
	try {
		const response = await fetch(`${relayBaseUrl()}/api/pane/${encodeURIComponent(paneId)}/keys`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ keys: ["Escape"] }),
			signal: AbortSignal.timeout(DISMISS_TIMEOUT_MS),
		});
		void response.body?.cancel();
	} catch {
		// The relay is optional. A failed dismissal must never invalidate an
		// already authorized answer or break users without the plugin.
	}
}

/**
 * Relay and local TUI are both offered immediately. A valid remote answer is
 * first-answer-wins: send Escape through the relay to dismiss the *same*
 * Herdr pane's local modal. Resolve the broker *before* sending Escape: the
 * TUI's cancellation callback then finds no pending request and cannot turn
 * a successful remote answer into the workflow node's default. Local
 * resolution likewise removes the pending request, so late remote responses
 * are ignored without keys.
 */
export function installRelayHookSink(pi: ExtensionAPI, broker: RequestBroker): RelayHookSink {
	const pending = new Map<string, PendingRelayRequest>();
	if (!pi.events?.on || !pi.events?.emit) return { offer: () => {} };

	pi.events.on(RELAY_RESULT_EVENT, async (value: unknown) => {
		const result = value as RelayInteractionResult;
		if (!result || typeof result.requestId !== "string") return;
		const entry = pending.get(result.requestId);
		if (!entry) return;
		if (!broker.hasPending(entry.request.id)) {
			clearTimeout(entry.timer);
			pending.delete(result.requestId);
			return;
		}
		const answers = answersFromOutcome(entry.request, result.outcome);
		if (!answers) return; // cancellation/expiry leave the indefinitely-waiting local TUI intact.

		clearTimeout(entry.timer);
		pending.delete(result.requestId);
		broker.resolve(entry.request.id, {
			source: "human",
			text: answers.questions[0]?.answer ?? undefined,
			answers,
		});
		await dismissLocalQuestion();
	});

	return {
		offer(requests) {
			if (!relayAvailable()) return;
			for (const request of requests) {
				if (!canRelayQuestion(request)) continue;
				const requestId = relayRequestId(request);
				const timer = setTimeout(() => pending.delete(requestId), RELAY_INTERACTION_TTL_MS + 1_000);
				timer.unref?.();
				pending.set(requestId, { request, timer });
				try {
					pi.events.emit(RELAY_ELICITATION_EVENT, {
						requestId,
						title: request.questions.length === 1 ? request.questions[0].header : "Workflow needs your input",
						description: request.questions.length === 1 ? request.questions[0].question : "Answer the workflow questions to continue.",
						schema: toRelaySchema(request),
					});
				} catch {
					clearTimeout(timer);
					pending.delete(requestId);
				}
			}
		},
	};
}
