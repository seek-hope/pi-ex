/**
 * Tests for the uncertainty review widgets: decision key flows and
 * width-safe rendering (same CJK crash class as CompactionReviewWidget).
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { UncertainFlag, UncertaintyDecision } from "../src/core/compaction/uncertainty.ts";
import {
	type UncertaintyBrowseResult,
	UncertaintyBrowseWidget,
	type UncertaintyReviewResult,
	UncertaintyReviewWidget,
} from "../src/modes/interactive/components/uncertainty-review.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

function flag(id: string, claim: string, extra?: Partial<UncertainFlag>): UncertainFlag {
	return { id, type: "inference", claim, messageId: "m1", ...extra };
}

function startReview(items: UncertainFlag[], hiddenCount = 0) {
	const widget = new UncertaintyReviewWidget(items, hiddenCount);
	let result: UncertaintyReviewResult | undefined;
	const control = widget.start((r) => {
		result = r;
	});
	return { control, getResult: () => result };
}

describe("UncertaintyReviewWidget", () => {
	it("Enter verifies the selected item and auto-closes when all decided", () => {
		const { control, getResult } = startReview([flag("a", "claim a"), flag("b", "claim b")]);
		expect(control.handleInput("\r")).toBe(true); // verify a, advance
		expect(control.handleInput("\r")).toBe(false); // verify b → all decided → close
		expect(getResult()?.decisions.get("a")).toEqual({ decision: "verified" });
		expect(getResult()?.decisions.get("b")).toEqual({ decision: "verified" });
	});

	it("d dismisses, arrows navigate", () => {
		const { control, getResult } = startReview([flag("a", "claim a"), flag("b", "claim b")]);
		control.handleInput("\x1b[B"); // down to b
		control.handleInput("d"); // dismiss b
		control.handleInput("\x1b[A"); // back to a
		expect(control.handleInput("\r")).toBe(false); // verify a → close
		expect(getResult()?.decisions.get("b")).toEqual({ decision: "dismissed" });
	});

	it("Esc defers undecided items (absent from the result)", () => {
		const { control, getResult } = startReview([flag("a", "claim a"), flag("b", "claim b")]);
		control.handleInput("\r"); // verify a
		expect(control.handleInput("\x1b")).toBe(false); // defer b
		expect(getResult()?.decisions.size).toBe(1);
		expect(getResult()?.decisions.has("b")).toBe(false);
	});

	it("c captures an inline correction", () => {
		const { control, getResult } = startReview([flag("a", "wrong claim")]);
		control.handleInput("c");
		for (const ch of "the fix") control.handleInput(ch);
		control.handleInput("\x7f"); // backspace
		for (const ch of "!") control.handleInput(ch);
		expect(control.handleInput("\r")).toBe(false); // submit → close
		expect(getResult()?.decisions.get("a")).toEqual({ decision: "corrected", correction: "the fi!" });
	});

	it("Esc cancels a correction without deciding", () => {
		const { control, getResult } = startReview([flag("a", "claim a")]);
		control.handleInput("c");
		control.handleInput("x");
		control.handleInput("\x1b"); // cancel correction
		expect(control.handleInput("\x1b")).toBe(false); // then defer
		expect(getResult()?.decisions.size).toBe(0);
	});

	it("A verifies all remaining items", () => {
		const { control, getResult } = startReview([flag("a", "claim a"), flag("b", "claim b")]);
		expect(control.handleInput("A")).toBe(false);
		expect(getResult()?.decisions.get("a")).toEqual({ decision: "verified" });
		expect(getResult()?.decisions.get("b")).toEqual({ decision: "verified" });
	});

	it("renders stale notes, subjects, and hidden count", () => {
		const { control } = startReview([flag("a", "claim a", { subject: "src/x.ts", staleNote: "basis changed" })], 3);
		const text = control.render(100).join("\n");
		expect(text).toContain("src/x.ts");
		expect(text).toContain("basis changed");
		expect(text).toContain("3 more queued");
	});

	it("keeps every line within width for CJK claims", () => {
		const { control } = startReview([
			flag("a", "包".repeat(200)),
			flag("b", `混合 mixed 内容 ${"x".repeat(120)}`, { subject: "src/文件.ts" }),
		]);
		for (const width of [40, 80, 127]) {
			for (const line of control.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("wraps long claims instead of truncating them", () => {
		const longClaim = "word ".repeat(60).trim();
		const { control } = startReview([flag("a", longClaim)]);
		const lines = control.render(60);
		const claimLines = lines.filter((l) => l.includes("word"));
		expect(claimLines.length).toBeGreaterThan(1); // wrapped, not one line
		expect(claimLines.every((l) => !l.includes("…"))).toBe(true); // claim not truncated
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});

describe("UncertaintyBrowseWidget", () => {
	const decided: UncertaintyDecision[] = [
		{ flagId: "a", type: "inference", claim: "claim a", decision: "verified", decidedAt: "2026-01-01" },
		{ flagId: "b", type: "state", claim: "claim b", decision: "dismissed", decidedAt: "2026-01-01" },
	];

	function startBrowse() {
		const widget = new UncertaintyBrowseWidget(decided);
		let result: UncertaintyBrowseResult | undefined;
		const control = widget.start((r) => {
			result = r;
		});
		return { control, getResult: () => result };
	}

	it("u toggles re-queue on the selected item", () => {
		const { control, getResult } = startBrowse();
		control.handleInput("u"); // re-queue a
		expect(control.handleInput("\x1b")).toBe(false);
		expect(getResult()?.requeue).toEqual(["a"]);
	});

	it("v/d supersede decisions; c re-corrects", () => {
		const { control, getResult } = startBrowse();
		control.handleInput("\x1b[B"); // down to b
		control.handleInput("v"); // dismissed → verified
		control.handleInput("\x1b[A"); // back to a
		control.handleInput("c");
		for (const ch of "new fact") control.handleInput(ch);
		control.handleInput("\r");
		expect(control.handleInput("\x1b")).toBe(false);
		expect(getResult()?.overrides.get("b")).toEqual({ decision: "verified" });
		expect(getResult()?.overrides.get("a")).toEqual({ decision: "corrected", correction: "new fact" });
	});

	it("keeps lines within width", () => {
		const { control } = startBrowse();
		for (const width of [40, 80]) {
			for (const line of control.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
