/**
 * Transport/UI-neutral application controller foundation.
 *
 * `ApplicationController` is a narrow, typed facade over an `AgentSession`. It
 * depends only on a runtime host exposing a replacement-safe `session` getter,
 * so callers may swap the underlying session (new/resume/fork) without leaking a
 * stale reference. Every operation reads `runtimeHost.session` at call time; the
 * initial session is never captured.
 *
 * In addition to direct session delegation it owns session lifecycle (new,
 * resume/switch, fork, import, dispose) by delegating to the host's
 * `AgentSessionRuntime`-derived methods, and it holds a transport-neutral
 * `InteractionPort` used by higher-level flows for dialogs and surface state.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEventListener, ModelCycleResult, PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { CompactionResult } from "./compaction/index.ts";
import type { InteractionPort } from "./interaction-port.ts";
import type { SessionTreeNode } from "./session-manager.ts";

/**
 * Host abstraction the controller is built on.
 *
 * It must expose the current session (replacement-safe getter) plus the exact
 * lifecycle methods of `AgentSessionRuntime`. The controller delegates lifecycle
 * calls to these so callers never hold a stale session reference across a
 * replacement.
 */
export interface ApplicationRuntimeHost {
	readonly session: AgentSession;
	newSession: (
		...args: Parameters<AgentSessionRuntime["newSession"]>
	) => ReturnType<AgentSessionRuntime["newSession"]>;
	fork: (...args: Parameters<AgentSessionRuntime["fork"]>) => ReturnType<AgentSessionRuntime["fork"]>;
	switchSession: (
		...args: Parameters<AgentSessionRuntime["switchSession"]>
	) => ReturnType<AgentSessionRuntime["switchSession"]>;
	importFromJsonl: (
		...args: Parameters<AgentSessionRuntime["importFromJsonl"]>
	) => ReturnType<AgentSessionRuntime["importFromJsonl"]>;
	dispose: (...args: Parameters<AgentSessionRuntime["dispose"]>) => ReturnType<AgentSessionRuntime["dispose"]>;
}

// ---------------------------------------------------------------------------
// Type aliases derived from the current AgentSession surface. These avoid
// duplicating internal structural types and keep the controller in lockstep
// with AgentSession's exact argument/result types.
// ---------------------------------------------------------------------------

/** A session model, including the not-yet-selected case. */
export type SessionModel = AgentSession["model"];

/** A model accepted by `setModel`. */
export type SessionModelInput = Parameters<AgentSession["setModel"]>[0];

/** Scoped model entries (read-only) exposed by `scopedModels`. */
export type SessionScopedModels = AgentSession["scopedModels"];

/** Mutable scoped model entries accepted by `setScopedModels`. */
export type SessionScopedModelsInput = Parameters<AgentSession["setScopedModels"]>[0];

/** Options accepted by `navigateTree`. */
export type NavigateTreeOptions = NonNullable<Parameters<AgentSession["navigateTree"]>[1]>;

/** Resolved result of `navigateTree`. */
export type NavigateTreeResult = Awaited<ReturnType<AgentSession["navigateTree"]>>;

/** Queue mode accepted by steering/follow-up setters and getters. */
export type QueueMode = AgentSession["steeringMode"];

/** The transport/UI-neutral application controller. */
export class ApplicationController {
	readonly #host: ApplicationRuntimeHost;
	readonly #interactions: InteractionPort;

	constructor(host: ApplicationRuntimeHost, interactions: InteractionPort) {
		this.#host = host;
		this.#interactions = interactions;
	}

	/** Read-only access to the transport-neutral interaction port. */
	get interactions(): InteractionPort {
		return this.#interactions;
	}

	/** Read the current session. Deliberately reads at call time, not construction time. */
	private get _session(): AgentSession {
		return this.#host.session;
	}

