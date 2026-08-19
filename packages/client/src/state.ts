import type {
	CommandResult,
	InteractionRequest,
	QueueKind,
	QueueMode,
	ServerEvent,
	ServerSnapshot,
	SessionSnapshot,
	SurfaceState,
} from "@earendil-works/pi-protocol";
import { toError } from "./errors.ts";
import type { ListenerErrorHandler, Unsubscribe } from "./types.ts";

export interface ResyncSignal {
	/** Session ids that need a resync because of a forward cursor gap. */
	readonly sessionIds: readonly string[];
}

export class ClientState {
	readonly #sessionSnapshots = new Map<string, SessionSnapshot>();
	readonly #attachedSessionIds = new Set<string>();
	readonly #eventCursors = new Map<string, number>();
	/** Sessions with an unresolved forward cursor gap awaiting an authoritative snapshot. */
	readonly #gappedSessionIds = new Set<string>();
	readonly #snapshotListeners = new Set<(snapshot: ServerSnapshot) => void>();
	readonly #eventListeners = new Set<(event: ServerEvent) => void>();
	readonly #sessionSnapshotListeners = new Map<string, Set<(snapshot: SessionSnapshot) => void>>();
	readonly #sessionEventListeners = new Map<string, Set<(event: ServerEvent) => void>>();
	readonly #onListenerError: ListenerErrorHandler | undefined;
	#snapshot: ServerSnapshot | undefined;
	#serverId: string | undefined;

	constructor(onListenerError?: ListenerErrorHandler) {
		this.#onListenerError = onListenerError;
	}

	get snapshot(): ServerSnapshot | undefined {
		return this.#snapshot;
	}

	reset(): void {
		this.#snapshot = undefined;
		this.#serverId = undefined;
		this.#sessionSnapshots.clear();
		this.#attachedSessionIds.clear();
		this.#eventCursors.clear();
		this.#gappedSessionIds.clear();
	}

	clearAttachments(): void {
		this.#attachedSessionIds.clear();
	}

	dispose(): void {
		this.reset();
		this.#snapshotListeners.clear();
		this.#eventListeners.clear();
		this.#sessionSnapshotListeners.clear();
		this.#sessionEventListeners.clear();
	}

	getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		return this.#sessionSnapshots.get(sessionId);
	}

	isSessionAttached(sessionId: string): boolean {
		return this.#attachedSessionIds.has(sessionId);
	}

	getSessionCursor(sessionId: string): number | undefined {
		return this.#eventCursors.get(sessionId);
	}

	isSessionGapped(sessionId: string): boolean {
		return this.#gappedSessionIds.has(sessionId);
	}

	/** Clears a forward-gap marker so a later event may re-trigger a resync retry. */
	clearGap(sessionId: string): void {
		this.#gappedSessionIds.delete(sessionId);
	}

	forgetSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		const previous = this.#sessionSnapshots.get(sessionId);
		this.#sessionSnapshots.delete(sessionId);
		this.#eventCursors.delete(sessionId);
		this.#gappedSessionIds.delete(sessionId);
		return previous;
	}

	restoreSessionSnapshot(snapshot: SessionSnapshot): void {
		if (!this.#sessionSnapshots.has(snapshot.id)) {
			this.#sessionSnapshots.set(snapshot.id, snapshot);
			this.#eventCursors.set(snapshot.id, snapshot.eventCursor);
		}
	}

	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#snapshotListeners.add(listener);
		return () => this.#snapshotListeners.delete(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	subscribeSession(sessionId: string, listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return addMappedListener(this.#sessionSnapshotListeners, sessionId, listener);
	}

	onSessionEvent(sessionId: string, listener: (event: ServerEvent) => void): Unsubscribe {
		return addMappedListener(this.#sessionEventListeners, sessionId, listener);
	}

	applyResult(result: CommandResult): void {
		if (result.command === "list") return;
		if (result.command === "detach") {
			this.#attachedSessionIds.delete(result.sessionId);
			const snapshot = this.#sessionSnapshots.get(result.sessionId);
			if (snapshot)
				this.#applySessionSnapshot(
					{ ...snapshot, attached: false, lease: { ...snapshot.lease, mode: null } },
					true,
				);
			return;
		}
		if ("session" in result) this.#applySessionSnapshot(result.session);
	}

	/**
	 * Applies a server event, reducing cursor-bearing events into the
	 * authoritative snapshot projection. Returns the set of session ids that now
	 * have a forward cursor gap and require a resync.
	 */
	applyEvent(event: ServerEvent): ResyncSignal {
		if (event.type === "server_snapshot") this.applyServerSnapshot(event.snapshot);
		if (event.type === "session_snapshot") this.#applySessionSnapshot(event.snapshot);
		if (event.type === "session_removed") {
			this.#sessionSnapshots.delete(event.sessionId);
			this.#attachedSessionIds.delete(event.sessionId);
			this.#eventCursors.delete(event.sessionId);
			this.#gappedSessionIds.delete(event.sessionId);
		}
		if (isCursorBearing(event)) {
			const outcome = this.#applyCursorEvent(event);
			if (outcome !== "apply") {
				// Stale/duplicate/gapped/no-baseline events are not reduced and not
				// emitted to any subscriber.
				return { sessionIds: outcome === "resync" ? [event.sessionId] : [] };
			}
		}
		this.#notify(this.#eventListeners, event);
		const sessionId = getEventSessionId(event);
		if (sessionId) this.#notify(this.#sessionEventListeners.get(sessionId), event);
		return { sessionIds: [] };
	}

	/** Returns true when the server identity changed (the snapshot serverId differs from the current one). */
	applyServerSnapshot(snapshot: ServerSnapshot): boolean {
		const previouslyKnown = this.#serverId !== undefined;
		const serverIdChanged = previouslyKnown && snapshot.serverId !== this.#serverId;
		if (snapshot.serverId !== this.#serverId) {
			// Identity takes precedence over revision: a restarted/replaced server may
			// legitimately begin at a lower server-snapshot revision.
			this.#serverId = snapshot.serverId;
			this.#sessionSnapshots.clear();
			this.#attachedSessionIds.clear();
			this.#eventCursors.clear();
			this.#gappedSessionIds.clear();
		} else if (this.#snapshot && snapshot.revision < this.#snapshot.revision) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#notify(this.#snapshotListeners, snapshot);
		return serverIdChanged;
	}

	#applySessionSnapshot(snapshot: SessionSnapshot, force = false): void {
		const current = this.#sessionSnapshots.get(snapshot.id);
		if (!force && current) {
			if (snapshot.revision < current.revision) return;
			// The event cursor is monotonic for one server identity, regardless of
			// runtime revision; delayed responses must never move it backward.
			if (snapshot.eventCursor < current.eventCursor) return;
		}
		this.#sessionSnapshots.set(snapshot.id, snapshot);
		this.#eventCursors.set(snapshot.id, snapshot.eventCursor);
		this.#gappedSessionIds.delete(snapshot.id);
		if (snapshot.attached) this.#attachedSessionIds.add(snapshot.id);
		else this.#attachedSessionIds.delete(snapshot.id);
		this.#notify(this.#sessionSnapshotListeners.get(snapshot.id), snapshot);
	}

	/** Returns how a cursor-bearing event was handled. */
	#applyCursorEvent(event: CursorBearingEvent): "apply" | "ignore" | "resync" {
		if (this.#gappedSessionIds.has(event.sessionId)) return "ignore";
		const previous = this.#eventCursors.get(event.sessionId);
		if (previous === undefined) {
			// No authoritative baseline yet: never adopt a cursor into stale state.
			// An unattached session cannot be resynced and should not receive events.
			if (!this.#attachedSessionIds.has(event.sessionId)) return "ignore";
			this.#gappedSessionIds.add(event.sessionId);
			return "resync";
		}
		const next = previous + 1;
		if (event.eventCursor === next) {
			this.#eventCursors.set(event.sessionId, event.eventCursor);
			this.#reduceEvent(event);
			return "apply";
		}
		if (event.eventCursor <= previous) {
			// Stale or duplicate: ignore and never reduce or emit.
			return "ignore";
		}
		// Forward gap.
		this.#gappedSessionIds.add(event.sessionId);
		return "resync";
	}

	#reduceEvent(event: CursorBearingEvent): void {
		const snapshot = this.#sessionSnapshots.get(event.sessionId);
		if (!snapshot) return;
		const reduced = reduceCursorEvent(snapshot, event);
		this.#sessionSnapshots.set(event.sessionId, reduced);
		if (event.type !== "session_progress") {
			// session_progress only advances the cursor; it is not a substantive
			// snapshot change, so snapshot subscribers are not re-notified.
			this.#notify(this.#sessionSnapshotListeners.get(event.sessionId), reduced);
		}
	}

	#notify<T>(listeners: Iterable<(value: T) => void> | undefined, value: T): void {
		for (const listener of listeners ?? []) {
			try {
				listener(value);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect client state.
		}
	}
}

