/**
 * Tests for the unified integration follow-up batcher: events inside the
 * debounce window merge into one delivery (one input turn); events further
 * apart deliver separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationFollowUpBatcher } from "../src/core/integrations/followup-batcher.ts";

describe("IntegrationFollowUpBatcher", () => {
	let deliveries: string[];
	let batcher: IntegrationFollowUpBatcher;

	beforeEach(() => {
		vi.useFakeTimers();
		deliveries = [];
		batcher = new IntegrationFollowUpBatcher((text) => deliveries.push(text), 3000);
	});

	afterEach(() => {
		batcher.dispose();
		vi.useRealTimers();
	});

	it("merges events within the window into a single delivery", () => {
		batcher.push("[task-1 completed]");
		vi.advanceTimersByTime(1500);
		batcher.push("[task-2 completed]");
		vi.advanceTimersByTime(1500);
		batcher.push("[task-3 completed]");
		vi.advanceTimersByTime(3000);

		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toContain("[task-1 completed]");
		expect(deliveries[0]).toContain("[task-2 completed]");
		expect(deliveries[0]).toContain("[task-3 completed]");
	});

	it("delivers a single event as-is (no separator)", () => {
		batcher.push("only one");
		vi.advanceTimersByTime(3000);
		expect(deliveries).toEqual(["only one"]);
	});

	it("delivers separate batches when the gap exceeds the window", () => {
		batcher.push("first");
		vi.advanceTimersByTime(3000);
		batcher.push("second");
		vi.advanceTimersByTime(3000);
		expect(deliveries).toEqual(["first", "second"]);
	});

	it("flush delivers immediately and is a no-op when empty", () => {
		batcher.push("queued");
		batcher.flush();
		expect(deliveries).toEqual(["queued"]);
		batcher.flush();
		expect(deliveries).toHaveLength(1);
		// Timer was cancelled by flush — nothing more arrives.
		vi.advanceTimersByTime(10_000);
		expect(deliveries).toHaveLength(1);
	});

	it("dispose drops pending parts and cancels the timer", () => {
		batcher.push("never delivered");
		batcher.dispose();
		vi.advanceTimersByTime(10_000);
		expect(deliveries).toHaveLength(0);
		expect(batcher.pendingCount).toBe(0);
	});
});
