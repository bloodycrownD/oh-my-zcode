# Phase 2b Step 28 主体 — 压缩移除全量回归报告

- 日期：2026-10-04/05 · 分支 `dev/phase-0` · HEAD `1189755`（工作树干净，回归期间未改任何 src）
- 范围：S26/S27/S28a 删净原生压缩后的**全量回归**（门禁 + 构建 + 真机 E2E + 残留扫描 + 测试族）
- 关键前提：`features.magicContext` 保持默认 **false**，回归跑在**无 transform 态**。本轮**不翻 flag、不打 tag、不改代码**
- 环境：便携 Node **v24.14.0**（`D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64`）；pnpm 走 Scoop shim 内部 node22 的 engine 警告为既有无害条件
- 证据目录：`D:\Dev\Js\oh-my-zcode\.e2e-phase2b\`（storage / work / mc / logs / tests，共 167 文件）

---

## 0. 一句话结论

**全绿。** 门禁 5 项、构建 2 项、E2E 8 用例、残留扫描、测试族 13 套全部通过，**未发现任何压缩移除引入的回归，未做任何代码改动**。
唯一需要登记的偏差是**残留扫描的绝对行数与任务书给的 S28a 基线 1396 对不上**（实测 1419），但**本轮 −1 的相对变化精确成立**（1420 → 1419），详见 §5.2。

---

## 1. 门禁：三套 typecheck + lint + fmt

| 门禁 | 命令 | 结果 | 判定 |
|---|---|---|---|
| 根 typecheck | `pnpm typecheck` | **0 error**（`tsc -b` 11 个 project 全过，无诊断输出） | ✅ |
| CLI typecheck | `cd apps/zcode-cli && pnpm typecheck` | **27/27 successful**（turbo，`FULL TURBO` 命中缓存） | ✅ |
| desktop 全量 typecheck | `node scripts/typecheck-desktop-full.mjs` | **59 error kinds**（baseline 366 / removed 307），脚本自判 **`gate OK: no new errors`** | ✅ 差分无新增 |
| 根 lint | `pnpm lint`（oxlint） | **Found 71 warnings and 0 errors** | ✅ 与基线持平 |
| oxfmt（改动文件） | 逐文件 `oxfmt --check` | **13/13 干净，零新增不合规** | ✅ |

### oxfmt 的一个必须记录的环境事实

`7cae56c^..1189755` 实际触及 **13 个文件**（任务书写 15，去重后 13）。它们分属**两个格式化器管辖区**：

- 根 `.prettierignore` 显式排除 `apps/zcode-cli/`（注释写明：apps 自带更高版本 oxfmt，根仓不应跨目录改写，否则两边格式化器互相打架）。
- 因此那 6 个 `apps/zcode-cli/**` 文件用**根 oxfmt 跑会被判 "Expected at least one target file"**（被 ignore 规则排除，不是格式问题）。
- 正确口径：`packages/**` 那 7 个用根 `node_modules/.bin/oxfmt`，`apps/zcode-cli/**` 那 6 个用 `apps/zcode-cli/node_modules/.bin/oxfmt`（0.47）且 cwd 必须在 `apps/zcode-cli` 内。两侧全部 `All matched files use the correct format.`

---

## 2. knip（口径：与 S28a 前基线差分 = 零新增 + 零 magic-context 命中）

工作树干净，`git stash` 不适用；改用**checkout 法**做差分：

1. HEAD 跑 knip 存 A（`logs/knip-head.norm.txt`）
2. `git checkout "7cae56c^" -- <13 个文件>` 把这批文件回退到 S28 前基线，跑 knip 存 B（`logs/knip-base.norm.txt`）
3. `git checkout HEAD -- apps packages` 还原（已确认工作树回到干净）

**结果：`fc /n` 报告「找不到差异」——两次输出逐字节相同。**

| issue 类型 | 数量（HEAD = 基线） |
|---|---|
| Unused files | 32 |
| Unused dependencies | 53 |
| Unused devDependencies | 32 |
| Unlisted dependencies | 8 |
| Unused exports | 407 |
| Unused exported types | 152 |
| Duplicate exports | 36 |
| Configuration hints | 10 |

- **零新增 issue**（差分逐字节相同）
- **magic-context 命中 = 0**（对归一化输出正则 `magic-context|magicContext` 全文扫描）
- 备注：S24-fix 报告里的「676」口径 = files+deps+devDeps+exports+exportedTypes = 32+53+32+407+152 = **676**，与前一轮完全一致；本轮把 unlisted/duplicate/hints 三类也一并列出以便复核。

---

## 3. 构建 ×2

| 构建 | 命令 | 结果 |
|---|---|---|
| CLI | `pnpm --filter @zcode/cli build` | **成功**，`dist/zcode.cjs` **28.3 MB** / `.map` 47.3 MB，`Done in 1993ms` |
| desktop 完整 | `pnpm --filter @zcode/desktop build`（`prepare:runtime-assets` + `build:no-runtime-assets`） | **成功**，`packages/desktop/out` = **6656 文件 / 139 350 810 B = 132.9 MB** |

- 产物规模与 Phase 1 基线（6657 文件 / 133 MB）一致，**1 个文件的差异来自本轮删除的压缩相关文件**，属预期。
- CLI 产物已实测可运行（E2E 全程跑的就是 `node dist/zcode.cjs`），S24-fix §6.2 记录的打包阻塞**未复现**。
- `build:sea` 本轮**未验证**（Phase 2a §8.5 遗留项，不在本步范围）。

---

## 4. 真机 E2E 冒烟（8 用例，隔离环境）

### 4.1 环境配方

```
.e2e-phase2b/
  storage/            ← ZCODE_STORAGE_DIR（从用户 ~/.zcode/v2 只读复制 provider 配置 + 凭据）
  storage/db/         ← ZCODE_SESSION_DB_PATH = storage/db/session.sqlite（冒烟后 499 712 B）
  work/               ← scratch 项目（--cwd），只放一个 README.md
  mc/                 ← MAGIC_CONTEXT_DB_DIR
  logs/cli/           ← ZCODE_LOG_DIR（329 360 B）
```

- **未写任何开 flag 的 config**——项目级 `.zcode/config.json` 也没建，因此跑的是**代码默认值 false** 的无 transform 态（与 2a 的 on/off 双臂测法不同，这正是本步要验的形态）。
- 沿用 2a §2.1 记的坑：用户级 `~/.zcode/cli/config.json` 路径硬编码、不受 `ZCODE_STORAGE_DIR` 重定向；本步**只读**该文件（确认它没有 `features.magicContext`，即用户真实态也是默认 off），**未写入**。
- **隔离已验证**：冒烟会话 id `sess_dcaed259-…` 在用户真实库 `~/.zcode/cli/db/db.sqlite` 里查得 **0 行**；冒烟结束时 `mc/` 目录**为空**。

### 4.2 八用例逐条结论

| # | 用例 | 关键证据 | 结论 |
|---|---|---|---|
| 1 | 新会话创建 | `sess_dcaed259-edaa-4939-9393-a9ab6629eea3`，`response: "PHASE2B-E2E-OK"`，`modelRequestCount: 1`，`inputTokens 12410 / cacheRead 7232`，`projection.status: idle` | ✅ PASS |
| 2 | 工具调用（yolo） | 同一会话 `--resume` 发「用 Bash 跑 `echo phase2b-bash-marker`」→ `response: "phase2b-bash-marker"`，**`modelRequestCount: 2`**（一次工具往返），`cacheRead 24832` | ✅ PASS |
| 3 | 多轮对话 | 同会话连发 3 轮：①问 echo 字符串 → 精确答 `phase2b-bash-marker`；②「说出先后两个 echo」→ `PHASE2B-E2E-OK\nphase2b-bash-marker`；③「有几个不同 echo 字符串」→ 答 **2** 个并逐个列出 | ✅ PASS 上下文完整延续（会话累计 6 轮） |
| 4 | `--resume` 新格式会话 | 退出后新进程 `--resume sess_dcaed259-…` 发「3 条编号回顾」→ 准确复述 marker、Bash 调用、以及三次回忆提问，**历史完整、可继续** | ✅ PASS |
| 5 | `/compact` 行为（T-M9 真机侧） | `--prompt "/compact"` → **`Unknown command: /compact. Available commands: /help, /login, /logout, /init, /expert, /effort, /dwf, /fork, /locale, /mcp, /plugins, /mode, /model, /new, /resume, /rewind, /skill, /goal, /workflow, /ctx-status, /ctx-reduce, /ctx-expand, /ctx-recomp.`** | ✅ PASS 干净的「命令不存在」，**无任何压缩执行痕迹**（exit 0，2s，未产生模型请求） |
| 6 | `/ctx-status` off 态 | 见 §4.3 | ✅ PASS（降级输出、不报错） |
| 7 | SQLite 直查 | 见 §4.4 | ✅ PASS |
| 8 | `--version` / `--help` | `--version` → `0.16.9`；`--help` 正常，Slash Commands 列表 **14 条，无 `/compact` 条目** | ✅ PASS |

补充：整个冒烟期间 CLI 运行日志（`logs/cli/zcode-2026-10-05.jsonl`）中 **`compact` 命中 0 行**、`ctx-`/`magicContext` 命中 **0 行**——即 flag off 时 transform 与压缩链**一次都没被装上**。

### 4.3 用例 6 的一个必须登记的事实

**headless `--prompt` 下 `/ctx-status` 不会被 command-center 拦截，而是作为普通文本发给模型。**
模型如实回答「`/ctx-status` isn't an available skill or command in this session」。

根因（**非本轮引入，是 import 基线行为**）：`prompt-command.ts` 的 `routesToPromptCommandCenter()` 对 `type === "known"` 的命令**只放行 `/expert` 与 `/goal`**，其余一律走普通 prompt 路径。`git log -S` 确认该判据来自 `c34a938`（ZCode v3.14.3 导入快照）。

因此按 TUI 的真实调用方式（直接打 `handleCtxCommand`）复测了 off 态降级行为，`.e2e-phase2b/logs/e6b-ctx-status-handler.log`：

```
=== /ctx-status ===
Magic Context status
session: sess_dcaed259-edaa-4939-9393-a9ab6629eea3
Budget
  protected floor: -
  last context usage: 0%
  last input tokens: 0
Compartments
  count: 0
  last compacted message: -1
Tags
  active: 0 (0 tokens) / dropped: 0 (0 tokens) / compacted: 0 (0 tokens) / pending operations: 0

=== /ctx-recomp ===
Recompute for the full compacted history was requested but the rebuild runner is not wired yet,
so nothing was rebuilt. Compartments now: 0. …
=== /ctx-expand ===
Usage: /ctx-expand [tag=N | message=N | <start>-<end>] [verbose]
```

- **不报错**：全部返回文本，无异常。
- 零值快照符合 off 态预期（无 db → 空快照，格式化器不崩）。
- **需要登记的既有行为**：`/ctx-status` 会通过 `readMagicContextStatusSnapshot` 打开 `MAGIC_CONTEXT_DB_DIR` 下的库，于是 `mc/` 里出现了 `magic-context.db`（+ `-shm`/`-wal`）。这**不是本轮压缩移除引入的**——`handlers/ctx.ts` 自 `5c0b926`（2a 收口）起未被 S26/S27/S28 碰过，2a T-M8 之所以观察到 `mc-off/` 为空，是因为那条臂**从未敲过 `/ctx-*` 命令**。探针结束后已把 `mc/` 清回空目录。
- 若主代理认为「flag off 时 `/ctx-status` 不该建库」属于要收的口子，那是**下一个变更**，不在本步「只测不改」范围。

### 4.4 用例 7：SQLite 直查（`node:sqlite` 只读）

脚本 `.e2e-phase2b/inspect-db.mjs`，日志 `logs/e7-sqlite.log`。库 **24 张表**。

**magic-context 侧**
```
mc/ entries: []            （冒烟全程为空）
magic-context.db exists: false
```
→ **flag off 连库都不建**，2a 的「off 零差异」语义在压缩移除后依然成立。

**part 类型分布（全库）**
```
text 16 / step-start 10 / step-finish 10 / reasoning 9 / tool 2
```
对比 Phase 1 E2E（压缩尚在时）：`text 8 / step-start 4 / step-finish 4 / reasoning 3 / tool 1 / **compaction 2** / **timeline 1**`。
→ **compaction part = 0，timeline part = 0**，两类都已从新写入路径彻底消失。

**全表 `compact` 扫描**
```
=== compaction / compact scan ===
(no HIT lines above = zero compaction residue)
```
→ 对 24 张表所有文本型列（`text|content|data|body|json|payload|message`）做 `LIKE '%compact%'`，**零命中**。

**`time_compacting` 历史列**
两个会话行均为 `null`，**从未被写**。列本身按白名单登记保留（schema 兼容，见 §5.1）。

**本地 usage 表健全**（Phase 1 防误删决策的持续证据）
```
model_usage 10 / turn_usage 8 / tool_usage 2
```

**时间线抽样**（`ORDER BY sequence`）：6 条 user 文本 part + 2 条 tool part（E2E 的 Bash 调用）+ 9 条 reasoning + 对应 text/step-finish，**无一条是边界/摘要载体**，顺序与真实对话一一对应。

---

## 5. 全仓 compact 残留扫描（S28 验收项）

### 5.1 总量与分类

`git grep -i -n compact` @ HEAD（去 ANSI、归一化）：

| 分区 | 命中行 | 命中文件 |
|---|---|---|
| **全仓总计** | **1419** | **256** |
| magic-context 包内 | 725 | 69 |
| 非 magic-context | 694 | 187 |
| ├ `packages/ui` + `packages/web` | 333 | 71 |
| ├ `apps/zcode-cli/**` | 277 | 87 |
| └ 其余（desktop/services/shared/scripts/docs/`.agents`） | 84 | 29 |

按白名单逐类核对（对 1419 行做**标识符级**普查：316 个 distinct `compact*` token）：

| 白名单类别 | 说明 | 判定 |
|---|---|---|
| 布局词 | `compactLines` / `compactStats` / density / variant / "compact output|label|row|badge|padding…" | ✅ 全部为 UI 密度与排版 |
| 数字缩写 | `formatCompactTokenUsage` / `formatCompactNumber` / `formatCompactTokenNumber` / `notation:"compact"` | ✅ `Intl.NumberFormat` 缩写显示 |
| `context-usage-log-compact` | `core/src/runtime/methods/context-usage-log-compact.ts`（5 行） | ✅ 白名单条目，日志归档 |
| `compact_stream_boundary` / `preserveProviderStreamBoundaries` | 43 行（`runner-stream.ts` / `runner-runtime.ts` / contracts） | ✅ provider SSE 重试与 stream 边界，**与上下文压缩无关**，是传输层语义 |
| `time_compacting` / `compacting?` 历史列 | 10 行（`sessions.ts` 仓库 / `session.port.ts` / migrations / rows / codec） | ✅ 登记保留的 DB schema 兼容列，运行时恒 `null`（§4.4 已证） |
| magic-context 语境 | 725 行 / 69 文件：`compactionOff`、`compaction-marker-manager`、`pending_compaction_marker_state`、`filterCompacted`、`compactTextForSummary`、`compaction_mode_record` … | ✅ **全部收敛在 magic-context 包内**（逐 token 核过，无一例外） |
| model_io 调试日志压缩 | `runner-debug.ts`（25 行）`compactMessageCollection` / `buildRequestCompactionState`；`model-io` / `rollout` 17 行 | ✅ 调试日志体积裁剪 |
| `compactLogArchive` | `services/src/feedback/compactLogArchive.ts` + 8 行 | ✅ 反馈日志归档 |
| shadow-replay 旧日志兼容过滤 | `apps/zcode-cli/scripts/shadow-replay.mjs`（2 行） | ✅ 旧日志兼容 |
| 守卫测试断言 | `test-feature-flag.mjs`（13 行，T-M10 退役键 `features.compact` 必须被剥离）、`test-magic-context-domain.mjs`、`test-magic-context-config-rpc.mjs`、`test-ctx-commands.mjs`、`test-sidecar-model-request.mjs`、`scripts/desktop-typecheck-baseline.txt` | ✅ 守卫测试，**正是压缩移除的回归防线** |
| 其余 misc | `WorkflowRunCompactCard`（workflow 运行紧凑卡）、`compactWorkflowPayload`（工作流事件载荷）、`compactToday`（配额展示）、`compact.length/slice`（JS 数组方法）、`ctx-context.ts` 的 ctx_expand 能力描述、`zcode-slash-command-help.ts` 的 `/ctx-status` 描述 | ✅ 均非对话压缩 |

**白名单外命中 = 0。**
关键判定：对话压缩的全部词汇（`compactionOff` / `compaction-marker` / `compactBoundary` / `/compact` / `autoCompact` / `PendingCompactionMarker` / `compaction_mode_record` …）**只出现在 `apps/zcode-cli/packages/magic-context/` 一个子树内**，包外零命中。

### 5.2 与 S28a 基线 1396 的偏差登记

| ref | 命中行 | 命中文件 |
|---|---|---|
| `8f78349`（S27-w1） | 1580 | 279 |
| `ce87d22`（S27-w2） | 1531 | 267 |
| `590364a`（S27-2b/w3） | 1445 | 264 |
| `43f8f59`（S27 收口） | 1445 | 264 |
| `7cae56c`（S28-pre） | **1420** | 256 |
| `1189755`（HEAD，本轮文案修复） | **1419** | 256 |

- **本轮 −1 精确成立**：`7cae56c → 1189755` 的 `resetConversationAndFiles.unavailable` 文案去压缩语义，把 1420 降到 1419。
- **绝对值对不上任务书给的 1396**：差 23 行。试过的口径都复现不出 1396——全仓 1419、排除 `.agents` 1387、`apps+packages+scripts` 1369、仅 `*.ts/*.tsx/*.mjs/*.js` 1351。推测 S28a 那次的 1396 用了本轮未复现的额外排除项（可能含 `harness/`、`third-party/`、`.prettierignore` 命中集等）。
- **该偏差不影响验收**：验收判据是「相对基线零新增 + 白名单外零命中」，前者由 `7cae56c → HEAD` 的 −1 与逐文件白名单核对共同满足，后者已证为零。**如实登记，不擅自调整口径。**

---

## 6. 测试全套重跑（13 套全绿）

统一用 `node --import tsx` 跑（`apps/zcode-cli/packages/cli/scripts/` 是实际路径），每套**单独捕获退出码**，日志在 `.e2e-phase2b/logs/tests/`。

| 套 | 路径 | pass | fail |
|---|---|---|---|
| adapters feature-flag | `adapters/scripts/test-feature-flag.mjs` | **13** | 0 |
| adapters magic-context domain | `adapters/scripts/test-magic-context-domain.mjs` | **16** | 0 |
| cli ctx-commands | `cli/scripts/test-ctx-commands.mjs` | **8** | 0 |
| magic-context config | `magic-context/scripts/test-config.mjs` | **9** | 0 |
| magic-context ctx-tools | `magic-context/scripts/test-ctx-tools.mjs` | **20** | 0 |
| magic-context historian | `magic-context/scripts/test-historian.mjs` | **16** | 0 |
| magic-context host | `magic-context/scripts/test-host.mjs` | **30** | 0 |
| magic-context transform | `magic-context/scripts/test-transform.mjs` | **35** | 0 |
| magic-context smoke-storage | `magic-context/scripts/smoke-storage.mjs` | **36**（36 checks） | 0 |
| bootstrap config-rpc | `bootstrap/scripts/test-magic-context-config-rpc.mjs` | **8** | 0 |
| bootstrap historian | `bootstrap/scripts/test-magic-context-historian.mjs` | **6** | 0 |
| bootstrap turn-transform | `bootstrap/scripts/test-magic-context-turn-transform.mjs` | **10** | 0 |
| core sidecar | `core/scripts/test-sidecar-model-request.mjs` | **6** | 0 |

**13/13 套通过，213 个 case，0 failure，0 `not ok`。**
全部与 2a §8.3 的基线逐项持平（feature-flag 13 / domain 16 / ctx-commands 8 / config 9 / ctx-tools 20 / historian 16 / host 30 / transform 35 / smoke 36 / bootstrap 10+8+6 / sidecar 6）——**压缩移除没有让任何一条既有断言变松或失效**。

（TAP 输出在当前控制台编码下 `#` 显示为乱码字形，故用标签文本而非 `# pass N` 解析计数；每套日志末行有 `TEST PASS — …` / `SMOKE PASS — 36 checks, 0 failures` 之类的自证汇总行。）

---

## 7. 异常与处置汇总

| # | 事项 | 性质 | 处置 |
|---|---|---|---|
| 1 | 残留扫描绝对值 1419 vs 任务书基线 1396（差 23） | **口径差异**，非回归 | 已试遍常见排除口径均复现不出 1396；登记实测值与逐 ref 趋势；相对判据（−1）成立 |
| 2 | headless `--prompt` 下 `/ctx-status` 走普通 prompt 路径 | **既有行为**，来自导入基线 `c34a938` | 已定位到 `prompt-command.ts` 的 `routesToPromptCommandCenter()`；另按 TUI 真实路径复测 off 态降级输出（不报错、零值快照），作为用例 6 的证据 |
| 3 | `/ctx-status` 会建 `magic-context.db` | **既有行为**（`handlers/ctx.ts` 自 2a 未被 S26-S28 触碰） | 登记；探针后已把 `mc/` 清回空。若要收口属下一变更 |
| 4 | `oxfmt` 对 `apps/zcode-cli/**` 返回 "Expected at least one target file" | **配置事实**，非格式违规 | 按 `.prettierignore` 的分区设计改用 apps 自带 oxfmt 0.47 复检，13/13 干净 |
| 5 | pnpm engine 警告（内部 node22 vs 要求 24.14.0） | 既有无害条件 | 忽略；tsc / 测试 / E2E 全部显式用便携 node v24.14.0 跑 |

**未改任何 src 代码。未打 tag。未翻 `features.magicContext`。仓库工作树在回归结束时与开始时一致（HEAD `1189755`，仅 `?? desktop-dev.log` 这一回归前就存在的未跟踪文件）。**

---

## 8. 给下一步的输入

1. **翻 flag 是下一个变更**：`features.magicContext` 仍默认 false，本回归已证明「无 transform 态」全链路健康，可以作为翻 true 的前置证据。
2. **`build:sea` 仍未验证**（继承 2a §8.5 第 1 项）：本轮只做到普通 CLI bundle 构建 + 产物实跑。
3. **`/ctx-status` 建库语义**（本轮 §7 第 3 项）是否要收口，交主代理决策。
4. **TUI 全屏交互体验**仍未自动覆盖（本轮与 2a 同）：八用例走的是 headless `-p` 路径；`zcode` 无参进 TUI 的 `/compact` 目录项摘除、上下文面板入口摘除等，只能由用户按需体验确认。
