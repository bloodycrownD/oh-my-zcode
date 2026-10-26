# 三方向调研记录：会话装载、MC 防腐层、三栏布局

- 日期：2026-10-25
- 基线：v1.0.20 回滚树 + v1.0.27 补丁（HEAD `dddb9a20`）
- 性质：只读调研，未修改任何代码
- 范围决定（用户 2026-10-25）：**UI 布局改动暂缓**；先做「会话装载」与「MC 防腐层」两项

## 0. 结论速览

| 方向 | 结论 | 量级 | 状态 |
|---|---|---|---|
| 会话打开/切换慢 | 传输早已窗口化，慢在「算全量」；更关键的是冷订阅把「看」与「跑」绑定，投影窗口化单独做不到 1s 级 | 零语义前置 0.5 天；S1 8-12 文件；S2 6-10 文件 | 待开工 |
| MC 防腐层 | 当前树没有门面：1663 行单体 + 6 处静态 value import，其中 config schema 与协议 handler 与开关无关、启动即全量加载 | 五波合计 5-7 天；第一波 1-2 天 | 待开工 |
| UI 三栏重排 | 顺序由 DOM + RRP 面板成员关系决定；只有「左栏 \| 右栏 \| 聊天」便宜（0.5-1 天），字面「右栏 \| 左栏 \| 聊天」要 2-4 天 | 小 / 大 | **暂缓** |

## 1. 会话打开与切换慢

### 1.1 已有实测（v1.0.26 树，供量级参照）

一次冷开 7.6s 的拆分：点任务 → CLI 起好 +1.4s；`session.resume_completed`（历史回放）+2.7s；三源合并 +0.8s；首屏可见 +2.8s。同会话 CLI 热时重开 0.4-0.7s。

### 1.2 本树可复现性

`git diff v1.0.20..v1.0.26` 对下列文件为空（逐字相同），所以结构问题在本树复现：

- `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `bootstrap/src/zcode-protocol-v4/cold-event-merge.ts`
- `bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `adapters/src/storage/session-store/repositories/messages.ts`

`product-projection.ts`（+313 行）与 UI 侧有差异，**具体毫秒数必须在本树复测**。

### 1.3 准确定性：不是分页问题，是「算全量、发窗口」

- 传输早已窗口化：尾部 60 行（`packages/shared/src/zcode-protocol-v4/core.ts:75-79`），`rows/range` 每页 200 行；前端 `loadOlder()` 已接（`conversationProjectionStore.ts:1129-1180`）。
- 全量读取的唯一源头：`adapters/src/storage/session-store/repositories/messages.ts:221`，`select * from message/part`，无 LIMIT/OFFSET。
- 全量合成与归约：`cold-event-merge.ts:696`、`transcript-hydration.ts:1342`、`product-projection.ts:1017-1039`。
- 发窗口前还复制了一遍全量 rows 再 `slice(-60)`：`conversation-topic-publisher.ts:346-376`。
- `rows/range` 也是在全量投影上 `filter+slice`：`conversation-topic-publisher.ts:476-498`。

### 1.4 主因更正：冷订阅把「看」与「跑」绑在一起

链路：

```
subscribeReserved (v4-gateway.ts:1415)
  └─ ensureColdReadyPublisher (v4-gateway.ts:2926-2949)
       ├─ ColdSessionResumeCoordinator.ensureResumed (cold-session-resume.ts:49)
       │    └─ resumePersistedSession (v4-bridge.ts:1434)
       │         └─ activateSessionForResume (server-operations.ts:1409)
       │              ├─ store.messages() 全量 (:1458)
       │              ├─ record.app.resume({ persistedMessages }) (:1491-1498)
       │              │    └─ core resumeFromStore (resume.ts:59)
       │              │         ├─ 重建 MessageHistoryImpl (:131)
       │              │         ├─ ensureContextInitialized, eager (:147)
       │              │         └─ hydrateMessageHistoryFromSession 全量 (:148-156)
       │              └─ session.resume_completed 日志 (:1502-1510)
       └─ hydratePublisher → performHydration (v4-gateway.ts:2989)
```

结论：只做投影窗口化，最多省掉「三源合并」一档（约 0.8s）；**要达到 1s 级，必须先把视图冷开与 runtime 激活解耦**。

### 1.5 三条接缝

