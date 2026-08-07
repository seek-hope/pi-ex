import { truncateToWidth } from "@earendil-works/pi-tui";
import type { UncertainItem } from "../../../core/compaction/review.ts";
import { pushWrapped } from "../../../utils/wrap-lines.ts";
import { theme } from "../theme/theme.ts";

export interface CompactionReviewResult {
	/** Line numbers in the summary that the user dismissed. */
	dismissedLines: Set<number>;
}

/**
 * TUI overlay widget for reviewing uncertain items after compaction.
 *
 * Each item is a statement drawn from the checkpoint summary. The user
 * decides its fate in memory: ✓ keep — retain it, ✗ abandon — drop it.
 * Navigation: arrow keys / j/k to move, space to toggle, a to keep all,
 * d to abandon all, enter/escape to confirm and close.
 */
export class CompactionReviewWidget {
	private selectedIdx = 0;
	private dismissed = new Set<number>();
	private items: UncertainItem[];
	private resolve?: (result: CompactionReviewResult) => void;

	constructor(items: UncertainItem[]) {
		this.items = items;
	}

	start(resolve: (result: CompactionReviewResult) => void): {
		render: (w: number) => string[];
		handleInput: (data: string) => boolean;
		invalidate: () => void;
	} {
		this.resolve = resolve;
		return {
			render: (w: number) => this.render(w),
			handleInput: (data: string) => this.handleInput(data),
			invalidate: () => {},
		};
	}

	private handleInput(data: string): boolean {
		// Return false to close, true to keep open
		if (data === "\x1b" || data === "\r") {
			// ESC or Enter: confirm and close
			this.resolve?.({ dismissedLines: new Set(this.dismissed) });
			return false;
		}
		if (data === "a") {
			this.dismissed.clear();
			this.resolve?.({ dismissedLines: new Set() });
			return false;
		}
		if (data === "d") {
			for (const item of this.items) this.dismissed.add(item.sourceLine);
			this.resolve?.({ dismissedLines: new Set(this.dismissed) });
			return false;
		}
		if (data === " ") {
			const item = this.items[this.selectedIdx];
			if (item) {
				if (this.dismissed.has(item.sourceLine)) {
					this.dismissed.delete(item.sourceLine);
				} else {
					this.dismissed.add(item.sourceLine);
				}
			}
			return true;
		}
		if (data === "j" || data === "\x1b[B") {
			// down
			this.selectedIdx = Math.min(this.selectedIdx + 1, this.items.length - 1);
			return true;
		}
		if (data === "k" || data === "\x1b[A") {
			// up
			this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
			return true;
		}
		return true;
	}

	private render(w: number): string[] {
		const lines: string[] = [];
		const A = (s: string) => theme.fg("accent", theme.bold(s));
		const M = (s: string) => theme.fg("dim", s);
		const H = (s: string) => theme.fg("warning", s);
		const G = (s: string) => theme.fg("success", s);

		lines.push("");
		lines.push(A(" Compaction Review"));
		lines.push(M(` ${this.items.length} statements to keep or abandon`));
		// Legend states the decision and its object: the whole statement line.
		pushWrapped(lines, M(` ${G("✓")} keep — retain statement in memory  ${H("✗")} abandon — drop it`), w);
		lines.push("");

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const isSelected = i === this.selectedIdx;
			const isDismissed = this.dismissed.has(item.sourceLine);
			const prefix = isSelected ? "▸" : " ";
			const check = isDismissed ? "✗" : "✓";

			const line = ` ${prefix} ${check} ${item.text}`;
			// Long items wrap to continuation lines instead of being truncated —
			// the user must read the full item to judge it. Width measured in
			// terminal cells (ANSI-aware, CJK double-width): raw .length budgeting
			// here crashed the TUI on CJK summaries.
			pushWrapped(lines, isSelected ? H(line) : line, w);
		}

		lines.push("");
		lines.push(truncateToWidth(M(" ─────────────────────────────────────────────"), w, ""));
		// Key hints wrap to continuation lines instead of truncating.
		pushWrapped(
			lines,
			` ${H("↑↓")} ${M("navigate")}  ` +
				`${H("Space")} ${M("toggle keep/abandon")}  ` +
				`${G("a")} ${M("keep all")}  ` +
				`${H("d")} ${M("abandon all")}  ` +
				`${M("Enter")} ${M("confirm")}`,
			w,
		);
		lines.push("");

		return lines;
	}
}
