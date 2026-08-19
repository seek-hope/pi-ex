/**
 * Tests for the bg task sleep cap (sleep allowed up to 5 minutes in
 * background tasks) and multi-task completion merging.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTasksIntegration, findOversizedSleep } from "../src/core/integrations/bg-tasks/index.ts";
import { type BackgroundTask, getBackgroundTaskStore } from "../src/core/integrations/bg-tasks/store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("findOversizedSleep", () => {
	it("allows sleeps at or under the cap", () => {
		expect(findOversizedSleep("sleep 60 && make")).toBeUndefined();
		expect(findOversizedSleep("sleep 300 && make")).toBeUndefined();
		expect(findOversizedSleep("sleep 5m && make")).toBeUndefined();
	});

	it("rejects sleeps over the cap in any unit", () => {
		expect(findOversizedSleep("sleep 43201")?.seconds).toBe(43201);
		expect(findOversizedSleep("sleep 721m")?.seconds).toBe(43260);
		expect(findOversizedSleep("sleep 13h")?.seconds).toBe(46800);
		expect(findOversizedSleep("sleep 43200.5s")?.seconds).toBeCloseTo(43200.5);
	});

	it("finds oversized sleeps anywhere in a chain", () => {
		expect(findOversizedSleep("make && sleep 43201; echo done")?.seconds).toBe(43201);
		expect(findOversizedSleep("sleep 5 | cat && sleep 50000 | cat")?.seconds).toBe(50000);
	});

	it("finds oversized sleeps after shell keywords on one line", () => {
		expect(findOversizedSleep("while true; do sleep 43201; done")?.seconds).toBe(43201);
		expect(findOversizedSleep("if x; then sleep 50000; fi")?.seconds).toBe(50000);
		expect(findOversizedSleep("if x; then echo ok; else sleep 90000; fi")?.seconds).toBe(90000);
		expect(findOversizedSleep("while true; do sleep 60; done")).toBeUndefined();
	});

	it("ignores non-sleep usages", () => {
		expect(findOversizedSleep("echo sleep 999")).toBeUndefined(); // echo's argument
		expect(findOversizedSleep("asleep 999")).toBeUndefined();
		expect(findOversizedSleep("make install")).toBeUndefined();
	});
});

describe("multi-task completion merging", () => {
	let dir: string;

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "pi-bg-merge-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	function makeIntegration() {
		const followUps: string[] = [];
		const ctx = {
			cwd: dir,
			sessionManager: SessionManager.inMemory(),
			settingsManager: undefined,
			modelRuntime: undefined,
			getUI: () => ({ setWidget: () => {}, notify: () => {} }),
			getModel: () => undefined,
			getIntegration: () => undefined,
			sendFollowUp: (text: string) => followUps.push(text),
		} as never;
		const integration = new BackgroundTasksIntegration(ctx);
		return { integration, followUps };
	}

	function finishedTask(id: string): BackgroundTask {
		return {
			id,
			description: `task ${id}`,
			cwd: dir,
			status: "done",
			startTime: Date.now(),
			logFile: `${dir}/${id}.log`,
		};
	}

	it("merges multiple completions inside the window into ONE follow-up", () => {
		const store = getBackgroundTaskStore();
		const { followUps } = makeIntegration();

		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(
			finishedTask("a1"),
			"out1",
		);
		vi.advanceTimersByTime(400);
		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(
			finishedTask("a2"),
			"out2",
		);
		vi.advanceTimersByTime(400);
		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(
			finishedTask("a3"),
			"out3",
		);
		vi.advanceTimersByTime(2000);

		expect(followUps).toHaveLength(1);
		expect(followUps[0]).toContain("a1");
		expect(followUps[0]).toContain("a2");
		expect(followUps[0]).toContain("a3");
		expect(followUps[0]).toContain("3 background tasks completed");
		// Finished tasks are pruned immediately, so the merged batch must carry
		// each task's output inline (a /fg pointer would hit a deleted log).
		expect(followUps[0]).toContain("out1");
		expect(followUps[0]).toContain("out2");
		expect(followUps[0]).toContain("out3");
	});

	it("delivers a single completion with its output inline", () => {
		const store = getBackgroundTaskStore();
		const { followUps } = makeIntegration();

		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(
			finishedTask("solo"),
			"the-output",
		);
		vi.advanceTimersByTime(2000);

		expect(followUps).toHaveLength(1);
		expect(followUps[0]).toContain("solo");
		expect(followUps[0]).toContain("the-output");
	});

	it("separates completions further than the window apart", () => {
		const store = getBackgroundTaskStore();
		const { followUps } = makeIntegration();

		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(
			finishedTask("first"),
			"o1",
		);
		vi.advanceTimersByTime(2000);
		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(
			finishedTask("second"),
			"o2",
		);
		vi.advanceTimersByTime(2000);

		expect(followUps).toHaveLength(2);
	});
});
