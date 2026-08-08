/**
 * Tests for the /btw side query (core/btw.ts).
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { runBtwQuery } from "../src/core/btw.ts";

function assistantMessage(text: string, stopReason: string = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: stopReason as AssistantMessage["stopReason"],
		errorMessage,
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function stubStreamFn(
	message: AssistantMessage,
	capture?: { context?: Context; options?: SimpleStreamOptions },
): StreamFn {
	return (async (_model: unknown, context: Context, options: SimpleStreamOptions) => {
		if (capture) {
			capture.context = context;
			capture.options = options;
		}
		return { result: async () => message };
	}) as unknown as StreamFn;
}

describe("runBtwQuery", () => {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;

	it("sends the question with a side-query system prompt and returns the answer text", async () => {
		const capture: { context?: Context; options?: SimpleStreamOptions } = {};
		const text = await runBtwQuery({
			model,
			question: "What is a monorepo?",
			streamFn: stubStreamFn(assistantMessage("A repository containing multiple packages."), capture),
		});

		expect(text).toBe("A repository containing multiple packages.");
		expect(capture.context?.systemPrompt).toContain("side question");
		const userMessage = capture.context?.messages[0];
		expect(userMessage?.role).toBe("user");
		expect(userMessage && "content" in userMessage ? userMessage.content : []).toEqual([
			{ type: "text", text: "What is a monorepo?" },
		]);
	});

	it("uses one-off request semantics: no cache writes and a fresh routing session id", async () => {
		const capture: { context?: Context; options?: SimpleStreamOptions } = {};
		await runBtwQuery({
			model,
			question: "q",
			streamFn: stubStreamFn(assistantMessage("a"), capture),
		});

		expect(capture.options?.cacheRetention).toBe("none");
		expect(capture.options?.sessionId).toBeTruthy();
	});

	it("throws on provider errors", async () => {
		await expect(
			runBtwQuery({
				model,
				question: "q",
				streamFn: stubStreamFn(assistantMessage("", "error", "rate limited")),
			}),
		).rejects.toThrow("rate limited");
	});

	it("throws on abort", async () => {
		await expect(
			runBtwQuery({
				model,
				question: "q",
				streamFn: stubStreamFn(assistantMessage("", "aborted")),
			}),
		).rejects.toThrow(/aborted/i);
	});

	it("throws on empty responses", async () => {
		await expect(
			runBtwQuery({
				model,
				question: "q",
				streamFn: stubStreamFn(assistantMessage("   ")),
			}),
		).rejects.toThrow(/empty/i);
	});
});
