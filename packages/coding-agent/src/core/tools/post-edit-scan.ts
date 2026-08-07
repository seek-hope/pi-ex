/**
 * Post-edit scan — after a successful edit, surface what still needs
 * syncing by reusing the registered codegraph tools (deterministic, no
 * hand-rolled reference scanning):
 *
 *   1. codegraph_sync  — incrementally refresh the symbol index
 *   2. codegraph_callers — for each identifier the edit removed/changed,
 *      list the call sites that still reference the old name
 *
 * Best-effort by design: missing tools, slow runs (deadline) or errors
 * degrade silently — the scan must never break or block the edit result
 * beyond its budget.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const MAX_IDENTIFIERS = 3;
const MIN_IDENTIFIER_LEN = 3;
const MAX_OUTPUT_PER_TOOL = 1500;
const MAX_TOTAL_OUTPUT = 6000;

/** Prose/keyword noise that would flood a reference scan. */
const STOPWORDS = new Set([
	"the",
	"this",
	"that",
	"these",
	"those",
	"with",
	"from",
	"into",
	"onto",
	"over",
	"under",
	"function",
	"return",
	"const",
	"let",
	"var",
	"class",
	"export",
	"import",
	"default",
	"async",
	"await",
	"new",
	"for",
	"while",
	"if",
	"else",
	"and",
	"not",
	"null",
	"undefined",
	"true",
	"false",
	"type",
	"interface",
	"void",
	"string",
	"number",
	"boolean",
	"object",
	"any",
	"unknown",
	"never",
	"readonly",
	"public",
	"private",
	"protected",
	"static",
	"extends",
	"implements",
	"typeof",
	"instanceof",
	"of",
	"to",
	"is",
	"was",
	"are",
	"be",
	"or",
	"but",
	"on",
	"at",
	"by",
	"as",
	"it",
	"has",
	"have",
	"had",
	"will",
	"would",
	"should",
	"can",
	"could",
	"may",
	"might",
	"must",
	"does",
	"did",
	"do",
	"no",
	"yes",
	"when",
	"where",
	"which",
	"who",
	"than",
	"then",
	"there",
	"here",
	"all",
	"any",
	"some",
	"more",
	"most",
	"other",
	"such",
	"only",
	"also",
	"very",
	"just",
	"about",
	"after",
	"before",
	"between",
	"value",
	"values",
	"result",
	"results",
	"data",
	"input",
	"output",
	"error",
	"errors",
	"message",
	"messages",
	"text",
	"line",
	"lines",
	"file",
	"files",
	"path",
	"name",
	"list",
	"array",
	"map",
	"set",
	"key",
	"keys",
	"state",
	"props",
	"ctx",
	"options",
	"option",
	"config",
	"settings",
	"type",
	"api",
]);

/** Identifiers removed by the edit (present in oldText, absent from newText). */
export function extractChangedIdentifiers(edits: Array<{ oldText?: string; newText?: string }>): string[] {
	const removed = new Set<string>();
	for (const edit of edits) {
		for (const match of (edit.oldText ?? "").matchAll(IDENTIFIER_RE)) removed.add(match[0]);
	}
	const kept = new Set<string>();
	for (const edit of edits) {
		for (const match of (edit.newText ?? "").matchAll(IDENTIFIER_RE)) kept.add(match[0]);
	}
	const changed: string[] = [];
	for (const identifier of removed) {
		if (identifier.length < MIN_IDENTIFIER_LEN || STOPWORDS.has(identifier) || kept.has(identifier)) {
			continue;
		}
		changed.push(identifier);
	}
	return changed.slice(0, MAX_IDENTIFIERS);
}

export interface PostEditScanOptions {
	/** The tool registry — codegraph_sync / codegraph_callers must be registered. */
	registry: Map<string, AgentTool>;
	/** Total budget for the scan, ms. Default: 5000. */
	deadlineMs?: number;
}

function cap(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/**
 * Run the post-edit scan for the changed identifiers and return a summary
 * block, or undefined when there is nothing to report (or nothing worked).
 */
export async function runPostEditScan(
	changedIdentifiers: string[],
	options: PostEditScanOptions,
): Promise<string | undefined> {
	const { registry } = options;
	const deadline = Date.now() + (options.deadlineMs ?? 5000);

	const callTool = async (name: string, args: Record<string, unknown>): Promise<string | undefined> => {
		const tool = registry.get(name);
		if (!tool) return undefined;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		// The race guarantees the deadline even when a tool ignores the abort
		// signal; the timer handle itself is always cleared (and unref'd) so
		// no dangling handles accumulate on the event loop.
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				tool.execute(`post-edit-scan:${name}`, args, AbortSignal.timeout(remaining), undefined),
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(() => reject(new Error("scan deadline exceeded")), remaining);
					timeoutId.unref?.();
				}),
			]);
			const text = (result?.content ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n")
				.trim();
			return text || undefined;
		} catch {
			return undefined;
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
	};

	const parts: string[] = [];
	let budget = MAX_TOTAL_OUTPUT;

	// Keep the index fresh so the caller list reflects the edit.
	await callTool("codegraph_sync", {});

	for (const identifier of changedIdentifiers) {
		if (budget <= 0) break;
		const callers = await callTool("codegraph_callers", { symbol: identifier });
		if (!callers) continue;
		const section = `\nReferences to \`${identifier}\` that may need syncing:\n${cap(callers, MAX_OUTPUT_PER_TOOL)}`;
		parts.push(section);
		budget -= section.length;
	}

	if (parts.length === 0) return undefined;
	return `[Post-edit scan — identifiers changed by this edit still referenced elsewhere:]\n${parts.join("\n")}`;
}
