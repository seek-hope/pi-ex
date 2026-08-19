/**
 * Tests for the LEGO subagent rework:
 * - readOnly path (shared project dir, no worktree/commit, report-only)
 * - dependsOn DAG scheduling (queue, upstream report injection, cascade cancel)
 * - subagent_message (prompt addendum for queued, steering for running)
 * - aggregate all-settled wake (no per-agent follow-ups)
 */
import { mkdtempSync, rmSync } from "node:fs";
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

function makeCtx(cwd: string, sendFollowUp?: (text: string) => void) {
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
		sendFollowUp,
	} as never;
}

function makeManager(sendFollowUp?: (text: string) => void) {
	return new SubagentManager(makeCtx(root, sendFollowUp), {
		maxDepth: 2,
		maxConcurrent: 5,
		defaultTimeoutMs: 10_000,
		gitName: "Test",
		gitEmail: "test@example.com",
	});
}

function okResult(text: string) {
	return { result: text, usage: { input: 1, output: 1, cost: 0 }, stopReason: "stop" };
}

beforeEach(() => {
	mockedRun.mockReset(); // clear calls AND any leftover mockImplementationOnce queue
	root = mkdtempSync(join(tmpdir(), "pi-dag-test-"));
	fakeHome = mkdtempSync(join(tmpdir(), "pi-dag-home-"));
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

describe("readOnly path", () => {
	it("runs in the project dir with no branch/commit and is report-only", async () => {
		mockedRun.mockImplementation(async () => okResult("findings here"));
		const manager = makeManager();
		const agent = await manager.spawn({ task: "survey the module", readOnly: true });
		expect(agent.branch).toBe("");
		expect(agent.worktreePath).toBe(root);
		await agent.promise;
		expect(agent.status).toBe("done");
		expect(agent.result).toBe("findings here");
		expect(agent.commitHash).toBeUndefined();
		// Nothing committed anywhere: project dir stays clean.
		expect(git(["status", "--porcelain"], root)).toBe("");
		expect(() => manager.review(agent.id)).toThrow(/report-only/);
		expect(() => manager.merge(agent.id)).toThrow(/nothing to merge/);
		const { message } = manager.reject(agent.id);
		expect(message).toMatch(/report-only/);
	});

	it("rejects write-like flows: runSubagent got the readOnly flag and project cwd", async () => {
		mockedRun.mockImplementation(async () => okResult("ok"));
		const manager = makeManager();
		const agent = await manager.spawn({ task: "t", readOnly: true });
		await agent.promise;
		const req = mockedRun.mock.calls[0][0];
		expect(req.readOnly).toBe(true);
		expect(req.cwd).toBe(root);
	});
});

describe("dependsOn DAG", () => {
	it("queues the dependent, then starts it with the upstream report injected", async () => {
		let gateA!: (r: ReturnType<typeof okResult>) => void;
		const promiseA = new Promise<ReturnType<typeof okResult>>((resolve) => {
			gateA = resolve;
		});
		mockedRun.mockImplementationOnce(() => promiseA).mockImplementationOnce(async () => okResult("B done"));
		const manager = makeManager();

		const a = await manager.spawn({ task: "task A" });
		const b = await manager.spawn({ task: "task B", dependsOn: [a.id] });

		expect(b.status).toBe("pending");
		expect(b.branch).toBe(""); // no worktree while queued
		expect(mockedRun).toHaveBeenCalledTimes(1); // only A running

		gateA(okResult("report from A"));
		await a.promise;
		// A's settle schedules B synchronously.
		expect(b.status).toBe("running");
		expect(b.branch).not.toBe(""); // deferred worktree created at launch
		await b.promise;
		expect(b.status).toBe("done");

		const bReq = mockedRun.mock.calls[1][0];
		expect(bReq.task).toContain("Upstream agent results");
		expect(bReq.task).toContain("report from A");
		expect(bReq.task).toContain("task B");
	});

	it("cascade-cancels dependents of a failed dependency", async () => {
		mockedRun.mockImplementation(async () => {
			throw new Error("boom");
		});
		const manager = makeManager();
		const a = await manager.spawn({ task: "task A" });
		const b = await manager.spawn({ task: "task B", dependsOn: [a.id] });
		const c = await manager.spawn({ task: "task C", dependsOn: [b.id] });
		await a.promise;
		expect(a.status).toBe("error");
		expect(b.status).toBe("cancelled");
		expect(b.error).toMatch(/dependency/);
		expect(c.status).toBe("cancelled"); // cascade inside the same pass
		await b.promise; // queued promises resolve on terminal transitions
		await c.promise;
	});

	it("rejects unknown dependency ids at spawn", async () => {
		const manager = makeManager();
		await expect(manager.spawn({ task: "t", dependsOn: ["sa-nonexistent"] })).rejects.toThrow(/unknown agent/);
	});

	it("queued agents do not consume concurrency slots", async () => {
		let release!: () => void;
		const gate = new Promise<ReturnType<typeof okResult>>((resolve) => {
			release = () => resolve(okResult("done"));
		});
		mockedRun.mockImplementation(() => gate);
		const manager = makeManager(); // maxConcurrent 5
		const running = await Promise.all(Array.from({ length: 5 }, (_, i) => manager.spawn({ task: `r${i}` })));
		// Pool is full — an immediate 6th spawn must fail…
		await expect(manager.spawn({ task: "r6" })).rejects.toThrow(/Concurrency limit/);
		// …but a queued one is accepted.
		const queued = await manager.spawn({ task: "q", dependsOn: [running[0].id] });
		expect(queued.status).toBe("pending");
		release();
		await Promise.all(running.map((a) => a.promise));
		await queued.promise;
		expect(queued.status).toBe("done");
	});
});

describe("subagent_message", () => {
	it("appends to a queued agent's prompt", async () => {
		let gateA!: (r: ReturnType<typeof okResult>) => void;
		const promiseA = new Promise<ReturnType<typeof okResult>>((resolve) => {
			gateA = resolve;
		});
		mockedRun.mockImplementation(() => promiseA);
		const manager = makeManager();
		const a = await manager.spawn({ task: "A" });
		const b = await manager.spawn({ task: "B", dependsOn: [a.id] });
		manager.message(b.id, "also cover the edge cases");
		expect(b.task).toContain("also cover the edge cases");
		gateA(okResult("A report"));
		await a.promise;
		await b.promise;
	});

	it("steers a running agent via the live handle", async () => {
		const steer = vi.fn();
		let gate!: (r: ReturnType<typeof okResult>) => void;
		const promise = new Promise<ReturnType<typeof okResult>>((resolve) => {
			gate = resolve;
		});
		mockedRun.mockImplementation((options) => {
			options.onAgentCreated?.({ steer } as never);
			return promise;
		});
		const manager = makeManager();
		const a = await manager.spawn({ task: "A" });
		manager.message(a.id, "focus on src/ only");
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer.mock.calls[0][0]).toMatchObject({ role: "user", content: "focus on src/ only" });
		gate(okResult("done"));
		await a.promise;
	});

	it("rejects messaging a finished agent", async () => {
		mockedRun.mockImplementation(async () => okResult("done"));
		const manager = makeManager();
		const a = await manager.spawn({ task: "A" });
		await a.promise;
		expect(() => manager.message(a.id, "too late")).toThrow(/followup/);
	});
});

describe("aggregate completion wake", () => {
	it("sends ONE follow-up when the last agent settles, none per-agent", async () => {
		const sendFollowUp = vi.fn();
		mockedRun.mockImplementation(async () => okResult("done"));
		const manager = makeManager(sendFollowUp);
		const a = await manager.spawn({ task: "A" });
		const b = await manager.spawn({ task: "B" });
		await a.promise;
		await b.promise;
		expect(sendFollowUp).toHaveBeenCalledTimes(1);
		expect(sendFollowUp.mock.calls[0][0]).toContain("All sub-agents have settled");
	});

	it("does not fire for an all-silent batch", async () => {
		const sendFollowUp = vi.fn();
		mockedRun.mockImplementation(async () => okResult("done"));
		const manager = makeManager(sendFollowUp);
		const a = await manager.spawn({ task: "A", silent: true });
		await a.promise;
		expect(sendFollowUp).not.toHaveBeenCalled();
	});
});
