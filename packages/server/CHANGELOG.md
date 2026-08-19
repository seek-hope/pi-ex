# Changelog

## [Unreleased]

### Added

- Added `PiServerService.importSession?(blob)` — a dedicated hook for the `import_session` command (distinct from the sessionId-less `free` commands). The server routes `import_session` to this hook (failing closed `not_implemented` when absent), then acquires + exclusively attaches the returned session and injects the server-projected snapshot into the result (mirroring `create`; an import creates a new session owned by the requester). The hook only materializes a durable session and reports its id — it never fabricates a snapshot.

- Added an optional `PiServerService.executeFreeCommand` hook for the sessionId-less `free` commands (`get_settings`/`set_setting`/`login`/`logout`). The server routes them to the hook without lease checks (matching the `free` role in `commandLeaseRole`) and fails closed with `not_implemented` when the hook is absent or declines a command. `import_session` continues to be handled by the dedicated `importSession` hook rather than `executeFreeCommand`.

- Added live-session re-keying for id-changing session replacements (`fork`/`clone`): when a runtime's snapshot id changes, the server atomically moves the `liveSessions` registration, every connection lease, and the monotonic `eventCursor` to the new id on the session queue, and the mutation result plus broadcast carry the new session snapshot. Previously this threw `invalid_request` and terminated the session.

- Added a server-owned monotonic safe-integer `eventCursor` per session (preserved across idle runtime reopen) with deterministic overflow treated as an internal error requiring resync; cursor-bearing `session_progress`/`surface_update`/`interaction_request`/`queue_update` events receive the exact next cursor.

- Added `resync` returning a correlated authoritative snapshot, and sanitized `not_implemented` responses for typed-but-unimplemented session commands.

- Serialized every per-session runtime event, cursor allocation, snapshot capture, and fan-out through a per-session async queue. Snapshot broadcasts and `resync` read a queued authoritative snapshot, capture their cursor watermark before awaiting the runtime, and await ordered sends; `resync` does not broadcast a `session_snapshot` to every client.

- Split `executeCommand` on the shared read/mutation classifier: reads return typed runtime data under any attachment, mutations run under the exclusive lease, broadcast a normalized authoritative snapshot, and receive the server-projected `session` (runtimes never fabricate `attached`/`locked`/`lease`/`eventCursor`).

### Breaking Changes

- Enforced server-side session leases: `create`/`attach` require a `leaseMode`; at most one exclusive controller and any number of shared observers per session. Shared observers may read/resync/detach but every mutation (including `respond_interaction`) is rejected with `unauthorized`, and a conflicting exclusive acquisition returns `session_locked`.

- `PiSessionRuntime` snapshots no longer carry connection-owned `attached`/`locked`/`lease`/`eventCursor` fields; runtimes return a `PiSessionRuntimeSnapshot` and the server projects the authoritative values. Runtimes may emit `surface`, `interaction`, and `queue` events and implement an optional `executeCommand` hook for the remaining typed command surface.

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Changed `toProtocolToolResultMessage()` to require the original `ToolCall` and verify tool result association.
- Changed `PiServerService.listSessions()` to return durable `SessionMetadata` instead of runtime `SessionSummary` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Fixed

- Hardened protocol adapters against contradictory lifecycle states, invalid identifiers and timestamps, sparse execution arrays, and additive `pi-ai` contract drift.
- Sanitized service and runtime failures into stable `not_implemented` and `internal_error` responses without exposing private error details ([#7644](https://github.com/earendil-works/pi/pull/7644)).

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
