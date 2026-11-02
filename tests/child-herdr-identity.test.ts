import { describe, expect, it } from "vitest";
import { stripHerdrPaneIdentity } from "../extensions/execution.ts";

describe("child Herdr identity isolation", () => {
	it("removes parent pane identity but preserves provider and relay transport configuration", () => {
		const child = stripHerdrPaneIdentity({
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_TAB_ID: "w1:t1",
			HERDR_WORKSPACE_ID: "w1",
			HERDR_SESSION: "default",
			HERDR_SOCKET_PATH: "/home/me/.config/herdr/herdr.sock",
			NINE_ROUTER_API_KEY: "configured",
			COLLIE_PORT: "8787",
			PI_WORKFLOW_RUN_ID: "run-1",
		});

		expect(child.HERDR_ENV).toBeUndefined();
		expect(child.HERDR_PANE_ID).toBeUndefined();
		expect(child.HERDR_TAB_ID).toBeUndefined();
		expect(child.HERDR_WORKSPACE_ID).toBeUndefined();
		expect(child.HERDR_SESSION).toBeUndefined();
		expect(child.HERDR_SOCKET_PATH).toBe("/home/me/.config/herdr/herdr.sock");
		expect(child.NINE_ROUTER_API_KEY).toBe("configured");
		expect(child.COLLIE_PORT).toBe("8787");
		expect(child.PI_WORKFLOW_RUN_ID).toBe("run-1");
	});
});
