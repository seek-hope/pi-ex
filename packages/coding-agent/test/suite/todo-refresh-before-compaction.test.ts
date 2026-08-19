import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { TodoIntegration } from "../../src/core/integrations/todo/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

async function createCompactionHarness(): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentRounds: 1, quality: "standard" } },
	});
	harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return harness;
}

function todoStore(harness: Harness): TodoIntegration["store"] {
	const integration = harness.session.getIntegration<TodoIntegration>("todo");
	if (!integration) throw new Error("todo integration missing");
	return integration.store;
}

function reminderPresent(harness: Harness): boolean {
	const branch = harness.session.sessionManager.getBranch();
	return branch.some((entry) => JSON.stringify(entry).toLowerCase().includes("update your todo list"));
}

describe("todo refresh before compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs a refresh turn before auto-compaction when todos are unfinished", async () => {
		const harness = await createCompactionHarness();
		harnesses.push(harness);
		todoStore(harness).replaceFromModel([{ content: "finish the widget" }]);
		// Refresh turn + summarization (plain or split turn) + headroom for a
		// misbehaving nested compaction — an extra LLM call fails the test.
		harness.appendResponses([
			fauxAssistantMessage("todo updated"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("summary two"),
			fauxAssistantMessage("summary three"),
		]);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		expect(reminderPresent(harness)).toBe(true);
		expect(
			todoStore(harness)
				.getModelItems()
				.map((i) => i.content),
		).toContain("finish the widget");
	});

	it("skips the refresh turn when all model todos are completed", async () => {
		const harness = await createCompactionHarness();
		harnesses.push(harness);
		todoStore(harness).replaceFromModel([{ content: "done work", status: "completed" }]);
		// Only summarization should run; a refresh turn would consume an extra
		// response and trip the pending count assertion.
		harness.appendResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("summary two")]);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		expect(reminderPresent(harness)).toBe(false);
	});

	it("runs a refresh turn before manual compact()", async () => {
		const harness = await createCompactionHarness();
		harnesses.push(harness);
		todoStore(harness).replaceFromModel([{ content: "manual task" }]);
		harness.appendResponses([
			fauxAssistantMessage("todo updated"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("summary two"),
		]);

		await harness.session.compact();

		expect(reminderPresent(harness)).toBe(true);
		expect(
			todoStore(harness)
				.getModelItems()
				.map((i) => i.content),
		).toContain("manual task");
	});

	it("skips the refresh turn on overflow auto-compaction even with unfinished todos", async () => {
		const harness = await createCompactionHarness();
		harnesses.push(harness);
		todoStore(harness).replaceFromModel([{ content: "overflow must not refresh" }]);
		// Only summarization should run; a refresh turn would consume an extra
		// response and trip the pending count assertion.
		harness.appendResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("summary two")]);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("overflow", false);

		expect(reminderPresent(harness)).toBe(false);
	});

	it("caps the refresh turn's output budget so the request cannot fill the window", async () => {
		const harness = await createCompactionHarness();
		harnesses.push(harness);
		todoStore(harness).replaceFromModel([{ content: "finish the widget" }]);
		harness.appendResponses([fauxAssistantMessage("todo updated"), fauxAssistantMessage("summary")]);

		// Capture every LLM request made during compaction. The refresh turn is
		// identified by the reminder as its last message; the summarization call
		// sends a single serialized-conversation message instead.
		const captured: Array<{ maxTokens: number | undefined; lastText: string; messageCount: number }> = [];
		const originalStreamFn = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = ((model, context, options) => {
			const last = context.messages[context.messages.length - 1];
			const lastText =
				last && typeof last.content !== "string"
					? last.content
							.filter((b) => b.type === "text")
							.map((b) => (b as { type: "text"; text: string }).text)
							.join("\n")
					: typeof last?.content === "string"
						? last.content
						: "";
			captured.push({ maxTokens: options?.maxTokens, lastText, messageCount: context.messages.length });
			return originalStreamFn(model, context, options);
		}) as typeof harness.session.agent.streamFunction;

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		const refreshCall = captured.find(
			(c) => c.messageCount > 1 && c.lastText.includes("Session compaction is about to start"),
		);
		expect(refreshCall).toBeDefined();
		expect(refreshCall?.maxTokens).toBe(4096);
	});

	it("skips the refresh turn when even the capped request would not fit the window", async () => {
		const harness = await createCompactionHarness();
		harnesses.push(harness);
		todoStore(harness).replaceFromModel([{ content: "no room to refresh" }]);
		harness.appendResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("summary two")]);

		// Shrink the window on a per-session model copy: the full-context refresh
		// request (estimate + capped output budget + safety margin) cannot fit.
		const model = harness.session.agent.state.model;
		if (!model) throw new Error("no model");
		harness.session.agent.state.model = { ...model, contextWindow: 8192 };

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		expect(reminderPresent(harness)).toBe(false);
	});
});
