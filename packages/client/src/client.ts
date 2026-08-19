import {
	type Command,
	type CommandResult,
	type EventEnvelope,
	encodeClientMessage,
	ProtocolValidationError,
	type ResponseEnvelope,
	type ResultForCommand,
	type ServerEvent,
	type ServerSnapshot,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
	toError,
} from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import {
	type AcquireSessionOptions,
	type PiSessionHandle,
	SessionHandle,
	type SessionHandleCallbacks,
	type SessionLeaseMode,
} from "./session-handle.ts";
import { ClientState } from "./state.ts";
import type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	PiClientOptions,
	Unsubscribe,
} from "./types.ts";

type SessionLeaseState = "active" | "releasing" | "released" | "invalidated";

interface SessionLeaseToken {
	readonly mode: SessionLeaseMode;
}

interface PendingRequest {
	command: Command;
	resolve(result: CommandResult): void;
	reject(error: Error): void;
}

export class PiClient {
	readonly #options: PiClientOptions;
	readonly #connection: Connection;
	readonly #state: ClientState;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #sessionLeaseCounts = new Map<string, number>();
	readonly #exclusiveSessionLeases = new Map<string, SessionLeaseToken>();
	readonly #sessionLeaseGenerations = new Map<string, number>();
	readonly #sessionAttachments = new Map<string, Promise<void>>();
	readonly #sessionDetachments = new Map<string, Promise<void>>();
	readonly #sessionCleanupRequired = new Set<string>();
	readonly #sessionReconciliations = new Map<string, Promise<void>>();
	readonly #sessionResyncs = new Map<string, Promise<void>>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	#requestSequence = 0;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: PiClientOptions) {
		this.#options = options;
		this.#state = new ClientState(options.onListenerError);
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (snapshot) => {
				if (this.#state.applyServerSnapshot(snapshot)) this.#invalidateAllSessionLeases();
			},
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#state.snapshot;
	}

