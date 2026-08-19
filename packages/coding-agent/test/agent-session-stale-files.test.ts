/**
 * The stale-file delta notice must actually reach the agent (via agent.steer),
 * like the stale-todo warning — not just sit in the steering mirror. Also
 * covers: relative paths in the notice, notified files not re-reported, and
 * a re-read clearing the stale mark.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { FileContextTracker } from "../src/core/file-context.ts";
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

describe("stale-file steering delivery", () => {
	let session: AgentSession;
	let tempDir: string;
	let sawFileStateText: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-file-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sawFileStateText = undefined;
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
					// Only the last user message belongs to this turn — earlier turns'
					// steering notices stay in the transcript and must not count.
					const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
					if (lastUser) {
						const notice = userTextsOf([lastUser]).find((t) => t.includes("[file-state]"));
						if (notice) sawFileStateText = notice;
					}
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

	function tracker(): FileContextTracker {
		return (session as unknown as { _fileContextTracker: FileContextTracker })._fileContextTracker;
	}

	it("delivers the delta notice for a changed file and drains the steering queue", async () => {
		await createSession();
		const filePath = join(tempDir, "seen.txt");
		writeFileSync(filePath, "v1");
		tracker().markRead(filePath, "v1");
		tracker().noteExternalChange(filePath);

		await session.prompt("msg 1");
		expect(sawFileStateText).toContain("[file-state]");
		expect(sawFileStateText).toContain("seen.txt");
		expect(sawFileStateText).toContain("Re-read them");
		// Delivered and drained — nothing left stuck in the steering queue.
		expect(session.getSteeringMessages()).toHaveLength(0);
		expect(session.pendingMessageCount).toBe(0);
	});

	it("does not re-report a notified file until it changes again", async () => {
		await createSession();
		const filePath = join(tempDir, "seen.txt");
		writeFileSync(filePath, "v1");
		tracker().markRead(filePath, "v1");
		tracker().noteExternalChange(filePath);

		await session.prompt("msg 1");
		expect(sawFileStateText).toContain("[file-state]");

		// Second prompt without further changes: no repeat notice.
		sawFileStateText = undefined;
		await session.prompt("msg 2");
		expect(sawFileStateText).toBeUndefined();

		// The file changes again → the notice fires once more.
		tracker().noteExternalChange(filePath);
		await session.prompt("msg 3");
		expect(sawFileStateText).toContain("[file-state]");
	});

	it("a fresh read clears the stale mark so no notice fires", async () => {
		await createSession();
		const filePath = join(tempDir, "seen.txt");
		writeFileSync(filePath, "v1");
		tracker().markRead(filePath, "v1");
		tracker().noteExternalChange(filePath);

		// The model re-reads the file (fresh content) before the next prompt.
		tracker().markRead(filePath, "v2");
		await session.prompt("msg 1");
		expect(sawFileStateText).toBeUndefined();
	});
});
