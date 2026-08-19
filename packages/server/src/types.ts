import type {
	BlobReference,
	Command,
	InteractionRequest,
	ModelMetadata,
	ModelRef,
	QueueKind,
	QueueMode,
	ResultForCommand,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	SurfaceUpdateOperation,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { PiServerError } from "./errors.ts";
import type { PiServerListener } from "./listener.ts";

export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

export type PromptInput = Omit<Extract<Command, { command: "prompt" }>, "command" | "sessionId">;
export type SteerInput = Omit<Extract<Command, { command: "steer" }>, "command" | "sessionId">;

export interface CreateSessionOptions {
	/** A collision-resistant ID assigned by PiServer. The service must persist this exact ID. */
	id: string;
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export type PiSessionRuntimeEvent =
	| { type: "snapshot" }
	| { type: "progress"; progress: TranscriptProgress }
	| { type: "surface"; operation: SurfaceUpdateOperation }
	| { type: "interaction"; request: InteractionRequest }
	| { type: "queue"; queue: QueueKind; mode: QueueMode; queuedCount: number }
	| { type: "error"; error: PiServerError };

/**
 * Authoritative per-session state produced by a runtime, before the server
 * attaches the per-connection projection (`attached`, `locked`, `lease`) and
 * the server-owned `eventCursor`. Runtimes never fabricate connection or
 * cursor fields.
 */
export type PiSessionRuntimeSnapshot = Omit<SessionSnapshot, "attached" | "locked" | "lease" | "eventCursor">;

/**
 * Session-scoped commands not dispatched through the runtime's explicit
 * methods. A runtime may implement this optional hook to service the full
 * command surface; commands it does not recognize must throw a
 * `not_implemented` error rather than falling through as internal errors.
 */
export type PiSessionRuntimeCommand = Exclude<
	Extract<Command, { sessionId: string }>,
	{ command: "attach" | "detach" | "resync" | "prompt" | "steer" | "abort" | "set_model" | "set_thinking" }
>;

/**
 * The runtime-visible result for a session command. For mutation commands whose
 * wire result carries the server-owned `session` projection, the `session` field
 * is omitted: the server produces it, so a runtime never fabricates
 * `attached`/`locked`/`lease`/`eventCursor`. Read commands return their full
 * typed result unchanged.
 */
export type PiSessionRuntimeResult<TCommand extends PiSessionRuntimeCommand> = Omit<
	ResultForCommand<TCommand>,
	"session"
>;

/** One acquired durable session. Conflicting operations must reject rather than queue. */
export interface PiSessionRuntime {
	snapshot(): MaybePromise<PiSessionRuntimeSnapshot>;
	getPhase(): SessionPhase;
	prompt(input: PromptInput): Promise<void>;
	steer(input: SteerInput): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	executeCommand?<const TCommand extends PiSessionRuntimeCommand>(
		command: TCommand,
	): MaybePromise<PiSessionRuntimeResult<TCommand>>;
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}

/** Service boundary for durable sessions and exclusively acquired runtimes. */
export interface PiServerService {
	listSessions(): Promise<SessionMetadata[]>;
	listModels(): Promise<ModelMetadata[]>;
	createSession(options: CreateSessionOptions): Promise<PiSessionRuntime>;
	openSession(sessionId: string): Promise<PiSessionRuntime>;
	/**
	 * Optional hook for free (non-session-scoped) commands: `get_settings`,
	 * `set_setting`, `login`, `logout`. Dispatched without lease checks; the
	 * service owns serializing host-global mutations. Commands the service does
	 * not service must throw `not_implemented` rather than fall through as
	 * internal errors.
	 */
	executeFreeCommand?<const TCommand extends PiFreeCommand>(
		command: TCommand,
	): MaybePromise<ResultForCommand<TCommand>>;
	/**
	 * Optional hook for `import_session`. Resolves the staged `blob`, creates a
	 * **new durable session** from its bytes, and returns its session id. The
	 * server then acquires + exclusively attaches that session and projects the
	 * authoritative snapshot for the result; this hook never fabricates a
	 * snapshot — it only materializes a durable session and reports its id.
	 * A missing/expired/blob-invalid payload must throw `invalid_request`.
	 */
	importSession?(blob: BlobReference): Promise<{ sessionId: string }>;
}

/**
 * Free commands the service boundary may service directly. `import_session` is
 * deliberately excluded: its result carries a session snapshot the server must
 * project after acquiring the imported session, so it is handled by the
 * dedicated `PiServerService.importSession` hook instead of `executeFreeCommand`.
 */
export type PiFreeCommand = Extract<Command, { command: "get_settings" | "set_setting" | "login" | "logout" }>;

export type SessionRuntime = PiSessionRuntime;
export type SessionRuntimeEvent = PiSessionRuntimeEvent;
