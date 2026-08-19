# Changelog

## [Unreleased]

### Breaking Changes

- Migrated the experimental CBOR protocol lockstep to v2 with no v1
  compatibility path. `create`/`attach` require a lease mode,
  prompt/steer/follow-up use structured content, and cursor-bearing session
  events require `eventCursor`.

### Added

- Added a browser-safe, fail-closed session command lease classifier
  (`commandLeaseRole` / `isSharedAllowedCommand`) shared by server and client so
  their read-vs-mutation decisions cannot drift. True read commands (tree,
  stats, review state, available models/thinking levels, todos, task output,
  tasks, ssh status, subagents) plus `resync`/`detach` are shared-safe; every
  other session command is a mutation.

- Added the Web UI protocol v2 contract: server-enforced lease projections,
  authoritative reconnect snapshots, structured text/image blob references,
  blocking interactions, reconstructable surfaces, resync, and typed
  command/result/event coverage for session, model, settings, shell, task,
  SSH, subagent, import/export, and tree-rewind workflows.
- Added typed model-cycle direction/outcomes, runtime-accurate tree navigation
  options/results with reverted and skipped-file reporting, and server-owned
  interaction timeouts.
- Added the `bash` transcript item (`BashTranscriptItemSchema`) so recorded
  shell executions (`bash` command) project into the transcript as a dedicated
  `role: "bash"` item carrying command/output/exit code (plus optional
  `cancelled`/`truncated`).

### Changed

- Added `unauthorized`, `interaction_timeout`, and `payload_too_large` protocol
  error codes.

### Removed

- Removed the v2 `run_btw` command and result schemas alongside the `/btw`
  side-query feature removal in the coding agent.

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.
- Replaced `SessionSummarySchema` and `SessionSummary` with durable `SessionMetadataSchema` and `SessionMetadata` for session lists; runtime state remains in acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
- Added `not_implemented` and `internal_error` protocol error codes for sanitized server failures ([#7644](https://github.com/earendil-works/pi/pull/7644)).