| 接缝 | 落点 | 规模 | 关键风险 |
|---|---|---|---|
| **S1 视图/运行时解耦** | `v4-gateway.ts:2926-2949` 拆 view-ready / runtime-ready；`cold-session-resume.ts:49` 增 mode；`hasLiveConversation`（`v4-gateway.ts:3306-3308`）认识 view-only；命令与查询入口按需激活 | 8-12 文件，600-1000 行，不动协议/持久化 | fileChanges / journal / subagent / attachment / usage 在首屏期间不可用，需产品确认 |
| **S2 服务端投影窗口化** | 尾部窗口（约 400 条 + 边界桩）喂 `cold-event-merge`/`synthesizeEventsFromMessages`；`messages()` 旁增范围读；投影起始 rowId 偏移；`getRowsRange` 走窗口页 | 6-10 文件 | 可能要协议 additive 字段（`firstRowId`/`totalCount` 语义） |
| **S3 row 边界 checkpoint** | 新表或 `session_entry` 新 kind，持久化 rowId↔messageId↔seq | 12-18 文件 + 迁移 | 老会话首次打开需回填一次（等价一次全量重放） |

推荐路线：S1 最小子集先验证 1s 级可达 → 再叠 S2。S3 只在确认「rowId 必须跨进程稳定」或深翻页成为热点时才做。

### 1.6 关键约束：rowId 与全序语义

- `rowId` 是 replay 期自增计数器（`product-projection.ts:437`、`:5140-5152`），不持久化；`logEpoch` 每进程随机（`v4-gateway.ts:444-445`）。
- `firstRowId` / `totalCount` 按「全序」写死在协议注释（`snapshot.ts:500-507`）与 UI 判定（`conversationProjectionStore.ts:275-280`、`ConversationTimeline.tsx:1776/1815`）。
- 窗口必须对齐整轮，且不能切在 assistant(toolCall) 与其 tool result 之间；UI 已有 `shouldAutoLoadIncompleteLeadingTurn` + 自动补拉（`conversationProjectionStore.ts:286`、`SessionPane.tsx:3143-3158`）。
- `getTurnDirectory`（`:538-618`）与 `getPlans`（`:500-521`）都是全量行现算，窗口化后会退化，需轻量全序索引。

### 1.7 已失效的旧约束

v1.0.20 树没有会话导出功能，`loadAllOlder`（`conversationProjectionStore.ts:1189`）无调用方。「导出仍要全量」不成立。真正依赖全量的是：上下文用量 seed、subagent 清单、fork/edit/retry 的 row→messageId 解析、turn 目录与计划。

### 1.8 零语义前置（不改变任何行为）

hydration 期存在重复全量读，先行消掉可拿回数百毫秒：

- `readSessionContextUsage` 再读一次全量 messages + events（`v4-bridge.ts:1830-1833` → `server-operations.ts:1840-1865`）。
- `listSessionSubagents` 父与每个 child 各全量读一次（`server-operations.ts:1672-1748`）。
- `buildColdFileChangeSummaries` 逐 messageId 读 artifact（`v4-bridge.ts:1813-1826`）。

### 1.9 待拍板

1. 首屏是否接受不激活 runtime（影响 fileChanges 卡片、subagent 面板、journal 查询、`/ctx-*`）。
2. `firstRowId` / `totalCount` 是否允许改语义或新增协议字段。
3. rowId 是否必须跨进程稳定（是 → 直接 S3）。
4. 首屏窗口大小与对齐规则（约 400 条、整轮、含 tool_result）。
5. 验收口径以 `openTiming` 哪一段为准（`cliSessionRestoreMs` 还是新增分段计时）。

## 2. MC 防腐层

### 2.1 目标（两条，第二条为用户 2026-10-25 补充）

- **A. bug 隔离与一键移除**：MC 造成的问题不再散落到宿主各处，未来可整体摘除。
- **B. 跟随 ZCode 上游升级**：MC 与宿主的耦合点每处都是升级时要人工判断的分叉；防腐层把这些分叉收敛成少数稳定契约，升级时只处理契约差异。

### 2.2 升级跟随的证据（为什么这层必须服务升级）

