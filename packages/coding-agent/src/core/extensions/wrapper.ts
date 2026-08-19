/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	const execute = tool.execute;
	// Snapshotting active tools is only an optimisation to propagate tools a run
	// registered mid-execution. On a stale runner getActiveTools() throws; we must
	// never let that turn a completed tool call into a rejected execute, so these
	// reads are best-effort and fail soft.
	const safeActiveTools = (): Set<string> | undefined => {
		try {
			return new Set(runner.getActiveTools());
		} catch {
			return undefined;
		}
	};
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeBefore = safeActiveTools();
			const result = await execute(toolCallId, params, signal, onUpdate);
			const activeAfter = safeActiveTools();
			if (activeBefore === undefined || activeAfter === undefined) return result;
			if (![...activeBefore].every((name) => activeAfter.has(name))) return result;

			const addedToolNames = [...activeAfter].filter((name) => !activeBefore.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
