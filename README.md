# pi-ex

> **pi-ex** is an enhanced fork of [pi-mono](https://github.com/earendil-works/pi-mono)
> that gives the pi coding agent **smarter context management**, **more reliable
> command routing**, and **stronger task orchestration**.

[![CI](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml/badge.svg)](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English**: [README.md](README.md) · **中文**: [README.zh-CN.md](README.zh-CN.md)

pi-ex stays in sync with upstream automatically (a GitHub Actions workflow tracks
upstream and only merges commits that passed upstream CI), adding a battle-tested
layer of enhancements on top. Version numbers carry a `-ex` suffix (e.g. `0.83.0-ex`).

---

## Feature Overview

| Area | Feature | Description |
|------|---------|-------------|
| **Command routing** | [Bash gate](#bash-gate) | Intercepts wasteful bash commands, steers the model to structured tools |
| | [Pipefail diagnostics](#pipefail-diagnostics) | Mid-pipeline failures are no longer silent |
| | [Timeout convention](#timeout-convention) | Unified seconds/milliseconds input, no unit confusion |
| **Context management** | [Structured pruning](#structured-pruning) | Tool-aware structured extraction at zero LLM cost |
| | [Uncertainty review](#uncertainty-review) | Inline marking + auto-ruling + compaction verification |
| | [Ask the user](#ask-and-wait) | `ask_user` — the model asks when analysis cannot determine intent |
| | [Wait and rest](#ask-and-wait) | `wait` — suspend the turn, auto-resume after N seconds |
| | [Post-edit scan](#post-edit-scan) | Codegraph scan after edit/write surfaces dangling references |
| | [Project diagnostics](#lsp-project-diagnostics) | Per-language CLI diagnostics (tsc/pyright/cargo/clangd) |
| | [File context tracking](#file-context-tracking) | Prevents silent overwrites of external edits |
| | [Recall](#recall) | Session archive lookup after compaction/pruning |
| **Task orchestration** | [Sub-agents](#sub-agents) | In-process delegation in isolated git worktrees, three modes |
| | [Background tasks](#bg-tasks) | tmux-persisted tasks, interactive list widget, model-side output/kill tools, auto-pruning |
| | [SSH integration](#ssh-integration) | Persistent remote exec, file transfer, remote monitoring, sudo password protection |
| | [Todo flow](#todo-flow) | Task list tool + staleness reminders + paged display |
| **Infrastructure** | [Upstream auto-sync](#upstream-auto-sync) | Continuous squash sync, conflict issues filed automatically |

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

## Bash Gate

bash is Turing-complete, but also the easiest tool to misuse: escaping errors,
unstructured output, and long output that wastes context. pi-ex performs
**shell-aware static analysis** (quoting/escaping/segment splitting) before a bash
command runs, intercepts commands that overlap with pi's structured tools, and
tells the model exactly what to use instead:

| bash command | redirected to | why |
|--------------|---------------|-----|
| `cat` / `head` / `tail` / `less` / `more` / `tac` / `bat` + file | `read()` | offset/limit, image support, no escaping issues |
| `sed` / `awk` / `perl` + script + file (read intent) | `read()` | script + file operands = disguised reads; stdin filters are unaffected |
| `cat <<EOF` / `echo` / `printf >` / `>>` | `write()` / `edit()` | auto-creates directories, no EOF delimiter mistakes |
| `sed -i` / `awk >` / `perl -pi` | `edit()` | exact string matching, no regex escaping bugs |
| `tail -f` / `less +F` | `bg_spawn()` | read only takes static snapshots; watch in background and get notified |
| `ssh` (non-git@) | `ssh_exec()` | reuses the persistent connection, no re-auth |
| `scp` | `scp_to_remote()` / `scp_from_remote()` | same |
| `tmux new` / `nohup` | `bg_spawn()` | task status tracking + cross-session resume |
| `sleep N` / `watch` / polling loops | auto-converted | pure `sleep N` becomes `wait()` (turn rests, clamped to the session cap); sleeps inside longer commands, `watch`, and `while/until` loops run as one background task — the model just types the command and the gate rewrites it |

Gate properties:

- **Shell tokenizer**: quoted content never false-triggers (`echo "2 > 1"` passes);
  escaped/quoted command words cannot bypass (`\cat file`, `'cat' file` blocked)
- **Segment splitting**: every segment after `&&`, `;`, `|` is checked
  independently (`foo && ssh host cmd` blocked)
- **Pipeline filters pass**: stdin filters like `npm test | tail -20` are legitimate
- **Wrapper/path hardening**: `sudo cat`, `/usr/bin/ssh`, `env FOO=1 ssh` cannot bypass
- **Sudo password protection**: when a model-run local `sudo` needs a
  password, the bash tool probes cached credentials first (`sudo -n`); if a
  password is required it pops a **masked input dialog** for the **user** —
  the password stays in session memory only (never persisted), is injected
  via a `SUDO_ASKPASS` temp file (0600, deleted after use) with `sudo -A`,
  and **never enters the model context**. Environments without a UI
  (headless, sub-agents) have no password channel and fail with a clear
  message (run it in your own terminal or configure NOPASSWD). Remote sudo
  protection lives in the [SSH integration](#ssh-integration).

## Timeout Convention

Every tool's timeout parameter accepts exactly two input forms:

```json
{ "timeout": 30 }           // bare number = seconds (default unit, uniform across tools)
{ "timeout": "30s" }       // suffixed string, explicit unit
{ "timeout": "500ms" }     // milliseconds must be written with the "ms" suffix
```

- Bare numbers are always interpreted as **seconds** (uniform across
  bash / bg_spawn / subagent_spawn / ssh_exec); expressing milliseconds requires
  the `"500ms"` suffix — unit confusion can no longer silently change behavior
- Invalid input (negatives, garbage suffixes) returns an explicit error listing
  the two valid forms
- Shared implementation: `TimeoutParamSchema` / `timeoutToMs` / `formatTimeout`
  (`utils/timeout.ts`, exported)

## Pipefail Diagnostics

A bash pipeline's exit code only reflects the last stage; mid-pipeline failures
are silently masked (`cat missing | grep x` returns grep's code). pi-ex implements
pipefail semantics at the bash layer: exit codes are captured per stage after
execution, and a mid-pipeline failure fails the whole command with the stage
annotated:

```
Pipeline stage 1/2 failed with code 1: `false`
```

- The model keeps the pipeline syntax it knows; failures come with full diagnostics
- **SIGPIPE exemption**: idioms like `yes | head -1` (consumer exits early)
  are not failures
- Non-bash shells and remote execution fall back to the original behavior

## Structured Pruning

Tool output is the main driver of context bloat in long sessions. Before
compaction, pi-ex performs **deterministic, LLM-free structured extraction** of
old tool output:

| tool | kept | dropped |
|------|------|---------|
| `read` | code skeleton: imports, function/class signatures, type declarations | function bodies |
| `bash` | error lines, highlighted lines, trailing summary | regular output |

- Compression-ratio validation: falls back to head-based truncation on failure
- Pruned stubs mark the original location; full content always remains in the
  session archive, recoverable via `recall`
- CJK-aware token estimation (Chinese chars ≈ 1 token instead of a systematic
  chars/4 underestimate)

## Uncertainty Review

Claims the model cannot directly verify (inferences, assertions about file
state, open questions) are tracked as **uncertainty entries**. The review
mechanism manages their full lifecycle: marking → ruling → compaction
verification → stale re-review, so unverified assumptions never harden into
facts for later turns.

### Marking

The system prompt requires the model to mark such statements inline:

```
[uncertain:inference] inferred content
[uncertain:state:path/to/file] claim about this file
[uncertain:question] open question
```

### Auto-ruling (default on, `auto: true`)

The model rules entries one by one in **newest → oldest** order
(verified / dismissed / corrected) — the latest turns represent the user's
current intent, and stale entries superseded by newer context are not revisited.
**User rulings are treated the same as model rulings and are re-reviewed too**;
overturning a user ruling requires a confirmation popup (Enter accepts / Esc
keeps, 300s timeout defaults to keeping). Trigger points:

1. **A user message conflicts with any entry (including decided ones)** —
   silently checked before responding, without blocking the conversation (primary)
2. **Before compaction** (secondary)

Everything runs silently and degrades quietly on failure. `auto: false` restores
the manual mode: a review popup appears when the agent run is idle —
`Enter` confirm, `c` correct, `d` dismiss, `Esc` defer until compaction.

### Corrections take effect immediately

Rulings/corrections are injected as follow-ups, so the model continues with the
corrected facts instead of compounding a bad assumption over dozens of turns.
At compaction, rulings feed a verify pass: verified/corrected entries are
promoted to confirmed facts, dismissed entries are no longer listed, and
undecided entries are reviewed afterwards. Dismissed entries are annotated
`[REVIEWED — dismissed by user]` in the summary.

### Stale ruling re-review

Rulings attached to a file are automatically **re-enqueued** when that file is
modified by edit/write (stale detection); invalidated rulings never carry into
a checkpoint.

### /review entry point

Opens anytime: first the unreviewed entries (✓ keep / ✗ abandon, no category
labels), then pending flags, then a browsable list of decided entries (which can
be moved back to pending or flipped). Decisions persist as session custom
entries (recording the ruling source user/model) and fully restore on resume.

### Configuration

`compaction.uncertaintyReview` in `settings.json`:
`timing: "incremental" | "at-compaction"` (default incremental),
`maxPerPrompt` (default 5), `auto` (default true).

## Post-Edit Scan

After a successful `edit`, identifiers removed/renamed by the change are looked
up through the registered codegraph tools (`codegraph_sync` incremental refresh
+ `codegraph_callers`) for dangling references, and the list is appended to the
edit result — the model sees "`X` still referenced in N places: file:line" in
the same turn and syncs them immediately. 5-second budget; missing/timeout/
failure all degrade silently and never block the edit result.
Disable with `settings.codeScan.enabled: false`.

## LSP Project Diagnostics

A unified project-wide diagnostic is a mirage — each language's type system
differs. After editing a batch of files, the model can call
`lsp_project_diagnostics` to run the most reliable backend per language:
TypeScript `tsc --noEmit`, Python `pyright`, Rust `cargo check`,
C/C++ `clangd --check` (degrades to per-file checks without
compile_commands.json).

## File Context Tracking

Tracks the state of files the model has touched (two-level cache plus idle
rotation, cache-architecture style):

- **read/write/edit results carry the file's last-modified time**
  (`[modified 2026-08-05 14:32:05 +0800]`, absolute time with UTC offset): the
  model can compare timestamps across two reads and detect changes itself,
  establishing an information-age baseline
- **L1 contact LRU (20 files, hash-precise)**: read/edit/write records content
  hashes; on re-contact the hash is compared — read annotates "previously seen
  content is stale", edit notes the edit applied to the current disk content
- **L2 change set**: files detected as externally changed (idle rotation /
  touch-time checks)
- **L3 project-wide rotation**: `git ls-files` path set plus a cursor; starts
  when the model turn ends (idle), stops when the next user input arrives,
  sweeping mtimes at full speed (no fixed budget; a completed sweep stops
  until the next idle window); L1 files are checked first every sweep
- **Delta notifications**: before each turn, unseen stale files are injected as
  one notice (`[file-state] N files you have seen changed on disk since your
  last read — re-read before relying on them`); notified files are re-reported
  only after they change again; a fresh read clears the stale mark
- `write` verifies the on-disk hash matches what the model has in context
  first; on mismatch it refuses and tells the model to `read()` first (hard
  protection)
- `edit` does **not** hard-check: region matching is its own protection — a
  missing oldText errors (the model re-reads)
- Non-git directories degrade gracefully: rotation covers only touched files

## Recall

The full session content before every compaction is kept in an archive. The
`recall` tool searches the archive by keyword, regex, file path, or entry ID to
recover output that was pruned or compacted away.

## Sub-Agents

In-process multi-agent delegation; each sub-agent works in its own git worktree
and commits automatically when done:

```
subagent_spawn({ task: "Refactor error handling in the auth module", mode: "execute" })
// → on completion: subagent_review → subagent_merge / subagent_reject

subagent_parallel({ tasks: ["Task A", "Task B", "Task C"], maxConcurrency: 5 })
```

Three modes:

| mode | toolset | use case |
|------|---------|----------|
| `analyze` | bash + read (read-only) | code review, research report |
| `improve` | full (read/edit/write/bash) | improve existing code |
| `execute` | full | end-to-end implementation |

- Failed/timed-out runs auto-commit partial work; worktree is cleaned up only
  when there is nothing valid to commit
- Crash-safe: each run persists `.pi/subagent/meta/<id>.json`, so after a pi
  restart the sub-agent is re-registered as `interrupted` (visible in
  `subagent_list`, reviewable/mergable/rejectable) and `subagent_continue`
  resumes it in the same worktree — partial work is never stranded
- Explicit cancel is strictly distinguished from timeout (`cancelled` vs `timeout`)
- `/subagent` lists all agents and their status

## BG Tasks

`bg_spawn` runs long tasks in tmux; tasks survive pi session restarts.
The running-tasks widget is an **interactive list** (`/tasks` to open,
↑/↓ select, `Enter` view output, `k` kill, `Esc` back); `/fg <id>` shows
the last 50 lines (`/fg <id> --full` shows everything), `/kill <id>` stops,
`/attach <id>` attaches live. Model-side tools: `bg_status`, `bg_output`
(tail a task's log), `bg_kill`. Finished tasks are **pruned immediately**
— the completion notification carries the output, then the record and log
are gone; only running tasks appear in the list. Multiple completions
merge into one notification.

## Ask and Wait

Two tools help the model behave like a careful collaborator instead of a
head-down guesser:

- **`ask_user(questions)`** — when the model's analysis and reasoning cannot
determine the user's intent, it asks instead of guessing. All questions in one
call are asked consecutively (one dialog each) and the answers return together.
Interactive sessions show the dialog to the **user**; headless sessions have no
dialog and the tool fails with guidance to proceed with a flagged assumption.
- **`wait(duration_seconds)`** — after starting a long-running background task
with nothing useful to do right now, the model suspends the turn instead of
busy-waiting or polling. The turn resumes automatically when the wait
completes (fixed guidance + the running background-task list); background-task
completions wake the agent earlier through the regular notification channel.
Interactive sessions allow waits up to 12 hours; headless sessions allow up to
120 seconds, 5 uses per session. Any new user input cancels a pending wait.

## SSH Integration

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

## Todo Flow

- `todo_write` maintains the task list; the widget renders it live
  (actionable-first ordering)
- When the list is long the main widget stays bounded; `/todo` pages through the
  **remaining entries** the widget cannot fit (no duplication)
- **Staleness reminder**: if 8 consecutive user inputs leave unfinished items
  untouched, a reminder is injected asking the model to clean up; if the model
  ignores it, the timer restarts 8 inputs from the reminder round (the items are
  likely still unfinished) instead of spamming every turn

## Upstream Auto-Sync

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

---

## Installation

```bash
git clone --recurse-submodules https://github.com/seek-hope/pi-ex.git
cd pi-ex
npm install --ignore-scripts
npm run build
npm link            # register the pi command globally
```

Verify:

```bash
pi --version      # 0.83.0-ex (the -ex suffix marks the fork)
```

## Updating from Upstream

Usually no manual action is needed — [upstream auto-sync](#upstream-auto-sync)
handles it. Manual trigger:

```bash
git fetch upstream
# squash sync: merge the fork work onto the new upstream and re-parent it
git merge --squash origin/upstream-image   # resolve conflicts manually if any
git reset --soft origin/upstream-image
git commit -m "squash: fork work onto upstream <sha>"
git push --force-with-lease origin main
```

> **Note**: the globally registered `pi` (via `npm link`) runs the `dist/`
> build artifacts, not the source. Any source change (upstream sync, local
> fixes) requires a fresh `npm run build`, otherwise both running and newly
> started pi sessions keep using the old code.
>
> **For development iteration, use the watch mode**: `node scripts/dev-watch.mjs`
> stays resident and incrementally compiles each package's `dist/` on every
> save (offline — it never runs `generate-models`). Newly started pi sessions
> pick up the new code immediately; already-running sessions need a restart.
> First start does a dependency-ordered full compile (~1–2 min); afterwards
> each change takes tens of milliseconds. A full `npm run build` (including the
> models.dev catalog refresh) is only needed before releases.

## Relationship to Upstream

pi-ex contains the full upstream pi-mono feature set: multi-model support
(OpenAI, Anthropic, Google, DeepSeek, Qwen, ...), the interactive TUI, the
extension system, skills, prompt templates, and more.

All fork-specific changes live in `main`'s incremental commits on top of
`upstream-image`, keeping the boundary clean and continuously squash-syncable.
The extension set (codegraph, lsp, docrelay, ...) is maintained as a git
submodule at [.pi/extensions](.pi/extensions) (standalone repo
[pi-extensions](https://github.com/seek-hope/pi-extensions)), symlinked from
`~/.pi/agent/extensions` so it is available in every directory.

## Development

```bash
npm run check         # lint + type checks + dependency validation
./test.sh             # full test suite in an isolated environment (non-e2e)
```

## License

MIT (same as upstream)

---

Based on [pi-mono](https://github.com/earendil-works/pi-mono) by [earendil-works](https://github.com/earendil-works)
