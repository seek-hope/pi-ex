import { describe, expect, it, vi } from "vitest";
import { classifyBashGateCommand, parseSleepCommand } from "../src/core/bash-gate.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import type { WaitScheduleResult } from "../src/core/tools/wait.ts";

describe("parseSleepCommand", () => {
	it("parses plain durations", () => {
		expect(parseSleepCommand("sleep 60")).toEqual({ kind: "pure", seconds: 60 });
		expect(parseSleepCommand("sleep 0.5")).toEqual({ kind: "pure", seconds: 0.5 });
	});

	it("parses GNU suffixes", () => {
		expect(parseSleepCommand("sleep 1m")).toEqual({ kind: "pure", seconds: 60 });
		expect(parseSleepCommand("sleep 1h")).toEqual({ kind: "pure", seconds: 3600 });
		expect(parseSleepCommand("sleep 1d")).toEqual({ kind: "pure", seconds: 86400 });
		expect(parseSleepCommand("sleep 1.5h")).toEqual({ kind: "pure", seconds: 5400 });
	});

	it("sums multiple time arguments", () => {
		expect(parseSleepCommand("sleep 1m 30s")).toEqual({ kind: "pure", seconds: 90 });
		expect(parseSleepCommand("sleep 5 5")).toEqual({ kind: "pure", seconds: 10 });
	});

	it("strips sudo, env, and path prefixes", () => {
		expect(parseSleepCommand("sudo sleep 5")).toEqual({ kind: "pure", seconds: 5 });
		expect(parseSleepCommand("env FOO=bar sleep 2")).toEqual({ kind: "pure", seconds: 2 });
		expect(parseSleepCommand("/usr/bin/sleep 3")).toEqual({ kind: "pure", seconds: 3 });
	});

	it("allows a trailing semicolon", () => {
		expect(parseSleepCommand("sleep 5;")).toEqual({ kind: "pure", seconds: 5 });
	});

	it("classifies mixed commands as mixed", () => {
		expect(parseSleepCommand("sleep 5 && npm build")).toEqual({ kind: "mixed" });
		expect(parseSleepCommand("sleep $VAR")).toEqual({ kind: "mixed" });
		expect(parseSleepCommand("sleep 2m; make")).toEqual({ kind: "mixed" });
	});

	it("classifies non-sleep commands as unparseable", () => {
		expect(parseSleepCommand("npm build && sleep 5")).toEqual({ kind: "unparseable" });
		expect(parseSleepCommand("echo x; sleep 3")).toEqual({ kind: "unparseable" });
	});

	it("classifies malformed pure sleeps as unparseable", () => {
		expect(parseSleepCommand("sleep 5 5.5.5")).toEqual({ kind: "unparseable" });
	});
});

describe("classifyBashGateCommand", () => {
	it("maps pure sleep to wait", () => {
		expect(classifyBashGateCommand("sleep 60", "sleep-command")).toEqual({ kind: "wait", seconds: 60 });
	});

	it("maps mixed sleep to bg", () => {
		expect(classifyBashGateCommand("sleep 2 && npm build", "sleep-command")).toEqual({ kind: "bg" });
		expect(classifyBashGateCommand("sleep $VAR", "sleep-command")).toEqual({ kind: "bg" });
	});

	it("keeps non-sleep-leading commands on the gate", () => {
		expect(classifyBashGateCommand("npm build && sleep 5", "sleep-command")).toEqual({ kind: "gate" });
	});

	it("maps polling loops and watch to bg", () => {
		expect(classifyBashGateCommand("while true; do sleep 1; done", "while-poll-loop")).toEqual({ kind: "bg" });
		expect(classifyBashGateCommand("watch -n 2 ls", "watch-command")).toEqual({ kind: "bg" });
	});

	it("keeps other rules on the gate", () => {
		expect(classifyBashGateCommand("cat x", "cat-file")).toEqual({ kind: "gate" });
	});
});

