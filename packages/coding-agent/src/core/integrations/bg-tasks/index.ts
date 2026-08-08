/**
 * Background tasks — tmux-based background execution as a core integration.
 *
 * Tools: bg_spawn, bg_status. Widget shows running tasks.
 * Commands (/tasks, /fg, /kill, /attach) are built-in in interactive mode
 * and reach this integration via AgentSession.getIntegration("bg-tasks").
 */
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { TimeoutParamSchema, timeoutToMs } from "../../../utils/timeout.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { CoreIntegration, CoreIntegrationContext } from "../types.ts";
import { type BackgroundTask, type BackgroundTaskStore, getBackgroundTaskStore } from "./store.ts";

export const MAX_BG_SLEEP_SECONDS = 12 * 3600;

/**
 * Find sleep invocations exceeding {@link MAX_BG_SLEEP_SECONDS} in a task
 * command. Handles `sleep N`, `sleep Ns`, `sleep Nm`, `sleep Nh`, and
 * fractional values. Foreground bash gates convert sleeps automatically; in
 * background tasks a sleep is a legitimate way to pace checks, capped at
 * 12h (the same cap as the wait tool in interactive sessions).
 */
export function findOversizedSleep(command: string): { value: number; unit: string; seconds: number } | undefined {
	// A sleep may also sit right after shell keywords (do/then/else) on one
	// line: `while c; do sleep 40000; done`.
	const re = /(?:^|[;\n&|]|\bdo\s+|\bthen\s+|\belse\s+)\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
	let match = re.exec(command);
	while (match) {
		const value = Number.parseFloat(match[1]);
		const unit = match[2] || "s";
		const factor = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
		const seconds = value * factor;
		if (seconds > MAX_BG_SLEEP_SECONDS) {
			return { value, unit: unit || "s", seconds };
		}
		match = re.exec(command);
	}
	return undefined;
}

export class BackgroundTasksIntegration implements CoreIntegration {
	readonly id = "bg-tasks";
	readonly store: BackgroundTaskStore;

