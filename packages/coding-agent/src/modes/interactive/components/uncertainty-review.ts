import { truncateToWidth } from "@earendil-works/pi-tui";
import type { UncertainFlag, UncertaintyDecision } from "../../../core/compaction/uncertainty.ts";
import { pushWrapped } from "../../../utils/wrap-lines.ts";
import { theme } from "../theme/theme.ts";

export interface UncertaintyReviewDecision {
	decision: UncertaintyDecision["decision"];
	correction?: string;
}

export interface UncertaintyReviewResult {
	/** Decisions made in this session, keyed by flagId. Undecided items are absent (deferred). */
	decisions: Map<string, UncertaintyReviewDecision>;
}

export interface UncertaintyBrowseResult {
	/** Decided flags the user sent back to the pending queue. */
	requeue: string[];
	/** Superseding decisions made while browsing (re-correct / re-dismiss / re-verify). */
	overrides: Map<string, UncertaintyReviewDecision>;
}

/**
 * Run-end prompt for incremental uncertainty review.
 *
 * Review mode keys: arrows/j-k navigate, Enter/v verify, d dismiss,
 * c correct (inline input), A verify all, D dismiss all, Esc defer all.
 * Closes automatically when every shown item has been decided.
 */
export class UncertaintyReviewWidget {
	private selectedIdx = 0;
	private decided = new Map<string, UncertaintyReviewDecision>();
	private correcting = false;
	private correctionBuffer = "";
	private readonly items: UncertainFlag[];
	private readonly hiddenCount: number;

	constructor(items: UncertainFlag[], hiddenCount = 0) {
		this.items = items;
		this.hiddenCount = hiddenCount;
	}

	start(resolve: (result: UncertaintyReviewResult) => void): {
		render: (w: number) => string[];
		handleInput: (data: string) => boolean;
		invalidate: () => void;
	} {
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			resolve({ decisions: new Map(this.decided) });
		};
		return {
			render: (w: number) => this.render(w),
			handleInput: (data: string) => {
				if (this.handleInput(data, close)) return true;
				close();
				return false;
			},
			invalidate: () => {},
		};
	}

	/** Returns true to stay open, false to close. */
	private handleInput(data: string, close: () => void): boolean {
		if (this.correcting) {
			return this.handleCorrectionInput(data);
		}
		if (data === "\x1b") return false; // Esc: defer the rest
		if (data === "j" || data === "\x1b[B") {
			this.selectedIdx = Math.min(this.selectedIdx + 1, this.items.length - 1);
			return true;
		}
		if (data === "k" || data === "\x1b[A") {
			this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
			return true;
		}
		if (data === "\r" || data === "v") {
			this.decideSelected({ decision: "verified" });
		} else if (data === "d") {
			this.decideSelected({ decision: "dismissed" });
		} else if (data === "c") {
			this.correcting = true;
			this.correctionBuffer = "";
			return true;
		} else if (data === "A") {
			for (const item of this.items) {
				if (!this.decided.has(item.id)) this.decided.set(item.id, { decision: "verified" });
			}
		} else if (data === "D") {
			for (const item of this.items) {
				if (!this.decided.has(item.id)) this.decided.set(item.id, { decision: "dismissed" });
			}
		} else {
			return true;
		}
		if (this.decided.size >= this.items.length) {
			close();
			return false;
		}
		this.advanceToUndecided();
		return true;
	}

	private handleCorrectionInput(data: string): boolean {
		if (data === "\x1b") {
			this.correcting = false;
			return true;
		}
		if (data === "\r") {
			const correction = this.correctionBuffer.trim();
			this.correcting = false;
			if (correction) {
				this.decideSelected({ decision: "corrected", correction });
				if (this.decided.size >= this.items.length) return false;
				this.advanceToUndecided();
			}
			return true;
		}
		if (data === "\x7f") {
			this.correctionBuffer = this.correctionBuffer.slice(0, -1);
			return true;
		}
		// Printable input (single chars or pasted text), ignore other control keys
		if (data.length >= 1 && !data.startsWith("\x1b") && data !== "\t") {
			this.correctionBuffer += data;
		}
		return true;
	}

	private decideSelected(decision: UncertaintyReviewDecision): void {
		const item = this.items[this.selectedIdx];
		if (item) this.decided.set(item.id, decision);
	}

	private advanceToUndecided(): void {
		for (let i = 0; i < this.items.length; i++) {
			const idx = (this.selectedIdx + 1 + i) % this.items.length;
			if (!this.decided.has(this.items[idx].id)) {
				this.selectedIdx = idx;
				return;
			}
		}
	}

	private render(w: number): string[] {
		const lines: string[] = [];
		const A = (s: string) => theme.fg("accent", theme.bold(s));
		const M = (s: string) => theme.fg("dim", s);
		const H = (s: string) => theme.fg("warning", s);
		const G = (s: string) => theme.fg("success", s);

		const extra = this.hiddenCount > 0 ? `, ${this.hiddenCount} more queued` : "";
		lines.push("");
		lines.push(truncateToWidth(A(" Uncertainty Review"), w, "…"));
		// Meta line wraps to continuation lines instead of truncating.
		pushWrapped(lines, M(` ${this.items.length} flagged claim(s) to decide${extra}`), w);
		lines.push("");

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const isSelected = i === this.selectedIdx;
			const decision = this.decided.get(item.id);
			const prefix = isSelected ? "▸" : " ";
			const check = decision ? (decision.decision === "dismissed" ? "✗" : "✓") : "?";
			const subject = item.subject ? M(` (${item.subject})`) : "";
			const stale = item.staleNote ? H(` {${item.staleNote}}`) : "";
			const suffix = decision?.decision === "corrected" ? G(` → ${decision.correction}`) : "";
			const line = ` ${prefix} ${check} ${item.claim}${subject}${stale}${suffix}`;
			// Long claims wrap to continuation lines instead of being truncated —
			// the user must read the full claim to judge it.
			pushWrapped(lines, isSelected ? H(line) : line, w);
		}

		lines.push("");
		if (this.correcting) {
			pushWrapped(lines, ` ${G("Correction:")} ${this.correctionBuffer}█`, w);
			lines.push(truncateToWidth(M(" Enter submit · Esc cancel"), w, "…"));
		} else {
			lines.push(truncateToWidth(M(" ─────────────────────────────────────────────"), w, ""));
			// Key hints wrap to continuation lines instead of truncating.
			pushWrapped(
				lines,
				` ${G("Enter")} ${M("verify")}  ` +
					`${H("c")} ${M("correct")}  ` +
					`${H("d")} ${M("dismiss")}  ` +
					`${M("A/D all")}  ` +
					`${M("Esc defer to compaction")}`,
				w,
			);
		}
		lines.push("");
		return lines;
	}
}

