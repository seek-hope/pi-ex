/**
 * Regression test: commitWorktree must succeed even when no git identity
 * (user.name/user.email) is configured anywhere. Otherwise cleanupFailedRun
 * in the subagent manager loses the agent's partial work: the commit fails,
 * hasBranchCommits() is false, and the worktree is deleted.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	commitWorktree,
	createWorktree,
	ensureGitRepo,
	git,
	hasBranchCommits,
} from "../src/core/integrations/subagent/worktree.ts";

let root: string;
let fakeHome: string;
const origHome = process.env.HOME;
const origNoSys = process.env.GIT_CONFIG_NOSYSTEM;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
	fakeHome = mkdtempSync(join(tmpdir(), "pi-worktree-home-"));
	// Isolate git config: no system config, fake empty HOME.
	process.env.HOME = fakeHome;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
	process.env.HOME = origHome;
	if (origNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = origNoSys;
	rmSync(root, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("subagent worktree: commit identity fallback", () => {
	const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(IDENTITY_ENV.map((k) => [k, process.env[k]]));
	});

	afterEach(() => {
		for (const k of IDENTITY_ENV) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	function setEnvIdentity(name: string, email: string): void {
		process.env.GIT_AUTHOR_NAME = name;
		process.env.GIT_AUTHOR_EMAIL = email;
		process.env.GIT_COMMITTER_NAME = name;
		process.env.GIT_COMMITTER_EMAIL = email;
	}

	function clearEnvIdentity(): void {
		for (const k of IDENTITY_ENV) delete process.env[k];
	}

	it("commits partial work even when git identity is not configured", () => {
		// Identity present (via env — `git config --global` fails under
		// test.sh's GIT_CONFIG_GLOBAL=/dev/null) for repo setup only…
		setEnvIdentity("Test", "test@example.com");
		ensureGitRepo(root);
		const wt = createWorktree(root, "sa-ident-000");
		writeFileSync(join(wt, "partial.txt"), "partial work\n");

		// …then the identity vanishes (fresh machine, removed config, …).
		clearEnvIdentity();

		const res = commitWorktree(wt, "sa-ident-000", "task without identity");
		expect(res.ok).toBe(true);
		expect(res.hash).not.toBe("");
		// The branch must carry the commit so cleanupFailedRun keeps the
		// worktree instead of deleting the partial work.
		expect(hasBranchCommits(root, "sa-ident-000")).toBe(true);
	});

	it("still prefers the configured identity when one exists", () => {
		setEnvIdentity("Real User", "real@example.com");
		ensureGitRepo(root);
		const wt = createWorktree(root, "sa-ident-001");
		writeFileSync(join(wt, "work.txt"), "work\n");

		const res = commitWorktree(wt, "sa-ident-001", "task with identity");
		expect(res.ok).toBe(true);
		const author = git(["log", "-1", "--format=%an <%ae>", "pi/subagent/sa-ident-001"], root).trim();
		expect(author).toBe("Real User <real@example.com>");
	});
});
