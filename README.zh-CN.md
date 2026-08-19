# pi-ex

> **pi-ex** 是 [pi-mono](https://github.com/earendil-works/pi-mono) 的增强 fork。
> 它保留 pi 的极简内核，消除长时间真实编码会话中出现的摩擦：不可靠的 shell
> 命令、腐烂的上下文、以及需要全程盯守的工作。

[![CI](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml/badge.svg)](https://github.com/seek-hope/pi-ex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English**: [README.md](README.md) · **中文**: [README.zh-CN.md](README.zh-CN.md)

pi-ex 自动跟踪上游（workflow 只同步通过上游 CI 的提交），并在其上叠加一层经过实战检验的增强。
版本号带 `-ex` 后缀（如 `0.84.2-ex`）。本 README 按你实际使用 pi-ex 的旅程组织——
从第一个 prompt 到长任务、多代理、远程工作，功能在你遇到它们的时刻自然登场。

---

## 快速开始

```bash
git clone --recurse-submodules https://github.com/seek-hope/pi-ex.git
cd pi-ex
npm install --ignore-scripts
npm run build
npm link            # 全局注册 pi 命令

pi --version        # 0.84.2-ex（-ex 后缀是 fork 的标记）
```

`npm link` 运行的是 `dist/` 构建产物而非源码。修改源码后需要重新构建——迭代期间建议常驻
`node scripts/dev-watch.mjs`：保存即增量编译（离线，不刷新模型目录），新启动的会话立即生效。
完整的 `npm run build`（含 models.dev 目录刷新）仅在发布前需要。

以下所有功能开箱即用；除非特别说明，无需任何配置。

## 第一部分——日常可靠性：让命令规矩起来

用了几个 prompt 之后你注意到的第一件事：模型不再做浪费的 shell 操作。这就是 **bash 门控**。

### bash 门控

bash 是图灵完备的，但也最容易被模型误用：转义出错、输出非结构化、大量浪费上下文的输出。
bash 命令执行前，pi-ex 先做 **shell 感知的静态分析**（引号/转义/分段切分），拦截与 pi 结构化
工具重复的低效命令，并告诉模型该用什么替代：

| bash 命令 | 重定向到 | 原因 |
|-----------|---------|------|
| `cat <<EOF` / `echo` / `printf >` / `>>` / `cat >` | `write()` / `edit()` | 自动建目录、杜绝 EOF 分隔符错误 |
| `sed -i` / `awk >` / `perl -pi` | `edit()` | 精确字符串匹配，无正则转义 bug |
| `less` / `more` + 文件；`sed` / `awk` / `perl` + 脚本 + 文件（读取意图） | `read()` | offset/limit、图像支持；stdin 过滤不受影响 |
| `tail -f` / `less +F` | `bg_spawn()` | read 只能拿到静态快照；后台持续观察并接收通知 |
| `ssh`（非 git@） | `ssh_exec()` | 复用持久连接，免重复认证 |
| `scp` | `scp_to_remote()` / `scp_from_remote()` | 同上 |
| `tmux new` / `nohup` | `bg_spawn()` | 任务状态跟踪 + 跨会话恢复 |
| `bash -c` / `sh -c` / `bash -s` | 扁平化 | 让内层命令对门控可见 |
| `sleep N` / `watch` / 轮询循环 | 自动转换 | 纯 `sleep N` 转为 `wait()`（turn 休眠，钳制在会话上限内）；长命令中的 sleep、`watch`、`while/until` 循环合并为一个后台任务运行——模型照常写命令，门控自动改写 |

普通文件读取（`cat`、`head`、`tail <file>`）**有意不拦截**——门控只拦截与 pi 工具
重复且可靠性更差的模式。

门控特性：

- **shell 分词器**：引号内容不会误触发（`echo "2 > 1"` 正常通过）；转义/引号包裹的命令名先归一化再匹配
- **分段切分**：`&&`、`;`、`|` 之后的每一段独立检查（`foo && ssh host cmd` 会被拦）
- **管道过滤放行**：`npm test | tail -20` 这类 stdin 过滤是正当用法
- **包装器/路径加固**：`sudo ssh`、`/usr/bin/ssh`、`env FOO=1 ssh` 等绕过手段全部无效
- **sudo 密码保护**：模型执行本地 `sudo` 且需要密码时，bash 工具先探测缓存凭据（`sudo -n`）；
  需要密码则向**用户**弹出**掩码输入框**——密码只存会话内存（不落盘），经
  `SUDO_ASKPASS` 临时文件（0600，用后删除）以 `sudo -A` 注入，**全程不进入模型上下文**。
  无头环境没有密码通道，直接失败并提示（请在自己的终端执行或配置 NOPASSWD）。
  远程 sudo 见 [SSH 集成](#第四部分把工作交出去并行与远程)。

### 统一的 timeout 约定

所有工具的 timeout 参数只接受两种输入形式：

```json
{ "timeout": 30 }           // 裸数字 = 秒（所有工具统一的默认单位）
{ "timeout": "30s" }       // 带后缀字符串，单位显式
{ "timeout": "500ms" }     // 毫秒必须写 "ms" 后缀
```

裸数字一律是**秒**（bash / bg_spawn / subagent_spawn / ssh_exec）；毫秒必须写 `"500ms"` 后缀——
单位混淆从此无法悄悄改变行为。非法输入（负数、错误后缀）返回明确错误并列出两种合法形式。
共享实现：`TimeoutParamSchema` / `timeoutToMs` / `formatTimeout`（`utils/timeout.ts`）。

### 管道失败诊断（pipefail）

bash 管道的退出码只看最后一段，中间段的失败会被静默掩盖（`cat missing | grep x` 返回 grep 的退出码）。
pi-ex 为 bash 层提供 pipefail 语义：逐段捕获退出码，中间段失败则整体失败并标注失败段：

```
Pipeline stage 1/2 failed with code 1: `false`
```

模型继续用熟悉的管道语法，失败时拿到完整诊断。**SIGPIPE 豁免**：`yes | head -1` 这类
"下游提前退出"的惯用法不算失败。非 bash shell 与远程执行回退到原始行为。

## 第二部分——长任务：不用盯着的工作

模型迟早要跑慢活——构建、测试套件、下载。pi-ex 让长任务即抛即忘，不再阻塞会话。

### 后台任务（bg-tasks）

`bg_spawn` 在 tmux 中运行长任务，pi 会话重启后任务仍在。运行中任务 widget 是**可交互列表**
（`/tasks` 打开，↑/↓ 选中、`Enter` 查看输出、`k` 终止、`Esc` 返回）；`/fg <id>` 显示末尾 50 行
（`/fg <id> --full` 显示全部），`/kill <id>` 终止，`/attach <id>` 实时挂接。模型侧工具：
`bg_status`、`bg_output`（查看任务日志尾部）、`bg_kill`。已完成任务**即刻回收**——完成通知
携带输出后，记录与日志立即删除，列表中只保留运行中的任务；多个任务同时完成时合并为一条通知。

### `wait` 与 `ask_user`

这两个工具让模型更像一个谨慎的协作者，而不是闷头瞎猜的执行器：

- **`wait(duration_seconds)`**——启动后台任务后、当前没有有用的事可做时，模型挂起 turn，
  而不是忙等或轮询。等待结束自动恢复；后台任务完成会通过常规通知渠道提前唤醒。
  交互式会话最长 12 小时；无头会话最长 120 秒、最多 5 次。新的用户输入会取消等待。
- **`ask_user(questions)`**——分析无法确定你的意图时，模型先问再动手。一次调用里的所有问题
  依次弹出（每个一个对话框），答案一起返回。交互式会话向你弹窗；无头会话没有对话框，
  工具直接失败并提示"按最佳推断继续并标注不确定性"。

## 第三部分——长会话：不腐烂的上下文

真实任务进行一小时后，会话已经历数百次工具调用。pi-ex 让这段上下文保持准确、有界、可恢复。

### 文件上下文跟踪

跟踪模型接触过的文件状态（两级缓存 + 空闲轮换，类 cache 架构）：

- **read/write/edit 结果附带文件最后修改时间**（`[modified 2026-08-05 14:32:05 +0800]`，
  含 UTC 偏移的绝对时间）：模型可对比两次读取的时间戳自行判断变化
- **L1 接触 LRU（20 文件，哈希精确）**：read/edit/write 记录内容哈希，再接触时比对——
  read 附注"先前看到的内容已过期"；edit 附注"本次编辑基于磁盘最新内容"
- **L2 变化集合**：外部修改被检出的文件（空闲轮换/接触时检查）
- **L3 全项目轮换**：`git ls-files` 路径集 + 游标；agent 空闲时运行，全速扫描 mtime；
  L1 文件每轮优先检查
- **增量通知**：每轮前把未见过的过期文件作为一条通知注入
  （`[file-state] N files you have seen changed on disk since your last read ——
  依赖其内容前请重新读取`）；重新 read 后标记自动清除
- `write` 硬保护：如果文件在模型上次看到之后被第三方改过（你在编辑器里、另一个
  agent/会话、formatter、`git checkout`），write 直接拒绝并提示先 `read()`——
  模型永远不会覆写一个它不知道存在的状态。新建文件与模型没碰过的文件自由写入，
  有意的覆盖从不受阻
- `edit` **不硬查**：oldText 区域匹配本身就是保护——找不到就报错（模型自然会重新读）
- 非 git 目录优雅降级：轮换只覆盖接触过的文件

你在自己的编辑器里改了文件、会话里的模型却不再覆盖你的改动——就是这个功能在起作用。

### 智能上下文修剪（structured pruning）

工具输出是上下文膨胀的主因。压缩前，pi-ex 对旧工具输出做**确定性结构化提取**（零 LLM 调用）：

| 工具 | 保留 | 丢弃 |
|------|------|------|
| `read` | 代码骨架：import、函数/类签名、类型声明 | 函数体 |
| `bash` | 错误行、高亮行、尾部摘要 | 常规输出 |

压缩率校验失败自动回退为头部截断。修剪后的存根标注原始位置，完整内容永远在会话档案中，
可用 `recall` 取回。token 估算对 CJK 感知（中文字符按 ≈1 token 计，不再按 chars/4 系统性低估）。

### 上下文窗口安全的压缩（compaction）

压缩请求会按模型的上下文窗口做预算。摘要请求过大时，pi-ex 按固定顺序减重而不是失败：
思考块整块丢弃；工具调用只保留名称 + 输入（附成功/失败标记，绝不保留输出）；然后逐轮丢弃
最旧的对话。如果 provider 仍以超窗拒绝，则从最旧开始逐轮丢弃并重试——不再有
"越到关键时刻越压不动"的全盘失败。

### 回忆（recall）

每次压缩/修剪前的完整会话内容都保存在档案中。`recall` 工具按关键词、正则、文件路径或
条目 ID 搜索档案，找回被修剪/压缩掉的内容。

### 不确定性审查（uncertainty review）

模型无法直接验证的论断（推断、对文件状态的断言、悬而未决的问题）被跟踪为**不确定性条目**，
全生命周期管理：标记 → 裁定 → 压缩验证 → 过期重审——让未验证的假设不会在后续 turn 里硬化成事实。

**标记。** 系统提示词要求内联标记：

```
[uncertain:inference] 推断内容
[uncertain:state:path/to/file] 关于某文件状态的断言
[uncertain:question] 悬而未决的问题
```

**自动裁定（默认开启，`auto: true`）。** 模型按**最新 → 最旧**逐条裁定（verified /
dismissed / corrected）——最新的轮次代表当前意图，被新上下文取代的陈旧条目不再重翻。
**用户裁定与模型裁定一视同仁，同样会被重审**；推翻用户裁定需弹窗确认（Enter 接受 /
Esc 保留，300 秒超时默认保留）。触发时机：

1. **用户输入与任何条目冲突时（含已裁定条目）**——响应前静默检查，不打断对话（主）
2. **compaction 前**（次）

全程静默执行，失败静默降级。`auto: false` 恢复手动模式：agent run 空闲时弹审查弹窗——
`Enter` 确认、`c` 纠正、`d` 驳回、`Esc` 推迟到压缩时处理。

**纠正立即生效。** 裁定作为 follow-up 注入，模型带着纠正后的事实继续，而不是把错误假设
复合几十轮。压缩时裁定进入 verify pass：verified/corrected 条目升格为确认事实，dismissed
条目标注 `[REVIEWED — dismissed by user]`，未裁定条目压缩后继续审查。

**过期裁定重审。** 绑定文件的裁定在该文件被 edit/write 修改时自动重新入队；失效裁定不会带进 checkpoint。

**/review 入口。** 随时打开：先列出未审查条目（✓ 保留 / ✗ 放弃，不显示分类标签），再处理
待裁定项，最后是可浏览的已裁定列表（可移回待裁定或翻转裁定）。裁定以会话自定义条目持久化
（记录裁定来源 user/model），resume 后完整恢复。

**配置。** `settings.json` 的 `compaction.uncertaintyReview`：
`timing: "incremental" | "at-compaction"`（默认 incremental）、`maxPerPrompt`（默认 5）、
`auto`（默认 true）。

### 编辑后扫描（post-edit scan）

`edit` 成功后，对被删除/重命名的标识符通过 codegraph CLI 做悬垂引用检查（直接调用
`codegraph callers`，只读——codegraph 守护进程随文件变化自动同步索引，无需 sync 步骤），
把结果列表附在 edit 结果之后——模型当轮看到"`X` 仍在 N 处被引用：file:line"并立即同步。
5 秒预算；CLI/索引缺失、超时、失败全部静默降级，不阻塞 edit 结果。
可用 `settings.codeScan.enabled: false` 关闭。

### LSP 项目诊断

"统一的项目级诊断"是个幻觉——各语言类型系统差异太大。编辑一批文件后，模型可调用
`lsp_project_diagnostics`，按语言选择最可靠的后端：TypeScript `tsc --noEmit`、
Python `pyright`、Rust `cargo check`、C/C++ `clangd --check`（无 compile_commands.json
时优雅降级为逐文件检查）。

## 第四部分——把工作交出去：并行与远程

### 任务清单（todo flow）

- `todo_write` 维护任务列表；widget 实时渲染（可操作项优先排序）
- 列表过长时主 widget 保持紧凑；`/todo` 分页浏览 widget 放不下的**剩余条目**（无重复）
- **过期提醒**：连续 8 次用户输入未触碰未完成项时注入提醒，请模型清理；若模型忽略，
  计时器从提醒轮重新数 8 次（这些项大概率仍未完成），而不是每轮刷屏

### 子代理（sub-agents）

进程内多代理委派，乐高式组合：单代理和并行批次是积木，`dependsOn` 是执行顺序的拼接口，
由模型组装成 workflow。

每个代理两条路径——与操作系统的多进程文件共享一致：只读进程共享文件，写入方获得私有副本（COW）：

| 路径 | 工作目录 | 工具集 | 交付物 |
|------|----------|--------|--------|
| 写路径（默认） | 独立 git worktree | 完整（read/edit/write/bash） | 自动提交 + `subagent_review` → `subagent_merge` / `subagent_reject` |
| `readOnly: true` | **共享项目目录** | bash（写命令门拦截）+ read | 报告本身——无 worktree/commit/review 仪式 |

只读路径从机制上无法写文件（无 edit/write 工具、bash 拦截写命令），因此不产生文件改动的任务
（调研、分析、问答）绝不会误写工作区。

```
subagent_spawn({ task: "重构 auth 模块的错误处理" })
// → 完成后：subagent_review → subagent_merge / subagent_reject

subagent_spawn({ task: "梳理 sync 引擎的调用图", readOnly: true })
// → 只出报告，零 git 痕迹

subagent_parallel({ tasks: ["任务 A", "任务 B", { task: "任务 C", readOnly: true }] })

// workflow 组合：A 完成后 B、C 自动启动，A 的报告注入它们的 prompt；
// 依赖失败会级联取消下游。
subagent_spawn({ task: "实现 schema", ... })                  // → sa-a
subagent_spawn({ task: "补测试", dependsOn: ["sa-a"] })
subagent_spawn({ task: "更新文档", dependsOn: ["sa-a"], readOnly: false })
```

- 不再逐代理刷屏：**最后一个**运行/排队中的代理结束时，主代理收到一次聚合唤醒，
  用 `subagent_list` 统一收报告
- `subagent_message({ id, message })` 在运行中的代理下一轮注入纠偏消息，
  或给排队中的代理补充 prompt——无需取消即可纠偏
- 失败/超时的运行自动提交部分工作；无有效提交才清理 worktree
- 崩溃安全：每次运行持久化 `.pi/subagent/meta/<id>.json`，pi 重启后该子代理以
  `interrupted` 状态重新注册（`subagent_list` 可见、可 review/merge/reject），
  `subagent_continue` 可在原 worktree 中续跑——部分工作不会搁置
- `subagent_followup` 在原 worktree/分支上追问已完成的子代理，可为小任务换用更便宜的模型
- 显式取消与超时严格区分（`cancelled` vs `timeout`）
- `/subagent` 查看所有代理状态

子代理内核（worktree 生命周期、DAG 调度、崩溃恢复元数据、追问状态机、派生树跟踪、并发上限）已抽取为
运行时无关的 `packages/subagent-core` 包，使同一套隔离语义可被其他 harness 驱动，
而无需分叉这部分逻辑。

### SSH 集成

- `/ssh <host>` 建立持久连接（ControlMaster 复用，免重复认证）
- **跳板机**：ssh config 中带 `ProxyJump` 的别名开箱即用（`/ssh lulab_via_vps`）；
  也支持 `-J` 形式（`/ssh -J user@bastion user@target`）。同一目标经不同跳板或直连
  各自独立连接；多段交互认证的等待窗口为 90 秒。注意：跳板连接由 keeper 终端窗口持有
  （代理子进程的生命周期绑定该窗口）——**请保持窗口开启**，关闭即断开
- `ssh_exec` 远程执行（>300 秒自动建议后台模式）
- `scp_to_remote` / `scp_from_remote` 文件传输
- 远程后台任务通知**按会话隔离**——不会投递到其他会话；多个完成合并为一轮
- **sudo 支持**：模型首次执行 `sudo` 时向**用户**请求密码（掩码输入、仅存内存、
  不落盘、不进入模型上下文）；`/ssh sudo <host>` 可提前设置并验证。密码经远程 shell
  函数注入，后续 `sudo ...` 直接使用

## 第五部分——fork 自身

### 上游自动同步

`.github/workflows/sync-upstream.yml` 每 5 分钟检查上游，采用**squash 策略**同步：

1. 上游有新提交且其 `build-check-test` CI 通过时，把本仓库的 fork 工作（相对
   `upstream-image` 的净差异）**squash 成单个提交**置于新上游之上，保持 `main` 是
   `upstream-image` 的直接后代（GitHub 显示 ahead N / behind 0）
2. 合并冲突时创建 `[upstream-sync]` Issue 人工处理（成功或出现新冲突时自动关闭旧的
   冲突 Issue，不会堆积）
3. `upstream-image` 分支同时充当 squash 的基线与变更检测的指针

这保证 pi-ex 永远只合入通过上游 CI 的代码，且每次同步最多只有一个冲突提交要处理
（而不是重放整个 fork 历史）。

需要时的手动操作：

```bash
git fetch upstream
git merge --squash origin/upstream-image   # 冲突时手动解决
git reset --soft origin/upstream-image
git commit -m "squash: fork work onto upstream <sha>"
git push --force-with-lease origin main
```

### 与上游的关系

pi-ex 包含上游 pi-mono 的全部功能：多模型支持（OpenAI、Anthropic、Google、DeepSeek、
Qwen 等）、交互式 TUI、扩展系统、技能（skills）、提示词模板等。

所有 fork 特有修改都位于 `main` 在 `upstream-image` 之上的增量提交中，边界清晰、
可持续 squash 同步。扩展集（codegraph、lsp、docrelay 等）以 git 子模块形式维护在
[.pi/extensions](.pi/extensions)（独立仓库
[pi-extensions](https://github.com/seek-hope/pi-extensions)），软链到
`~/.pi/agent/extensions`，在任意目录下可用。

### 包清单

| 包 | 说明 |
|----|------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 厂商中立的遥测契约、参考适配器、一致性测试与类型化 schema |
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 带工具调用和状态管理的 Agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码 Agent CLI（TUI） |
| **[@earendil-works/pi-tui](packages/tui)** | 差分渲染终端 UI 库 |
| **[@earendil-works/pi-subagent-core](packages/subagent-core)** | 运行时无关的子代理内核：worktree 隔离、生命周期、崩溃恢复、追问 |
| **[@earendil-works/pi-protocol](packages/protocol)** | 传输中立的 CBOR 协议，用于远程 pi 会话 |
| **[@earendil-works/pi-client](packages/client)** | 经 CBOR 帧字节流访问远程 pi 会话的客户端 |
| **[@earendil-works/pi-server](packages/server)** | 实验性 server，将 pi 会话架于协议之上 |

### 开发

```bash
npm run check         # lint + 类型检查 + 依赖校验
./test.sh             # 隔离环境完整测试套件（非 e2e）
```

## 许可证

MIT（与上游一致）

---

基于 [earendil-works](https://github.com/earendil-works) 的 [pi-mono](https://github.com/earendil-works/pi-mono)
