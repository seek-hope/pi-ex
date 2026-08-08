/**
 * Session-facing subagent tools (parent agent calls these).
 */
import { Type } from "typebox";
import { TimeoutParamSchema, timeoutToMs } from "../../../utils/timeout.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { SubagentManager } from "./manager.ts";
import type { SubAgent } from "./types.ts";

function formatAgent(a: SubAgent): string {
	const duration = ((a.endTime ?? Date.now()) - a.startTime) / 1000;
	const parts = [`${a.id}: ${a.status} (${duration.toFixed(0)}s)`];
	if (a.commitHash) parts.push(`commit ${a.commitHash}`);
	if (a.error) parts.push(`error: ${a.error.substring(0, 120)}`);
	return parts.join(" — ");
}

export function createSubagentToolDefinitions(manager: SubagentManager): ToolDefinition[] {
	const spawnSchema = Type.Object({
		task: Type.String({
			description: "Task description for the sub-agent (self-contained: context, paths, constraints)",
		}),
		mode: Type.Optional(
			Type.Enum(["analyze", "improve", "execute"] as const, {
				default: "execute",
				description:
					"'analyze': read-only tools (read+bash; bash is still gated, so no mutations) — produces a written report, cannot modify files. " +
					"'improve': full tools (read+edit+write+bash) to improve existing code. " +
					"'execute': full tools (read+edit+write+bash) to implement new tasks (default).",
			}),
		),
		model: Type.Optional(
			Type.String({ description: "Model override as provider/id (default: inherit parent model)" }),
		),
		timeout: Type.Optional(TimeoutParamSchema),
	});
	const spawnTool: ToolDefinition<typeof spawnSchema> = {
		name: "subagent_spawn",
		label: "Spawn Sub-agent",
		description:
			"Spawn an isolated sub-agent in its own git worktree. " +
			"Modes: 'analyze' (read-only: read+bash, produces a written report, cannot modify files), " +
			"'improve' (full tools, improve existing code), 'execute' (full tools, implement new tasks; default). " +
			"Runs in-process with its own context window; you get a completion notification. " +
			"Use subagent_wait to collect the result, subagent_review to inspect the diff, subagent_merge or subagent_reject to decide.",
		promptSnippet: "Spawn isolated sub-agent in git worktree (analyze/improve/execute modes)",
		promptGuidelines: [
			"Use subagent_parallel when the user asks for 3+ independent changes or searches.",
			"Prefer subagent_parallel over sequential execution for independent tasks — it saves wall-clock time.",
			"Use subagent_spawn(mode=analyze) for read-only investigation or codebase Q&A — it cannot modify files and returns a written report.",
			"Use subagent_spawn(mode=improve) to improve or refactor existing code; use mode=execute (default) to implement new tasks.",
			"For tasks that depend on each other, use subagent_spawn(mode=execute) instead.",
			"Always review sub-agent output before merging — never merge blindly.",
		],
		parameters: spawnSchema,
		async execute(_id, params) {
			const agent = await manager.spawn({
				task: params.task,
				mode: params.mode,
				model: params.model,
				timeoutMs: params.timeout ? timeoutToMs(params.timeout) : undefined,
				depth: 0,
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`Sub-agent ${agent.id} started in an isolated worktree.`,
							`Worktree: ${agent.worktreePath}`,
							`Branch: ${agent.branch}`,
							"",
							`Use subagent_wait("${agent.id}") to collect the result, subagent_review("${agent.id}") to inspect the diff.`,
						].join("\n"),
					},
				],
				details: { id: agent.id, worktree: agent.worktreePath, branch: agent.branch },
			};
		},
	};

	const idSchema = Type.Object({ id: Type.String({ description: "Sub-agent id" }) });

	const waitTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_wait",
		label: "Wait for Sub-agent",
		description: "Wait for a sub-agent to complete. Returns the result and indicates whether changes were committed.",
		parameters: idSchema,
		async execute(_id, params) {
			const agent = await manager.wait(params.id);
			const text = [
				`Sub-agent ${agent.id} finished with status: ${agent.status}`,
				agent.commitHash ? `Commit: ${agent.commitHash} on ${agent.branch}` : undefined,
				agent.result ? `\nReport:\n${agent.result}` : undefined,
				agent.error ? `\nError: ${agent.error}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text }], details: { status: agent.status, commitHash: agent.commitHash } };
		},
	};

	const reviewTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_review",
		label: "Review Sub-agent",
		description:
			"Inspect the git diff and commit log of a completed sub-agent. Use this to decide whether to merge or reject the sub-agent's work.",
		parameters: idSchema,
		async execute(_id, params) {
			const diff = manager.review(params.id);
			return { content: [{ type: "text", text: diff }], details: {} };
		},
	};

	const mergeTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_merge",
		label: "Merge Sub-agent",
		description:
			"Merge a sub-agent's branch into the main branch. If there are merge conflicts, they are reported so the main agent can resolve them.",
		parameters: idSchema,
		async execute(_id, params) {
			const { message } = manager.merge(params.id);
			return { content: [{ type: "text", text: message }], details: {} };
		},
	};

	const rejectTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_reject",
		label: "Reject Sub-agent",
		description: "Reject a sub-agent's work: delete its branch and worktree.",
		parameters: idSchema,
		async execute(_id, params) {
			const { message } = manager.reject(params.id);
			return { content: [{ type: "text", text: message }], details: {} };
		},
	};

	const parallelSchema = Type.Object({
		tasks: Type.Array(Type.String(), { description: "JSON array of task strings" }),
		maxConcurrency: Type.Optional(Type.Number({ description: "Max concurrent (default: 5)" })),
	});
	const parallelTool: ToolDefinition<typeof parallelSchema> = {
		name: "subagent_parallel",
		label: "Parallel Sub-agents",
		description:
			"Spawn multiple sub-agents in parallel git worktrees. All work independently and commit to their own branches. Returns all results. Review each with subagent_review before merging.",
		parameters: parallelSchema,
		async execute(_id, params) {
			const limit = Math.max(1, params.maxConcurrency ?? 5);
			const queue = [...params.tasks];
			const spawned: SubAgent[] = [];
			const errors: string[] = [];
			async function worker(): Promise<void> {
				for (;;) {
					const task = queue.shift();
					if (task === undefined) return;
					let concurrencyWaits = 0;
					try {
						const agent = await manager.spawn({ task, depth: 0, silent: true });
						spawned.push(agent);
					} catch (e: any) {
						// Concurrency limit: another session may hold slots — wait for
						// one to free up and retry instead of dropping the task.
						// Bounded: give up after ~5 minutes of a full pool.
						if (/Concurrency limit reached/.test(e?.message ?? "") && concurrencyWaits++ < 150) {
							queue.unshift(task);
							await new Promise((resolve) => setTimeout(resolve, 2_000));
							continue;
						}
						errors.push(`${task.substring(0, 60)}: ${e?.message || e}`);
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
			const lines: string[] = [`Spawned ${spawned.length} sub-agents:`];
			for (const a of spawned) lines.push(`  ${a.id} — ${a.task.substring(0, 60)}`);
			if (errors.length > 0) {
				lines.push("", "Failed to spawn:");
				for (const e of errors) lines.push(`  ${e}`);
			}
			lines.push("", "Use subagent_wait on each id to collect results.");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { ids: spawned.map((a) => a.id), errors },
			};
		},
	};

	const listSchema = Type.Object({});
	const listTool: ToolDefinition<typeof listSchema> = {
		name: "subagent_list",
		label: "List Sub-agents",
		description: "List all running sub-agents and their worktrees.",
		parameters: listSchema,
		async execute() {
			const agents = manager.list();
			if (agents.length === 0) {
				return { content: [{ type: "text", text: "No sub-agents." }], details: {} };
			}
			return {
				content: [{ type: "text", text: `Sub-agents:\n${agents.map(formatAgent).join("\n")}` }],
				details: {},
			};
		},
	};

	const cancelTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_cancel",
		label: "Cancel Sub-agent",
		description: "Cancel a running sub-agent and clean up its worktree.",
		parameters: idSchema,
		async execute(_id, params) {
			const agent = await manager.cancel(params.id);
			return { content: [{ type: "text", text: `Sub-agent ${agent.id}: ${agent.status}.` }], details: {} };
		},
	};

	const continueTool: ToolDefinition<typeof idSchema> = {
		name: "subagent_continue",
		label: "Continue Sub-agent",
		description:
			"Resume an interrupted sub-agent (crash survivor) in its existing worktree and branch. " +
			"The original task is re-issued with a note to inspect the partial work first. " +
			"Use after pi was restarted and subagent_list shows an 'interrupted' entry.",
		parameters: idSchema,
		async execute(_id, params) {
			const agent = await manager.continueAgent(params.id);
			return {
				content: [
					{
						type: "text",
						text: `Resumed ${agent.id} in ${agent.worktreePath}. Use subagent_wait("${agent.id}") to collect the result, then subagent_review / subagent_merge / subagent_reject.`,
					},
				],
				details: { id: agent.id, worktree: agent.worktreePath, branch: agent.branch },
			};
		},
	};

	const ensureGitTool: ToolDefinition<typeof listSchema> = {
		name: "subagent_ensure_git",
		label: "Ensure Git Repo",
		description:
			"Initialize a git repository in the project if one doesn't exist. Called automatically; rarely needed manually.",
		parameters: listSchema,
		async execute() {
			return { content: [{ type: "text", text: manager.ensureGit() }], details: {} };
		},
	};

	return [
		spawnTool as ToolDefinition,
		waitTool as ToolDefinition,
		reviewTool as ToolDefinition,
		mergeTool as ToolDefinition,
		rejectTool as ToolDefinition,
		parallelTool as ToolDefinition,
		listTool as ToolDefinition,
		cancelTool as ToolDefinition,
		continueTool as ToolDefinition,
		ensureGitTool as ToolDefinition,
	];
}
