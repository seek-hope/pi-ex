/**
 * Sub-agent types (in-process execution via the Agent runtime).
 */

export type SubAgentStatus =
	| "running"
	| "done"
	| "error"
	| "cancelled"
	| "timeout"
	| "merged"
	| "rejected"
	| "interrupted";

/**
 * Sub-agent toolset mode:
 * - analyze: read-only (read + bash; bash still passes through the bash gate). No edit/write.
 * - improve: full toolset (read + edit + write + bash) for improving existing code.
 * - execute: full toolset (read + edit + write + bash) for implementing new tasks. Default.
 */
export type SubagentMode = "analyze" | "improve" | "execute";

export interface SubAgentUsage {
	input: number;
	output: number;
	cost: number;
}

export interface SubAgent {
	id: string;
	task: string;
	status: SubAgentStatus;
	depth: number;
	branch: string;
	worktreePath: string;
	projectRoot: string;
	startTime: number;
	endTime?: number;
	/** Toolset mode the agent runs with (also persisted for crash resume). */
	mode?: SubagentMode;
	/** Final report from the sub-agent (last assistant message). */
	result?: string;
	error?: string;
	commitHash?: string;
	model?: string;
	usage?: SubAgentUsage;
	/** Abort the in-process run. */
	abort?: () => Promise<void>;
	/** Resolves when the run reaches a terminal state. */
	promise?: Promise<void>;
}

export interface SpawnSubagentOptions {
	task: string;
	/** Toolset mode (default: "execute"). */
	mode?: SubagentMode;
	/** Model id override (provider/id form resolved against the ModelRuntime). */
	model?: string;
	/** Run timeout in ms (default from settings). */
	timeoutMs?: number;
	/** Depth in the spawn tree (0 = spawned by the main session). */
	depth?: number;
	/** Suppress the follow-up completion message (parallel fan-out collects explicitly). */
	silent?: boolean;
}
