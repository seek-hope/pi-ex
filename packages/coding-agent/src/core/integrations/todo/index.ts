/**
 * TodoIntegration — todo flow as a core integration.
 *
 * Owns the TodoStore, renders the todo widget (prioritized bounded view
 * with a "/todo for full list" hint), and forwards session lifecycle
 * events. Other core modules (e.g. subagent) access the store via
 * AgentSession.getIntegration("todo").
 *
 * Display design:
 * - Main widget: deliberately bounded (in_progress → pending → done),
 *   because string-array widgets are capped at MAX_WIDGET_LINES by the
 *   interactive mode — an unbounded list would be cut off arbitrarily
 *   with no recourse.
 * - /todo detail: factory-form component (bypasses the line cap), paged
 *   by terminal height. Repeated /todo cycles pages; past the last page
 *   it closes. The page refreshes in place on store changes.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { CoreIntegration, CoreIntegrationContext } from "../types.ts";
import { STATUS_ICONS, type TodoItem, TodoStore } from "./store.ts";
import { createTodoWriteToolDefinition } from "./tool.ts";

/** Item lines in the main widget before the "N more" hint kicks in. */
const MAIN_WIDGET_MAX_ITEMS = 8;

export class TodoIntegration implements CoreIntegration {
	readonly id = "todo";
	readonly store: TodoStore;

	private detailWidgetActive = false;
	/** Current 1-based detail page (valid only while detailWidgetActive). */
	private detailPage = 1;
	private readonly ctx: CoreIntegrationContext;
	/** Turn index set by AgentSession before each prompt. */
	private currentTurn = 0;
	/** Turn index of the most recent todo modification. */
	private lastActivityTurn = 0;
	/** Turn index when we last warned about stale todos (prevent spam). */
	private lastStaleWarnTurn = -1;

	constructor(ctx: CoreIntegrationContext) {
		this.ctx = ctx;
		this.store = new TodoStore(ctx.sessionManager, {
			onChange: () => {
				this.lastActivityTurn = this.currentTurn;
				this.renderWidget();
			},
			notify: (message, level) => this.ctx.getUI()?.notify(message, level),
		});
	}

	getToolDefinitions(): ToolDefinition[] {
		return [createTodoWriteToolDefinition(this.store) as ToolDefinition];
	}

	getDefaultActiveToolNames(): string[] {
		return ["todo_write"];
	}

	/** Items sorted for display: actionable first (in_progress → pending → done). */
	private sortedItems(): TodoItem[] {
		const items = this.store.getItems();
		const statusOrder = ["in_progress", "pending", "completed", "cancelled"];
		const statusRank = (s: string): number => {
			const idx = statusOrder.indexOf(s);
			return idx === -1 ? statusOrder.length : idx;
		};
		return items
			.map((item, index) => ({ item, index }))
			.sort((a, b) => statusRank(a.item.status) - statusRank(b.item.status) || a.index - b.index)
			.map(({ item }) => item);
	}

	/** How many items the main widget shows (rest goes to the /todo detail). */
	private mainWidgetItemCap(): number {
		const progressLines = this.store.getProgressItems().length > 0 ? this.store.getProgressItems().length + 2 : 0;
		return Math.max(2, MAIN_WIDGET_MAX_ITEMS - progressLines);
	}

	/** Items per detail page, adaptive to terminal height. */
	private detailPageSize(): number {
		const rows = process.stdout.rows ?? 24;
		return Math.min(25, Math.max(10, Math.floor(rows / 3)));
	}

	/** Whether the detail page is currently open. */
	isDetailOpen(): boolean {
		return this.detailWidgetActive;
	}

	/**
	 * Close the detail page if it is open (Esc). Returns true when it closed
	 * something — callers use this to swallow the key.
	 */
	closeDetailWidget(): boolean {
		if (!this.detailWidgetActive) return false;
		this.clearDetailWidget();
		return true;
	}