- **MC 是移植件**：`UPSTREAM-SYNC.md:62` 要求 `src/core/**` 按上游新版本逐字重放，`src/host/**` 逐个判定是否跟着改。
- **偏离面很大**：`magic-context/src/core` 共 255 个文件，其中 **83 个文件带 FORK 标记（294 处）**；`src/host` 14 个文件里 **12 个带标记（75 处）**。每次上游 MC 升级都要重新贴/复核这些标记。
- **语义分叉**：`hostProcessLifetime = 'one-process-per-turn'`（`UPSTREAM-SYNC.md:82`）——ZCode 一进程一轮 prompt，上游是一进程一会话；不传即退回上游行为=错。
- **同步期成本**：`v1.0.20..archive/pre-rollback-v1.0.26` 共 217 个提交，其中 **12 条 MC 相关提交**；MC 包本身 10 文件 +976/−65，含 3 条纯适配修复（`f5bc0e0a` schema 惰性化、`ba079334` 反投影保 tool_reference、`0f8ae895` 结构化工具结果整弧绕过）。
- **事故与回滚**：幽灵用户消息根因之一是 MC 反投影重建条目无条件继承 `original.metadata`（`ff8b4522` 修复）；v3.16.2 全量同步后整体不可用，最终整体回滚（记忆 #139）。
- **结论**：升级成本的大头不是 MC 包自身，而是「MC 与宿主三端口、config schema、协议 handler、ctx_* 工具、构建 external」这些散点——每处都要在升级时重新确认。防腐层的价值就是把它们变成有测试的稳定接口。

### 2.3 现状：当前树没有门面

- 回滚树**不存在** v1.0.21+ 的 `bootstrap/src/app/magic-context/{adapter,gate,assembly}.ts`。
- bootstrap 侧是一个 **1663 行单体** `magic-context-turn-transform.ts`，同时承担投影/反投影、config bridge、prompt section、tool description、usage recorder、historian 组装、DB open 重试、失败分级八件事，对外 6 个导出函数。
- 装配门只是内联三元：`create-app.ts:826-844`。
- core 侧防腐是干净的：`core/src/runtime/helpers/magic-context-{turn-transform,prompt-section}.ts` 零运行时 import，三个端口只判空，删注入即降级。

### 2.4 耦合清单

**A. 硬编译期依赖**

- 包声明：`adapters`、`bootstrap`、`core`、`cli` 四个 `package.json` 各一条 `workspace:*`；`knip.json:31-37` 豁免。
- 静态 value import 6 处：`adapters/src/config/schema.ts:4-8`、`bootstrap/src/app/magic-context-turn-transform.ts:135-182`、`magic-context-historian.ts:64-85`、`magic-context-usage-summary.ts:40-43`、`bootstrap/src/zcode-protocol/magic-context-config.ts:3`、`magic-context-memories.ts:80-92`。
- type-only 1 处：`magic-context-prompt-section-zh-cn.ts:34`。
- `typeof import("@zcode/magic-context")` 类型位 7 处：`run-ctx-command.ts` 多处、`format-ctx-status.ts:24`、`core/src/tool/handlers/ctx-{context,memory,search}.ts`。

**B. 运行期装配**

- 唯一冷求值：`runtime-config.ts:212-220`；装配门：`create-app.ts:826-844`；工厂内再判一次：`magic-context-turn-transform.ts:1331-1338`。
- 动态 import 4 处（永不抛，失败即视为不可用）：`run-ctx-command.ts:210-216`、`core/src/tool/handlers/ctx-context.ts:48-60`、`ctx-memory.ts:53-67`、`ctx-search.ts:60-81`。
- **绕过门面的直连**：
  1. `adapters/src/config/schema.ts`（config 装载无条件）。
  2. `bootstrap/src/zcode-protocol/server.ts:85,91` 静态 import 两个 MC handler（app-server 启动即载整棵包）。
  3. `magic-context-memories.ts:158` 自开库，不复用装配层 db。
  4. `run-ctx-command.ts:218-224` 自开库 + 再调 `initializeMagicContextHost()`。
  5. 三个 `ctx_*` handler 各自 `openDatabase()`。
  6. 全局单例：`initializeMagicContextHost()` 3 处、`setMuralVisionProbe()`。
- 生效口径在 **6 处各写一遍**：`runtime-config.ts:212-220`、`magic-context-memories.ts:127-139`、`run-ctx-command.ts:172`、`runtime-tools.ts:126`、`magic-context-prompt-section.ts:84`、`turn-transform.ts:884/1331`。
- 默认值：`features.magicContext` 默认 true（`contracts/src/config/index.ts:372-375`、`adapters/src/config/index.ts:302`）；`magicContext.enabled` 默认 true；`fail_closed_blocking` 默认 true（`magic-context/src/host/config/schema.ts:279,330-334`）。

**C. 数据与持久化**