	private readonly ctx: CoreIntegrationContext;
	private readonly sessionId: string;
	private readonly unsubscribe: () => void;
	private pendingResults: Array<{ task: BackgroundTask; output: string }> = [];
	private batchTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: CoreIntegrationContext) {
		this.ctx = ctx;
		this.store = getBackgroundTaskStore();
		// Session isolation: completion notifications are routed by this id
		// (store is a process-wide singleton shared by all sessions).
		this.sessionId = ctx.sessionManager.getSessionId();
		this.unsubscribe = this.store.subscribe(
			{
				onChange: () => this.updateWidget(),
				onNotify: (message, level) => this.ctx.getUI()?.notify(message, level),
				onTaskFinished: (task, output) => this.deliverResult(task, output),
			},
			this.sessionId,
		);
	}

	getToolDefinitions(): ToolDefinition[] {
		return [
			this.createSpawnTool() as ToolDefinition,
			this.createStatusTool() as ToolDefinition,
			this.createOutputTool() as ToolDefinition,
			this.createKillTool() as ToolDefinition,
		];
	}

	getDefaultActiveToolNames(): string[] {
		return ["bg_spawn", "bg_status", "bg_output", "bg_kill"];
	}

	/** Deliver a finished task's result into the session as a follow-up message.
	 * Batches multiple completions within a 1-second window into one message. */
	private deliverResult(task: BackgroundTask, output: string): void {
		this.pendingResults.push({ task, output });
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.batchTimer = setTimeout(() => {
			this.batchTimer = null;
			const results = this.pendingResults.splice(0);
			if (results.length === 0) return;
			const parts: string[] = [];
			if (results.length > 1) {
				parts.push(`${results.length} background tasks completed:`);
			}
			for (const { task: t, output: o } of results) {
				const label = t.label ? ` — ${t.label}` : "";
				parts.push(`[${t.id} completed (${t.status})]${label}`);
				if (results.length === 1) {
					const truncated = o.length > 4000;
					parts.push(
						`Output:\n${o.substring(0, 4000)}${truncated ? `\n... (truncated — full output: ${t.logFile})` : ""}`,
					);
				}
			}
			if (results.length > 1) {
				parts.push("", `Use /fg <id> to view individual task output.`);
			}
			parts.push(
				"",
				`Check the outputs and keep going — continue with the next step of the work; only report back to the user once everything is done.`,
			);
			this.ctx.sendFollowUp?.(parts.join("\n"));
		}, 1000);
	}
	private updateWidget(): void {
		// The interactive UI owns the bg-tasks widget (focusable list component);
		// nothing to render here. Non-UI consumers get completion notifications
		// through deliverResult. Widget cleanup happens on shutdown.
	}

	/** /fg <id>: finalize and return the task's current output. */
	async taskOutput(id: string): Promise<{ task: BackgroundTask; output: string } | undefined> {
		const task = this.store.get(id);
		if (!task) return undefined;
		const output = await this.store.finalizeAndSettle(task);
		// Finished tasks are pruned immediately; the completion notification
		// carried the output, so the log may already be gone.
		if (!existsSync(task.logFile) && task.status !== "running") {
			return { task, output: "(output was delivered with the completion notification; the task has been pruned)" };
		}
		return { task, output };
	}

	async killTask(id: string): Promise<boolean> {
		return this.store.kill(id);
	}

	private createSpawnTool() {
		const schema = Type.Object({
			task: Type.String({ description: "Command or task to run in background" }),
			label: Type.Optional(
				Type.String({
					description:
						"Human-readable summary shown in task lists and notifications (e.g. 'npm run build'). The command text itself is never displayed.",
				}),
			),
			timeout: Type.Optional(TimeoutParamSchema),
		});
		const store = this.store;
		const cwd = this.ctx.cwd;
		const sessionId = this.sessionId;
		const definition: ToolDefinition<typeof schema> = {
			name: "bg_spawn",
			label: "Background Task",
			description:
				"Start a background task in a tmux session. Returns a task ID and log file path. " +
				"The task continues running even if the session ends. " +
				"Use bg_status to check progress, read the logFile to see output.",
			promptSnippet: "Start a task in background via tmux — survives session end.",
			promptGuidelines: [
				"Use bg_spawn for long-running local tasks (builds, servers, downloads, training).",
				"bg_spawn returns a logFile path — use the read tool to check output anytime.",
				"For remote long-running tasks, use ssh_exec with nohup on the server side.",
				"Tasks survive pi session shutdown. They keep running in tmux.",
				"Use /tasks (TUI) to manage tasks, /fg <id> to view output, /kill <id> to stop.",
			],
			parameters: schema,
			async execute(_toolCallId, params) {
				let timeoutMs: number | undefined;
				if (params.timeout != null) {
					try {
						timeoutMs = timeoutToMs(params.timeout);
					} catch (err) {
						return {
							content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
							details: {},
							isError: true,
						};
					}
				}
				const badSleep = findOversizedSleep(params.task);
				if (badSleep) {
					return {
						content: [
							{
								type: "text",
								text: `sleep ${badSleep.value}${badSleep.unit} (${Math.round(badSleep.seconds)}s) exceeds the 12-hour cap for background tasks. Split the wait into shorter sleeps or schedule it differently.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const task = await store.spawn(params.task, cwd, timeoutMs ?? 12 * 3600 * 1000, sessionId, params.label);
				return {
					content: [
						{
							type: "text",
							text: [
								"Background task started.",
								`ID: ${task.id}`,
								`Log: ${task.logFile}`,
								"",
								`Check: /fg ${task.id}  |  Kill: /kill ${task.id}  |  Manage: /tasks`,
							].join("\n"),
						},
					],
					details: { taskId: task.id, logFile: task.logFile },
				};
			},
		};
		return definition;
	}

	private createStatusTool() {
		const schema = Type.Object({});
		const store = this.store;
		const definition: ToolDefinition<typeof schema> = {
			name: "bg_status",
			label: "Background Status",
			description: "Check the status of all background tasks.",
			parameters: schema,
			async execute() {
				await store.sync();
				const tasks = store.list();
				if (tasks.length === 0) {
					return { content: [{ type: "text", text: "No background tasks." }], details: {} };
				}
				const lines = ["Background tasks:"];
				for (const t of tasks) {
					const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
					const icon = t.status === "done" ? "✓" : t.status === "running" ? "◐" : "✗";
					const label = t.label ? `: ${t.label}` : "";
					lines.push(`  ${icon} ${t.id}${label} (${elapsed.toFixed(0)}s)`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
			},
		};
		return definition;
	}

	/** Tail a task's log file for the model. */
	private createOutputTool() {
		const schema = Type.Object({
			task_id: Type.String({ description: "Task ID (from bg_spawn/bg_status)." }),
			tail_lines: Type.Optional(
				Type.Integer({
					description: "How many lines from the end of the log to return (default 50, max 500).",
					minimum: 1,
					maximum: 500,
				}),
			),
		});
		const store = this.store;
		const definition: ToolDefinition<typeof schema> = {
			name: "bg_output",
			label: "Background Task Output",
			description:
				"Read the output of a background task (tail of its log file). " +
				"Use after bg_status shows a task finished or when you want to check progress without reading the raw log path.",
			parameters: schema,
			async execute(_toolCallId, { task_id, tail_lines }) {
				const task = store.get(task_id);
				if (!task) {
					return {
						content: [{ type: "text", text: `Task ${task_id} not found.` }],
						details: {},
						isError: true,
					};
				}
				const output = await store.finalizeAndSettle(task);
				const lines = output.split("\n");
				const tail = tail_lines ?? 50;
				const shown = lines.slice(-tail);
				const status = `[${task.id} ${task.status}${task.exitCode != null ? ` exit=${task.exitCode}` : ""}]`;
				const truncated = lines.length > shown.length;
				const text = [
					status,
					...shown,
					truncated ? `... (${lines.length - shown.length} earlier lines omitted; tail_lines up to 500)` : "",
				].join("\n");
				return { content: [{ type: "text", text }], details: { taskId: task.id, status: task.status } };
			},
		};
		return definition;
	}

	/** Kill a background task for the model. */
	private createKillTool() {
		const schema = Type.Object({
			task_id: Type.String({ description: "Task ID to stop (from bg_spawn/bg_status)." }),
		});
		const store = this.store;
		const definition: ToolDefinition<typeof schema> = {
			name: "bg_kill",
			label: "Background Task Kill",
			description:
				"Stop a background task (kills its tmux session and marks it killed). " +
				"Use to stop runaway or no-longer-needed tasks.",
			parameters: schema,
			async execute(_toolCallId, { task_id }) {
				const task = store.get(task_id);
				if (!task) {
					return {
						content: [{ type: "text", text: `Task ${task_id} not found.` }],
						details: {},
						isError: true,
					};
				}
				const killed = await store.kill(task_id);
				return {
					content: [
						{
							type: "text",
							text: killed ? `Task ${task_id} killed.` : `Task ${task_id} could not be killed.`,
						},
					],
					details: { taskId: task_id, killed },
				};
			},
		};
		return definition;
	}

	onSessionStart(): void {
		void this.store.sync();
	}

	onShutdown(): void {
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.unsubscribe();
		this.ctx.getUI()?.setWidget("bg-tasks", undefined);
	}
}
