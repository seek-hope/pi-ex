# pi-ex

> **pi-ex** 是 [pi-mono](https://github.com/earendil-works/pi-mono) 的增强分支（fork），
> 为 pi 编码代理提供**更智能的上下文管理**、**更可靠的命令路由**和**更强的任务编排能力**。

[![CI](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml/badge.svg)](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English**: [README.md](README.md) · **中文**: [README.zh-CN.md](README.zh-CN.md)

pi-ex 与上游保持自动同步（GitHub Actions 持续跟踪，仅合入上游 CI 通过的提交），
并在此基础上增加了一层经过实战检验的增强功能。版本号以 `-ex` 后缀标识（如 `0.83.0-ex`）。

---

## 功能总览

| 类别 | 功能 | 说明 |
|------|------|------|
| **命令路由** | [Bash 门控](#bash-门控bash-gate) | 拦截低效 bash 命令，引导至更可靠的结构化工具 |
| | [管线失败诊断](#管线失败诊断pipefail) | bash 管道链中间阶段失败不再静默 |
| | [timeout 参数约定](#timeout-参数约定) | 统一秒/毫秒输入，杜绝单位混淆 |
| **上下文管理** | [智能修剪](#智能上下文修剪structured-pruning) | 零 LLM 成本的工具感知结构化提取 |
| | [不确定条目审查](#不确定条目审查uncertainty-review) | 即时标记 + 自动裁决 + 压缩核验，防止错误沉淀 |
| | [提问与等待](#提问与等待ask-and-wait) | `ask_user` 无法推理出意图时主动提问；`wait` 挂起回合定时恢复 |
| | [编辑后引用扫描](#编辑后引用扫描post-edit-scan) | edit/write 后 codegraph 增量扫描，残留引用自动提示 |
| | [项目级诊断](#项目级诊断lsp-project-diagnostics) | 按语言 CLI 跑全项目诊断（tsc/pyright/cargo/clangd） |
| | [文件上下文追踪](#文件上下文追踪) | write 前防静默覆盖外部修改 |
| | [记忆与召回](#记忆与召回recall) | 会话归档检索，压缩后可找回原始输出 |
| **任务编排** | [子代理](#子代理sub-agent) | 进程内多代理委托，git worktree 隔离，三种模式 |
| | [后台任务](#后台任务bg-tasks) | tmux 持久化任务，可交互列表 widget，模型侧输出/终止工具，自动回收 |
| | [SSH 集成](#ssh-集成) | 持久连接远程执行、文件传输、远程监控、sudo 密码保护 |
| | [Todo 流](#todo-流) | 任务清单工具 + 过期提醒 + 分页展示 |
| **基础设施** | [上游自动同步](#上游自动同步) | GitHub Actions 持续 squash 同步，冲突自动建 Issue |

| 包 | 说明 |
|----|------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 厂商中立遥测契约、参考适配器、一致性测试与类型化 schema |
| **[@earendil-works/pi-ai](packages/ai)** | 统一多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 带工具调用与状态管理的 Agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码 Agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 差分渲染终端 UI 库 |

---

## Bash 门控（Bash Gate）

bash 是图灵完备的，但也是最容易出错的工具：转义错误、输出无结构、长输出浪费上下文。
pi-ex 在 bash 执行前对命令做 **shell 感知的静态分析**（引号/转义/段分割），拦截与
pi 工具功能重叠的命令，并明确告诉模型应该用什么：

| bash 命令 | 被引导至 | 理由 |
|-----------|----------|------|
| `cat` / `head` / `tail` / `less` / `more` / `tac` / `bat` + 文件 | `read()` | offset/limit、图片识别、无转义问题 |
| `sed` / `awk` / `perl` + 脚本 + 文件（读取用途） | `read()` | 脚本+文件操作数=伪装读取；stdin 过滤器不受影响 |
| `cat <<EOF` / `echo` / `printf >` / `>>` | `write()` / `edit()` | 自动建目录、无 EOF 分隔符错误 |
| `sed -i` / `awk >` / `perl -pi` | `edit()` | 精确字符串匹配，无正则转义 bug |
| `tail -f` / `less +F` | `bg_spawn()` | read 只能静态快照；后台观察完成即通知 |
| `ssh`（非 git@） | `ssh_exec()` | 复用持久连接，免重复认证 |
| `scp` | `scp_to_remote()` / `scp_from_remote()` | 同上 |
| `tmux new` / `nohup` | `bg_spawn()` | 任务状态追踪 + 跨会话恢复 |
| `sleep N` / `watch` / 轮询循环 | 自动转换 | 纯 `sleep N` 变为 `wait()`（回合休息，超出会话上限时截断）；含 sleep 的长命令、`watch`、`while/until` 循环整体转为后台任务——模型只需照常写命令，门控自动改写 |

门控特性：

- **Shell 分词器**：引号内的内容不会误触发（`echo "2 > 1"` 放行），
  转义/引号包装的命令词无法绕过（`\cat file`、`'cat' file` 拦截）
- **段分割**：`&&`、`;`、`|` 后的每个命令段独立检查（`foo && ssh host cmd` 拦截）
- **管道过滤放行**：`npm test | tail -20` 这类 stdin 过滤器是合法用法，不拦截
- **包装器/路径加固**：`sudo cat`、`/usr/bin/ssh`、`env FOO=1 ssh` 均无法绕过
- **sudo 密码保护**：模型执行需要密码的本地 `sudo` 时，先探测凭据缓存
  （`sudo -n`），需要密码则弹出**遮蔽输入框**向**用户**索要——密码仅存内存
  （会话级缓存，不持久化）、通过 `SUDO_ASKPASS` 临时文件（0600，用完即删）
  注入 `sudo -A`，**从不进入模型上下文**。无 UI 的环境（headless/子代理）
  没有密码通道，会明确报错提示（在自己的终端运行或配置 NOPASSWD）。
  远程 sudo 的密码保护见 [SSH 集成](#ssh-集成)

## timeout 参数约定

所有工具的 timeout 参数统一接受两种输入：

```json
{ "timeout": 30 }           // 纯数字 = 秒（默认单位，全工具统一）
{ "timeout": "30s" }       // 后缀字符串，显式单位
{ "timeout": "500ms" }     // 毫秒必须显式写 "ms" 后缀
```

- 纯数字一律按**秒**解释（bash / bg_spawn / subagent_spawn / ssh_exec 统一），
  想表达毫秒只能用 `"500ms"` 后缀——单位混淆不再可能静默改变行为
- 非法输入（负数、乱码后缀等）返回明确错误并提示两种合法形式
- 共享实现：`TimeoutParamSchema` / `timeoutToMs` / `formatTimeout`（`utils/timeout.ts`，已导出）

## 管线失败诊断（pipefail）

bash 管道链的退出码只反映最后一个阶段，中间阶段的失败会被静默掩盖
（`cat missing | grep x` 返回 grep 的退出码）。pi-ex 在 bash 层实现 pipefail
语义：执行后逐段捕获退出码，中间阶段失败时整个命令报错并精确标注：

```
Pipeline stage 1/2 failed with code 1: `false`
```

- 模型可以继续使用它最熟悉的管道语法，失败时自动获得完整诊断
- **SIGPIPE 豁免**：`yes | head -1` 这类提前退出消费者的惯用法不算失败
- 非 bash shell 和远程执行回退到原有行为

## 智能上下文修剪（Structured Pruning）

长会话中工具输出是上下文膨胀的主因。pi-ex 在压缩前对旧工具输出做
**零 LLM 成本的确定性结构化提取**：

| 工具 | 保留 | 丢弃 |
|------|------|------|
| `read` | 代码骨架：import、函数/类签名、结构声明 | 函数体实现 |
| `bash` | 错误行、高亮行、尾部摘要 | 常规输出 |

- 压缩比率校验：提取失败时回退到 head-based 截断
- 修剪存根标记原始位置，完整内容永远在会话归档中可用 `recall` 找回
- CJK 感知的 token 估算（中文字符 ≈ 1 token，而非 chars/4 的系统性低估）

## 不确定条目审查（Uncertainty Review）

模型陈述中无法直接验证的内容（推断、对文件状态的声称、未决问题）会被标记为
**不确定条目**。审查机制管理这些条目的完整生命周期：标记 → 裁决 → 压缩核验 →
陈旧重审，防止未经验证的假设沉淀为后续对话的事实。

### 标记

系统提示要求模型在做出无法直接验证的陈述时立即标记一行：

```
[uncertain:inference] 推断内容
[uncertain:state:文件路径] 对该文件的声称
[uncertain:question] 未决问题
```

### 自动裁决（默认开启，`auto: true`）

模型按**最新 → 最远**顺序逐条裁决（verified / dismissed / corrected）——
最新对话代表用户当前意图，被最新上下文推翻/修正/舍弃的旧条目不再回溯。
**用户过去的裁决与模型裁决一视同仁，同样会被重新审视**；覆盖用户裁决前会弹
确认框（Enter 接受 / Esc 保留，300 秒超时默认保留）。触发时机：

1. **用户输入与任何条目（含已裁决）冲突时**——响应前静默检查，不阻塞对话（主）
2. **压缩前**（辅）

全部静默运行，失败静默降级。`auto: false` 恢复手动模式：agent run 空闲时弹出
审核框——`Enter` 确认无误、`c` 纠正、`d` 忽略、`Esc` 推迟到压缩时再审。

### 纠正即生效

裁决/纠正内容作为 follow-up 注入对话，模型立刻按更正后的事实继续，
避免错误假设在后续几十轮里沉淀。压缩时裁决注入 verify pass：
verified/corrected 晋升为确认事实、dismissed 不再列举、未决策条目照旧后审。
被舍弃的条目在摘要中标注 `[REVIEWED — dismissed by user]`。

### 陈旧裁决重审

带文件主体的裁决在该文件被 edit/write 修改后自动**重新入队**（stale 检测），
未经复核的失效裁决不会带进 checkpoint。

### /review 入口

随时打开：先审未审查条目（✓ keep 保留 / ✗ abandon 舍弃，无类别标签），
再处理待审条目，最后浏览已裁决条目（可翻回待审或改判）。决策以 session
自定义条目持久化（记录裁决来源 user/model），resume 后完整恢复。

### 配置

`settings.json` 的 `compaction.uncertaintyReview`：
`timing: "incremental" | "at-compaction"`（默认 incremental）、
`maxPerPrompt`（默认 5）、`auto`（默认 true）。

## 编辑后引用扫描（Post-Edit Scan）

`edit` 成功改动后，被改动移除/重命名的标识符会通过已注册的 codegraph 工具
（`codegraph_sync` 增量保鲜 + `codegraph_callers`）自动查询残留引用，并把清单
追加进 edit 结果——模型同一轮就能看到「`X` 仍被 N 处引用：file:line」，当场同步。
5 秒预算、缺失/超时/失败全部静默降级，绝不阻塞编辑结果；
`settings.codeScan.enabled: false` 可关闭。

## 项目级诊断（LSP Project Diagnostics）

统一项目级诊断是伪命题——各语言类型系统各异。模型改完一批文件后可调用
`lsp_project_diagnostics` 按语言跑最可靠的后端：TypeScript `tsc --noEmit`、
Python `pyright`、Rust `cargo check`、C/C++ `clangd --check`（无 compile_commands.json
时降级逐文件）。

## 文件上下文追踪

追踪模型接触的文件状态（两级缓存 + 空闲轮转，借鉴 CPU 缓存分层）：

- **read/write/edit 结果附带 last-modified 时间**（`[modified 2026-08-05 14:32:05 +0800]` 绝对时间+时区）：
  模型对比两次读取的时间戳即可自己发现文件是否已变，建立信息年龄基线
- **L1 接触式 LRU（20 个文件，哈希级）**：read/edit/write 接触的文件记录内容哈希；
  再次接触时哈希对比——read 结果标注"旧视图已作废"、edit 结果提示"本次编辑基于磁盘当前内容"
- **L2 变更集**：外部变更（空闲轮转 / 接触时检查）检测到的过期文件
- **L3 全项目轮转**：`git ls-files` 路径集 + 游标；模型回合结束（空闲）时启动、
  用户新输入到达时停止，按 mtime 巡检（无固定数量，能扫多少扫多少；一圈完成即停，
  下次空闲重新开圈）；L1 文件每圈优先检查
- **delta 通知**：每轮用户输入后，未通知过的过期文件以一条提示注入
  （`[file-state] N 个你见过的文件已在磁盘上变更，重新 read 后再依赖其内容`）；
  通知过的文件再次变更才重新通知；模型 read 刷新后自动解除
- `write` 前校验磁盘当前 hash 与模型上下文是否一致：不一致拒绝并提示先 `read()`（硬保护）
- `edit` 不做硬检查：区域匹配本身就是保护——oldText 找不到会报错（模型重新读取）
- 非 git 仓库自动降级：轮转只覆盖模型接触过的文件

## 记忆与召回（recall）

每次压缩前的完整会话内容都保存在归档中。`recall` 工具按关键字、
正则、文件路径或条目 ID 检索归档，找回被修剪/压缩的原始输出。

## 子代理（sub-agent）

进程内多代理委托，每个子代理在独立 git worktree 中工作，完成后自动提交：

```
subagent_spawn({ task: "重构 auth 模块的错误处理", mode: "execute" })
// → 完成后: subagent_review → subagent_merge / subagent_reject

subagent_parallel({ tasks: ["任务A", "任务B", "任务C"], maxConcurrency: 5 })
```

三种模式：

| 模式 | 工具集 | 用途 |
|------|--------|------|
| `analyze` | bash + read（只读） | 代码审查、调研报告 |
| `improve` | 完整（read/edit/write/bash） | 改进现有代码 |
| `execute` | 完整 | 端到端实现新任务 |

- 失败/超时的运行自动提交部分工作；无有效提交才清理 worktree
- 显式取消与超时严格区分（`cancelled` vs `timeout`）
- 崩溃安全：每次运行持久化 `.pi/subagent/meta/<id>.json`，pi 重启后该子代理以 `interrupted` 状态重新注册（`subagent_list` 可见、可 review/merge/reject），`subagent_continue` 可在原 worktree 中续跑——部分工作不会搁置
- `/subagent` 查看所有代理状态

## 后台任务（bg-tasks）

`bg_spawn` 在 tmux 中运行长任务，pi 会话重启后任务仍在。
运行中任务 widget 是**可交互列表**（`/tasks` 打开，↑/↓ 选中、`Enter` 查看输出、`k` 终止、`Esc` 返回）；`/fg <id>` 显示末尾 50 行（`/fg <id> --full` 显示全部），`/kill <id>` 终止，`/attach <id>` 实时挂接。模型侧工具：`bg_status`、`bg_output`（查看任务日志尾部）、`bg_kill`。已完成任务**即刻回收**——完成通知携带输出后，记录与日志立即删除，列表中只保留运行中的任务；多个任务同时完成时合并为一条通知。

## 提问与等待（ask and wait）

两个工具让模型像细心的协作者而不是闷头猜的实干家：

- **`ask_user(questions)`** —— 当模型的分析和推理无法确定用户意图时，
  主动提问而不是猜测。一次调用里的所有问题**连续弹出**（每题一个对话框），
  回答一起返回。交互模式下对话框面向**用户**；headless 模式没有对话框，
  工具会报错并引导模型给出标注假设。
- **`wait(duration_seconds)`** —— 启动长后台任务后无活可干时，模型
  挂起当前回合而不是空转轮询。等待结束自动恢复（固定引导语 + 当前
  运行中的后台任务清单）；后台任务完成会通过常规通知通道提前唤醒。
  交互模式单次最长 12 小时；headless 模式最长 120 秒、每会话 5 次。
  任何新的用户输入都会取消待触发的等待。

## SSH 集成

- `/ssh <host>` 建立持久连接（ControlMaster 复用，免重复认证）
- **跳板机**：ssh config 中带 `ProxyJump` 的别名开箱即用（`/ssh lulab_via_vps`）；
  也支持 `-J` 形式（`/ssh -J user@bastion user@target`）。同一端点经不同跳板
  或直连会建立独立连接；多段交互认证的等待窗口为 90 秒。
  注意：跳板连接由弹出的 keeper 终端窗口持有（proxy 子进程的生命周期
  与窗口绑定）——**保持窗口打开**，关闭即断开
- `ssh_exec` 远程执行（>300s 自动建议后台模式）
- `scp_to_remote` / `scp_from_remote` 文件传输
- 远程后台任务通知**按会话隔离**——不会投递到其他会话，多任务完成合并为一轮输入
- **sudo 支持**：模型首次执行 `sudo` 命令时提示**用户**输入密码
  （遮蔽输入、仅存内存、不持久化、不进入模型上下文）；也可提前用
  `/ssh sudo <host>` 设置并验证。密码通过远端 shell 函数注入，
  之后的 `sudo ...` 直接可用

## Todo 流

- `todo_write` 维护任务清单，widget 实时展示（actionable 优先排序）
- 条目过多时主 widget 有界展示；`/todo` 分页展示 widget 放不下的**剩余条目**（两者不重复）
- **过期提醒**：清单连续 8 次用户输入未更新且仍有未完成项时，
  注入提示要求模型清理；若模型忽略提醒，计时器从提醒轮重新计 8 次
  （此时条目大概率仍未完成），不会逐轮刷屏

## 上游自动同步

`.github/workflows/sync-upstream.yml` 每 5 分钟检查上游，用 **squash 方案**同步：

1. 上游有新提交且其 `build-check-test` CI 通过 → 把本仓库的独有工作
   （相对 `upstream-image` 的净差异）**squash 为单个提交**合并到新上游上，
   保持 `main` 始终是 `upstream-image` 的直系后代（GitHub 显示 ahead N / behind 0）
2. 合并冲突 → 自动创建 `[upstream-sync]` Issue 通知，等待人工处理
   （旧的冲突 Issue 在成功同步或重新冲突时自动关闭，不会堆积）
3. `upstream-image` 分支同时作为 squash 目标和变更检测指针

这保证 pi-ex 始终只合入经过上游 CI 验证的代码，且每次同步最多产生
一个待解决的冲突提交（而非重放整个 fork 历史）。

---

## 安装

```bash
git clone --recurse-submodules https://github.com/seek-hope/pi-ex.git
cd pi-ex
npm install --ignore-scripts
npm run build
npm link            # 全局注册 pi 命令
```

验证：

```bash
pi --version      # 0.83.0-ex（-ex 后缀标识 fork）
```

## 从上游更新

通常无需手动操作——[上游自动同步](#上游自动同步)会处理。手动触发：

```bash
git fetch upstream
# squash 同步：把独有工作合并到新上游并重挂到 upstream-image 上
git merge --squash origin/upstream-image   # 冲突时手动解决
git reset --soft origin/upstream-image
git commit -m "squash: fork work onto upstream <sha>"
git push --force-with-lease origin main
```

> **注意**：`npm link` 注册的全局 `pi` 运行的是 `dist/` 构建产物，不是源码。
> 任何源码修改（包括同步上游、本地修复）都必须重新 `npm run build`，
> 否则运行中的和新启动的 pi 仍然是旧代码。
>
> **开发迭代推荐用 watch 模式**：`node scripts/dev-watch.mjs` 启动后常驻，
> 每次保存源码自动增量编译到各包 `dist/`（无需网络，不跑 `generate-models`），
> 新启动的 pi 立即使用新代码；已运行的会话需重启。首次启动会按依赖顺序做一次
> 全量编译（约 1-2 分钟），之后每次修改只需几十毫秒。完整 `npm run build`
> （含 models.dev 目录刷新）仅在发布前需要。

## 与上游的关系

pi-ex 包含上游 pi-mono 的全部功能：多模型支持（OpenAI、Anthropic、Google、
DeepSeek、Qwen 等）、交互式 TUI、扩展系统、技能系统、提示模板等。

本仓库的独有改动均位于 `main` 分支对 `upstream-image` 的增量提交中，
边界清晰，可持续 squash 同步。扩展集（codegraph、lsp、docrelay 等）
作为 git submodule 维护于 [.pi/extensions](.pi/extensions)（独立仓库
[pi-extensions](https://github.com/seek-hope/pi-extensions)），通过
`~/.pi/agent/extensions` 软链接在所有目录可用。

## 开发

```bash
npm run check         # lint + 类型检查 + 依赖校验
./test.sh             # 隔离环境全量测试（非 e2e）
```

## 许可

MIT（与上游一致）

---

基于 [pi-mono](https://github.com/earendil-works/pi-mono) by [earendil-works](https://github.com/earendil-works)