- DB 路径：`~/.omz/cli/db/magic-context.db`（`data-path.ts:184-250`；`MAGIC_CONTEXT_DB_PATH` 可覆盖）。
- 迁移：约 96 条（version 1..94 + 10000 哨兵，`migrations.ts:267`）。
- **无自动备份**；删包后为孤儿文件。
- 开库失败默认 `fail_closed_blocking=true` → throw 阻断首轮；关闭时降级为 inert。
- 生命周期：进程内按 path 缓存 handle → `session-facade.ts:294-302` drain → shutdown。

**D. UI / 协议 / 文案**

- 4 个 RPC（config update/read、memories list/archive）：`packages/shared/src/zcode-protocol/index.ts:2100-2337`；handler `magic-context-config.ts:66-181`、`magic-context-memories.ts:213+`。
- 4 个 v4 本地命令：`packages/shared/src/zcode-protocol-v4/command.ts:207-224,423`（刻意恒定可用）。
- 设置面：`MagicContextSettingsSection.tsx`、`MagicContextSettingsFields.tsx`（13 个 testid）、`magicContextSettingsForm.ts`（复述包内数值约束）。
- i18n：`settings.context.*` 46 条 ×2 语言 + `chat.contextUsage.magicContext.*` 10 条 ×2。
- 日志事件 21 个（`magic_context.*`）。

**E. 测试与构建**

- 28 个专门测试文件 + 跨切面若干；其中 `test-magic-context-lifecycle.mjs`、`test-magic-context-ui-config.mjs` **未接进任何 script/CI**。
- esbuild external：`apps/zcode-cli/packages/cli/scripts/build.mjs:14-27`。
- SEA staging：`sea-tui-assets.mjs:132-167`（deferred 队列，避免 zod4 抢根位）。
- 桌面 staging：`packages/desktop/scripts/stage-agent-bundle.mjs:20-31,63-80`；`scripts/build-desktop-agent-cli.mjs:33-36` 要求 MC 先出 dist。
- `UPSTREAM-SYNC.md:119` 的「5 静态 + 2 动态 = 7 处加载点」已过期（实际 6 静态 + 4 动态）。

### 2.5 五波改造

1. **gate 单函数 + adapter 门面**（零行为，1-2 天）：唯一 `resolveMagicContextEffectiveEnabled`；1663 行拆为 transform / historian / promptSection / toolDescription / usage / configBridge 六个工厂，对外一个 `createMagicContextPlugin()`。
2. **adapters schema 解耦 + 协议 handler 惰性化**：给 MC 包加 `./host/config/schema` 窄子路径（本树只有 `.` 一个 exports），或 contracts 侧 opaque 化；`server.ts:85,91` 改条件注册/`await import()`。验收：flag off 实测零加载。
3. **core `ctx_*` handler 收口**：四个 handler 的包 import 与自开库收敛到注入式端口。
4. **UI/协议面**：4 RPC、4 命令、2 设置分区、56 条 i18n、test-ids。
5. **数据面与构建面**：DB 备份/归档说明、external/staging/knip/构建顺序清理、文档更新。

### 2.6 移除后会缺失的行为

上下文压缩/分舱（**无原生替代**）、§N§ 条目控制（ctx_reduce/ctx_expand）、跨会话项目记忆（文件式 `MEMORY.md` 会回归）、historian 与 `/ctx-recomp`、token 预算面板 MC 段、4 个 `/ctx-*` 命令与 4 个 RPC。删前必须显式备份 DB。

### 2.7 验收口径（第一波）

- `grep -rn "@zcode/magic-context" apps/zcode-cli/packages/*/src` 只命中白名单四组：`adapters/config/schema.ts`、`bootstrap/src/app/magic-context/**`、`bootstrap/src/ctx-commands/**`、`core/src/tool/handlers/ctx-*`。
- 现有 MC 测试族全绿；根 typecheck / lint 无新增。
- 零行为：同会话在开关前后行为与日志事件序列不变。

## 3. UI 三栏布局（暂缓，结论保留）

### 3.1 顺序由什么决定

不是 CSS `order`/grid，而是 DOM + react-resizable-panels 的面板成员关系：

- 根：`[sidebar 面板][自研把手][#content]`（`WorkspaceShellLayout.tsx:1511-1636`）。
- 右栏：`#content` 内 RRP group 的第二个 panel（`:1637-1921`，`id="browser"`）。
- RRP 写死 `flexDirection: "row"`（`.reference/ZCode/node_modules/react-resizable-panels/dist/react-resizable-panels.js:1730`），不支持反向排布。

