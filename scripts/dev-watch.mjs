// Dev watcher: compiles every package's src to dist on save.
//
// Unlike `npm run build` this never touches the network: the ai package's
// generate-models step (models.dev catalog fetch) is skipped, so the watcher
// works with a broken proxy or no internet at all. The ai provider data was
// generated previously and lives in src/providers/data (gitignored).
//
// Usage:
//   node scripts/dev-watch.mjs
//
// Start it once in a terminal (or tmux), edit source, and every save is
// incrementally compiled to dist. New `pi` sessions pick up the fresh dist
// immediately; already-running sessions need a restart.
//
// One-time setup steps that `npm run build` performs alongside tsgo
// (asset copies, sqlite migrations) are re-run here before watching starts.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = ["tui", "telemetry", "ai", "agent", "session-backends/sqlite-node", "protocol", "client", "server", "coding-agent"];

// ── one-time preparation (idempotent, offline) ─────────────────────────────
const aiData = resolve(root, "packages/ai/src/providers/data");
if (!existsSync(aiData)) {
	console.error(
		"[dev-watch] packages/ai/src/providers/data is missing (gitignored).\n" +
			"  Run `cd packages/ai && npm run generate-models` once with working network,\n" +
			"  or restore the directory from another checkout.",
	);
	process.exit(1);
}

const prepSteps = [
	{ cwd: resolve(root, "packages/session-backends/sqlite-node"), cmd: "node", args: ["scripts/prepare-dist.mjs", "copy-sqlite-migrations"] },
	{ cwd: resolve(root, "packages/coding-agent"), cmd: "npm", args: ["run", "copy-assets"] },
];
for (const step of prepSteps) {
	console.log(`[dev-watch] prep: ${step.cmd} ${step.args.join(" ")} (in ${step.cwd.split("/").slice(-2).join("/")})`);
	const result = spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`[dev-watch] prep step failed (exit ${result.status}); aborting.`);
		process.exit(1);
	}
}

// ── initial full compile (dependency order, offline) ───────────────────────
// Parallel watchers would race: e.g. sqlite-node resolves @earendil-works/*
// to the other packages' dist, which must exist before it compiles. Compile
// once sequentially first, then the watchers only do incremental rebuilds.
const depOrder = ["tui", "telemetry", "ai", "agent", "session-backends/sqlite-node", "protocol", "client", "server", "coding-agent"];
for (const pkg of depOrder) {
	console.log(`[dev-watch] initial compile: ${pkg}`);
	const result = spawnSync("npx", ["tsgo", "-p", "tsconfig.build.json"], {
		cwd: resolve(root, "packages", pkg),
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error(`[dev-watch] initial compile of ${pkg} failed (exit ${result.status}); aborting.`);
		process.exit(1);
	}
}

// ── parallel incremental watchers ──────────────────────────────────────────
const children = new Map();
for (const pkg of packages) {
	const cwd = resolve(root, "packages", pkg);
	const child = spawn("npx", ["tsgo", "--watch", "-p", "tsconfig.build.json"], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const prefix = `[${pkg}] `;
	child.stdout.on("data", (chunk) => {
		// tsgo emits a progress line for every incremental pass; only forward
		// diagnostics (errors) and the ready/complete markers.
		for (const line of String(chunk).split("\n")) {
			const text = line.trim();
			if (!text) continue;
			if (
				text.includes("error TS") ||
				text.includes("build starting") ||
				text.includes("build finished") ||
				text.includes("Found") ||
				text.includes("Watching") ||
				text.includes("Complete")
			) {
				process.stdout.write(`${prefix}${text}\n`);
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		for (const line of String(chunk).split("\n")) {
			if (line.trim()) process.stderr.write(`${prefix}${line}\n`);
		}
	});
	child.on("exit", (code) => {
		console.log(`[dev-watch] ${pkg} watcher exited (${code})`);
		children.delete(pkg);
		if (children.size === 0) process.exit(0);
	});
	children.set(pkg, child);
}

const stop = () => {
	for (const child of children.values()) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`[dev-watch] watching ${packages.length} packages (${packages.join(", ")})`);