type CursorBearingEvent = Extract<ServerEvent, { eventCursor: number; sessionId: string }>;

function isCursorBearing(event: ServerEvent): event is CursorBearingEvent {
	return (
		event.type === "session_progress" ||
		event.type === "surface_update" ||
		event.type === "interaction_request" ||
		event.type === "queue_update"
	);
}

function reduceCursorEvent(snapshot: SessionSnapshot, event: CursorBearingEvent): SessionSnapshot {
	const withCursor = { ...snapshot, eventCursor: event.eventCursor };
	switch (event.type) {
		case "session_progress":
			// Transcript deltas are exposed to event subscribers; the snapshot itself
			// does not change, but the cursor has advanced.
			return withCursor;
		case "surface_update":
			return { ...withCursor, surface: reduceSurface(snapshot.surface, event.operation) };
		case "interaction_request":
			return {
				...withCursor,
				pendingInteractions: upsertInteraction(snapshot.pendingInteractions, event.request),
			};
		case "queue_update":
			return reduceQueue(withCursor, event.queue, event.mode, event.queuedCount);
	}
}

function setRecordEntry<V>(
	record: Record<string, V> | undefined,
	key: string,
	value: V | undefined,
): Record<string, V> | undefined {
	if (value === undefined) {
		if (!record || !(key in record)) return record;
		const next = { ...record };
		delete next[key];
		return next;
	}
	return { ...record, [key]: value };
}

function reduceSurface(
	surface: SurfaceState,
	operation: Extract<ServerEvent, { type: "surface_update" }>["operation"],
): SurfaceState {
	switch (operation.op) {
		case "notify":
			// Transient notification; not part of the reconstructable surface.
			return surface;
		case "set_status":
			return { ...surface, statuses: setRecordEntry(surface.statuses, operation.key, operation.text ?? undefined) };
		case "set_working_message":
			return { ...surface, workingMessage: operation.message ?? undefined };
		case "set_working_visible":
			return { ...surface, workingVisible: operation.visible };
		case "set_working_indicator":
			return { ...surface, workingIndicator: operation.indicator ?? undefined };
		case "set_hidden_thinking_label":
			return { ...surface, hiddenThinkingLabel: operation.label ?? undefined };
		case "set_widget":
			return {
				...surface,
				widgets: setRecordEntry(
					surface.widgets,
					operation.key,
					operation.lines === null
						? undefined
						: { lines: operation.lines, placement: operation.placement ?? "aboveEditor" },
				),
			};
		case "set_title":
			return { ...surface, title: operation.title ?? undefined };
		case "set_editor_text":
			return { ...surface, editorText: operation.text };
		case "set_theme":
			return { ...surface, theme: operation.theme ?? undefined };
		case "set_tools_expanded":
			return { ...surface, toolsExpanded: operation.expanded };
	}
}

function upsertInteraction(pending: readonly InteractionRequest[], request: InteractionRequest): InteractionRequest[] {
	const existing = pending.find((item) => item.id === request.id);
	if (existing) return pending.map((item) => (item.id === request.id ? request : item));
	return [...pending, request];
}

function reduceQueue(
	snapshot: SessionSnapshot,
	queue: QueueKind,
	mode: QueueMode,
	queuedCount: number,
): SessionSnapshot {
	if (queue === "steer") {
		return { ...snapshot, steeringMode: mode, queuedSteerCount: queuedCount };
	}
	return { ...snapshot, followUpMode: mode, queuedFollowUpCount: queuedCount };
}

function addMappedListener<T>(
	listenersById: Map<string, Set<(value: T) => void>>,
	id: string,
	listener: (value: T) => void,
): Unsubscribe {
	let listeners = listenersById.get(id);
	if (!listeners) {
		listeners = new Set();
		listenersById.set(id, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) listenersById.delete(id);
	};
}

function getEventSessionId(event: ServerEvent): string | undefined {
	if (event.type === "session_snapshot") return event.snapshot.id;
	if (
		event.type === "session_progress" ||
		event.type === "session_removed" ||
		event.type === "surface_update" ||
		event.type === "interaction_request" ||
		event.type === "queue_update" ||
		event.type === "lease_lost"
	) {
		return event.sessionId;
	}
	return undefined;
}
