/**
 * Tests for context pruning (compaction/prune.ts).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "../src/core/compaction/prune.ts";

function toolResult(toolName: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${Math.random().toString(36).slice(2)}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	} as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

const BIG = "x".repeat(10_000); // ~2500 tok

describe("pruneContextMessages", () => {
	it("replaces bulky old read-only tool outputs with stubs", () => {
		const messages = [
			userMessage("go"),
			toolResult("read", BIG),
			toolResult("bash", BIG),
			toolResult("read", "small"),
		];
		const {
			messages: pruned,
			prunedCount,
			prunedTokens,
		} = pruneContextMessages(messages, {
			keepRecentToolResults: 1,
		});

		expect(prunedCount).toBe(2);
		expect(prunedTokens).toBeGreaterThan(3000);
		const first = pruned[1] as { content: Array<{ text: string }> };
		expect(first.content[0].text).toContain("[pruned ~2500 tok of read output");
		expect(first.content[0].text).toContain("recall");
		expect(first.content[0].text.length).toBeLessThan(700);
		// Recent tool result untouched
		const last = pruned[3] as { content: Array<{ text: string }> };
		expect(last.content[0].text).toBe("small");
	});

	it("keeps the N most recent tool results intact", () => {
		const messages = [toolResult("read", BIG), toolResult("read", BIG), toolResult("read", BIG)];
		const { prunedCount } = pruneContextMessages(messages, { keepRecentToolResults: 3 });
		expect(prunedCount).toBe(0);
	});

	it("skips error results, non-read-only tools, images, small outputs, and existing stubs", () => {
		const messages = [
			toolResult("bash", BIG, true), // error
			toolResult("write", BIG), // not read-only
			toolResult("read", "short"), // small
			toolResult("read", "[pruned ~9000 tok of read output. already]"), // idempotent
			toolResult("edit", BIG), // not read-only
		];
		const { prunedCount } = pruneContextMessages(messages, { keepRecentToolResults: 0 });
		expect(prunedCount).toBe(0);
	});

	it("skips tool results containing images", () => {
		const imageResult = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [
				{ type: "text", text: BIG },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const { prunedCount } = pruneContextMessages([imageResult], { keepRecentToolResults: 0 });
		expect(prunedCount).toBe(0);
	});

	it("honors minPrunableTokens and enabled=false", () => {
		const messages = [toolResult("read", BIG)];
		expect(pruneContextMessages(messages, { keepRecentToolResults: 0, minPrunableTokens: 9999 }).prunedCount).toBe(0);
		expect(pruneContextMessages(messages, { keepRecentToolResults: 0, enabled: false }).prunedCount).toBe(0);
		expect(pruneContextMessages(messages, { keepRecentToolResults: 0 }).prunedCount).toBe(1);
	});

	it("keeps headChars of the original output, with the prune marker first", () => {
		const content = `HEADER-${"y".repeat(10_000)}`;
		const { messages: pruned } = pruneContextMessages([toolResult("read", content)], {
			keepRecentToolResults: 0,
			headChars: 100,
		});
		const text = (pruned[0] as { content: Array<{ text: string }> }).content[0].text;
		// Marker at the START so the idempotence guard recognizes the stub.
		expect(text.startsWith("[pruned ~")).toBe(true);
		expect(text).toContain(`HEADER-${"y".repeat(93)}`);
		expect(text).toContain("…");
	});

	it("replaces only the first text part and drops the rest (no stub duplication)", () => {
		const multiPart = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [
				{ type: "text", text: BIG },
				{ type: "text", text: BIG },
				{ type: "text", text: BIG },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const { messages: pruned, prunedCount } = pruneContextMessages([multiPart], { keepRecentToolResults: 0 });
		expect(prunedCount).toBe(1);
		const content = (pruned[0] as { content: Array<{ type: string; text: string }> }).content;
		expect(content).toHaveLength(1);
		expect(content[0].text.startsWith("[pruned ~")).toBe(true);
		// Stub appears exactly once
		expect(content[0].text.split("[pruned ~").length - 1).toBe(1);
	});
});
