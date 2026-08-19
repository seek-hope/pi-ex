import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BranchSummaryEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n`;

function createAssistantText(model: Model<string>, text: string): AssistantMessage {
	return {
		...fauxAssistantMessage(text, { stopReason: "stop" }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

/**
 * Replace the session stream function with a fully scripted one so the default
 * branch summarizer (which calls `streamFn`) never touches the network. Returns
 * a `capture` function that relays the prompt context passed to the summarizer.
 */
function useScriptedSummaryStreamFn(harness: Harness, summary: string): () => { promptText: string } | undefined {
	let captured: { promptText: string } | undefined;
	harness.session.agent.streamFunction = (model, context) => {
		// Snapshot the prompt text assembled for the summarizer.
		const text = String((context.messages[0] as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");
		captured = { promptText: text };
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantText(model, summary);
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => captured;
}

describe("AgentSession tree navigation (deterministic)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function buildConversation(harness: Harness, turns: string[]): Promise<void> {
		for (const turn of turns) {
			harness.setResponses([fauxAssistantMessage(`${turn} (assistant)`)]);
			await harness.session.prompt(turn);
		}
	}

	it("navigates to the root user message, generating a branch summary attached to the tree root", async () => {
		const sessionTreeEvents: Array<{ newLeafId: string | null; oldLeafId: string | null }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", (event) => {
						sessionTreeEvents.push({ newLeafId: event.newLeafId, oldLeafId: event.oldLeafId });
					});
				},
			],
		});
		harnesses.push(harness);

		// u1 -> a1 -> u2 -> a2
		await buildConversation(harness, ["u1", "u2"]);

		const entries = harness.sessionManager.getEntries();
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		const rootUser = userEntries[0]!;
		expect(rootUser).toBeDefined();

		// Script the default summarizer output.
		useScriptedSummaryStreamFn(harness, "SUM-ROOT");
		const oldLeafId = harness.sessionManager.getLeafId();
		expect(oldLeafId).toBeTruthy();

		// Navigate to the root user message WITH summarization.
		const result = await harness.session.navigateTree(rootUser.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("u1");
		expect(result.aborted).toBeUndefined();

		const entry = result.summaryEntry;
		expect(entry).toBeDefined();
		expect(entry?.type).toBe("branch_summary");
		// Summary text = preamble prepended by the default summarizer.
		expect((entry as BranchSummaryEntry).summary).toBe(`${BRANCH_SUMMARY_PREAMBLE}SUM-ROOT`);
		// Navigated to a root user message -> leaf moves to parent (null root).
		expect((entry as BranchSummaryEntry).parentId).toBeNull();
		// d711bd5f0 (upstream): fromId records the pre-navigation leaf.
		expect((entry as BranchSummaryEntry).fromId).toBe(oldLeafId);

		// The summary is a new root entry and is the new leaf.
		expect(harness.sessionManager.getLeafId()).toBe(entry?.id);
		expect(
			harness.sessionManager
				.getTree()
				.map((node) => node.entry.type)
				.sort(),
		).toEqual(["branch_summary", "message"]);
		// u1 (the retained user message) is a sibling root, unchanged.
		const rootsById = new Map(harness.sessionManager.getTree().map((node) => [node.entry.id, node]));
		expect(rootsById.get(rootUser.id)).toBeDefined();
		expect(rootsById.get(entry!.id)).toBeDefined();

		// `session_tree` extension event reflects the navigation.
		expect(sessionTreeEvents).toHaveLength(1);
		expect(sessionTreeEvents[0]?.newLeafId).toBe(entry?.id);
		expect(sessionTreeEvents[0]?.oldLeafId).toBe(oldLeafId);
	});

	it("selects the correct parent and abandoned-branch context when navigating to a nested user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// u1 -> a1 -> u2 -> a2 -> u3 -> a3
		await buildConversation(harness, ["u1", "u2", "u3"]);

		const entries = harness.sessionManager.getEntries();
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		expect(userEntries).toHaveLength(3);
		const u2 = userEntries[1]!;
		const a1 = entries.find((e) => e.id === u2.parentId);
		if (a1?.type !== "message") throw new Error("expected a1 to be a message entry");
		expect(a1.message.role).toBe("assistant");

		// Capture the prompt passed to the summarizer.
		const capture = useScriptedSummaryStreamFn(harness, "SUM-NEST");
		const oldLeafId = harness.sessionManager.getLeafId();
		const result = await harness.session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("u2");

		const entry = result.summaryEntry as BranchSummaryEntry;
		expect(entry?.type).toBe("branch_summary");
		// Navigating to a user message puts the summary at its parent (a1).
		expect(entry?.parentId).toBe(a1?.id);
		// d711bd5f0 (upstream): fromId records the pre-navigation leaf.
		expect(entry?.fromId).toBe(oldLeafId);

		// a1 now has two children: the continuation (u2) and the summary.
		const children = harness.sessionManager.getChildren(a1!.id);
		expect(children.map((c) => c.type).sort()).toEqual(["branch_summary", "message"]);

		// The summarizer received only the abandoned branch tail (a2,u3,a3),
		// never the retained prefix (u1,a1,u2).
		const promptText = capture()?.promptText ?? "";
		expect(promptText).toContain("u2 (assistant)");
		expect(promptText).toContain("u3");
		expect(promptText).toContain("u3 (assistant)");
		expect(promptText).not.toContain("u1 (assistant)");
	});

	it("aborting an in-progress branch summary returns cancelled and leaves entries unchanged", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await buildConversation(harness, ["u1", "u2"]);

		const entries = harness.sessionManager.getEntries();
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		const rootUser = userEntries[0]!;
		const leafBefore = harness.sessionManager.getLeafId();
		const countBefore = entries.length;

		// Script the summarizer so it only completes when the request is aborted,
		// producing a deterministic `aborted` stop reason as soon as the signal fires.
		harness.session.agent.streamFunction = (model, _context, requestOptions) => {
			const stream = createAssistantMessageEventStream();
			requestOptions?.signal?.addEventListener(
				"abort",
				() => {
					const msg: AssistantMessage = { ...createAssistantText(model, ""), stopReason: "aborted" };
					msg.content = [{ type: "text", text: "" }];
					stream.push({ type: "error", reason: "aborted", error: msg });
				},
				{ once: true },
			);
			return stream;
		};

		const navPromise = harness.session.navigateTree(rootUser.id, { summarize: true });
		// Let the navigation start the summarization request.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isCompacting).toBe(true);

		harness.session.abortBranchSummary();
		const result = await navPromise;

		expect(result.cancelled).toBe(true);
		expect(result.aborted).toBe(true);
		expect(result.summaryEntry).toBeUndefined();

		// Session is unchanged: no new entries, leaf still points at the old value.
		expect(harness.sessionManager.getEntries().length).toBe(countBefore);
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().filter((e) => e.type === "branch_summary")).toHaveLength(0);
	});

	it("treats navigation to the current leaf as a no-op and rejects unknown targets", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await buildConversation(harness, ["u1"]);

		const leafId = harness.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		const countBefore = harness.sessionManager.getEntries().length;

		// Navigate to the current leaf -> no-op.
		const noop = await harness.session.navigateTree(leafId!, { summarize: false });
		expect(noop.cancelled).toBe(false);
		expect(noop.summaryEntry).toBeUndefined();
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.sessionManager.getEntries().length).toBe(countBefore);
		// No branch summary, no new entries of any kind.
		expect(harness.sessionManager.getEntries()).toEqual(harness.sessionManager.getBranch());

		// Navigate to a non-existent entry -> rejected before any state change.
		await expect(harness.session.navigateTree("missing-entry", { summarize: false })).rejects.toThrow(
			"Entry missing-entry not found",
		);
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.sessionManager.getEntries().length).toBe(countBefore);
	});
});
