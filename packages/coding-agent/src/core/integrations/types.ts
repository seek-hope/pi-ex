/**
 * Core integrations — built-in features that ship with pi and are wired
 * directly into AgentSession, as opposed to user extensions loaded through
 * the extension runtime.
 *
 * Integrations are constructed per session runtime (like extensions) and
 * receive lifecycle hooks from AgentSession. They can contribute built-in
 * tools, widgets, and react to session lifecycle events.
 */
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionUIContext, ToolDefinition } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface CoreIntegrationContext {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	/** UI surface; undefined in print/json modes or before UI bindings are applied. */
	getUI(): ExtensionUIContext | undefined;
	/** The session's current model. */
	getModel(): Model<any> | undefined;
	/** Access another core integration (e.g. subagent reaching the todo store). */
	getIntegration<T extends CoreIntegration = CoreIntegration>(id: string): T | undefined;
	/** Deliver a message to this session as a follow-up user message (queued while streaming). */
	sendFollowUp?(text: string): void;
}

export interface CoreIntegration {
	readonly id: string;

	/** Tool definitions contributed to the built-in tool registry. */
	getToolDefinitions?(): ToolDefinition[];

	/** Tool names that are active by default while the integration is enabled. */
	getDefaultActiveToolNames?(): string[];

	/** Called after the session runtime has been (re)built: startup, reload, new, resume, fork. */
	onSessionStart?(): void;

	/** Called when an agent run ends (before auto-retry/compaction continuations). */
	onAgentEnd?(): void;

	/** Called after /tree navigation switched the session leaf. */
	onSessionTree?(): void;

	/**
	 * Synchronous tool-call gate evaluated before extension handlers.
	 * Return a block decision to prevent execution.
	 */
	onToolCall?(toolName: string, input: Record<string, unknown>): { block: true; reason: string } | undefined;

	/** Called before the session runtime is torn down. */
	onShutdown?(): void;
}
