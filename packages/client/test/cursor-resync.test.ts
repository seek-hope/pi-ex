import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { type PiClient, PiSessionOwnershipError } from "../src/index.ts";
import { ClientState } from "../src/state.ts";
import { baseServerSnapshot, collectRequests, connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

function text(content: string) {
	return [{ type: "text" as const, text: content }];
}

describe("PiClient cursor and resync", () => {
	test("applies only exact-next cursor events and ignores stale duplicates", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 0 }));

		// Duplicate / stale cursor is ignored.
		server.send({
			type: "event",
			event: {
				type: "surface_update",
				eventCursor: 0,
				sessionId: "session-1",
				operation: { op: "set_title", title: "stale" },
			},
		});
		expect(handle.snapshot?.surface.title).toBeUndefined();

		// Exact next cursor applies the surface projection.
		server.send({
			type: "event",
			event: {
				type: "surface_update",
				eventCursor: 1,
				sessionId: "session-1",
				operation: { op: "set_title", title: "applied" },
			},
		});
		expect(handle.snapshot?.surface.title).toBe("applied");

		// A forward gap triggers exactly one resync request.
		server.send({
			type: "event",
			event: {
				type: "surface_update",
				eventCursor: 5,
				sessionId: "session-1",
				operation: { op: "set_title", title: "gapped" },
			},
		});
		await Promise.resolve();
		const resyncs = requests.filter((request) => request.request.command === "resync");
		expect(resyncs).toHaveLength(1);
		expect(resyncs[0]?.request).toEqual({ command: "resync", sessionId: "session-1" });
	});

	test("resync atomically replaces the snapshot and cursor, clearing the gap", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 0 }));

		server.send({
			type: "event",
			event: {
				type: "surface_update",
				eventCursor: 7,
				sessionId: "session-1",
				operation: { op: "set_title", title: "gap" },
			},
		});
		await Promise.resolve();
		const resync = requests.find((request) => request.request.command === "resync");
		if (!resync) throw new Error("missing resync");
		const authoritative = sessionSnapshot("session-1", {
			eventCursor: 7,
			revision: 5,
			surface: { title: "recovered" },
		});
		server.send({ type: "response", id: resync.id, ok: true, result: { command: "resync", session: authoritative } });

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(handle.snapshot).toMatchObject({ revision: 5, eventCursor: 7, surface: { title: "recovered" } });

		// After the resync, the next exact cursor event applies cleanly.
		server.send({
			type: "event",
			event: {
				type: "surface_update",
				eventCursor: 8,
				sessionId: "session-1",
				operation: { op: "set_title", title: "next" },
			},
		});
		expect(handle.snapshot?.surface.title).toBe("next");
	});

	test("reduces interaction requests and queue updates into the snapshot", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 0 }));

		server.send({
			type: "event",
			event: {
				type: "interaction_request",
				eventCursor: 1,
				sessionId: "session-1",
				request: { method: "select", id: "i1", title: "Pick", options: ["a"] },
			},
		});
		expect(handle.snapshot?.pendingInteractions).toEqual([
			{ method: "select", id: "i1", title: "Pick", options: ["a"] },
		]);

		server.send({
			type: "event",
			event: {
				type: "queue_update",
				eventCursor: 2,
				sessionId: "session-1",
				queue: "follow_up",
				mode: "one-at-a-time",
				queuedCount: 3,
			},
		});
		expect(handle.snapshot).toMatchObject({ followUpMode: "one-at-a-time", queuedFollowUpCount: 3 });
	});

	test("shared handles reject mutations client-side", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const shared = await attachShared(client, server, sessionSnapshot("session-1"));

		await expect(shared.prompt(text("hi"))).rejects.toBeInstanceOf(PiSessionOwnershipError);
		await expect(shared.abort()).rejects.toBeInstanceOf(PiSessionOwnershipError);
		await expect(shared.setQueueMode("steer", "all")).rejects.toBeInstanceOf(PiSessionOwnershipError);
		expect(requests.filter((request) => request.request.command !== "attach")).toHaveLength(0);
	});

	test("derives lease mode from the authoritative snapshot", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const acquiring = client.acquireSession("session-1", { mode: "exclusive" });
		const attach = requests.find((request) => request.request.command === "attach");
		if (!attach) throw new Error("missing attach");
		server.send({
			type: "response",
			id: attach.id,
			ok: true,
			result: {
				command: "attach",
				session: sessionSnapshot("session-1", {
					lease: { exclusiveControllerConnected: true, observerCount: 2, mode: "shared" },
				}),
			},
		});
		const handle = await acquiring;
		expect(handle.mode).toBe("shared");
	});

	test("lease_lost immediately invalidates handles", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const handle = await attachExclusive(client, server, sessionSnapshot("session-1"));

		server.send({ type: "event", event: { type: "lease_lost", sessionId: "session-1", reason: "revoked" } });
		expect(handle.attached).toBe(false);
		await expect(handle.prompt(text("hi"))).rejects.toMatchObject({ name: "PiSessionDetachedError" });
	});
});

