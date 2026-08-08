import { describe, expect, it } from "vitest";
import type { BackgroundTask } from "../src/core/integrations/bg-tasks/store.ts";
import { BgTasksWidget } from "../src/modes/interactive/components/bg-tasks-widget.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

function task(id: string, status: "running" | "done" | "killed" | "error", label?: string): BackgroundTask {
	const startTime = Date.now() - 5000;
	return {
		id,
		description: `echo ${id}`,
		label,
		cwd: "/tmp",
		status,
		startTime,
		endTime: status === "running" ? undefined : startTime + 1000,
		logFile: `/tmp/${id}.log`,
	};
}

function makeWidget(overrides?: {
	tasks?: BackgroundTask[];
	getTasks?: () => BackgroundTask[];
	onView?: (id: string) => void;
	onKill?: (id: string) => Promise<boolean>;
	onExit?: () => void;
}) {
	const seen: string[] = [];
	const widget = new BgTasksWidget({
		getTasks: overrides?.getTasks ?? (() => overrides?.tasks ?? [task("t1", "running", "build"), task("t2", "done")]),
		onView: (id) => {
			seen.push(`view:${id}`);
			overrides?.onView?.(id);
		},
		onBackFromView: () => {
			seen.push("back");
		},
		onKill: async (id) => {
			seen.push(`kill:${id}`);
			overrides?.onKill?.(id);
			return true;
		},
		onExit: () => {
			seen.push("exit");
			overrides?.onExit?.();
		},
		height: 10,
	});
	return { widget, seen };
}

describe("BgTasksWidget", () => {
	it("moves selection with arrow keys and views on Enter", () => {
		const { widget, seen } = makeWidget();
		widget.focused = true;
		widget.handleInput("\u001b[B"); // down
		widget.handleInput("\n"); // enter on t2
		expect(seen).toEqual(["view:t2"]);
		widget.dispose();
	});

	it("kills the selected task with k", async () => {
		const { widget, seen } = makeWidget();
		widget.focused = true;
		widget.handleInput("\u001b[B");
		widget.handleInput("k");
		await new Promise((r) => setTimeout(r, 10));
		expect(seen).toEqual(["kill:t2"]);
		widget.dispose();
	});

	it("first Esc leaves the preview (back to list), second Esc closes the manager", () => {
		const { widget, seen } = makeWidget();
		widget.focused = true;
		widget.handleInput("\n"); // view t1
		expect(seen).toEqual(["view:t1"]);
		widget.handleInput("\u001b"); // first Esc: back to list
		expect(seen).toEqual(["view:t1", "back"]);
		widget.handleInput("\u001b"); // second Esc: close
		expect(seen).toEqual(["view:t1", "back", "exit"]);
		widget.dispose();
	});

	it("moving the selection while viewing dismisses the preview", () => {
		const { widget, seen } = makeWidget();
		widget.focused = true;
		widget.handleInput("\n"); // view t1
		widget.handleInput("\u001b[B"); // down: leaves preview
		expect(seen).toEqual(["view:t1", "back"]);
		widget.dispose();
	});

	it("keeps the selection valid after the task list shrinks", () => {
		const state = { tasks: [task("a", "running"), task("b", "running"), task("c", "done")] };
		const { widget } = makeWidget({ getTasks: () => state.tasks });
		widget.focused = true;
		widget.handleInput("\u001b[B");
		widget.handleInput("\u001b[B");
		// c selected; now it disappears.
		state.tasks = [task("a", "running"), task("b", "running")];
		widget.refresh();
		widget.handleInput("\n");
		expect((widget as unknown as { tasks: BackgroundTask[] }).tasks.length).toBe(2);
		widget.dispose();
	});

	it("no-ops input when there are no tasks", () => {
		const { widget, seen } = makeWidget({ tasks: [] });
		widget.focused = true;
		widget.handleInput("\n");
		widget.handleInput("k");
		widget.handleInput("\u001b[B");
		expect(seen).toEqual([]);
		widget.dispose();
	});
});
