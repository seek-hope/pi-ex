/**
 * Tests for bg-task completion-notification session isolation.
 * The store is a process-wide singleton shared by all sessions — a
 * completion must reach only the session that spawned the task.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BackgroundTask, BackgroundTaskStore } from "../src/core/integrations/bg-tasks/store.ts";

function makeTask(sessionId?: string): BackgroundTask {
	return {
		id: `t-${Math.random().toString(36).slice(2, 8)}`,
		description: "test task",
		cwd: "/tmp",
		status: "done",
		startTime: Date.now(),
		logFile: "/tmp/x.log",
		sessionId,
	};
}

describe("bg task completion session isolation", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function setup() {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-iso-"));
		const store = new BackgroundTaskStore(dir);
		const received = { a: [] as string[], b: [] as string[] };
		store.subscribe(
			{ onChange: () => {}, onNotify: () => {}, onTaskFinished: (t) => received.a.push(t.id) },
			"session-A",
		);
		store.subscribe(
			{ onChange: () => {}, onNotify: () => {}, onTaskFinished: (t) => received.b.push(t.id) },
			"session-B",
		);
		return { store, received };
	}

	it("delivers a session-tagged task only to its owning session", () => {
		const { store, received } = setup();
		const task = makeTask("session-A");
		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(task, "out");
		expect(received.a).toEqual([task.id]);
		expect(received.b).toEqual([]);
	});

	it("broadcasts untagged (legacy disk-restored) tasks to all sessions", () => {
		const { store, received } = setup();
		const task = makeTask(undefined);
		(store as unknown as { emitFinished(t: BackgroundTask, o: string): void }).emitFinished(task, "out");
		expect(received.a).toEqual([task.id]);
		expect(received.b).toEqual([task.id]);
	});

	it("records sessionId on spawn and keeps it on the stored task", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-iso-"));
		const store = new BackgroundTaskStore(dir);
		const task = await store.spawn("echo hi", dir, 60_000, "session-A");
		expect(task.sessionId).toBe("session-A");
		// Cleanup: kill the tmux session so the test leaves nothing behind.
		await store.kill(task.id);
	});
});
