/**
 * SubagentManager — lifecycle of in-process sub-agents for one session.
 *
 * spawn → worktree + AgentHarness run → auto-commit → report.
 * review/merge/reject operate on the sub-agent's branch.
 * Recursive delegation: children spawn through the same manager with depth+1.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { TodoIntegration } from "../todo/index.ts";
import type { CoreIntegrationContext } from "../types.ts";
import { runSubagent } from "./runner.ts";
import type { SpawnSubagentOptions, SubAgent, SubagentMode } from "./types.ts";
import {
	branchName,
	cleanupWorktree,
	commitWorktree,
	createWorktree,
	ensureGitRepo,
	getDiff,
	hasBranchCommits,
	mergeBranch,
} from "./worktree.ts";

export interface SubagentManagerOptions {
	maxDepth: number;
	maxConcurrent: number;
	defaultTimeoutMs: number;
	gitName?: string;
	gitEmail?: string;
}

let spawnCounter = 0;

/**
 * Crash-resume metadata, written per sub-agent under
 * <projectRoot>/.pi/subagent/meta/<id>.json (outside the worktree, so it
 * never lands in the sub-agent's branch). On manager construction the file
 * is read back and the sub-agent re-registered as "interrupted" — the
 * worktree and branch survive a pi crash and can be reviewed, merged,
 * rejected, or continued.
 */
interface SubAgentMeta {
	id: string;
	task: string;
	mode?: SubagentMode;
	depth: number;
	branch: string;
	worktreePath: string;
	projectRoot: string;
	model: string;
	startTime: number;
	todoId?: string | null;
}

function metaDir(projectRoot: string): string {
	return join(projectRoot, ".pi", "subagent", "meta");
}

function metaPath(projectRoot: string, id: string): string {
	return join(metaDir(projectRoot), `${id}.json`);
}

export class SubagentManager {
	private readonly agents = new Map<string, SubAgent>();

	private readonly ctx: CoreIntegrationContext;
	private readonly options: SubagentManagerOptions;

	constructor(ctx: CoreIntegrationContext, options: SubagentManagerOptions) {
		this.ctx = ctx;
		this.options = options;
		// Re-register sub-agents whose meta.json survived a crash/shutdown, so
		// their worktree + branch can be reviewed, merged, rejected, or
		// continued in this session.
		try {
			this.restoreInterrupted();
		} catch {
			/* restore is best-effort */
		}
		// Best-effort: drop on-disk leftovers of agents in a terminal state.
		// Must run AFTER restoreInterrupted — before it, the agents map is
		// empty and sweep is a no-op.
		try {
			this.sweep();
		} catch {
			/* sweep is best-effort */
		}
	}

	/** Write the crash-resume metadata file for a sub-agent. */
	private writeMeta(agent: SubAgent): void {
		try {
			mkdirSync(metaDir(agent.projectRoot), { recursive: true });
			const meta: SubAgentMeta = {
				id: agent.id,
				task: agent.task,
				mode: agent.mode,
				depth: agent.depth,
				branch: agent.branch,
				worktreePath: agent.worktreePath,
				projectRoot: agent.projectRoot,
				model: agent.model ?? "",
				startTime: agent.startTime,
				todoId: (agent as SubAgent & { todoId?: string | null }).todoId,
			};
			writeFileSync(metaPath(agent.projectRoot, agent.id), JSON.stringify(meta, null, 2), { mode: 0o600 });
		} catch {
			/* metadata is best-effort — a failed write must not break spawn */
		}
	}

	private deleteMeta(agent: SubAgent): void {
		try {
			rmSync(metaPath(agent.projectRoot, agent.id), { force: true });
		} catch {
			/* best-effort */
		}
	}

