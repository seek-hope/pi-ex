import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { WaitScheduleResult } from "../src/core/tools/wait.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

describe("wait + ask_user session integration", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function createSession(options: { ui?: boolean } = {}): Promise<Harness> {
		const h = await createHarness();
		if (options.ui) {
			await h.session.bindExtensions({
				uiContext: {
					input: async (title: string) => (title.startsWith("Q:") ? `answer to ${title}` : undefined),
					notify: () => {},
					setWidget: () => {},
				} as unknown as ExtensionUIContext,
				mode: "tui",
			});
		}
		harness = h;
		return h;
	}

	function scheduler(h: Harness) {
		return (seconds: number) =>
			(h.session as unknown as { _scheduleWait: (s: number) => WaitScheduleResult })._scheduleWait.call(
				h.session,
				seconds,
			);
	}

	it("wakes the model after wait() with fixed guidance and the bg-task list", async () => {
		const h = await createSession();
		// Respond with a toolUse for the built-in wait tool (registered by default
		// in every session); the harness drives the real tool execution.
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", { timeout: 1 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed"),
		]);
		await h.session.prompt("start a build and wait");
		// The wait tool armed a 1s timer; the wake-up arrives as a follow-up
		// and needs another faux response.
		h.appendResponses([fauxAssistantMessage("woke")]);
		await sleep(1600);
		const texts = getUserTexts(h);
		const wakeup = texts.find((t) => t.includes("The wait you requested has ended"));
		expect(wakeup).toBeDefined();
		expect(wakeup).toContain("Current background tasks:");
		// Running tasks are listed; when none run, the placeholder appears.
		// The task store is a process-wide singleton, so either form is valid.
		expect(wakeup).toMatch(/\(no background tasks running\)|◐/);
	});

	it("ends the turn after wait: no further assistant response is requested", async () => {
		const h = await createSession();
		// Only ONE faux response: the wait tool call. If the turn did not end
		// after wait, the loop would request a second response and fail with
		// "No more faux responses queued".
		h.setResponses([fauxAssistantMessage(fauxToolCall("wait", { timeout: 1 }), { stopReason: "toolUse" })]);
		const promptPromise = h.session.prompt("wait please");
		// The wake-up arrives after ~1s as a follow-up and needs its own response.
		h.appendResponses([fauxAssistantMessage("woke")]);
		await promptPromise;
		await sleep(1600);
		const texts = getUserTexts(h);
		expect(texts.some((t) => t.includes("The wait you requested has ended"))).toBe(true);
	});

	it("agent.isActive is false when idle and after a run settles", async () => {
		const h = await createSession();
		expect(h.session.agent.isActive).toBe(false);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("hi");
		expect(h.session.agent.isActive).toBe(false);
	});

	it("replays queued messages stranded after the loop exited", async () => {
		const h = await createSession();
		// First turn finishes normally.
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("first");
		// A follow-up arrives while the loop is gone (post-run window): it must
		// still wake the session instead of stranding until the next user input.
		h.appendResponses([fauxAssistantMessage("processed")]);
		const session = h.session as unknown as {
			_queueFollowUp: (text: string) => Promise<void>;
			_replayStrandedQueuedMessages: () => void;
		};
		await session._queueFollowUp("stranded notification");
		session._replayStrandedQueuedMessages();
		await new Promise((r) => setTimeout(r, 500));
		const texts = getUserTexts(h);
		expect(texts.some((t) => t.includes("stranded notification"))).toBe(true);
	});

	it("schedule caps: headless 120s / interactive 12h, headless 5 uses", async () => {
		const h = await createSession();
		const sched = scheduler(h);
		expect(sched(121)).toMatchObject({ ok: false });
		expect(sched(120)).toMatchObject({ ok: true });
		for (let i = 0; i < 4; i++) {
			expect(sched(1)).toMatchObject({ ok: true });
		}
		const sixth = sched(1);
		expect(sixth.ok).toBe(false);
		if (!sixth.ok) expect(sixth.error).toContain("Headless wait limit");
	});

	it("interactive sessions allow long waits (12h)", async () => {
		const h = await createSession({ ui: true });
		const sched = scheduler(h);
		expect(sched(12 * 3600 + 1)).toMatchObject({ ok: false });
		expect(sched(12 * 3600)).toMatchObject({ ok: true });
	});

	it("ask_user handler: no UI reports no-ui, with UI returns the answer", async () => {
		const h = await createSession();
		const handler = (h.session as unknown as { _askUserHandler: (q: string) => Promise<unknown> })._askUserHandler;
		expect(await handler.call(h.session, "Q: deploy?")).toEqual({ ok: false, reason: "no-ui" });

		const h2 = await createSession({ ui: true });
		const handler2 = (h2.session as unknown as { _askUserHandler: (q: string) => Promise<unknown> })._askUserHandler;
		expect(await handler2.call(h2.session, "Q: deploy?")).toEqual({
			ok: true,
			answer: "answer to Q: deploy?",
		});
		expect(await handler2.call(h2.session, "no-prefix")).toEqual({ ok: false, reason: "cancelled" });
	});
});