test("changed server id invalidates session snapshots, cursors, attachments, and handles", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const requests = collectRequests(server);
	const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 10 }));

	server.send({
		type: "event",
		event: {
			type: "server_snapshot",
			snapshot: { ...baseServerSnapshot, serverId: "server-2", revision: 0 },
		},
	});

	// The old snapshot, cursor baseline, attachment, and handle are invalidated;
	// the handle no longer reports itself as attached and has no snapshot.
	expect(handle.attached).toBe(false);
	expect(handle.snapshot).toBeUndefined();

	// A cursor event arriving after a server-id change is never adopted into
	// stale state. The old lease is invalidated, so the unattached session is
	// ignored rather than issuing a resync that the server must reject.
	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 1,
			sessionId: "session-1",
			operation: { op: "set_title", title: "fresh" },
		},
	});
	await Promise.resolve();
	expect(handle.snapshot?.surface.title).toBeUndefined();
	const resyncs = requests.filter((request) => request.request.command === "resync");
	expect(resyncs).toHaveLength(0);
});

test("shared handles reject every mutation with zero wire request, including respondInteraction", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const requests = collectRequests(server);
	const shared = await attachShared(client, server, sessionSnapshot("session-1"));

	await expect(
		shared.respondInteraction("i1", { method: "confirm", kind: "value", value: true }),
	).rejects.toBeInstanceOf(PiSessionOwnershipError);
	expect(() => shared.request({ command: "set_name", sessionId: "session-1", name: "Renamed" })).toThrow(
		PiSessionOwnershipError,
	);
	expect(() => shared.request({ command: "get_tree", sessionId: "another-session" })).toThrow(RangeError);

	// No wire request is emitted for any of the rejected mutations (beyond attach).
	expect(requests.filter((request) => request.request.command !== "attach")).toHaveLength(0);
});

test("shared handles may resync and issue typed read requests", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const requests = collectRequests(server);
	const shared = await attachShared(client, server, sessionSnapshot("session-1", { eventCursor: 4 }));

	// resync is shared-allowed and round-trips an authoritative snapshot.
	const resync = shared.resync();
	const resyncRequest = requests.find((request) => request.request.command === "resync");
	if (!resyncRequest) throw new Error("missing resync request");
	server.send({
		type: "response",
		id: resyncRequest.id,
		ok: true,
		result: { command: "resync", session: sessionSnapshot("session-1", { eventCursor: 9 }) },
	});
	await expect(resync).resolves.toMatchObject({ eventCursor: 9 });

	// A typed read request is allowed on a shared handle and produces typed data.
	const read = shared.request({ command: "get_tree", sessionId: "session-1" });
	const readRequest = requests.find((request) => request.request.command === "get_tree");
	if (!readRequest) throw new Error("missing get_tree request");
	server.send({
		type: "response",
		id: readRequest.id,
		ok: true,
		result: { command: "get_tree", tree: [], leafId: null },
	});
	await expect(read).resolves.toMatchObject({ command: "get_tree", tree: [] });
});

