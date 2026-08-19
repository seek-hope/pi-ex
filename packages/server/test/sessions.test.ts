import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMetadata, ResultForCommand, SessionSnapshot, TranscriptProgress } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NotImplementedError } from "../src/errors.ts";
import type {
	CreateSessionOptions,
	MaybePromise,
	PiFreeCommand,
	PiServer,
	PiServerService,
	PiSessionRuntime,
	PiSessionRuntimeCommand,
	PiSessionRuntimeEvent,
	PiSessionRuntimeResult,
	PiSessionRuntimeSnapshot,
} from "../src/index.ts";
import {
	connectUnixTestClient,
	Deferred,
	type ProtocolTestClient,
	TEST_MODEL,
	TestServerService,
	TestSessionRuntime,
} from "../src/testing/index.ts";
import { createUnixServer, type UnixServerOptions } from "../src/transports/unix/index.ts";

const MODEL = TEST_MODEL;
type Client = ProtocolTestClient;
class MemoryService extends TestServerService {}

class OrderedSnapshotService extends MemoryService {
	readonly firstStarted = new Deferred<void>();
	readonly secondStarted = new Deferred<void>();
	readonly firstRelease = new Deferred<void>();
	readonly secondRelease = new Deferred<void>();
	controlled = false;
	startedCount = 0;

	override async listModels(): Promise<ModelMetadata[]> {
		if (!this.controlled) return super.listModels();
		this.startedCount += 1;
		if (this.startedCount === 1) {
			this.firstStarted.resolve(undefined);
			await this.firstRelease.promise;
		} else if (this.startedCount === 2) {
			this.secondStarted.resolve(undefined);
			await this.secondRelease.promise;
		}
		return [MODEL];
	}
}

const servers = new Set<PiServer>();
const clients = new Set<Client>();
const tempDirectories = new Set<string>();

async function startServer<S extends PiServerService = MemoryService>(
	service: S = new MemoryService() as unknown as S,
	options: Partial<UnixServerOptions> = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pst-"));
	tempDirectories.add(directory);
	const server = createUnixServer(service, {
		path: join(directory, "server.sock"),
		...options,
	});
	servers.add(server);
	await server.start();
	return { server, service };
}

async function connect(server: PiServer): Promise<Client> {
	const client = await connectUnixTestClient(server.addresses[0]!);
	clients.add(client);
	return client;
}

async function attach(
	client: Client,
	sessionId: string,
	leaseMode: "exclusive" | "shared" = "exclusive",
): Promise<SessionSnapshot> {
	const response = await client.request({ command: "attach", sessionId, leaseMode });
	if (!response.ok || response.result.command !== "attach") throw new Error("Attach failed");
	return response.result.session;
}

function text(content: string) {
	return [{ type: "text" as const, text: content }];
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...tempDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	tempDirectories.clear();
});