describe("bash tool sleep auto-conversion", () => {
	function waitScheduler(results: WaitScheduleResult[]) {
		return vi.fn(
			(_seconds: number, _opts?: { clamp?: boolean }): WaitScheduleResult =>
				results.shift() ?? { ok: false, error: "no more results" },
		);
	}

	it("converts a pure sleep into a wait with terminate", async () => {
		const schedule = waitScheduler([{ ok: true, message: "Waiting 60s." }]);
		const tool = createBashTool("/tmp", { waitSchedule: schedule });
		const result = await tool.execute("t1", { command: "sleep 60" });
		expect(schedule).toHaveBeenCalledWith(60, { clamp: true });
		expect(result.terminate).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: "Waiting 60s." });
	});

	it("passes through a clamped wait message", async () => {
		const schedule = waitScheduler([
			{ ok: true, message: "Waiting 120s (capped at 120s — the wait limit for this session)." },
		]);
		const tool = createBashTool("/tmp", { waitSchedule: schedule });
		const result = await tool.execute("t1", { command: "sleep 1000" });
		expect(schedule).toHaveBeenCalledWith(1000, { clamp: true });
		expect(result.terminate).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Waiting 120s (capped at 120s — the wait limit for this session).",
		});
	});

	it("falls back to the gate response when the wait scheduler rejects", async () => {
		const schedule = waitScheduler([
			{ ok: false, error: "Headless wait limit reached: 5 waits per session. Continue without waiting." },
		]);
		const tool = createBashTool("/tmp", { waitSchedule: schedule });
		const result = await tool.execute("t1", { command: "sleep 60" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[BLOCKED]") });
	});

	it("converts a mixed sleep command into a background task", async () => {
		const spawnBg = vi.fn(async (_task: string, _label?: string) => ({ id: "task-x1", logFile: "/tmp/task-x1.log" }));
		const tool = createBashTool("/tmp", { spawnBg });
		const result = await tool.execute("t1", { command: "sleep 2 && npm build" });
		expect(spawnBg).toHaveBeenCalledWith("sleep 2 && npm build", "sleep 2 && npm build");
		const text = result.content[0];
		expect(text).toMatchObject({ type: "text" });
		if (text.type !== "text") throw new Error("expected text content");
		expect(text.text).toContain("Converted to a background task");
		expect(text.text).toContain("ID: task-x1");
		expect(text.text).toContain("Log: /tmp/task-x1.log");
	});

	it("converts polling loops into background tasks", async () => {
		const spawnBg = vi.fn(async (_task: string) => ({ id: "task-y1", logFile: "/tmp/task-y1.log" }));
		const tool = createBashTool("/tmp", { spawnBg });
		const result = await tool.execute("t1", { command: "while true; do sleep 1; done" });
		expect(spawnBg).toHaveBeenCalled();
		const text = result.content[0];
		expect(text).toMatchObject({ type: "text" });
		if (text.type !== "text") throw new Error("expected text content");
		expect(text.text).toContain("Converted to a background task");
	});

	it("falls back to the gate response for oversized background sleeps", async () => {
		const spawnBg = vi.fn(async (_task: string) => ({ id: "task-z1", logFile: "/tmp/task-z1.log" }));
		const tool = createBashTool("/tmp", { spawnBg });
		const result = await tool.execute("t1", { command: "sleep 50000 && npm build" });
		expect(spawnBg).not.toHaveBeenCalled();
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[BLOCKED]") });
	});

	it("falls back to the gate response without conversion hooks", async () => {
		const tool = createBashTool("/tmp");
		const result = await tool.execute("t1", { command: "sleep 60" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[BLOCKED]") });
	});

	it("falls back to the gate response when spawnBg throws", async () => {
		const spawnBg = vi.fn(async () => {
			throw new Error("no tmux");
		});
		const tool = createBashTool("/tmp", { spawnBg });
		const result = await tool.execute("t1", { command: "sleep 2 && make" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[BLOCKED]") });
	});

	it("leaves non-sleep gate rules untouched", async () => {
		const spawnBg = vi.fn(async (_task: string) => ({ id: "task-w1", logFile: "/tmp/task-w1.log" }));
		const tool = createBashTool("/tmp", { spawnBg });
		const result = await tool.execute("t1", { command: "cat > /tmp/task-w1.out" });
		expect(spawnBg).not.toHaveBeenCalled();
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("[BLOCKED]") });
	});
});
