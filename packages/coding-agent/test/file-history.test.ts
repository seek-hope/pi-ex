/**
 * Unit tests for FileChangeHistory — the /tree file-revert bookkeeping.
 *
 * Covers record dedupe, turn-boundary semantics (strict-ancestor rule),
 * new-file deletion, external-modification skip, and post-revert pruning.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileChangeHistory } from "../src/core/file-history.ts";

describe("FileChangeHistory", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "file-history-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("ignores no-op mutations and mutations without a leaf entry", () => {
		const history = new FileChangeHistory();
		history.getLeafId = () => null;
		history.record("/tmp/a.txt", "same", "same");
		history.record("/tmp/a.txt", "x", "y");
		expect(history.size).toBe(0);

		history.getLeafId = () => "u1";
		history.record("/tmp/a.txt", "same", "same");
		expect(history.size).toBe(0);
	});

	it("reverts a turn's own mutation when rewinding to the user entry", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "v0", "utf8");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u1";
		history.record(file, "v0", "v1");
		await writeFile(file, "v1", "utf8");

		// Path root -> u1: {u1}. Rewinding to u1 (leaf = u1) reverts the turn.
		const result = await history.revertTo(new Set(["u1"]), "u1");
		expect(result.reverted).toEqual([file]);
		expect(result.skipped).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("v0");
		expect(history.size).toBe(0);
	});

	it("keeps the whole turn when rewinding to the assistant entry", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "v0", "utf8");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u1";
		history.record(file, "v0", "v1");
		await writeFile(file, "v1", "utf8");
		// Second mutation tagged with the first toolResult entry.
		history.getLeafId = () => "r1";
		history.record(file, "v1", "v2");
		await writeFile(file, "v2", "utf8");

		// Path root -> u1 -> r1 -> a1: rewinding to the assistant keeps all.
		const result = await history.revertTo(new Set(["u1", "r1", "a1"]), "a1");
		expect(result.reverted).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("v2");
		expect(history.size).toBe(2);
	});

	it("reverts only mutations after a mid-turn toolResult target", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "v0", "utf8");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u1";
		history.record(file, "v0", "v1");
		await writeFile(file, "v1", "utf8");
		history.getLeafId = () => "r1";
		history.record(file, "v1", "v2");
		await writeFile(file, "v2", "utf8");

		// Rewind to r1 (the first toolResult): only the second mutation reverts.
		const result = await history.revertTo(new Set(["u1", "r1"]), "r1");
		expect(result.reverted).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("v1");
	});

	it("deletes files created after the target point", async () => {
		const file = join(dir, "new.txt");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u2";
		history.record(file, null, "created");
		await writeFile(file, "created", "utf8");

		const result = await history.revertTo(new Set(["u1"]), "u1");
		expect(result.reverted).toEqual([file]);
		await expect(readFile(file, "utf8")).rejects.toThrow();
	});

	it("skips files modified outside the tracked tools", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "v0", "utf8");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u1";
		history.record(file, "v0", "v1");
		await writeFile(file, "v1", "utf8");
		// External actor changes the file after the recorded mutation.
		await writeFile(file, "external", "utf8");

		const result = await history.revertTo(new Set(["u1"]), "u1");
		expect(result.skipped).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("external");
	});

	it("restores to the earliest pre-mutation state across multiple mutations", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "v0", "utf8");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u1";
		history.record(file, "v0", "v1");
		await writeFile(file, "v1", "utf8");
		history.getLeafId = () => "r1";
		history.record(file, "v1", "v2");
		await writeFile(file, "v2", "utf8");
		history.getLeafId = () => "u2";
		history.record(file, "v2", "v3");
		await writeFile(file, "v3", "utf8");

		// Rewind to u1: v1/v2/v3 mutations revert; file returns to v0.
		const result = await history.revertTo(new Set(["u1"]), "u1");
		expect(result.reverted).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("prunes abandoned-timeline records after a revert", async () => {
		const file = join(dir, "f.txt");
		await writeFile(file, "v0", "utf8");
		const history = new FileChangeHistory();
		history.getLeafId = () => "u1";
		history.record(file, "v0", "v1");
		await writeFile(file, "v1", "utf8");
		history.getLeafId = () => "u2";
		history.record(file, "v1", "v2");
		await writeFile(file, "v2", "utf8");

		// Rewind to u1: u2's record is abandoned.
		await history.revertTo(new Set(["u1"]), "u1");
		expect(history.size).toBe(0);
		expect(await readFile(file, "utf8")).toBe("v0");
	});
});
