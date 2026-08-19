/**
 * Shared timeout parameter for tool schemas.
 *
 * Exactly two accepted forms:
 *   1. Plain number — SECONDS (the default unit everywhere)
 *   2. Suffixed string — "500ms", "30s", "5m", "2h" (explicit unit)
 *
 * Bare numbers default to seconds across ALL tools, so a unit mix-up
 * cannot silently change behavior: the only way to express milliseconds
 * is an explicit "ms" suffix.
 */

import { type Static, Type } from "typebox";

export const TIMEOUT_UNITS = ["ms", "s", "m", "h"] as const;
export type TimeoutUnit = (typeof TIMEOUT_UNITS)[number];

const UNIT_MULTIPLIERS: Record<TimeoutUnit, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Acceptable timeout input: a plain number of seconds, or a string with an
 * explicit unit suffix.
 */
export const TimeoutParamSchema = Type.Union(
	[
		Type.Number({ description: "Timeout in SECONDS — the default unit (e.g. 30)" }),
		Type.String({ description: "Timeout with explicit unit, e.g. '30s', '500ms', '5m'" }),
	],
	{ description: "Timeout in SECONDS by default, or with an explicit unit suffix ('30s', '500ms', '5m', '2h')" },
);

export type TimeoutInput = Static<typeof TimeoutParamSchema>;

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout ceiling
const SUFFIX_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;

/**
 * Convert a timeout to milliseconds. Bare numbers are SECONDS.
 * Throws on invalid values.
 */
export function timeoutToMs(timeout: TimeoutInput, paramName = "timeout"): number {
	let ms: number;
	if (typeof timeout === "number") {
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new Error(`Invalid ${paramName}: value must be a positive number of seconds (got ${timeout}).`);
		}
		ms = timeout * 1000;
	} else {
		const m = timeout.trim().match(SUFFIX_RE);
		if (!m) {
			throw new Error(
				`Invalid ${paramName}: "${timeout}". Use a plain number of SECONDS or a suffixed string like '30s', '500ms', '5m'.`,
			);
		}
		const val = Number.parseFloat(m[1]);
		if (val <= 0) {
			throw new Error(`Invalid ${paramName}: "${timeout}". Must be positive.`);
		}
		// Bare number strings default to seconds too.
		const unit = (m[2] || "s").toLowerCase() as TimeoutUnit;
		ms = val * UNIT_MULTIPLIERS[unit];
	}

	// Clamp to the timer-safe range: 0 would fire immediately, and above the
	// ceiling setTimeout silently truncates — report instead of corrupting the wait.
	ms = Math.max(1, Math.round(ms));
	if (ms > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid ${paramName}: ${timeout} exceeds the maximum (~24.8 days).`);
	}
	return ms;
}

/** Compact display form: 30 → "30s", "500ms" → "500ms". */
export function formatTimeout(timeout: TimeoutInput): string {
	return typeof timeout === "number" ? `${timeout}s` : timeout;
}
