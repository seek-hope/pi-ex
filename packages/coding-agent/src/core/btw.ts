/**
 * /btw — ask a temporary question without affecting the current session.
 *
 * Runs a standalone one-off request against the current model (no tools, no
 * session history, no cache writes). The question and answer never touch the
 * active session.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { contentText, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Context, Model } from "@earendil-works/pi-ai/compat";
import { completeSummarization } from "./compaction/compaction.ts";

const BTW_SYSTEM_PROMPT = [
	"You are answering a quick side question during a coding agent session.",
	"A summary of the conversation so far is provided for context — use it to understand what the user is referring to.",
	"Answer directly and concisely. No preamble, no follow-up questions.",
].join(" ");

export interface BtwQueryOptions {
	model: Model<any>;
	question: string;
	sessionMessages?: Message[];
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	signal?: AbortSignal;
}

export async function runBtwQuery(options: BtwQueryOptions): Promise<string> {
	const messages: Message[] = [];

	// Include session history so the model understands what the user is referring to.
	if (options.sessionMessages && options.sessionMessages.length > 0) {
		messages.push(...options.sessionMessages);
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: options.question }],
		timestamp: Date.now(),
	});

	const context: Context = {
		systemPrompt: BTW_SYSTEM_PROMPT,
		messages,
	};

	// completeSummarization gives us the right one-off semantics: fresh routing
	// session id, no cache writes, and retry policy handling.
	const response = await completeSummarization(
		options.model,
		context,
		{
			apiKey: options.apiKey,
			headers: options.headers,
			env: options.env,
			signal: options.signal,
		},
		options.streamFn,
		options.retry,
	);

	if (response.stopReason === "aborted") {
		throw new Error("Side query aborted");
	}
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Side query failed");
	}

	const text = contentText(response.content, "").trim();
	if (!text) {
		throw new Error("Side query returned an empty response");
	}
	return text;
}