### 3.2 三种顺序的成本

| 目标顺序 | 主要工作 | 量级 |
|---|---|---|
| 左栏 \| 右栏 \| 聊天 | 组内两 panel 换序 + 把手位置参数 + 窗控搬回聊天 header + 持久化 key 变化 | 0.5-1 天 |
| 右栏 \| 聊天 \| 左栏 | 上者全部 + pane 提到根层 + 侧栏拖拽反号（`WorkspaceShellLayout.tsx:636` 左锚定） | 2-3 天 |
| 右栏 \| 左栏 \| 聊天（字面） | pane 提到根层 + 新顶层分组 + 窗口 chrome 重做 + 持久化迁移 | 2-4 天 |

### 3.3 必查风险点

1. **窗控落点**：Windows/Linux 桌面窗控现在在右栏 tab 栏末（`AnimatedSidePanePanel.tsx:819`），右栏关时才回落聊天 header（`WorkspaceHeaderActionSection.tsx:68`）。换序后必须反转条件，否则按钮浮在窗口中间。
2. **把手位置**：`AnimatedSidePanePanel.tsx:1348-1386` 硬编码「把手在面板前」，整体换序会把把手落到 group 最左缘，需加 `handleSide` 参数或布局层单独渲染。
3. **browser guest 合成面**：注释说明 browser surface 是「fixed 到窗口内的低透明合成层」，栏位换边后必须真机确认无白屏。
4. 持久化 key 含 `panelIds` 顺序（`WorkspaceShellLayout.tsx:121-122`），换序导致栏宽一次性重置，可选迁移。
5. 窄窗自动收起阈值（`WorkspaceShellLayout.tsx:442-528`，360/480px）按旧顺序调，换位后「先收谁」观感变化。

## 4. 推进顺序（建议）

1. **MC 第一波**：gate 单函数 + adapter 门面（零行为，可独立回滚）。
2. **会话零语义前置 + 本树复测**：消重复全量读，用 `openTiming` 与 `scripts/dev/long-session-perf-sample.mjs` 重新拆段。
3. **S1 视图/运行时解耦**（收益最大，动语义）。
4. **S2 投影窗口化**（视复测数据决定是否与 S1 同批）。
5. **UI 三栏重排**：等用户恢复该项，且先定窗口 chrome 方案。

## 5. 未决项

- 首屏是否接受不激活 runtime。
- `firstRowId` / `totalCount` 是否允许改语义或加协议字段。
- rowId 是否必须跨进程稳定。
- 首屏窗口大小与整轮对齐规则。
- MC 是「将来可一键移除」还是「现在就删」；若删，DB 备份与记忆导出方案需先定。

## 6. 证据索引

| 主题 | 位置 |
|---|---|
| 全量消息读取 | `adapters/src/storage/session-store/repositories/messages.ts:221` |
| 冷恢复激活 | `bootstrap/src/zcode-protocol/server-operations.ts:1409-1510` |
| core 重建历史 | `core/src/runtime/methods/resume.ts:131-156` |
| 三源合并 | `bootstrap/src/zcode-protocol-v4/cold-event-merge.ts:696` |
| 事件合成 | `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:1342` |
| 投影与 rowId | `bootstrap/src/zcode-protocol-v4/product-projection.ts:437,5140-5152` |
| 60 行窗口 | `bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts:346-376` |
| 协议窗口语义 | `packages/shared/src/zcode-protocol-v4/snapshot.ts:500-507` |
| 前端分页 | `packages/ui/src/v4/conversationProjectionStore.ts:1129-1180` |
| MC 装配门 | `bootstrap/src/app/create-app.ts:826-844` |
| MC 生效口径 | `bootstrap/src/app/runtime-config.ts:212-220` |
| MC 单体 | `bootstrap/src/app/magic-context-turn-transform.ts`（1663 行） |
| 协议静态装载 | `bootstrap/src/zcode-protocol/server.ts:85,91` |
| MC DB 路径 | `magic-context/src/core/shared/data-path.ts:184-250` |
| MC 迁移 | `magic-context/src/core/features/magic-context/migrations.ts:267` |
| 移植与 FORK 规则 | `UPSTREAM-SYNC.md:62,69-72,82` |
| 外壳布局 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1511-1921` |
| 右栏把手与窗控 | `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:819,1348-1386` |
| 侧栏拖拽 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:636` |
