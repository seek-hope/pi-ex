import { readFile, rm, writeFile } from "node:fs/promises";

/**
 * Records the model's file mutations (edit/write tools) with full before/after
 * content so /tree navigation can revert files alongside the transcript.
 *
 * Bash-driven mutations are intentionally untracked (the shell may touch
 * arbitrary paths); reverting those is out of scope, matching Claude Code's
 * /rewind behavior for shell-side changes.
 *
 * History is session-memory only: after a restart, /tree navigation reverts
 * nothing until new mutations are recorded.
 */
export interface FileChangeRecord {
	/** Absolute file path. */
	file: string;
	/** Content before the mutation; null means the file did not exist. */
	contentBefore: string | null;
	/** Content after the mutation; null means the file was deleted. */
	contentAfter: string | null;
	/**
	 * The tree entry that was the leaf while the mutation ran. A mutation
	 * tagged with entry E happened "on the edge after E": rewinding to a
	 * point where E is the leaf (or further back) must undo it.
	 */
	entryId: string;
	/** Monotonic sequence number (append order). */
	seq: number;
}

export interface FileRevertResult {
	/** Files restored to their state at the target point. */
	reverted: string[];
	/** Files skipped because their on-disk content changed outside the tracked tools. */
	skipped: string[];
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

export class FileChangeHistory {
	private records: FileChangeRecord[] = [];
	private seq = 0;
	/** Resolves the current tree leaf at mutation time. */
	getLeafId: () => string | null = () => null;

	record(file: string, contentBefore: string | null, contentAfter: string | null): void {
		if (contentBefore === contentAfter) return; // no-op mutation
		const entryId = this.getLeafId();
		if (!entryId) return;
		this.records.push({ file, contentBefore, contentAfter, entryId, seq: this.seq++ });
	}

	/** Number of tracked mutations (tests/diagnostics). */
	get size(): number {
		return this.records.length;
	}

	/**
	 * Revert all files mutated after `leafId` was the tree leaf, restoring the
	 * state each file had at that point. `pathIds` is the id set on the path
	 * root → leafId (ancestor-or-self).
	 *
	 * A record tagged E is "after" the target unless E is a strict ancestor of
	 * leafId. Rewinding to a user entry therefore also undoes that turn's own
	 * mutations; rewinding to an assistant entry keeps the whole turn.
	 */
	async revertTo(pathIds: ReadonlySet<string>, leafId: string | null): Promise<FileRevertResult> {
		const after = this.records.filter((r) => !pathIds.has(r.entryId) || r.entryId === leafId);
		const reverted: string[] = [];
		const skipped: string[] = [];

		const byFile = new Map<string, FileChangeRecord[]>();
		for (const record of after) {
			const list = byFile.get(record.file) ?? [];
			list.push(record);
			byFile.set(record.file, list);
		}

		for (const [file, recs] of byFile) {
			recs.sort((a, b) => a.seq - b.seq);
			const earliest = recs[0];
			const latest = recs[recs.length - 1];

			// Safety: never clobber changes made outside the tracked tools.
			let current: string | null = null;
			try {
				current = await readFile(file, "utf8");
			} catch (error) {
				if (!isMissingPathError(error)) throw error;
			}
			if (current !== latest.contentAfter) {
				skipped.push(file);
				continue;
			}

			try {
				if (earliest.contentBefore === null) {
					await rm(file, { force: true });
				} else {
					await writeFile(file, earliest.contentBefore, "utf8");
				}
				reverted.push(file);
			} catch {
				skipped.push(file);
			}
		}

		// The timeline now starts at leafId: records from the abandoned part
		// of the tree are moot. Keep only strict-ancestor records.
		this.records = this.records.filter((r) => pathIds.has(r.entryId) && r.entryId !== leafId);
		return { reverted, skipped };
	}
}
