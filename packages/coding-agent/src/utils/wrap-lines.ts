/**
 * Wrap styled lines instead of truncating them, so user-facing text is
 * never cut off. Continuation lines are indented so wrapped blocks stay
 * visually aligned.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Word-wrap a (possibly ANSI-styled) line and append the result to
 * `lines`; continuation lines get `indent` leading spaces.
 */
export function pushWrapped(lines: string[], styled: string, width: number, indent = 6): void {
	const wrapWidth = Math.max(10, width - indent);
	const wrapped = wrapTextWithAnsi(styled, wrapWidth);
	for (let i = 0; i < wrapped.length; i++) {
		lines.push(i === 0 ? wrapped[i] : " ".repeat(indent) + wrapped[i]);
	}
}
