/**
 * Scrollable result viewer for the /btw side-query overlay.
 * ↑↓/j/k scroll, g/G/home jump, esc/q/enter closes.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";

export class BtwScrollViewer {
	private lines: string[];
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(content: string) {
		this.lines = content.split("\n");
	}

	/** Returns false when the viewer wants to close. */
	handleInput(data: string): boolean {
		const visible = this.visibleLines();
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.scroll < this.lines.length - visible) {
				this.scroll++;
				this.invalidate();
			}
			return true;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.scroll > 0) {
				this.scroll--;
				this.invalidate();
			}
			return true;
		}
		if (data === "g" || matchesKey(data, Key.home)) {
			if (this.scroll > 0) {
				this.scroll = 0;
				this.invalidate();
			}
			return true;
		}
		if (data === "G") {
			const bottom = Math.max(0, this.lines.length - visible);
			if (this.scroll < bottom) {
				this.scroll = bottom;
				this.invalidate();
			}
			return true;
		}
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.enter)) {
			return false;
		}
		return true;
	}

	private visibleLines(): number {
		const rows = process.stdout.rows || 24;
		return Math.max(5, rows - 8);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const out: string[] = [];
		const maxLineWidth = width - 2;
		const visible = this.visibleLines();
		const end = Math.min(this.scroll + visible, this.lines.length);

		for (let i = this.scroll; i < end; i++) {
			const line = this.lines[i];
			out.push(line.length <= maxLineWidth ? ` ${line}` : ` ${line.substring(0, maxLineWidth - 1)}…`);
		}
		while (out.length < visible) {
			out.push("");
		}

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
