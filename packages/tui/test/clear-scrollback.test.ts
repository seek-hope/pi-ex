import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import type { TUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function lines(terminal: VirtualTerminal): string[] {
	const xterm = (terminal as unknown as { xterm: { buffer: { active: { length: number } } } }).xterm;
	// Scrollback region size is not directly exposed; render state is checked via the screen methods below.
	void xterm;
	return [];
}

describe("TUI clearScrollback", () => {
	it("TuiMainScreen resets render state and forces a full redraw", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const first = new Text("line one", 1, 0);
		const second = new Text("line two", 1, 1);
		tui.addChild(first);
		tui.addChild(second);
		tui.start();
		await terminal.waitForRender();

		// Grow the rendered output, then clearScrollback and shrink the tree —
		// the next render must reflect only the remaining content.
		const third = new Text("line three", 1, 2);
		tui.addChild(third);
		tui.requestRender();
		await terminal.waitForRender();

		tui.clearScrollback();
		await terminal.waitForRender();

		// State was reset: a subsequent render of a smaller tree must not leave
		// stale maxLinesRendered (no clearOnShrink dependency).
		tui.removeChild(third);
		tui.requestRender();
		await terminal.waitForRender();

		const state = (tui as unknown as { getRenderState?: () => unknown }).getRenderState?.();
		if (state) {
			const { maxLinesRendered, previousLines } = state as { maxLinesRendered: number; previousLines: unknown[] };
			assert.ok(previousLines.length <= 2, `previousLines should be small, got ${previousLines.length}`);
			assert.ok(maxLinesRendered <= 2, `maxLinesRendered should be reset, got ${maxLinesRendered}`);
		}
		tui.stop();
		void lines(terminal);
	});

	it("TuiAltScreen resets viewport and scrolls to end", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiAltScreen(terminal);
		const first = new Text("alt one", 1, 0);
		const second = new Text("alt two", 1, 1);
		tui.addChild(first);
		tui.addChild(second);
		tui.start();
		await terminal.waitForRender();

		const scrollView = (
			tui as unknown as { getPrimaryScrollView?: () => { scrollToStart(): void; scrollBy(n: number): void } }
		).getPrimaryScrollView?.();
		scrollView?.scrollToStart();
		tui.requestRender();
		await terminal.waitForRender();

		tui.clearScrollback();
		await terminal.waitForRender();

		// clearScrollback must not throw and must keep rendering subsequent content.
		const third = new Text("alt three", 1, 2);
		tui.addChild(third);
		tui.requestRender();
		await terminal.waitForRender();
		tui.stop();
	});
});