test("stale and duplicate cursor events are never delivered to subscribers", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 0 }));
	const delivered: number[] = [];
	handle.onEvent((event) => {
		if (event.type === "surface_update") delivered.push(event.eventCursor);
	});

	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 0,
			sessionId: "session-1",
			operation: { op: "set_title", title: "stale" },
		},
	});
	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 1,
			sessionId: "session-1",
			operation: { op: "set_title", title: "applied" },
		},
	});
	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 1,
			sessionId: "session-1",
			operation: { op: "set_title", title: "dup" },
		},
	});

	expect(delivered).toEqual([1]);
	expect(handle.snapshot?.surface.title).toBe("applied");
});

test("repeated forward gaps dedupe into a single in-flight resync", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const requests = collectRequests(server);
	await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 0 }));

	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 5,
			sessionId: "session-1",
			operation: { op: "set_title", title: "gap" },
		},
	});
	await Promise.resolve();
	// While gapped, subsequent cursor events are ignored and do not trigger another resync.
	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 6,
			sessionId: "session-1",
			operation: { op: "set_title", title: "gap2" },
		},
	});
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(requests.filter((request) => request.request.command === "resync")).toHaveLength(1);
});

test("a failed resync permits a later event to trigger exactly one retry", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const requests = collectRequests(server);
	const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { eventCursor: 0 }));

	// Forward gap triggers the first resync.
	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 5,
			sessionId: "session-1",
			operation: { op: "set_title", title: "gap" },
		},
	});
	await Promise.resolve();
	const first = requests.find((request) => request.request.command === "resync");
	if (!first) throw new Error("missing first resync");

	// Fail the resync; the client retains stale state but clears the gap marker.
	server.send({ type: "response", id: first.id, ok: false, error: { code: "internal_error", message: "boom" } });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(handle.snapshot?.surface.title).toBeUndefined();

	// A later forward-gap event re-triggers exactly one retry.
	server.send({
		type: "event",
		event: {
			type: "surface_update",
			eventCursor: 7,
			sessionId: "session-1",
			operation: { op: "set_title", title: "retry" },
		},
	});
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(requests.filter((request) => request.request.command === "resync")).toHaveLength(2);
});

test("detach projection clears attachment and lease mode", async () => {
	const state = new ClientState();
	const detached: SessionSnapshot[] = [];
	state.subscribeSession("session-1", (snapshot) => detached.push(snapshot));

	state.applyResult({
		command: "attach",
		session: sessionSnapshot("session-1", { eventCursor: 3 }),
	});
	state.applyResult({ command: "detach", sessionId: "session-1" });

	const last = detached.at(-1);
	expect(last?.attached).toBe(false);
	expect(last?.lease.mode).toBeNull();
});

test("authoritative snapshots never regress to a lower cursor", async () => {
	const server = new MemoryByteServer();
	const client = await connectClient(server);
	const handle = await attachExclusive(client, server, sessionSnapshot("session-1", { revision: 5, eventCursor: 10 }));

	// Even a snapshot with a higher runtime revision cannot regress the
	// server-owned cursor for the same server identity.
	server.send({
		type: "event",
		event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 6, eventCursor: 4 }) },
	});
	expect(handle.snapshot?.eventCursor).toBe(10);

	// Same revision with a higher cursor advances.
	server.send({
		type: "event",
		event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 5, eventCursor: 12 }) },
	});
	expect(handle.snapshot?.eventCursor).toBe(12);
});

async function attachExclusive(client: PiClient, server: MemoryByteServer, snapshot: SessionSnapshot) {
	const requests = collectRequests(server);
	const acquiring = client.acquireSession(snapshot.id, { mode: "exclusive" });
	const attach = requests.find((request) => request.request.command === "attach");
	if (!attach) throw new Error("missing attach");
	server.send({ type: "response", id: attach.id, ok: true, result: { command: "attach", session: snapshot } });
	return acquiring;
}

async function attachShared(client: PiClient, server: MemoryByteServer, snapshot: SessionSnapshot) {
	const requests = collectRequests(server);
	const acquiring = client.acquireSession(snapshot.id, { mode: "shared" });
	const attach = requests.find((request) => request.request.command === "attach");
	if (!attach) throw new Error("missing attach");
	server.send({
		type: "response",
		id: attach.id,
		ok: true,
		result: {
			command: "attach",
			session: sessionSnapshot(snapshot.id, {
				lease: { exclusiveControllerConnected: true, observerCount: 1, mode: "shared" },
			}),
		},
	});
	return acquiring;
}
