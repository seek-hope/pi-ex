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

import { SubagentManager } from "../src/core/integrations/subagent/manager.ts";
import { runSubagent } from "../src/core/integrations/subagent/runner.ts";
import { git } from "../src/core/integrations/subagent/worktree.ts";

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
