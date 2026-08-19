/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** True when stdout/stderr accumulation hit the cap and was cut off. */
	truncated?: boolean;
}

// Cap accumulated stdout/stderr so a runaway process cannot exhaust memory.
// Beyond this, output is cut off and the result is marked `truncated` (mirrors
// the bash tool's truncation handling).
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
// How long after SIGTERM before a hard SIGKILL is sent.
const SIGKILL_GRACE_MS = 5000;

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports optional timeout and abort signal. No default timeout is applied
 * so long-running callers are unaffected.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let truncated = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let forceKillId: NodeJS.Timeout | undefined;

		// Permanently failed stdout/stderr state; once set, subsequent writes are
		// ignored so we can keep the accumulated buffer capped.
		let stdoutFull = false;
		let stderrFull = false;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after a grace period if SIGTERM doesn't work. The timer
				// is cleared when the process actually closes so it does not leak.
				forceKillId = setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, SIGKILL_GRACE_MS);
			}
		};

		const appendOutput = (buffer: string, target: "stdout" | "stderr") => {
			const current = target === "stdout" ? stdout : stderr;
			const isFull = target === "stdout" ? stdoutFull : stderrFull;
			if (!isFull && Buffer.byteLength(current, "utf-8") + buffer.length > MAX_OUTPUT_BYTES) {
				truncated = true;
				if (target === "stdout") stdoutFull = true;
				else stderrFull = true;
				return;
			}
			if (isFull) return;
			if (target === "stdout") stdout += buffer;
			else stderr += buffer;
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			appendOutput(data.toString(), "stdout");
		});

		proc.stderr?.on("data", (data) => {
			appendOutput(data.toString(), "stderr");
		});

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			// Release the grace-period SIGKILL timer now that the process is gone
			// so it cannot leak past termination.
			if (forceKillId) clearTimeout(forceKillId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		// Clear the grace-period SIGKILL timer as soon as the process actually
		// closes, independent of the (slightly delayed) waitForChildProcess settle.
		proc.once("close", () => {
			if (forceKillId) clearTimeout(forceKillId);
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				cleanup();
				resolve({ stdout, stderr, code: code ?? 0, killed, truncated });
			})
			.catch((err) => {
				cleanup();
				// A spawn failure (e.g. ENOENT) reaches us through the error event —
				// name the command so the caller isn't left with an empty result.
				const message = err instanceof Error ? err.message : String(err);
				const note = `Failed to execute ${command}: ${message}`;
				resolve({ stdout, stderr: stderr ? `${stderr}\n${note}` : note, code: 1, killed, truncated });
			});
	});
}
