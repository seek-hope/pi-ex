import {
	type Command,
	type InteractionResponse,
	isSharedAllowedCommand,
	type MessagePart,
	type ModelRef,
	type QueueKind,
	type QueueMode,
	type ResultForCommand,
	type ServerEvent,
	type SessionSnapshot,
	type ThinkingLevel,
} from "@earendil-works/pi-protocol";
import { PiSessionOwnershipError } from "./errors.ts";
import type { Unsubscribe } from "./types.ts";

type SessionCommand = Extract<Command, { sessionId: string }>;

export type SessionLeaseMode = "shared" | "exclusive";

export interface AcquireSessionOptions {
	mode: SessionLeaseMode;
}

export interface SessionLease extends AsyncDisposable {
	readonly id: string;
	readonly active: boolean;
	readonly attached: boolean;
	/** This connection's authoritative lease mode from the latest snapshot, if any. */
	readonly mode: SessionLeaseMode | undefined;
	readonly snapshot: SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	dispose(): Promise<void>;
	/** Typed request dispatch, correlating the result by command discriminator. */
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
	prompt(content: MessagePart[]): Promise<SessionSnapshot>;
	steer(content: MessagePart[]): Promise<SessionSnapshot>;
	followUp(content: MessagePart[]): Promise<SessionSnapshot>;
	abort(): Promise<SessionSnapshot>;
	setModel(model: ModelRef): Promise<SessionSnapshot>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot>;
	resync(): Promise<SessionSnapshot>;
	respondInteraction(
		interactionId: string,
		result: InteractionResponse,
	): Promise<ResultForCommand<Extract<Command, { command: "respond_interaction" }>>>;
	clearQueue(queue?: QueueKind): Promise<SessionSnapshot>;
	setQueueMode(queue: QueueKind, mode: QueueMode): Promise<SessionSnapshot>;
}

export type PiSessionHandle = SessionLease;

export interface SessionHandleCallbacks {
	isAttached(): boolean;
	getMode(): SessionLeaseMode | undefined;
	getSnapshot(): SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	dispose(): Promise<void>;
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
	assertController(): void;
}

export class SessionHandle implements SessionLease {
	readonly id: string;
	readonly #callbacks: SessionHandleCallbacks;

	constructor(id: string, callbacks: SessionHandleCallbacks) {
		this.id = id;
		this.#callbacks = callbacks;
	}

	get attached(): boolean {
		return this.#callbacks.isAttached();
	}

	get active(): boolean {
		return this.attached;
	}

	get mode(): SessionLeaseMode | undefined {
		return this.#callbacks.getMode();
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.#callbacks.getSnapshot();
	}

	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.#callbacks.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#callbacks.onEvent(listener);
	}

	async detach(): Promise<void> {
		await this.#callbacks.detach();
	}

	dispose(): Promise<void> {
		return this.#callbacks.dispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		this.#assertRequestAllowed(command);
		return this.#callbacks.request(command);
	}

	async prompt(content: MessagePart[]): Promise<SessionSnapshot> {
		return (await this.#request({ command: "prompt", sessionId: this.id, content })).session;
	}

	async steer(content: MessagePart[]): Promise<SessionSnapshot> {
		return (await this.#request({ command: "steer", sessionId: this.id, content })).session;
	}

	async followUp(content: MessagePart[]): Promise<SessionSnapshot> {
		return (await this.#request({ command: "follow_up", sessionId: this.id, content })).session;
	}

	async abort(): Promise<SessionSnapshot> {
		return (await this.#request({ command: "abort", sessionId: this.id })).session;
	}

	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_model", sessionId: this.id, model })).session;
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_thinking", sessionId: this.id, thinkingLevel })).session;
	}

	async resync(): Promise<SessionSnapshot> {
		// resync is shared-allowed and routed through the gated request path.
		return (await this.request({ command: "resync", sessionId: this.id })).session;
	}

	async respondInteraction(
		interactionId: string,
		result: InteractionResponse,
	): Promise<ResultForCommand<Extract<Command, { command: "respond_interaction" }>>> {
		// respond_interaction is a mutation and must be gated like one.
		return this.request({ command: "respond_interaction", sessionId: this.id, interactionId, result });
	}

	async clearQueue(queue?: QueueKind): Promise<SessionSnapshot> {
		return (
			await this.#request(
				queue === undefined
					? { command: "clear_queue", sessionId: this.id }
					: { command: "clear_queue", sessionId: this.id, queue },
			)
		).session;
	}

	async setQueueMode(queue: QueueKind, mode: QueueMode): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_queue_mode", sessionId: this.id, queue, mode })).session;
	}

	#request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		this.#callbacks.assertController();
		return this.#callbacks.request(command);
	}

	#assertRequestAllowed(command: SessionCommand): void {
		if (command.sessionId !== this.id) {
			throw new RangeError(`Session handle ${this.id} cannot issue a request for ${command.sessionId}`);
		}
		const mode = this.#callbacks.getMode();
		if (mode !== "exclusive" && !isSharedAllowedCommand(command.command)) {
			throw new PiSessionOwnershipError(
				command.sessionId,
				`Session ${command.sessionId} is not exclusively controlled`,
			);
		}
	}
}
