/** Optional Moshi native-question publication. Answers still use Moshi's verified terminal bridge. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUIQuestion } from "./ask-user-question-tui.ts";

export const CHAT_REPLY_LABEL = "Reply in chat";
export function questionChoices(question: TUIQuestion) {
	return [...(question.options ?? []), { label: CHAT_REPLY_LABEL, description: "None of these fit? Write your own answer after closing this form." }];
}

export function moshiSocketPaths(): string[] {
	if (process.env.MOSHI_SOCKET_PATH) return [process.env.MOSHI_SOCKET_PATH];
	if (process.platform === "darwin") return [join(homedir(), "Library", "Application Support", "Moshi", "moshi-hook.sock")];
	return [...new Set([
		...(process.env.XDG_RUNTIME_DIR ? [join(process.env.XDG_RUNTIME_DIR, "moshi-hook.sock")] : []),
		...(process.getuid ? [`/run/user/${process.getuid()}/moshi-hook.sock`] : []),
		"/tmp/moshi-hook.sock",
	])];
}

/** Bounded, fire-and-forget local IPC. No daemon, hooks, or network listener is installed. */
function send(socketPath: string, envelope: object): Promise<void> {
	return new Promise(resolve => {
		const socket = createConnection({ path: socketPath });
		const finish = () => { clearTimeout(timer); socket.destroy(); resolve(); };
		const timer = setTimeout(finish, 250);
		socket.on("data", () => {}); // Consume the daemon acknowledgement so close is observed promptly.
		socket.once("error", finish);
		socket.once("close", finish);
		socket.once("connect", () => socket.end(`${JSON.stringify(envelope)}\n`));
	});
}

/** One lifecycle per displayed dialog, including child/human-gate requests shown in the parent. */
export function createMoshiQuestion(ctx: ExtensionContext, toolUseId: string, questions: TUIQuestion[]) {
	const socketPath = process.env.PI_SUBAGENT_CHILD === "1" ? undefined : moshiSocketPaths().find(p => existsSync(p));
	let opened = false;
	let closed = false;
	let chain = Promise.resolve();
	const base = () => ({
		type: "session.update", source: "pi", sessionId: ctx.sessionManager.getSessionId(),
		transcriptPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd,
		projectName: ctx.cwd.split(/[\\/]/).pop(), modelName: ctx.model?.id,
		requestedAt: new Date().toISOString(),
		terminalKind: process.env.HERDR_ENV === "1" ? "herdr" : process.env.TMUX ? "tmux" : process.env.ZELLIJ ? "zellij" : undefined,
		herdrPane: process.env.HERDR_PANE_ID, herdrSession: process.env.HERDR_SESSION,
		herdrWorkspaceId: process.env.HERDR_WORKSPACE_ID, herdrTabId: process.env.HERDR_TAB_ID,
		tmuxPane: process.env.TMUX_PANE, tmuxSocket: process.env.TMUX?.split(",")[0],
		zellijSession: process.env.ZELLIJ_SESSION_NAME, zellijPane: process.env.ZELLIJ_PANE_ID,
	});
	return {
		open() {
			if (!socketPath || opened || closed) return;
			opened = true;
			chain = chain.then(() => send(socketPath, {
				...base(), eventName: "QuestionAsked", category: "approval_required", toolName: "ask",
				title: "Pi has a question", subtitle: "Answer in terminal", message: questions[0]?.question,
				interactivePrompt: { kind: "question", toolUseId, questions: questions.map(q => ({
					question: q.question, header: q.header, multiSelect: false,
					options: questionChoices(q).map(o => ({ ...o, ...("preview" in o && o.preview ? { preview: capPreview(o.preview) } : {}) })),
				})) },
			})).catch(() => {});
		},
		async close() {
			if (closed) return chain;
			closed = true;
			if (socketPath && opened) chain = chain.then(() => send(socketPath, {
				...base(), eventName: "QuestionResolved", interactivePrompt: { kind: "question", toolUseId },
			})).catch(() => {});
			await chain;
		},
	};
}

function capPreview(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= 8192) return text;
	let bytes = 0;
	let result = "";
	for (const char of text) { const size = Buffer.byteLength(char, "utf8"); if (bytes + size > 8189) break; result += char; bytes += size; }
	return `${result}…`;
}
