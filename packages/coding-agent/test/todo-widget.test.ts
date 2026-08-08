/**
 * Tests for the TodoIntegration widget display: bounded main widget with a
 * "N more" hint, and the paged /todo detail widget.
 */
import { describe, expect, it } from "vitest";
import { TodoIntegration } from "../src/core/integrations/todo/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

interface WidgetCall {
	key: string;
	content: string[] | ((tui: never, theme: never) => { children?: unknown[] }) | undefined;
}

function makeCtx(items: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>) {
	const widgets: WidgetCall[] = [];
	const notifications: string[] = [];
	let integration!: TodoIntegration;
	const ctx = {
		cwd: "/tmp",
		sessionManager: SessionManager.inMemory(),
		settingsManager: undefined,
		modelRuntime: undefined,
		getUI: () => ({
			setWidget: (key: string, content: WidgetCall["content"]) => {
				widgets.push({ key, content });
			},
			notify: (msg: string) => notifications.push(msg),
		}),
		getModel: () => undefined,
		getIntegration: () => integration,
		sendFollowUp: undefined,
	} as never;
	integration = new TodoIntegration(ctx);
	// Seed via the model entry point so items are model-owned (addItem is
	// the programmatic bridge API, excluded from staleness and persistence).
	if (items.length > 0) {
		integration.store.replaceFromModel(items);
	}
	return { integration, widgets, notifications };
}

/** Render a widget call's content to plain lines (string[] or factory). */
function linesOf(call: WidgetCall): string[] {
	if (Array.isArray(call.content)) return call.content;
	if (typeof call.content === "function") {
		const component = call.content(undefined as never, undefined as never);
		return ((component as { children?: Array<{ text?: string }> }).children ?? []).map((c) => c.text ?? "");
	}
	return [];
}

describe("todo stale warning", () => {
	it("reports the real staleness gap, not 0", () => {
		const { integration } = makeCtx([{ content: "task A", status: "pending" }]);
		// Item added at turn 0; 7 turns have passed.
		integration.setTurnIndex(7);
		const warning = integration.getStaleWarning(5);
		expect(warning).toContain("7 user inputs");
	});

	it("respects the gap threshold", () => {
		const { integration } = makeCtx([{ content: "task A", status: "pending" }]);
		integration.setTurnIndex(4);
		expect(integration.getStaleWarning(5)).toBeNull();
	});

	it("returns null when nothing is pending or in progress", () => {
		const { integration } = makeCtx([{ content: "task A", status: "completed" }]);
		integration.setTurnIndex(10);
		expect(integration.getStaleWarning(5)).toBeNull();
	});

	it("warns once, then stays quiet for another grace period", () => {
		const { integration } = makeCtx([{ content: "task A", status: "pending" }]);
		integration.setTurnIndex(6);
		expect(integration.getStaleWarning(5)).toContain("6 user inputs");
		// Activity timer reset by the warning — quiet during the new grace period.
		integration.setTurnIndex(8);
		expect(integration.getStaleWarning(5)).toBeNull();
		integration.setTurnIndex(11);
		expect(integration.getStaleWarning(5)).toContain("5 user inputs");
	});

	it("never fires when the list has always been empty", () => {
		const { integration } = makeCtx([]);
		for (let turn = 1; turn <= 20; turn++) {
			integration.setTurnIndex(turn);
			expect(integration.getStaleWarning(5)).toBeNull();
		}
	});

	it("never fires after the model clears the list", () => {
		// Model-owned items (replaceFromModel), then an empty snapshot.
		const { integration } = makeCtx([{ content: "task A", status: "pending" }]);
		integration.setTurnIndex(1);
		integration.store.replaceFromModel([]);
		expect(integration.store.getItems()).toHaveLength(0);
		for (let turn = 6; turn <= 20; turn++) {
			integration.setTurnIndex(turn);
			expect(integration.getStaleWarning(5)).toBeNull();
		}
	});

	it("never fires for programmatic-only items the model cannot clear", () => {
		// A stuck bridge item (e.g. subagent status) must not warn the model —
		// replaceFromModel preserves programmatic items, so the model has no
		// way to act on the warning.
		const { integration } = makeCtx([]);
		integration.store.addItem("🔍 subagent task", "pending");
		for (let turn = 6; turn <= 20; turn++) {
			integration.setTurnIndex(turn);
			expect(integration.getStaleWarning(5)).toBeNull();
		}
	});
});

