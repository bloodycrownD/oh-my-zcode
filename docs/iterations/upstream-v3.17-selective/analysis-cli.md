---
date: 2026-11-04
title: 上游 ZCode v3.16.2 → v3.17.2 选择性同步：apps/zcode-cli 区域缺陷修复与性能优化候选
upstream_base: 3c5b2276（v3.16.2）
upstream_target: v3.17.2（a9fe401e）
fork_head: main @ 36bc100f（omz v1.1.3）
scope: apps/zcode-cli/packages/**、apps/zcode-cli/tools/**、apps/zcode-cli/docs/**
excluded: apps/zcode-cli/packages/*/tests/**、apps/zcode-cli/packages/*/test/**、apps/zcode-cli/docs/**（作为证据读，不作为候选）
---

# 0. 结论摘要

- 候选 **27 项**：bugfix **25** 项，perf **2** 项。
- 「可直接重放」（涉及的源文件 fork 全部未改过）**9** 项（CLI-01/02/07/17/18/19/21/22/27）；「需人工融合」（至少一个涉及文件 fork 改过）**18** 项。
- 需要额外补 fork 不存在的能力 **4 处**：CLI-02 必须删掉 `CronPauseSelf` 段（fork 无该 capability）；CLI-06/CLI-11 依赖 `SessionStore.commitMessageBundle`（v3.17.2 新增，fork 无）；CLI-23 必须删掉 `telemetry.unregisterConnection`（红线 1）；CLI-24 依赖 contracts 的 `dropTrailingHighSurrogate`（v3.17.2 新增，fork 无）。
- 最值得做：
  1. **CLI-02 / CLI-01 / CLI-03**（权限闸门三连）：Plan 模式比基础模式更宽、`sed` 只读黑名单漏 `e`/`w`、内置 Explore 固定 yolo 且不继承父权限——三者都是「不经审批执行命令/写文件」的安全缺陷。
  2. **CLI-06 + CLI-07**（Read 工具与读取状态）：冷恢复前后 Read/Edit 行为不一致（range Read 丢失、`snapshotIndex` 顺序、`file_unchanged` 重放、`requestedPath` 缺失），会直接导致 Edit 误报 stale 与 `Wasted call` 误判。
  3. **CLI-08**（冷恢复后指令公告仍是旧 MEMORY.md）：模型按旧内容写入，会覆盖它没看过的新内容，是数据丢失级缺陷。
- 最大的单项收益在 **CLI-27**（dynamic-workflow 控制流分析）：80 层 helper × 800 处调用时旧算法产出 1629 万条边 / 4.7 GB 内存，且图本身是错的。

# 1. 区域规模

统计口径：`git diff --numstat 3c5b2276 v3.17.2 -- apps/zcode-cli`，927 个条目，全部有行号，无二进制。分类规则：路径含 `/test/`、`/tests/` 或文件名匹配 `*.test.*` / `*.spec.*` 记为测试；路径含 `/docs/` 或以 `.md` 结尾记为文档；其余记为源码。

| 类别 | 文件数 | +行 | −行 |
| --- | ---: | ---: | ---: |
| 源码 | 481 | 24536 | 4871 |
| 测试 | 362 | 35230 | 2990 |
| 文档 | 84 | 3365 | 498 |
| **合计** | **927** | **63131** | **8359** |

文件状态：M 642、A 282、D 2、R 1。

按区域（源码 / 测试 / 文档，格式 `文件数/+/-`）：

| 区域 | 源码 | 测试 | 文档 |
| --- | --- | --- | --- |
| `packages/core` | 178 / +7430 / −2756 | 128 / +14984 / −1428 | 6 / +83 / −2 |
| `packages/bootstrap` | 84 / +4425 / −922 | 71 / +8393 / −1153 | 7 / +82 / −0 |
| `packages/adapters` | 49 / +2327 / −305 | 42 / +5750 / −61 | 2 / +28 / −0 |
| `packages/zcode-site-plugin`（全新） | 28 / +5654 / −0 | 8 / +1360 / −0 | 14 / +413 / −0 |
| `tools/provider-regression`（全新） | 19 / +1704 / −0 | 6 / +1455 / −0 | 1 / +7 / −0 |
| `apps/zcode-cli/docs` | — | — | 39 / +2551 / −456 |
| `packages/dynamic-workflow` | 22 / +1005 / −314 | 82 / +1173 / −105 | 2 / +116 / −14 |
| `packages/node-repl-host` | 38 / +841 / −183 | 7 / +1194 / −169 | 1 / +19 / −0 |
| `packages/contracts` | 29 / +596 / −47 | 3 / +161 / −8 | 0 |
| `packages/office-runtime` | 5 / +306 / −187 | 4 / +250 / −2 | 1 / +5 / −2 |
| `tools/prompt-trajectory` | 9 / +151 / −102 | 4 / +370 / −1 | 2 / +25 / −5 |
| `packages/cli` | 5 / +39 / −27 | 4 / +71 / −61 | 0 |
| `packages/dynamic-workflow-runtime` | 3 / +19 / −1 | 3 / +69 / −2 | 0 |
| 其余（各 plugin、cua、bundled-skills、package.json） | 12 / +38 / −35 | 0 | 8 / +34 / −15 |

判读：

1. **测试 +3.5 万行不是候选**。上游为本轮修复补了大量回归（`core/tests` 净增 1.35 万行），这部分是「修复的验证」，不是修复本身；fork 测试基建是 `scripts/test-*.mjs`（node --test / tsx --test），上游 vitest 用例无法直接搬。
2. **新增 282 个文件里没有「本身即修复模块」的**。逐项看过：`zcode-site-plugin`（站点托管新产品线）、`tools/provider-regression`（模型供应商回归工具）、`bootstrap/src/workspace-mcp-trust/**`（工作区 MCP 信任）、`bootstrap/src/official-command-endpoint/**`（官方端点，红线）、`core/src/runtime/session-features/**`（会话能力标签）、`core/src/runtime/methods/input-prediction-sidecar.ts`（输入预测）、`adapters/src/mcp/node-fallback.ts`（MCP node 回退）、`bootstrap/src/app/dynamic-workflow-quota-resume.ts`（配额续跑）、`node-repl-host/src/call-ledger/**`（调用账本）、`core/src/runtime/provider-tool-rounds/**`（协议轮次）——全是新能力或为新能力做的类型/目录重构。
3. **删除只有 2 个文件**：`bootstrap/src/custom-command-shell-expansion.ts`（−255，自定义命令 `!` 块改为交给模型经 Bash 执行，属产品面重做，见 §4）与 `bootstrap/tests/tool-history-order.test.ts`（上游测试裁剪）。另有 1 个重命名 `zcode-protocol-v4/local-ttft.ts → local-ttft/recorder.ts`（纯目录重构）。
4. **`packages/magic-context`、`packages/tui`、`packages/i18n` 在本区间内没有源码变更**。magic-context 是 fork 自研包，上游根本不存在（`git ls-tree v3.17.2:apps/zcode-cli/packages` 无此项），所以本区域没有 magic-context 候选；`tui`、`i18n` 在该区间零改动。这一点与 BRIEF 的区域清单不同，需知悉。
5. **红线命中**：`core/src/compact/**`、`compact-active.ts`、`compact-post-reminders.ts`、`compact-selection.ts`、`compact-persistence.ts` 在 fork 全部不存在（红线 3：原生压缩已移除），因此本区间对这些文件的所有修复一律跳过（见 §4）。`bootstrap/src/zcode-protocol/session-data/**` 在 fork 不存在（data-sync 红线）。

# 2. 候选表

「fork 改过」判定：`git diff --name-only 3c5b2276 main -- <file>` 非空。
「已修」判定：`git diff v3.17.2 main -- <file>` 为空即 fork 已与目标一致（本区域无一命中，故省略该列，全部为「否」）。

| ID | 类型 | 一句话问题 | 上游文件（v3.17.2，路径相对 `apps/zcode-cli/packages/`） | fork 改过 | 红线 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CLI-01 | bugfix | `sed` 只读判定是黑名单，漏掉 `e` 命令与 `s///e`、`s///w` 标志，Plan 下自动放行执行/写文件 | `core/src/tool/handlers/bash-readonly-policy-callbacks.ts`、`bash-readonly-policy-flags-text.ts` | 否 | 无 | M | 取 |
| CLI-02 | bugfix | Plan 闸门比基础模式更宽：只读但 `needsApproval` 的工具、非 destructive MCP 一律免审批；guarded+Plan 跳过危险命令单次确认 | `core/src/permission/service.ts` | 否 | 无（`CronPauseSelf` 段需删） | M | 适配后取 |
| CLI-03 | bugfix | 内置 Explore 固定 yolo、且新建默认权限服务，父会话 allowed/disallowed 与会话授权不生效；提示注入可免审批执行任意 Bash | `core/src/runtime/methods/subagent.ts`、`bootstrap/src/subagents.ts`、`contracts`（`restrictPermissionMode`） | 是 | 无 | L | 适配后取 |
| CLI-04 | bugfix | 子会话恢复沿用落盘执行状态，父会话从 yolo 改 build 后子会话仍免审批 | `core/src/runtime/methods/resume.ts`、`subagent.ts` | 是 | 无 | S | 取 |
| CLI-05 | bugfix | subagent 复用父 model 句柄，父 runtime 层盖掉子层：准入端口/重试预算/会话类型全失效，并行 Agent 放大成 1302 风暴 | `core/src/runtime/methods/runtime-model.ts`、`subagent.ts` | 是 | 无 | L | 适配后取 |
| CLI-06 | bugfix | Read 状态按 `path+offset+limit` 存多条、冷恢复另用一套规则：range Read 不恢复、并行 Read 顺序错、`file_unchanged` 重放、rewind 丢 MEMORY.md 种子、`requestedPath` 缺失 | `core/src/tool/read-file-state.ts`、`read-file-state-metadata.ts`、`core/src/agent/read-file-state-hydrator.ts`、`core/src/tool/handlers/read.ts`、`core/src/runtime/methods/context.ts` | 部分（hydrator、context） | 无 | L | 取 |
| CLI-07 | bugfix | 空文件与「offset 超出」混为一谈；部分视图提示固定写 `lines 1-N`，行号与下一页 offset 都错 | `core/src/tool/handlers/read-text.ts`、`read.ts` | 否 | 无 | M | 取 |
| CLI-08 | bugfix | 冷恢复后指令公告（MEMORY.md 索引）原样保留，模型按旧内容写入覆盖未见的新内容（数据丢失） | `core/src/runtime/methods/context-refresh.ts`、`resume.ts` | 是（resume） | 无 | M | 取 |
| CLI-09 | bugfix | 从非仓库目录开始（或在非仓库目录 compact 一次）后，进入仓库永远不再宣告 Git；冷恢复又宣告，与环境公告矛盾 | `core/src/runtime/methods/context-refresh.ts`、`resume.ts`、`context.ts` | 是 | 无 | M | 取 |
| CLI-10 | bugfix | 目录不变时沿用存储的 `isGitRepository`，会话中途 `git init` 后冷恢复仍报 false | `core/src/runtime/methods/context-refresh.ts`、`resume.ts` | 是 | 无 | S | 取（可与 CLI-09 合并） |
| CLI-11 | bugfix | 隐藏提醒（agent listing 等）在 live 会移动 `latestConversationMessageId`，冷恢复却跳过：compaction 覆盖边界与 timeline 锚点前后不一致 | `core/src/runtime/methods/message-persistence.ts`、`resume.ts` | 是（resume） | 无 | M | 取 |
| CLI-12 | bugfix | 工具批次中停止后继续往下 drain guide，把引导塞进已停止的轮次；中断标记用错阶段文案 | `core/src/runtime/methods/turn-tools.ts` | 是 | 无 | S | 取 |
| CLI-13 | bugfix | 隐藏提醒写在用户输入与 assistant 之间，rewind 的 assistant 锚点回溯停在它上面，旧输入留在历史里 | `core/src/runtime/methods/rewind-message.ts` | 是 | 无 | S | 取 |
| CLI-14 | bugfix | 输入附件每次迭代都收集/不落盘：Stop hook 续跑、流重试、降级等重发请求被插入通知；`output_style` 只在首步发、`memoryUpdate` 只属单次请求、`plan_mode_exit` 只看内存标记 | `core/src/runtime/methods/turn-loop.ts`、`context-refresh.ts`、`core/src/runtime/helpers/runtime-reminders.ts` | 是（turn-loop） | magic-context 投影边界需重验 | L | 适配后取 |
| CLI-15 | bugfix | MCS 投影错位：人类 guide 被投影成 user 文本并移到 run 末尾、带图中途消息缺包装被当新轮、整批通知按 `<task-notification>` 前缀猜边界、`latestRealUserIndex` 选错导致图片失去媒体预算保护 | `core/src/runtime/helpers/provider-entry-origins.ts`、`provider-request-messages.ts`、`provider-mid-conversation-system.ts` | 是（provider-request-messages） | magic-context 投影边界需重验 | L | 适配后取 |
| CLI-16 | bugfix | 补 `"\n"` 无条件执行，OpenAI 兼容协议不合并相邻 user，补了只改写上次请求最后一块 → 前缀缓存失效 | `core/src/runtime/helpers/provider-request-messages.ts` | 是 | 无 | M | 取 |
| CLI-17 | bugfix | `localeCompare` 不带 locale，跟随进程语言（如 da-DK 把 `aa` 排到 `z` 之后）：换语言设置恢复后 tools 段字节变化、缓存失效 | `core/src/tool/provider-visible-order.ts` | 否 | 无 | S | 取 |
| CLI-18 | bugfix | Bash 失败输出 >30000 字节就落盘、只给 2KB 开头，模型看不到后部的错误原因 | `core/src/tool/handlers/bash-model-content.ts`、`core/src/tool/executor/result-serialization.ts` | 否 | 无 | S | 取 |
| CLI-19 | bugfix | 工具错误给模型的是 UI 摘要（空白折叠、500 字符截断），多行错误细节丢失 | `core/src/tool/executor/errors.ts` | 否 | 无 | S | 取 |
| CLI-20 | bugfix | Hook 文本拼进 tool result 占用其预算、以 UI 摘要为底拼失败结果；移出后单条超长 context 又整段进请求 | `core/src/tool/executor/hook-flow.ts`、`result-content-projection.ts`、`call-runner.ts` | 是（call-runner） | 无 | M | 适配后取 |
| CLI-21 | bugfix | Bash `cd` 后写回规范化物理路径，symlink root / `/private` 别名 / 盘符大小写让同一目录换写法 → 假目录变化 + 多跑一次仓库检查 | `core/src/tool/handlers/bash-cwd-policy.ts` | 否 | 无 | S | 取 |
| CLI-22 | bugfix | workflow 对分类器不认识的业务码无上限重试，run 永远挂着（2026-10-16 事故：1113 批量返回） | `adapters/src/model/workflow-model-failure-policy.ts`、`runner-stream.ts` | 否 | 无 | M | 取 |
| CLI-23 | bugfix | MCP 连接归 pool 却继承第一个 session 的关闭信号，关一个会话连带中止其他 lease；close 非幂等 | `adapters/src/mcp/pool.ts` | 是 | telemetry 注销需删 | M | 适配后取 |
| CLI-24 | bugfix | 一组小缺陷：小数 `timeout` 被判工具失败、空白 `send-message` 报 queued 后被拒、`~N messages` 把隐藏提醒算进去、子会话通知复制超长 provider 原文、resume 用 summary 当描述、reasoning history 每对多补 `\n`、SQLite metadata 字符串逐字符校验 | `contracts/src/tools/bash.ts`、`send-message.ts`、`core/src/memory/extraction.ts`、`core/src/subagent/completion-notification.ts`、`runner.ts`、`message-steering.ts`、`adapters/src/model/reasoning-history-normalization.ts`、`adapters/src/storage/session-store/sqlite-session-store.ts` | 部分 | 无 | S | 取 |
| CLI-25 | perf | Git 快照：5 条互不依赖的 git 命令串行执行，git 卡住时要等 7–9 次 3 秒超时；「是否仓库」每次都 spawn git | `adapters/src/context/git-snapshot.ts`、`context/index.ts` | 是（context/index） | 无 | M | 取 |
| CLI-26 | bugfix | 自动 git 按裸名执行并继承全部环境：Windows 会跑工作区里的 `git.exe`、执行仓库配置的 fsmonitor/hooks、继承的 `GIT_DIR` 会读另一个仓库；Windows PATH 按 `:` 拆导致条目全丢（LFS 仓库 status 失败 → 快照显示干净） | `adapters/src/context/git-snapshot.ts`、`adapters/src/exec/windows-executable.ts` | 部分 | 无 | L | 取 |
| CLI-27 | perf | dynamic-workflow 控制流分析：`settle` 对主线完全透明 → n 个顺序 `await helper()` 画出 n(n+1)/2 条边（80 层 × 800 处 = 1629 万条边 / 4.7 GB），且图本身错；占位符扫描从 edges 末尾扫到 0，是 region 数 × 边数 | `dynamic-workflow/src/analysis/flow-graph.ts`、`state.ts`、`causality-order-*.ts`、`domain.ts`、`interpret.ts`、`calls.ts`、`causality-graph.ts` | 否 | 无 | L | 取 |

# 3. 候选详情

## CLI-01 `sed` 只读判定改为完整脚本白名单（安全）

- **旧行为**：`sedCommandIsDangerous` 只拒绝 `-i` / `--in-place` 与脚本里形如 `w` 的写命令；`SED_SAFE_FLAGS` 还放行 `-e/--expression`、`-f/--file`、`-l`、`-u`、`--debug`。于是 `sed -n '1e whoami' p`、`sed 's/x/y/e'`、`sed 's/x/y/w /tmp/out'` 都被判为只读，Plan 模式下**自动放行**（无权限请求事件）。
- **新行为**：只读资格改为「完整脚本白名单」，不用危险指令黑名单：
  - 选项只允许 `-n/--quiet/--silent`、`-E/-r/--regexp-extended`、`--posix`、`-z/--zero-terminated`；短选项可组合，选项必须在脚本前，可用 `--` 结束。
  - 打印要求 quiet，脚本仅由 `p`、`Np`、`N,Mp`（地址为正整数）以 `;` 连接，可带输入文件。
  - 替换不接受 quiet / 零分隔 / 文件参数，脚本必须完整匹配一条 `s/pattern/replacement/flags`，只支持 `/` 分隔符与 `g p i I m M` 及最多一个 `1–9`；转义只允许 `/ \ & 1–9 . ^ $ * + ? ( ) [ ] { } |`。
  - 脚本后的 option 形参数（单独 `-` 输入除外）、`-e`、`-f`、`-i`、控制字符一律拒绝。
  - 子集外返回 `readOnly=false, concurrentSafe=false`：Plan 拒绝，Build 请求审批。
- **证据**：`core/src/tool/handlers/bash-readonly-policy-callbacks.ts:16`（`sedCommandIsDangerous` 的新实现与其注释「原先只排除 -i 和局部 w 语法，漏掉了脚本执行和替换写入」）；`bash-readonly-policy-flags-text.ts` 的 `SED_SAFE_FLAGS` 由 20 项缩到 9 项；`apps/zcode-cli/docs/bash-tool-ast-permission-semantics.md` 新增段落记录「2026-10-28 回归证据：Linux/GNU sed 下，真实 executor 与 NodeExecutionAdapter 在临时目录复现了旧策略放行 `e`、替换命令的 `e`/`w` 标志并创建文件，且没有权限请求事件」。
- **移植要点与风险**：两个文件 fork 均未改过，可直接重放。风险点：① 收紧后 `sed -n '1,20p' file` 这类常见调用仍放行，但 `sed 's/a/b/'`（无 quiet、无文件）在 Plan 下从「自动放行」变成「请求审批」——这是刻意的行为变化，需要确认产品接受；② 上游验收只在 macOS/BSD 与 Linux/GNU sed 上做过 49 个场景，**Windows 未实测**（文档明写），fork 主要用户在 Windows，需补 Git-Bash / MSYS sed 的实测；③ 同批改动删掉了 `sed` 的 `-e` 支持，自定义命令/技能里若依赖 `sed -e` 只读会自动落回审批。

## CLI-02 Plan 闸门只收紧不放宽（安全）

- **旧行为**：`checkPlanMode` 对「只读且非 destructive」直接 allow（不看 `needsApproval`），对「非 destructive 的 MCP 工具」直接 allow。于是 Plan 模式**比基础模式更宽**：任意 URL 的 WebFetch、声明了 `readOnlyHint` 的 MCP 写工具、`node_repl` 的 `js` 都免审批，而 `EnterPlanMode` 本身免确认。另有一处：guarded 的单次确认分支带 `!planEnabled`，开着 Plan 时整段被跳过，`checkPlanMode` 随后补回 guarded 放行 → **guarded + Plan 下危险命令免确认执行**。
- **新行为**：`checkPlanMode` 语义改为「只在原模式之上收紧」，返回 `undefined` 表示放过、交给调用方按原模式判定：
  - 只读 + 非 destructive + `needsApproval=false` → allow（保留 ruleId）；
  - 只读 + 非 destructive 但需审批 → `undefined`（交回基础模式）；
  - 非 destructive MCP → yolo/guarded 下 `undefined`，其余模式改为 `ask` 且 `optionsPolicy: "no-always-allow"`（Plan 下记住的规则不生效，所以不提供「始终允许」）；
  - guarded 的危险命令在 Plan 下补做单次确认（`approvalMode: "user-once"`）；
  - Plan 闸门未拒绝时，按原模式补回 yolo/guarded 的放行。
- **证据**：`core/src/permission/service.ts:512`（注释「这里曾对只读工具不看 needsApproval、对非 destructive MCP 直接放行，Plan 因此比原模式更宽」）；同文件 `:204-230`（Plan 分支补 guarded 单次确认）与 `:478-500`（`guardedSingleUseAsk` 抽取）。`PermissionOptionsPolicy` 与 `no-always-allow` 在 base 3c5b2276 已存在（`git grep` 各 11 个文件），无需先补协议。
- **移植要点与风险**：`permission/service.ts` fork 未改过，可重放；但 diff 里另有一段 `CronPauseSelf` / `automation.pause` 的预批准（根因是无人值守 automation 停在审批界面），fork 无 `CronPauseSelf`（`git grep main` 命中 0），**必须删掉这段**，否则引用不存在的 capability 名。风险：`ask` + `no-always-allow` 会改变 MCP 工具在 Plan 下的 UI 选项，需要 desktop 侧确认已支持该 policy（fork 已有 11 个文件引用，应已支持）。

## CLI-03 Explore 子代理继承父权限、取消固定 yolo（安全）

- **旧行为**：`builtInExplore` 时子 runtime 使用 `new PermissionService(defaultPermissionConfig)`，父会话的 `allowedTools`、`disallowedTools`、会话内授权全部不生效；并且 `resolveSubagentPermissionMode` 在 `permissionMode` 缺省时对内置 Explore 返回 `"yolo"`，只靠 prompt 约束只读。组合后果：提示注入后模型可经 `Agent(Explore)` 在 build 或 Plan 父会话下**免审批执行任意 Bash**。
- **新行为**：
  - 所有子会话（含 Explore）继承父会话的 `permissionService`；
  - Explore 与其他 profile 一样继承父会话模式与 Plan 状态，Bash 是否只读交给 shell AST 判定；
  - 插件 profile 声明 `bypassPermissions` 时不再直接采信：`profile.permissionModeRestrictOnly === true` 时用 `restrictPermissionMode(parentMode, declared)` 取更严格的一个（根因：插件 profile 按用户级解析，父会话 build 的子会话也会变 yolo）。
- **证据**：`core/src/runtime/methods/subagent.ts:400`（「Explore 曾新建默认配置的权限服务，父会话的 allowedTools、disallowedTools 和会话内授权都不生效」）、`:641`（「内置 Explore 曾在这里固定为 yolo，只靠 prompt 约束只读；提示注入后模型可经 Agent(Explore) 在 build 或 Plan 父会话下免审批执行任意 Bash」）；`bootstrap/src/subagents.ts` 同名根因注释；`contracts` 新增 `restrictPermissionMode`。
- **移植要点与风险**：`subagent.ts` fork 改过（需人工融合），`bootstrap/src/subagents.ts` 也改过。风险：① 取消 Explore 的 yolo 后，Explore 在 build 父会话下会开始弹审批，可能影响「Explore 只读探索」的既有体验——上游的取舍是「Bash 只读交给 AST 判定」，而 CLI-01 修完 sed 后 AST 判定才真正可信，**两项应一起取**；② `permissionModeRestrictOnly` 需要在 fork 的子代理 profile 解析里补字段，否则插件声明的 `bypassPermissions` 仍会生效。

## CLI-04 子会话恢复不再沿用落盘执行状态

- **旧行为**：`resumeFromStore` 在 `options.modeOverride` 未给出时 `Object.assign(this.config, savedExecution.data)`，把落盘时的 mode 套回；父会话从 yolo 改成 build 后，恢复的子会话仍免审批执行命令。
- **新行为**：新增 `options.executionStateOverride`，调用方给出的完整执行状态**最后生效**，覆盖历史 mode 与落盘状态。
- **证据**：`core/src/runtime/methods/resume.ts:230`（注释「子会话恢复曾沿用落盘的执行状态，父会话从 yolo 改为 build 后，恢复的子会话仍免审批执行命令」）。
- **移植要点与风险**：`resume.ts` fork 改过（`git diff --stat` 显示 fork 对 `context.ts`/`resume.ts` 有小改动），需人工融合。风险低，但必须同时确认父会话在恢复子会话时确实传了 `executionStateOverride`（见 CLI-03 的 `childExecutionState`），否则新参数永远为空、修复不生效。

## CLI-05 runtime 层改为「外层优先」，修 subagent 准入失效

- **旧行为**：`withModelInvocationContext` 按「本层压过调用层」合并；subagent 继承父模型时复用父 runtime 交出的句柄（`createInheritedSubagentModelFactory`），句柄上已绑父 runtime 层，子 runtime 再包一层后靠近 adapter 的**父层盖掉子层**：子 runtime 的准入端口、重试预算、会话类型全部失效——subagent 请求拿着父的 observer（不排队、不看 Retry-After），会话类型被标成 `main`。一轮并行 10 个 Agent 调用就是 10 路无节制请求，放大成 1302 风暴。
- **新行为**：runtime 层之间改为**外层优先**——外层已生效时内层原样透传，runtime 层压过调用层这一条不变。标记放在调用上下文的模块私有 Symbol 键（`RUNTIME_LAYER_APPLIED`）而不是另一个 ALS，因为 off-peak 包装的 `streamText` 是 async generator，要到第一次 `next()`、`await` 换票之后才调用内层，独立 ALS 在那一刻已为空。同时 subagent 的准入端口改为 `deps.subagentModelRequestAdmission?.(this.sessionId) ?? this.modelRequestAdmission`（同一父会话的 subagent 共用一条队列）。
- **证据**：`core/src/runtime/methods/runtime-model.ts:97`（整段根因注释，含 MR !3127 评审 CR-01）；`subagent.ts:380-390`（「subagent 曾直接继承父的 observer（不排队、不看 Retry-After），一轮并行多个 Agent 调用会放大成 1302 风暴」）；`bootstrap/src/app/workflow-concurrency-governor.ts` 同名根因注释。
- **移植要点与风险**：`runtime-model.ts` fork 未改过（可直接重放），但 `subagent.ts` 与 `workflow-concurrency-governor.ts` 都改过（需融合）。风险：① 这是 AsyncLocalStorage 语义改动，影响所有模型调用路径（主轮、标题、Memory、workflow、subagent），回归面很大；② `subagentModelRequestAdmission` 需要装配方提供，fork 的 `bootstrap` 装配点若未提供会静默退回父端口（等于没修），需一并核对。

## CLI-06 Read 读取状态：单条/文件 + 冷恢复同一套规则

本项包含 6 个独立缺陷，建议一起做（它们共用同一份数据结构）。

- **旧行为与新行为**：
  1. **存储形状**：旧 key 是 `path\0offset\0limit`，一个文件可有多条；找「最新视图」要遍历整张表，冷恢复又按另一套规则挑选，同一段历史在重启前后去重结果不同。新：每文件一条，`setReadFileStateEntry` 先 `delete` 再 `set`，Map 遍历顺序即最近写入顺序；`findLatestReadFileState` 变成一次 `get`。
  2. **range Read 不恢复**：旧 `restoreReadToolState` 只恢复完整 Read（`skippedRangeReadCount`），range Read 跨 resume 丢弃。表现为「完整 → 范围 → 重启 → 完整」命中旧的完整视图返回 `Wasted call`，而 live 返回正文。新：range Read 与 same-runtime 一样恢复，按 live 更新顺序覆盖，每文件留最近一次视图。
  3. **并行 Read 顺序**：part 在工具开始前按声明顺序落盘、完成时原地更新，part 顺序与结果返回先后都不等于 live 写入读取状态的顺序。新：快照新增 `snapshotIndex`（执行器在写入 live 状态的同一同步步骤里取号），同一 assistant 内按它重放；任一快照缺该字段（旧数据）则保持 part 原顺序。
  4. **`file_unchanged` 重放**：旧数据里返回 `file_unchanged` 的 Read 也存了快照（当时最新记录的副本），按它重放会把读取时间改成这次调用的时间，之前那次真实读取不在 active history 时还会恢复出模型看不到原文的视图。新：`READ_FILE_UNCHANGED_STUB` 的 Read 不记录、也不恢复快照。
  5. **rewind 丢 MEMORY.md 种子**：旧 `hydrateReadFileStateFromSession` 无条件 `readFileState.clear()`，rewind 不重新加载 context，之后 `Write MEMORY.md` 报未读。新：`retainContextSeeds` 保留 `seededFromContext` 的记录。
  6. **`requestedPath` 缺失**：旧把工具输入的原始写法随快照持久化；该字段出现前写下的记录没有它，升级后冷恢复时 compaction 补回只按规范化路径判 deny，相对写法规则拦不住。新：从 tool part 的 `state.input.file_path` 取（新旧记录都有）。
- **证据**：`core/src/tool/read-file-state.ts:22`（存储形状根因）、`core/src/agent/read-file-state-hydrator.ts:50`（rewind 清表）、`:82`（range Read 不恢复）、`:171`（`inSnapshotOrder` 与 `file_unchanged` 跳过）、`:190`（`requestedPath`）；`core/src/tool/read-file-state-metadata.ts` 新增 `snapshotIndex` 与「只有 `output.type === "text"` 才记录快照」；`docs/design/v2/tool/tool-history-order-repair-proposal.md` 新增「文件读取状态的写入顺序 `snapshotIndex`（2026-10-22 补充）」整节，含 `declarationIndex` vs `snapshotIndex` 的对照图。
- **移植要点与风险**：`read-file-state.ts`、`read-file-state-metadata.ts`、`handlers/read.ts` 可直接重放；`read-file-state-hydrator.ts` fork 只删了 1 行、`context.ts` fork 有小改动，需人工融合（注意 fork 的 `context.ts:86-90` 有自研 `preContextEntries` 逻辑，融合时不要覆盖）。风险：① 存储形状变了，**旧会话的 read-state 无法按新 key 命中**——但该状态只在 runtime 内存里、由 resume 重新水化，不需要迁移；② `snapshotIndex` 只在「同一 assistant 内全部快照都有序号」时排序，混合数据保持原顺序，行为可预测；③ 需要 `commitMessageBundle`（CLI-11）才能保证多段快照原子落盘。

## CLI-07 Read 空文件与部分视图提示

- **旧行为**：`formatReadTextOutput` 用 `totalLines === 0` 判空文件，于是「空文件」与「按 offset 读到的空行」都归一成 1 行，并被说成「offset 太大」。部分视图提示固定写 `lines 1-N`，视图不从第 1 行开始时行号和下一页 offset 都错。
- **新行为**：`numLines >= 1 && totalLines > 1` 时返回带行号的空内容；空文件判据改为 `numLines >= 1 || totalLines === 0`。部分视图的 `lastShownLine = read.startLine + shownLines - 1`，提示里给 `offset=lastShownLine+1 limit=shownLines`。同时 token 上限估算从「二分查找 0.85 预算」改为「按平均密度估初值 + 按 0.7 逐步缩小 + 字符级回退」，并用真实 `estimateTokens` 校验（旧法在前段比全文更密时会超上限）。
- **证据**：`core/src/tool/handlers/read-text.ts:87`（空文件根因）、`:235`（「提示固定写 lines 1-N，视图不从第 1 行开始时行号和下一页 offset 都错」）、`createTokenCapPartialView` 全量重写。
- **移植要点与风险**：两文件 fork 均未改过，可直接重放。风险：① 部分视图提示从 tool_result 正文移到「工具批次之后的附件」（`formatReadBatchNotice` + `ToolBatchNotice`，source `read_truncation_notice`），这依赖 CLI-14 的附件收集机制；若只取 CLI-07 而不取 CLI-14，提示会**完全不出现**——这是本项最容易踩的坑，要么两项一起取，要么把提示留在 tool_result 里（上游早期形态）。② `READ_OUTPUT_TOO_MANY_TOKENS_CODE` 被抽成常量，外部若按字面量断言错误码需同步。

## CLI-08 冷恢复后指令公告必须原位刷新（数据丢失）

- **旧行为**：`skills_listing` 与 `context_prefix`（含 MEMORY.md 索引）公告在从库加载历史后原样保留。模型看到旧的 MEMORY.md 内容，读文件状态却记录磁盘上的当前内容；`Write` 的新鲜度检查因此放行，模型按旧内容写入，**覆盖它没见过的新内容**。
- **新行为**：新增 `refreshRestoredAnnouncements(runtime)`，在冷恢复/rewind 加载历史后按 runtime 当前内容**原位更新**这两类公告：内容不同就在原位置改成当前内容，当前为空就删除。只改内存，库里的记录只决定位置，每次加载都重新套用。
- **证据**：`core/src/runtime/methods/context-refresh.ts:192`（整段根因注释）；`resume.ts` 在 `ensureContextInitialized` 之后调用 `refreshRestoredAnnouncements(this)`。
- **移植要点与风险**：`context-refresh.ts` fork 未改过；`resume.ts` 改过（需融合）。风险：① 该函数依赖 `runtime.latestContextBuildResult.metaUserAttachments`，fork 的 context builder 若没有 `metaUserAttachments` 概念需补；② 内容变化会让「之前的请求字节变一次、prompt cache 失效一次」，这是刻意的取舍（文档明写）。

## CLI-09 / CLI-10 Git 会话上下文的窗口判定

- **旧行为**：
  - 是否读取 Git 按「上一次构建结果里有没有 Git 段」决定。会话从**非仓库目录**开始，或在非仓库目录 compact 一次之后，进入仓库也**永远不再宣告 Git**。
  - 非仓库窗口没有 Git 公告，「已决定」只记在 runtime 内存里；冷恢复后的新 runtime 又读 Git 并宣告，与环境公告里的 `Is a git repository: false` 矛盾。
  - 起始快照分不清「确定不是仓库」与「没读到」，为空时不记住目录，第二个请求还要再查一次（慢文件系统上可能等到 git 超时）。
  - 目录不变时沿用历史 envInfo，冷恢复后的新 runtime 一直报告存储里的「是否仓库」；会话中途 `git init` 后冷恢复仍报 false。
- **新行为**：
  - 判定改为**只看历史**：已有 `session_context` 公告就沿用、什么都不读（切目录也不重读）；请求前已有 `date` 公告说明本窗口首个请求已决定过，也什么都不读。
  - 本 runtime 已确认不是仓库的目录记入 `nonGitDirectories`，之后不再检查。
  - 新增 `sessionStartGitPrefetch`：新会话初始化时刚读过的 Git 只给第一次判断用一次；恢复的快照来自存储，不算。
  - 新增 `repositoryRecheckPending`：新 runtime 第一次环境公告重读一次「是否仓库」，平台/shell/系统版本仍沿用历史。
  - `date` 一律取运行时时钟（`runtime.now()`），不回退到会话起点冻结的 context snapshot 日期。
- **证据**：`context-refresh.ts:140`（目录不变时沿用历史）、`:383`（「原来按『上一次构建结果里有没有 Git 段』决定是否读取」「非仓库窗口没有 Git 公告…冷恢复后的新 runtime 又读 Git 并宣告」）、`:415`（「起始快照原来分不清『确定不是仓库』与『没读到』」）；`resume.ts` 设 `sessionStartGitPrefetch = false`、`repositoryRecheckPending = true`；`context.ts` 设 `sessionStartGitPrefetch = true`。
- **移植要点与风险**：`context-refresh.ts` fork 未改过，可直接重放；`resume.ts`、`context.ts` fork 改过（需融合）。风险：① `nonGitDirectories` 是 runtime 级缓存，`git init` 之后同 runtime 内不会重新识别——上游的取舍是「进入仓库后从**下一个窗口**开始宣告」，语义要接受；② 与 CLI-25/CLI-26 强耦合（`resolveGitContext` 的返回形状变了），建议三项一起做。

## CLI-11 隐藏提醒不得移动对话指针

- **旧行为**：`persistSyntheticUserNoticeForSession` 对**任何** sessionId 相同的记录都更新 `latestConversationMessageId`；冷恢复的 `getLatestActiveSessionMessageId` 却跳过隐藏提醒（agent listing 等公告）。于是 live 与冷恢复的 compaction 覆盖边界、timeline 锚点不一致。同一函数还把 `text` 写成单 part，多段（整批通知）时逐 part 落库，中途失败会留下只有前几段的消息。
- **新行为**：用同一个判据 `isHiddenReminderMessage({ info, parts })` 决定是否移动指针；`text` 接受 `string | readonly string[]`，多段时每段一个文本 part，优先 `sessionStore.commitMessageBundle` 在同一事务写入。`resume.ts` 的 `turnNumber` 也改为不把隐藏提醒算作一轮。
- **证据**：`core/src/runtime/methods/message-persistence.ts:259`（根因注释）；`resume.ts:246`（`turnNumber` 过滤新增 `!isHiddenReminderMessage(message)`）。
- **移植要点与风险**：`message-persistence.ts` fork 未改过，可直接重放；`resume.ts` 改过（需融合）。风险：`commitMessageBundle` 是 **v3.17.2 新增的 SessionStore 方法**（`git grep -l commitMessageBundle v3.17.2 -- apps/zcode-cli` 命中 9 个文件，base 3c5b2276 与 main 均 0 命中），fork 没有它 → 多段写入会退回逐 part，**修复退化为部分生效**。要拿到原子性必须一并移植 `SessionStore.commitMessageBundle` 的接口与 sqlite 实现。

## CLI-12 工具批次中停止后不再 drain guide

- **旧行为**：`executeToolCallsForModelStep` 在 `settleToolResults` 之后继续往下走，把挂起的 guide drain 进已经停止的轮次（引导被消费掉但轮次已结束）。另外 checkpoint 被取消时结算写完结果后自己抛出取消，走不到下面的分支，中断标记会用成「模型请求阶段」的文字。
- **新行为**：`settleToolResults` 放进 `try/finally`，`finally` 里若 `turnAbortSignal.aborted` 则置 `interruptedDuringToolBatch = true`；随后 `persistToolModelStepFinish` + `throwIfTurnAborted` 直接结束本轮，guide 由取消路径退回队列。
- **证据**：`core/src/runtime/methods/turn-tools.ts:258`（「继续往下会把挂起的 guide drain 进已停止的轮次；结束后 guide 由取消路径退回队列」）。
- **移植要点与风险**：`turn-tools.ts` fork 改过（需融合）。风险低，但依赖 `interrupt-marker.ts` 的 `withUserStoppedToolResultContent`（同批新增），需一并取。

## CLI-13 rewind 锚点跳过隐藏提醒

- **旧行为**：隐藏提醒写在用户输入与 assistant 之间；`rewind-message.ts` 的 assistant 锚点回溯停在它上面，旧输入留在历史里。
- **新行为**：回溯时跳过隐藏提醒（与 `resume.ts` 的 `turnNumber` 同一判据）。
- **证据**：`core/src/runtime/methods/rewind-message.ts:740`（根因注释）。
- **移植要点与风险**：`rewind-message.ts` fork 改过（需融合）。风险：rewind 直接改历史，建议配上游同款回归（rewind 后模型历史逐字节比对）。

## CLI-14 输入附件收集纪律（前缀稳定性）

- **旧行为**（多条叠加）：
  - 通知在**每次迭代**都 drain：Stop hook 续跑、流重试、模型降级等「重发同一份输入」的请求也被插入通知。
  - 输入附件（环境/模型/output style/tool search 公告/agent listing/skills/todo/退出提醒）在每次迭代都收集；`output_style` 只在 `modelStepCount === 0` 发且不落 session，工具批次后的请求缺它、resume 后前缀也变；`memoryUpdate` 作为「只属于单次请求的 entry」存在，后续请求缺它 → 同一会话内请求前缀变化（缓存失效）。
  - `plan_mode_exit` 只看内存标记 `needsPlanModeExitReminder`，冷恢复后标记丢失，退出提醒不再发出。
  - `runtime_mode` 提醒只写内存，冷恢复时丢失提醒与计数边界。
  - `pendingMemoryUpdate` 先取出再写库，写库失败时这条一次性更新永久丢失。
- **新行为**：新增 `state.inputAttachmentCollectionPending` 门控——只在「轮首、完整工具批次之后、文本回复后续上 guide」收集；`endsWithNewTurnInput` 只看历史判断，resume/fork/rewind 后自然一致。收集顺序固定为 environment → model → output_style_instructions → tool search 公告 → agent listing → skills → plan_mode_exit → runtime_mode → todo → silent_turn → output_style/memoryUpdate，全部走 `persistAnnouncements`（先落盘再提交）。`plan_mode_exit` 改为「内存标记 OR 历史推导」；`runtime_mode` 改为持久化；`memoryUpdate` 写库失败时 `runtime.pendingMemoryUpdate ??= pendingMemoryUpdate` 放回。
- **证据**：`core/src/runtime/methods/turn-loop.ts:73`（通知只在带新输入的请求前取出）、`:275`（「只看内存标记时，冷恢复后标记丢失，计划模式的退出提醒不会发出」）、`:339`（output_style 每次收集）、`:343`（memoryUpdate 一次性 entry 与失败回滚）；`core/src/runtime/helpers/runtime-reminders.ts:317`（「子会话继承父会话 Plan 后收到了主会话的五阶段提醒」）、`:393`（「中途 steer 也带 real_user 来源，算成用户轮次会让提醒发得过早」）。
- **移植要点与风险**：`turn-loop.ts` fork 改过（需融合），`context-refresh.ts` 未改过。**这是本区域风险最高的一项**：它把 turn 循环里散落的「立即写内存」全部改成「先持久化再提交」，改变每次模型请求的字节内容。fork 的 magic-context 宿主适配层（`bootstrap/src/app/magic-context-turn-transform.ts`）会读 runtime entries 做边界计算，附件落盘/顺序变化会影响 MC 的 compartment 边界，**必须重跑 MC 的 `test-magic-context-session-isolation.mjs` 与 `test-cold-open-window.mjs`**。建议拆成两个 PR：先取「plan_mode_exit 历史推导 + runtime_mode 持久化 + memoryUpdate 失败回滚」（低风险、修正确性），再取「collectionPending 门控」（高风险、修前缀稳定性）。

## CLI-15 MCS 投影修正

- **旧行为**：
  - MCS 下 guide 并入 run 末尾的 system，可能排到之后的真实 prompt 后面；`hasRealUser` 按投影位置取最后一个带真实用户来源的条目会选中这条 system → prompt 里的图片失去媒体预算保护。
  - 空闲整批通知在投影时按 `<task-notification>` 开头把连接字符串拆回各条；workflow 运行中通知不以它开头，会被并进前一条的包装。
  - 人类 guide 在 MCS 下单独投影为 user 文本并移到 run 末尾，与其他中途消息、MCS 关、已发布版本都不同。
  - 带图中途消息缺前缀与说明，模型会把它当作新的用户轮次。
  - 中途消息在每个带标记的输入前截断时，通知前的公告留在通知之前，落点错误。
- **新行为**：`latestRealUserIndex(projected, canonical)` 按**原始顺序**最后一条真实用户输入反查投影位置；`task_notification` 整批按「每条通知一个文本块」逐块包装（除最后一块外末尾一个 `"\n"`）；中途消息（含人类 guide）统一走 attachment；带媒体中途消息保留 user 消息形态但在首块补包装；`provider-mid-conversation-system.ts` 的截断点改为在通知之后。
- **证据**：`core/src/runtime/helpers/provider-entry-origins.ts:40`（MCS guide 排到真实 prompt 后面）、`:125`（整批通知拆分）、`:158`（人类 guide 投影）；`provider-mid-conversation-system.ts:86`。
- **移植要点与风险**：`provider-entry-origins.ts`、`provider-mid-conversation-system.ts` fork 未改过；`provider-request-messages.ts` 改过（需融合）。风险：这是 provider-visible 历史的投影层，**magic-context 的前缀缓存与边界计算直接依赖它**；`origins.set(projected, [entry])` 的映射关系一变，MC 的 `cached_m0_*` 基线可能失效。必须先跑 MC 的冷恢复一致性回归。建议与 CLI-16 一起做（两者都改同一函数）。

## CLI-16 补换行只在会合并相邻 user 的协议上执行

- **旧行为**：`separateUserTextBeforeUserInput` 无条件在 user 输入前补 `"\n"`，模拟「相邻 user 内容会合成一条消息」的分隔。OpenAI 兼容协议不合并相邻 user，补了只会改写上一次请求的最后一块，读不到前缀缓存。
- **新行为**：新增 `foldRemindersIntoToolResults` 输入（由模型请求能力决定），`mergesAdjacentUserContent` 为真时才做并入与补换行；换行在并入**之后**判断（上一块是 tool_result 时不补，否则 `"\n"` 会留在数组形态的 tool result 里）。
- **证据**：`core/src/runtime/helpers/provider-request-messages.ts:91`（根因注释）。
- **移植要点与风险**：该文件 fork 改过（需融合）。风险：`foldRemindersIntoToolResults` 需要从 `requestCapabilities` 推导，fork 的 model 能力表若没有对应位需要补；补错会导致 tool result 结构变化，影响所有 provider。

## CLI-17 `localeCompare` 固定 locale

- **旧行为**：`provider-visible-order.ts` 排序用不带 locale 的 `localeCompare`，跟随进程语言设置（如 da-DK 把 `aa` 排在 `z` 之后）。同一会话换语言设置恢复时 tools 段字节变化、缓存失效。
- **新行为**：固定 `en-US`，与原来常见环境下的顺序相同。
- **证据**：`core/src/tool/provider-visible-order.ts:60`。
- **移植要点与风险**：fork 未改过，可直接重放。**成本最低、收益明确**（一次 prompt cache 命中）。

## CLI-18 Bash 失败输出不再被截成 2KB

- **旧行为**：失败命令输出超过 30000 字节就落盘，模型只看到 2KB 开头（`MODEL_RESULT_PREVIEW_CHARS = 2_000`），看不到这段后部的错误原因。
- **新行为**：失败命令输出不落盘，用内联采集的前 30000 字节，超长时 `truncateMiddleForModel` 保留头尾（1 万字符）；`formatProviderErrorContent` 同时去掉了 `staleReadFileStateHint` / `ghRateLimitHint` 的拼接。
- **证据**：`core/src/tool/handlers/bash-model-content.ts:65`（「超过 30000 字节就落盘、只给 2KB 开头时，模型看不到这段后部的错误原因」）。
- **移植要点与风险**：两文件 fork 未改过。风险：`truncateMiddleForModel` 与 `formatCompactPersistedOutputContent` 在 `result-persistence-format.ts`（同批 +58/−0），需一并取；`isBashModelContentBounded` 是给 serializer 判「正文已定界」用的，漏取会导致重复截断。

## CLI-19 工具错误给模型保留多行原文

- **旧行为**：`createErrorResult` 给模型的 `modelContent` 来自 UI 摘要投影（`projectExecutionErrorPayload`），空白被折叠、500 字符截断，多行错误的细节丢失。
- **新行为**：保留换行，`truncateMiddleForModel(selectExecutionErrorMessage(error))` 超过 1 万字符才截中间；与摘要相同时不另存。`preservesReason`（ExitPlanMode / workflow Refine 的用户反馈）仍原样保留。
- **证据**：`core/src/tool/executor/errors.ts:39`。
- **移植要点与风险**：fork 未改过。风险：错误正文变长会增加 token 消耗，且 `preserveReasonFormatting` 路径必须继续原样（否则超长反馈不会触发 `input_too_large`）。

## CLI-20 Hook 文本移出 tool result

- **旧行为**：Hook 的 `additionalContext` 以 `[Hook additional context]` 聚合后拼进 tool result，占用 tool result 预算；失败结果以 UI 摘要为底拼 Hook 文本，有 Hook 与没有 Hook 时模型看到的内容不同。移出后又出现新问题：单条超长 context 整段进入每次请求。
- **新行为**：每条 context 单独成文（`${hookEventName}:${toolName} hook additional context: ...`），多个 Hook 不合并、多行原样保留；单条超过 10000 字符先落盘，模型只看到外壳与预览；落盘失败退回截断并把原因告诉模型。
- **证据**：`core/src/tool/executor/hook-flow.ts:246`（`formatToolHookAdditionalContexts` 与整段根因注释）；`call-runner.ts:613`（「Hook 文本原来拼进 tool result、占用它的预算」）；`result-content-projection.ts` 删除 `appendHookWithoutReorderingStructuredContent` 等 4 个函数。
- **移植要点与风险**：`hook-flow.ts`、`result-content-projection.ts` fork 未改过；`call-runner.ts` 改过（需融合）。风险：这是**模型可见格式变化**，会影响依赖 Hook 文本出现在 tool result 里的技能/prompt；`deps.artifactStore.writeToolResultArtifact` 在 fork 是否存在需确认。

## CLI-21 Bash cwd 写回保留 workspace root 写法

- **旧行为**：`decideBashCwdPolicy` 把规范化后的物理路径写回 `nextWorkingDirectory`；symlink root、`/private` 别名或盘符大小写让同一目录换了写法，环境公告按字符串比较，报出假的目录变化并多跑一次仓库检查。
- **新行为**：规范化只用于判断边界；写回一律用 workspace root 的写法（`join(workspaceRoot, relative)`）。
- **证据**：`core/src/tool/handlers/bash-cwd-policy.ts:43`。
- **移植要点与风险**：fork 未改过，可直接重放。风险低；与 CLI-09/CLI-10 的 env 公告比较逻辑配套。

## CLI-22 workflow 未知业务码连续出现 10 次即停

- **旧行为**：workflow 子代理与工具侧请求持有无上限重试预算，策略表对「分类器不认识的业务码」一律 retry。2026-10-16 事故：服务端对一批账号确定性返回 1113，分类器不认识，run 永远挂着，只剩 stall 通知。
- **新行为**：新增 `WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE = 10`，`nextUnrecognizedCodeStreak` 统计**同一次请求内连续**出现次数（中间夹一次别的失败就清零），达到 10 次以 `kind: "other"` 停下（可 Resume）。计数随 adapter 错误的 `unrecognizedCodeStreak` 带到 driver，保证 runner 与 driver 用同一函数、同一输入。
- **证据**：`adapters/src/model/workflow-model-failure-policy.ts:62`（「根因（2026-10-16 事故）」整段）；`runner-stream.ts` 新增 `countUnrecognizedCode` 并在两条失败路径（外层 catch、流内错误块）各更新一次。
- **移植要点与风险**：fork 未改过。风险：`runner-stream.ts` 同批还混入大量 TTFT 观测代码（红线 1 遥测），**必须只挑 `unrecognizedCodeStreak` 与 `error.retryable = error.retryable` 两处**，不要把 `logLocalModelMilestone` / `publishModelTelemetryMilestone` 带进来。

## CLI-23 MCP pool 连接所有权与幂等关闭

- **旧行为**：`createMcpConnectionPool` 里 entry 的连接 `connectServer` 直接收到**第一个 session 的** `connectOptions.signal`，连接本身归 pool 却继承该 session 的关闭信号 → 关掉那个会话会连带中止其他 lease 的连接。`closeEntry` 非幂等（并发 close 会重复 `adapter.close()` 与 telemetry 注销）。lease 关闭后 `requireEntry` / `acquire` 没有 `assertOpen` 守卫，可能产生迟到 lease。
- **新行为**：entry 持有自己的 `AbortController`（`entry.controller`），`closeEntry` 用 `entry.closing ??=` 幂等；lease 增加 `leaseShutdown` 与 `callerSignal`（`AbortSignal.any`）、`wait()` 包装；`assertOpen` 在 `requireEntry` / `acquire` 前置；引用登记先于任何等待；session 隔离的 server 在 `release(immediate)` 时直接 `closeEntry`。
- **证据**：`adapters/src/mcp/pool.ts:302`（「连接归 pool，不能继承第一个 session 的关闭信号，否则会连带中止其他 lease」）。
- **移植要点与风险**：`pool.ts` fork 改过（需融合）。风险：① `options.telemetry?.unregisterConnection` 属红线 1，移植时删掉（但 `closeEntry` 的 `finally` 结构要保留，否则关闭失败不再冒泡）；② 同批把 `config.source.kind` 的 `user`/`workspace` 映射成 `custom` 是 telemetry 口径，可一并删。

## CLI-24 小型缺陷批（8 项）

| 子项 | 旧行为 → 新行为 | 证据 |
| --- | --- | --- |
| 小数 Bash timeout | 输入 schema 带 `.int()` 时小数 `timeout` 超时转后台被判为工具失败 → 允许小数并原样记录 | `contracts/src/tools/bash.ts:257` |
| 空白 `send-message` | 只有空白的 message 能过 provider JSON Schema（`minLength 1`），runtime schema 拒绝；待发队列里却回报 queued → 两处对齐 | `contracts/src/tools/send-message.ts`、`core/src/tool/handlers/send-message.ts` |
| 超长 message 截断 | 直接 `slice` 会切断 emoji 等代理对，留下孤立高位代理 → 用 `dropTrailingHighSurrogate`，并留一位给省略号 | `contracts/src/tools/send-message.ts` |
| Memory 计数 | 公告持久化成隐藏记录后，`~N messages` 把它们也算进去，数字比实际对话多 → 排除隐藏提醒 | `core/src/memory/extraction.ts:229` |
| 子会话通知 | 结构化 error 随 originMeta 进轮头与每帧快照，原样复制超长 provider 原文；`||` 兜底让只有空白的 error 变成空串而非 `Unknown error` | `core/src/subagent/completion-notification.ts` |
| resume 描述 | 恢复时用 summary 作描述，完成通知与卡片标题都变成这次消息的摘要 → 用原描述 | `core/src/subagent/runner.ts`、`message-steering.ts` |
| reasoning history 换行 | 整段重新合并会给每对相邻 user 多补一个 `"\n"` → 只合并删除点两侧的一对 | `adapters/src/model/reasoning-history-normalization.ts` |
| SQLite metadata | metadata 非数组时按字符串逐字符校验 → 非数组直接忽略 | `adapters/src/storage/session-store/sqlite-session-store.ts` |

- **移植要点与风险**：`send-message.ts`、`runner.ts` fork 改过；其余未改过。逐条可独立取，互不依赖。`dropTrailingHighSurrogate` 是 v3.17.2 新增的 contracts 工具（`git grep -l` 在 target 命中 7 个文件、在 base 与 main 均 0 命中），**fork 没有**，取「超长 message 截断」这条时必须先把它搬进 `@zcode/contracts`。

## CLI-25 Git 快照并行化与「是否仓库」免 spawn（perf）

- **旧行为**：`resolveGitSnapshot` 串行执行 5 条互不依赖的 git 命令（branch / mainBranch / user / status / log），每条 3 秒超时；git 卡住的仓库要等 **7–9 次 3 秒超时**（`resolveMainBranch` 内部还有 `show-ref` 探测）。「是否在仓库」每次都 `git rev-parse --is-inside-work-tree` spawn 一次 git；git 不存在/超时/取消时没有结论，调用方只能写成「不是仓库」或每次请求重跑。
- **新行为**：
  - 5 条命令 `Promise.all` 并行，结果按固定字段组装（字节与串行时相同）；每条命令带 `signal`，请求取消时 git 立即结束。
  - `findGitRoot` 从目录向上走，找第一个含 `.git` 的目录（目录或文件都算，worktree/submodule 的 gitdir 文件也算；symlink 按目标判断）。`resolveIsGitRepository` 用 `realpath` 后查找——是否在仓库是文件系统事实，不需要启动 git。
  - git 可执行文件按 PATH 查找一次并缓存（`gitExecutable ??=`）；配置覆盖按平台构建一次并缓存（`automaticGitConfigs`）。
  - `resolveGitBranch` 改用 `symbolic-ref --short -q HEAD`（旧 `rev-parse --abbrev-ref HEAD` 在无提交仓库以 128 退出，分支名丢失为 `HEAD`）。
  - `status --short` 增加 `--ignore-submodules=dirty`。
- **证据**：`adapters/src/context/git-snapshot.ts:75`（「命令串行时，git 卡住的仓库要等 7–9 次 3 秒超时」）、`:40-70`（`findGitRoot` / `resolveIsGitRepository` 的根因注释，含「指向仓库子目录的链接被判为『不是仓库』；仓库里指向外部的链接被判为仓库，git 命令全部失败，模型看到默认值拼成的假快照」）、`:119`（无提交仓库）、`:184-210`（可执行文件缓存）；`adapters/src/context/index.ts`（`findProjectRoot` 已查找过 `.git`，快照里不再查第二遍）。
- **移植要点与风险**：`git-snapshot.ts` fork 未改过（可重放），`context/index.ts` fork 改过（需融合）。风险：① 返回类型从 `Partial<EnvInfo>` 改成 `GitContext`，调用方（`context/index.ts`、`context-refresh.ts`、`subagent.ts`）都要跟着改，**建议与 CLI-09/CLI-10 一起做**；② `realpath` 在 Windows 上对 UNC / 网络盘的行为需实测；③ `--ignore-submodules=dirty` 会改变 `gitStatus` 内容（子模块 dirty 不再算 dirty），需确认 UI 文案不依赖。

## CLI-26 自动 git 的加固（安全 + Windows 正确性）

- **旧行为**：
  - 自动 git 按裸名 `git` 执行并继承全部环境。Windows 上 `execFile` 的 libuv `search_path` **先在 cwd 里找**，工作区放一个 `git.exe` 就会被自动 git 运行；仓库配置的 `fsmonitor`、hooks 会被执行；继承的 `GIT_DIR` 会让快照读另一个仓库。这些都不经过权限判定（不是工具调用）。
  - PATH 处理不分平台按 `":"` 拆、只留 `/` 开头条目。桌面 host 在 Windows 上以大写 `PATH` 启动 Agent，Windows 条目被全部丢掉 → git 找不到 `git-lfs` 等外部程序 → LFS 仓库的 `status` 失败 → 快照显示干净。
  - 查找可执行文件前先读进程目录，目录被删除时 `process.cwd()` 抛错，PATH 上绝对路径的 git 也找不到。
  - Windows PATH 条目可以写成 `"C:\Program Files\Git\cmd"`（带引号），旧代码带着引号拼路径，这类目录里的程序都找不到。
- **新行为**：
  - 用 PATH 上的**绝对路径**执行；`findExecutableOnPath` 只查 PATH 条目、不加工作目录（Windows 只认盘符/UNC 开头，`\dir` 按当前盘符解析时跳过；只试 `.com` / `.exe`）。
  - 每条命令带固定配置覆盖（`core.fsmonitor=`、`core.hooksPath=<null device>`、`core.askPass=`、`protocol.ext.allow=never`、`submodule.recurse=false`、`log.showSignature=false`、`gc.auto=0`、`maintenance.auto=false`、28 个 `hook.<name>.enabled=false`）以及 `GIT_CONFIG_COUNT/KEY/VALUE` 镜像。
  - 环境净化：去掉继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE`、`GIT_CEILING_DIRECTORIES`、`GIT_CONFIG*`、`GIT_CONFIG_KEY_<n>` 等（大小写不敏感），加上 `GIT_ALLOW_PROTOCOL=/`、`GIT_NO_LAZY_FETCH=1`、`GIT_NO_REPLACE_OBJECTS=1`、`GIT_TERMINAL_PROMPT=0`、`GIT_LFS_SKIP_SMUDGE=1`、`GIT_SSH_COMMAND=false`。
  - PATH 只留绝对路径条目（Windows 用 `splitWindowsPath` + `win32.isAbsolute`，去引号），一个不剩时用空设备。
- **证据**：`adapters/src/context/git-snapshot.ts:214`（「自动 git 不是工具调用，不经过权限判定。原来按裸名执行并继承全部环境…」）、`:394`（Windows PATH 拆分根因）、`:430`（「裸名交给 execFile 时，Windows 先在 cwd 里找」）、`:460`（进程目录抛错）；`adapters/src/exec/windows-executable.ts`（带引号 PATH 条目）。
- **移植要点与风险**：`git-snapshot.ts`、`windows-executable.ts` fork 未改过；`context/index.ts` 改过。风险：① 配置覆盖表较长，Windows 的 `\\\\.\\NUL` 与 POSIX 的 `/dev/null` 需按平台分支（上游已做）；② `GIT_CONFIG_PARAMETERS` 里的 alias 覆盖（`alias.remote-none=version` 等）依赖 git 版本，老 git 可能不认 `alias.<name>.command`；③ 这是安全加固，但**会让「工作区自带 git.exe」的 Windows 用户行为变化**（从「跑工作区的 git」变成「跑 PATH 上的 git」），需要在 CHANGELOG 说明。

## CLI-27 dynamic-workflow 控制流分析的复杂度与语义（perf）

- **旧行为**：
  - `projectControlFlow` 里 `settle` 对主线**完全透明**（原样返回 incoming），于是每个 helper 调用的分叉点永远留在主线上：n 个顺序 `await helper()` 画出 entry 与每个早先调用到每个后来调用的边，共 **n(n+1)/2** 条。上游实测：80 层 helper × 800 处调用 = **1629 万条边、4.7 GB**。而且图是**错的**——它说第三步可以不等前两步就跑。
  - `withEntries` 的占位符边扫描从 `edges` 末尾一直扫到 0；占位符的边只可能在刚才的 sequence 里产生，所以每个 loop / fan-out / strand 都重扫整张图，复杂度是 **region 数 × 边数**。
  - `causality-order-strands` 的几处查找线性扫 `state.strands`；`domain.addPortless` 为找同站点的带端口出现扫一遍整个出现集；`sharesIteration` 每次调用重新过滤站点出现过的全部 region；`causality-order-calls` 按函数声明判重入并内联合并记录。
- **新行为**：
  - `settle` 变成「strand 汇合点」：确定 join 的 strand 被消耗（`park.join(joins, maybeJoins)` 返回 `consumed` / `exits`），主线在屏障处放弃为它携带的控制流；`standsFor` 让占位符代表它的 incoming，全部被消耗时才算被消耗。
  - `edgeMark = edges.length`，扫描只到进入前的长度。
  - 其余查找改为按索引/集合。
- **证据**：`dynamic-workflow/src/analysis/flow-graph.ts:270`（「此前 settle 对主线完全透明…共 n(n+1)/2 条（80 层 helper × 800 处调用时 1,629 万条边、4.7 GB），而且图是错的」）、`:331`（「原来每个 loop / fan-out / strand 都重扫整张图，是 region 数 × 边数」）；`state.ts`、`causality-order-strands.ts`、`domain.ts`、`causality-graph.ts`、`calls.ts`、`interpret.ts` 各有同款根因注释。
- **移植要点与风险**：所有涉及文件 fork 均未改过（可直接重放）。风险：① 这是**语义修复**而非纯性能——控制流图的边集变了，依赖图做「可并行性/顺序」判断的 dynamic-workflow 编排结果会变（更正确，但与旧 run 的转录可能对不上）；② `park.join` 签名变了（多一个 `maybeJoins` 参数、返回对象），`flow-strands.ts`、`causality-order-*` 需同步；③ 建议先补上游同款回归（`dynamic-workflow/tests` 该区间新增 82 个测试文件 / +1173 行），再改代码。

# 4. 看起来像修复但排除

| 改动 | 为什么看着像修复 | 排除理由 |
| --- | --- | --- |
| `core/src/compact/prompt.ts`（替换串模板 `$'`/`$$`/`$&` 被当替换语法；重复格式化 `<summary>` 标签）、`core/src/runtime/methods/compact-active.ts`（摘要请求工具选择、文件恢复重读、子会话五阶段提醒）、`compact-post-reminders.ts`（相对路径 `Read(.env)` 匹配）、`compact-persistence.ts`、`compact-selection.ts` | 都带「修复原因」注释，是真实缺陷 | **红线 3**：fork 已移除 ZCode 原生压缩（`core/src/compact/**`、`compact-*` 在 main 不存在），等价物是 fork 自研的 `sidecar-model-request.ts`。整族不适用 |
| `bootstrap/src/zcode-protocol/session-data/index.ts`（`session.removed` 在文件删除前发布） | 生命周期顺序缺陷 | **data-sync 红线**：该文件在 fork 不存在（`git cat-file -e main:...` 失败） |
| `bootstrap/src/official-command-endpoint/**`、`official-mcp-auth-port.ts`、`core/src/runtime/off-peak/**`、`adapters/src/auth/coding-plan-api-key.ts`、`adapters/src/model/offpeak-retry.ts` | 含错误处理与重试修复 | **官方端点/账号/闲时任务红线**，fork 已下线该产品面 |
| `adapters/src/model/model-execution.ts`（`observeProviderFetch`、`streamTiming`）、`adapters/src/model/runner-stream.ts` 的 TTFT 里程碑、`core/src/runtime/session-features/**` | `streamTiming` 修「缺少线协议观测时回退到缓冲时间」，看着像正确性修复 | **遥测红线 1**：`observeProviderFetch` / `publishModelTelemetryMilestone` / `logLocalModelMilestone` 全是观测通道。`runner-stream.ts` 只挑 `unrecognizedCodeStreak` 与 `error.retryable`（已收进 CLI-22） |
| `core/src/tool/search/exposure.ts`、`history.ts`、`description.ts`、`contracts` 的 `LOCAL_TOOL_SEARCH_NAME` / `DEFERRED_TOOL_CALL_NAME` | `history.ts` 有「同批结果尚未被模型看到…避免并行搜索互相去重」这类修复性注释 | 主体是**新增 local tool search 模式**（新工具名、新延迟调用协议）。BRIEF 明确「新增能力即使顺带修了 bug」不进候选。fork 的 tool search 已接线（`turn-loop.ts` 读 `config.toolSearch`），但本批改动的前提是新模式 |
| `core/src/tool/executor/background-tasks.ts`（−348 行） | 大幅改动，像修资源泄漏 | 实际是**重构**：`BackgroundTaskSnapshot`、`buildWorkflowTaskSummary`、`workflowSnapshotTerminal` 等 12 个 builder 移到 `workflow-artifact.ts`（同批 +337），加上 `registerResidencyBlockingWork` 的 residency 接线（新能力）。无「旧行为错误」证据 |
| `core/src/runtime/methods/steering.ts` 的 `drainPendingInputUnlocked` 改为一次取出全部 inline guide | 注释描述「同一边界按 admission FIFO 取出全部已等待的 guide」，像修「guide 排队延迟一轮」 | 这是**产品行为变更**（一条边界从取 1 条变取 N 条），没有「旧行为是错的」证据；`bootstrap/src/zcode-protocol-v4/product-projection.ts` 的配套注释明说「原来每条取出的 guide 都开启一个工作段。runtime 现在在一个边界按 FIFO 取出全部」——是新交互设计。同批的 `firstInlineGuideIndex` 重构（先入队普通消息挡住后续 guide）在 base 3c5b2276 已修 |
| `bootstrap/src/custom-command-shell-expansion.ts` 整文件删除（−255）+ `contracts/src/commands/index.ts` 新增 `handOffCustomCommandShellBlocks` | CLI 不再抛 `unsupported shell expansion`（真实 bug），且 shell 改由模型经 Bash 执行、受权限服务约束（安全） | 这是**自定义命令执行模型的产品面重做**：`!` 块从「解析期直接执行」变成「改写成交给模型的指令」，用户看到的交互（是否出现一次 Bash 工具调用）都变了；还顺带删掉了 `custom_command_unsupported_dynamic_syntax` 诊断码（协议面变化）。不是可独立移植的缺陷修复 |
| `core/src/context/sections/env-info.ts` 的 `injectionTarget: "system" → "meta_user"`、`# Environment update` 增量公告、`UNTRUSTED_DOWNLOADS_NOTE` | 同文件里确实修了「git 段文案」等细节 | 主体是**上下文注入结构重做**（环境从 system 段搬到 meta_user，新增增量更新公告与安全提示文案）。属产品/提示词重构，非缺陷修复 |
| `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`（3 处修复：整批通知按 `""` 连接、`finish=stop` 无 error 时停止、无可见内容 assistant 不产生事件） | 都是真实的投影缺陷 | 属 **V4 产品投影**（`zcode-protocol-v4`）链路；fork 的 V4 投影是否保留需单独判定（本报告范围只做 CLI 源码，未验证 fork 侧接线）。标**待验证**：需确认 fork 的 `bootstrap/src/zcode-protocol-v4/` 仍是活跃链路，若是则应另立候选 |
| `core/src/memory/memory-agent-loop.ts`（+79/−88）、`core/src/hooks/runner.ts`（+81/−2）、`core/src/tool/handlers/cron.ts`（+92/−1） | 改动量大，像修内存/hook/cron 缺陷 | 均为**新能力接线**（Memory Dream 循环调整、hooks 新事件、automation cron 工具），diff 里没有「旧行为错误」的证据。标**待验证**：若要确认需逐个读 hunk |
| `bootstrap/src/zcode-protocol/session-residency.ts`（+206/−9）、`bootstrap/src/app/session-facade.ts`（+117/−98）、`core/src/runtime/agent-runtime.ts`（+99/−3） | 会话驻留/门面改动，像修生命周期 | residency lease 是新能力（`session-execution/residency-lease.ts` 同批新增），`session-facade` / `agent-runtime` 是为它做的接线重构 |
| `adapters/src/exec/output-collector.ts` 的 `ByteTail` | 注释明写「每个 chunk 复制整个尾部（总输出 × 尾部大小）、每个进度 tick 解码整个尾部…这里摊还 O(总输出)」，是标准 perf 论证 | 但它服务的是**新增的请求级 `outputLimit.tailBytes`**（result 带 `tail`），旧路径没有被优化。属新功能的实现选择，不是对既有热路径的优化 |
| `core/src/runtime/methods/context.ts:96-98` 的 `preContextEntries` + `addEntries` 重复接历史 | 正是 fork 已知的 CLI CR B1（legacy resume 把 provider 历史发两遍，`test-cold-open-window` C3 红） | **上游 v3.17.2 未修**：`git grep -n preContextEntries v3.17.2` 仍在 `context.ts:96/98`。fork 需自行修（删除 88/90 两行），本区间无可 cherry-pick 的补丁 |

# 5. 明确不候选的分类

**纯新功能 / 新产品线**（即使带少量 bugfix 也不进候选）：
`zcode-site-plugin`（站点托管，50 文件 / +7427）、`tools/provider-regression`（供应商回归工具，26 文件 / +3166）、`tools/prompt-trajectory` 的 provider proxy、`bootstrap/src/workspace-mcp-trust/**`（+462）、`bootstrap/src/official-command-endpoint/**`（红线）、`bootstrap/src/app/dynamic-workflow-quota-resume.ts`（+283）、`core/src/runtime/methods/input-prediction-sidecar.ts`（+296）、`core/src/runtime/session-features/**`（+331）、`core/src/runtime/provider-tool-rounds/**`（+350）、`adapters/src/mcp/node-fallback.ts`（+286）、`adapters/src/model/provider-builtin-tool-compat/**`（+285）、`bootstrap/src/app/mcp-node-fallback.ts`、`node-repl-host/src/call-ledger/**`（+249）、`node-repl-host/src/no-progress-guard.ts`（+96）、`office-runtime` 的 documents/adapters 改动、`dynamic-workflow` 的 `analysis/causality-order-*` 新增模块本身（其中的 perf 修复已收进 CLI-27）。

**纯重构 / 纯目录调整**：
`bootstrap/src/zcode-protocol-v4/local-ttft.ts → local-ttft/recorder.ts`（R096）、`core/src/tool/executor/background-tasks.ts` 的 builder 搬迁、`contracts/src/interfaces/**` 新增 port 声明、`core/src/runtime/helpers/provider-request-messages.ts` 的 `appendToolSearchSuccessMessages` / `composeIndexMap` 结构化（行为等价部分）、`core/src/context/builder.ts` + `dynamic-sections.ts` 的段装配重排、`core/src/runtime/methods/turn-model-step.ts` 的职责拆分。

**纯测试**：
`apps/zcode-cli/packages/*/tests/**` 362 个文件 / +35230 −2990（上游为本轮修复补的 vitest 回归）、`bootstrap/tests/tool-history-order.test.ts` 删除。fork 的 CLI 测试基建是 `scripts/test-*.mjs`，这些用例只能作为**回归场景参考**，不能直接搬。

**纯文档 / 文案**：
`apps/zcode-cli/docs/**` 39 个文件 / +2551 −456（其中 `docs/design/v2/tool/tool-history-order-repair-proposal.md`、`docs/bash-tool-ast-permission-semantics.md` 被本报告用作证据）、`packages/*/CONTRACT.md`、`bundled-skills` 文案、各 plugin 的 README 类改动。

# 6. 方法与局限

**方法**：
1. `git diff --numstat 3c5b2276 v3.17.2 -- apps/zcode-cli` 聚类（927 条，按源码/测试/文档 + 按包）。
2. `git diff --name-status` 取 M/A/D/R；A 与 D 逐个看是否本身即修复模块。
3. 对全部源码 M 文件提取新增行里含「修复原因 / 原来 / 缺陷 / 回归」的注释（190 处命中），据此建立候选地图；再对每个候选读完整 hunk 确认「旧行为错 → 新行为对」。
4. 交叉参考 `docs/design/v2/tool/tool-history-order-repair-proposal.md`（新增 `snapshotIndex` 整节）、`apps/zcode-cli/docs/bash-tool-ast-permission-semantics.md`（2026-10-28 回归证据）、`apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`（Git snapshot 一节）、`apps/zcode-cli/docs/design/v2/model/streaming-tool-execution-and-recovery.md`、`docs/dynamic-workflow/concurrency.md`（「Where the port is bound」）。
5. 每个候选执行 `git diff --name-only 3c5b2276 main -- <file>` 判定 fork 是否改过；执行 `git diff v3.17.2 main -- <file>` 判定是否已修（本区域**无一命中**，即 fork 没有任何一项已自行修好）。
6. 对「能力是否存在」的判定用 `git grep -l <symbol> main`：`CronPauseSelf`（0 命中）、`nonGitDirectories`（0）、`READ_FILE_UNCHANGED_STUB`（0）、`preContextEntries`（在，且上游也未修）、`PermissionOptionsPolicy`（11 文件，base 已有）。

**局限（待验证项）**：
- **CLI-14 / CLI-15 / CLI-16 与 magic-context 的交互未实测**。fork 的 `bootstrap/src/app/magic-context-turn-transform.ts` 读 runtime entries 做 compartment 边界，附件落盘时机与 provider 投影顺序变化会影响 `mc<N>` 边界。缺的证据：移植后跑 `bootstrap/scripts/test-magic-context-session-isolation.mjs` 与 `test-cold-open-window.mjs` 的结果。
- **CLI-27 的图语义变化对既有 workflow run 的影响未验证**。缺的证据：fork 侧 `dynamic-workflow` 的转录/回放回归。
- **V4 投影链路（`transcript-hydration.ts`、`product-projection.ts`、`session-flow.ts`）是否仍是 fork 的活跃链路未验证**，因此其中的 3 处修复被放进 §4「待验证」而不是候选。缺的证据：`git grep` fork 侧 `transcript-hydration` 的调用点。
- **`core/src/memory/memory-agent-loop.ts`、`core/src/hooks/runner.ts`、`core/src/tool/handlers/cron.ts` 三处大改动未逐 hunk 读完**，暂判为新能力接线。缺的证据：完整 diff 阅读。
- **CLI-26 的 Windows 实测缺口**：上游对 sed 白名单与 git PATH 处理都只写了「Windows 未实测」，fork 主要用户在 Windows，这两项都需要补实测。
- 本报告只覆盖 `apps/zcode-cli/**`；`packages/shared`、`packages/ui`、`packages/desktop` 侧的配套改动（协议字段、UI 选项策略渲染）未审。