describe("PiServer Unix integration", () => {
	test("serializes server snapshot revisions", async () => {
		const service = new OrderedSnapshotService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		service.controlled = true;
		const messageIndex = client.messages.length;

		const firstCreate = client.request({ command: "create", leaseMode: "exclusive", name: "first" });
		await service.firstStarted.promise;
		const secondCreate = client.request({ command: "create", leaseMode: "exclusive", name: "second" });
		await Promise.resolve();
		expect(service.startedCount).toBe(1);

		service.firstRelease.resolve(undefined);
		await service.secondStarted.promise;
		service.secondRelease.resolve(undefined);
		await Promise.all([firstCreate, secondCreate]);
		await client.nextFrom(
			messageIndex,
			(message) =>
				message.type === "event" &&
				message.event.type === "server_snapshot" &&
				message.event.snapshot.revision === 2,
		);

		const revisions = client.messages
			.slice(messageIndex)
			.flatMap((message) =>
				message.type === "event" && message.event.type === "server_snapshot"
					? [message.event.snapshot.revision]
					: [],
			);
		expect(revisions).toEqual([1, 2]);
	});

	test("creates server-assigned durable IDs and supports list, attach, and detach", async () => {
		const { server, service } = await startServer();
		const client = await connect(server);
		await client.hello();
		const created = await client.request({
			command: "create",
			leaseMode: "exclusive",
			cwd: "/work",
			name: "Created",
		});
		expect(created.ok).toBe(true);
		if (!created.ok || created.result.command !== "create") throw new Error("Create failed");
		const createdId = created.result.session.id;
		expect(created.result.session).toMatchObject({
			id: service.lastCreatedId,
			cwd: "/work",
			name: "Created",
			attached: true,
			locked: true,
			lease: { mode: "exclusive", exclusiveControllerConnected: true, observerCount: 0 },
		});

		const listed = await client.request({ command: "list" });
		if (!listed.ok || listed.result.command !== "list") throw new Error("List failed");
		expect(listed.result.sessions).toEqual([
			{
				id: service.lastCreatedId,
				createdAt: 1,
				updatedAt: 1,
				sessionName: "Created",
				cwd: "/work",
			},
		]);
		const detached = await client.request({ command: "detach", sessionId: createdId });
		expect(detached).toMatchObject({ ok: true, result: { command: "detach", sessionId: createdId } });
		expect(service.latestRuntime(createdId).disposeCount).toBe(1);
		const detachedAgain = await client.request({ command: "detach", sessionId: createdId });
		expect(detachedAgain).toMatchObject({ ok: true, result: { command: "detach", sessionId: createdId } });

		const attached = await attach(client, createdId);
		expect(attached.id).toBe(service.lastCreatedId);
		expect(attached.lease.mode).toBe("exclusive");
		expect(service.runtimes.get(createdId)?.length).toBe(2);
	});

	test("preserves backend metadata while refreshing live session metadata", async () => {
		class ExtendedMetadataService extends MemoryService {
			override async listSessions() {
				return (await super.listSessions()).map((metadata) => ({
					...metadata,
					parentSessionId: "parent-1",
					sessionName: "stale name",
				}));
			}
		}
		const service = new ExtendedMetadataService();
		service.seed("session-1", "Live name");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");

		const listed = await client.request({ command: "list" });
		if (!listed.ok || listed.result.command !== "list") throw new Error("List failed");
		expect(listed.result.sessions).toEqual([
			{
				id: "session-1",
				createdAt: 1,
				updatedAt: 1,
				parentSessionId: "parent-1",
				sessionName: "Live name",
				cwd: "/tmp/pi-server-conformance",
			},
		]);
	});

	test("keeps multiple attachments on one connection independent", async () => {
		const service = new MemoryService();
		service.seed("first");
		service.seed("second");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "first");
		await attach(client, "second");

		await client.request({ command: "detach", sessionId: "first" });
		expect(service.latestRuntime("first").disposeCount).toBe(1);
		expect(service.latestRuntime("second").disposeCount).toBe(0);
		const response = await client.request({
			command: "set_thinking",
			sessionId: "second",
			thinkingLevel: "medium",
		});
		expect(response).toMatchObject({ ok: true, result: { session: { id: "second", thinkingLevel: "medium" } } });
	});

	test("broadcasts full snapshots and cursor-bearing progress only to attached clients", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const attachedClient = await connect(server);
		const unattachedClient = await connect(server);
		await attachedClient.hello();
		await unattachedClient.hello();
		await attach(attachedClient, "session-1");
		const runtime = service.latestRuntime("session-1");
		const progress: TranscriptProgress = {
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "hello",
		};
		runtime.emitProgress(progress);
		const progressMessage = await attachedClient.next(
			(message) => message.type === "event" && message.event.type === "session_progress",
		);
		expect(progressMessage).toEqual({
			type: "event",
			event: { type: "session_progress", eventCursor: 1, sessionId: "session-1", progress },
		});
		expect(
			unattachedClient.messages.some(
				(message) => message.type === "event" && message.event.type === "session_progress",
			),
		).toBe(false);

		const messageCount = attachedClient.messages.length;
		runtime.emitSnapshot();
		const snapshotMessage = await attachedClient.nextFrom(
			messageCount,
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.revision === runtime.snapshot().revision,
		);
		expect(snapshotMessage).toMatchObject({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: { id: "session-1", attached: true, locked: true, eventCursor: 1 },
			},
		});
		expect(
			unattachedClient.messages.some(
				(message) => message.type === "event" && message.event.type === "session_snapshot",
			),
		).toBe(false);
	});

	test("enforces at most one exclusive controller and unlimited shared observers", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const controller = await connect(server);
		const observer = await connect(server);
		const secondController = await connect(server);
		await controller.hello();
		await observer.hello();
		await secondController.hello();

		await attach(controller, "session-1", "exclusive");
		await attach(observer, "session-1", "shared");
		const conflict = await secondController.request({
			command: "attach",
			sessionId: "session-1",
			leaseMode: "exclusive",
		});
		expect(conflict).toMatchObject({ ok: false, error: { code: "session_locked" } });

		// The shared observer's snapshot reports itself as a non-controller observer.
		const observerSnapshot = await observer.request({ command: "resync", sessionId: "session-1" });
		if (!observerSnapshot.ok || observerSnapshot.result.command !== "resync") throw new Error("resync failed");
		expect(observerSnapshot.result.session.lease).toEqual({
			exclusiveControllerConnected: true,
			observerCount: 1,
			mode: "shared",
		});
	});

	test("rejects mutation from shared observers with unauthorized", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const controller = await connect(server);
		const observer = await connect(server);
		await controller.hello();
		await observer.hello();
		await attach(controller, "session-1", "exclusive");
		await attach(observer, "session-1", "shared");

		for (const command of [
			{ command: "prompt" as const, sessionId: "session-1", content: text("hi") },
			{ command: "steer" as const, sessionId: "session-1", content: text("hi") },
			{ command: "abort" as const, sessionId: "session-1" },
			{ command: "set_model" as const, sessionId: "session-1", model: { provider: "test", id: "large" } },
			{ command: "set_thinking" as const, sessionId: "session-1", thinkingLevel: "high" as const },
		]) {
			expect(await observer.request(command)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
		}

		// The controller still mutates successfully.
		expect(
			await controller.request({ command: "set_thinking", sessionId: "session-1", thinkingLevel: "high" }),
		).toMatchObject({ ok: true, result: { session: { thinkingLevel: "high" } } });

		// A shared observer may still read via resync.
		const resync = await observer.request({ command: "resync", sessionId: "session-1" });
		expect(resync).toMatchObject({ ok: true, result: { command: "resync" } });
	});

	test("releases an exclusive lease on disconnect so another client can take over", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const first = await connect(server);
		await first.hello();
		await attach(first, "session-1", "exclusive");
		await first.close();

		const second = await connect(server);
		await second.hello();
		const attached = await attach(second, "session-1", "exclusive");
		expect(attached.lease).toEqual({ exclusiveControllerConnected: true, observerCount: 0, mode: "exclusive" });
	});

	test("allocates a monotonic cursor that is preserved across idle runtime reopen", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1", "exclusive");

		const runtime = service.latestRuntime("session-1");
		runtime.emitProgress({
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "a",
		});
		runtime.emitProgress({
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "b",
		});
		await client.next(
			(message) =>
				message.type === "event" && message.event.type === "session_progress" && message.event.eventCursor === 2,
		);

		// Detach -> idle runtime disposes -> reattach reopens a fresh runtime that
		// must resume the cursor at 2 rather than resetting to 0.
		await client.request({ command: "detach", sessionId: "session-1" });
		await service.latestRuntime("session-1").disposed.promise;
		const reopened = await attach(client, "session-1", "exclusive");
		expect(reopened.eventCursor).toBe(2);
	});

	test("returns a correlated authoritative snapshot from resync", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1", "exclusive");

		const resync = await client.request({ command: "resync", sessionId: "session-1" });
		if (!resync.ok || resync.result.command !== "resync") throw new Error("resync failed");
		expect(resync.result.session).toMatchObject({
			id: "session-1",
			attached: true,
			locked: true,
			lease: { mode: "exclusive" },
		});
	});

	test("returns sanitized not_implemented for typed but unimplemented commands", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1", "exclusive");

		for (const command of [
			{ command: "follow_up" as const, sessionId: "session-1", content: text("hi") },
			{ command: "clear_queue" as const, sessionId: "session-1" },
			{ command: "set_queue_mode" as const, sessionId: "session-1", queue: "steer" as const, mode: "all" as const },
			{ command: "get_tree" as const, sessionId: "session-1" },
		]) {
			expect(await client.request(command)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
		}
	});

	test("routes free commands to the service hook without any session lease", async () => {
		class FreeCommandService extends MemoryService {
			readonly calls: string[] = [];
			async executeFreeCommand<const TCommand extends PiFreeCommand>(
				command: TCommand,
			): Promise<ResultForCommand<TCommand>> {
				this.calls.push(command.command);
				if (command.command === "get_settings") {
					return { command: "get_settings", settings: { theme: "dark" } } as ResultForCommand<TCommand>;
				}
				if (command.command === "logout") {
					return { command: "logout", provider: "anthropic" } as ResultForCommand<TCommand>;
				}
				throw new NotImplementedError();
			}
		}
		const service = new FreeCommandService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();

		// No attach at all: free commands are dispatched without a session lease.
		const settings = await client.request({ command: "get_settings" });
		expect(settings).toMatchObject({ ok: true, result: { command: "get_settings", settings: { theme: "dark" } } });
		const logout = await client.request({ command: "logout", provider: "anthropic" });
		expect(logout).toMatchObject({ ok: true, result: { command: "logout", provider: "anthropic" } });
		expect(service.calls).toEqual(["get_settings", "logout"]);

		// Unserviced free commands fail closed through the same hook.
		expect(await client.request({ command: "set_setting", key: "k", value: 1 })).toMatchObject({
			ok: false,
			error: { code: "not_implemented" },
		});
	});

	test("free commands fail closed when the service has no hook, and import_session stays unimplemented", async () => {
		const service = new MemoryService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();

		expect(await client.request({ command: "get_settings" })).toMatchObject({
			ok: false,
			error: { code: "not_implemented" },
		});
		expect(
			await client.request({
				command: "import_session",
				blob: { id: "blob-1", token: "token-1", size: 42 },
			}),
		).toMatchObject({ ok: false, error: { code: "not_implemented" } });
	});

	test("import_session acquires + exclusively attaches the imported session and projects its snapshot", async () => {
		class ImportService extends MemoryService {
			readonly importedBlobs: Array<{ id: string; token: string }> = [];
			override seed(id = "session-1"): void {
				super.seed(id, `Imported ${id}`, "/tmp/imported");
			}
			async importSession(blob: { id: string; token: string }): Promise<{ sessionId: string }> {
				this.importedBlobs.push(blob);
				return { sessionId: "imported-1" };
			}
		}
		const service = new ImportService();
		service.seed("imported-1");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();

		// No prior attach: import_session is a free command that creates a new
		// session owned by the requester (exclusive lease).
		const response = await client.request({
			command: "import_session",
			blob: { id: "blob-1", token: "token-1", size: 42 },
		});
		expect(response.ok).toBe(true);
		if (!response.ok || response.result.command !== "import_session") throw new Error("import_session failed");

		// The hook received the staged blob reference (never fabricated a snapshot).
		expect(service.importedBlobs).toEqual([{ id: "blob-1", token: "token-1", size: 42 }]);

		// The result carries the server-projected snapshot of the acquired session.
		expect(response.result.session).toMatchObject({
			id: "imported-1",
			name: "Imported imported-1",
			cwd: "/tmp/imported",
			attached: true,
			locked: true,
			lease: { mode: "exclusive", exclusiveControllerConnected: true, observerCount: 0 },
		});

		// The connection now holds the exclusive lease (import = new session owned by requester).
		const importedRuntime = service.latestRuntime("imported-1");
		expect(importedRuntime).toBeDefined();
	});

	test("re-keys the live session when a mutation replaces the durable session id", async () => {
		const modelRef = { provider: TEST_MODEL.provider, id: TEST_MODEL.id };
		class ReplacingRuntime implements PiSessionRuntime {
			private snap: PiSessionRuntimeSnapshot;
			constructor(id: string) {
				this.snap = {
					id,
					name: "session-1",
					cwd: "/tmp/pi-server-conformance",
					createdAt: 1,
					updatedAt: 1,
					phase: "idle",
					model: modelRef,
					scopedModels: [modelRef],
					thinkingLevel: "off",
					revision: 0,
					transcript: [],
					queuedSteer: [],
					queuedSteerCount: 0,
					queuedFollowUp: [],
					queuedFollowUpCount: 0,
					steeringMode: "all",
					followUpMode: "all",
					surface: {},
					pendingInteractions: [],
				};
			}
			private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
			snapshot(): PiSessionRuntimeSnapshot {
				return structuredClone(this.snap);
			}
			getPhase() {
				return this.snap.phase;
			}
			async prompt(): Promise<void> {
				throw new NotImplementedError();
			}
			async steer(): Promise<void> {
				throw new NotImplementedError();
			}
			async abort(): Promise<void> {
				throw new NotImplementedError();
			}
			async setModel(): Promise<void> {
				throw new NotImplementedError();
			}
			async setThinking(): Promise<void> {
				throw new NotImplementedError();
			}
			executeCommand<const TCommand extends PiSessionRuntimeCommand>(
				command: TCommand,
			): MaybePromise<PiSessionRuntimeResult<TCommand>> {
				if (command.command === "set_name") {
					// Stand-in for fork/clone: the durable session id changes mid-mutation.
					this.snap = { ...this.snap, id: "session-2", revision: this.snap.revision + 1, updatedAt: 2 };
					for (const listener of this.listeners) listener({ type: "snapshot" });
					return { command: "set_name" } as PiSessionRuntimeResult<TCommand>;
				}
				throw new NotImplementedError();
			}
			subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			async dispose(): Promise<void> {}
		}
		class ReplacingService implements PiServerService {
			readonly created: ReplacingRuntime[] = [];
			async listSessions() {
				return [];
			}
			async listModels() {
				return [TEST_MODEL];
			}
			async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
				const runtime = new ReplacingRuntime(options.id);
				this.created.push(runtime);
				return runtime;
			}
			async openSession(sessionId: string): Promise<PiSessionRuntime> {
				return new ReplacingRuntime(sessionId);
			}
		}
		const service = new ReplacingService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();

		const created = await client.request({ command: "create", leaseMode: "exclusive" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = (created.result as { session: { id: string } }).session.id;

		const renamed = await client.request({ command: "set_name", sessionId, name: "irrelevant" });
		expect(renamed.ok).toBe(true);
		if (renamed.ok) {
			expect(renamed.result).toMatchObject({
				command: "set_name",
				session: { id: "session-2", lease: { mode: "exclusive" } },
			});
		}

		// The lease moved with the live session: the new id is attached/exclusive.
		const resynced = await client.request({ command: "resync", sessionId: "session-2" });
		expect(resynced.ok).toBe(true);
		if (resynced.ok) {
			expect(resynced.result).toMatchObject({ session: { id: "session-2", lease: { mode: "exclusive" } } });
		}
		// The previous id no longer resolves for this connection.
		expect(await client.request({ command: "resync", sessionId })).toMatchObject({ ok: false });
		// The old durable session can still be attached fresh.
		const reattached = await client.request({ command: "attach", sessionId, leaseMode: "shared" });
		expect(reattached.ok).toBe(true);
		if (reattached.ok) {
			expect(reattached.result).toMatchObject({ session: { id: sessionId } });
		}
	});

	test("allows only the exclusive controller to mutate a singleton live runtime", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const first = await connect(server);
		const second = await connect(server);
		await first.hello();
		await second.hello();
		await attach(first, "session-1", "exclusive");

		const secondList = await second.request({ command: "list" });
		if (!secondList.ok || secondList.result.command !== "list") throw new Error("List failed");
		expect(secondList.result.sessions).toEqual([
			{
				id: "session-1",
				createdAt: 1,
				updatedAt: 1,
				sessionName: "Session session-1",
				cwd: "/tmp/pi-server-conformance",
			},
		]);
		await attach(second, "session-1", "shared");

		const modelResponse = await first.request({
			command: "set_model",
			sessionId: "session-1",
			model: { provider: "test", id: "large" },
		});
		expect(modelResponse).toMatchObject({ ok: true, result: { session: { model: { id: "large" } } } });
		await second.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.model.id === "large",
		);
		const thinkingResponse = await first.request({
			command: "set_thinking",
			sessionId: "session-1",
			thinkingLevel: "high",
		});
		expect(thinkingResponse).toMatchObject({ ok: true, result: { session: { thinkingLevel: "high" } } });
	});

	test("does not queue prompts and processes steer and abort while a prompt response is pending", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");

		const prompt = client.request({ command: "prompt", sessionId: "session-1", content: text("first") });
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const busy = await client.request({ command: "prompt", sessionId: "session-1", content: text("second") });
		expect(busy).toMatchObject({ ok: false, error: { code: "busy" } });

		const steer = await client.request({ command: "steer", sessionId: "session-1", content: text("adjust") });
		expect(steer).toMatchObject({ ok: true, result: { command: "steer" } });
		expect(service.latestRuntime("session-1").steers).toEqual([{ content: text("adjust") }]);
		const abort = await client.request({ command: "abort", sessionId: "session-1" });
		expect(abort).toMatchObject({ ok: true, result: { command: "abort" } });
		expect(await prompt).toMatchObject({ ok: true, result: { command: "prompt", session: { phase: "idle" } } });
	});

	test("returns operation attachment state relative to the requesting connection", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const first = await connect(server);
		const second = await connect(server);
		await first.hello();
		await second.hello();
		await attach(first, "session-1", "exclusive");
		await attach(second, "session-1", "shared");

		const prompt = first.request({ command: "prompt", sessionId: "session-1", content: text("hello") });
		await first.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		await first.request({ command: "detach", sessionId: "session-1" });
		service.latestRuntime("session-1").finishPrompt();

		expect(await prompt).toMatchObject({
			ok: true,
			result: { command: "prompt", session: { id: "session-1", attached: false } },
		});
	});

	test("keeps busy work alive after disconnect and disposes when it next becomes idle", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1");
		const prompt = client.request({ command: "prompt", sessionId: "session-1", content: text("survive") });
		await client.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.phase === "turn",
		);
		const runtime = service.latestRuntime("session-1");
		await client.close();
		await expect(prompt).rejects.toThrow(Error);
		expect(runtime.disposeCount).toBe(0);
		runtime.finishPrompt();
		await runtime.disposed.promise;
		expect(runtime.disposeCount).toBe(1);

		const reconnect = await connect(server);
		await reconnect.hello();
		const snapshot = await attach(reconnect, "session-1");
		expect(snapshot.transcript).toHaveLength(2);
		expect(snapshot.transcript[1]).toMatchObject({ role: "assistant", content: [{ text: "reply:survive" }] });
	});

	test("restores persisted sessions lazily after a server restart", async () => {
		const service = new MemoryService();
		service.seed();
		const { server: firstServer } = await startServer(service);
		const firstClient = await connect(firstServer);
		await firstClient.hello();
		await attach(firstClient, "session-1");
		await firstClient.request({ command: "set_thinking", sessionId: "session-1", thinkingLevel: "high" });
		await firstClient.close();
		await firstServer.close();

		const { server: secondServer } = await startServer(service);
		expect(service.runtimes.get("session-1")).toHaveLength(1);
		const secondClient = await connect(secondServer);
		await secondClient.hello();
		const restored = await attach(secondClient, "session-1");
		expect(restored.thinkingLevel).toBe("high");
		expect(service.runtimes.get("session-1")).toHaveLength(2);
	});

	test("rejects and disposes a service runtime with the wrong server-assigned ID", async () => {
		class WrongIdService extends MemoryService {
			override async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
				return super.createSession({ ...options, id: "wrong-id" });
			}
		}
		const service = new WrongIdService();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		const response = await client.request({ command: "create", leaseMode: "exclusive" });
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(service.latestRuntime("wrong-id").disposeCount).toBe(1);
	});

	test("maps service lock errors and rejects control from unattached clients", async () => {
		const service = new MemoryService();
		service.seed("locked");
		service.locked.add("locked");
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		const locked = await client.request({ command: "attach", sessionId: "locked", leaseMode: "shared" });
		expect(locked).toMatchObject({ ok: false, error: { code: "session_locked" } });
		const unattached = await client.request({ command: "abort", sessionId: "locked" });
		expect(unattached).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});
});

