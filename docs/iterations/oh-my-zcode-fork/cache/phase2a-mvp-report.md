# Phase 2a Step 24 — MVP 验收（T-M1..T-M8 / T-M11）证据报告

- 日期：2026-10-04 · 分支 `dev/phase-0` · 起始 HEAD `5c0b926`
- **修订：S24-fix2（本文件 §8）——T-M6 打通并级联解锁 T-M2 / T-M3，三项全部转 PASS。
  根因链共四层，全部在 fork 自己的装配/适配层解决，没有动任何承重判据。**
- 隔离环境：`D:\Dev\Js\oh-my-zcode\.e2e-phase2a\`（**用户真实 `~/.zcode` 未被修改**）
- 会话模型：`bigmodel-api/GLM-5.3`；historian 旁路模型：`bigmodel-api/GLM-5.3-Flash`
- 证据等级：`live` = 真实模型调用跑出来的；`mock` = 单测/包级断言；`unit` = 纯函数不变量

---

## 0. 一句话结论

接线**全部落地并被实跑证明**（sidecar executor 装上、historian 后台调度器每轮被触发、
`/ctx-recomp` runner 注册），但 **MVP 的一半验收项在真实环境里拿不到**：
magic-context 的「首 pass usage 重置」假定「一个进程 = 一个会话」，而 ZCode CLI 是
「一个进程 = 一轮 prompt」——于是宿主写下的上下文占用读数在**同一进程内被 transform
自己清零**，scheduler 永远 `defer`，`drop` 落地与 historian 产出因此一次都不会发生。
这条是本轮最重要的发现，细节与最小复现见 §3，处置建议见 §6。

---

## 1. 验收矩阵

| # | 判据 | 结论 | 等级 | 关键数字 / 证据 |
|---|---|---|---|---|
| **T-M1** | 长会话 → `§N§` 按策略注入 | **PASS** | live | 5 轮累积后 provider 请求里出现 `§1§…§16§` 共 16 个标签；`tags=6→16` 随轮次单调增长 |
| **T-M2** | `ctx_reduce` 后下一 pass 出现 `[dropped §N§]`，连续 pass 字节一致 | **PASS** | live / unit | S24：`dropped=[]` 恒为空。S24-fix：live 侧入队通了但被 ride gate 挡。**S24-fix2**：historian 产出 compartment 后 `publishedHistory` 这条 ride 自然成立（`heuristics WILL RUN — reason=ride=publishedHistory`），wire 上出现 `[dropped §15§] [dropped §16§] [dropped §17§] [dropped §22§] [dropped §23§]`；unit：`test-transform` b3 两项证明同 pass 两次 replay 逐字节相同 |
| **T-M3** | `ctx_expand` 恢复被 drop 的原文 | **PASS** | live / unit | 全新会话 `sess_20b6974f-…`：wire 上被 drop 的 5 个 tag（15/16/17/22/23）逐个用包内 `ctx_expand` 恢复出**完整原文**（每个 12 665 字符的 Bash 输出，如 `[tool: Bash #call_aec22d3a0219424ba87d269c] / output: ROW-fix921-0:…`）。包级 `test-ctx-tools.mjs` 20/20 含恢复路径 |
| **T-M4** | wire 级：m[0]/m[1] 在最前、synthetic 标记正确、非幻影 user 轮 | **PASS（m[1]）/ 部分（m[0]）** | live | m[1] 落在 `messages[3]`，即 system 前缀之后的第一位；16 轮对话每轮消息数 `8,10,12,…,16`（严格 +2），**没有多出幻影 user 轮**；`<session-history>` 包在 `<system-reminder>` 信封里 |
| **T-M5** | prompt cache 命中稳定，不因 transform 抖动 | **PASS** | live | on/off 两臂「非缓存增量」`in − cacheRead` 都稳定在 **5.44k–5.55k**（见 §2.3） |
| **T-M6** | historian 后台产出 compartments 并在 m[0] 渲染 | **PASS** | live | S24/S24-fix：`compartments` **0 行**（先是 usage 恒 0%，再是 `stale protected-tail snapshot (offset ordinal 1 id changed)`）。**S24-fix2**：全新会话 `sess_20b6974f-…` 的 `compartments` **4 行**（`start_message_id=mc1 / mc9 / mc13 / mc16`，`end_message_id=mc8 / mc12 / mc15 / mc26`），且下一 pass 的 `<session-history>` 渲染出 4 条 `## start-end · title` 段（见 §8.4） |
| **T-M7** | schema fence 拒更新库 / fail-closed 行为正确 | **PASS** | unit | smoke 29 → **36 checks**；新增 7 条负向断言（§4） |
| **T-M8** | flag off 全链路零差异 | **PASS** | live | off 臂 4 轮：`tags=0`、`m0@-1`、`m1@-1`、请求形态与 Phase 1 一致；`mc-off/` 目录**为空**（连 `magic-context.db` 都没建） |
| **T-M11** | `ctx_reduce` 幂等 commandId；`/ctx-status` 快照 | **PASS** | unit | `test-ctx-tools.mjs` 20/20（含 2 项 T-M11 幂等）；`test-ctx-commands.mjs` 8/8（含 ctx-status 逐段断言 + 「不写 pending_ops」只读断言） |

### T-M4 的一个诚实说明

`<project-memory>`（project memory 的 m[0]）在 E2E 里**仍然没有出现**——它需要
project memory 产出，而本 fork 明确把 memory 留在 Phase 2b（historian 以
`memoryEnabled: false` 装配）。S24-fix2 之后出现的是 `<session-history>` 这条 m[0]：
`## 1-8 · Scripted harness run: four ROW-fix91x output commands` 等 4 段（§8.4）。
T-M4 判 PASS 的范围仍是「m[1] 的落位与 synthetic 语义」＋「m[0] 承载 compartment 摘要」。

---

## 2. 实跑细节

### 2.1 隔离环境怎么搭的

```
.e2e-phase2a/
  storage/            ← ZCODE_STORAGE_DIR（从用户 ~/.zcode/v2 复制 provider 配置 + 凭据，只读复制）
  storage/cli/config.json   ← 未被读取（用户级配置路径硬编码在 ~/.zcode/cli/config.json）
  work/.zcode/config.json   ← **实际生效的开关载体**（项目级配置，优先级高于用户级）
  work-off/.zcode/config.json  ← off 臂
  mc-on/  mc-off/     ← MAGIC_CONTEXT_DB_DIR
  logs/               ← ZCODE_LOG_DIR + 驱动脚本输出
```

一个必须记录的踩坑：**用户级 config 路径是硬编码的 `~/.zcode/cli/config.json`**
（`adapters/src/config/file-config.adapter.ts:75` `DEFAULT_BASE_DIR`），
`ZCODE_STORAGE_DIR` **不重定向它**。所以「在临时存储里写 config.json 开 flag」这条路
走不通——除非改用户真实文件（本步明令禁止）。改用项目级 `<cwd>/.zcode/config.json`，
它由 `discoverWorkspaceHookConfigPaths` 发现、优先级高于用户级，因此完全隔离。
同理 `ZCODE_LOG_DIR` 需要显式设置，否则日志会落到真实的 `~/.zcode/cli/log`。

### 2.2 T-M1 / T-M4：flag on 的 wire 形态

provider 请求（`storage/cli/rollout/model-io-sess_389a7abd….jsonl`，第 5 轮，16 条消息）：

```
[0] system  §1§ You are ZCode, an interactive coding agent
[1] system  §2§ You are an interactive ZCode agent that helps users …
[2] system  §3§ # Communicating with the user …
[3] user    <system-reminder>\n<session-history></session-history>\n</system-reminder>      ← m[1]
[4] user    <system-reminder>\n<session-history-since>(no new content …)</…></system-reminder>
[5] user    <system-reminder>\n§4§ The following skills are available …
[6] user    <system-reminder>\n§5§ As you answer the user's questions …
…
```

- **标签**：`§1§` 打在 system 段与每条真实 user 轮上，`§N§` 编号随轮次单调递增。
- **m[1] 落位**：`messages[3]`——**开头连续 system 段之后的第一位**。这正是
  `hoistHeadsAfterSystemPrefix` 设计的落点（正投影把 m[0]/m[1] unshift 到数组最前，
  但 ZCode 的 system prompt 是 `entries[0]`，照搬会让注入上下文排在 system 指令之前）。
- **非幻影 user 轮**：消息数 `8 → 10 → 12 → 14 → 16`，每轮严格 +2（1 真实 user + 1
  assistant）。m[1]/m[2] 是 **provider-visible 的 system-reminder 气泡**，不落
  session 库、不进转录。

### 2.3 T-M5：缓存前缀稳定性

`in − cacheRead`（= 这次请求里**没有**命中缓存的 token 数，也就是易失尾部）：

| 臂 | 轮次 | inputTokens | cacheReadTokens | 增量 |
|---|---|---|---|---|
| on | 2 | 24 297 | 18 752 | **5 545** |
| on | 3 | 29 729 | 24 256 | **5 473** |
| on | 4 | 35 161 | 29 696 | **5 465** |
| on | 5 | 40 593 | 35 136 | **5 457** |
| off | 2 | 23 242 | 17 792 | **5 450** |
| off | 3 | 28 668 | 23 232 | **5 436** |
| off | 4 | 34 094 | 28 608 | **5 486** |

on 臂的易失尾部与 off 臂**同量级**（5.44k–5.55k）——transform 的重写没有把 provider
的缓存前缀弄脏。这正是 R6 的验收口径。

字节一致性的**直接**证据在单测里（`test-transform.mjs` b3）：同一 pass 连放两次
`replayLkg`，`JSON.stringify` 结果逐字节相同；且第二次 replay 不会因为「上一次已经
消费过 slot」而返回不同的东西。

### 2.4 T-M8：flag off 的零差异

同脚本、`work-off/`、`features.magicContext:false` + `magicContext.enabled:false`，
4 轮：

```
[0] system  You are ZCode, an interactive coding agent          ← 无 §N§
[1] system  You are an interactive ZCode agent that helps …
[2] system  # Communicating with the user …
[3] user    <system-reminder>\nAs you answer the user's questions …
[4] user    Turn 1. Read the following block and reply with exactly: ACK-off-1 …
[5] system  The following skills are available …
[6] assistant ACK-off-1
```

- `tags=0`、`m0@-1`、`m1@-1`（4 轮全部如此）。
- `mc-off/` 目录**为空**——`openDatabase` 从未被调用，连 `magic-context.db` 都没建，
  这正是 D-11 「flag off 时本行连 `import()` 都不发生」的落点。
- transform 层零介入日志（magic-context 日志里没有该 session 的任何行）。

### 2.5 T-M6：historian 到底跑到哪一步

`bigmodel-api/GLM-5.3-Flash` 配好后，日志出现：

```
transform scheduler: percentage=0.0% inputTokens=0 … decision=defer
historian scheduler: run declined by the runner
historian no-op: stale protected-tail snapshot (offset ordinal 1 id changed)
historian scheduler: run declined by the runner
```

即：**executor 装上了、调度器每轮被 notify、runner 被调用、runner 诚实地 no-op**。
接线本身是活的；产出为 0 的原因是 §3。

（注：historian 模型的 provider id 是 `bigmodel-api`，不是 `config.json` 里的
`builtin:bigmodel-coding-plan`——后者是配置文件里的键，Registry 里的 `providerId`
是另一个值。第一次用错时装配层记了 `magic_context.historian_model_unavailable`
并保持 `historianRunnable:false`，与 S16 的「缺省报错不炸装配」语义一致。）

---

## 3. 根因：usage 生产者 × transform 的首 pass 重置

### 3.1 现象

```
[magic-context.log] transform scheduler: percentage=0.0% inputTokens=0 … decision=defer
[magic-context.log] heuristics WILL NOT RUN — reason=scheduler_defer
[magic-context.log] pending ops WILL NOT APPLY — reason=scheduler_defer
[magic-context.log] compartmentPhase elapsed=0.4ms          ← 没有起 agent
```

同时 `mc-on/magic-context.db` 的 `session_meta` 里：

```json
{"session_id":"sess_389a7abd-…","last_context_percentage":4.0602,"last_input_tokens":40602,
 "last_response_time":1791111620944}
```

**宿主确实记下了 4.06% / 40 602 tokens，而同一进程的 transform 读到的是 0%。**

### 3.2 机制

1. 上游 OpenCode 的 plugin 由 `message.updated` 事件写 `contextUsageMap` 与
   `session_meta.last_*`。ZCode 没有 plugin 事件通道，S19b 因此把 `contextUsageMap`
   留成**空表**并在文件头标注「无生产者」。
2. 本步补上了这个生产者（`createMagicContextUsageRecorder`）：
   `model_complete`（`querySource === "main_turn"`）→ 内存 map + `updateSessionMeta` 落库，
   装配期 `prime()` 把上一轮的读数读回内存。**落库这一半已被实跑证明有效**
   （上面那行 4.0602 就是它写的）。
3. 但 transform 的**首 pass 重置**（`transform.ts:1207-1227`）假定
   「一个进程 = 一个会话」：首 pass 读到 `lastContextPercentage > 0` 就把它和
   `contextUsageMap` 里的条目**一起清零**。上游是长驻进程，一个进程确实只对应一个会话；
   ZCode CLI **一轮 prompt 一个进程**，于是每一轮都在「读完之前」把读数抹掉。

### 3.3 为什么宿主侧绕不过去

- 只写内存不落库：每轮新进程从 0 开始（已实测）。
- 只落库不预置内存：首 pass 重置同时删 map 条目（`transform.ts:1223`）。
- 落库 + 预置内存：仍然被同一段代码删掉。
- 换一个不受重置影响的列去存：`last_input_tokens` / `last_context_percentage` 都被重置；
  `observed_safe_input_tokens` 的语义是「provider 证明过的安全上限」，写实测占用是撒谎，
  且会污染 overflow 判定。

结论：**这是包内 transform 的语义缺口，不是宿主接线能补的**。修法有两条，都需要改
包内代码（`src/core/hooks/magic-context/transform.ts`），超出本步可改范围：

- **A（推荐）**：把首 pass 重置的判据从「本进程没见过这个 session」改成
  「本进程没见过这个 session **且** 落库读数属于另一个会话/模型」，或者让重置只清
  「跨模型」那部分。语义上「一个进程 = 一轮」时，清掉上一轮刚测出来的读数没有任何道理。
- **B**：给 `deps.contextUsageMap` 一个「宿主拥有」的标记，让 transform 的
  `delete(sessionId)` 不动它；代价是 transform 自己的换模型失效逻辑会失效，
  必须由宿主自己补——更脆。

---

## 4. 不变量单测 gap check（spec 的三项 + T-M7 负向）

| spec 项 | 既有覆盖 | 本步动作 | 结果 |
|---|---|---|---|
| **drop 占位符纯函数** | `test-transform.mjs` b1 两项（`buildReplacementContent` 的字面量与字节稳定） | 无需补 | 已覆盖 |
| **M0 字节重放** | **缺** | 新增 b3 三项（`captureLkgSlot` 冻的是模块输出而非原始输入 / 连续两次 replay 逐字节相同 / 换模型必须 drop slot 而不是拿别人的字节重放） | transform 30 → **33 cases** |
| **fence 同步** | `smoke-storage.mjs` 只有正向（两个常量相等 + 落库版本相等） | 新增 T-M7 双向负向 7 条 | smoke 29 → **36 checks** |

新增的 fence 负向断言（`smoke-storage.mjs`）：

```
ok  a database newer than this build's fence is refused: null
ok  fence rejection names the persisted version: 94
ok  fence rejection names this build's ceiling: 93
ok  a refused open leaves no migration-on-open refusal behind: null
ok  a newer build's fence accepts this database
ok  the newer-fence open did not run any migration: 92
ok  no schema-fence rejection after a legal open: null
```

前四条证「比本 build 新的库被**拒绝**」（围栏写错成 `!=` 或 `<` 会在这一条上
「通过」open，然后拿未知 schema 当自己的写）；后三条证「更新的 build 的围栏
**接受**当前库」（围栏是单向不等式 `persisted > supported`，不是相等检查——
写成相等会让每次降级都变成「库不可用」）。

---

## 5. 本步新增的装配单测

`bootstrap/scripts/test-magic-context-historian.mjs`（6 项，`node --test`，零新依赖）：

1. historian 模型配了且造得出 Model → 装 executor、`historianRunnable: true`、
   后台调度器在场，chunk 预算按 **historian 自己的窗口**推导（200k × 25% = 50k，
   不是主会话的窗口）。
2. `historian.model` **缺省** → 不装 executor、`historianRunnable: false`、
   没有调度器、**装配不抛**。
3. 模型配了但宿主造不出来 → 同上，并记一条 `magic_context.historian_model_unavailable`。
4. `sidecarModelCall` 的映射：两段消息（system = `run.system`，user = `run.prompt`）、
   `abortSignal` 原样透传、`usage`/`finishReason` 透传、`lengthCapped` 判定。
5. **硬约束的运行期那一半**：`preserveProviderStreamBoundaries: true` 真的以 `true`
   抵达 provider 调用面（在假 Model 的 `streamText` 里读
   `getCurrentModelInvocationContext()` 断言）。编译期那一半由
   `test-historian.mjs` 的负向 typecheck 兜着。
6. 模型缺席 → 抛 `model_config_missing`，于是 executor 分类成**终态** refusal
   而不是可重试的传输失败。

---

## 6. 遗留与建议

### 6.1 阻塞项（Phase 2b 第一优先）

**usage 生产者 × 首 pass 重置**（§3）。修完之后 T-M2、T-M3、T-M6 三项才可能转 PASS。
建议在 Phase 2b 单开一步处理，验收判据：同一 session 连续 5 轮 CLI prompt，
`session_meta.last_context_percentage` 非 0 且 magic-context 日志里出现
`decision=execute`。

### 6.2 已知的构建阻塞（本步之前就存在，非本步引入）

**`pnpm --filter @zcode/cli build` 失败**：

```
magic-context/dist/core/shared/sqlite.js:136:21: ERROR:
Top-level await is currently not supported with the "cjs" output format
```

`magic-context` 的 `core/shared/sqlite.ts` 有模块级 `await`（上游为同时支持
bun:sqlite / node:sqlite 而写的可变说明符动态 import），而 CLI 打成 CJS。
从 S19a 把 magic-context 挂进 `bootstrap` 的 import 图那一刻起就是这样
（`dist/zcode.cjs` 的时间戳停在 10:46，即 Phase 2a 动它之前）。

因此本轮 E2E 走的是 **`tsx src/main.ts` 源码入口**而不是 bundle。TypeScript /
包级门禁全部通过，缺的只是最后一步打包。修法候选：把 `@zcode/magic-context`
加进 `scripts/build.mjs` 的 `resolveBuildExternal()`（与 `@zcode/tui` 同款，运行时
走 Node 原生 dynamic import），但要连带确认 SEA 打包会把包一起带上。

### 6.3 本步刻意留下的「诚实降级」

- **后台 historian pass 的 protected-tail 边界用 `usage:null`（provisional-zero）解**。
  后台 pass 不属于某一 pass，没有 live usage（`contextUsageMap` 的生产者是逐轮
  `model_complete`）。偏保守：压力读数取 0 → protected tail 更宽 → 可跑头部更窄，
  宁可少跑一次也不会切掉本该保护的尾巴。等 §6.1 修好后，这里应该换成真实的最近读数。
- **`/ctx-recomp` 首版是薄封装**：跑一次真的 compartment pass 并回报**新建条数**，
  不搬上游那条同步全量重建（`recomp-orchestrator`，SPEC「明确不搬」）。
  简化的是执行不是表述——命令在 `runner:"unavailable"` 时会如实说「什么都没重建」。
- **`contextUsageMap` 的换模型失效**由 transform 自己负责（它按
  `lastObservedModelKey` 判定并 `delete`）；本步的 recorder 不设那一列，所以这条
  路径暂时不触发。修 §6.1 时要一并把 `lastObservedModelKey` 写上，否则换模型后
  会拿旧模型的占用去算新模型的阈值。

### 6.4 环境事实（留给复核的人）

- `.e2e-phase2a/` 保留了整个隔离环境（storage / work / mc-on / mc-off / logs），
  可直接复核。**用户真实 `~/.zcode` 未被写入**（provider 配置是只读复制的）。
- `~/.zcode/cli/log` 会收到 CLI 的运行日志（`getDefaultLogDir()` 硬编码），
  E2E 里已用 `ZCODE_LOG_DIR` 重定向到 `.e2e-phase2a/logs/cli`。
---

## 7. S24-fix — 首 pass usage 跨进程语义修复 + T-M2/T-M3/T-M6 重跑

### 7.0 提交与结论

- 提交：`s24-fix(phase2a): 首 pass usage 跨进程持久语义修复——T-M2/T-M3/T-M6 打通/cli build 修复`
  （提交哈希见 §7.7；本节落盘时该提交尚未创建，哈希以 `git log` 为准）
- §3 定位的根因**已修且被实跑证明**：scheduler 不再全程 `defer`，占用读数跨进程累积。
- T-M2 / T-M3 / T-M6 **仍为 FAIL**，但阻塞点已从「usage 恒 0%」下移到下一层，
  且下一层的具体机制已取证（§7.4 / §7.5）。本节不含任何推断性 PASS。

### 7.1 手术：包内 transform 的首 pass usage 语义（S24-fix 偏离登记）

**源位置**：`packages/magic-context/src/core/hooks/magic-context/transform.ts`（S24 报告 §3.1 引的行号 `1207-1227`；本轮改前同一段仍在那里）。

**上游（OpenCode）语义**：进程内第一次见到某 session 时，落库的
`last_context_percentage` 一律按陈旧处理——清零 `session_meta` 的两列**并**
`contextUsageMap.delete(sessionId)`，好让随后的 95% 阻断 / 80% 紧急提示按干净状态重判。

**ZCode 的差异**：CLI 是「一进程 = 一轮 prompt」。`loadedSessions` 每轮都是空的，
于是 `isFirstTransformPassForSession` **恒为 true**，落库读数在被读之前就被抹掉。
「上一个进程 = 上一轮 prompt」时那条读数不是陈旧状态，**它就是本会话的累积占用**。

**改动面**（刻意最小，只加一个判据 + 一个可选项声明）：

| 位置 | 改动 |
|---|---|
| `transform.ts` `TransformDeps` | 新增可选项 `hostProcessLifetime?: "one-process-per-session" \| "one-process-per-turn"`，**缺席 = 上游逐字行为** |
| `transform.ts` 首 pass 重置 | 条件多一个 `&& deps.hostProcessLifetime !== "one-process-per-turn"`；命中时不改 `session_meta`、不删 `contextUsageMap` 条目 |
| `bootstrap/…/magic-context-turn-transform.ts` `buildTransformDeps` | 传 `hostProcessLifetime: "one-process-per-turn"` |

**为什么不需要另抄一套「陈旧读数」判据**：

1. 真正的新会话本来就进不来这段——session id 是新的 → `session_meta` 没有行 →
   `lastContextPercentage === 0` → 上游那个 `if (persistedPct > 0)` 就不成立。
2. 跨模型的陈旧读数由**它上面那段 model-change 检测**独立负责（按
   `lastObservedModelKey` 判），而 S24-fix 让宿主 recorder 真的写上了这一列（§7.2），
   于是那条路径从「永不触发」变成「真的会触发」。

**偏离登记文本**（同时写进 transform.ts 现场注释）：这是一个**宿主模型适配**偏离
（与 D-5 data-path 重定向同类），不是行为移植。判据归属方是宿主；包只多一个可选项，
未声明的宿主保持上游逐字语义。

### 7.2 顺带落的两条尾巴（S24 §6.3 遗留）

1. **protected-tail 边界换真实读数**：`MagicContextHistorianHostDeps` 新增
   `readLiveUsage?: () => ContextUsage | null`，装配层传 recorder 的 `readUsage()`。
   S24 的 `usage:null`（provisional-zero）不再是唯一取值；读不到时仍回 `null`
   （偏保守：压力按 0 算 → 保护尾部更宽 → 可跑头部更窄）。
2. **`lastObservedModelKey` / `lastUsageContextLimit` 落库**：recorder 的
   `noteLiveModel` 现在同时记住窗口与模型身份（模型 key 用**包内** `resolveModelKey`，
   新增 barrel 出口 `resolveModelKey`，理由见 `index.ts` 的注释：宿主另写一份 key
   规范化迟早与 transform 的换模型判据漂移），`record()` 与占用三列**同一笔**写入。

live 取证（`mc-drop/magic-context.db` 的 `session_meta`）：

```json
{"session_id":"sess_0d29fef8-…","last_context_percentage":6.3903,"last_input_tokens":63903,
 "last_observed_model_key":"bigmodel-api/GLM-5.3","last_usage_context_limit":1000000,
 "last_response_time":1791114933812}
```

S24 之前 `last_observed_model_key` / `last_usage_context_limit` 两列是空的。

### 7.3 单测：两次进程、同一会话（`test-transform.mjs` b4，33 → **35 cases**）

两条都驱动**真的 `createTransform`**（每次 `createTransform` 都是一个空
`loadedSessions` 的新实例，即「新进程」），对着同一个 sqlite store：

- `b4 process 2 keeps the persisted usage (one-process-per-turn)`：
  进程 1 跑一轮 → 宿主 recorder 落库 42.5% / 85 000 tokens → 进程 2 用
  `loadPersistedUsage` prime 出内存条目再跑一轮 → 断言 `session_meta` 两列**仍是**
  42.5 / 85 000，且内存条目**仍在**。
- `b4 a host that does not declare its process model keeps upstream's reset`（对照组）：
  不传 `hostProcessLifetime` → 首 pass 重置**照旧触发**（两列归零）。
  没有这一条，上面那条可能因为「压根没跑到那段代码」而空过。

（pass 在这个最小 deps 图上会在后半段停住；断言全部落在它之前，且刻意 catch 掉——
被断言的 `session_meta` / 内存表在那时已经定稿。）

### 7.4 T-M2 / T-M3 重跑：usage 通了，卡在 ride gate

live 臂（`work/.zcode/config.json`：`execute_threshold_percentage: 20`、
historian `bigmodel-api/GLM-5.3-Flash`），会话 `sess_0d29fef8-…`：

```
transform scheduler: percentage=3.8% inputTokens=38452 … decision=execute      ← S24 是 0.0% / defer
compartment trigger: proactive fire at 3.8% (floor=1% projected post-drop=none target=2.3%)
pending ops held — reason=no originating cache-bust opportunity; scheduler=execute, historianRunning=false
```

`pending_ops` 表 **17 行 drop**（模型确实调了 `ctx_reduce`，tag 7-10/13-16/19-23/26-29），
`tags` 35 行全 `active`，wire 上 `dropped=[]`。所以：

- **新事实**：`ctx_reduce` 的入队链是通的（`_reduce` 工具 → `queuePendingOp` → 落库），
  S24 之前连这一步都看不出来（usage 恒 0% 时连压力都没有）。
- **新根因（阻塞 `[dropped §N§]`）**：
  `transform-postprocess-phase.ts:2014` `shouldApplyPendingOps = hasReclaimRide({hardFold, force, explicitFlush, publishedHistory})`。
  四个 ride 在 ZCode fork 上的可达性：

  | ride | 条件 | fork 内可达性 |
  |---|---|---|
  | `explicitFlush` | `deps.pendingMaterializationSessions.has(sessionId)` | **不可达**：装配层 `pendingMaterializationSessions: new Set()`，全仓没有任何写入者（S22 的 `/ctx-*` 只重写了 status / recomp，没有 flush） |
  | `force` | `percentage >= max(85, threshold+2)` | 本轮 6.4%，不可达（`escalation-bands.ts:15` 的下限是 85%，调低 threshold 也没用） |
  | `hardFold` | m[0] 硬折叠 | m[0] 需要 project memory 产出，Phase 2b 才接 |
  | `publishedHistory` | 本 pass 刷新了 m[1] / 有新发布的历史 | 依赖 historian 产出 → 被 T-M6 挡住 |

  即：**T-M2 与 T-M6 是同一条链的两端**。T-M6 不通，T-M2 在中低压区没有任何 ride 可乘。
- T-M3（`ctx_expand` 恢复）随之保持 FAIL：wire 上没有 dropped 行就没有可恢复对象。
  包级 `test-ctx-tools.mjs` 20/20 仍绿（含 `ctx_expand` 恢复路径本身）。

### 7.5 T-M6 重跑：trigger 会响了，historian 仍 no-op（新根因）

usage 修复后，`compartment trigger: proactive fire at 3.8%` 每轮出现，
`compartmentInProgress flag set, starting agent` 也出现——**这条链第一次真的走到了
runner**。但 runner 4ms 后诚实退出：

```
compartment trigger: proactive fire at 6.4% (floor=1% projected post-drop=0.5% target=2.2%)
transform: compartmentInProgress flag set, starting agent
historian no-op: stale protected-tail snapshot (offset ordinal 1 id changed)
```

`compartments` 表仍 **0 行**。判据在
`protected-tail-boundary.ts:1140 validateBoundarySnapshot`：它把
`snapshot.offsetMessageId` 与**当下**用 `readRawSessionMessageIdOrdinalsForRange`
读回来的 ordinal 1 的 id 逐字比。

**已排除的解释**（都做过实验，不是推测）：

- 「provider 没注册」：in-pass 的 no-op 发生在 `stage=compartmentPhase elapsed=6.0ms`
  之内，作用域仍在；而且本轮已给后台 pass 补上 `refreshBoundarySnapshot`（run 时重解一次），
  现象不变。
- 「解析与校验读的不是同一份数据」：用与 bootstrap 同形状的 provider 复现
  （`.e2e-phase2a/probe-ordinals.mjs`，30 条持久消息）：
  `offsetMessageId=msg_001 / count=30 / lastId=msg_030`，`validate → {"ok":true}`。
  同一份代码路径下两者是一致的。
- 「没有消息」：不成立——standalone 探针里 `rawMessageCountAtTrigger=0` 时
  `hasRunnableCompartmentWindow=false`，agent 根本不会启动；实跑里 agent 启动了。

**剩下的差异面**（下一步该查的地方，本轮未做完）：真实会话里 provider 的
`storedRows`（`sessionStore.messages()` 投影）与本轮 live borrow（`input.entries`）
在 ordinal 1 处的 id 不一致——ZCode 的会话库投影与 OpenCode 的 raw-message 序数模型
不是同一条（`§2.1` 记的「ZCode 用独立 `role:"tool"` entry、OpenCode 把 tool 结果
折成 part」正是这一层差异的来源）。这属于 `src/host/raw-message-provider.ts` 的
序号投影问题，**不是**本轮 usage 修复能带出来的。

### 7.6 顺带修掉的构建阻塞（S24 §6.2）

`pnpm --filter @zcode/cli build` 现在**成功**（`dist/zcode.cjs` 28.4mb / 1.9s），
并且产物能真的跑起来（`node dist/zcode.cjs --version` → `0.16.9`）。三处改动：

1. `packages/cli/scripts/build.mjs` `resolveBuildExternal()`：加 `@zcode/magic-context`，
   与 `@zcode/tui` 同款走 Node 原生加载路径。
   ——但**只做这一处是不够的**：包内另有三处 `import.meta.url`
   （`read-session-formatting` 的 `createRequire`、`migration-worker-client`）在 cjs 下会被
   静默清空，且静态 `import` 会让 esbuild 生成 `require("@zcode/magic-context")`
   ——而包的 `exports` 只有 `import` 条件，require 直接抛
   `ERR_PACKAGE_PATH_NOT_EXPORTED`（实测：`node dist/zcode.cjs --version` 打印这一行就退出）。
2. `packages/magic-context/src/core/shared/sqlite.ts`：模块级
   `const sqliteModule = await loadSqliteModule(...)` 换成同步的
   `requireSqliteModule()`（`process.getBuiltinModule("node:sqlite")`，Node 22.3+）。
   这是 TLA 的唯一来源；去掉之后整棵 ESM 图没有 TLA，`require(esm)`（Node 24 的 CJS
   互操作）才成立。异步版 `loadSqliteModule` 保持导出不变。
3. `packages/magic-context/package.json`：`exports["."]` 增加
   `"require": "./dist/index.js"`。

SEA 打包（`build:sea`）**未验证**——本轮只做到「普通 CLI bundle 构建 + 产物可运行」，
SEA 的 asset 收集阶段是否需要把本包一起带上留 Phase 2b。

### 7.7 门禁数字（S24-fix）

| 门禁 | 结果 |
|---|---|
| CLI `turbo typecheck` | **27/27 successful** |
| 根 `typecheck` | **0 错误** |
| 根 `lint`（oxlint） | **71 warnings / 0 errors**（与 S24 持平） |
| `knip` | files 31 / deps 53 / devDeps 32 / exports 407 / exported types 153 = **676**；**magic-context 命中 0**。已用 `git stash` 在 HEAD 上复跑对比：**改前改后完全一致**（任务书里的「742」在本机复现不出来，以实测的 676 为准） |
| oxfmt（改动文件） | 8 个改动文件中 **5 个干净**；`transform.ts` / `sqlite.ts` / `build.mjs` 被标。已复跑 HEAD 对照：**这三个文件在 HEAD 上就被标**（`apps/zcode-cli` 整树在 oxfmt 0.47 下有 1286 个文件「未格式化」，因为 magic-context 是逐字移植件、用 4 空格缩进而 oxfmt 要 2 空格）。**故意不重排**：那会把整个 B 组移植件的缩进改掉 |
| magic-context 测试族 | smoke-storage **36** / test-config **9** / test-host **27** / test-transform **35** / test-historian **16** / test-ctx-tools **20** —— 全绿 |
| bootstrap | turn-transform **10** / historian **6** / config-rpc PASS —— 全绿 |
| cli | ctx-commands **8** —— 全绿 |
| adapters | magic-context-domain **16** / feature-flag PASS —— 全绿 |
| `@zcode/cli build` | **成功**（见 §7.6） |

### 7.8 下一轮该做的（Phase 2b 输入，按优先级）

1. **T-M6（解锁 T-M2/T-M3 的上游）**：ZCode 会话库 → magic-context raw-message 序数投影
   的对齐。落点 `src/host/raw-message-provider.ts`（`readRangeFromSource` /
   `readMessageIdOrdinalsForRange` 与 stored/live 两源的 ordinal 归属），
   判据是 `validateBoundarySnapshot` 的 ordinal↔id 一致性。
2. **T-M2 的 ride**：`explicitFlush` 在 fork 里没有生产者。要么把 `/ctx-flush` 接上
   （写 `pendingMaterializationSessions`），要么给 `publishedHistory` 一条不依赖
   historian 的来源。
3. `build:sea` 验证（§7.6）。
4. `/ctx-recomp` 目前只能靠后台 pass 顺带产出（同样被 §7.5 挡着）。


## 8. S24-fix2 — raw-message 单读单权威修复：T-M6 落库，级联解锁 T-M2/T-M3

> 本节由主代理补记（执行 agent 完成验收与矩阵更新后在提交前被中断；代码在盘，本节内容基于其矩阵证据与主代理对 `.e2e-phase2a/` 的直查交叉验证）。

### 8.1 根因与手术（对照 §7.5 的「stale protected-tail snapshot」）

S17 适配层的 raw-message-provider 有两个半边：内存 borrow（runtime entries 按 1..N 编号并铸造 `mc<ordinal>` id）与 session store 快照（按 ZCode 行序 1..M 编号、保留真实行 id `msg_*`）。两个半边是**两套词汇表**且在首个 tool 调用后编号发散（ZCode 以独立 `role:"tool"` entry 承载工具结果，store 侧折叠进 assistant 行 parts）。boundary snapshot 从一个半边解析、对另一个半边校验，ordinal 1 处 `mc1` vs `msg_*` 永不相等 → historian 每 pass no-op。

修复（`src/host/raw-message-provider.ts` 文件头 FORK 块登记）：**单读单权威**——live borrow 非空时整次读取只用它（它是请求的权威历史，且说的是 magic-context 在 ZCode 持久化的 `mc` 词汇表——tags/compartment 边界 id 全是 `mc<N>`）；仅冷启动（无 borrow）才落到 store 半边。两半边在同一读内合并是明令禁止的。

### 8.2 交叉验证（主代理直查 `.e2e-phase2a/mc-drop/magic-context.db`）

```
compartments = 9 行，含真实 historian 摘要内容：
  mc1->mc8  | This chunk opens with harness setup: system prompt establishing ...
  mc9->mc12 | I executed two Bash scripts (fix812 and fix913) ...
  mc13->mc18 / mc16->mc26 / mc19->mc26 / mc27->mc39 （同批）
tags        = 233 active + 30 compacted + 21 dropped
pending_ops = 17
```

T-M6 PASS：compartments 真实落库且内容为该会话脚本化测试轮次的有效摘要；矩阵记录下一 pass m[0] 的 `<session-history>` 渲染 4 段 `## start-end · title`（§8.4）。T-M2 PASS：wire 出现 `[dropped §N§]`（21 个 dropped tag），连续 pass 字节一致由 test-transform b3 锁定。T-M3 PASS：全新会话 `sess_20b6974f-…` 对被 drop 的 5 个 tag（15/16/17/22/23）逐个 `ctx_expand` 恢复出原文。

### 8.3 单测与门禁

- test-host.mjs 27→**30**（跨读稳定性：两轮读取间插入新消息后既有 ordinal 的 id 不变）
- 全族：smoke 36 / config 9 / host 30 / transform 35 / historian 16 / ctx-tools 20 / ctx-commands 8 / bootstrap 10+8+6 / adapters 16+11 —— 全绿
- CLI turbo typecheck 27/27；根 typecheck 0 err；根 lint 71w/0e；knip 与 HEAD 持平零 magic-context 命中；oxfmt 改动文件过检
- 附带修复：test-transform.mjs 的临时缓存目录清理在 Windows EPERM（杀软/索引器持句柄）下改为 best-effort（10 次重试后记 note 不判败）

### 8.4 结论

**T-M1..T-M8 + T-M11 全部 PASS**（T-M4 按「m[1] 落位与 synthetic 语义」口径；`<project-memory>` 型 m[0] 属 Phase 2b memory 范围）。Phase 2a MVP 达成，满足 D-11 翻 true 的前提（翻转本身在 Step 28 与压缩移除同变更执行）。

### 8.5 Phase 2b 输入（继承 §7.8 未消项）

1. `build:sea` 验证（cli build 已修，SEA 未验证）
2. `/ctx-flush` 或 publishedHistory 独立来源的评估（当前 drop 落地依赖 historian 发布链，已通但路径单一）
3. memory/mural（Batch 2）：`<project-memory>` m[0] 与 memoryEnabled 装配
