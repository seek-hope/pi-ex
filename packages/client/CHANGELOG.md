# Changelog

## [Unreleased]

### Added

- Added a public `PiClient.request(command)` for arbitrary protocol commands, including the session-less `free` commands (`get_settings`/`set_setting`/`login`/`logout`/`import_session`) that no session handle can carry. Session-scoped commands should still go through a `PiSessionHandle` (which enforces lease gating).

- Moved the remote-transcript reducer into `@earendil-works/pi-client`: `createTranscriptState`, `applyTranscriptSnapshot`, `applyTranscriptProgress`, `selectTranscript`, and the `TranscriptState` type are now exported from the package root (previously lived in `packages/coding-agent/src/client/transcript.ts`). The reducer is browser-safe (protocol types + `structuredClone` only) and is consumed by the coding-agent `RemoteSession`.

- Added per-session cursor/resync state: clients apply only exact-next cursor events, ignore stale/duplicate events, and trigger exactly one in-flight `resync` on a forward gap; a successful resync atomically replaces the snapshot/cursor and clears gap state. `surface_update`, `interaction_request`, and `queue_update` events reduce into the reconstructable snapshot projections.

- Exposed a typed `SessionLease.request()`/`ResultForCommand<T>` path plus focused helpers (`resync`, `respondInteraction`, `followUp`, `clearQueue`, `setQueueMode`).

- Shared handles use the protocol's fail-closed read/mutation classifier: shared observers may `resync`/`detach` and issue typed read requests, while every mutation (including `respondInteraction`) fails locally with `PiSessionOwnershipError` with no wire request.

- Advanced the stored `SessionSnapshot.eventCursor` after every accepted exact-next event (including `session_progress`), reduced stale/duplicate events silently (never reduced nor delivered), and added monotonic same-revision/lower-cursor no-regress protection. A changed `serverId` invalidates session snapshots, cursors, attachments, gap state, and handles; `detach` projects `attached:false` and `lease.mode:null`.

### Breaking Changes

- `PiClient` sends `leaseMode` on `create`/`attach` and derives ownership from the authoritative `SessionSnapshot.lease.mode` and `lease_lost`; `SessionLease.prompt`/`steer`/`followUp` now accept structured `MessagePart` content, and shared handles reject mutations client-side while the server remains authoritative.

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Replaced `SessionSummary` with durable `SessionMetadata` for `PiClient.listSessions()` and server snapshots; runtime state is available only from acquired session snapshots ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added the experimental transport-neutral `PiClient` and multi-session `PiSessionHandle` APIs with structured `PiServerError` responses.
