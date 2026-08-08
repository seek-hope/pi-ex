/**
 * Tests for bash pipefail semantics: per-stage PIPESTATUS capture,
 * SIGPIPE tolerance, marker stripping, and stage-labelled failures.
 */

import type { TextContent } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	classifyPipestatus,
	createBashTool,
	extractPipestatus,
	PIPESTATUS_MARKER,
	splitPipeStages,
} from "../src/core/tools/bash.ts";

describe("classifyPipestatus", () => {
	it("passes when all stages succeed", () => {
		expect(classifyPipestatus([0])).toBeNull();
		expect(classifyPipestatus([0, 0, 0])).toBeNull();
	});

	it("fails on a single non-zero command", () => {
		expect(classifyPipestatus([1])).toEqual({ stageIndex: 0, code: 1, stageCount: 1 });
	});

	it("catches a masked mid-pipeline failure", () => {
		// `false | true` — last stage succeeds, but the producer failed.
		expect(classifyPipestatus([1, 0])).toEqual({ stageIndex: 0, code: 1, stageCount: 2 });
		expect(classifyPipestatus([0, 2, 0])).toEqual({ stageIndex: 1, code: 2, stageCount: 3 });
	});

	it("tolerates SIGPIPE-killed producers (early consumer)", () => {
		// `yes | head -1` — yes dies of SIGPIPE, head succeeds: intended idiom.
		expect(classifyPipestatus([141, 0])).toBeNull();
		expect(classifyPipestatus([141, 0, 0])).toBeNull();
	});

	it("does not tolerate a SIGPIPE-killed last stage", () => {
		expect(classifyPipestatus([0, 141])).toEqual({ stageIndex: 1, code: 141, stageCount: 2 });
	});

	it("reports the meaningful failure, not the SIGPIPE casualty", () => {
		// Producer SIGPIPEd because grep exited 1 without reading everything.
		expect(classifyPipestatus([141, 1])).toEqual({ stageIndex: 1, code: 1, stageCount: 2 });
	});
});

describe("extractPipestatus", () => {
	it("strips the marker and parses stage codes", () => {
		const { content, stages } = extractPipestatus(`hello\n${PIPESTATUS_MARKER}0 1 0\n`);
		expect(content).toBe("hello");
		expect(stages).toEqual([0, 1, 0]);
	});

	it("returns undefined stages without a marker", () => {
		const { content, stages } = extractPipestatus("plain output");
		expect(content).toBe("plain output");
		expect(stages).toBeUndefined();
	});
});

describe("splitPipeStages", () => {
	it("splits on pipes", () => {
		expect(splitPipeStages("a | b | c")).toEqual(["a", "b", "c"]);
	});

	it("ignores pipes inside quotes and || operators", () => {
		expect(splitPipeStages(`echo "a|b" | wc -c`)).toEqual(['echo "a|b"', "wc -c"]);
		expect(splitPipeStages("a || b | c")).toEqual(["a || b", "c"]);
	});
});

describe("bash pipefail execution", () => {
	const bashTool = createBashTool(process.cwd());

	async function run(command: string): Promise<{ text: string; error?: string }> {
		try {
			const result = await bashTool.execute("call-1", { command });
			const text = result.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return { text };
		} catch (err) {
			return { text: "", error: err instanceof Error ? err.message : String(err) };
		}
	}

	it("fails a pipeline whose producer failed even when the consumer succeeds", async () => {
		const { error } = await run("false | true");
		expect(error).toContain("Pipeline stage 1/2 failed with code 1");
		expect(error).toContain("`false`");
	});

	it("fails on last-stage failure with the stage label", async () => {
		const { error } = await run("echo hi | false");
		expect(error).toContain("Pipeline stage 2/2 failed with code 1");
	});

	it("passes a SIGPIPE-tolerated idiom", async () => {
		const { text, error } = await run("yes | head -1");
		expect(error).toBeUndefined();
		expect(text).toBe("y\n");
	});

	it("keeps single-command exit semantics", async () => {
		const { error } = await run("exit 3");
		expect(error).toContain("Command exited with code 3");
	});

	it("succeeds and hides the marker on normal output", async () => {
		const { text, error } = await run("echo hello | tr a-z A-Z");
		expect(error).toBeUndefined();
		expect(text).toBe("HELLO\n");
		expect(text).not.toContain(PIPESTATUS_MARKER);
	});

	it("labels the failing stage in multi-stage chains", async () => {
		const { error } = await run("echo x | false | cat");
		expect(error).toContain("Pipeline stage 2/3 failed with code 1");
	});
});
