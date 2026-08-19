import { randomUUID } from "node:crypto";
import {
	type Command,
	commandLeaseRole,
	type EventEnvelope,
	type LeaseMode,
	type ResultForCommand,
	type ServerEvent,
	type SessionMetadata,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import type { ByteConnection, ConnectionState } from "./connection.ts";
import { InternalServerError, NotImplementedError, PiServerError } from "./errors.ts";
import type {
	CreateSessionOptions,
	MaybePromise,
	PiFreeCommand,
	PiServerService,
	PiSessionRuntime,
	PiSessionRuntimeCommand,
	PiSessionRuntimeEvent,
} from "./types.ts";

/**
 * Mutation commands whose wire result carries the server-projected `session`.
 * These are exactly the mutation results in `schemas.ts` that include a
 * `SessionSnapshot`; runtime results for them omit `session` and the server
 * injects the authoritative projection after the mutation.
 */
const SESSION_RESULT_COMMANDS = new Set<string>([
	"follow_up",
	"clear_queue",
	"set_queue_mode",
	"navigate_tree",
	"set_name",
	"fork",
	"clone",
	"compact",
	"set_auto_compaction",
	"abort_compaction",
	"respond_review",
	"cycle_model",
	"set_scoped_models",
	"cycle_thinking",
	"set_trust",
	"reload",
	"bash",
	"abort_bash",
	"kill_task",
]);

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

type CursorBearingSessionEvent = Extract<ServerEvent, { eventCursor: number; sessionId: string }>;

interface LiveSession {
	id: string;
	runtime: PiSessionRuntime;
	connections: Set<ConnectionState>;
	unsubscribe: () => void;
	operationCount: number;
	ready: boolean;
	terminal: boolean;
	/** Server-owned monotonic cursor over all runtime events for this session. */
	eventCursor: number;
	/** Serializes all per-session runtime events, cursor allocation, snapshot capture, and fan-out. */
	queue: Promise<void>;
	disposing?: Promise<void>;
}

interface LiveSessionManagerOptions {
	service: PiServerService;
	isClosing: () => boolean;
	sendMessage: (connection: ConnectionState, message: EventEnvelope) => Promise<boolean>;
	closeConnection: (connection: ByteConnection) => Promise<void>;
	disconnect: (connection: ConnectionState) => Promise<void>;
	broadcastServerSnapshot: () => void;
	reportError: (error: unknown) => void;
}

function toMetadata(snapshot: SessionSnapshot): SessionMetadata {
	return {
		id: snapshot.id,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		sessionName: snapshot.name,
		cwd: snapshot.cwd,
	};
}

function buildCursorEvent(sessionId: string, cursor: number, event: PiSessionRuntimeEvent): CursorBearingSessionEvent {
	if (event.type === "progress") {
		return { type: "session_progress", eventCursor: cursor, sessionId, progress: event.progress };
	}
	if (event.type === "surface") {
		return { type: "surface_update", eventCursor: cursor, sessionId, operation: event.operation };
	}
	if (event.type === "interaction") {
		return { type: "interaction_request", eventCursor: cursor, sessionId, request: event.request };
	}
	if (event.type === "queue") {
		return {
			type: "queue_update",
			eventCursor: cursor,
			sessionId,
			queue: event.queue,
			mode: event.mode,
			queuedCount: event.queuedCount,
		};
	}
	// `snapshot` and `error` are handled outside dispatch, never reaching here.
	throw new InternalServerError(`Unexpected runtime event type received cursor allocation`);
}

export class LiveSessionManager {
	private readonly options: LiveSessionManagerOptions;
	private readonly liveSessions = new Map<string, LiveSession>();
	private readonly openingSessions = new Map<string, Promise<LiveSession>>();
	private readonly sessionCursors = new Map<string, number>();

	constructor(options: LiveSessionManagerOptions) {
		this.options = options;
	}

	async executeCommand(connection: ConnectionState, command: Command): Promise<ResultForCommand<Command>> {
		switch (command.command) {
			case "list":
				return { command: "list" as const, sessions: await this.listMetadata() };
			case "create": {
				const id = randomUUID();
				const options: CreateSessionOptions = {
					id,
					cwd: command.cwd,
					name: command.name,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
				};
				const live = await this.acquire(id, () => this.options.service.createSession(options));
				await this.attach(connection, live, command.leaseMode);
				this.options.broadcastServerSnapshot();
				return {
					command: "create" as const,
					session: this.forConnection(await this.broadcastSnapshot(live), connection),
				};
			}
			case "attach": {
				const live = await this.acquire(command.sessionId, () =>
					this.options.service.openSession(command.sessionId),
				);
				await this.attach(connection, live, command.leaseMode);
				this.options.broadcastServerSnapshot();
				return {
					command: "attach" as const,
					session: this.forConnection(await this.broadcastSnapshot(live), connection),
				};
			}
			case "detach": {
				const live = this.liveSessions.get(command.sessionId);
				if (connection.sessionLeases.has(command.sessionId)) {
					this.releaseLease(connection, command.sessionId);
					if (live) {
						live.connections.delete(connection);
						if (live.connections.size > 0 && !live.terminal && !live.disposing) {
							await this.broadcastSnapshot(live);
						}
						await this.maybeDispose(live);
					}
					this.options.broadcastServerSnapshot();
				}
				return { command: "detach" as const, sessionId: command.sessionId };
			}
			case "resync": {
				const live = this.requireAttached(connection, command.sessionId);
				return {
					command: "resync" as const,
					session: this.forConnection(await this.captureSnapshot(live), connection),
				};
			}
			case "prompt": {
				const live = this.requireController(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.prompt({ content: command.content }),
				);
				return { command: "prompt" as const, session };
			}
			case "steer": {
				const live = this.requireController(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.steer({ content: command.content }),
				);
				return { command: "steer" as const, session };
			}
			case "abort": {
				const live = this.requireController(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.abort());
				return { command: "abort" as const, session };
			}
			case "set_model": {
				const live = this.requireController(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.setModel(command.model));
				return { command: "set_model" as const, session };
			}
			case "set_thinking": {
				const live = this.requireController(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.setThinking(command.thinkingLevel),
				);
				return { command: "set_thinking" as const, session };
			}
			default: {
				// Fail-closed: any session command not explicitly classified as a
				// shared read is a mutation requiring the exclusive controller.
				if (!("sessionId" in command)) {
					// `import_session` carries no sessionId but its result embeds a
					// session snapshot the server must project after acquiring the
					// imported session. It is a new durable session owned by the
					// requester (exclusive), so it follows the `create` flow.
					if (command.command === "import_session") {
						return this.executeImportSession(connection, command) as Promise<ResultForCommand<Command>>;
					}
					const hook = this.options.service.executeFreeCommand;
					if (!hook) throw new NotImplementedError();
					return hook.call(this.options.service, command as PiFreeCommand) as Promise<ResultForCommand<Command>>;
				}
				return this.executeRuntimeCommand(connection, command as PiSessionRuntimeCommand) as Promise<
					ResultForCommand<Command>
				>;
			}
		}
	}

	async disconnect(connection: ConnectionState): Promise<void> {
		const sessions = [...connection.sessionLeases.keys()]
			.map((id) => this.liveSessions.get(id))
			.filter((live): live is LiveSession => live !== undefined);
		connection.sessionLeases.clear();
		for (const live of sessions) live.connections.delete(connection);
		const results = await Promise.allSettled(sessions.map((live) => this.maybeDispose(live)));
		for (const result of results) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
	}

	async listMetadata(): Promise<SessionMetadata[]> {
		const stored = await this.options.service.listSessions();
		const liveSnapshots = await Promise.all(
			[...this.liveSessions.values()]
				.filter((live) => !live.disposing)
				.map(async (live) => [live.id, await this.normalizedSnapshot(live)] as const),
		);
		const liveById = new Map(liveSnapshots);
		const metadata = stored.map((item) => {
			const snapshot = liveById.get(item.id);
			if (!snapshot) return item;
			liveById.delete(item.id);
			return { ...item, ...toMetadata(snapshot) };
		});
		for (const snapshot of liveById.values()) metadata.push(toMetadata(snapshot));
		return metadata;
	}

	async close(): Promise<void> {
		this.sessionCursors.clear();
		const openingResults = await Promise.allSettled([...this.openingSessions.values()]);
		for (const result of openingResults) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
		const sessions = [...this.liveSessions.values()];
		this.liveSessions.clear();
		await Promise.all(
			sessions.map(async (live) => {
				if (live.disposing) {
					await live.disposing;
					return;
				}
				live.unsubscribe();
				await live.runtime.dispose();
			}),
		);
	}

	/**
	 * Implement `import_session`: materialize the imported durable session via the
	 * service hook, then acquire + exclusively attach it (mirroring `create` — an
	 * import creates a new session owned by the requester) and return the
	 * server-projected snapshot. The hook returns only a session id; the snapshot
	 * is projected here, never fabricated by the hook.
	 */
	private async executeImportSession(
		connection: ConnectionState,
		command: Extract<Command, { command: "import_session" }>,
	): Promise<{ command: "import_session"; session: SessionSnapshot }> {
		const importSession = this.options.service.importSession;
		if (!importSession) throw new NotImplementedError();
		const { sessionId } = await importSession.call(this.options.service, command.blob);
		const live = await this.acquire(sessionId, () => this.options.service.openSession(sessionId));
		await this.attach(connection, live, "exclusive");
		this.options.broadcastServerSnapshot();
		return {
			command: "import_session" as const,
			session: this.forConnection(await this.broadcastSnapshot(live), connection),
		};
	}

	private async executeRuntimeCommand<R extends PiSessionRuntimeCommand>(
		connection: ConnectionState,
		command: R,
	): Promise<ResultForCommand<R>> {
		const role = commandLeaseRole(command.command);
		let live: LiveSession;
		if (role === "read") live = this.requireAttached(connection, command.sessionId);
		else live = this.requireController(connection, command.sessionId);

		const runtime = live.runtime;
		const hook = runtime.executeCommand;
		if (!hook) throw new NotImplementedError();

		if (role === "read") {
			// Reads are safe under a shared lease, but still hold the runtime open
			// until the command completes so detach/disconnect cannot dispose it.
			return (await this.runRuntimeRead(live, () => hook.call(runtime, command))) as ResultForCommand<R>;
		}

		// Mutations run under the exclusive lease, broadcast the authoritative
		// snapshot, and inject the server-projected snapshot where the wire schema
		// carries `session`.
		const { result, session } = await this.runExclusiveMutation(connection, live, () => hook.call(runtime, command));
		if (SESSION_RESULT_COMMANDS.has(command.command)) {
			return { ...result, session } as ResultForCommand<R>;
		}
		return result as ResultForCommand<R>;
	}

	/** Holds the live runtime open while a read command is in flight. */
	private async runRuntimeRead<T>(live: LiveSession, operation: () => MaybePromise<T>): Promise<T> {
		live.operationCount += 1;
		try {
			return await operation();
		} finally {
			live.operationCount -= 1;
			this.scheduleMaybeDispose(live);
		}
	}

	/**
	 * Runs `operation` under an exclusive lease, broadcasting the resulting
	 * authoritative snapshot to every observer and returning both the operation
	 * result and the server-projectable snapshot.
	 */
	private async runExclusiveMutation<T>(
		connection: ConnectionState,
		live: LiveSession,
		operation: () => MaybePromise<T>,
	): Promise<{ result: T; snapshot: SessionSnapshot; session: SessionSnapshot }> {
		live.operationCount += 1;
		try {
			const result = await operation();
			const snapshot = await this.broadcastSnapshot(live);
			const session = this.forConnection(snapshot, connection);
			return { result, snapshot, session };
		} finally {
			live.operationCount -= 1;
			this.scheduleMaybeDispose(live);
		}
	}

	/**
	 * Runs a void mutation under the exclusive lease, returning only the
	 * server-projected snapshot.
	 */
	private async runOperation(
		connection: ConnectionState,
		live: LiveSession,
		operation: () => Promise<void>,
	): Promise<SessionSnapshot> {
		return (await this.runExclusiveMutation(connection, live, operation)).session;
	}

	private async acquire(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		for (;;) {
			const existing = this.liveSessions.get(id);
			if (existing) {
				if (existing.terminal) throw new PiServerError("session_locked", `Session runtime is terminating: ${id}`);
				if (existing.disposing) {
					await existing.disposing;
					continue;
				}
				return existing;
			}
			const opening = this.openingSessions.get(id);
			if (opening) return opening;
			const pending = this.create(id, acquireRuntime);
			this.openingSessions.set(id, pending);
			try {
				return await pending;
			} finally {
				if (this.openingSessions.get(id) === pending) this.openingSessions.delete(id);
			}
		}
	}

	private async create(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		const runtime = await acquireRuntime();
		if (this.options.isClosing()) {
			await runtime.dispose();
			throw new Error("PiServer closed while acquiring a session runtime");
		}
		let live: LiveSession | undefined;
		try {
			const snapshot = await runtime.snapshot();
			if (snapshot.id !== id) {
				throw new PiServerError(
					"invalid_request",
					`Service returned session ${snapshot.id} for server-assigned session ${id}`,
				);
			}
			live = {
				id,
				runtime,
				connections: new Set(),
				unsubscribe: () => {},
				operationCount: 0,
				ready: false,
				terminal: false,
				eventCursor: this.sessionCursors.get(id) ?? 0,
				queue: Promise.resolve(),
			};
			live.unsubscribe = runtime.subscribe((event) => this.handleRuntimeEvent(live!, event));
			this.liveSessions.set(id, live);
			live.ready = true;
			return live;
		} catch (error) {
			if (live) live.unsubscribe();
			try {
				await runtime.dispose();
			} catch (disposeError) {
				this.options.reportError(disposeError);
			}
			throw error;
		}
	}

	private handleRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): void {
		if (live.terminal || live.disposing) return;
		void this.processRuntimeEvent(live, event);
	}

	private async processRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): Promise<void> {
		try {
			await this.enqueue(live, () => this.dispatchRuntimeEvent(live, event));
		} catch (error) {
			try {
				await this.terminate(live, error);
			} catch (terminateError) {
				this.options.reportError(terminateError);
			}
		} finally {
			// A detached runtime can transition to idle because of an unsolicited
			// runtime event rather than a tracked command completing.
			this.scheduleMaybeDispose(live);
		}
	}

	private async dispatchRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): Promise<void> {
		if (event.type === "error") {
			await this.terminate(live, event.error);
			return;
		}
		if (event.type === "snapshot") {
			await this.broadcastSnapshotNow(live);
			return;
		}
		const cursor = this.allocateCursor(live);
		const serverEvent: CursorBearingSessionEvent = buildCursorEvent(live.id, cursor, event);
		const envelope: EventEnvelope = { type: "event", event: serverEvent };
		// Ordered fan-out: every prior cursor-bearing send completes before a
		// later snapshot broadcast captures its watermark.
		for (const connection of live.connections) await this.options.sendMessage(connection, envelope);
	}

	/**
	 * Allocates and records the next monotonic safe-integer cursor for a runtime
	 * event. Exhaustion past `Number.MAX_SAFE_INTEGER` is an internal error
	 * requiring resync; it never wraps and remains deterministic.
	 */
	private allocateCursor(live: LiveSession): number {
		if (live.eventCursor >= MAX_SAFE_INTEGER) {
			throw new InternalServerError(`Session ${live.id} event cursor exhausted; resync required`);
		}
		live.eventCursor += 1;
		this.sessionCursors.set(live.id, live.eventCursor);
		return live.eventCursor;
	}

	private async terminate(live: LiveSession, error: unknown): Promise<void> {
		if (live.terminal) return;
		live.terminal = true;
		this.options.reportError(error);
		live.unsubscribe();
		const connections = [...live.connections];
		await Promise.all(connections.map((connection) => this.options.closeConnection(connection.connection)));
		await Promise.all(connections.map((connection) => this.options.disconnect(connection)));
		await this.maybeDispose(live);
	}

	private async normalizedSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		// Capture the watermark before awaiting the runtime so a snapshot never
		// claims events that were queued after it was requested.
		const eventCursor = live.eventCursor;
		const snapshot = await live.runtime.snapshot();
		if (snapshot.id !== live.id) {
			this.rekeyLiveSession(live, snapshot.id);
		}
		const exclusiveControllerConnected = this.hasExclusiveController(live);
		const observerCount = this.observerCount(live);
		return {
			...snapshot,
			phase: live.runtime.getPhase(),
			attached: live.connections.size > 0,
			locked: true,
			eventCursor,
			lease: { exclusiveControllerConnected, observerCount, mode: null },
		};
	}

	/**
	 * Re-key a live session after the runtime replaced its durable session
	 * (`fork`/`clone`): the event channel and every connection lease move to the
	 * new identity atomically. Only ever called on the session queue (from
	 * `normalizedSnapshot`), so map mutations serialize with event fan-out. The
	 * cursor continues monotonically — a replacement is not a new event stream.
	 */
	private rekeyLiveSession(live: LiveSession, nextId: string): void {
		const previousId = live.id;
		if (this.liveSessions.get(previousId) === live) this.liveSessions.delete(previousId);
		live.id = nextId;
		this.liveSessions.set(nextId, live);
		for (const connection of live.connections) {
			const lease = connection.sessionLeases.get(previousId);
			if (lease) {
				connection.sessionLeases.delete(previousId);
				connection.sessionLeases.set(nextId, lease);
			}
		}
		const cursor = this.sessionCursors.get(previousId);
		if (cursor !== undefined) {
			this.sessionCursors.delete(previousId);
			this.sessionCursors.set(nextId, cursor);
		}
	}

	private forConnection(snapshot: SessionSnapshot, connection: ConnectionState): SessionSnapshot {
		const lease = connection.sessionLeases.get(snapshot.id);
		const mode = lease?.mode ?? null;
		return {
			...snapshot,
			attached: lease !== undefined,
			lease: { ...snapshot.lease, mode },
		};
	}

	/** Serializes a task after every task already queued on the session. */
	private enqueue<T>(live: LiveSession, task: () => Promise<T>): Promise<T> {
		const result = live.queue.then(task);
		live.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Reads an authoritative snapshot on the queue without broadcasting. */
	private captureSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		return this.enqueue(live, () => this.normalizedSnapshot(live));
	}

	/** Broadcasts an authoritative snapshot to every attached connection, ordered after all prior cursor sends. */
	private broadcastSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		return this.enqueue(live, () => this.broadcastSnapshotNow(live));
	}

	/** Normalizes and fans out a snapshot without queueing (callers already hold the queue). */
	private async broadcastSnapshotNow(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await this.normalizedSnapshot(live);
		for (const connection of live.connections) {
			const envelope: EventEnvelope = {
				type: "event",
				event: { type: "session_snapshot", snapshot: this.forConnection(snapshot, connection) },
			};
			await this.options.sendMessage(connection, envelope);
		}
		return snapshot;
	}

	private async attach(connection: ConnectionState, live: LiveSession, mode: LeaseMode): Promise<void> {
		if (connection.disconnected || connection.stage !== "ready" || connection.connection.closed) {
			await this.maybeDispose(live);
			throw new PiServerError("invalid_request", "Connection closed while attaching to a session");
		}
		if (mode === "exclusive") {
			const existingController = this.exclusiveController(live);
			if (existingController && existingController !== connection) {
				throw new PiServerError("session_locked", `Session ${live.id} already has an exclusive controller`);
			}
		}
		connection.sessionLeases.set(live.id, { mode });
		live.connections.add(connection);
	}

	private releaseLease(connection: ConnectionState, sessionId: string): void {
		connection.sessionLeases.delete(sessionId);
	}

	private hasExclusiveController(live: LiveSession): boolean {
		return this.exclusiveController(live) !== undefined;
	}

	private exclusiveController(live: LiveSession): ConnectionState | undefined {
		for (const connection of live.connections) {
			if (connection.sessionLeases.get(live.id)?.mode === "exclusive") return connection;
		}
		return undefined;
	}

	private observerCount(live: LiveSession): number {
		let count = 0;
		for (const connection of live.connections) {
			if (connection.sessionLeases.get(live.id)?.mode === "shared") count += 1;
		}
		return count;
	}

	private isController(connection: ConnectionState, live: LiveSession): boolean {
		return connection.sessionLeases.get(live.id)?.mode === "exclusive";
	}

	private requireAttached(connection: ConnectionState, sessionId: string): LiveSession {
		if (!connection.sessionLeases.has(sessionId)) {
			throw new PiServerError("invalid_request", `Connection is not attached to session ${sessionId}`);
		}
		const live = this.liveSessions.get(sessionId);
		if (!live || live.terminal || live.disposing) {
			throw new PiServerError("not_found", `Session is not live: ${sessionId}`);
		}
		return live;
	}

	private requireController(connection: ConnectionState, sessionId: string): LiveSession {
		const live = this.requireAttached(connection, sessionId);
		if (!this.isController(connection, live)) {
			throw new PiServerError("unauthorized", `Connection is not the exclusive controller of session ${sessionId}`);
		}
		return live;
	}

	private scheduleMaybeDispose(live: LiveSession): void {
		void this.maybeDispose(live).catch((error: unknown) => this.options.reportError(error));
	}

	private async maybeDispose(live: LiveSession): Promise<void> {
		if (
			this.options.isClosing() ||
			!live.ready ||
			live.disposing ||
			live.connections.size > 0 ||
			live.operationCount > 0 ||
			(!live.terminal && live.runtime.getPhase() !== "idle")
		) {
			return live.disposing;
		}
		live.unsubscribe();
		live.disposing = (async () => {
			try {
				await live.runtime.dispose();
			} finally {
				if (this.liveSessions.get(live.id) === live) this.liveSessions.delete(live.id);
			}
		})();
		await live.disposing;
		if (!this.options.isClosing()) this.options.broadcastServerSnapshot();
	}
}
