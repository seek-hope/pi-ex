import type { ClientMessageDecoder, LeaseMode } from "@earendil-works/pi-protocol";

import type { MaybePromise } from "./types.ts";

/** An established, authorized ordered byte connection. */
export interface ByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): MaybePromise<void>;
}

export interface ByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

export type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

export type ConnectionStage = "awaitingHello" | "handshaking" | "ready" | "closing" | "closed";

/** Per-connection per-session lease record; the server is the only authority on its mode. */
export interface ConnectionSessionLease {
	mode: LeaseMode;
}

export interface ConnectionState {
	id: string;
	connection: ByteConnection;
	decoder: ClientMessageDecoder;
	/** Session id -> this connection's lease mode for that session. */
	sessionLeases: Map<string, ConnectionSessionLease>;
	stage: ConnectionStage;
	disconnected: boolean;
	handshakeComplete: boolean;
	handshake?: Promise<void>;
	handshakeTimeout: NodeJS.Timeout;
}

export function isTerminalConnection(state: ConnectionState): boolean {
	return state.disconnected || state.stage === "closing" || state.stage === "closed";
}
