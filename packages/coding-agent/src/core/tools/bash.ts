import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access as fsAccess, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Container, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { formatTimeout, type TimeoutInput, TimeoutParamSchema, timeoutToMs } from "../../utils/timeout.ts";
import { checkBashGate, classifyBashGateCommand, formatGateResponse } from "../bash-gate.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { findOversizedSleep } from "../integrations/bg-tasks/index.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";
import type { WaitScheduleResult } from "./wait.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(TimeoutParamSchema),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Background-task conversion (gate auto-conversion of sleep commands). */
	convertedToBackgroundTask?: { taskId: string; logFile: string };
	/** Wait conversion (gate auto-conversion of pure sleeps). */
	convertedToWait?: { seconds: number };
}

export interface BashExecResult {
	/** Process exit code (null if killed). */
	exitCode: number | null;
	/**
	 * Per-stage pipeline exit codes when the shell reports them (bash local
	 * backend). Enables pipefail semantics: a masked mid-pipeline failure
	 * (`false | true`) must not pass silently.
	 */
	pipestatus?: number[];
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: TimeoutInput;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<BashExecResult>;
}

/**
 * Marker printed after the user command (bash only) carrying the per-stage
 * PIPESTATUS values. Enables pipefail semantics: without it, a pipeline's
 * exit code is just the last stage's, so a failing producer (`cat missing |
 * grep x`, `npm test | tail -5`) is silently masked by a successful consumer.
 */
export const PIPESTATUS_MARKER = "__PI_PIPESTATUS__";

/**
 * Suffix appended to commands run under bash. Captures PIPESTATUS before any
 * other command clobbers it, prints it as a marker line, and exits with the
 * original last-stage code so process-level exit detection keeps working.
 * Appended with newlines (not `;`) so trailing comments or `&` in the user
 * command cannot break it.
 */
const PIPESTATUS_SUFFIX =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: bash syntax, evaluated by the shell
	'\n__pi_pipe=("${PIPESTATUS[@]}")\n' +
	`printf '\\n${PIPESTATUS_MARKER}%s\\n' "\${__pi_pipe[*]}"\n` +
	// biome-ignore lint/suspicious/noTemplateCurlyInString: bash syntax, evaluated by the shell
	"exit ${__pi_pipe[$((${#__pi_pipe[@]}-1))]}\n";

/** Result of classifying per-stage pipeline exit codes. */
export interface PipelineStageFailure {
	/** Zero-based index of the first genuinely failing stage. */
	stageIndex: number;
	code: number;
	stageCount: number;
}

/**
 * Decide whether a pipeline failed from its per-stage exit codes.
 * A stage killed by SIGPIPE (141) is tolerated when it is not the last
 * stage — it means a downstream consumer exited early (`yes | head -1`),
 * which is an intended idiom, not a failure.
 */
export function classifyPipestatus(stages: number[]): PipelineStageFailure | null {
	for (let i = 0; i < stages.length; i++) {
		const code = stages[i];
		if (code === 0) continue;
		if (code === 128 + 13 && i < stages.length - 1) continue; // SIGPIPE, early consumer
		return { stageIndex: i, code, stageCount: stages.length };
	}
	return null;
}

/** Strip the trailing PIPESTATUS marker line from captured output. */
export function extractPipestatus(output: string): { content: string; stages: number[] | undefined } {
	const match = output.match(new RegExp(`\\n?${PIPESTATUS_MARKER}([0-9 ]+)\\n?`));
	if (!match || match.index === undefined) return { content: output, stages: undefined };
	const stages = match[1].trim().split(/\s+/).filter(Boolean).map(Number);
	const content = output.slice(0, match.index) + output.slice(match.index + match[0].length);
	return { content, stages };
}

/**
 * Quote-aware split of a command on pipe operators only (`|`, not `||`).
 * Used to label failing pipeline stages with their command text.
 */
