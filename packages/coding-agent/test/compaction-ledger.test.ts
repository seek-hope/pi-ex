/**
 * Tests for the action ledger extractor (compaction/ledger.ts).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { emptyLedger, extractLedgerActions, formatLedger } from "../src/core/compaction/ledger.ts";

function assistantWithCalls(
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): AgentMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", ...c })),
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

function toolResult(toolCallId: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("extractLedgerActions", () => {
	it("extracts file edits/writes with status from paired results", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "edit", arguments: { path: "src/a.ts" } },
				{ id: "c2", name: "write", arguments: { path: "src/b.ts" } },
			]),
			toolResult("c1"),
			toolResult("c2", true),
		]);

		expect(ledger.files).toEqual([
			{ type: "edit", path: "src/a.ts", status: "ok" },
			{ type: "write", path: "src/b.ts", status: "error" },
		]);
	});

	it("dedups files by path keeping the latest action", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([{ id: "c1", name: "write", arguments: { path: "a.ts" } }]),
			toolResult("c1"),
			assistantWithCalls([{ id: "c2", name: "edit", arguments: { path: "a.ts" } }]),
			toolResult("c2"),
		]);
		expect(ledger.files).toEqual([{ type: "edit", path: "a.ts", status: "ok" }]);
	});

	it("records commands and detects git commits", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "bash", arguments: { command: "npm test" } },
				{ id: "c2", name: "bash", arguments: { command: 'git commit -m "fix bug"' } },
			]),
			toolResult("c1"),
			toolResult("c2"),
		]);
		expect(ledger.commands).toEqual([{ type: "command", command: "npm test", status: "ok" }]);
		expect(ledger.commits).toEqual([{ type: "commit", message: "fix bug", status: "ok" }]);
	});

	it("records subagent operations", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "subagent_spawn", arguments: { task: "explore repo" } },
				{ id: "c2", name: "subagent_merge", arguments: { id: "sa-1" } },
			]),
			toolResult("c1"),
			toolResult("c2"),
		]);
		expect(ledger.subagents).toEqual([
			{ type: "subagent", id: "explore repo", action: "spawn", status: "ok" },
			{ type: "subagent", id: "sa-1", action: "merge", status: "ok" },
		]);
	});

	it("merges with the previous ledger (cumulative across compactions)", () => {
		const prev = emptyLedger();
		prev.files.push({ type: "edit", path: "old.ts", status: "ok" });
		prev.commands.push({ type: "command", command: "old cmd", status: "ok" });

		const ledger = extractLedgerActions(
			[assistantWithCalls([{ id: "c1", name: "edit", arguments: { path: "new.ts" } }]), toolResult("c1")],
			prev,
		);
		expect(ledger.files.map((f) => f.path)).toEqual(["old.ts", "new.ts"]);
		expect(ledger.commands.map((c) => c.command)).toEqual(["old cmd"]);
	});

	it("accepts file_path as an alias for path", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "edit", arguments: { file_path: "src/a.ts" } },
				{ id: "c2", name: "write", arguments: { file_path: "src/b.ts" } },
			]),
			toolResult("c1"),
			toolResult("c2"),
		]);
		expect(ledger.files).toEqual([
			{ type: "edit", path: "src/a.ts", status: "ok" },
			{ type: "write", path: "src/b.ts", status: "ok" },
		]);
	});

	it("annotates non-zero bash exits as exit N instead of (failed)", () => {
		const exitResult = (toolCallId: string): AgentMessage =>
			({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "some output\n\nCommand exited with code 1" }],
				isError: true,
				timestamp: Date.now(),
			}) as AgentMessage;
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "bash", arguments: { command: "grep foo bar.txt" } },
				{ id: "c2", name: "bash", arguments: { command: "npm test" } },
			]),
			exitResult("c1"),
			toolResult("c2", true), // tool-level error, no exit code in text
		]);
		expect(ledger.commands[0]).toEqual({
			type: "command",
			command: "grep foo bar.txt",
			status: "error",
			exitCode: 1,
		});
		expect(ledger.commands[1]).toEqual({ type: "command", command: "npm test", status: "error" });
		const md = formatLedger(ledger);
		expect(md).toContain("`grep foo bar.txt` (exit 1)");
		expect(md).toContain("`npm test` (failed)");
	});

	it("caps commands at 50", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 60; i++) {
			messages.push(assistantWithCalls([{ id: `c${i}`, name: "bash", arguments: { command: `cmd ${i}` } }]));
			messages.push(toolResult(`c${i}`));
		}
		const ledger = extractLedgerActions(messages);
		expect(ledger.commands).toHaveLength(50);
		expect(ledger.commands[49].command).toBe("cmd 59");
	});

	it("ignores non-ledger tools and in-flight calls get recorded as ok", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "read", arguments: { path: "a.ts" } },
				{ id: "c2", name: "edit", arguments: { path: "b.ts" } },
			]),
			toolResult("c1"),
			// c2 has no result (in-flight)
		]);
		expect(ledger.files).toEqual([{ type: "edit", path: "b.ts", status: "ok" }]);
	});
});

describe("formatLedger", () => {
	it("renders markdown sections", () => {
		const ledger = extractLedgerActions([
			assistantWithCalls([
				{ id: "c1", name: "edit", arguments: { path: "a.ts" } },
				{ id: "c2", name: "bash", arguments: { command: "npm test" } },
			]),
			toolResult("c1"),
			toolResult("c2", true),
		]);
		const md = formatLedger(ledger);
		expect(md).toContain("### Files Modified");
		expect(md).toContain("- a.ts (edit)");
		expect(md).toContain("### Commands");
		expect(md).toContain("`npm test` (failed)");
	});
});
