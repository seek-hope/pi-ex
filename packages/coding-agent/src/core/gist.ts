/**
 * `shareSessionAsGist` — create a secret GitHub gist from an exported HTML file
 * and return the Pi share-viewer URL.
 *
 * Extracted from the TUI `InteractiveMode.handleShareCommand` so both the TUI
 * and the Web UI runtime (`share_as_gist`) share one implementation. The helper
 * checks `gh auth status`, creates a **secret** gist via `gh gist create
 * --public=false`, parses the gist id out of the returned URL, and returns
 * `getShareViewerUrl(gistId)`.
 *
 * Errors are surfaced as `Error`s with a user-facing message (gh missing /
 * not-authed / gist-create failure / unparseable output); callers map them to
 * their own error vocabulary. An optional `AbortSignal` cancels the in-flight
 * `gh gist create` process (the TUI's loader passes one).
 */

import { spawn, spawnSync } from "node:child_process";
import { getShareViewerUrl } from "../config.ts";

export interface ShareSessionAsGistOptions {
	/** Path to the exported HTML file to upload. */
	htmlPath: string;
	/** Optional display name (currently unused by `gh gist create`). */
	name?: string;
	/** Optional cancellation signal (kills the in-flight `gh gist create`). */
	signal?: AbortSignal;
}

/**
 * Check `gh auth status`, create a secret gist from `htmlPath`, and return the
 * share viewer URL. Throws an `Error` with a user-facing message on failure.
 */
export async function shareSessionAsGist(options: ShareSessionAsGistOptions): Promise<string> {
	const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
	if (authResult.error) {
		throw new Error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
	}
	if (authResult.status !== 0) {
		throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
	}

	const result = await runGhGistCreate(options.htmlPath, options.signal);
	if (result.code !== 0) {
		throw new Error(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
	}

	const gistUrl = result.stdout?.trim();
	const gistId = gistUrl?.split("/").pop();
	if (!gistId) {
		throw new Error("Failed to parse gist ID from gh output");
	}

	return getShareViewerUrl(gistId);
}

interface GhResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

function runGhGistCreate(htmlPath: string, signal?: AbortSignal): Promise<GhResult> {
	return new Promise<GhResult>((resolve) => {
		const proc = spawn("gh", ["gist", "create", "--public=false", htmlPath]);
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => resolve({ stdout, stderr, code }));

		const onAbort = () => {
			proc.kill();
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
				proc.on("close", () => signal.removeEventListener("abort", onAbort));
			}
		}
	});
}
