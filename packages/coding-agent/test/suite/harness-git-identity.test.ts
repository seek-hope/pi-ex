/**
 * Regression: the harness must guarantee a USABLE git identity.
 *
 * The GIT_AUTHOR_/GIT_COMMITTER_ env vars are filled with the pi-test fallback when
 * unset — and also when set to an EMPTY string. `??=` kept empty strings,
 * and git rejects an empty ident ("empty ident name ..."), breaking every
 * git-using suite test (subagent) under such an environment. Non-empty
 * ambient values are intentionally preserved (they still produce valid
 * commits in the throwaway test repos).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;

describe("suite harness git identity", () => {
	const saved: Record<string, string | undefined> = {};
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.cleanup();
		harness = undefined;
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	function saveAndSet(values: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
		for (const k of KEYS) {
			saved[k] = process.env[k];
			const v = values[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}

	it("empty-string ambient GIT_AUTHOR_* is replaced with the fallback", async () => {
		saveAndSet({ GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" });
		harness = await createHarness();
		expect(process.env.GIT_AUTHOR_NAME).toBe("pi-test");
		expect(process.env.GIT_AUTHOR_EMAIL).toBe("pi-test@example.com");
		expect(process.env.GIT_COMMITTER_NAME).toBe("pi-test");
		expect(process.env.GIT_COMMITTER_EMAIL).toBe("pi-test@example.com");
	});

	it("unset GIT_AUTHOR_* gets the fallback", async () => {
		saveAndSet({});
		harness = await createHarness();
		expect(process.env.GIT_AUTHOR_NAME).toBe("pi-test");
	});

	it("non-empty ambient GIT_AUTHOR_* is preserved", async () => {
		saveAndSet({ GIT_AUTHOR_NAME: "ambient-dev" });
		harness = await createHarness();
		expect(process.env.GIT_AUTHOR_NAME).toBe("ambient-dev");
	});
});
