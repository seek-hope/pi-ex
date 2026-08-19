/**
 * pi-ex fork host bridge.
 *
 * Capabilities the extension API does not expose (the session's custom
 * `streamFn`, the `SettingsManager`) are published here for fork extensions
 * (pi-extensions repo) to consume via `ctx.sessionManager` identity.
 *
 * This file is fork-owned and tiny on purpose: it is the ONLY place fork
 * extensions are allowed to bridge into core internals, which keeps the
 * upstream-conflict surface at the two registration lines in
 * agent-session.ts instead of scattered across the codebase.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface ForkHostHandle {
	streamFn: StreamFn | undefined;
	settingsManager: SettingsManager;
}

const hosts = new WeakMap<SessionManager, ForkHostHandle>();

export function registerForkHost(sessionManager: SessionManager, handle: ForkHostHandle): void {
	hosts.set(sessionManager, handle);
}

export function getForkHost(sessionManager: SessionManager): ForkHostHandle | undefined {
	return hosts.get(sessionManager);
}

// ── Extension-registered services ────────────────────────────────────────────
// Core wiring points that need an extension-provided implementation. The
// extension registers at load time; core call sites read at execution time.

export type BgSpawner = (
	task: string,
	cwd: string,
	timeoutMs: number,
	sessionId: string,
	label?: string,
) => Promise<{ id: string; logFile: string }>;

let bgSpawner: BgSpawner | undefined;

/** Called by the bg-tasks extension at load time. */
export function setBgSpawner(spawner: BgSpawner): void {
	bgSpawner = spawner;
}

export function getBgSpawner(): BgSpawner | undefined {
	return bgSpawner;
}
