import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskStore } from "../src/core/integrations/bg-tasks/store.ts";

describe("bg task immediate pruning", () => {
	let dir: string;
	let finishedCount = 0;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-prune-"));
		finishedCount = 0;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function createStore(): BackgroundTaskStore {
		const s = new BackgroundTaskStore(dir);
		s.subscribe({ onChange: () => {}, onNotify: () => {}, onTaskFinished: () => finishedCount++ });
		return s;
	}

	/** Write the on-disk shape of a finished task (log with EXIT_CODE + script). */
	function writeFinishedTask(id: string, code: number): void {
		writeFileSync(join(dir, `${id}.log`), `output for ${id}\nEXIT_CODE=${code}\n`);
		writeFileSync(join(dir, `${id}.sh`), `#!/bin/sh\necho ${id}\n`);
	}

	it("recovers a finished orphan on sync, notifies, and prunes it immediately", async () => {
		writeFinishedTask("task-aaaa0000-000", 0);
		const s = createStore();
		await s.sync();
		// Recovered -> notified -> pruned: no finished task may linger.
		expect(s.list()).toHaveLength(0);
		expect(finishedCount).toBe(1);
		expect(existsSync(join(dir, "task-aaaa0000-000.log"))).toBe(false);
		expect(existsSync(join(dir, "task-aaaa0000-000.sh"))).toBe(false);
	});

	it("prunes failed orphans too (non-zero exit)", async () => {
		writeFinishedTask("task-bbbb0000-000", 1);
		const s = createStore();
		await s.sync();
		expect(s.list()).toHaveLength(0);
		expect(existsSync(join(dir, "task-bbbb0000-000.log"))).toBe(false);
	});

	it("silently prunes finished records loaded from disk on sync", async () => {
		// A finished record in tasks.json (no notification this session) is
		// pruned without emitting onTaskFinished.
		writeFileSync(
			join(dir, "tasks.json"),
			JSON.stringify([
				{
					id: "task-cccc0000-000",
					description: "old",
					cwd: dir,
					status: "done",
					startTime: Date.now() - 60_000,
					endTime: Date.now() - 30_000,
					exitCode: 0,
					logFile: join(dir, "task-cccc0000-000.log"),
				},
			]),
		);
		writeFileSync(join(dir, "task-cccc0000-000.log"), "old output\nEXIT_CODE=0\n");
		const s = createStore();
		await s.sync();
		expect(s.list()).toHaveLength(0);
		expect(finishedCount).toBe(0);
		expect(existsSync(join(dir, "task-cccc0000-000.log"))).toBe(false);
	});
});
