/**
 * Crash resume: a sub-agent interrupted by an external shutdown (pi
 * restart) must survive via .pi/subagent/meta/<id>.json — the next
 * manager re-registers it as "interrupted" so its worktree + branch can
 * be reviewed, merged, rejected, or continued.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
		modelRuntime: { getModel: () => model, getProviders: () => [] },
		getUI: () => undefined,
		getModel: () => model,
		getIntegration: () => undefined,
		sendFollowUp: undefined,
	} as never;
}

function makeManager(): SubagentManager {
	return new SubagentManager(makeCtx(root), {
		maxDepth: 1,
		maxConcurrent: 2,
		defaultTimeoutMs: 60_000,
	});
}

/** A runSubagent mock that stays pending until the test releases it. */
function deferredRun(): { release: () => void; calls: Array<{ task: string }> } {
	const calls: Array<{ task: string }> = [];
	let release: () => void = () => {};
	mockedRun.mockImplementation(async (opts: { task: string }) => {
		calls.push({ task: opts.task });
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			result: "done report",
			usage: { input: 0, output: 0, cost: 0 },
			stopReason: "end_turn",
		};
	});
	return { release: () => release(), calls };
}

beforeEach(() => {
	vi.clearAllMocks();
	root = mkdtempSync(join(tmpdir(), "pi-resume-test-"));
	fakeHome = mkdtempSync(join(tmpdir(), "pi-resume-home-"));
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

describe("subagent crash resume", () => {
	it("writes a meta file on spawn and restores interrupted agents in a new manager", async () => {
		const { release } = deferredRun();
		const manager = makeManager();
		const agent = await manager.spawn({ task: "long task", silent: true });

		// Meta written next to the worktree (outside it, never committed).
		const metaFile = join(root, ".pi", "subagent", "meta", `${agent.id}.json`);
		expect(existsSync(metaFile)).toBe(true);
		const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
		expect(meta.task).toBe("long task");
		expect(meta.worktreePath).toBe(agent.worktreePath);

		// Simulate a crash: the manager instance dies while the run is pending.
		const resurrected = makeManager();
		const restored = resurrected.list().find((a) => a.id === agent.id);
		expect(restored).toBeDefined();
		expect(restored!.status).toBe("interrupted");
		expect(restored!.task).toBe("long task");
		expect(restored!.worktreePath).toBe(agent.worktreePath);
		expect(restored!.error).toContain("Interrupted");

		// Release the old run so the test can exit cleanly.
		release();
		await agent.promise;
	});

	it("continues an interrupted agent in its existing worktree with a resume note", async () => {
		const first = deferredRun();
		const manager = makeManager();
		const agent = await manager.spawn({ task: "original task", silent: true });
		const worktree = agent.worktreePath;

		// Crash: drop the manager without finishing the run.
		const resurrected = makeManager();
		const restored = resurrected.list().find((a) => a.id === agent.id)!;
		expect(restored.status).toBe("interrupted");

		// Continue: same worktree, resume note + original task, then done.
		const continued = await resurrected.continueAgent(restored.id);
		expect(continued.status).toBe("running");
		expect(continued.worktreePath).toBe(worktree);
		expect(first.calls[1]!.task).toContain("[RESUMED TASK]");
		expect(first.calls[1]!.task).toContain("original task");

		first.release();
		await continued.promise;
		expect(continued.status).toBe("done");
		expect(continued.result).toBe("done report");
		// The meta file still exists for the terminal record until merge/reject.
		expect(existsSync(join(root, ".pi", "subagent", "meta", `${agent.id}.json`))).toBe(true);
	});

	it("rejects only-interruptable rules: running or terminal agents cannot be continued", async () => {
		const { release } = deferredRun();
		const manager = makeManager();
		const running = await manager.spawn({ task: "running task", silent: true });
		await expect(manager.continueAgent(running.id)).rejects.toThrow(/still running/);
		release();
		await running.promise;

		// Second task resolves immediately.
		mockedRun.mockImplementation(async () => ({
			result: "ok",
			usage: { input: 0, output: 0, cost: 0 },
			stopReason: "end_turn",
		}));
		const done = await manager.spawn({ task: "done task", silent: true });
		await done.promise;
		await expect(manager.continueAgent(done.id)).rejects.toThrow(/only interrupted/);
	});

	it("rejecting an interrupted agent removes its worktree, branch, and meta", async () => {
		const { release } = deferredRun();
		const manager = makeManager();
		const agent = await manager.spawn({ task: "doomed task", silent: true });
		release();
		await agent.promise; // let the original finish as done

		const resurrected = makeManager();
		const restored = resurrected.list().find((a) => a.id === agent.id)!;
		// The run settled as done before the restart — restored faithfully
		// (not mislabeled "interrupted") so it stays reviewable/mergeable.
		expect(restored.status).toBe("done");
		expect(restored.commitHash).toBe(agent.commitHash);
		const result = resurrected.reject(restored.id);
		expect(result.message).toContain("Rejected");
		expect(existsSync(join(root, ".pi", "subagent", "meta", `${agent.id}.json`))).toBe(false);
		expect(existsSync(agent.worktreePath)).toBe(false);
	});

	it("drops stale meta when the worktree is gone", async () => {
		const { release } = deferredRun();
		const manager = makeManager();
		const agent = await manager.spawn({ task: "vanished task", silent: true });
		release();
		await agent.promise;
		rmSync(agent.worktreePath, { recursive: true, force: true });

		const resurrected = makeManager();
		expect(resurrected.list().some((a) => a.id === agent.id)).toBe(false);
		expect(existsSync(join(root, ".pi", "subagent", "meta", `${agent.id}.json`))).toBe(false);
	});

	it("restored interrupted agents are listed with no in-flight work", async () => {
		const { release } = deferredRun();
		const manager = makeManager();
		const agent = await manager.spawn({ task: "pending task", silent: true });

		// Restart while the run is still in flight: the meta has no terminal
		// status, so the agent comes back as interrupted with no promise.
		const resurrected = makeManager();
		const restored = resurrected.list().find((a) => a.id === agent.id)!;
		expect(restored.status).toBe("interrupted");
		expect(restored.promise).toBeUndefined();
		release();
		await agent.promise;
	});
});
