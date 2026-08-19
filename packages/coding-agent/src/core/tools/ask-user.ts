import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Ask the user a question from within a model turn.
 *
 * The question is shown to the USER in a dialog (never to the model's
 * transcript), and the answer comes back as the tool result. The password
 * masking path (ui.input masked) is NOT used here — ask_user is for
 * clarifying intent, not secrets.
 */
export type AskUserResult = { ok: true; answer: string } | { ok: false; reason: "no-ui" | "cancelled" };

export interface AskUserOptions {
	/** Show a dialog with the question and return the user's answer. */
	askUser: (question: string) => Promise<AskUserResult>;
}

const parameters = Type.Object({
	questions: Type.Array(Type.String(), {
		description:
			"The questions to ask. Pass ALL questions in one call — they are asked consecutively and the answers return together.",
		minItems: 1,
		maxItems: 8,
	}),
});

const DESCRIPTION =
	"Call this tool to ask the user questions whenever you are not at least 98% confident that you understand their true intent — do not guess as a substitute. " +
	"You can ask multiple questions in one call: pass them all in the questions array; they are asked consecutively and the answers return together. " +
	"Not available in headless sessions; calling it there fails with a message telling you to proceed with a flagged assumption.";

const execute =
	(options: AskUserOptions) =>
	async (
		_toolCallId: string,
		{ questions }: Static<typeof parameters>,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_ctx?: ExtensionContext,
	): Promise<AgentToolResult<any>> => {
		const answered: string[] = [];
		let interrupted = false;
		for (const question of questions) {
			const result = await options.askUser(question);
			if (result.ok) {
				answered.push(result.answer);
			} else {
				interrupted = true;
				if (result.reason === "no-ui") {
					break;
				}
				// User dismissed one dialog: keep asking the rest (they
				// may still answer), but note the gap in the result.
				answered.push("");
			}
		}
		if (interrupted && answered.length === 0) {
			return {
				content: [
					{
						type: "text",
						text:
							"ask_user is unavailable (no UI in this environment). " +
							"Proceed with your best-effort assumption and flag it inline on its own line, e.g.\n" +
							"[uncertain:inference] <the assumption you are proceeding with>",
					},
				],
				details: undefined,
			};
		}
		// Only report the questions actually asked (a no-UI interruption stops
		// the sequence early).
		const asked = questions.slice(0, answered.length);
		const lines = asked.map((q, i) => {
			const answer = answered[i];
			return `Q: ${q}\nA: ${answer === "" ? "(no answer — user dismissed the dialog)" : answer}`;
		});
		return {
			content: [{ type: "text", text: `User answers:\n\n${lines.join("\n\n")}` }],
			details: undefined,
		};
	};

export function createAskUserToolDefinition(options: AskUserOptions): ToolDefinition<typeof parameters> {
	return {
		name: "ask_user",
		label: "Ask the user",
		description: DESCRIPTION,
		parameters,
		execute: execute(options),
	};
}

export function createAskUserTool(options: AskUserOptions): AgentTool<typeof parameters> {
	return wrapToolDefinition(createAskUserToolDefinition(options));
}

export type AskUserToolParameters = Static<typeof parameters>;
