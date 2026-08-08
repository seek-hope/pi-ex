/**
 * Regression test: the stale todo warning must actually be delivered to the
 * agent (agent.steer), not just pushed into the local steering mirror where
 * it sat forever — visible in the queue but never sent.
 *
 * Also covers: the warning reports the real staleness gap (previously it
 * always said "0 turns" because the activity timer was reset before the
 * message was composed), and the turn counter accumulates across runs
 * (previously it reset at every agent_start, so cross-run gaps never
 * reached the threshold).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ImageContent,
	type TextContent,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { TodoIntegration } from "../src/core/integrations/todo/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	/**
	 * CI-only watchdog: if the loop never consumes this stream (timing
	 * variance under load), force a done event after 5s so the test fails
	 * with a deterministic assertion instead of hanging into the 30s
	 * vitest timeout. Pushing after the stream completed is a no-op.
	 */
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		setTimeout(() => {
			this.push({ type: "done", reason: "stop", message: createAssistantMessage("") });
		}, 5_000);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userTextsOf(messages: Array<{ role: string; content: unknown }>): string[] {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => {
			if (typeof m.content === "string") return m.content;
			return (m.content as Array<TextContent | ImageContent>)
				.filter((p): p is TextContent => typeof p === "object" && p !== null && p.type === "text")
				.map((p) => p.text)
				.join("\n");
		});
}

describe("stale todo steering delivery", () => {
	let session: AgentSession;
	let tempDir: string;
	let sawWarningText: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-todo-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sawWarningText = undefined;
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(): Promise<void> {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, context) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const warning = userTextsOf(context.messages).find((t) => t.includes("todo list has not been updated"));
					if (warning) sawWarningText = warning;
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("delivers the warning to the agent and clears the steering queue", async () => {
		await createSession();
		const todo = session.getIntegration<TodoIntegration>("todo");
		expect(todo).toBeDefined();
		todo!.store.replaceFromModel([{ content: "unfinished task", status: "pending" }]);

		// One user prompt = one turn. The warning fires once the gap reaches 8.
		for (let i = 0; i < 7; i++) {
			await session.prompt(`msg ${i}`);
		}
		expect(sawWarningText).toBeUndefined();

		await session.prompt("msg 7");
		expect(sawWarningText).toContain("todo list has not been updated for the last 8 user inputs");
		expect(sawWarningText).toContain("unfinished task");
		// Delivered and drained — nothing left stuck in the steering queue.
		expect(session.getSteeringMessages()).toHaveLength(0);
		expect(session.pendingMessageCount).toBe(0);
	});

	it("does not count machine-delivered (extension-sourced) prompts as turns", async () => {
		await createSession();
		const todo = session.getIntegration<TodoIntegration>("todo");
		todo!.store.replaceFromModel([{ content: "unfinished task", status: "pending" }]);

		// 7 user prompts (count 1-7), then machine follow-ups — the count
		// must not advance, so no warning may fire yet.
		for (let i = 0; i < 7; i++) {
			await session.prompt(`msg ${i}`);
		}
		for (let i = 0; i < 3; i++) {
			await session.prompt(`machine ${i}`, { streamingBehavior: "followUp", source: "extension" });
		}
		expect(sawWarningText).toBeUndefined();

		// The next genuine user input reaches 8.
		await session.prompt("real user input");
		expect(sawWarningText).toContain("8 user inputs");
	});
});