	/** /todo command: page through items the main widget cannot show, then close. */
	toggleDetailWidget(): void {
		const ui = this.ctx.getUI();
		if (!ui) return;

		const items = this.store.getItems();
		if (items.length === 0) {
			ui.notify("No todo items yet. Use todo_write to create a plan.", "info");
			return;
		}

		// The main widget already shows the first mainWidgetItemCap() items of
		// the same sorted list — the detail view continues where it ends, so
		// the two never show the same item.
		const hidden = this.sortedItems().slice(this.mainWidgetItemCap());
		if (hidden.length === 0) {
			ui.notify(`All ${items.length} item(s) are already visible in the todo widget.`, "info");
			return;
		}

		const pageSize = this.detailPageSize();
		const pages = Math.max(1, Math.ceil(hidden.length / pageSize));

		if (!this.detailWidgetActive) {
			this.detailWidgetActive = true;
			this.detailPage = 1;
		} else {
			this.detailPage++;
			if (this.detailPage > pages) {
				this.clearDetailWidget();
				ui.notify("Todo detail hidden", "info");
				return;
			}
		}

		this.renderDetailPage();
	}

	/** Render the current detail page (items beyond the main widget's window). */
	private renderDetailPage(): void {
		const ui = this.ctx.getUI();
		if (!ui || !this.detailWidgetActive) return;

		const items = this.store.getItems();
		if (items.length === 0) {
			this.clearDetailWidget();
			return;
		}

		const hidden = this.sortedItems().slice(this.mainWidgetItemCap());
		if (hidden.length === 0) {
			// Everything now fits in the main widget — nothing left to page.
			this.clearDetailWidget();
			return;
		}

		const done = items.filter((i) => i.status === "completed" || i.status === "cancelled").length;
		const pageSize = this.detailPageSize();
		const pages = Math.max(1, Math.ceil(hidden.length / pageSize));
		// Clamp after store changes (items may have shrunk mid-paging).
		this.detailPage = Math.min(this.detailPage, pages);
		const start = (this.detailPage - 1) * pageSize;
		const pageItems = hidden.slice(start, start + pageSize);

		const lines: string[] = [
			`Todo detail (${done}/${items.length} done · ${hidden.length} not shown above) — page ${this.detailPage}/${pages}`,
		];
		for (const item of pageItems) {
			const icon = STATUS_ICONS[item.status] || "○";
			if (item.status === "in_progress") {
				lines.push(`\x1b[1m${icon}\x1b[0m \x1b[1m${item.content}\x1b[0m`);
			} else {
				lines.push(`${icon} ${item.content}`);
			}
		}
		lines.push(
			this.detailPage < pages
				? `(${hidden.length} remaining items · /todo for next page)`
				: `(${hidden.length} remaining items · /todo to close)`,
		);

		// Factory-form component: bypasses the interactive mode's string-array
		// line cap (MAX_WIDGET_LINES) — the page size itself bounds the height.
		ui.setWidget("todo-detail", () => {
			const container = new Container();
			for (const line of lines) {
				container.addChild(new Text(line, 1, 0));
			}
			return container;
		});
	}

	private clearDetailWidget(): void {
		this.detailWidgetActive = false;
		this.detailPage = 1;
		this.ctx.getUI()?.setWidget("todo-detail", undefined);
	}

