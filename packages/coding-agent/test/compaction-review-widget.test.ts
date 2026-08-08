/**
 * Regression test: the compaction review widget must never render a line
 * wider than the render width — the TUI crashes with "Rendered line exceeds
 * terminal width" otherwise. CJK summary text made the old character-count
 * budgeting overflow (CJK chars are two terminal cells wide).
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { UncertainItem } from "../src/core/compaction/review.ts";
import { CompactionReviewWidget } from "../src/modes/interactive/components/compaction-review.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

function renderItems(items: UncertainItem[], width: number): string[] {
	const widget = new CompactionReviewWidget(items);
	const control = widget.start(() => {});
	return control.render(width);
}

describe("CompactionReviewWidget width safety", () => {
	const items: UncertainItem[] = [
		{ type: "inference", text: "包".repeat(200), sourceLine: 10 }, // 200 CJK chars = 400 cells
		{ type: "question", text: "short english question", sourceLine: 11 },
		{ type: "state", text: `混合 mixed 内容 with a very long tail ${"x".repeat(120)}`, sourceLine: 12 },
	];

	for (const width of [40, 80, 127]) {
		it(`keeps every line within width ${width}`, () => {
			const lines = renderItems(items, width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});
	}

	it("wraps overlong CJK items instead of truncating them", () => {
		const lines = renderItems(items, 80);
		const cjkLines = lines.filter((l) => l.includes("包包"));
		expect(cjkLines.length).toBeGreaterThan(1); // wrapped across continuation lines
		expect(cjkLines.every((l) => !l.includes("…"))).toBe(true); // no truncation ellipsis
		for (const line of cjkLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});
});

describe("CompactionReviewWidget semantics", () => {
	it("offers a keep/abandon decision without category labels", () => {
		const widget = new CompactionReviewWidget([
			{ type: "inference", text: "the API retries on 429", sourceLine: 1 },
			{ type: "question", text: "does the user want compat?", sourceLine: 2 },
			{ type: "state", text: "server status: running", sourceLine: 3 },
		]);
		const control = widget.start(() => {});
		const lines = control.render(127).join("\n");
		// No category labels — just the statement and its fate.
		expect(lines).not.toContain("[Inference");
		expect(lines).not.toContain("[Question");
		expect(lines).not.toContain("[Stale");
		expect(lines).toContain("keep — retain statement in memory");
		expect(lines).toContain("toggle keep/abandon");
		expect(lines).toContain("keep all");
		expect(lines).toContain("abandon all");
	});
});