	/** Re-register sub-agents found in the meta directory (crash survivors). */
	private restoreInterrupted(): void {
		const dir = metaDir(this.ctx.cwd);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return; // no meta dir yet
		}
		for (const file of files) {
			try {
				const meta = JSON.parse(readFileSync(join(dir, file), "utf-8")) as SubAgentMeta;
				if (!meta?.id || this.agents.has(meta.id)) continue;
				if (!existsSync(meta.worktreePath)) {
					// Worktree gone — nothing to salvage; drop the stale meta.
					rmSync(metaPath(meta.projectRoot, meta.id), { force: true });
					continue;
				}
				const agent: SubAgent = {
					id: meta.id,
					task: meta.task,
					status: "interrupted",
					depth: meta.depth,
					branch: meta.branch,
					worktreePath: meta.worktreePath,
					projectRoot: meta.projectRoot,
					startTime: meta.startTime,
					endTime: Date.now(),
					model: meta.model,
					error:
						"Interrupted by an external shutdown — the process ended before this sub-agent finished. " +
						"Review the worktree, merge/reject it, or continue it.",
				};
				this.agents.set(meta.id, agent);
			} catch {
				/* corrupt meta — ignore */
			}
		}
	}

	list(): SubAgent[] {
		return [...this.agents.values()];
	}

	get(id: string): SubAgent | undefined {
		return this.agents.get(id);
	}

	private runningCount(): number {
		let n = 0;
		for (const a of this.agents.values()) if (a.status === "running") n++;
		return n;
	}

	private todo(): TodoIntegration | undefined {
		return this.ctx.getIntegration<TodoIntegration>("todo");
	}

	private resolveModel(modelRef?: string) {
		if (!modelRef) return this.ctx.getModel();
		const slash = modelRef.indexOf("/");
		if (slash > 0) {
			const exact = this.ctx.modelRuntime.getModel(modelRef.slice(0, slash), modelRef.slice(slash + 1));
			if (exact) return exact;
			// Fall through: some catalog ids contain a slash themselves
			// (vendor/name) — try the whole string as a bare id.
		}
		// Bare id: search every provider
		for (const provider of this.ctx.modelRuntime.getProviders()) {
			const model = this.ctx.modelRuntime.getModel(provider.id, modelRef);
			if (model) return model;
		}
		return undefined;
	}

	async spawn(options: SpawnSubagentOptions): Promise<SubAgent> {
		if (this.runningCount() >= this.options.maxConcurrent) {
			throw new Error(
				`Concurrency limit reached (${this.options.maxConcurrent} running sub-agents). Wait for one to finish or cancel one.`,
			);
		}
		const depth = options.depth ?? 0;
		if (depth >= this.options.maxDepth) {
			throw new Error(`Sub-agent depth limit reached (${this.options.maxDepth}). Solve the task yourself.`);
		}
		const model = this.resolveModel(options.model);
		if (!model) {
			throw new Error(
				options.model ? `Model not found: ${options.model}` : "No model selected in the parent session.",
			);
		}

		const projectRoot = ensureGitRepo(this.ctx.cwd);
		const id = `sa-${Date.now().toString(36)}-${String(spawnCounter++).padStart(3, "0")}`;
		const worktreePath = createWorktree(projectRoot, id);
		const branch = branchName(id);

		const agent: SubAgent = {
			id,
			task: options.task,
			status: "running",
			depth,
			branch,
			worktreePath,
			projectRoot,
			startTime: Date.now(),
			mode: options.mode,
			model: `${model.provider}/${model.id}`,
		};
		this.agents.set(id, agent);
		this.launch(agent, {
			taskText: options.task,
			mode: options.mode,
			timeoutMs: options.timeoutMs,
			silent: options.silent === true,
		});
		return agent;
	}

	/**
	 * Resume an interrupted sub-agent (crash survivor) in its existing
	 * worktree and branch. The original task is re-issued with a note to
	 * inspect the partial work first; the model context starts fresh, but
	 * every file change from the previous attempt is still on disk.
	 */
	async continueAgent(id: string): Promise<SubAgent> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running") throw new Error(`Sub-agent ${id} is still running.`);
		if (agent.status !== "interrupted") {
			throw new Error(`Sub-agent ${id} is ${agent.status} — only interrupted sub-agents can be continued.`);
		}
		if (this.runningCount() >= this.options.maxConcurrent) {
			throw new Error(
				`Concurrency limit reached (${this.options.maxConcurrent} running sub-agents). Wait for one to finish or cancel one.`,
			);
		}
		if (!existsSync(agent.worktreePath)) {
			agent.status = "error";
			agent.error = "Worktree missing — nothing to continue.";
			this.deleteMeta(agent);
			throw new Error(`Worktree for ${id} is gone.`);
		}
		agent.status = "running";
		agent.error = undefined;
		agent.endTime = undefined;
		agent.startTime = Date.now();
		agent.result = undefined;
		agent.commitHash = undefined;
		const taskText = [
			"[RESUMED TASK] This task was started in a previous session but interrupted before completion.",
			"The worktree already contains any partial work from that attempt (possibly uncommitted).",
			"Before acting, inspect the current state: git status, git diff, and the files involved.",
			"Then complete the original task:",
			"",
			agent.task,
		].join("\n");
		this.launch(agent, {
			taskText,
			mode: agent.mode,
			timeoutMs: undefined,
			silent: false,
		});
		return agent;
	}

	/**
	 * Run a sub-agent to completion inside its worktree: todo progress,
	 * abort/timeout handling, auto-commit, failure salvage, and completion
	 * notification. Shared by spawn() and continueAgent().
	 */
	private launch(
		agent: SubAgent,
		options: { taskText: string; mode?: SubagentMode; timeoutMs?: number; silent: boolean },
	): void {
		const { id } = agent;
		const projectRoot = agent.projectRoot;
		const worktreePath = agent.worktreePath;
		const branch = agent.branch;
		const depth = agent.depth;

		const todoId = this.todo()?.store.addItem(`• ${agent.task}`) ?? null;
		(agent as SubAgent & { todoId?: string | null }).todoId = todoId;
		this.writeMeta(agent);
		const setProgress = (text: string) => {
			if (todoId) this.todo()?.store.setProgress(id, "running", text);
		};

		const abortController = new AbortController();
		// Distinguishes an explicit cancel()/shutdown() abort from the timeout
		// abort. Without this, a timeout firing between the explicit abort and
		// the run handler resuming would flip a deliberate cancel into a
		// "timeout" (which keeps partial work instead of discarding it).
		let explicitCancel = false;
		agent.abort = async () => {
			explicitCancel = true;
			abortController.abort();
		};

		const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs;
		// Distinguishes a timeout abort from an explicit cancel() in the run handler.
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			abortController.abort();
		}, timeoutMs);

		agent.promise = (async () => {
			try {
				const subagentResult = await runSubagent({
					id,
					task: options.taskText,
					mode: options.mode,
					cwd: worktreePath,
					branch,
					projectRoot,
					modelRuntime: this.ctx.modelRuntime,
					// Prefer the originally chosen model; fall back to the
					// session's current model only when that ref no longer
					// resolves (e.g. provider removed since the crash).
					model: this.resolveModel(agent.model) ?? this.ctx.getModel()!,
					depth,
					maxDepth: this.options.maxDepth,
					childTools: (childDepth) => this.createChildTools(childDepth),
					onProgress: setProgress,
					signal: abortController.signal,
				});
				agent.usage = subagentResult.usage;

				if (abortController.signal.aborted) {
					if (timedOut && !explicitCancel) {
						agent.status = "timeout";
						agent.error = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
						this.cleanupFailedRun(agent);
					} else {
						agent.status = "cancelled";
						agent.error = "Cancelled";
						// Explicit cancel = deliberate discard: remove worktree + branch
						// (matches the subagent_cancel tool contract).
						cleanupWorktree(agent.projectRoot, id, true);
						this.deleteMeta(agent);
					}
				} else if (subagentResult.stopReason === "error") {
					agent.status = "error";
					agent.error = subagentResult.errorMessage || "Sub-agent run failed";
					this.cleanupFailedRun(agent);
				} else {
					// Auto-commit the worktree
					const commit = commitWorktree(worktreePath, id, agent.task, this.options.gitName, this.options.gitEmail);
					if (!commit.ok) {
						agent.status = "error";
						agent.error = `Commit failed: ${commit.reason}`;
					} else {
						agent.status = "done";
						agent.commitHash = commit.hash || undefined;
						agent.result = subagentResult.result;
					}
				}
			} catch (e: any) {
				agent.status = "error";
				agent.error = e?.message || String(e);
				this.cleanupFailedRun(agent);
			} finally {
				clearTimeout(timeout);
				agent.endTime = Date.now();
				if (todoId) {
					const icon = agent.status === "done" ? "✓" : agent.status === "cancelled" ? "✗" : "!";
					// Full task text — the widget wraps instead of truncating.
					const label = `• ${agent.task} — ${icon} ${agent.status}`;
					const store = this.todo()?.store;
					store?.updateItemById(todoId, agent.status === "done" ? "completed" : "cancelled", label);
					store?.clearProgress(id);
					// Programmatic items are excluded from the store's auto-clear,
					// so remove the entry ourselves after the completed state has
					// been visible for a moment — otherwise it lingers forever.
					if (store) {
						const timer = setTimeout(() => store.removeItemById(todoId), 2_000);
						timer.unref?.();
					}
				}
				this.notifyCompletion(agent, options.silent);
			}
		})();
	}

	private notifyCompletion(agent: SubAgent, silent: boolean): void {
		const ui = this.ctx.getUI();
		if (agent.status === "done") {
			ui?.notify(`✓ Sub-agent ${agent.id} completed`, "info");
		} else {
			ui?.notify(`! Sub-agent ${agent.id} ${agent.status}: ${agent.error ?? ""}`, "warning");
		}
		if (silent) return;
		const lines = [
			`[Sub-agent ${agent.id} ${agent.status}]`,
			`Task: ${agent.task.substring(0, 200)}`,
			`Branch: ${agent.branch}${agent.commitHash ? ` (commit ${agent.commitHash})` : ""}`,
		];
		if (agent.result) lines.push(`Report:\n${agent.result.substring(0, 4000)}`);
		if (agent.error) lines.push(`Error: ${agent.error}`);
		if (agent.status === "done") {
			lines.push(
				`Next: subagent_review("${agent.id}") to inspect the diff, subagent_merge("${agent.id}") or subagent_reject("${agent.id}").`,
			);
		}
		this.ctx.sendFollowUp?.(lines.join("\n"));
	}

	async wait(id: string): Promise<SubAgent> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "interrupted") return agent; // nothing in flight — return immediately
		await agent.promise;
		return agent;
	}

	async cancel(id: string): Promise<SubAgent> {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running") {
			await agent.abort?.();
			await agent.promise;
		}
		// The run handler already cleans up on cancel; this is idempotent
		// insurance so the subagent_cancel contract ("clean up its worktree")
		// always holds.
		if (agent.status === "cancelled") {
			cleanupWorktree(agent.projectRoot, agent.id, true);
		}
		return agent;
	}

	/**
	 * Failure-path cleanup (error/timeout).
	 *
	 * Policy: first try to commit whatever partial work the agent left in its
	 * worktree, then check whether the branch carries commits the main HEAD
	 * doesn't. If it does, KEEP the worktree + branch so the user can review
	 * and salvage the partial work (status stays 'error'/'timeout'). If the
	 * agent produced no commits, remove worktree + branch so failed runs don't
	 * leak .pi/subagent/<id> directories and pi/subagent/<id> branches forever.
	 */
	private cleanupFailedRun(agent: SubAgent): void {
		try {
			try {
				const commit = commitWorktree(
					agent.worktreePath,
					agent.id,
					agent.task,
					this.options.gitName,
					this.options.gitEmail,
				);
				if (commit.ok && commit.hash) agent.commitHash = commit.hash;
			} catch {
				/* best effort — worktree may already be gone */
			}
			if (hasBranchCommits(agent.projectRoot, agent.id)) {
				agent.error =
					`${agent.error ?? "Sub-agent run failed"} ` +
					`(partial work kept on branch ${agent.branch} — use subagent_review("${agent.id}"), then merge or reject)`;
			} else {
				cleanupWorktree(agent.projectRoot, agent.id, true);
				this.deleteMeta(agent);
			}
		} catch {
			/* cleanup is best-effort and must not mask the original error */
		}
	}

	/**
	 * Remove worktrees + branches for agents in terminal states (cancelled,
	 * rejected, merged) whose on-disk artifacts are still present — e.g. after
	 * a crash or a missed cleanup. Best-effort.
	 */
	sweep(): void {
		for (const agent of this.agents.values()) {
			if (agent.status === "cancelled" || agent.status === "rejected" || agent.status === "merged") {
				try {
					cleanupWorktree(agent.projectRoot, agent.id, true);
					this.deleteMeta(agent);
				} catch {
					/* best-effort */
				}
			}
		}
	}

	review(id: string): string {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		return getDiff(agent.projectRoot, id);
	}

	merge(id: string): { agent: SubAgent; message: string } {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running") throw new Error(`Sub-agent ${id} is still running.`);
		const result = mergeBranch(this.ctx.cwd, id, {
			stashPolicy: "auto",
			onCommitFailure: "keep-merge",
			description: agent.task,
		});
		if (result.success) {
			agent.status = "merged";
			cleanupWorktree(agent.projectRoot, id, true);
			this.deleteMeta(agent);
			let message = `Merged ${agent.branch} into the current branch.`;
			if (result.stashWarning) message += `\n! ${result.stashWarning}`;
			return { agent, message };
		}
		if (result.hasConflicts) {
			let message =
				`Merge conflicts in:\n${result.conflictFiles}\n` +
				`The branch ${agent.branch} is retained. Resolve manually or subagent_reject("${id}").`;
			// The pre-merge stash may have failed to pop — the user must know
			// their uncommitted changes are still stashed.
			if (result.stashWarning) message += `\n! ${result.stashWarning}`;
			return { agent, message };
		}
		return { agent, message: `Merge failed: ${result.error}. The branch ${agent.branch} is retained.` };
	}

	reject(id: string): { agent: SubAgent; message: string } {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Sub-agent ${id} not found.`);
		if (agent.status === "running") throw new Error(`Sub-agent ${id} is still running — cancel it first.`);
		agent.status = "rejected";
		cleanupWorktree(agent.projectRoot, id, true);
		this.deleteMeta(agent);
		return { agent, message: `Rejected ${id}: worktree removed and branch ${agent.branch} deleted.` };
	}

	ensureGit(): string {
		ensureGitRepo(this.ctx.cwd);
		return `Git repository ready at ${this.ctx.cwd}`;
	}

	/** Recursive toolset for child sub-agents (Agent runtime tools, not session tools). */
	private createChildTools(depth: number): AgentTool[] {
		const manager = this;
		const spawnSchema = Type.Object({
			task: Type.String({ description: "Task description for the sub-agent" }),
			mode: Type.Optional(
				Type.Enum(["analyze", "improve", "execute"] as const, {
					default: "execute",
					description:
						"'analyze': read-only tools (read+bash, written report only). 'improve': full tools to improve existing code. 'execute': full tools to implement new tasks (default).",
				}),
			),
			timeoutMs: Type.Optional(Type.Number({ description: "Max runtime in ms" })),
		});
		const waitSchema = Type.Object({ id: Type.String({ description: "Sub-agent id" }) });
		const listSchema = Type.Object({});

		const spawnTool: AgentTool<typeof spawnSchema> = {
			name: "subagent_spawn",
			label: "Spawn Sub-agent",
			description:
				"Spawn a sub-agent in its own git worktree for an independent subtask. " +
				"Modes: 'analyze' (read-only: read+bash, produces a written report), 'improve' (full tools, improve existing code), 'execute' (full tools, implement new tasks; default).",
			parameters: spawnSchema,
			async execute(_id, params: { task: string; mode?: SubagentMode; timeoutMs?: number }) {
				const agent = await manager.spawn({
					task: params.task,
					mode: params.mode,
					timeoutMs: params.timeoutMs,
					depth,
					silent: true,
				});
				return {
					content: [{ type: "text", text: `Sub-agent ${agent.id} started (worktree: ${agent.worktreePath}).` }],
					details: { id: agent.id },
				};
			},
		};
		const waitTool: AgentTool<typeof waitSchema> = {
			name: "subagent_wait",
			label: "Wait for Sub-agent",
			description: "Wait for a sub-agent to finish and return its report.",
			parameters: waitSchema,
			async execute(_id, params: { id: string }) {
				const agent = await manager.wait(params.id);
				return {
					content: [
						{
							type: "text",
							text: `Sub-agent ${agent.id} ${agent.status}.\n${agent.result ?? agent.error ?? ""}`,
						},
					],
					details: { status: agent.status },
				};
			},
		};
		const listTool: AgentTool<typeof listSchema> = {
			name: "subagent_list",
			label: "List Sub-agents",
			description: "List all sub-agents and their status.",
			parameters: listSchema,
			async execute() {
				const lines = manager.list().map((a) => `  ${a.id}: ${a.status} — ${a.task.substring(0, 60)}`);
				return {
					content: [{ type: "text", text: lines.length ? `Sub-agents:\n${lines.join("\n")}` : "No sub-agents." }],
					details: {},
				};
			},
		};
		const cancelTool: AgentTool<typeof waitSchema> = {
			name: "subagent_cancel",
			label: "Cancel Sub-agent",
			description: "Cancel a running sub-agent and clean up its worktree.",
			parameters: waitSchema,
			async execute(_id, params: { id: string }) {
				const agent = await manager.cancel(params.id);
				return { content: [{ type: "text", text: `Sub-agent ${agent.id}: ${agent.status}.` }], details: {} };
			},
		};
		return [spawnTool, waitTool, listTool, cancelTool];
	}

	/** Abort every running sub-agent (session shutdown). */
	async shutdown(): Promise<void> {
		const running = this.list().filter((a) => a.status === "running");
		await Promise.allSettled(running.map((a) => a.abort?.()));
		await Promise.allSettled(running.map((a) => a.promise));
		// Aborted agents land in 'cancelled' and their run handler cleans up;
		// this pass is belt-and-braces for anything missed.
		for (const agent of this.list()) {
			if (agent.status === "cancelled") {
				try {
					cleanupWorktree(agent.projectRoot, agent.id, true);
				} catch {
					/* best-effort */
				}
			}
		}
	}
}
