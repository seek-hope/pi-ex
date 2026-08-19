/**
 * Asset-dir resolution regression (the `dist/dist` double-path bug):
 * theme/export-template/assets directories must resolve relative to the
 * module's own directory (src/ under tsx, dist/ under Node) — never by
 * probing for `src/` against a `getPackageDir()` that a copied
 * `dist/package.json` (build:binary payload) can shadow.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getExportTemplateDir, getInteractiveAssetsDir, getThemesDir } from "../src/config.ts";

describe("asset directory resolution", () => {
	it("resolves the themes dir under the module dir (no dist/dist)", () => {
		const dir = getThemesDir();
		expect(dir).not.toContain("dist/dist");
		expect(dir.endsWith("modes/interactive/theme")).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});

	it("resolves the export template dir under the module dir", () => {
		const dir = getExportTemplateDir();
		expect(dir).not.toContain("dist/dist");
		expect(dir.endsWith("core/export-html")).toBe(true);
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(`${dir}/template.html`)).toBe(true);
	});

	it("resolves the interactive assets dir under the module dir", () => {
		const dir = getInteractiveAssetsDir();
		expect(dir).not.toContain("dist/dist");
		expect(dir.endsWith("modes/interactive/assets")).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});
});
