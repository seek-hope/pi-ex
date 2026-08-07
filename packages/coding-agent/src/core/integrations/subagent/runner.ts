/**
 * SubagentRunner — drives one in-process sub-agent run via the Agent runtime.
 *
 * The sub-agent gets: harness base tools scoped to its git worktree
 * (bash/read/edit/write for improve/execute modes; bash/read only for the
 * read-only analyze mode), the shared ModelRuntime (no re-auth), and — when
 * depth allows — a scoped subagent toolset for recursive delegation.
 */
import {
	Agent,
	type AgentHarnessTool,
	type AgentTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { contentText, type Usage } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "../../model-runtime.ts";
import type { SubAgentUsage, SubagentMode } from "./types.ts";

export interface SubagentRunOptions {
	id: string;
	task: string;
	/** Toolset mode: 'analyze' is read-only; 'improve'/'execute' get the full set. */
	mode?: SubagentMode;
	/** Worktree path — the sub-agent's filesystem root. */
	cwd: string;
	branch: string;
	projectRoot: string;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	depth: number;
	maxDepth: number;
	/** Recursive toolset factory; not consulted when depth+1 >= maxDepth. */
	childTools?: (depth: number) => AgentHarnessTool<ExecutionToolContext>[];
	onProgress?: (text: string) => void;
	signal?: AbortSignal;
}

export interface SubagentRunResult {
	result: string;
	usage: SubAgentUsage;
	stopReason: string;
	errorMessage?: string;
}

const MODE_LINES: Record<SubagentMode, string> = {
	analyze:
		"MODE: analyze — you have read-only tools. Do not attempt to modify files; produce a written report instead.",
	improve:
		"MODE: improve — you have full tools (read, edit, write, bash). Improve the existing code per the task; keep changes focused and minimal.",
	execute:
		"MODE: execute — you have full tools (read, edit, write, bash). Implement the task end-to-end inside the worktree.",
};

function buildSubagentPrompt(options: SubagentRunOptions): string {
	const mode: SubagentMode = options.mode ?? "execute";
	const lines = [
		"You are a sub-agent executing a delegated task inside an isolated git worktree.",
		"",
		`Worktree: ${options.cwd} (branch ${options.branch})`,
		`The worktree is a full copy of the project at ${options.projectRoot}.`,
		"",
		MODE_LINES[mode],
		"",
		"Rules:",
		"- Work only inside the worktree. Never touch files outside it.",
		"- Do not ask questions — make reasonable decisions and complete the task fully.",
		"- Do not run git commit/push; your changes are committed and reviewed automatically after you finish.",
		"- Be concise in tool output usage: prefer targeted reads over dumping whole files.",
	];
	if (options.depth + 1 < options.maxDepth) {
		lines.push(
			`- You may delegate independent subtasks via subagent_spawn (depth ${options.depth + 1} of ${options.maxDepth}).`,
		);
	}
	lines.push(
		"",
		"Final message format: a concise report — what you changed, key decisions, blockers, and anything the parent agent must know.",
	);
	return lines.join("\n");
}

export async function runSubagent(options: SubagentRunOptions): Promise<SubagentRunResult> {
	const env = new NodeExecutionEnv({ cwd: options.cwd });

	const mode: SubagentMode = options.mode ?? "execute";
	// analyze = read-only intent: no edit/write tools, and the prompt forbids
	// mutations. NOTE: these are pi-agent-core base tools without the
	// coding-agent bash gate, so analyze-mode bash can technically still
	// mutate — the restriction is contractual (prompt + toolset), not enforced.
	const baseTools: AgentHarnessTool<ExecutionToolContext>[] =
		mode === "analyze"
			? [createBashTool(), createReadTool()]
			: [createBashTool(), createReadTool(), createEditTool(), createWriteTool()];
	if (options.childTools && options.depth + 1 < options.maxDepth) {
		baseTools.push(...options.childTools(options.depth + 1));
	}
	// The Agent runtime has no per-execution context slot; close over the
	// worktree env instead.
	const tools: AgentTool[] = baseTools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		async execute(toolCallId, params, signal, onUpdate) {
			const result = await tool.execute(toolCallId, params, signal, onUpdate, { env });
			return { content: result.content, details: result.details };
		},
	}));

	const agent = new Agent({
		initialState: {
			model: options.model,
			systemPrompt: buildSubagentPrompt(options),
			thinkingLevel: options.thinkingLevel ?? "off",
			tools,
		},
		streamFn: (model, context, streamOptions) =>
			options.modelRuntime.streamSimple(
				model,
				context,
				streamOptions as Parameters<typeof options.modelRuntime.streamSimple>[2],
			),
	});

	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start" && options.onProgress) {
			const args = event.args as Record<string, unknown> | undefined;
			const target =
				(typeof args?.path === "string" && args.path) ||
				(typeof args?.command === "string" && args.command.substring(0, 60)) ||
				"";
			options.onProgress(`${event.toolName}${target ? ` ${target}` : ""}`);
		}
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
			const u = event.message.usage;
			usage.input += u.input;
			usage.output += u.output;
			usage.cacheRead += u.cacheRead;
			usage.cacheWrite += u.cacheWrite;
			usage.totalTokens += u.totalTokens;
			usage.cost.input += u.cost.input;
			usage.cost.output += u.cost.output;
			usage.cost.cacheRead += u.cost.cacheRead;
			usage.cost.cacheWrite += u.cost.cacheWrite;
			usage.cost.total += u.cost.total;
		}
	});

	if (options.signal) {
		const signal = options.signal;
		if (signal.aborted) {
			agent.abort();
		} else {
			signal.addEventListener("abort", () => agent.abort(), { once: true });
		}
	}

	await agent.prompt(options.task);

	const final = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
	if (!final) {
		throw new Error("Sub-agent run completed without an assistant message");
	}
	return {
		result: contentText(final.content, "").trim(),
		usage: {
			input: usage.input,
			output: usage.output,
			cost: usage.cost.total,
		},
		stopReason: final.stopReason,
		errorMessage: final.stopReason === "error" ? final.errorMessage : undefined,
	};
}
