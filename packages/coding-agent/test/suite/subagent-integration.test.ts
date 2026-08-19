/**
 * End-to-end tests for the subagent core integration.
 * Uses the suite harness (faux provider) and real git in a temp project.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { branchName, safeId } from "@earendil-works/pi-subagent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { SubagentIntegration } from "../../src/core/integrations/subagent/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const noCtx = undefined as unknown as ExtensionContext;

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("subagent integration", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	function subagent(): SubagentIntegration {
		const integration = harness.session.getIntegration<SubagentIntegration>("subagent");
		expect(integration).toBeDefined();
		return integration!;
	}

	function spawnTool() {
		const def = subagent()
			.getToolDefinitions()
			.find((d) => d.name === "subagent_spawn");
		expect(def).toBeDefined();
		return def!;
	}

	async function waitFor(id: string) {
		const agent = subagent()
			.manager.list()
			.find((a) => a.id === id);
		expect(agent).toBeDefined();
		await agent!.promise;
		return agent!;
	}

	it("registers the subagent toolset in the session", () => {
		const names = subagent()
			.getToolDefinitions()
			.map((d) => d.name);
		expect(names).toEqual([
			"subagent_spawn",
			"subagent_review",
			"subagent_merge",
			"subagent_reject",
			"subagent_parallel",
			"subagent_list",
			"subagent_message",
			"subagent_cancel",
			"subagent_continue",
			"subagent_followup",
			"subagent_ensure_git",
		]);
	});

	it("spawns an in-process sub-agent that completes in its own worktree", async () => {
		harness.setResponses([fauxAssistantMessage("Sub-agent report: explored the repo.")]);

		const result = await spawnTool().execute("call-1", { task: "explore the repo" }, undefined, undefined, noCtx);
		const details = result.details as { id: string; worktree: string; branch: string };
		expect(details.id).toMatch(/^sa-/);
		expect(details.worktree).toContain(join(".pi", "subagent"));

		const agent = await waitFor(details.id);
		expect(agent.status).toBe("done");
		expect(agent.result).toBe("Sub-agent report: explored the repo.");
		// Auto-initialized git + worktree branch
		expect(agent.branch).toBe(branchName(details.id));
		git(["rev-parse", "--verify", agent.branch], harness.tempDir);
	});

	it("review returns the branch diff and merge integrates the work", async () => {
		// The sub-agent writes a file via its own write tool, then reports done.
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("write", { path: "subagent-output.txt", content: "hello from sub-agent\n" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);

		const result = await spawnTool().execute("call-1", { task: "change things" }, undefined, undefined, noCtx);
		const { id } = result.details as { id: string };

		const agent = await waitFor(id);
		expect(agent.status).toBe("done");
		expect(agent.commitHash).toBeTruthy();

		const diff = subagent().manager.review(id);
		expect(diff).toContain("subagent-output.txt");

		const { message } = subagent().manager.merge(id);
		expect(message).toContain("Merged");
		expect(existsSync(join(harness.tempDir, "subagent-output.txt"))).toBe(true);
	});

	it("reject removes the worktree and branch", async () => {
		harness.setResponses([fauxAssistantMessage("done")]);
		const result = await spawnTool().execute("call-1", { task: "doomed work" }, undefined, undefined, noCtx);
		const { id } = result.details as { id: string };
		const agent = await waitFor(id);
		expect(agent.status).toBe("done");

		subagent().manager.reject(id);
		expect(() => git(["rev-parse", "--verify", branchName(id)], harness.tempDir)).toThrow();
	});

	it("enforces the concurrency limit", async () => {
		const busy = await createHarness({ settings: { subagents: { maxConcurrent: 0 } } });
		try {
			const integration = busy.session.getIntegration<SubagentIntegration>("subagent")!;
			await expect(integration.manager.spawn({ task: "x", depth: 0 })).rejects.toThrow(/Concurrency limit/);
		} finally {
			busy.cleanup();
		}
	});

	it("enforces the depth limit", async () => {
		const integration = subagent();
		await expect(integration.manager.spawn({ task: "x", depth: 99 })).rejects.toThrow(/depth limit/);
	});

	it("cancel marks a running sub-agent as cancelled", async () => {
		// No responses queued — the sub-agent's first model call would hang, so
		// cancel immediately after spawn.
		const result = await spawnTool().execute("call-1", { task: "long work" }, undefined, undefined, noCtx);
		const { id } = result.details as { id: string };
		const agent = await subagent().manager.cancel(id);
		expect(["cancelled", "error"]).toContain(agent.status);
	});
});

describe("safeId / branchName", () => {
	it("keeps safe ids readable", () => {
		expect(safeId("sa-abc-123")).toBe("sa-abc-123");
		expect(branchName("sa-abc-123")).toBe("pi/subagent/sa-abc-123");
	});

	it("sanitizes and hashes unsafe ids", () => {
		const safe = safeId("my task/with spaces")!;
		expect(safe).toMatch(/^my-task-with-spaces-[a-f0-9]{8}$/);
		expect(branchName("my task/with spaces")).toBe(`pi/subagent/${safe}`);
	});

	it("falls back to a hash for empty ids", () => {
		expect(safeId("!!!")).toBeNull();
		expect(branchName("!!!")).toMatch(/^pi\/subagent\/fallback-[a-f0-9]{12}$/);
	});
});
