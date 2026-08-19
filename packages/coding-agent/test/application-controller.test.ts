import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEventListener } from "../src/core/agent-session.ts";
import { ApplicationController, type ApplicationRuntimeHost } from "../src/core/application-controller.ts";
import type { CompactionResult } from "../src/core/compaction/index.ts";
import type { InteractionPort } from "../src/core/interaction-port.ts";
import type { SessionTreeNode } from "../src/core/session-manager.ts";

/**
 * A minimal, narrow fake of the AgentSession surface used by the controller.
 *
 * The controller is typed against the real `AgentSession`, which is far too
 * large to construct in a unit test. We therefore build a plain object that
 * structurally implements only the delegated subset and downcast it once at the
 * host boundary (the one unavoidable `unknown` cast, since
 * `ApplicationRuntimeHost.session` must be replacement-safe).
 */
interface FakeSession {
	subscribe: (listener: AgentSessionEventListener) => () => void;
	prompt: (text: string, options?: unknown) => Promise<void>;
	steer: (text: string, images?: unknown[]) => Promise<void>;
	followUp: (text: string, images?: unknown[]) => Promise<void>;
	abort: () => Promise<void>;
	waitForIdle: () => Promise<void>;
	clearQueue: () => { steering: string[]; followUp: string[] };
	getSteeringMessages: () => readonly string[];
	getFollowUpMessages: () => readonly string[];
	pendingMessageCount: number;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	setSteeringMode: (mode: "all" | "one-at-a-time") => void;
	setFollowUpMode: (mode: "all" | "one-at-a-time") => void;
	model: unknown;
	thinkingLevel: ThinkingLevel;
	setModel: (model: unknown) => Promise<void>;
	cycleModel: (direction?: "forward" | "backward") => Promise<unknown>;
	setThinkingLevel: (level: ThinkingLevel) => void;
	cycleThinkingLevel: () => ThinkingLevel | undefined;
	getAvailableThinkingLevels: () => ThinkingLevel[];
	scopedModels: readonly unknown[];
	setScopedModels: (models: readonly unknown[]) => void;
	isCompacting: boolean;
	autoCompactionEnabled: boolean;
	compact: (customInstructions?: string) => Promise<CompactionResult>;
	abortCompaction: () => void;
	setAutoCompactionEnabled: (enabled: boolean) => void;
	sessionManager: { getTree: () => SessionTreeNode[] };
	navigateTree: (targetId: string, options?: object) => Promise<unknown>;
	abortBranchSummary: () => void;
	sessionId: string;
	sessionFile: string | undefined;
	sessionName: string | undefined;
	isStreaming: boolean;
	isIdle: boolean;
	reload: (options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>;
	setSessionName: (name: string) => void;
	// Session core state
	messages: unknown[];
	state: unknown;
	systemPrompt: string;
	respondOverrideConfirmation: (accepted: boolean) => boolean;
	getToolDefinition: (name: string) => unknown;
	bindExtensions: (bindings: unknown) => Promise<void>;
	getIntegration: (id: string) => unknown;
	// Bash execution and retry
	isBashRunning: boolean;
	executeBash: (command: string, onChunk?: (chunk: string) => void, options?: unknown) => Promise<unknown>;
	abortBash: () => void;
	recordBashResult: (command: string, result: unknown, options?: unknown) => void;
	retryAttempt: number;
	abortRetry: () => void;
	// Queries and exports
	getSessionStats: () => unknown;
	getContextUsage: () => unknown;
	getLastAssistantText: () => string | undefined;
	getUserMessagesForForking: () => Array<{ entryId: string; text: string }>;
	exportToHtml: (outputPath?: string, options?: unknown) => Promise<string>;
	exportToJsonl: (outputPath?: string) => string;
	name: string;
	calls: string[];
}

function makeFakeSession(name: string): FakeSession {
	const calls: string[] = [];
	const record = (method: string, ...args: unknown[]): void => {
		calls.push(method + (args.length > 0 ? `(${args.join(",")})` : "()"));
	};

	return {
		name,
		calls,
		subscribe: (listener) => {
			record("subscribe");
			void listener;
			return () => record("unsubscribe");
		},
		prompt: async (text) => {
			record("prompt", text);
		},
		steer: async (text) => {
			record("steer", text);
		},
		followUp: async (text) => {
			record("followUp", text);
		},
		abort: async () => {
			record("abort");
		},
		waitForIdle: async () => {
			record("waitForIdle");
		},
		clearQueue: () => {
			record("clearQueue");
			return { steering: [], followUp: [] };
		},
		getSteeringMessages: () => {
			record("getSteeringMessages");
			return [];
		},
		getFollowUpMessages: () => {
			record("getFollowUpMessages");
			return [];
		},
		pendingMessageCount: 0,
		steeringMode: "all",
		followUpMode: "all",
		setSteeringMode: (mode) => {
			record("setSteeringMode", mode);
		},
		setFollowUpMode: (mode) => {
			record("setFollowUpMode", mode);
		},
		model: undefined,
		thinkingLevel: "off" as ThinkingLevel,
		setModel: async (model) => {
			record("setModel", String(model));
		},
		cycleModel: async (direction) => {
			record("cycleModel", direction ?? "forward");
			return undefined;
		},
		setThinkingLevel: (level) => {
			record("setThinkingLevel", level);
		},
		cycleThinkingLevel: () => {
			record("cycleThinkingLevel");
			return undefined;
		},
		getAvailableThinkingLevels: () => {
			record("getAvailableThinkingLevels");
			return ["off", "minimal", "low", "medium", "high"] as ThinkingLevel[];
		},
		scopedModels: [],
		setScopedModels: (models) => {
			record("setScopedModels", String(models.length));
		},
		isCompacting: false,
		autoCompactionEnabled: true,
		compact: async (customInstructions) => {
			record("compact", customInstructions ?? "");
			return { summary: "", firstKeptEntryId: "", tokensBefore: 0 };
		},
		abortCompaction: () => {
			record("abortCompaction");
		},
		setAutoCompactionEnabled: (enabled) => {
			record("setAutoCompactionEnabled", String(enabled));
		},
		sessionManager: {
			getTree: () => {
				record("getTree");
				return [];
			},
		},
		navigateTree: async (targetId, options) => {
			record("navigateTree", targetId, options ? "opts" : "");
			return { cancelled: false };
		},
		abortBranchSummary: () => {
			record("abortBranchSummary");
		},
		sessionId: `${name}-id`,
		sessionFile: `${name}-file`,
		sessionName: undefined,
		isStreaming: false,
		isIdle: true,
		reload: async (options) => {
			record("reload", options ? "opts" : "");
		},
		setSessionName: (sessionName) => {
			record("setSessionName", sessionName);
		},
		// Session core state
		messages: [],
		state: { messages: [] },
		systemPrompt: `${name}-system-prompt`,
		respondOverrideConfirmation: (accepted) => {
			record("respondOverrideConfirmation", String(accepted));
			return true;
		},
		getToolDefinition: (toolName) => {
			record("getToolDefinition", toolName);
			return { name: toolName };
		},
		bindExtensions: async (bindings) => {
			record("bindExtensions", bindings ? "bindings" : "");
		},
		getIntegration: (id) => {
			record("getIntegration", id);
			return { id };
		},
		// Bash execution and retry
		isBashRunning: false,
		executeBash: async (command, onChunk, options) => {
			record("executeBash", command, onChunk ? "onChunk" : "", options ? "opts" : "");
			return { output: "", exitCode: 0, cancelled: false, truncated: false };
		},
		abortBash: () => {
			record("abortBash");
		},
		recordBashResult: (command, result, options) => {
			record("recordBashResult", command, result ? "result" : "", options ? "opts" : "");
		},
		retryAttempt: 0,
		abortRetry: () => {
			record("abortRetry");
		},
		// Queries and exports
		getSessionStats: () => {
			record("getSessionStats");
			return { sessionId: "stats" };
		},
		getContextUsage: () => {
			record("getContextUsage");
			return { tokens: 100, contextWindow: 200000, percent: 0.05 };
		},
		getLastAssistantText: () => {
			record("getLastAssistantText");
			return "last text";
		},
		getUserMessagesForForking: () => {
			record("getUserMessagesForForking");
			return [{ entryId: "entry-1", text: "hello" }];
		},
		exportToHtml: async (outputPath, options) => {
			record("exportToHtml", outputPath ?? "", options ? "opts" : "");
			return "/tmp/export.html";
		},
		exportToJsonl: (outputPath) => {
			record("exportToJsonl", outputPath ?? "");
			return "/tmp/export.jsonl";
		},
	};
}

/**
 * Build a host whose `session` getter returns whatever the `holder` points at.
 * This is what makes the controller replacement-safe to test: swap `holder.current`
 * and every subsequent operation must resolve against the new session.
 *
 * Lifecycle methods are recorded on `calls` so tests can assert delegation.
 */
function makeHost(holder: { current: FakeSession }, calls: string[]): ApplicationRuntimeHost {
	const record = (method: string, ...args: unknown[]): void => {
		calls.push(method + (args.length > 0 ? `(${args.join(",")})` : "()"));
	};
	return {
		get session(): AgentSession {
			return holder.current as unknown as AgentSession;
		},
		newSession: async (options) => {
			record("newSession", options ? "opts" : "");
			return { cancelled: false };
		},
		fork: async (entryId, options) => {
			record("fork", entryId, options ? "opts" : "");
			return { cancelled: false };
		},
		switchSession: async (sessionPath, options) => {
			record("switchSession", sessionPath, options ? "opts" : "");
			return { cancelled: false };
		},
		importFromJsonl: async (inputPath, cwdOverride) => {
			record("importFromJsonl", inputPath, cwdOverride ?? "");
			return { cancelled: false };
		},
		dispose: async () => {
			record("dispose");
		},
	};
}

/** Minimal transport-neutral interaction port for the controller tests. */
function makeInteractions(): InteractionPort {
	return {
		select: async (title) => {
			void title;
			return undefined;
		},
		confirm: async (title, message) => {
			void title;
			void message;
			return false;
		},
		input: async (title) => {
			void title;
			return undefined;
		},
		editor: async (title) => {
			void title;
			return undefined;
		},
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
	};
}

describe("ApplicationController", () => {
	it("stores the interaction port by reference", () => {
		const holder = { current: makeFakeSession("a") };
		const interactions = makeInteractions();
		const controller = new ApplicationController(makeHost(holder, []), interactions);

		expect(controller.interactions).toBe(interactions);
	});

	it("delegates lifecycle methods to the runtime host", async () => {
		const holder = { current: makeFakeSession("a") };
		const calls: string[] = [];
		const controller = new ApplicationController(makeHost(holder, calls), makeInteractions());

		await controller.newSession({ setup: async () => {} });
		await controller.fork("entry-id", { position: "at" });
		await controller.switchSession("session.jsonl", { withSession: async () => {} });
		await controller.importFromJsonl("input.jsonl");
		await controller.importFromJsonl("input.jsonl", "/cwd");
		await controller.dispose();

		expect(calls).toContain("newSession(opts)");
		expect(calls).toContain("fork(entry-id,opts)");
		expect(calls).toContain("switchSession(session.jsonl,opts)");
		expect(calls).toContain("importFromJsonl(input.jsonl,)");
		expect(calls).toContain("importFromJsonl(input.jsonl,/cwd)");
		expect(calls).toContain("dispose()");
	});

	it("delegates reload and setSessionName to the current session", async () => {
		const holder = { current: makeFakeSession("a") };
		const controller = new ApplicationController(makeHost(holder, []), makeInteractions());

		await controller.reload({ beforeSessionStart: () => {} });
		controller.setSessionName("renamed");

		expect(holder.current.calls).toContain("reload(opts)");
		expect(holder.current.calls).toContain("setSessionName(renamed)");
	});

	it("delegates to the current session across every group", async () => {
		const holder = { current: makeFakeSession("a") };
		const controller = new ApplicationController(makeHost(holder, []), makeInteractions());

		// subscription
		const unsub = controller.subscribe(() => {});
		unsub();

		// prompting / steering
		await controller.prompt("hello");
		await controller.steer("steer-message");
		await controller.followUp("follow-up-message");
		await controller.abort();
		await controller.waitForIdle();
		controller.clearQueue();
		controller.getSteeringMessages();
		controller.getFollowUpMessages();
		expect(controller.pendingMessageCount).toBe(0);
		expect(controller.steeringMode).toBe("all");
		expect(controller.followUpMode).toBe("all");
		controller.setSteeringMode("one-at-a-time");
		controller.setFollowUpMode("one-at-a-time");

		// model / thinking
		expect(controller.model).toBeUndefined();
		expect(controller.thinkingLevel).toBe("off");
		await controller.cycleModel("backward");
		controller.setThinkingLevel("high");
		controller.cycleThinkingLevel();
		controller.getAvailableThinkingLevels();
		expect(controller.scopedModels).toEqual([]);
		controller.setScopedModels([]);

		// compaction
		expect(controller.isCompacting).toBe(false);
		expect(controller.autoCompactionEnabled).toBe(true);
		await controller.compact("instructions");
		controller.abortCompaction();
		controller.setAutoCompactionEnabled(false);

		// tree
		controller.getTree();
		const navigation = await controller.navigateTree("target", { summarize: true });
		expect(navigation).toEqual({ cancelled: false });
		controller.abortBranchSummary();

		// identity / state
		expect(controller.sessionId).toBe("a-id");
		expect(controller.sessionFile).toBe("a-file");
		expect(controller.sessionName).toBeUndefined();
		expect(controller.isStreaming).toBe(false);
		expect(controller.isIdle).toBe(true);

		const calls = holder.current.calls;
		expect(calls).toContain("prompt(hello)");
		expect(calls).toContain("steer(steer-message)");
		expect(calls).toContain("followUp(follow-up-message)");
		expect(calls).toContain("clearQueue()");
		expect(calls).toContain("setSteeringMode(one-at-a-time)");
		expect(calls).toContain("setFollowUpMode(one-at-a-time)");
		expect(calls).toContain("cycleModel(backward)");
		expect(calls).toContain("setThinkingLevel(high)");
		expect(calls).toContain("compact(instructions)");
		expect(calls).toContain("setAutoCompactionEnabled(false)");
		expect(calls).toContain("getTree()");
		expect(calls).toContain("navigateTree(target,opts)");
		expect(calls).toContain("abortBranchSummary()");
	});

	it("delegates core state, bash/retry, queries/exports, and integrations", async () => {
		const holder = { current: makeFakeSession("a") };
		const controller = new ApplicationController(makeHost(holder, []), makeInteractions());

		// session core state
		expect(controller.messages).toEqual([]);
		expect(controller.state).toEqual({ messages: [] });
		expect(controller.systemPrompt).toBe("a-system-prompt");
		expect(controller.respondOverrideConfirmation(true)).toBe(true);
		controller.getToolDefinition("read");
		await controller.bindExtensions({ uiContext: undefined });
		controller.getIntegration("todo");

		// bash / retry
		expect(controller.isBashRunning).toBe(false);
		await controller.executeBash(
			"ls",
			(chunk) => {
				void chunk;
			},
			{ excludeFromContext: false },
		);
		controller.abortBash();
		controller.recordBashResult(
			"ls",
			{ output: "", exitCode: 0, cancelled: false, truncated: false },
			{ excludeFromContext: false },
		);
		expect(controller.retryAttempt).toBe(0);
		controller.abortRetry();

		// queries / exports
		controller.getSessionStats();
		controller.getContextUsage();
		expect(controller.getLastAssistantText()).toBe("last text");
		expect(controller.getUserMessagesForForking()).toEqual([{ entryId: "entry-1", text: "hello" }]);
		await controller.exportToHtml(undefined, { themeName: "dark" });
		controller.exportToJsonl("/tmp/x.jsonl");

		const calls = holder.current.calls;
		expect(calls).toContain("respondOverrideConfirmation(true)");
		expect(calls).toContain("getToolDefinition(read)");
		expect(calls).toContain("bindExtensions(bindings)");
		expect(calls).toContain("getIntegration(todo)");
		expect(calls).toContain("executeBash(ls,onChunk,opts)");
		expect(calls).toContain("abortBash()");
		expect(calls).toContain("recordBashResult(ls,result,opts)");
		expect(calls).toContain("abortRetry()");
		expect(calls).toContain("getSessionStats()");
		expect(calls).toContain("getContextUsage()");
		expect(calls).toContain("getLastAssistantText()");
		expect(calls).toContain("getUserMessagesForForking()");
		expect(calls).toContain("exportToHtml(,opts)");
		expect(calls).toContain("exportToJsonl(/tmp/x.jsonl)");
	});

	it("reads core/common delegates from the replacement session (replacement safety)", () => {
		const original = makeFakeSession("original");
		const replacement = makeFakeSession("replacement");
		const holder = { current: original };
		const controller = new ApplicationController(makeHost(holder, []), makeInteractions());

		expect(controller.systemPrompt).toBe("original-system-prompt");

		holder.current = replacement;

		expect(controller.systemPrompt).toBe("replacement-system-prompt");
		controller.getToolDefinition("read");
		expect(replacement.calls).toContain("getToolDefinition(read)");
		expect(original.calls).not.toContain("getToolDefinition(read)");
	});

	it("reads session at call time (replacement safety)", async () => {
		const original = makeFakeSession("original");
		const replacement = makeFakeSession("replacement");
		const holder = { current: original };
		const controller = new ApplicationController(makeHost(holder, []), makeInteractions());

		// Before replacement, operations hit the original session.
		expect(controller.sessionId).toBe("original-id");

		// Swap the target after construction.
		holder.current = replacement;

		// All subsequent operations must hit the replacement session.
		expect(controller.sessionId).toBe("replacement-id");
		await controller.prompt("after-swap");
		expect(replacement.calls).toContain("prompt(after-swap)");
		expect(original.calls).not.toContain("prompt(after-swap)");
	});

	it("delegates getTree to the replacement session manager", () => {
		const original = makeFakeSession("original");
		const replacement = makeFakeSession("replacement");
		const holder = { current: original };
		const controller = new ApplicationController(makeHost(holder, []), makeInteractions());

		controller.getTree();
		expect(original.calls).toContain("getTree()");
		expect(replacement.calls).not.toContain("getTree()");

		holder.current = replacement;
		controller.getTree();
		expect(replacement.calls).toContain("getTree()");
	});
});