describe("todo widget display", () => {
	it("bounds the main widget and hints at hidden items", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" as const }));
		const { widgets } = makeCtx(items);
		const todoWidget = widgets.filter((w) => w.key === "todo").at(-1);
		expect(todoWidget).toBeDefined();
		const lines = linesOf(todoWidget!);
		expect(lines[0]).toBe("Todo (0/20)");
		// 1 header + 8 items + 1 hint = 10 lines, within the 10-line cap.
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.at(-1)).toContain("12 more");
		expect(lines.at(-1)).toContain("/todo");
	});

	it("shows actionable items first in the main widget", () => {
		const { widgets } = makeCtx([
			{ content: "done 1", status: "completed" },
			{ content: "done 2", status: "completed" },
			{ content: "active", status: "in_progress" },
			{ content: "later", status: "pending" },
		]);
		const lines = linesOf(widgets.filter((w) => w.key === "todo").at(-1)!);
		expect(lines[1]).toContain("active");
		expect(lines[2]).toContain("later");
	});

	it("does not hint when everything fits", () => {
		const { widgets } = makeCtx([
			{ content: "a", status: "pending" },
			{ content: "b", status: "pending" },
		]);
		const lines = linesOf(widgets.filter((w) => w.key === "todo").at(-1)!);
		expect(lines.some((l) => l.includes("more"))).toBe(false);
	});

	it("pages through the detail list with /todo, starting where the widget ends", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" as const }));
		const { integration, widgets } = makeCtx(items);

		const detailPages: string[][] = [];
		for (let i = 0; i < 5; i++) {
			integration.toggleDetailWidget();
			const call = widgets.filter((w) => w.key === "todo-detail").at(-1);
			if (!call || call.content === undefined) {
				detailPages.push([]); // closed
				break;
			}
			detailPages.push(linesOf(call));
		}

		// Widget window is 8 items; detail shows the remaining 12 (pageSize 10).
		expect(detailPages[0][0]).toContain("page 1/2");
		expect(detailPages[0][0]).toContain("(0/20 done");
		expect(detailPages[0].some((l) => /task 8$/.test(l))).toBe(false); // still in the widget window
		expect(detailPages[0].some((l) => l.includes("task 9"))).toBe(true);
		expect(detailPages[0].some((l) => l.includes("task 18"))).toBe(true);
		expect(detailPages[0].some((l) => l.includes("task 19"))).toBe(false);

		expect(detailPages[1][0]).toContain("page 2/2");
		expect(detailPages[1].some((l) => l.includes("task 19"))).toBe(true);
		expect(detailPages[1].some((l) => l.includes("task 20"))).toBe(true);

		// Third toggle closes the widget.
		expect(detailPages[2]).toEqual([]);
	});

	it("widget + detail pages partition the list (no duplication, no loss)", () => {
		const items = Array.from({ length: 23 }, (_, i) => ({
			content: `todo-${String(i + 1).padStart(2, "0")}`,
			status: "pending" as const,
		}));
		const { integration, widgets } = makeCtx(items);

		// Collect items visible in the main widget.
		const widgetLines = linesOf(widgets.filter((w) => w.key === "todo").at(-1)!);
		const inWidget = new Set<string>();
		for (const line of widgetLines) {
			const m = line.match(/todo-\d\d/);
			if (m) inWidget.add(m[0]);
		}
		expect(inWidget.size).toBe(8);

		// Collect items shown across all detail pages.
		const inDetail = new Set<string>();
		for (let i = 0; i < 5; i++) {
			integration.toggleDetailWidget();
			const call = widgets.filter((w) => w.key === "todo-detail").at(-1);
			if (!call || call.content === undefined) break;
			for (const line of linesOf(call)) {
				const m = line.match(/todo-\d\d/);
				if (m) inDetail.add(m[0]);
			}
		}

		// No overlap; together they cover all 23 items.
		for (const id of inWidget) expect(inDetail.has(id)).toBe(false);
		expect(inWidget.size + inDetail.size).toBe(23);
	});

	it("/todo does not open a detail widget when everything fits in the main widget", () => {
		const items = Array.from({ length: 5 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" as const }));
		const { integration, widgets, notifications } = makeCtx(items);

		integration.toggleDetailWidget();
		expect(widgets.filter((w) => w.key === "todo-detail")).toHaveLength(0);
		expect(notifications.at(-1)).toContain("already visible");
	});

	it("Esc closes the detail page without paging to the end", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" as const }));
		const { integration, widgets } = makeCtx(items);

		integration.toggleDetailWidget(); // open page 1
		expect(integration.isDetailOpen()).toBe(true);
		expect(widgets.filter((w) => w.key === "todo-detail").at(-1)!.content).toBeDefined();

		expect(integration.closeDetailWidget()).toBe(true);
		expect(integration.isDetailOpen()).toBe(false);
		// Closed: the widget was removed.
		expect(widgets.filter((w) => w.key === "todo-detail").at(-1)!.content).toBeUndefined();

		// Nothing open → closeDetailWidget reports no-op.
		expect(integration.closeDetailWidget()).toBe(false);
	});

	it("keeps the detail widget open (in sync) when items change mid-paging", () => {
		const items = Array.from({ length: 15 }, (_, i) => ({ content: `task ${i + 1}`, status: "pending" as const }));
		const { integration, widgets } = makeCtx(items);

		integration.toggleDetailWidget(); // open page 1
		expect(widgets.filter((w) => w.key === "todo-detail").at(-1)!.content).toBeDefined();

		// Store change while the detail is open: it must refresh, not close.
		integration.store.addItem("replacement", "in_progress");

		const call = widgets.filter((w) => w.key === "todo-detail").at(-1)!;
		expect(call.content).not.toBeUndefined();
		const lines = linesOf(call);
		expect(lines[0]).toContain("(0/16 done");
	});
});
