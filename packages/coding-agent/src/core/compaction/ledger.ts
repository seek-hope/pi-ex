/**
 * Action Ledger — deterministic extraction of world-state changes from the
 * message stream. No LLM involved: file modifications, command executions,
 * git commits, and sub-agent operations are recorded structurally so the
 * compaction checkpoint can present facts instead of narrative.
 *
 * The ledger is cumulative: each compaction merges the previous checkpoint's
 * ledger with actions extracted since.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface FileAction {
	type: "edit" | "write";
	path: string;
	status: "ok" | "error";
}

export interface CommandAction {
	type: "command";
	command: string;
	status: "ok" | "error";
	/** Process exit code when the error is a non-zero exit (see below). */
	exitCode?: number;
}

export interface CommitAction {
	type: "commit";
	message: string;
	status: "ok" | "error";
	/** Process exit code when the error is a non-zero exit (see below). */
	exitCode?: number;
}

export interface SubagentAction {
	type: "subagent";
	id: string;
	action: "spawn" | "merge" | "reject";
	status: "ok" | "error";
}

export interface ActionLedger {
	/** File modifications, deduped by path (latest action last). */
	files: FileAction[];
	/** Commands, most recent last, capped. */
	commands: CommandAction[];
	/** git commit invocations, most recent last, capped. */
	commits: CommitAction[];
	/** Sub-agent operations, most recent last, capped. */
	subagents: SubagentAction[];
}

const MAX_COMMANDS = 50;
const MAX_COMMITS = 20;
const MAX_SUBAGENTS = 30;

export function emptyLedger(): ActionLedger {
	return { files: [], commands: [], commits: [], subagents: [] };
}

interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

function toolCallsOf(message: AgentMessage): Array<{ id: string } & ToolCallInfo> {
	if (message.role !== "assistant") return [];
	const content = (
		message as { content?: Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown> }> }
	).content;
	if (!Array.isArray(content)) return [];
	const calls: Array<{ id: string } & ToolCallInfo> = [];
	for (const part of content) {
		if (part.type === "toolCall" && part.id && part.name) {
			calls.push({ id: part.id, name: part.name, arguments: part.arguments ?? {} });
		}
	}
	return calls;
}

function toolResultTextOf(message: AgentMessage): string {
	const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part.type === "text" && part.text) text += part.text;
	}
	return text;
}

/**
 * Extract the status of a tool result.
 *
 * The bash tool throws on ANY non-zero exit, so query commands whose non-zero
 * exit is a normal answer (grep with no match, diff finding differences,
 * `test`/`[` returning false) arrive as isError=true. Recording those as
 * "(failed)" in the World State ledger is a false failure. Instead, parse the
 * exit code from the tool error text (bash formats it as "Command exited with
 * code N"; structured details never carry a failing exitCode because the tool
 * throws before returning them) and annotate it as `exitCode`. "(failed)" is
 * reserved for tool-level errors: exceptions, aborts, timeouts.
 */
