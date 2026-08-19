// Guard for the `test` scripts across the monorepo packages that transitively
// import provider model data (packages/ai/src/providers/data/*.json).
//
// Those JSON files are gitignored and only produced by `npm run build`
// (generate-models, which requires network access). On a fresh checkout a
// `vitest` run would otherwise fail with a pile of `Cannot find module
// './data/<provider>.json'` errors. When the data is missing we print a loud,
// actionable warning and exit 0 so tests that don't touch model data still
// run.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "providers", "data");

if (existsSync(dataDir)) {
	const count = readdirSync(dataDir).filter((name) => name.endsWith(".json")).length;
	if (count > 0) {
		process.exit(0);
	}
}

process.stdout.write(
	[
		"",
		"  \x1b[33m\x1b[1m⚠ PROVIDER MODEL DATA MISSING\x1b[0m",
		`  Expected JSON fill files in \`${dataDir}\` (gitignored, generated).`,
		"  Run \x1b[1mnpm run build\x1b[0m first (requires network; runs generate-models).",
		"  Many test files will fail to import without it, but non-model tests will still run.",
		"",
	].join("\n") + "\n",
);
process.exit(0);
