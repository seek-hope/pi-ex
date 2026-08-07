import { getModel } from "../src/compat.ts";
import type { OpenAICompletionsCompat, OpenAIResponsesCompat } from "../src/types.ts";

const cases = [getModel("opencode-go", "kimi-k2.6")!, getModel("opencode", "grok-build-0.1")!] as const;

for (const model of cases) {
	// P1a: if compat resolves to the union, this assignment is legal.
	const c: OpenAICompletionsCompat | OpenAIResponsesCompat = model.compat;
	c.maxTokensField;
}

import values from "../src/providers/data/opencode-go.json" with { type: "json" };

// P2: literal inference probe.
const api: "openai-completions" = values["openai-completions"]["kimi-k2.6"].api;
void api;

// P3: leak top-level group keys of opencode-go.json.
const groupKeys: keyof typeof values = "LEAK_GROUP";
void groupKeys;

import opencodeValues from "../src/providers/data/opencode.json" with { type: "json" };

// P4: leak top-level group keys of opencode.json.
const opencodeGroupKeys: keyof typeof opencodeValues = "LEAK_GROUP_2";
void opencodeGroupKeys;

export {};
