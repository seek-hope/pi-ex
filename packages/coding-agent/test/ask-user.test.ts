import { describe, expect, it } from "vitest";
import { type AskUserOptions, type AskUserResult, createAskUserTool } from "../src/core/tools/ask-user.ts";

function makeTool(responses: Array<AskUserResult | (() => Promise<AskUserResult>)>) {
	const calls: string[] = [];
	const options: AskUserOptions = {
		askUser: async (question) => {
			calls.push(question);
			const next = responses.shift();
			return typeof next === "function" ? await next() : (next ?? { ok: false, reason: "cancelled" });
		},
	};
	return { tool: createAskUserTool(options), calls };
}

describe("ask_user tool", () => {
	it("asks questions consecutively and pairs answers with questions", async () => {
		const { tool, calls } = makeTool([
			{ ok: true, answer: "prod" },
			{ ok: true, answer: "docker" },
		]);
		const result = await tool.execute("c1", {
			questions: ["Deploy target?", "Container runtime?"],
		});
		expect(calls).toEqual(["Deploy target?", "Container runtime?"]);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Q: Deploy target?\nA: prod");
		expect(text).toContain("Q: Container runtime?\nA: docker");
	});

	it("keeps asking remaining questions when the user dismisses one dialog", async () => {
		const { tool, calls } = makeTool([
			{ ok: false, reason: "cancelled" },
			{ ok: true, answer: "answered" },
		]);
		const result = await tool.execute("c2", {
			questions: ["Q1?", "Q2?"],
		});
		expect(calls).toHaveLength(2);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Q: Q1?\nA: (no answer — user dismissed the dialog)");
		expect(text).toContain("Q: Q2?\nA: answered");
	});

	it("reports unavailable when there is no UI", async () => {
		const { tool, calls } = makeTool([{ ok: false, reason: "no-ui" }]);
		const result = await tool.execute("c3", { questions: ["Q1?"] });
		expect(calls).toHaveLength(1);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("ask_user is unavailable");
		expect(text).toContain("[uncertain:inference]");
	});

	it("stops asking further questions when the UI is gone mid-way", async () => {
		const { tool, calls } = makeTool([
			{ ok: true, answer: "first" },
			{ ok: false, reason: "no-ui" },
		]);
		const result = await tool.execute("c4", { questions: ["Q1?", "Q2?", "Q3?"] });
		expect(calls).toHaveLength(2);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Q: Q1?\nA: first");
		expect(text).not.toContain("Q3?");
	});

	it("treats blank answers as cancelled", async () => {
		const { tool } = makeTool([{ ok: false, reason: "cancelled" }]);
		const result = await tool.execute("c5", { questions: ["Q1?"] });
		expect((result.content[0] as { text: string }).text).toContain("(no answer — user dismissed the dialog)");
	});
});
