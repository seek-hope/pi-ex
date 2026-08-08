/**
 * Tests for the background task store (tmux-based).
 * Requires tmux — skipped when unavailable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BackgroundTask, BackgroundTaskStore } from "../src/core/integrations/bg-tasks/store.ts";

function hasTmux(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!hasTmux())("BackgroundTaskStore", () => {
	let tempDir: string;
	let store: BackgroundTaskStore;
	const createdTaskIds: string[] = [];

	async function spawnTracked(description: string, timeout = 60_000): Promise<BackgroundTask> {
		const task = await store.spawn(description, tempDir, timeout);
		createdTaskIds.push(task.id);
		return task;
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
		store = new BackgroundTaskStore(join(tempDir, "tasks"));
	});

	afterEach(async () => {
		for (const id of createdTaskIds.splice(0)) {
			try {
				await store.kill(id);
			} catch {
				/* best effort */
			}
			try {
				execFileSync("tmux", ["kill-session", "-t", id], { stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				/* already dead */
			}
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("spawns a task and detects successful completion", async () => {
		const task = await spawnTracked("echo hello-from-bg");
		expect(task.status).toBe("running");

		const finished = new Promise<BackgroundTask>((resolve) => {
			store.subscribe({
				onChange: () => {},
				onNotify: () => {},
				onTaskFinished: (t) => resolve(t),
			});
		});

		const done = await finished;
		expect(done.id).toBe(task.id);
		expect(done.status).toBe("done");

		// Finished tasks are pruned immediately (notification carried the
		// output) — the record and log no longer exist.
		expect(store.get(task.id)).toBeUndefined();
		expect(existsSync(task.logFile)).toBe(false);
	}, 30_000);

	it("marks failing commands as error and prunes them", async () => {
		const task = await spawnTracked("exit 3");
		// Completion notification carries the failure; the record is pruned.
		const finished = new Promise<BackgroundTask>((resolve) => {
			store.subscribe({
				onChange: () => {},
				onNotify: () => {},
				onTaskFinished: (t) => resolve(t),
			});
		});
		const done = await finished;
		expect(done.status).toBe("error");
		expect(done.exitCode).toBe(3);
		expect(store.get(task.id)).toBeUndefined();
	}, 30_000);

	it("deduplicates identical running tasks (same description + cwd)", async () => {
		const a = await spawnTracked("sleep 30");
		const b = await spawnTracked("sleep 30");
		expect(b.id).toBe(a.id);
	}, 30_000);

	it("dedup adoption registers the second session and refreshes the label", async () => {
		const a = await store.spawn("sleep 30", tempDir, 60_000, "session-a", "first label");
		const b = await store.spawn("sleep 30", tempDir, 60_000, "session-b", "second label");
		expect(b.id).toBe(a.id);
		expect(b.label).toBe("second label");
		expect(b.sessionId).toBe("session-a");
		expect(b.sessionIds).toEqual(["session-a", "session-b"]);
	}, 30_000);

	it("kills a running task and prunes it", async () => {
		const task = await spawnTracked("sleep 300");
		expect(await store.kill(task.id)).toBe(true);
		expect(store.get(task.id)).toBeUndefined();
		expect(await store.kill("task-nonexistent")).toBe(false);
	}, 30_000);

	it("rejects invalid task ids in kill (path traversal guard)", async () => {
		expect(await store.kill("../etc")).toBe(false);
		expect(await store.kill("not a task")).toBe(false);
	});

	it("finalizes status from the log's last EXIT_CODE marker", async () => {
		// Simulate a completed task whose tmux session is gone: a tasks.json entry
		// still marked running plus a log containing the exit marker.
		const id = "task-finalize-test";
		const dir = join(tempDir, "tasks-finalize");
		mkdirSync(dir, { recursive: true });
		const logFile = join(dir, `${id}.log`);
		writeFileSync(logFile, "EXIT_CODE=1\nsome output\nEXIT_CODE=0\n", "utf-8");
		writeFileSync(
			join(dir, "tasks.json"),
			JSON.stringify([{ id, description: "fake", cwd: tempDir, status: "running", startTime: Date.now(), logFile }]),
			"utf-8",
		);
		const finalizeStore = new BackgroundTaskStore(dir);

		const task = finalizeStore.get(id)!;
		const output = await finalizeStore.finalizeTaskOutput(task);
		expect(task.status).toBe("done");
		expect(task.exitCode).toBe(0);
		expect(output).toContain("some output");
	});

	it("recovers orphaned tasks from log files on sync and prunes them", async () => {
		// Plant an orphaned completed task: .log + .sh, no tasks.json entry.
		const id = "task-orphan-test";
		mkdirSync(join(tempDir, "tasks"), { recursive: true });
		writeFileSync(join(tempDir, "tasks", `${id}.log`), "recovered output\nEXIT_CODE=0\n", "utf-8");
		writeFileSync(join(tempDir, "tasks", `${id}.sh`), "echo recovered", "utf-8");

		const finished: BackgroundTask[] = [];
		store.subscribe({
			onChange: () => {},
			onNotify: () => {},
			onTaskFinished: (t) => finished.push(t),
		});
		await store.sync();

		// Recovered -> notified -> pruned.
		expect(store.get(id)).toBeUndefined();
		expect(finished.some((t) => t.id === id)).toBe(true);
		expect(existsSync(join(tempDir, "tasks", `${id}.log`))).toBe(false);
	});

	it("loads gracefully from a non-array tasks.json (e.g. leftover {})", () => {
		mkdirSync(join(tempDir, "tasks"), { recursive: true });
		writeFileSync(join(tempDir, "tasks", "tasks.json"), "{}", "utf-8");
		const reloaded = new BackgroundTaskStore(join(tempDir, "tasks"));
		// Should not throw; store starts empty.
		expect(reloaded.list().length).toBe(0);
	});
});