	static async connect(options: PiClientOptions): Promise<PiClient> {
		const client = new PiClient(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	connect(): Promise<ServerSnapshot> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (this.#connection.state === "disconnected") this.#state.reset();
		return this.#connection.connect();
	}

	reconnect(): Promise<ServerSnapshot> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#state.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#state.onEvent(listener);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	async listSessions(): Promise<readonly SessionMetadata[]> {
		return (await this.#request({ command: "list" })).sessions;
	}

	/**
	 * Send an arbitrary protocol command, including session-less `free`
	 * commands (`get_settings`/`set_setting`/`login`/`logout`/`import_session`)
	 * that no session handle can carry. Session-scoped commands should
	 * normally go through a `PiSessionHandle` (which enforces lease gating);
	 * this is the raw path for everything else.
	 */
	async request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		return this.#request(command);
	}

	async createSession(options: CreateSessionOptions = {}): Promise<PiSessionHandle> {
		return this.createSessionWithMode(options, "exclusive");
	}

	async createSessionWithMode(options: CreateSessionOptions, mode: SessionLeaseMode): Promise<PiSessionHandle> {
		const result = await this.#request({ command: "create", leaseMode: mode, ...options });
		const token = this.#reserveSessionLease(result.session.id, mode);
		return this.#createSessionLease(result.session.id, token);
	}

	async attachSession(sessionId: string): Promise<PiSessionHandle> {
		return this.acquireSession(sessionId, { mode: "shared" });
	}

	async acquireSession(sessionId: string, options: AcquireSessionOptions): Promise<PiSessionHandle> {
		this.#assertNotDisposed();
		const token = this.#reserveSessionLease(sessionId, options.mode);
		try {
			const detachment = this.#sessionDetachments.get(sessionId);
			if (detachment) await detachment.catch(() => {});
			const reconciled = this.#sessionCleanupRequired.has(sessionId)
				? await this.#reconcileSessionCleanup(sessionId)
				: false;
			if (reconciled || !this.#state.isSessionAttached(sessionId)) {
				let attachment = this.#sessionAttachments.get(sessionId);
				if (!attachment) {
					attachment = this.#attachSession(sessionId, options.mode);
					this.#sessionAttachments.set(sessionId, attachment);
				}
				try {
					await attachment;
				} finally {
					if (this.#sessionAttachments.get(sessionId) === attachment) this.#sessionAttachments.delete(sessionId);
				}
			}
			return this.#createSessionLease(sessionId, token);
		} catch (error) {
			this.#releaseSessionLease(sessionId, token);
			throw error;
		}
	}

	async #attachSession(sessionId: string, mode: SessionLeaseMode): Promise<void> {
		const previous = this.#state.forgetSessionSnapshot(sessionId);
		try {
			await this.#request({ command: "attach", sessionId, leaseMode: mode });
		} catch (error) {
			if (previous) this.#state.restoreSessionSnapshot(previous);
			throw error;
		}
	}

	#request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<CommandResult>();
		this.#pendingRequests.set(id, { command, resolve, reject });
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, request: command },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise as Promise<ResultForCommand<TCommand>>;
		}
		this.#connection.send(frame);
		return promise as Promise<ResultForCommand<TCommand>>;
	}

	#createSessionLease(sessionId: string, token: SessionLeaseToken): PiSessionHandle {
		const generation = this.#sessionLeaseGenerations.get(sessionId) ?? 0;
		this.#sessionLeaseGenerations.set(sessionId, generation);
		let state: SessionLeaseState = "active";
		let releasePromise: Promise<void> | undefined;
		const refreshState = () => {
			if (
				(state === "active" || state === "releasing") &&
				this.#sessionLeaseGenerations.get(sessionId) !== generation
			) {
				state = "invalidated";
			}
		};
		const isActive = () => {
			refreshState();
			return state === "active" && this.#state.isSessionAttached(sessionId);
		};
		const resolveMode = (): SessionLeaseMode | undefined => {
			const snapshot = this.#state.getSessionSnapshot(sessionId);
			if (snapshot?.lease.mode) return snapshot.lease.mode;
			return token.mode;
		};
		const assertActive = () => {
			this.#assertNotDisposed();
			if (!this.connected) throw new PiDisconnectedError();
			if (!isActive()) throw new PiSessionDetachedError(sessionId);
		};
		const assertController = () => {
			assertActive();
			if (resolveMode() !== "exclusive") {
				throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} is not exclusively controlled`);
			}
		};
		const release = (relinquishOnFailure: boolean): Promise<void> => {
			refreshState();
			if (state === "released" || state === "invalidated") return Promise.resolve();
			if (releasePromise) return releasePromise;
			assertActive();
			state = "releasing";
			releasePromise = (async () => {
				const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
				if (count <= 1) {
					const detachment = this.#request({ command: "detach", sessionId }).then(() => undefined);
					this.#sessionDetachments.set(sessionId, detachment);
					try {
						await detachment;
						this.#releaseSessionLease(sessionId, token);
					} finally {
						if (this.#sessionDetachments.get(sessionId) === detachment) {
							this.#sessionDetachments.delete(sessionId);
						}
					}
				} else {
					this.#releaseSessionLease(sessionId, token);
				}
				state = "released";
			})().catch((error: unknown) => {
				refreshState();
				if (state === "invalidated") return;
				if (relinquishOnFailure) {
					this.#releaseSessionLease(sessionId, token);
					this.#sessionCleanupRequired.add(sessionId);
					state = "released";
				} else {
					state = "active";
					releasePromise = undefined;
				}
				throw error;
			});
			return releasePromise;
		};
		const callbacks: SessionHandleCallbacks = {
			isAttached: isActive,
			getMode: resolveMode,
			getSnapshot: () => (isActive() ? this.#state.getSessionSnapshot(sessionId) : undefined),
			subscribe: (listener) => {
				assertActive();
				return this.#state.subscribeSession(sessionId, (snapshot) => {
					if (isActive()) listener(snapshot);
				});
			},
			onEvent: (listener) => {
				assertActive();
				return this.#state.onSessionEvent(sessionId, (event) => {
					if (isActive() || event.type === "session_removed") listener(event);
				});
			},
			detach: () => release(false),
			dispose: () => release(true),
			request: (command) => {
				assertActive();
				return this.#request(command);
			},
			assertController,
		};
		return new SessionHandle(sessionId, callbacks);
	}

	#handleMessage(message: ResponseEnvelope | EventEnvelope): void {
		if (message.type === "event") {
			if (message.event.type === "session_removed" || message.event.type === "lease_lost") {
				this.#invalidateSessionLeases(message.event.sessionId);
			}
			if (message.event.type === "server_snapshot") {
				const previous = this.#state.snapshot?.serverId;
				if (previous !== undefined && message.event.snapshot.serverId !== previous) {
					this.#invalidateAllSessionLeases();
				}
			}
			const signal = this.#state.applyEvent(message.event);
			for (const sessionId of signal.sessionIds) this.#scheduleResync(sessionId);
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new PiServerError(message.error));
			return;
		}
		if (message.result.command !== pending.command.command) {
			const error = new ProtocolValidationError(
				`Response command ${message.result.command} does not match ${pending.command.command}`,
			);
			pending.reject(error);
			this.#connection.fail(error);
			return;
		}
		this.#state.applyResult(message.result);
		pending.resolve(message.result);
	}

	#scheduleResync(sessionId: string): void {
		if (this.#sessionResyncs.has(sessionId) || this.#disposed || !this.connected) return;
		let failure: Error | undefined;
		let tracked: Promise<void>;
		tracked = this.#request({ command: "resync", sessionId })
			.then(() => undefined)
			.catch((error: unknown) => {
				failure = toError(error);
			})
			.finally(() => {
				// A disconnected generation can settle after a new generation starts;
				// only the promise still registered for this session may mutate state.
				if (this.#sessionResyncs.get(sessionId) !== tracked) return;
				this.#sessionResyncs.delete(sessionId);
				if (failure) {
					// Retain the stale snapshot/cursor but clear the gap only after the
					// in-flight marker is gone, so the next event can reliably retry.
					this.#state.clearGap(sessionId);
					this.#reportListenerError(failure);
				}
			});
		this.#sessionResyncs.set(sessionId, tracked);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#state.clearAttachments();
			this.#invalidateAllSessionLeases();
			this.#sessionResyncs.clear();
			this.#rejectPendingRequests(change.error ?? new PiDisconnectedError());
		}
		this.#notifyConnectionStateListeners(change);
	}

	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) this.#pendingRequests.delete(id);
		return request;
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) request.reject(error);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new PiClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#state.dispose();
		this.#invalidateAllSessionLeases();
		this.#sessionResyncs.clear();
		this.#connectionStateListeners.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#assertNotDisposed(): void {
		if (this.#disposed) throw new PiClientDisposedError();
	}

	async #reconcileSessionCleanup(sessionId: string): Promise<boolean> {
		if (!this.#sessionCleanupRequired.has(sessionId)) return false;
		let reconciliation = this.#sessionReconciliations.get(sessionId);
		if (!reconciliation) {
			reconciliation = this.#request({ command: "detach", sessionId })
				.then(() => undefined)
				.then(() => {
					this.#sessionCleanupRequired.delete(sessionId);
				})
				.finally(() => {
					this.#sessionReconciliations.delete(sessionId);
				});
			this.#sessionReconciliations.set(sessionId, reconciliation);
		}
		await reconciliation;
		return true;
	}

	#reserveSessionLease(sessionId: string, mode: SessionLeaseMode): SessionLeaseToken {
		const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
		if (mode === "exclusive" && count > 0) {
			throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} already has an active lease`);
		}
		if (mode === "shared" && this.#exclusiveSessionLeases.has(sessionId)) {
			throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} has an exclusive lease`);
		}
		const token: SessionLeaseToken = { mode };
		this.#sessionLeaseCounts.set(sessionId, count + 1);
		if (mode === "exclusive") this.#exclusiveSessionLeases.set(sessionId, token);
		return token;
	}

	#releaseSessionLease(sessionId: string, token: SessionLeaseToken): void {
		const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
		if (count <= 1) this.#sessionLeaseCounts.delete(sessionId);
		else this.#sessionLeaseCounts.set(sessionId, count - 1);
		if (this.#exclusiveSessionLeases.get(sessionId) === token) this.#exclusiveSessionLeases.delete(sessionId);
	}

	#invalidateSessionLeases(sessionId: string): void {
		this.#sessionLeaseCounts.delete(sessionId);
		this.#exclusiveSessionLeases.delete(sessionId);
		this.#sessionCleanupRequired.delete(sessionId);
		this.#sessionLeaseGenerations.set(sessionId, (this.#sessionLeaseGenerations.get(sessionId) ?? 0) + 1);
	}

	#invalidateAllSessionLeases(): void {
		for (const sessionId of this.#sessionLeaseCounts.keys()) this.#invalidateSessionLeases(sessionId);
		this.#sessionCleanupRequired.clear();
	}

	#notifyConnectionStateListeners(change: ConnectionStateChange): void {
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect protocol or transport state.
		}
	}
}
