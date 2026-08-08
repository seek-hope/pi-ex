import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BashOperations,
	createBashTool,
	hasSudoToken,
	injectSudoAskpass,
	type LocalSudoHandler,
} from "../src/core/tools/bash.ts";

describe("sudo token detection", () => {
	it("detects sudo in any command segment", () => {
		expect(hasSudoToken("sudo apt update")).toBe(true);
		expect(hasSudoToken("echo hi && sudo rm -rf /tmp/x")).toBe(true);
		expect(hasSudoToken("false; sudo -v")).toBe(true);
		expect(hasSudoToken("cat sudo.txt")).toBe(false);
		expect(hasSudoToken("echo 'sudo not a command'")).toBe(false);
		expect(hasSudoToken("grep sudo /etc/passwd")).toBe(false);
	});

	it("injects -A only into segment-leading sudo tokens", () => {
		expect(injectSudoAskpass("sudo apt update")).toBe("sudo -A apt update");
		expect(injectSudoAskpass("echo hi && sudo rm -rf /tmp/x")).toBe("echo hi && sudo -A rm -rf /tmp/x");
		expect(injectSudoAskpass("grep sudo x && sudo -n true")).toBe("grep sudo x && sudo -A -n true");
	});
});

describe("bash tool local sudo", () => {
	let dir: string;
	let handler: LocalSudoHandler;
	let password: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-bash-sudo-"));
		password = undefined;
		handler = {
			getPassword: () => password,
			setPassword: (p) => {
				password = p;
			},
			promptPassword: async () => "prompted-secret",
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function recordingOps(
		records: Array<{ command: string; env?: NodeJS.ProcessEnv }>,
		onSudoExec?: (env: NodeJS.ProcessEnv) => void,
	): BashOperations {
		return {
			exec: async (command, _cwd, { onData, env }) => {
				records.push({ command, env });
				if (command === "sudo -n true") {
					// Probe: cached credentials missing → exit 1 (needs password).
					onData(Buffer.from("sudo: a password is required\n", "utf-8"));
					return { exitCode: 1 };
				}
				if (command.startsWith("sudo -A") && env?.SUDO_ASKPASS) {
					onSudoExec?.(env);
				}
				onData(Buffer.from(`ran: ${command}`, "utf-8"));
				return { exitCode: 0 };
			},
		};
	}

	it("runs commands without sudo untouched", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		const tool = createBashTool(dir, { operations: recordingOps(records) });
		const result = await tool.execute("c1", { command: "ls -la" });
		expect(records.map((r) => r.command)).toEqual(["ls -la"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "ran: ls -la" });
	});

	it("prompts for the password, caches it, and injects SUDO_ASKPASS", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		let askpassContent: string | undefined;
		const tool = createBashTool(dir, {
			operations: recordingOps(records, (env) => {
				// The askpass script and its password file exist while the command runs.
				const askpass = readFileSync(env.SUDO_ASKPASS!, "utf-8");
				const passFile = askpass.match(/cat "([^"]+)"/)![1]!;
				expect(readFileSync(passFile, "utf-8")).toBe("prompted-secret");
				askpassContent = askpass;
			}),
			sudo: handler,
		});
		const result = await tool.execute("c2", { command: "sudo whoami" });

		// The password is verified with an askpass probe before caching.
		expect(records.map((r) => r.command)).toEqual(["sudo -n true", "sudo -A true", "sudo -A whoami"]);
		expect(records[2]!.env?.SUDO_ASKPASS).toBeTruthy();
		expect(askpassContent).toContain("#!/bin/sh");
		// The password was cached for reuse.
		expect(password).toBe("prompted-secret");
		expect(result.content[0]).toMatchObject({ type: "text", text: "ran: sudo -A whoami" });
	});

	it("reuses the cached password without re-prompting", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		let prompts = 0;
		const tool = createBashTool(dir, {
			operations: recordingOps(records),
			sudo: {
				...handler,
				promptPassword: async () => {
					prompts++;
					return "prompted-secret";
				},
			},
		});
		await tool.execute("c3", { command: "sudo whoami" });
		await tool.execute("c4", { command: "sudo whoami" });
		expect(prompts).toBe(1);
		expect(records.filter((r) => r.command === "sudo -A whoami")).toHaveLength(2);
	});

	it("verifies the password before caching and re-prompts on a wrong one", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		const ops: BashOperations = {
			exec: async (command, _cwd, { onData, env }) => {
				records.push({ command, env });
				if (command === "sudo -n true") {
					onData(Buffer.from("sudo: a password is required\n", "utf-8"));
					return { exitCode: 1 };
				}
				if (command === "sudo -A true") {
					// First cached password is wrong, re-prompted one is accepted.
					const askpassPath = env?.SUDO_ASKPASS;
					if (!askpassPath) return { exitCode: 1 };
					const askpass = readFileSync(askpassPath, "utf-8");
					const pass = readFileSync(askpass.match(/cat "([^"]+)"/)![1]!, "utf-8");
					onData(Buffer.from("sudo: authentication failure\n", "utf-8"));
					return { exitCode: pass === "good-secret" ? 0 : 1 };
				}
				onData(Buffer.from(`ran: ${command}`, "utf-8"));
				return { exitCode: 0 };
			},
		};
		let prompts = 0;
		const cached = { value: "wrong-secret" };
		const tool = createBashTool(dir, {
			operations: ops,
			sudo: {
				getPassword: () => cached.value,
				setPassword: (p) => {
					cached.value = p;
				},
				promptPassword: async () => {
					prompts++;
					return "good-secret";
				},
			},
		});
		const result = await tool.execute("c4b", { command: "sudo whoami" });

		// Wrong cached password was not trusted: re-prompted, verified, and only
		// then cached — the session is not poisoned by the first mistake.
		expect(prompts).toBe(1);
		expect(cached.value).toBe("good-secret");
		expect(records.map((r) => r.command)).toEqual(["sudo -n true", "sudo -A true", "sudo -A true", "sudo -A whoami"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "ran: sudo -A whoami" });
	});

	it("gives up after three failed verification attempts", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		let attempts = 0;
		const ops: BashOperations = {
			exec: async (command, _cwd, { onData, env }) => {
				records.push({ command, env });
				if (command === "sudo -n true") {
					onData(Buffer.from("sudo: a password is required\n", "utf-8"));
					return { exitCode: 1 };
				}
				if (command === "sudo -A true") {
					onData(Buffer.from("sudo: authentication failure\n", "utf-8"));
					return { exitCode: 1 };
				}
				onData(Buffer.from(`ran: ${command}`, "utf-8"));
				return { exitCode: 0 };
			},
		};
		const tool = createBashTool(dir, {
			operations: ops,
			sudo: {
				getPassword: () => undefined,
				setPassword: () => {},
				promptPassword: async () => {
					attempts++;
					return "bad-secret";
				},
			},
		});
		await expect(tool.execute("c4c", { command: "sudo whoami" })).rejects.toThrow(
			/verification failed after 3 attempts/,
		);
		expect(attempts).toBe(3);
		// No stale askpass files survive the failure.
		const leftover = readdirSync(tmpdir()).filter((f) => f.startsWith(".pi-sudo-"));
		expect(leftover).toEqual([]);
	});

	it("fails with a clear message when no password is available", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		const tool = createBashTool(dir, {
			operations: recordingOps(records),
			sudo: { getPassword: () => undefined, setPassword: () => {}, promptPassword: async () => undefined },
		});
		await expect(tool.execute("c5", { command: "sudo whoami" })).rejects.toThrow(/sudo requires a password/);
	});

	it("fails cleanly without a sudo handler (sub-agent toolsets)", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		const tool = createBashTool(dir, { operations: recordingOps(records) });
		await expect(tool.execute("c6", { command: "sudo whoami" })).rejects.toThrow(/sudo requires a password/);
	});

	it("cleans up the askpass temp files after execution", async () => {
		const records: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
		let askpassPath: string | undefined;
		let passPath: string | undefined;
		const tool = createBashTool(dir, {
			operations: recordingOps(records, (env) => {
				askpassPath = env.SUDO_ASKPASS;
				passPath = readFileSync(env.SUDO_ASKPASS!, "utf-8").match(/cat "([^"]+)"/)![1]!;
			}),
			sudo: handler,
		});
		await tool.execute("c7", { command: "sudo whoami" });
		expect(askpassPath).toBeTruthy();
		expect(() => readFileSync(askpassPath!)).toThrow();
		expect(() => readFileSync(passPath!)).toThrow();
	});
});
