/** Execute synchronous graph callbacks with a runtime CPU deadline, preserving closures. */
import { runInNewContext } from "node:vm";

export const GRAPH_CALLBACK_TIMEOUT_MS = 1000;
export function boundedCallback<T>(callback: (...args: any[]) => T, ...args: any[]): T {
	return runInNewContext("callback(...args)", {callback, args}, {timeout: GRAPH_CALLBACK_TIMEOUT_MS});
}