describe("PiServer session command classification", () => {
	test("shared observers may read but every non-read commands fails unauthorized", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const controller = await connect(server);
		const observer = await connect(server);
		await controller.hello();
		await observer.hello();
		await attach(controller, "session-1", "exclusive");
		await attach(observer, "session-1", "shared");

		// Shared observers reach the runtime for true reads (which is not_implemented
		// here), rather than being rejected authoritatively.
		for (const command of [
			{ command: "get_tree" as const, sessionId: "session-1" },
			{ command: "get_session_stats" as const, sessionId: "session-1" },
			{ command: "get_review_state" as const, sessionId: "session-1" },
			{ command: "get_available_models" as const, sessionId: "session-1" },
			{ command: "get_available_thinking_levels" as const, sessionId: "session-1" },
			{ command: "get_todos" as const, sessionId: "session-1" },
			{ command: "list_tasks" as const, sessionId: "session-1" },
			{ command: "get_task_output" as const, sessionId: "session-1", taskId: "task-1" },
			{ command: "ssh_status" as const, sessionId: "session-1" },
			{ command: "get_subagents" as const, sessionId: "session-1" },
		]) {
			expect(await observer.request(command)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
		}

		// Unclassified/mutation commands are rejected authoritatively.
		for (const command of [
			{ command: "set_name" as const, sessionId: "session-1", name: "N" },
			{
				command: "respond_interaction" as const,
				sessionId: "session-1",
				interactionId: "i1",
				result: { method: "confirm" as const, kind: "value" as const, value: true },
			},
		]) {
			expect(await observer.request(command)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
		}
	});

	test("holds the runtime open while an executeCommand read is in flight", async () => {
		class DeferredReadRuntime extends TestSessionRuntime {
			readonly readStarted = new Deferred<void>();
			readonly readRelease = new Deferred<void>();

			override async executeCommand<const TCommand extends PiSessionRuntimeCommand>(
				command: TCommand,
			): Promise<PiSessionRuntimeResult<TCommand>> {
				if (command.command !== "get_tree") throw new Error(`Unexpected command ${command.command}`);
				this.readStarted.resolve(undefined);
				await this.readRelease.promise;
				return { command: "get_tree", tree: [], leafId: null } as unknown as PiSessionRuntimeResult<TCommand>;
			}
		}

		class DeferredReadService extends TestServerService {
			override async openSession(sessionId: string): Promise<PiSessionRuntime> {
				const stored = this.sessions.get(sessionId);
				if (!stored) throw new Error(`Unknown session ${sessionId}`);
				this.locked.add(sessionId);
				const runtime = new DeferredReadRuntime(stored, () => this.locked.delete(sessionId));
				const runtimes = this.runtimes.get(sessionId) ?? [];
				runtimes.push(runtime);
				this.runtimes.set(sessionId, runtimes);
				return runtime;
			}
		}

		const service = new DeferredReadService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1", "shared");
		const runtime = service.latestRuntime("session-1") as DeferredReadRuntime;

		const read = client.request({ command: "get_tree", sessionId: "session-1" });
		await runtime.readStarted.promise;
		await client.request({ command: "detach", sessionId: "session-1" });
		expect(runtime.disposeCount).toBe(0);

		runtime.readRelease.resolve(undefined);
		expect(await read).toMatchObject({ ok: true, result: { command: "get_tree", tree: [] } });
		await runtime.disposed.promise;
		expect(runtime.disposeCount).toBe(1);
	});

	test("disposes a detached runtime when an unsolicited snapshot reports it idle", async () => {
		const service = new MemoryService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1", "exclusive");
		const runtime = service.latestRuntime("session-1");
		runtime.setPhase("turn");

		await client.request({ command: "detach", sessionId: "session-1" });
		expect(runtime.disposeCount).toBe(0);
		runtime.setPhase("idle");
		runtime.emitSnapshot();
		await runtime.disposed.promise;
		expect(runtime.disposeCount).toBe(1);
	});

	test("executeCommand mutations run under the exclusive lease and broadcast a server-projected snapshot", async () => {
		class CommandRuntime extends TestSessionRuntime {
			override executeCommand<const TCommand extends PiSessionRuntimeCommand>(
				command: TCommand,
			): PiSessionRuntimeResult<TCommand> {
				if (command.command === "set_name") {
					this.setName(command.name);
					// The mapped runtime result omits the server-owned `session`, so a
					// runtime never fabricates attached/locked/lease/eventCursor.
					return { command: "set_name" } as PiSessionRuntimeResult<TCommand>;
				}
				if (command.command === "get_tree") {
					return { command: "get_tree", tree: [], leafId: null } as unknown as PiSessionRuntimeResult<TCommand>;
				}
				throw new Error(`Unexpected command ${command.command}`);
			}
		}

		class CommandService extends TestServerService {
			override async openSession(sessionId: string): Promise<PiSessionRuntime> {
				if (this.locked.has(sessionId)) throw new Error("locked");
				const stored = this.sessions.get(sessionId);
				if (!stored) throw new Error(`Unknown session ${sessionId}`);
				this.locked.add(sessionId);
				const runtime = new CommandRuntime(stored, () => this.locked.delete(sessionId));
				const runtimes = this.runtimes.get(sessionId) ?? [];
				runtimes.push(runtime);
				this.runtimes.set(sessionId, runtimes);
				return runtime;
			}
		}

		const service = new CommandService();
		service.seed();
		const { server } = await startServer(service);
		const controller = await connect(server);
		const observer = await connect(server);
		await controller.hello();
		await observer.hello();
		await attach(controller, "session-1", "exclusive");
		await attach(observer, "session-1", "shared");

		// A read returns typed runtime data (no fabricated session).
		const read = await controller.request({ command: "get_tree", sessionId: "session-1" });
		expect(read).toMatchObject({
			ok: true,
			result: { command: "get_tree", tree: [], leafId: null },
		});

		// A mutation broadcasts a normalized authoritative snapshot and its
		// response carries the server-projected session.
		const observerSnapshot = observer.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.name === "Renamed",
		);
		const rename = await controller.request({ command: "set_name", sessionId: "session-1", name: "Renamed" });
		expect(rename).toMatchObject({
			ok: true,
			result: {
				command: "set_name",
				session: { name: "Renamed", attached: true, locked: true, lease: { mode: "exclusive" } },
			},
		});
		const event = await observerSnapshot;
		expect(event).toMatchObject({
			type: "event",
			event: { type: "session_snapshot", snapshot: { name: "Renamed", lease: { mode: "shared" } } },
		});
	});

	test("snapshot captures its watermark before awaiting a slow runtime snapshot (no false cursor)", async () => {
		class DeferredSnapshotRuntime implements PiSessionRuntime {
			deferNext = false;
			readonly pendingSnapshots: Deferred<void>[] = [];
			private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
			private readonly snapshotState: PiSessionRuntimeSnapshot = {
				id: "session-1",
				name: "Session session-1",
				cwd: "/tmp/pi-server-conformance",
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model: { provider: TEST_MODEL.provider, id: TEST_MODEL.id },
				scopedModels: [{ provider: TEST_MODEL.provider, id: TEST_MODEL.id }],
				thinkingLevel: "off",
				revision: 0,
				transcript: [],
				queuedSteer: [],
				queuedSteerCount: 0,
				queuedFollowUp: [],
				queuedFollowUpCount: 0,
				steeringMode: "all",
				followUpMode: "all",
				surface: {},
				pendingInteractions: [],
			};
			async snapshot(): Promise<PiSessionRuntimeSnapshot> {
				if (this.deferNext) {
					this.deferNext = false;
					const gate = new Deferred<void>();
					this.pendingSnapshots.push(gate);
					await gate.promise;
				}
				return structuredClone(this.snapshotState);
			}
			getPhase() {
				return "idle" as const;
			}
			async prompt(): Promise<void> {}
			async steer(): Promise<void> {}
			async abort(): Promise<void> {}
			async setModel(): Promise<void> {}
			async setThinking(): Promise<void> {}
			subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			async dispose(): Promise<void> {}
			emitProgress(progress: TranscriptProgress): void {
				for (const listener of this.listeners) listener({ type: "progress", progress });
			}
		}
		class DeferredSnapshotService extends TestServerService {
			readonly runtime = new DeferredSnapshotRuntime();
			override async openSession(sessionId: string): Promise<PiSessionRuntime> {
				if (!this.sessions.has(sessionId)) throw new Error(`Unknown session ${sessionId}`);
				return this.runtime;
			}
		}

		const service = new DeferredSnapshotService();
		service.seed();
		const { server } = await startServer(service);
		const client = await connect(server);
		await client.hello();
		await attach(client, "session-1", "exclusive");
		const runtime = service.runtime;

		// First progress event allocates cursor 1 and sends it.
		runtime.emitProgress({
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "a",
		});
		const firstProg = await client.next((m) => m.type === "event" && m.event.type === "session_progress");
		expect(firstProg).toMatchObject({ event: { eventCursor: 1 } });

		// Begin a resync whose runtime snapshot is intentionally slow. The cursor
		// watermark (1) must be captured before the snapshot resolves.
		runtime.deferNext = true;
		const resync = client.request({ command: "resync", sessionId: "session-1" });
		await vi.waitFor(() => expect(runtime.pendingSnapshots.length).toBe(1));
		// A second progress event is emitted while the snapshot is still pending;
		// it must be ordered AFTER the pending snapshot capture, not folded into it.
		runtime.emitProgress({
			type: "assistant_delta",
			messageId: "assistant-1",
			contentIndex: 0,
			kind: "text",
			delta: "b",
		});
		runtime.pendingSnapshots[0]!.resolve(undefined);

		const response = await resync;
		expect(response).toMatchObject({ ok: true, result: { command: "resync", session: { eventCursor: 1 } } });
		// The second progress event arrives afterward with cursor 2.
		const secondProg = await client.next(
			(m) => m.type === "event" && m.event.type === "session_progress" && m.event.eventCursor === 2,
		);
		expect(secondProg).toMatchObject({ event: { eventCursor: 2 } });
	});
});