/**
 * /review browse mode: inspect already-decided flags, send back to pending
 * (u), or supersede with a new ruling (v/d/c).
 */
export class UncertaintyBrowseWidget {
	private selectedIdx = 0;
	private requeue = new Set<string>();
	private overrides = new Map<string, UncertaintyReviewDecision>();
	private correcting = false;
	private correctionBuffer = "";
	private readonly items: UncertaintyDecision[];

	constructor(items: UncertaintyDecision[]) {
		this.items = items;
	}

	start(resolve: (result: UncertaintyBrowseResult) => void): {
		render: (w: number) => string[];
		handleInput: (data: string) => boolean;
		invalidate: () => void;
	} {
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			resolve({ requeue: [...this.requeue], overrides: new Map(this.overrides) });
		};
		return {
			render: (w: number) => this.render(w),
			handleInput: (data: string) => {
				if (this.handleInput(data)) return true;
				close();
				return false;
			},
			invalidate: () => {},
		};
	}

	private handleInput(data: string): boolean {
		if (this.correcting) {
			if (data === "\x1b") {
				this.correcting = false;
				return true;
			}
			if (data === "\r") {
				const correction = this.correctionBuffer.trim();
				this.correcting = false;
				const item = this.items[this.selectedIdx];
				if (item && correction) {
					this.overrides.set(item.flagId, { decision: "corrected", correction });
					this.requeue.delete(item.flagId);
				}
				return true;
			}
			if (data === "\x7f") {
				this.correctionBuffer = this.correctionBuffer.slice(0, -1);
				return true;
			}
			if (data.length >= 1 && !data.startsWith("\x1b") && data !== "\t") {
				this.correctionBuffer += data;
			}
			return true;
		}
		if (data === "\x1b" || data === "\r") return false;
		if (data === "j" || data === "\x1b[B") {
			this.selectedIdx = Math.min(this.selectedIdx + 1, this.items.length - 1);
			return true;
		}
		if (data === "k" || data === "\x1b[A") {
			this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
			return true;
		}
		const item = this.items[this.selectedIdx];
		if (!item) return true;
		if (data === "u") {
			if (this.requeue.has(item.flagId)) this.requeue.delete(item.flagId);
			else this.requeue.add(item.flagId);
			this.overrides.delete(item.flagId);
		} else if (data === "v") {
			this.overrides.set(item.flagId, { decision: "verified" });
			this.requeue.delete(item.flagId);
		} else if (data === "d") {
			this.overrides.set(item.flagId, { decision: "dismissed" });
			this.requeue.delete(item.flagId);
		} else if (data === "c") {
			this.correcting = true;
			this.correctionBuffer = "";
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
		lines.push(truncateToWidth(A(" Decided Uncertainty Flags"), w, "…"));
		// Meta line wraps to continuation lines instead of truncating.
		pushWrapped(
			lines,
			M(` ${this.items.length} decided item(s) — u re-queue for review, v/d/c supersede, Esc close`),
			w,
		);
		lines.push("");

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const isSelected = i === this.selectedIdx;
			const prefix = isSelected ? "▸" : " ";
			const override = this.overrides.get(item.flagId);
			const effective = override?.decision ?? item.decision;
			const queued = this.requeue.has(item.flagId);
			const state = queued
				? H("[re-queue]")
				: effective === "verified"
					? G("[verified]")
					: effective === "corrected"
						? G("[corrected]")
						: M("[dismissed]");
			const correction = effective === "corrected" ? G(` → ${override?.correction ?? item.correction}`) : "";
			const line = ` ${prefix} ${state} ${item.claim}${correction}`;
			pushWrapped(lines, isSelected ? H(line) : line, w);
		}

		lines.push("");
		if (this.correcting) {
			pushWrapped(lines, ` ${G("Correction:")} ${this.correctionBuffer}█`, w);
			lines.push(truncateToWidth(M(" Enter submit · Esc cancel"), w, "…"));
		}
		lines.push("");
		return lines;
	}
}