function resultStatusOf(
	message: AgentMessage,
): { toolCallId: string; status: "ok" | "error"; exitCode?: number } | undefined {
	if (message.role !== "toolResult") return undefined;
	const toolCallId = (message as { toolCallId?: string }).toolCallId;
	if (!toolCallId) return undefined;
	const isError = (message as { isError?: boolean }).isError === true;
	let exitCode: number | undefined;
	if (isError) {
		const match = toolResultTextOf(message).match(/Command exited with code (\d+)/);
		if (match) exitCode = Number(match[1]);
	}
	return { toolCallId, status: isError ? "error" : "ok", exitCode };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actionFor(
	call: ToolCallInfo,
	status: "ok" | "error",
): FileAction | CommandAction | SubagentAction | CommitAction | undefined {
	switch (call.name) {
		case "edit": {
			// read/edit/write accept `file_path` as an alias for `path`.
			const path = asString(call.arguments.path) ?? asString(call.arguments.file_path);
			return path ? { type: "edit", path, status } : undefined;
		}
		case "write": {
			const path = asString(call.arguments.path) ?? asString(call.arguments.file_path);
			return path ? { type: "write", path, status } : undefined;
		}
		case "bash": {
			const command = asString(call.arguments.command);
			if (!command) return undefined;
			const trimmed = command.trim();
			const commitMatch = trimmed.match(/^git\s+commit\b/);
			if (commitMatch) {
				const messageMatch = trimmed.match(/-m\s+["']([^"']+)["']/);
				return { type: "commit", message: messageMatch?.[1]?.substring(0, 120) ?? "(git commit)", status };
			}
			return { type: "command", command: trimmed, status };
		}
		case "subagent_spawn": {
			const id = asString(call.arguments.task);
			return { type: "subagent", id: id ? id.substring(0, 60) : "(spawn)", action: "spawn", status };
		}
		case "subagent_merge": {
			const id = asString(call.arguments.id) ?? "?";
			return { type: "subagent", id, action: "merge", status };
		}
		case "subagent_reject": {
			const id = asString(call.arguments.id) ?? "?";
			return { type: "subagent", id, action: "reject", status };
		}
		default:
			return undefined;
	}
}

/** Extract ledger actions from messages and merge into a cumulative ledger. */
export function extractLedgerActions(messages: AgentMessage[], previous?: ActionLedger): ActionLedger {
	const ledger: ActionLedger = {
		files: [...(previous?.files ?? [])],
		commands: [...(previous?.commands ?? [])],
		commits: [...(previous?.commits ?? [])],
		subagents: [...(previous?.subagents ?? [])],
	};

	const pending = new Map<string, FileAction | CommandAction | SubagentAction | CommitAction>();
	const push = (action: FileAction | CommandAction | SubagentAction | CommitAction): void => {
		switch (action.type) {
			case "edit":
			case "write": {
				// Dedup by path: latest action wins, moved to the end.
				const idx = ledger.files.findIndex((f) => f.path === (action as FileAction).path);
				if (idx >= 0) ledger.files.splice(idx, 1);
				ledger.files.push(action);
				break;
			}
			case "command":
				ledger.commands.push(action);
				break;
			case "commit":
				ledger.commits.push(action);
				break;
			case "subagent":
				ledger.subagents.push(action);
				break;
		}
	};

	for (const message of messages) {
		for (const call of toolCallsOf(message)) {
			const action = actionFor(call, "ok");
			if (action) pending.set(call.id, action);
		}
		const result = resultStatusOf(message);
		if (result) {
			const action = pending.get(result.toolCallId);
			if (action) {
				pending.delete(result.toolCallId);
				action.status = result.status;
				if (result.exitCode !== undefined && (action.type === "command" || action.type === "commit")) {
					action.exitCode = result.exitCode;
				}
				push(action);
			}
		}
	}
	// In-flight calls without results (should not happen mid-session, but be safe)
	for (const action of pending.values()) {
		push(action);
	}

	// Caps
	if (ledger.commands.length > MAX_COMMANDS) ledger.commands = ledger.commands.slice(-MAX_COMMANDS);
	if (ledger.commits.length > MAX_COMMITS) ledger.commits = ledger.commits.slice(-MAX_COMMITS);
	if (ledger.subagents.length > MAX_SUBAGENTS) ledger.subagents = ledger.subagents.slice(-MAX_SUBAGENTS);

	return ledger;
}

/** Render an action status: non-zero exits as `(exit N)`, tool errors as `(failed)`. */
function statusSuffix(status: "ok" | "error", exitCode?: number): string {
	if (status !== "error") return "";
	return exitCode !== undefined ? ` (exit ${exitCode})` : " (failed)";
}

/** Render the ledger as the World State section of a checkpoint (markdown). */
export function formatLedger(ledger: ActionLedger): string {
	const lines: string[] = [];
	if (ledger.files.length > 0) {
		lines.push("### Files Modified");
		for (const f of ledger.files) {
			lines.push(`- ${f.path} (${f.type}${f.status === "error" ? ", failed" : ""})`);
		}
	}
	if (ledger.commits.length > 0) {
		lines.push("### Commits");
		for (const c of ledger.commits) {
			lines.push(`- ${c.message}${statusSuffix(c.status, c.exitCode)}`);
		}
	}
	if (ledger.subagents.length > 0) {
		lines.push("### Sub-agent Operations");
		for (const s of ledger.subagents) {
			lines.push(`- ${s.action} ${s.id}${statusSuffix(s.status)}`);
		}
	}
	if (ledger.commands.length > 0) {
		lines.push("### Commands");
		for (const c of ledger.commands) {
			lines.push(`- \`${c.command}\`${statusSuffix(c.status, c.exitCode)}`);
		}
	}
	return lines.join("\n");
}
