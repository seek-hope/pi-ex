# Fork Compaction (pi-ex)

This document describes how pi-ex's context compaction differs from upstream pi
(see [compaction.md](compaction.md) for the upstream mechanism, which remains in
the tree but is not what the application runs). The fork implementation lives in
`src/core/compaction/fork.ts` (+ `fork-utils.ts`), keeping upstream
`compaction.ts`/`utils.ts` byte-identical to upstream pi.

## Differences from upstream

### Round-based cut point

Upstream walks backwards by token budget (`keepRecentTokens`). The fork keeps
the most recent `keepRecentRounds` **rounds** (default 2, configurable). A round
is bounded by user-like messages — a user message opens a new round, and a bash
execution block, custom message, branch summary, or compaction summary also
starts one. The cut always lands on a round boundary; rounds are never split
(if the kept rounds alone exceed the window, compaction cannot shrink them — in
practice `prune` stubs bulky tool outputs before it comes to that). Upstream's
split-turn machinery (mid-turn cuts with a separate turn-prefix summary) does
not exist in the fork pipeline.

### Full-fidelity serialization

The summarization request serializes the conversation losslessly: assistant
thinking blocks, tool calls with full arguments, and tool results are all
included **untruncated** (upstream truncates tool results to 2000 chars).
Oversized requests are handled structurally, not by lossy serialization: if the
request exceeds the model's context window, the oldest conversation rounds are
dropped from the request one at a time until it fits (the previous summary
keeps carrying that earlier state forward); the same drop-one-and-retry applies
when the provider rejects the request with a context-overflow error.

### Threshold

```
contextTokens > contextWindow * thresholdRatio
```

`contextTokens` is the request-scope usage after pruning, `thresholdRatio`
(default `0.9`) is the fraction of the window at which compaction fires.

## Structured Checkpoints (quality: "structured")

By default, compaction produces a **structured checkpoint** instead of a single
narrative summary. The checkpoint has four layers:

1. **Task Contract** — the authoritative statement of the user's current
   requirements: goal, constraints with explicit lifecycle
   (`ACTIVE`/`SUPERSEDED`/`UNRESOLVED` with supersession chains), user-confirmed
   decisions, and open questions. The intent compiler receives the **full
   conversation as role-tagged JSON** (no truncation, no heuristic message
   parsing): `"user"` entries are authoritative, `"assistant"` entries are
   present for context but explicitly marked untrusted, so abandoned approaches
   and early wrong assumptions cannot silently become requirements. The
   verifier pass then audits the compiled contract against the full transcript.
2. **World State** — a deterministic **Action Ledger** (file modifications,
   command executions, git commits, sub-agent operations) extracted from the
   message stream without an LLM, plus cumulative read/modified file tracking.
3. **Execution State** — current approach, done/in-progress/blocked, next steps,
   **model inferences explicitly marked unverified**, and external state
   observations with source/refresh hints.
4. **Verification Notes** — output of a verifier pass that audits the contract
   against the full transcript (missing constraints, wrongly superseded items,
   contradictions with tool-verified facts) and applies corrections.

The markdown checkpoint is what the model sees; the contract and ledger are also
stored as JSON in `CompactionEntry.details` (`version: 2`) so the next
compaction round and the `recall` tools can consume them.

Set `"compaction": { "quality": "standard" }` to restore the legacy narrative
summary. Overflow recovery always falls back to the standard path, and any
checkpoint failure falls back as well.

## Context pruning before compaction

Before compaction triggers, pi prunes bulky old read-only tool outputs
(read/bash/grep/find/ls) from the **context view**, replacing their entire
content with a metadata-only stub: tool name, approximate size, line count, and
a short recall handle (the toolCallId prefix). No output content is kept —
recall is the single retrieval path, and `recall`'s `toolCallId` parameter
returns the full original from the session archive directly (regardless of
compaction boundaries). Pruning often defers or avoids compaction entirely.
Configure via `compaction.prune`.

## Archive retrieval (recall)

Compaction only changes which entries are sent to the LLM — the session JSONL
tree is append-only and never deletes content. The built-in `recall` tool
searches the archived span by keyword/regex, file path, or exact entry id, and
`recall_checkpoints` lists past checkpoints. For a pruned tool output, pass
`toolCallId` (exact id or the 4+ character prefix shown in the prune stub) to
get the full original output directly — this works regardless of compaction
boundaries and without the search-snippet cap.