export function splitPipeStages(command: string): string[] {
	const stages: string[] = [];
	let current = "";
	let quote: string | null = null;
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (quote) {
			current += c;
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current += c;
			i++;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			current += c + command[i + 1];
			i += 2;
			continue;
		}
		if (c === "|" && command[i + 1] !== "|" && command[i - 1] !== "|") {
			stages.push(current.trim());
			current = "";
			i++;
			continue;
		}
		current += c;
		i++;
	}
	stages.push(current.trim());
	return stages;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = timeout ? timeoutToMs(timeout) : undefined;
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			// Pipefail instrumentation is bash-specific (PIPESTATUS); other
			// shells fall back to last-stage exit code only.
			const isBash = shellConfig.shell.split(/[\\/]/).pop()?.includes("bash") ?? false;
			const fullCommand = isBash ? command + PIPESTATUS_SUFFIX : command;

			// The marker line is emitted last; hold back a small tail window so
			// it never reaches onData consumers even if split across chunks.
			const HOLD_BACK = isBash ? 4096 : 0;
			let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
			const wrappedOnData = (data: Buffer) => {
				if (HOLD_BACK === 0) {
					onData(data);
					return;
				}
				tail = tail.length > 0 ? Buffer.concat([tail, data]) : data;
				if (tail.length > HOLD_BACK) {
					onData(tail.subarray(0, tail.length - HOLD_BACK));
					tail = tail.subarray(tail.length - HOLD_BACK);
				}
			};

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(
				shellConfig.shell,
				commandFromStdin ? shellConfig.args : [...shellConfig.args, fullCommand],
				{
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(fullCommand);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", wrappedOnData);
				child.stderr?.on("data", wrappedOnData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const flushTail = (): void => {
					if (HOLD_BACK === 0 || tail.length === 0) return;
					const extracted = extractPipestatus(tail.toString("utf-8"));
					if (extracted.content) onData(Buffer.from(extracted.content, "utf-8"));
					tail = Buffer.alloc(0);
				};
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					// Don't drop the newest diagnostics (the last ~4KB) on abort.
					flushTail();
					throw new Error("aborted");
				}
				if (timedOut && timeoutMs !== undefined) {
					flushTail();
					throw new Error(`timeout:${timeoutMs / 1000}`);
				}
				// Flush the held-back tail minus the instrumentation marker.
				let pipestatus: number[] | undefined;
				if (HOLD_BACK > 0 && tail.length > 0) {
					const extracted = extractPipestatus(tail.toString("utf-8"));
					pipestatus = extracted.stages;
					if (extracted.content) onData(Buffer.from(extracted.content, "utf-8"));
				} else if (tail.length > 0) {
					onData(tail);
				}
				return pipestatus !== undefined ? { exitCode, pipestatus } : { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

/**
 * Session-level sudo password handling for the local bash tool.
 *
 * The password is kept in memory only (never persisted), never shown, and
 * never enters the model context — the model only sees stdout/stderr of the
 * commands it runs. If no handler is provided (e.g. sub-agent toolsets),
 * password-requiring sudo fails with a clear message.
 */
export interface LocalSudoHandler {
	/** Cached session password, if any. */
	getPassword(): string | undefined;
	/** Cache the password for the session (memory only). */
	setPassword(password: string): void;
	/** Ask the user for the password (masked). undefined = unavailable/cancelled. */
	promptPassword(): Promise<string | undefined>;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Sudo password handling; without it password-requiring sudo fails cleanly. */
	sudo?: LocalSudoHandler;
	/**
	 * Scheduler for the wait tool, used when the gate auto-converts a pure
	 * `sleep` command into a wait. When `clamp` is set, durations above the
	 * session cap are truncated to the cap instead of rejected.
	 */
	waitSchedule?: (seconds: number, opts?: { clamp?: boolean }) => WaitScheduleResult;
	/**
	 * Start a background task (gate auto-conversion of sleep-containing
	 * commands and polling loops). Returns the spawned task's id and log
	 * path, or throws when background tasks are unavailable.
	 */
	spawnBg?: (task: string, label?: string) => Promise<{ id: string; logFile: string }>;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

// ── local sudo support ───────────────────────────────────────────────────────
// Model-run `sudo` needs a password for most users. The bash tool's child has
// no terminal, so we probe with `sudo -n`, and when a password is required we
// ask the USER (masked, memory-only) and feed it to sudo via SUDO_ASKPASS +
// `sudo -A`. The password never enters the model context.

const SEGMENT_SEPARATORS = "|;&\n";
const SUDO_BOUNDARY_CHARS = " \t\n\r\f\v|;&";
const WORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

/**
 * Linearly scan a command for segment-leading `sudo` tokens, returning their
 * indices. Quote/escape aware: `sudo` inside quotes or mid-segment is not a
 * sudo invocation. Iterative (no regex) so hostile input cannot trigger
 * catastrophic backtracking.
 */
function findSudoTokens(command: string): number[] {
	const tokens: number[] = [];
	let i = 0;
	const n = command.length;
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let segmentStart = true;
	while (i < n) {
		const c = command[i];
		if (escaped) {
			escaped = false;
			i++;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			i++;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			i++;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			i++;
			continue;
		}
		if (!inSingle && !inDouble) {
			if (SEGMENT_SEPARATORS.includes(c)) {
				segmentStart = true;
				i++;
				continue;
			}
			if (segmentStart && c === "s" && command.startsWith("sudo", i)) {
				const after = command[i + 4];
				if (after === undefined || SUDO_BOUNDARY_CHARS.includes(after)) {
					tokens.push(i);
					segmentStart = false;
					i += 4;
					continue;
				}
			}
			if (segmentStart && c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
				segmentStart = false;
			}
		}
		i++;
	}
	return tokens;
}

/** True when the command contains a sudo invocation in any command segment. */
export function hasSudoToken(command: string): boolean {
	return findSudoTokens(command).length > 0;
}

/** True when the user explicitly requested no password (`sudo -n`). */
function usesExplicitNoPasswordSudo(command: string): boolean {
	return findSudoTokens(command).some((idx) => {
		const rest = command.slice(idx + 4);
		let j = 0;
		while (j < rest.length && (rest[j] === " " || rest[j] === "\t")) j++;
		return rest.startsWith("-n", j) && (rest[j + 2] === undefined || !WORD_CHARS.includes(rest[j + 2]));
	});
}

/** Replace each segment-leading `sudo` token with `sudo -A` (askpass mode). */
export function injectSudoAskpass(command: string): string {
	const tokens = findSudoTokens(command);
	if (tokens.length === 0) return command;
	let result = "";
	let prev = 0;
	for (const idx of tokens) {
		result += `${command.slice(prev, idx)}sudo -A`;
		prev = idx + 4;
	}
	result += command.slice(prev);
	return result;
}

/**
 * Prepare a command for password-requiring sudo: probe cached credentials,
 * obtain a password via the handler, and set up SUDO_ASKPASS. Returns null
 * when no password is needed; otherwise the rewritten command, the env
 * addition, and a cleanup callback for the temp files.
 */
async function prepareSudoCommand(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	ops: BashOperations,
	sudo?: LocalSudoHandler,
): Promise<{ command: string; env: NodeJS.ProcessEnv; cleanup(): Promise<void> } | null> {
	if (!hasSudoToken(command) || usesExplicitNoPasswordSudo(command)) return null;

	// Credentials may already be cached by an earlier terminal sudo; then no
	// password is needed and nothing is injected.
	try {
		const probe = await ops.exec("sudo -n true", cwd, { onData: () => {}, env });
		if (probe.exitCode === 0) return null;
	} catch {
		/* probe failed — treat as needing a password */
	}

	// Obtain a password and verify it BEFORE caching: a wrong password must
	// not poison the session (every later sudo would silently reuse it). Up
	// to 3 attempts; each failure discards the password and re-prompts.
	let passFile: string | undefined;
	let askpassFile: string | undefined;
	let password: string | undefined;
	let verified = false;
	try {
		for (let attempt = 0; attempt < 3 && !verified; attempt++) {
			password =
				attempt === 0 ? (sudo?.getPassword() ?? (await sudo?.promptPassword())) : await sudo?.promptPassword();
			if (!password) {
				throw new Error(
					"sudo requires a password, and none is available. Options: run the command in your own terminal, " +
						"configure NOPASSWD in sudoers, or (in interactive mode) the model prompts you for the password " +
						"(masked, memory-only, never in the model context).",
				);
			}
			passFile = joinPath(tmpdir(), `.pi-sudo-pass-${randomUUID()}`);
			askpassFile = joinPath(tmpdir(), `.pi-sudo-askpass-${randomUUID()}`);
			await fsWriteFile(passFile, password, { mode: 0o600 });
			await fsWriteFile(askpassFile, `#!/bin/sh\ncat "${passFile}"\n`, { mode: 0o700 });
			const probe = await ops.exec("sudo -A true", cwd, {
				onData: () => {},
				env: { ...env, SUDO_ASKPASS: askpassFile },
			});
			if (probe.exitCode === 0) {
				verified = true;
				break;
			}
			// Wrong or expired password — discard and re-prompt.
			await Promise.allSettled([fsRm(passFile, { force: true }), fsRm(askpassFile, { force: true })]);
			passFile = undefined;
			askpassFile = undefined;
		}
		if (!verified) {
			throw new Error(
				"sudo password verification failed after 3 attempts — the password may be wrong. " +
					"Try again in your own terminal or configure NOPASSWD in sudoers.",
			);
		}
		if (password !== undefined) sudo?.setPassword(password);
	} catch (err) {
		if (passFile) await fsRm(passFile, { force: true }).catch(() => {});
		if (askpassFile) await fsRm(askpassFile, { force: true }).catch(() => {});
		throw err;
	}
	if (!passFile || !askpassFile) {
		throw new Error("sudo setup failed: askpass files missing");
	}
	const finalPassFile = passFile;
	const finalAskpassFile = askpassFile;

	return {
		command: injectSudoAskpass(command),
		env: { ...env, SUDO_ASKPASS: finalAskpassFile },
		cleanup: async () => {
			await Promise.allSettled([fsRm(finalPassFile, { force: true }), fsRm(finalAskpassFile, { force: true })]);
		},
	};
}

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: TimeoutInput } | undefined): string {
	const command = str(args?.command);
	const timeoutSuffix = args?.timeout ? theme.fg("muted", ` (timeout ${formatTimeout(args.timeout)})`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", ...wrapTextWithAnsi(hint, width), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: bashToolSystemPromptContribution.snippet,
		promptGuidelines: exposeSessionEnvironment ? [...bashToolSystemPromptContribution.guidelines] : undefined,
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: TimeoutInput },
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			// ── Bash Gate: block commands that duplicate pi tools ──────
			const gateMatch = checkBashGate(command);
			if (gateMatch) {
				const converted = await autoConvertGatedCommand(command, gateMatch.rule.name, options ?? {});
				if (converted) {
					return converted;
				}
				return {
					content: [{ type: "text", text: formatGateResponse(gateMatch) }],
					details: undefined,
				};
			}

			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook, exposeSessionEnvironment, ctx);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let pipestatus: number[] | undefined;
				// Local sudo support: probe for a password requirement and, when
				// needed, obtain it from the user (masked, memory-only) and inject
				// it via SUDO_ASKPASS so the model never sees the password.
				let sudoCleanup: (() => Promise<void>) | undefined;
				let execCommand = spawnContext.command;
				let execEnv = spawnContext.env;
				try {
					const prepared = await prepareSudoCommand(
						spawnContext.command,
						spawnContext.cwd,
						spawnContext.env,
						ops,
						options?.sudo,
					);
					if (prepared) {
						execCommand = prepared.command;
						execEnv = prepared.env;
						sudoCleanup = prepared.cleanup;
					}
				} catch (err) {
					throw err instanceof Error ? err : new Error(String(err));
				}
				try {
					const result = await ops.exec(execCommand, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: execEnv,
					});
					exitCode = result.exitCode;
					pipestatus = result.pipestatus;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				} finally {
					// The command has finished (or failed): the askpass temp files
					// are no longer needed and must not linger.
					await sudoCleanup?.();
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				// Evaluate per-stage pipeline exit codes when the backend reports
				// them: a masked mid-pipeline failure (`npm test | tail -5` with
				// failing tests) must fail the command, not pass silently.
				const stageFailure = pipestatus ? classifyPipestatus(pipestatus) : null;
				if (stageFailure) {
					const labels = splitPipeStages(command);
					const label =
						labels.length === stageFailure.stageCount ? `: \`${labels[stageFailure.stageIndex]}\`` : "";
					const status =
						stageFailure.stageCount > 1
							? `Pipeline stage ${stageFailure.stageIndex + 1}/${stageFailure.stageCount} failed with code ${stageFailure.code}${label}`
							: `Command exited with code ${stageFailure.code}`;
					throw new Error(appendStatus(outputText, status));
				}
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}

/**
 * Auto-convert gate-blocked sleep commands:
 *
 * - pure `sleep N` → the wait tool (clamped to the session cap, ends the turn)
 * - `sleep ... && cmd`, `while/until` polling loops, and `watch` → the whole
 *   command runs as one background task via bg_spawn
 *
 * Returns a tool result when the command was converted, or undefined when the
 * conversion is not possible (unparseable sleep, oversized background sleep,
 * wait scheduler unavailable) and the ordinary gate response should be shown.
 */
async function autoConvertGatedCommand(
	command: string,
	ruleName: string,
	options: BashToolOptions,
): Promise<AgentToolResult<BashToolDetails | undefined> | undefined> {
	const classification = classifyBashGateCommand(command, ruleName);
	if (classification.kind === "wait") {
		const result = options.waitSchedule?.(classification.seconds, { clamp: true });
		if (!result?.ok) {
			// Over the headless use cap or no scheduler: fall back to the gate
			// response instead of silently running the sleep in the foreground.
			return undefined;
		}
		return {
			content: [{ type: "text", text: result.message }],
			details: { convertedToWait: { seconds: classification.seconds } },
			terminate: true,
		};
	}
	if (classification.kind === "bg") {
		if (!options.spawnBg) {
			return undefined;
		}
		const badSleep = findOversizedSleep(command);
		if (badSleep) {
			return undefined;
		}
		try {
			const task = await options.spawnBg(command, command.substring(0, 60));
			return {
				content: [
					{
						type: "text",
						text: [
							`Converted to a background task: the command now runs in tmux and its output arrives with the completion notice.`,
							`ID: ${task.id}`,
							`Log: ${task.logFile}`,
							"",
							`Check: /fg ${task.id}  |  Kill: /kill ${task.id}  |  Manage: /tasks`,
						].join("\n"),
					},
				],
				details: { convertedToBackgroundTask: { taskId: task.id, logFile: task.logFile } },
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}
