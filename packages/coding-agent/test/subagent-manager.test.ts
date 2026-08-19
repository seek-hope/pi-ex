/**
 * Regression test: an explicit cancel() that races with the run timeout.
 *
 * Sequence: cancel() aborts the run; before the (mocked) runner observes the
 * abort and resolves, the timeout timer fires and sets timedOut=true. The
 * run handler must still classify this as an explicit cancel — status
 * "cancelled", worktree discarded — not as "timeout" (which keeps partial
 * work for salvage).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/integrations/subagent/runner.ts", () => ({
	runSubagent: vi.fn(),
}));

import { git } from "@earendil-works/pi-subagent-core";
import { SubagentManager } from "../src/core/integrations/subagent/manager.ts";
import { runSubagent } from "../src/core/integrations/subagent/runner.ts";

const mockedRun = vi.mocked(runSubagent);

let root: string;
let fakeHome: string;
const origHome = process.env.HOME;
const origNoSys = process.env.GIT_CONFIG_NOSYSTEM;

function makeCtx(cwd: string) {
	const model = { provider: "test", id: "test-model" };
	return {
		cwd,
		sessionManager: undefined,
		settingsManager: undefined,
		modelRuntime: {
			getModel: (provider: string, id: string) => (provider === "test" && id === "test-model" ? model : undefined),
			getProviders: () => [],
		},
		getUI: () => undefined,
		getModel: () => model,
		getIntegration: () => undefined,
		sendFollowUp: undefined,
	} as never;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-manager-test-"));
	fakeHome = mkdtempSync(join(tmpdir(), "pi-manager-home-"));
	process.env.HOME = fakeHome;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	git(["init"], root);
	git(["config", "user.name", "Test"], root);
	git(["config", "user.email", "test@example.com"], root);
	git(["commit", "--allow-empty", "-m", "init"], root);
});

afterEach(() => {
	process.env.HOME = origHome;
	if (origNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = origNoSys;
	rmSync(root, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("subagent manager: cancel vs timeout race", () => {
	it("explicit cancel wins over a timeout that fires before the run settles", async () => {
		// The runner resolves 300ms after the abort is requested — well past
		// the 100ms run timeout, so timedOut flips true in between.
		mockedRun.mockImplementation(async (opts: { signal?: AbortSignal }) => {
			await new Promise<void>((resolve) => {
				opts.signal?.addEventListener("abort", () => setTimeout(resolve, 300), { once: true });
			});
			return {
				result: "unused",
				usage: { input: 0, output: 0, cost: 0 },
				stopReason: "aborted",
			};
		});

		const manager = new SubagentManager(makeCtx(root), {
			maxDepth: 1,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const agent = await manager.spawn({ task: "race test", timeoutMs: 100, silent: true });

		// Cancel immediately; the timeout (100ms) fires before the mocked
		// runner settles (300ms after abort).
		const cancelled = await manager.cancel(agent.id);

		expect(cancelled.status).toBe("cancelled");
		// Explicit cancel = deliberate discard: worktree + branch are gone.
		expect(existsSync(agent.worktreePath)).toBe(false);
	}, 15_000);

	it("a genuine timeout is still classified as timeout", async () => {
		mockedRun.mockImplementation(async (opts: { signal?: AbortSignal }) => {
			await new Promise<void>((resolve) => {
				opts.signal?.addEventListener("abort", () => setTimeout(resolve, 50), { once: true });
			});
			return {
				result: "unused",
				usage: { input: 0, output: 0, cost: 0 },
				stopReason: "aborted",
			};
		});

		const manager = new SubagentManager(makeCtx(root), {
			maxDepth: 1,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const agent = await manager.spawn({ task: "timeout test", timeoutMs: 100, silent: true });
		await agent.promise;

		expect(agent.status).toBe("timeout");
	}, 15_000);
});

const doneResult = {
	result: "report",
	usage: { input: 0, output: 0, cost: 0 },
	stopReason: "done",
};

describe("subagent manager: followup (codex multi-agent v2 followup_task)", () => {
	it("re-tasks a done agent on its existing branch with a follow-up preamble", async () => {
		mockedRun.mockResolvedValue(doneResult);
		const manager = new SubagentManager(makeCtx(root), {
			maxDepth: 2,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const agent = await manager.spawn({ task: "first task", silent: true });
		await agent.promise;
		expect(agent.status).toBe("done");
		const branch = agent.branch;
		const worktree = agent.worktreePath;

		mockedRun.mockResolvedValueOnce(doneResult);
		const reTasked = await manager.followup(agent.id, "second task");
		await reTasked.promise;

		expect(reTasked.id).toBe(agent.id);
		expect(reTasked.status).toBe("done");
		expect(reTasked.branch).toBe(branch);
		expect(reTasked.worktreePath).toBe(worktree);
		const lastCall = mockedRun.mock.calls.at(-1)![0] as { task: string };
		expect(lastCall.task).toContain("[FOLLOW-UP TASK]");
		expect(lastCall.task).toContain("second task");
		expect(lastCall.task).toContain("first task");
	}, 15_000);

	it("rejects followup for running and cleaned-up agents", async () => {
		mockedRun.mockImplementation(async (opts: { signal?: AbortSignal }) =>
			new Promise((resolve) => {
				opts.signal?.addEventListener("abort", () => setTimeout(resolve, 50), { once: true });
			}).then(() => ({ ...doneResult, stopReason: "aborted" })),
		);
		const manager = new SubagentManager(makeCtx(root), {
			maxDepth: 1,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const running = await manager.spawn({ task: "long", timeoutMs: 200, silent: true });
		await expect(manager.followup(running.id, "nope")).rejects.toThrow(/still running/);
		const cancelled = await manager.cancel(running.id);
		await expect(manager.followup(cancelled.id, "nope")).rejects.toThrow(/cleaned up/);
	}, 15_000);

	it("a model override re-resolves a leaf model for the follow-up", async () => {
		mockedRun.mockResolvedValue(doneResult);
		const manager = new SubagentManager(makeCtx(root), {
			maxDepth: 1,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const agent = await manager.spawn({ task: "t1", silent: true });
		await agent.promise;
		// Unknown override fails before the agent is re-launched; the agent
		// keeps its original model and terminal status.
		await expect(manager.followup(agent.id, "t2", { model: "missing/model" })).rejects.toThrow(/Model not found/);
		expect(agent.status).toBe("done");
		expect(agent.model).toBe("test/test-model");
	}, 15_000);
});

describe("subagent manager: tree tracking and developer instructions", () => {
	it("records parentId on spawn and restores it from crash metadata", async () => {
		mockedRun.mockResolvedValue(doneResult);
		const ctx = makeCtx(root);
		const manager = new SubagentManager(ctx, {
			maxDepth: 2,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const agent = await manager.spawn({ task: "child task", depth: 1, parentId: "sa-parent", silent: true });
		expect(agent.parentId).toBe("sa-parent");

		// A fresh manager (same project root) re-registers the interrupted
		// agent from its meta file, carrying the tree edge.
		const restored = new SubagentManager(ctx, {
			maxDepth: 2,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
		});
		const survivor = restored.get(agent.id);
		expect(survivor?.status).toBe("interrupted");
		expect(survivor?.parentId).toBe("sa-parent");
	}, 15_000);

	it("passes subagentInstructions through to the runner", async () => {
		mockedRun.mockResolvedValue(doneResult);
		const manager = new SubagentManager(makeCtx(root), {
			maxDepth: 1,
			maxConcurrent: 2,
			defaultTimeoutMs: 60_000,
			subagentInstructions: "Always run npm run check before finishing.",
		});
		const agent = await manager.spawn({ task: "t", silent: true });
		await agent.promise;
		const call = mockedRun.mock.calls.at(-1)![0] as { subagentInstructions?: string };
		expect(call.subagentInstructions).toBe("Always run npm run check before finishing.");
	}, 15_000);
});
