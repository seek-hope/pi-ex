import { describe, expect, it } from "vitest";
import { createWaitTool, type WaitScheduleResult, type WaitToolOptions } from "../src/core/tools/wait.ts";

describe("wait tool", () => {
	function makeTool(schedule: (seconds: number) => WaitScheduleResult) {
		const options: WaitToolOptions = { schedule };
		return createWaitTool(options);
	}

	it("forwards the duration to the scheduler and returns its message", async () => {
		const tool = makeTool((seconds) => ({
			ok: true,
			message: `Waiting ${seconds}s. The current turn ends now.`,
		}));
		const result = await tool.execute("c1", { timeout: 30 });
		expect((result.content[0] as { text: string }).text).toBe("Waiting 30s. The current turn ends now.");
	});

	it("surfaces scheduler errors (out-of-range / headless limit)", async () => {
		const tool = makeTool(() => ({
			ok: false,
			error: "wait duration 999999s is out of range.",
		}));
		const result = await tool.execute("c2", { timeout: 999999 });
		expect((result.content[0] as { text: string }).text).toContain("out of range");
	});

	it("exposes integer duration in the schema", async () => {
		const tool = makeTool((seconds) => ({ ok: true, message: `ok ${seconds}` }));
		const props = tool.parameters.properties as Record<string, { type?: string }>;
		expect(props.timeout?.type).toBe("integer");
	});
});
