import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Suspend the current model turn and resume automatically after N seconds.
 *
 * The turn ends when the tool returns ("this should be the last tool call of
 * the turn"); the session schedules a follow-up wake-up message. Background
 * task completions already wake the agent earlier through the integration
 * follow-up channel.
 */
export type WaitScheduleResult = { ok: true; message: string } | { ok: false; error: string };

export interface WaitToolOptions {
	/**
	 * Schedule a wake-up `seconds` from now. The session decides the cap from
	 * its own UI availability (interactive 12h / headless 120s, 5 uses).
	 * Returns the message to show the model, or an error for over-limit calls.
	 */
	schedule: (seconds: number) => WaitScheduleResult;
}

const parameters = Type.Object({
	timeout: Type.Integer({
		description:
			"How long to wait before resuming, in seconds. Set a reasonable value covering the expected remaining duration of the running tasks. " +
			"Interactive sessions: up to 43200 (12 hours). Headless sessions: up to 120.",
		minimum: 1,
	}),
});

const DESCRIPTION =
	"Call this tool when tasks are still running and you plan to stop producing output until they complete. " +
	"Set a reasonable timeout that covers the expected remaining duration of those tasks. " +
	"This should be the last tool call of the turn; the turn ends and resumes automatically when the wait completes. " +
	"Background-task and sub-agent completions wake the agent earlier automatically. " +
	"Prefer it over busy-waiting, polling loops, or long bash sleeps. " +
	"Interactive sessions: up to 12 hours. Headless sessions: up to 120 seconds, 5 uses per session.";

export function createWaitToolDefinition(options: WaitToolOptions): ToolDefinition<typeof parameters> {
	return {
		name: "wait",
		label: "Wait and rest",
		description: DESCRIPTION,
		parameters,
		execute: async (_toolCallId, { timeout }) => {
			const result = options.schedule(timeout);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error }],
					details: undefined,
				};
			}
			return {
				content: [{ type: "text", text: result.message }],
				details: undefined,
				// End the turn now: the wake-up arrives later (or earlier via
				// background-task completions), so the model must not keep
				// executing tools in the same turn.
				terminate: true,
			};
		},
	};
}

export function createWaitTool(options: WaitToolOptions): AgentTool<typeof parameters> {
	return wrapToolDefinition(createWaitToolDefinition(options));
}

export type WaitToolParameters = Static<typeof parameters>;
