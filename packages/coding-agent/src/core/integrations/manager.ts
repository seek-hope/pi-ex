/**
 * IntegrationManager — owns core integrations for one session runtime.
 *
 * Created by AgentSession during _buildRuntime; integrations are rebuilt
 * alongside extensions on reload/session replacement.
 */

import type { SettingsManager } from "../settings-manager.ts";
import { BackgroundTasksIntegration } from "./bg-tasks/index.ts";
import { ComputerUseIntegration, isComputerUseSupported } from "./computer-use/index.ts";
import { SshIntegration } from "./ssh/index.ts";
import { SubagentIntegration } from "./subagent/index.ts";
import type { CoreIntegration, CoreIntegrationContext } from "./types.ts";

/**
 * Default-active tool names contributed by enabled core integrations.
 * Used by sdk.ts when computing the initial active tool set.
 */
export function getDefaultIntegrationToolNames(settingsManager: SettingsManager): string[] {
	const names: string[] = [];
	if (settingsManager.getTodoEnabled()) {
	}
	if (settingsManager.getBackgroundTasksEnabled()) {
		names.push("bg_spawn", "bg_status", "bg_output", "bg_kill");
	}
	if (settingsManager.getSshEnabled()) {
		names.push("ssh_exec", "ssh_status", "scp_to_remote", "scp_from_remote");
	}
	if (isComputerUseAvailable(settingsManager)) {
		names.push(
			"computer_screenshot",
			"computer_move",
			"computer_click",
			"computer_click_at",
			"computer_double_click",
			"computer_type",
			"computer_key",
			"computer_scroll",
			"computer_drag",
			"computer_get_position",
			"computer_get_screen_size",
		);
	}
	if (settingsManager.getSubagentsEnabled()) {
		names.push(
			"subagent_spawn",
			"subagent_review",
			"subagent_merge",
			"subagent_reject",
			"subagent_parallel",
			"subagent_list",
			"subagent_cancel",
			"subagent_continue",
			// subagent_ensure_git stays registered but is not default-active.
		);
	}
	if (settingsManager.getRecallEnabled()) {
	}
	return names;
}

/** Settings gate + platform support (Hyprland/Wayland with grim/ydotool/wtype/hyprctl). */
function isComputerUseAvailable(settingsManager: SettingsManager): boolean {
	if (!settingsManager.getComputerUseEnabled()) return false;
	return isComputerUseSupported();
}

export class IntegrationManager {
	private readonly integrations = new Map<string, CoreIntegration>();

	constructor(ctx: CoreIntegrationContext) {
		if (ctx.settingsManager.getTodoEnabled()) {
		}
		if (ctx.settingsManager.getBackgroundTasksEnabled()) {
			this.integrations.set("bg-tasks", new BackgroundTasksIntegration(ctx));
		}
		if (ctx.settingsManager.getSshEnabled()) {
			this.integrations.set("ssh", new SshIntegration(ctx));
		}
		if (isComputerUseAvailable(ctx.settingsManager)) {
			this.integrations.set("computer-use", new ComputerUseIntegration(ctx));
		}
		if (ctx.settingsManager.getSubagentsEnabled()) {
			this.integrations.set("subagent", new SubagentIntegration(ctx));
		}
	}

	get<T extends CoreIntegration = CoreIntegration>(id: string): T | undefined {
		return this.integrations.get(id) as T | undefined;
	}

	getToolDefinitions() {
		const defs = [];
		for (const integration of this.integrations.values()) {
			defs.push(...(integration.getToolDefinitions?.() ?? []));
		}
		return defs;
	}

	getDefaultActiveToolNames(): string[] {
		const names: string[] = [];
		for (const integration of this.integrations.values()) {
			names.push(...(integration.getDefaultActiveToolNames?.() ?? []));
		}
		return names;
	}

	onSessionStart(): void {
		for (const integration of this.integrations.values()) integration.onSessionStart?.();
	}

	onAgentEnd(): void {
		for (const integration of this.integrations.values()) integration.onAgentEnd?.();
	}

	onSessionTree(): void {
		for (const integration of this.integrations.values()) integration.onSessionTree?.();
	}

	onToolCall(toolName: string, input: Record<string, unknown>): { block: true; reason: string } | undefined {
		for (const integration of this.integrations.values()) {
			const decision = integration.onToolCall?.(toolName, input);
			if (decision) return decision;
		}
		return undefined;
	}

	onShutdown(): void {
		for (const integration of this.integrations.values()) integration.onShutdown?.();
	}
}
