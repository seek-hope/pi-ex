/**
 * Integration tests for /tree file rewind: navigating the tree back also
 * reverts file mutations recorded by the model's edit/write tools.
 *
 * Uses the faux provider scripting tool calls against the real built-in
 * edit/write tools (no real provider APIs).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("tree navigation reverts file changes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reverts edit-tool mutations when rewinding to the user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const file = join(harness.tempDir, "f.txt");
		writeFileSync(file, "hello world", "utf8");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "f.txt", edits: [{ oldText: "hello", newText: "goodbye" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Change hello to goodbye");
		expect(readFileSync(file, "utf8")).toBe("goodbye world");

		const userEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntry).toBeDefined();

		const result = await harness.session.navigateTree(userEntry!.id, { summarize: false });
		expect(result.cancelled).toBe(false);
		expect(result.fileRevert?.reverted).toEqual([file]);
		expect(readFileSync(file, "utf8")).toBe("hello world");
	});

	it("deletes files created by write when rewinding to the user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const file = join(harness.tempDir, "new.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "new.txt", content: "created" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Create new.txt");
		expect(readFileSync(file, "utf8")).toBe("created");

		const userEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");

		const result = await harness.session.navigateTree(userEntry!.id, { summarize: false });
		expect(result.fileRevert?.reverted).toEqual([file]);
		expect(existsSync(file)).toBe(false);
	});

	it("keeps files intact when navigating to the assistant reply", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const file = join(harness.tempDir, "f.txt");
		writeFileSync(file, "hello world", "utf8");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "f.txt", edits: [{ oldText: "hello", newText: "goodbye" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Change hello to goodbye");
		expect(readFileSync(file, "utf8")).toBe("goodbye world");

		// The toolResult entry sits between the tool-call entry (the mutation's
		// tag) and the final reply: rewinding to it keeps the file change.
		const toolResultEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolResultEntry).toBeDefined();

		const result = await harness.session.navigateTree(toolResultEntry!.id, { summarize: false });
		expect(result.fileRevert?.reverted).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("goodbye world");
	});
});
