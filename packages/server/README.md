# @earendil-works/pi-server

Experimental. This package is under active development and may change or be removed without notice. Its APIs and behavior are not yet stable.

Server package for pi.

## Session server core

The package exports the `PiServer` session server.

```ts
import type { PiServerService } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";

const service: PiServerService = {
  async listSessions() {
    return storage.listSessions();
  },
  async listModels() {
    return modelRegistry.listModels();
  },
  async createSession(options) {
    return storage.createAndOpen(options);
  },
  async openSession(sessionId) {
    return storage.open(sessionId);
  },
};

const server = createUnixServer(service, {
  path: "/tmp/pi/server.sock",
});
await server.start();
```

`PiServer` composes transport listeners through the `PiServerListener` interface. Each listener must complete any transport-specific authentication and authorization before passing a connection to `PiServer`. For example, a WebSocket listener can validate credentials during the HTTP upgrade, while the Unix listener relies on socket filesystem permissions. The Unix submodule exports the `createUnixListener()` building block and `createUnixServer()` preset, keeping the common case concise without coupling the primary server to Unix sockets. The listener uses length-prefixed CBOR messages from `@earendil-works/pi-protocol`.

## WebSocket listener

The `@earendil-works/pi-server/websocket` submodule exports a WebSocket listener and preset:

```ts
import type { PiServerService } from "@earendil-works/pi-server";
import { createWebSocketServer } from "@earendil-works/pi-server/websocket";

const server = createWebSocketServer(service, {
  host: "127.0.0.1", // standalone mode accepts only numeric loopback (127/8, ::1, ::ffff:127.0.0.1)
  port: 8000,
  authorize: async (request) => {
    if (request.headers["authorization"] === `Bearer ${token}`) return { authorized: true };
    return { authorized: false, status: 401, message: "Unauthorized" };
  },
});
await server.start();
```

Pass an existing `server` (an `http.Server`/`https.Server`) to attach the listener as an upgrade handler on the default path `/api/ws`; the listener ignores unrelated paths, never closes the external server, and removes its listeners on shutdown. Omit `server` to own a standalone numeric-loopback server (`localhost` is rejected). The default `maxPayload` accepts exactly `maxFrameLength + 4` bytes — one WebSocket message carries the 4-byte length prefix plus the CBOR payload — and a custom `maxPayload` is validated as the full framed-message limit. The async `authorize` hook pauses the upgrade socket, is bounded by `authorizationTimeoutMs` (default 10 s), and denials are sanitized (status restricted to 400/401/403 with a normalized reason, sent via a complete response). The transport is binary-only; text frames are closed, and a bounded per-connection byte budget protects against slow peers. The reusable `WebSocketByteConnection` adapter (with `WebSocketByteConnectionOptions`) is exported for adapting an already-authorized `ws` connection.

This package does not provide a standalone CLI or coding-agent service. Applications supply the `PiServerService` implementation.

`PiServerService.listSessions()` returns protocol `SessionMetadata`, not acquired runtime state. Services should map the durable fields their storage supports and may omit `updatedAt`, `parentSessionId`, `sessionName`, and `cwd`. `PiServer` refreshes available metadata from live snapshots without requiring stored sessions to fabricate phase, model, thinking-level, attachment, or lock values.

## Transport testing

Custom transports can use `@earendil-works/pi-server/testing` for deterministic protocol conformance tests. It exports `createTestServer()`, `TestServerService`, `ProtocolTestClient`, and the transport-neutral `WireChannel` contract. `connectUnixTestClient()` is provided for Unix transport tests.

## `pi-ai` protocol bridge

`@earendil-works/pi-ai` domain objects and `@earendil-works/pi-protocol` wire DTOs remain independent. This package owns their boundary and exports `toProtocolModelMetadata()`, `toProtocolAssistantMessage()`, `toProtocolUserMessage()`, and `toProtocolToolResultMessage()`.

The adapters reject invalid tool inputs, identifiers, timestamps, and mismatched tool results; `toProtocolToolResultMessage()` requires the original `ToolCall` so it can verify the association and convert its arguments itself. Diagnostic details are explicitly sanitized. Closed `pi-ai` unions are mapped exhaustively, and compile-time field manifests enumerate current `pi-ai` properties so additions require an explicit review. The protocol mirrors `pi-ai` vocabulary such as `toolCall` and `toolUse` where the semantics are identical. Protocol schemas enforce consistent lifecycle states, and tests encode adapter output through the runtime schemas so incompatible changes fail in the bridging package.
