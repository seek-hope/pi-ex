import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("resolves result() from a pushed terminal event", async () => {
		const stream = new EventStream<{ type: "chunk" | "done"; value?: string }, string>(
			(e) => e.type === "done",
			(e) => (e.type === "done" ? (e.value ?? "") : ""),
		);
		stream.push({ type: "chunk", value: "a" });
		stream.push({ type: "done", value: "ok" });
		stream.end();
		await expect(stream.result()).resolves.toBe("ok");
	});

	it("end() without a terminal event does not hang result()", async () => {
		const stream = new EventStream<{ type: "chunk" | "done"; value?: string }, string>(
			(e) => e.type === "done",
			(e) => (e.type === "done" ? (e.value ?? "") : ""),
		);
		stream.push({ type: "chunk", value: "a" });
		stream.end();
		const result = await Promise.race([
			stream.result(),
			new Promise<"hang">((resolve) => setTimeout(() => resolve("hang"), 100)),
		]);
		expect(result).not.toBe("hang");
	});

	it("end() with an explicit result wins over nothing, and later end() is a no-op", async () => {
		const stream = new EventStream<{ type: "chunk" | "done"; value?: string }, string>(
			(e) => e.type === "done",
			(e) => (e.type === "done" ? (e.value ?? "") : ""),
		);
		stream.end("explicit");
		stream.end("again");
		await expect(stream.result()).resolves.toBe("explicit");
	});

	it("iterator drains queued events and stops after done", async () => {
		const stream = new EventStream<{ type: "chunk" | "done"; value?: string }, string>(
			(e) => e.type === "done",
			(e) => (e.type === "done" ? (e.value ?? "") : ""),
		);
		stream.push({ type: "chunk", value: "a" });
		stream.push({ type: "chunk", value: "b" });
		stream.push({ type: "done", value: "ok" });
		stream.end();
		const events: string[] = [];
		for await (const event of stream) {
			if (event.type === "chunk") events.push(event.value ?? "");
		}
		expect(events).toEqual(["a", "b"]);
	});

	it("push after done is silently ignored but result stays resolved", async () => {
		const stream = new EventStream<{ type: "chunk" | "done"; value?: string }, string>(
			(e) => e.type === "done",
			(e) => (e.type === "done" ? (e.value ?? "") : ""),
		);
		stream.push({ type: "done", value: "first" });
		stream.push({ type: "chunk", value: "late" });
		stream.end();
		await expect(stream.result()).resolves.toBe("first");
		const events: unknown[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(events).toEqual([{ type: "done", value: "first" }]);
	});
});