	private renderWidget(): void {
		const ui = this.ctx.getUI();
		if (!ui) return;

		if (this.store.isEmpty) {
			this.clearDetailWidget();
			ui.setWidget("todo", undefined);
			return;
		}

		// Keep the open detail page in sync instead of closing it on every
		// store change (todo_write while the user is paging through the list).
		if (this.detailWidgetActive) {
			this.renderDetailPage();
		}

		const items = this.store.getItems();
		const progress = this.store.getProgressItems();
		const done = items.filter((i) => i.status === "completed" || i.status === "cancelled").length;

		// Deliberately bounded view: the interactive mode caps string-array
		// widgets at MAX_WIDGET_LINES, so an unbounded list would be cut off
		// arbitrarily. Show actionable items first and hint at the rest.
		const sorted = this.sortedItems();

		// Reserve lines: header + hint + progress section, capped so the
		// whole widget stays within the interactive mode's line limit.
		const progressLines = progress.length > 0 ? progress.length + 2 : 0;
		const itemCap = Math.max(2, MAIN_WIDGET_MAX_ITEMS - progressLines);
		const shown = sorted.slice(0, itemCap);
		const hidden = sorted.length - shown.length;

		const lines: string[] = [];
		if (items.length > 0) {
			lines.push(`Todo (${done}/${items.length})`);
		}
		for (const item of shown) {
			const icon = STATUS_ICONS[item.status] || "○";
			const bold = item.status === "in_progress" ? "\x1b[1m" : "";
			const reset = item.status === "in_progress" ? "\x1b[0m" : "";
			lines.push(`${bold}${icon} ${item.content}${reset}`);
		}
		if (hidden > 0) {
			lines.push(`… ${hidden} more — /todo for full list`);
		}

		if (progress.length > 0) {
			if (items.length > 0) lines.push("");
			lines.push("Progress");
			for (const [key, prog] of progress) {
				lines.push(`  ◐ [${key}] ${prog.status}: ${prog.content}`);
			}
		}

		ui.setWidget("todo", lines);
	}

	onSessionStart(): void {
		this.clearDetailWidget();
		this.store.onSessionStart();
	}

	onAgentEnd(): void {
		this.store.onAgentEnd();
	}

	onSessionTree(): void {
		this.clearDetailWidget();
		this.store.onSessionTree();
	}

	/** Called before each user turn so staleness can be computed. */
	setTurnIndex(turnIndex: number): void {
		this.currentTurn = turnIndex;
	}

	/**
	 * Check for stale todo items (pending/in_progress items untouched for
	 * {@link gap} user inputs). Returns a steering message or null.
	 *
	 * When the warning fires, the activity timer restarts from the warning
	 * turn: if the model ignores the reminder, the items are almost
	 * certainly still unfinished, so it gets another full gap before the
	 * next reminder instead of being nagged every turn.
	 */
	getStaleWarning(gap = 8): string | null {
		if (this.currentTurn - this.lastActivityTurn < gap) return null;
		if (this.lastStaleWarnTurn === this.currentTurn) return null; // already warned this turn

		// Only model-owned items count. Programmatic (bridge) items are managed
		// by code — the model cannot clear them via todo_write (replaceFromModel
		// preserves them), so warning the model about them is both useless and
		// potentially an endless warning loop.
		const stale = this.store.getModelItems().filter((i) => i.status === "pending" || i.status === "in_progress");
		if (stale.length === 0) return null;

		// Capture the gap BEFORE resetting the timers — resetting first
		// would always report "0 turns".
		const staleFor = this.currentTurn - this.lastActivityTurn;
		this.lastStaleWarnTurn = this.currentTurn;
		// Reset the activity timer so we don't warn again every single turn.
		// The model just got notified — give it another 'gap' turns to act.
		this.lastActivityTurn = this.currentTurn;
		const names = stale.map((i) => `"${i.content.substring(0, 40)}${i.content.length > 40 ? "…" : ""}"`).join(", ");
		return (
			`Your todo list has not been updated for the last ${staleFor} user inputs. ` +
			`The following items are still pending or in progress: ${names}. ` +
			`Review them and cancel any that are no longer relevant, or update their status.`
		);
	}

	onShutdown(): void {
		this.store.onShutdown();
		const ui = this.ctx.getUI();
		ui?.setWidget("todo", undefined);
		ui?.setWidget("todo-detail", undefined);
		this.detailWidgetActive = false;
	}
}
