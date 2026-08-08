/**
 * Context pruning — deterministic pre-compaction cleanup of bulky read-only
 * tool outputs.
 *
 * Runs as a context-view transformation (the session store keeps full output;
 * retrieval is always possible via the recall tool). Large old outputs from
 * read-only tools are replaced with short stubs, shrinking every subsequent
 * LLM call and often deferring or avoiding compaction entirely.
 *
 * Rules:
 * - Only tool results from read-only tools (read, bash, grep, find, ls).
 * - Never the most recent `keepRecentToolResults` tool results.
 * - Never error results (diagnostics are high-value) or results with images.
 * - Only results at or above `minPrunableTokens`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "./utils.ts";

export interface PruneSettings {
	enabled?: boolean; // default: true
	keepRecentToolResults?: number; // default: 3
	minPrunableTokens?: number; // default: 1000
	headChars?: number; // default: 400 - leading characters of the original output to keep
}

export const DEFAULT_PRUNE_SETTINGS: Required<PruneSettings> = {
	enabled: true,
	keepRecentToolResults: 3,
	minPrunableTokens: 1000,
	headChars: 400,
};

const READ_ONLY_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);

const PRUNE_MARKER = "[pruned ";

export interface PruneResult {
	messages: AgentMessage[];
	prunedCount: number;
	prunedTokens: number;
}

interface ToolResultText {
	text: string;
	hasImage: boolean;
}

function toolResultText(message: AgentMessage): ToolResultText | undefined {
	if (message.role !== "toolResult") return undefined;
	const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
	if (!Array.isArray(content)) return undefined;
	let text = "";
	let hasImage = false;
	for (const part of content) {
		if (part.type === "image") hasImage = true;
		else if (part.type === "text" && part.text) text += part.text;
	}
	return { text, hasImage };
}

export function pruneContextMessages(messages: AgentMessage[], settings?: PruneSettings): PruneResult {
	const opts = { ...DEFAULT_PRUNE_SETTINGS, ...settings };
	if (!opts.enabled || messages.length === 0) {
		return { messages, prunedCount: 0, prunedTokens: 0 };
	}

	// Indices of the tool results that stay untouched (the N most recent).
	const toolResultIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "toolResult") toolResultIndices.push(i);
	}
	const keepFrom = Math.max(0, toolResultIndices.length - opts.keepRecentToolResults);
	const prunableIndices = new Set(toolResultIndices.slice(0, keepFrom));

	let prunedCount = 0;
	let prunedTokens = 0;
	const out: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!prunableIndices.has(i)) {
			out.push(message);
			continue;
		}
		const result = toolResultText(message);
		if (!result || result.hasImage) {
			out.push(message);
			continue;
		}
		const toolName = (message as { toolName?: string }).toolName ?? "";
		const isError = (message as { isError?: boolean }).isError === true;
		if (!READ_ONLY_TOOLS.has(toolName) || isError) {
			out.push(message);
			continue;
		}
		if (result.text.startsWith(PRUNE_MARKER)) {
			out.push(message);
			continue;
		}
		const tokens = estimateTextTokens(result.text);
		if (tokens < opts.minPrunableTokens) {
			out.push(message);
			continue;
		}

		const head = result.text.substring(0, opts.headChars);
		// The marker goes FIRST so the idempotence guard (startsWith check above)
		// actually recognizes already-pruned results; the retained head follows.
		const stub = `[pruned ~${tokens} tok of ${toolName} output. The original remains in the session archive — retrieve it with the recall tool if needed.]\n${head}${head.length < result.text.length ? "…" : ""}`;

		// Replace only the FIRST text part with the stub and drop the remaining
		// text parts (they were slices of the same pruned output — replacing each
		// with the full stub would duplicate it N times while the token
		// accounting above counts it once). Non-text parts (images etc.) are
		// kept as-is.
		const toolResult = message as { content: Array<{ type: string; text?: string }> };
		let stubPlaced = false;
		const newContent: Array<{ type: string; text?: string }> = [];
		for (const part of toolResult.content) {
			if (part.type === "text") {
				if (!stubPlaced) {
					newContent.push({ ...part, text: stub });
					stubPlaced = true;
				}
				// else: drop — part of the same pruned output
			} else {
				newContent.push(part);
			}
		}
		out.push({ ...message, content: newContent } as AgentMessage);
		prunedCount++;
		prunedTokens += tokens - estimateTextTokens(stub);
	}

	return { messages: out, prunedCount, prunedTokens };
}
