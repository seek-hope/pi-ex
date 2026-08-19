# Fork Settings (pi-ex)

Settings added or changed by pi-ex relative to upstream pi (see
[settings.md](settings.md) for the upstream settings reference). Same locations:
`~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project).

## Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.reserveTokens` | number | `16384` | Budget for the summarization output tokens (`maxTokens = 0.8 × reserveTokens`); does not affect the compaction trigger |
| `compaction.keepRecentRounds` | number | `2` | Most recent rounds to keep (not summarized); the cut always lands on a round boundary. A round is bounded by user-like messages — a user message opens a new round, and a bash execution block, custom message, branch summary, or compaction summary also starts one |
| `compaction.thresholdRatio` | number | `0.9` | Compact when context usage exceeds this fraction of the context window |
| `compaction.quality` | `"structured"` \| `"standard"` | `"structured"` | Checkpoint format: structured (contract + ledger + verifier) or legacy narrative summary |
| `compaction.prune.enabled` | boolean | `true` | Prune bulky old read-only tool outputs from the context view before compaction |
| `compaction.prune.keepRecentToolResults` | number | `5` | Most recent eligible (over-threshold) tool outputs never pruned — small/error/image outputs don't consume protection slots |
| `compaction.prune.minPrunableTokens` | number | `1000` | Only prune results at or above this size |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "quality": "structured",
    "prune": {
      "enabled": true,
      "keepRecentToolResults": 5,
      "minPrunableTokens": 1000
    }
  }
}
```

Note: upstream's `compaction.keepRecentTokens` does not exist in the fork
pipeline (replaced by `keepRecentRounds`); see
[fork-compaction.md](fork-compaction.md).

## Todo

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `todo.enabled` | boolean | `true` | Enable the todo flow (`todo_write` tool, todo widget, `/todo` command) |

## Background Tasks

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `backgroundTasks.enabled` | boolean | `true` | Enable tmux background tasks (`bg_spawn`/`bg_status` tools, `/tasks` `/fg` `/kill` `/attach` commands) |

## SSH

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ssh.enabled` | boolean | `true` | Enable persistent SSH connections (`ssh_exec`/`ssh_status`/`scp_to_remote`/`scp_from_remote` tools, `/ssh` command) |

## Computer Use

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `computerUse.enabled` | boolean | `true` | Enable desktop automation (`computer_*` tools). Only takes effect on Hyprland/Wayland with grim/ydotool/wtype/hyprctl installed |

## Recall

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `recall.enabled` | boolean | `true` | Enable the `recall`/`recall_checkpoints` archive-retrieval tools |

## Sub-agents

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `subagents.enabled` | boolean | `true` | Enable in-process sub-agents (`subagent_*` tools, `/subagent` command) |
| `subagents.maxDepth` | number | `5` | Maximum recursive spawn depth |
| `subagents.maxConcurrent` | number | `5` | Maximum simultaneously running sub-agents |
| `subagents.timeout` | number | `7200` | Per-run timeout in seconds (2h) |

## Bash

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bash.exposeProviderSecrets` | boolean | `false` | Pass LLM provider secret env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) through to bash tool subprocesses. By default they are stripped so model-issued commands cannot read those keys back into the context |
