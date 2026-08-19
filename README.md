# pi-ex

> **pi-ex** is an enhanced fork of [pi-mono](https://github.com/earendil-works/pi-mono).
> It keeps pi's minimal core and removes the friction that shows up in long, real
> coding sessions: unreliable shell commands, rotting context, and work you have
> to babysit.

[![CI](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml/badge.svg)](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English**: [README.md](README.md) · **中文**: [README.zh-CN.md](README.zh-CN.md)

pi-ex tracks upstream automatically (a workflow syncs only commits that passed
upstream CI) and adds a battle-tested layer on top. Version numbers carry an
`-ex` suffix (e.g. `0.84.2-ex`). This README walks through a pi-ex session the
way you will actually meet its features — from the first prompt to long-running,
multi-agent, remote work.

---

## Getting Started

```bash
git clone --recurse-submodules https://github.com/seek-hope/pi-ex.git
cd pi-ex
npm install --ignore-scripts
npm run build
npm link            # register the pi command globally

pi --version        # 0.84.2-ex (the -ex suffix marks the fork)
```

`npm link` runs the `dist/` build artifacts, not the source. After any source
change you need a fresh build — for iteration, keep `node scripts/dev-watch.mjs`
resident instead: it incrementally recompiles on every save (offline; never
refreshes the model catalog), and newly started sessions pick up the change
immediately. A full `npm run build` (including the models.dev catalog refresh)
is only needed before releases.

Everything below works out of the box; no configuration is required unless a
section says so.

## Part 1 — Everyday Reliability: Commands That Behave

The first thing you notice after a few prompts: the model stops doing wasteful
shell things. That is the **bash gate**.

### Bash gate

bash is Turing-complete, but also the easiest tool to misuse: escaping errors,
unstructured output, and long output that wastes context. Before a bash command
runs, pi-ex performs **shell-aware static analysis** (quoting/escaping/segment
splitting) and intercepts commands that overlap with pi's structured tools,
telling the model exactly what to use instead:

| bash command | redirected to | why |
|--------------|---------------|-----|
| `cat <<EOF` / `echo` / `printf >` / `>>` / `cat >` | `write()` / `edit()` | auto-creates directories, no EOF delimiter mistakes |
| `sed -i` / `awk >` / `perl -pi` | `edit()` | exact string matching, no regex escaping bugs |
| `less` / `more` + file; `sed` / `awk` / `perl` + script + file (read intent) | `read()` | offset/limit, image support; stdin filters are unaffected |
| `tail -f` / `less +F` | `bg_spawn()` | read only takes static snapshots; watch in background and get notified |
| `ssh` (non-git@) | `ssh_exec()` | reuses the persistent connection, no re-auth |
| `scp` | `scp_to_remote()` / `scp_from_remote()` | same |
| `tmux new` / `nohup` | `bg_spawn()` | task status tracking + cross-session resume |
| `bash -c` / `sh -c` / `bash -s` | flattened | nested commands become visible to the gate |
| `sleep N` / `watch` / polling loops | auto-converted | pure `sleep N` becomes `wait()` (turn rests, clamped to the session cap); sleeps inside longer commands, `watch`, and `while/until` loops run as one background task — the model just types the command and the gate rewrites it |

Plain file reads (`cat`, `head`, `tail <file>`) are intentionally **not** gated —
the gate only intercepts patterns that duplicate a pi tool with worse reliability.

Gate properties:

- **Shell tokenizer**: quoted content never false-triggers (`echo "2 > 1"` passes);
  escaped/quoted command words are normalized before matching
- **Segment splitting**: every segment after `&&`, `;`, `|` is checked
  independently (`foo && ssh host cmd` blocked)
- **Pipeline filters pass**: stdin filters like `npm test | tail -20` are legitimate
- **Wrapper/path hardening**: `sudo ssh`, `/usr/bin/ssh`, `env FOO=1 ssh` cannot bypass
- **Sudo password protection**: when a model-run local `sudo` needs a password,
  the bash tool probes cached credentials first (`sudo -n`); if a password is
  required it pops a **masked input dialog** for the **user** — the password
  stays in session memory only (never persisted), is injected via a
  `SUDO_ASKPASS` temp file (0600, deleted after use) with `sudo -A`, and
  **never enters the model context**. Headless environments have no password
  channel and fail with a clear message (run it in your own terminal or
  configure NOPASSWD). Remote sudo lives in the [SSH integration](#part-4--delegation-parallel-and-remote-work).

### One timeout convention everywhere

Every tool's timeout parameter accepts exactly two input forms:

```json
{ "timeout": 30 }           // bare number = seconds (default unit, uniform across tools)
{ "timeout": "30s" }       // suffixed string, explicit unit
{ "timeout": "500ms" }     // milliseconds must be written with the "ms" suffix
```

Bare numbers are always **seconds** (bash / bg_spawn / subagent_spawn / ssh_exec);
milliseconds require the `"500ms"` suffix — unit confusion can no longer
silently change behavior. Invalid input (negatives, garbage suffixes) returns an
explicit error listing the two valid forms. Shared implementation:
`TimeoutParamSchema` / `timeoutToMs` / `formatTimeout` (`utils/timeout.ts`).

### Pipefail diagnostics

A bash pipeline's exit code only reflects the last stage; mid-pipeline failures
are silently masked (`cat missing | grep x` returns grep's code). pi-ex gives
the bash layer pipefail semantics: exit codes are captured per stage, and a
mid-pipeline failure fails the whole command with the stage annotated:

```
Pipeline stage 1/2 failed with code 1: `false`
```

The model keeps the pipeline syntax it knows; failures come with full
diagnostics. **SIGPIPE exemption**: idioms like `yes | head -1` (consumer exits
early) are not failures. Non-bash shells and remote execution fall back to the
original behavior.

## Part 2 — Long Tasks: Work You Don't Have to Watch

Sooner or later the model needs to run something slow — a build, a test suite, a
download. pi-ex makes long tasks fire-and-forget instead of blocking the session.

### Background tasks

`bg_spawn` runs long tasks in tmux; tasks survive pi session restarts. The
running-tasks widget is an **interactive list** (`/tasks` to open, ↑/↓ select,
`Enter` view output, `k` kill, `Esc` back); `/fg <id>` shows the last 50 lines
(`/fg <id> --full` shows everything), `/kill <id>` stops, `/attach <id>`
attaches live. Model-side tools: `bg_status`, `bg_output` (tail a task's log),
`bg_kill`. Finished tasks are **pruned immediately** — the completion
notification carries the output, then the record and log are gone; only running
tasks appear in the list. Multiple completions merge into one notification.

### `wait` and `ask_user`

Two tools make the model behave like a careful collaborator instead of a
head-down guesser:

- **`wait(duration_seconds)`** — after starting a background task with nothing
  useful to do right now, the model suspends the turn instead of busy-waiting or
  polling. The turn resumes automatically when the wait completes;
  background-task completions wake the agent earlier through the regular
  notification channel. Interactive sessions allow waits up to 12 hours;
  headless sessions up to 120 seconds, 5 uses per session. Any new user input
  cancels a pending wait.
- **`ask_user(questions)`** — when analysis cannot determine your intent, the
  model asks instead of guessing. All questions in one call are asked
  consecutively (one dialog each) and the answers return together. Interactive
  sessions show the dialog to **you**; headless sessions have no dialog and the
  tool fails with guidance to proceed with a flagged assumption.

## Part 3 — Long Sessions: Context That Doesn't Rot

An hour into a real task, the session has seen hundreds of tool calls. pi-ex
keeps that context accurate, bounded, and recoverable.

### File context tracking

Tracks the state of files the model has touched (two-level cache plus idle
rotation, cache-architecture style):

- **read/write/edit results carry the file's last-modified time**
  (`[modified 2026-08-05 14:32:05 +0800]`, absolute time with UTC offset): the
  model can compare timestamps across two reads and detect changes itself
- **L1 contact LRU (20 files, hash-precise)**: read/edit/write records content
  hashes; on re-contact the hash is compared — read annotates "previously seen
  content is stale", edit notes the edit applied to the current disk content
- **L2 change set**: files detected as externally changed (idle rotation /
  touch-time checks)
- **L3 project-wide rotation**: `git ls-files` path set plus a cursor; runs
  while the agent is idle, sweeping mtimes at full speed; L1 files are checked
  first every sweep
- **Delta notifications**: before each turn, unseen stale files are injected as
  one notice (`[file-state] N files you have seen changed on disk since your
  last read — re-read before relying on them`); a fresh read clears the mark
- `write` hard protection: if a third party (you in your editor, another
  agent/session, a formatter, `git checkout`) changed the file since the model
  last saw it, the write is refused with a hint to `read()` first — the model
  never overwrites a state it doesn't know about. New files and files the
  model hasn't touched write freely, so intentional overwrites are never blocked
- `edit` does **not** hard-check: region matching is its own protection — a
  missing oldText errors (the model re-reads)
- Non-git directories degrade gracefully: rotation covers only touched files

You notice this when you edit a file in your own editor mid-session: the model
stops overwriting your changes.

### Structured pruning

Tool output is the main driver of context bloat. Before compaction, pi-ex
performs **deterministic, LLM-free structured extraction** of old tool output:

| tool | kept | dropped |
|------|------|---------|
| `read` | code skeleton: imports, function/class signatures, type declarations | function bodies |
| `bash` | error lines, highlighted lines, trailing summary | regular output |

Compression-ratio validation falls back to head-based truncation on failure.
Pruned stubs mark the original location; the full content always remains in the
session archive, recoverable via `recall`. Token estimation is CJK-aware
(Chinese chars ≈ 1 token instead of a systematic chars/4 underestimate).

### Context-window-safe compaction

Compaction requests are budgeted against the model's context window. If the
summarization request is too large, pi-ex sheds detail in a fixed order instead
of failing: thinking blocks are dropped entirely, tool calls keep name + input
(with a success/failure marker, never the output), then the oldest conversation
rounds are dropped one at a time. If the provider still rejects the request for
context overflow, oldest rounds are shed one at a time with a retry — no more
all-or-nothing compaction failures at the worst moment.

### Recall

The full session content before every compaction is kept in an archive. The
`recall` tool searches the archive by keyword, regex, file path, or entry ID to
recover output that was pruned or compacted away.

### Uncertainty review

Claims the model cannot directly verify (inferences, assertions about file
state, open questions) are tracked as **uncertainty entries**, managed through
their full lifecycle: marking → ruling → compaction verification → stale
re-review — so unverified assumptions never harden into facts for later turns.

**Marking.** The system prompt requires inline markers:

```
[uncertain:inference] inferred content
[uncertain:state:path/to/file] claim about this file
[uncertain:question] open question
```

**Auto-ruling (default on, `auto: true`).** The model rules entries one by one
in **newest → oldest** order (verified / dismissed / corrected) — the latest
turns represent your current intent, and stale entries superseded by newer
context are not revisited. **User rulings are treated the same as model rulings
and are re-reviewed too**; overturning a user ruling requires a confirmation
popup (Enter accepts / Esc keeps, 300s timeout defaults to keeping). Trigger
points:

1. **A user message conflicts with any entry (including decided ones)** —
   silently checked before responding, without blocking the conversation (primary)
2. **Before compaction** (secondary)

Everything runs silently and degrades quietly on failure. `auto: false` restores
the manual mode: a review popup appears when the agent run is idle —
`Enter` confirm, `c` correct, `d` dismiss, `Esc` defer until compaction.

**Corrections take effect immediately.** Rulings are injected as follow-ups, so
the model continues with the corrected facts instead of compounding a bad
assumption over dozens of turns. At compaction, rulings feed a verify pass:
verified/corrected entries are promoted to confirmed facts, dismissed entries
are annotated `[REVIEWED — dismissed by user]`, and undecided entries are
reviewed afterwards.

**Stale ruling re-review.** Rulings attached to a file are automatically
re-enqueued when that file is modified by edit/write; invalidated rulings never
carry into a checkpoint.

**/review entry point.** Opens anytime: first the unreviewed entries (✓ keep /
✗ abandon, no category labels), then pending flags, then a browsable list of
decided entries (which can be moved back to pending or flipped). Decisions
persist as session custom entries (recording the ruling source user/model) and
fully restore on resume.

**Configuration.** `compaction.uncertaintyReview` in `settings.json`:
`timing: "incremental" | "at-compaction"` (default incremental),
`maxPerPrompt` (default 5), `auto` (default true).

### Post-edit scan

After a successful `edit`, identifiers removed/renamed by the change are looked
up for dangling references via the codegraph CLI (`codegraph callers`, invoked
directly — read-only; codegraph's daemon keeps the index fresh on file changes,
so no sync step is needed), and the list is appended to the edit result — the
model sees "`X` still referenced in N places: file:line" in the same turn and
syncs them immediately. 5-second budget; missing binary/index, timeout, or
failure all degrade silently and never block the edit result.
Disable with `settings.codeScan.enabled: false`.

### LSP project diagnostics

A unified project-wide diagnostic is a mirage — each language's type system
differs. After editing a batch of files, the model can call
`lsp_project_diagnostics` to run the most reliable backend per language:
TypeScript `tsc --noEmit`, Python `pyright`, Rust `cargo check`,
C/C++ `clangd --check` (degrades to per-file checks without
compile_commands.json).

## Part 4 — Delegation: Parallel and Remote Work

### Todo flow

- `todo_write` maintains the task list; the widget renders it live
  (actionable-first ordering)
- When the list is long the main widget stays bounded; `/todo` pages through the
  **remaining entries** the widget cannot fit (no duplication)
- **Staleness reminder**: if 8 consecutive user inputs leave unfinished items
  untouched, a reminder is injected asking the model to clean up; if the model
  ignores it, the timer restarts 8 inputs from the reminder round (the items are
  likely still unfinished) instead of spamming every turn

### Sub-agents

In-process multi-agent delegation, LEGO-style: single agents and parallel
batches are the blocks, `dependsOn` is the execution ordering, and the
model assembles them into workflows.

Two paths per agent — like OS processes sharing files: readers share,
writers get a private copy (COW):

| path | directory | toolset | deliverable |
|------|-----------|---------|-------------|
| write (default) | dedicated git worktree | full (read/edit/write/bash) | auto-commit + `subagent_review` → `subagent_merge` / `subagent_reject` |
| `readOnly: true` | **shared project dir** | bash (write-gated) + read | the report itself — no worktree/commit/review ceremony |

The read-only path mechanically cannot write (no edit/write tools, bash
rejects write-like commands), so tasks that produce no file changes
(research, analysis, Q&A) never touch the working tree by accident.

```
subagent_spawn({ task: "Refactor error handling in the auth module" })
// → on completion: subagent_review → subagent_merge / subagent_reject

subagent_spawn({ task: "Map the call graph of the sync engine", readOnly: true })
// → report only, zero git footprint

subagent_parallel({ tasks: ["Task A", "Task B", { task: "Task C", readOnly: true }] })

// Workflow composition: B and C start once A completes, with A's report
// injected into their prompts; a failed dependency cascade-cancels its
// dependents.
subagent_spawn({ task: "Implement the schema", ... })        // → sa-a
subagent_spawn({ task: "Write the tests", dependsOn: ["sa-a"] })
subagent_spawn({ task: "Update the docs", dependsOn: ["sa-a"], readOnly: false })
```

- No per-agent completion spam: when the **last** running/queued agent
  settles, the parent gets one wake-up and collects all reports via
  `subagent_list`
- `subagent_message({ id, message })` steers a running agent at its next
  turn, or amends a queued agent's prompt — course correction without
  cancelling
- Failed/timed-out runs auto-commit partial work; the worktree is cleaned up
  only when there is nothing valid to commit
- Crash-safe: each run persists `.pi/subagent/meta/<id>.json`, so after a pi
  restart the sub-agent is re-registered as `interrupted` (visible in
  `subagent_list`, reviewable/mergable/rejectable) and `subagent_continue`
  resumes it in the same worktree — partial work is never stranded
- `subagent_followup` re-tasks a finished sub-agent in its existing worktree and
  branch, with an optional cheaper model override for well-scoped leaf tasks
- Explicit cancel is strictly distinguished from timeout (`cancelled` vs `timeout`)
- `/subagent` lists all agents and their status

The sub-agent kernel (worktree lifecycle, DAG scheduling, crash-resume
metadata, follow-up state machine, spawn-tree tracking, concurrency caps) is
extracted into `packages/subagent-core` as a runtime-agnostic package, so the
same isolation semantics can be driven from other harnesses without forking
this logic.

### SSH integration

- `/ssh <host>` establishes a persistent connection (ControlMaster reuse, no
  repeated auth)
- **Jump hosts**: aliases with `ProxyJump` in ssh config work out of the box
  (`/ssh lulab_via_vps`); `-J` form is also supported
  (`/ssh -J user@bastion user@target`). The same endpoint via different jumps
  or direct connects gets its own connection; the wait window for multi-stage
  interactive auth is 90 seconds. Note: the jump connection is held by a keeper
  terminal window (the proxy child's lifetime is bound to that window) —
  **keep the window open**; closing it disconnects
- `ssh_exec` remote execution (>300s automatically suggests background mode)
- `scp_to_remote` / `scp_from_remote` file transfer
- Remote background task notifications are **isolated per session** — never
  delivered to other sessions; multiple completions merge into one turn
- **sudo support**: the first `sudo` the model runs prompts the **user** for the
  password (masked input, memory-only, never persisted, never enters the model
  context); `/ssh sudo <host>` sets and verifies it upfront. The password is
  injected via a remote shell function; subsequent `sudo ...` just work

## Part 5 — The Fork Itself

### Upstream auto-sync

`.github/workflows/sync-upstream.yml` checks upstream every 5 minutes and syncs
with a **squash strategy**:

1. When upstream has new commits and its `build-check-test` CI passed, the
   repo's fork work (net diff against `upstream-image`) is **squashed into a
   single commit** on top of the new upstream, keeping `main` a direct
   descendant of `upstream-image` (GitHub shows ahead N / behind 0)
2. On merge conflicts an `[upstream-sync]` Issue is filed for manual resolution
   (stale conflict issues are auto-closed on success or on a fresh conflict, so
   they never pile up)
3. The `upstream-image` branch doubles as the squash target and the
   change-detection pointer

This guarantees pi-ex only ever merges code that passed upstream CI, and each
sync produces at most one conflicting commit to resolve (instead of replaying
the whole fork history).

Manual trigger, when you need it:

```bash
git fetch upstream
git merge --squash origin/upstream-image   # resolve conflicts manually if any
git reset --soft origin/upstream-image
git commit -m "squash: fork work onto upstream <sha>"
git push --force-with-lease origin main
```

### Relationship to upstream

pi-ex contains the full upstream pi-mono feature set: multi-model support
(OpenAI, Anthropic, Google, DeepSeek, Qwen, ...), the interactive TUI, the
extension system, skills, prompt templates, and more.

All fork-specific changes live in `main`'s incremental commits on top of
`upstream-image`, keeping the boundary clean and continuously squash-syncable.
The extension set (codegraph, lsp, docrelay, ...) is maintained as a git
submodule at [.pi/extensions](.pi/extensions) (standalone repo
[pi-extensions](https://github.com/seek-hope/pi-extensions)), symlinked from
`~/.pi/agent/extensions` so it is available in every directory.

### Package map

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI (TUI) |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-subagent-core](packages/subagent-core)** | Runtime-agnostic sub-agent kernel: worktree isolation, lifecycle, crash-resume, follow-ups |
| **[@earendil-works/pi-protocol](packages/protocol)** | Transport-neutral CBOR protocol for remote pi sessions |
| **[@earendil-works/pi-client](packages/client)** | Client for remote pi sessions over framed CBOR bytes |
| **[@earendil-works/pi-server](packages/server)** | Experimental server fronting pi sessions over the protocol |

### Development

```bash
npm run check         # lint + type checks + dependency validation
./test.sh             # full test suite in an isolated environment (non-e2e)
```

## License

MIT (same as upstream)

---

Based on [pi-mono](https://github.com/earendil-works/pi-mono) by [earendil-works](https://github.com/earendil-works)
