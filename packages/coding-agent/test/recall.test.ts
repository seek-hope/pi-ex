/**
 * Tests for the recall archive-retrieval tool.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { archivedEntries, createRecallToolDefinitions } from "../src/core/tools/recall.ts";

function makeCtx(sessionManager: SessionManager): ExtensionContext {
	return { sessionManager } as unknown as ExtensionContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0].text ?? "";
}

describe("recall", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let recall: ReturnType<typeof createRecallToolDefinitions>[0];
	let checkpoints: ReturnType<typeof createRecallToolDefinitions>[1];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-recall-test-"));
		sessionManager = SessionManager.create(tempDir);
		[recall, checkpoints] = createRecallToolDefinitions();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function appendUser(text: string): string {
		return sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}

	function appendAssistant(text: string): string {
		return sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as never);
	}

	function appendToolResult(text: string): void {
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} as never);
	}

	function compactThroughLast(): void {
		const leafId = sessionManager.getLeafId()!;
		sessionManager.appendCompaction(
			"summary of archived span",
			leafId,
			50_000,
			{ readFiles: [], modifiedFiles: [] },
			false,
		);
	}

	it("reports an empty archive when nothing was compacted away", async () => {
		appendUser("hello");
		const result = await recall.execute("c", { query: "hello" }, undefined, undefined, makeCtx(sessionManager));
		expect(textOf(result)).toContain("Nothing archived");
		expect(archivedEntries(sessionManager.getBranch())).toHaveLength(0);
	});

	it("searches archived entries by keyword", async () => {
		appendUser("tell me about the charge_status column");
		appendAssistant("the charge_status column stores billing state");
		appendToolResult("CREATE TABLE t (charge_status TEXT)");
		const keptId = appendUser("new topic");
		sessionManager.appendCompaction("archived billing discussion", keptId, 50_000, {}, false);
		appendUser("current work continues");

		const result = await recall.execute(
			"c",
			{ query: "charge_status" },
			undefined,
			undefined,
			makeCtx(sessionManager),
		);
		const text = textOf(result);
		expect(text).toContain("3 archived entrie(s) matched");
		expect(text).toContain("charge_status");
		// Kept entries are not searched
		expect(text).not.toContain("current work continues");
	});

	it("searches by file path and regex", async () => {
		appendAssistant("edit src/auth/login.ts to use argon2");
		const keptId = appendUser("next");
		sessionManager.appendCompaction("archived", keptId, 50_000, {}, false);

		const byFile = await recall.execute(
			"c",
			{ files: ["src/auth/login.ts"] },
			undefined,
			undefined,
			makeCtx(sessionManager),
		);
		expect(textOf(byFile)).toContain("login.ts");

		const byRegex = await recall.execute("c", { query: "arg\\w+2" }, undefined, undefined, makeCtx(sessionManager));
		expect(textOf(byRegex)).toContain("argon2");
	});

	it("returns no-match information when nothing matches", async () => {
		appendUser("something");
		const keptId = appendUser("kept message");
		sessionManager.appendCompaction("archived something", keptId, 50_000, {}, false);
		const result = await recall.execute("c", { query: "zzzzz" }, undefined, undefined, makeCtx(sessionManager));
		expect(textOf(result)).toContain("No archived entries matched");
	});

	it("fetches a specific entry with neighbors", async () => {
		appendUser("first message");
		const targetId = appendAssistant("the middle answer");
		appendUser("third message");
		const keptId = appendUser("kept message");
		sessionManager.appendCompaction("archived all three", keptId, 50_000, {}, false);

		const result = await recall.execute(
			"c",
			{ entryId: targetId, beforeCount: 1, afterCount: 1 },
			undefined,
			undefined,
			makeCtx(sessionManager),
		);
		const text = textOf(result);
		expect(text).toContain("first message");
		expect(text).toContain("the middle answer");
		expect(text).toContain("third message");
	});

	it("lists checkpoints including their summaries", async () => {
		appendUser("old work");
		compactThroughLast();
		appendUser("newer work");

		const result = await checkpoints.execute("c", {}, undefined, undefined, makeCtx(sessionManager));
		const text = textOf(result);
		expect(text).toContain("checkpoint");
		expect(text).toContain("summary of archived span");
	});
});
