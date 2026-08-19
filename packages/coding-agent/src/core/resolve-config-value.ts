/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

// Stdout cap for `!command` config values: a runaway command cannot flood
// memory past this, mirroring the bash tool's truncation approach.
const COMMAND_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
// Default timeout for `!command` config value execution.
const COMMAND_TIMEOUT_MS = 10000;

type CommandExecResult = { executed: boolean; value: string | undefined; reason?: string };

export function executeWithConfiguredShell(command: string): CommandExecResult {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined, reason: "shell not found" };
			}
			if ((error as { killed?: boolean }).killed) {
				return { executed: true, value: undefined, reason: `timed out after ${COMMAND_TIMEOUT_MS}ms` };
			}
			return { executed: true, value: undefined, reason: error.message };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined, reason: `exited with status ${result.status}` };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch (error) {
		return {
			executed: false,
			value: undefined,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function executeWithDefaultShell(command: string): CommandExecResult {
	try {
		// Use spawnSync (never execSync) so a malformed or huge command can't
		// run unbounded: shell:true keeps compat with existing configs that use
		// pipes/globs, with a 10s timeout and a capped stdout buffer.
		const result = spawnSync(command, {
			shell: true,
			encoding: "utf-8",
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if ((error as { killed?: boolean }).killed) {
				return { executed: true, value: undefined, reason: `timed out after ${COMMAND_TIMEOUT_MS}ms` };
			}
			return { executed: true, value: undefined, reason: error.message };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined, reason: `exited with status ${result.status}` };
		}

		const output = (result.stdout ?? "").trim();
		return { executed: true, value: output || undefined };
	} catch (error) {
		return {
			executed: false,
			value: undefined,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function executeCommandUncached(commandConfig: string): { value: string | undefined; reason?: string } {
	const command = commandConfig.slice(1);
	const resolveCommand = (): CommandExecResult => {
		if (process.platform === "win32") {
			const configured = executeWithConfiguredShell(command);
			if (configured.executed) return configured;
			const fallback = executeWithDefaultShell(command);
			return { executed: true, value: fallback.value, reason: fallback.reason };
		}
		return executeWithDefaultShell(command);
	};
	const result = resolveCommand();
	return { value: result.value, reason: result.reason };
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result.value);
	return result.value;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config).value;
	}
	return resolveTemplate(reference.parts, env);
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		const result = executeCommandUncached(reference.config);
		if (result.value !== undefined) {
			return result.value;
		}
		const detail = result.reason ? ` (${result.reason})` : "";
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}${detail}`);
	}

	const resolvedValue = resolveTemplate(reference.parts, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