	// -----------------------------------------------------------------------
	// Event subscription
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to session events. Returns an unsubscribe function scoped to the
	 * current session at call time.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		return this._session.subscribe(listener);
	}

	// -----------------------------------------------------------------------
	// Session lifecycle (delegated to the runtime host)
	// -----------------------------------------------------------------------

	/** Start a new session, replacing the current one. */
	newSession(...args: Parameters<AgentSessionRuntime["newSession"]>): ReturnType<AgentSessionRuntime["newSession"]> {
		return this.#host.newSession(...args);
	}

	/** Fork the current session from a given entry. */
	fork(...args: Parameters<AgentSessionRuntime["fork"]>): ReturnType<AgentSessionRuntime["fork"]> {
		return this.#host.fork(...args);
	}

	/** Switch to a different session file. */
	switchSession(
		...args: Parameters<AgentSessionRuntime["switchSession"]>
	): ReturnType<AgentSessionRuntime["switchSession"]> {
		return this.#host.switchSession(...args);
	}

	/** Replace the current session with one imported from a JSONL file. */
	importFromJsonl(
		...args: Parameters<AgentSessionRuntime["importFromJsonl"]>
	): ReturnType<AgentSessionRuntime["importFromJsonl"]> {
		return this.#host.importFromJsonl(...args);
	}

	/** Dispose the current session/runtime. */
	dispose(...args: Parameters<AgentSessionRuntime["dispose"]>): ReturnType<AgentSessionRuntime["dispose"]> {
		return this.#host.dispose(...args);
	}

	/** Reload the current session (extensions, skills, prompts, themes, resources). */
	reload(...args: Parameters<AgentSession["reload"]>): ReturnType<AgentSession["reload"]> {
		return this._session.reload(...args);
	}

	/** Set the current session display name. */
	setSessionName(...args: Parameters<AgentSession["setSessionName"]>): ReturnType<AgentSession["setSessionName"]> {
		return this._session.setSessionName(...args);
	}

	// -----------------------------------------------------------------------
	// Prompting and steering
	// -----------------------------------------------------------------------

	/** Send a user prompt (see `AgentSession.prompt`). */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this._session.prompt(text, options);
	}

	/** Queue a steering message for the active turn. */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this._session.steer(text, images);
	}

	/** Queue a follow-up message for after the active turn. */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this._session.followUp(text, images);
	}

	/** Abort the current operation and wait for idle. */
	async abort(): Promise<void> {
		await this._session.abort();
	}

	/** Resolve when the session becomes idle. */
	async waitForIdle(): Promise<void> {
		await this._session.waitForIdle();
	}

	/** Clear one pending queue or both queues, returning what was cleared. */
	clearQueue(queue?: "steer" | "follow_up"): { steering: string[]; followUp: string[] } {
		return this._session.clearQueue(queue);
	}

	/** Read-only view of pending steering messages. */
	getSteeringMessages(): readonly string[] {
		return this._session.getSteeringMessages();
	}

	/** Read-only view of pending follow-up messages. */
	getFollowUpMessages(): readonly string[] {
		return this._session.getFollowUpMessages();
	}

	/** Number of pending messages (includes both steering and follow-up). */
	get pendingMessageCount(): number {
		return this._session.pendingMessageCount;
	}

	/** Current steering queue mode. */
	get steeringMode(): QueueMode {
		return this._session.steeringMode;
	}

	/** Current follow-up queue mode. */
	get followUpMode(): QueueMode {
		return this._session.followUpMode;
	}

	/** Set steering queue mode. */
	setSteeringMode(mode: QueueMode): void {
		this._session.setSteeringMode(mode);
	}

	/** Set follow-up queue mode. */
	setFollowUpMode(mode: QueueMode): void {
		this._session.setFollowUpMode(mode);
	}

	// -----------------------------------------------------------------------
	// Model and thinking level
	// -----------------------------------------------------------------------

	/** Current model, or undefined if none selected. */
	get model(): SessionModel {
		return this._session.model;
	}

	/** Current thinking level. */
	get thinkingLevel(): ThinkingLevel {
		return this._session.thinkingLevel;
	}

	/** Select a model (requires provider auth). */
	async setModel(model: SessionModelInput): Promise<void> {
		await this._session.setModel(model);
	}

	/** Cycle to the next/previous model. */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this._session.cycleModel(direction);
	}

	/** Set the thinking level (clamped to model capabilities). */
	setThinkingLevel(level: ThinkingLevel): void {
		this._session.setThinkingLevel(level);
	}

	/** Cycle to the next thinking level, or undefined if the model doesn't support thinking. */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._session.cycleThinkingLevel();
	}

	/** Available thinking levels for the current model. */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._session.getAvailableThinkingLevels();
	}

	/** Scoped models used for cycling (from --models flag). */
	get scopedModels(): SessionScopedModels {
		return this._session.scopedModels;
	}

	/** Replace scoped models used for cycling. */
	setScopedModels(scopedModels: SessionScopedModelsInput): void {
		this._session.setScopedModels(scopedModels);
	}

	// -----------------------------------------------------------------------
	// Compaction
	// -----------------------------------------------------------------------

	/** Whether compaction or branch summarization is currently running. */
	get isCompacting(): boolean {
		return this._session.isCompacting;
	}

	/** Whether auto-compaction is enabled. */
	get autoCompactionEnabled(): boolean {
		return this._session.autoCompactionEnabled;
	}

	/** Run a manual compaction. */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._session.compact(customInstructions);
	}

	/** Abort in-progress compaction. */
	abortCompaction(): void {
		this._session.abortCompaction();
	}

	/** Enable/disable auto-compaction. */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._session.setAutoCompactionEnabled(enabled);
	}

	// -----------------------------------------------------------------------
	// Session tree
	// -----------------------------------------------------------------------

	/** Defensive copy of the session tree (via the session manager). */
	getTree(): SessionTreeNode[] {
		return this._session.sessionManager.getTree();
	}

	/** Navigate the session tree to the given entry. */
	async navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		return this._session.navigateTree(targetId, options);
	}

	/** Abort an in-progress branch summary started by tree navigation. */
	abortBranchSummary(): void {
		this._session.abortBranchSummary();
	}

	// -----------------------------------------------------------------------
	// Identity and state
	// -----------------------------------------------------------------------

	/** Current session ID. */
	get sessionId(): string {
		return this._session.sessionId;
	}

	/** Current session file path, or undefined if sessions are disabled. */
	get sessionFile(): string | undefined {
		return this._session.sessionFile;
	}

	/** Current session display name, if set. */
	get sessionName(): string | undefined {
		return this._session.sessionName;
	}

	/** Whether the session is currently processing an agent run. */
	get isStreaming(): boolean {
		return this._session.isStreaming;
	}

	/** Whether the session has no active run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return this._session.isIdle;
	}

	// -----------------------------------------------------------------------
	// Session core state (replacement-safe reads)
	// -----------------------------------------------------------------------

	/** All messages, including custom types such as bash executions. */
	get messages(): AgentSession["messages"] {
		return this._session.messages;
	}

	/** Full agent state. */
	get state(): AgentSession["state"] {
		return this._session.state;
	}

	/** Current effective system prompt (includes per-turn extension modifications). */
	get systemPrompt(): AgentSession["systemPrompt"] {
		return this._session.systemPrompt;
	}

	/** Look up a tool definition by name. */
	getToolDefinition(
		...args: Parameters<AgentSession["getToolDefinition"]>
	): ReturnType<AgentSession["getToolDefinition"]> {
		return this._session.getToolDefinition(...args);
	}

	/** Bind extension UI/mode/actions and emit the session-start event. */
	bindExtensions(...args: Parameters<AgentSession["bindExtensions"]>): ReturnType<AgentSession["bindExtensions"]> {
		return this._session.bindExtensions(...args);
	}

	// -----------------------------------------------------------------------
	// Bash execution and retry
	// -----------------------------------------------------------------------

	/** Whether a bash command is currently running. */
	get isBashRunning(): AgentSession["isBashRunning"] {
		return this._session.isBashRunning;
	}

	/** Execute a bash command, adding its result to context and session. */
	executeBash(...args: Parameters<AgentSession["executeBash"]>): ReturnType<AgentSession["executeBash"]> {
		return this._session.executeBash(...args);
	}

	/** Cancel all running bash commands. */
	abortBash(...args: Parameters<AgentSession["abortBash"]>): ReturnType<AgentSession["abortBash"]> {
		return this._session.abortBash(...args);
	}

	/** Record a bash execution result in session history. */
	recordBashResult(
		...args: Parameters<AgentSession["recordBashResult"]>
	): ReturnType<AgentSession["recordBashResult"]> {
		return this._session.recordBashResult(...args);
	}

	/** Current retry attempt (0 if not retrying). */
	get retryAttempt(): AgentSession["retryAttempt"] {
		return this._session.retryAttempt;
	}

	/** Cancel an in-progress retry. */
	abortRetry(...args: Parameters<AgentSession["abortRetry"]>): ReturnType<AgentSession["abortRetry"]> {
		return this._session.abortRetry(...args);
	}

	// -----------------------------------------------------------------------
	// Queries and exports
	// -----------------------------------------------------------------------

	/** Aggregate session statistics. */
	getSessionStats(...args: Parameters<AgentSession["getSessionStats"]>): ReturnType<AgentSession["getSessionStats"]> {
		return this._session.getSessionStats(...args);
	}

	/** Current context usage for the active model. */
	getContextUsage(...args: Parameters<AgentSession["getContextUsage"]>): ReturnType<AgentSession["getContextUsage"]> {
		return this._session.getContextUsage(...args);
	}

	/** Text content of the last assistant message. */
	getLastAssistantText(
		...args: Parameters<AgentSession["getLastAssistantText"]>
	): ReturnType<AgentSession["getLastAssistantText"]> {
		return this._session.getLastAssistantText(...args);
	}

	/** All user messages from the session, for the fork selector. */
	getUserMessagesForForking(
		...args: Parameters<AgentSession["getUserMessagesForForking"]>
	): ReturnType<AgentSession["getUserMessagesForForking"]> {
		return this._session.getUserMessagesForForking(...args);
	}

	/** Export the session to HTML. */
	exportToHtml(...args: Parameters<AgentSession["exportToHtml"]>): ReturnType<AgentSession["exportToHtml"]> {
		return this._session.exportToHtml(...args);
	}

	/** Export the current session branch to a JSONL file. */
	exportToJsonl(...args: Parameters<AgentSession["exportToJsonl"]>): ReturnType<AgentSession["exportToJsonl"]> {
		return this._session.exportToJsonl(...args);
	}
}
