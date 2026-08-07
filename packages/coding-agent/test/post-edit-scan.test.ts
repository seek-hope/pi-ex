/**
 * Tests for the post-edit scan: identifier extraction from edit diffs and
 * the registry-driven reference scan (best-effort, deadline-capped).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { extractChangedIdentifiers, runPostEditScan } from "../src/core/tools/post-edit-scan.ts";

describe("extractChangedIdentifiers", () => {
	it("finds identifiers removed by the edit", () => {
		const changed = extractChangedIdentifiers([
			{ oldText: "const oldName = 1;\nfoo(oldName);", newText: "const newName = 1;\nfoo(newName);" },
		]);
		expect(changed).toContain("oldName");
		expect(changed).not.toContain("newName"); // kept in newText
		expect(changed).not.toContain("const"); // stopword
		expect(changed).not.toContain("foo"); // unchanged
	});

	it("caps the number of identifiers and skips short ones", () => {
		const changed = extractChangedIdentifiers([
			{
				oldText: "a b cc ddd eeee fffff gggggg hhhhhhh",
				newText: "x",
			},
		]);
		expect(changed.every((id) => id.length >= 3)).toBe(true);
		expect(changed.length).toBeLessThanOrEqual(3);
	});

	it("returns nothing when no identifiers were removed", () => {
		expect(extractChangedIdentifiers([{ oldText: "foo(bar)", newText: "foo(bar, baz)" }])).toEqual([]);
		expect(extractChangedIdentifiers([])).toEqual([]);
	});
});

describe("runPostEditScan", () => {
	function fakeTool(name: string, output: string | undefined, delayMs = 0): AgentTool {
		return {
			name,
			label: name,
			description: "",
			parameters: {} as never,
			execute: async () => {
				if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
				if (output === undefined) throw new Error("boom");
				return { content: [{ type: "text", text: output }], details: {} };
			},
		} as unknown as AgentTool;
	}

	it("lists callers for changed identifiers via registered tools", async () => {
		const registry = new Map<string, AgentTool>([
			["codegraph_sync", fakeTool("codegraph_sync", "synced")],
			["codegraph_callers", fakeTool("codegraph_callers", "src/a.ts:42\nsrc/b.ts:7")],
		]);
		const scan = await runPostEditScan(["oldName"], { registry });
		expect(scan).toContain("oldName");
		expect(scan).toContain("src/a.ts:42");
		expect(scan).toContain("src/b.ts:7");
	});

	it("returns undefined when no codegraph tools are registered", async () => {
		const scan = await runPostEditScan(["oldName"], { registry: new Map() });
		expect(scan).toBeUndefined();
	});

	it("degrades silently when tools throw", async () => {
		const registry = new Map<string, AgentTool>([
			["codegraph_sync", fakeTool("codegraph_sync", undefined)],
			["codegraph_callers", fakeTool("codegraph_callers", undefined)],
		]);
		const scan = await runPostEditScan(["oldName"], { registry });
		expect(scan).toBeUndefined();
	});

	it("respects the deadline and never blocks past it", async () => {
		vi.useFakeTimers();
		try {
			const registry = new Map<string, AgentTool>([
				["codegraph_sync", fakeTool("codegraph_sync", "synced", 10_000)],
			]);
			const promise = runPostEditScan(["oldName"], { registry, deadlineMs: 50 });
			await vi.advanceTimersByTimeAsync(200);
			const scan = await promise;
			expect(scan).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
