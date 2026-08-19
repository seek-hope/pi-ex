import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

// Fork note: this fork's built-in registry is read/bash/edit/write/ask_user/wait
// (plus integration tools), not upstream's read/bash/edit/write/grep/find/ls —
// so the configured lists below use this fork's inventory, and the all-tools
// assertions are containment checks instead of upstream's exact 7-tool list.

describe("defaultTools setting", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function createSession(
		defaultTools: string[] | undefined,
		options: {
			customTools?: Array<{
				name: string;
				label: string;
				description: string;
				parameters: import("typebox").TObject;
				execute: (...args: never[]) => Promise<{
					content: Array<{ type: "text"; text: string }>;
					details: Record<string, never>;
				}>;
			}>;
			tools?: string[];
			excludeTools?: string[];
			noTools?: "all";
		} = {},
	) {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
		});
		services.settingsManager.applyOverrides(defaultTools ? { defaultTools } : {});
		return (
			await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(),
				model: getModel("anthropic", "claude-sonnet-4-5"),
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["read", "bash"]);

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "ask_user", "wait"]),
		);
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
		expect(session.systemPrompt).toContain("Read file contents");
		expect(session.systemPrompt).toContain("Execute bash commands");
		expect(session.systemPrompt).not.toContain("Make precise file edits");
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const makeTool = (name: string) => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		});
		// Fork note: extension tools are registered via extension factories
		// (pi.registerTool on session_start), not by assigning session.extensions.
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							pi.registerTool(makeTool("dynamic_tool") as never);
							pi.registerTool(makeTool("static_tool") as never);
						});
					},
				],
			},
		});
		services.settingsManager.applyOverrides({ defaultTools: ["read"] });
		const session = (
			await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(),
				model: getModel("anthropic", "claude-sonnet-4-5"),
				customTools: [makeTool("sdk_tool") as never],
			})
		).session;

		await session.bindExtensions({});

		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "read", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const explicitTools = await createSession(["bash"], { tools: ["read"] });
		expect(explicitTools.getActiveToolNames()).toEqual(["read"]);
		explicitTools.dispose();

		const excluded = await createSession(["read", "bash"], { excludeTools: ["read"] });
		expect(excluded.getActiveToolNames()).toEqual(["bash"]);
		excluded.dispose();

		const none = await createSession(["read"], { noTools: "all" });
		expect(none.getActiveToolNames()).toEqual([]);
		none.dispose();
	});

	it("applies through service-based session creation", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
		});
		services.settingsManager.applyOverrides({ defaultTools: ["read"] });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "ask_user", "wait"]),
		);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		session.dispose();
	});
});
