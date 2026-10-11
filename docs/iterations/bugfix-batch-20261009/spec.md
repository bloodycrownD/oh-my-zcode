---
date: 2026-10-09
---

# 五缺陷修复批次（bugfix-batch-20261009）技术规格（SPEC）

## 需求来源

用户口述（对话内报障，无 `prd.md`），共六个缺陷；诊断依据为两轮只读探索
（6 个 explore 子代理报告，含 file:line 级证据）与用户本机取证
（`%TEMP%\zcode\magic-context\magic-context.log` 与
`~/.omz/cli/db/magic-context.db`）。用户明确：①的「旧文本」半不人工复现，
由我方 e2e 复现定位；桌面实机验收走 CDP 通道（见 RULE.md「桌面 UI 实机验证方法」）。

五个缺陷（用户原述）：

1. 编辑消息后发送仍是旧消息、模型也没切到最新；agent 默认模型切换也不实时。
2. 消息多时切换会话，msg 列表总跳到最上方（正序列表渲染难）。
3. 子智能体支持手动关闭（参考 novelmaster，外部参考，仓内无痕迹）。
4. 智能体同步派遣工具同样返回 sessionId，和异步派遣一样。
5. Magic context 有 bug，都 90% 上下文了都没压缩。
6. 子代理失控命令把 exec 日志撑爆磁盘：单次 ~5.13GiB、5 次共 25.7GB
   （`cli/exec/<sessionId>/<toolCallId>-stdout.log`）；入库记录只有 ~338
   字符的「短文本」，形成「文件无界、数据库有界」的假象。

## 设计目标

- ⑤ 恢复 magic-context 在桌面端的实际运行与可观测性（当前桌面进程零
  transform pass 且无任何告警，用户无法感知「压缩已停机」）。
- ① 编辑重发使用「当前会话模型 + 用户编辑后的文本」，且不再把旧模型静默
  写回会话；agent 默认模型配置变更对同进程新会话实时生效。
- ② 切换会话首帧不再闪顶部：落点等首批真实测高，测高缓存跨会话复用。
- ③ 前台子智能体可手动停止，停止终态正确显示「已取消」而非「失败」。
- ④ 同步派遣（Agent/Task 工具）返回 `childSessionId`，与异步对齐。
- ⑥ 失控命令的 exec 输出文件不再以 GiB 级留在磁盘：看门狗上限下调至
  可配置默认值、超限杀进程后对文件物理截断（保留头尾）、`cli/exec`
  目录纳入可清理范围。
- 全部改动遵守仓库门禁与 FORK 登记约束（见「现状约束」）。

## 现状约束（来自探索报告与 RULE.md，实现不得违反）

- **上游逐字移殖区**：`apps/zcode-cli/packages/magic-context/src/core/**` 改动
  必须加 `FORK (xxx)` 注释块（源位置/上游语义/改动面），不重排不改风格。
  已有范例：`sqlite.ts:187-205`（FORK S24-fix）。
- **门禁口径**：根 `pnpm typecheck`（0 err）、根 `pnpm lint`（基线 71w/0e）、
  `cd apps\zcode-cli && pnpm typecheck`（turbo 全绿）、magic-context
  `pnpm run build && pnpm run test:transform`（38 cases 基线）、oxfmt 改动文件
  零新增不合觃、桌面差分 `node scripts/typecheck-desktop-full.mjs`。
  CLI turbo lint **不是**门禁。
- **fail-closed 契约**：`host/config/schema.ts:198-203` 规定 schema fence /
  存储打开或迁移失败应 loud block（`fail_closed_blocking` 默认 true）。
  「可重试」改造必须限定 busy/瞬时类，且保留「重试上界后仍 throw」的语义，
  不得偷换成静默降级。
- **`openDatabase` 是同步 API**（无 await 点）；boot 期重试不能同步 sleep 冻宿主。
  现成退避常量可复用：`MIGRATION_LOCK_RETRY_DELAYS_MS`（migrations.ts:34）、
  `FOREGROUND_ACQUISITION_BUDGET_MS`（sqlite.ts:657）。
- **E2E 隔离**：绝不写用户真实 `~/.omz`（magic-context 测试必须显式
  `MAGIC_CONTEXT_DB_DIR`/传 db；RULE.md 已登记 S30 事故）。
- **协议契约**：工具输出 zod `.strict()`——`AgentCompletedOutput` 接口与
  schema 必须同 PR 双改，漏一边工具调用直接失败。
- **产品语义（有意设计，不得「顺手修」）**：运行中会话粘住自己的模型选择
  （`turn.ts:97-100` 注释）；后台子代理与父 turn abort 脱钩
  （`runner.ts:465-468`）；`retryTurn` 故意重发原文
  （`fork-edit-retry.ts:5` 注释）。
- 桌面 UI 实机验收走 CDP（dev electron `--inspect=9229` → `/json/list` 找
  renderer → `Runtime.evaluate`；React 元素用 `el.click()`，Radix 菜单需
  `PointerEvent('pointerdown')`；selector 用 data-testid）。

## 总体方案

六个缺陷分九个 phase 组，按「⑤可观测性+复现 → ① → ④ → ③ → ② → ⑥」顺序交付
（⑤优先因用户感知最强且当前完全停机；②与⑥放后，UI/adapter 回归面大且相互独立）。

### ⑤ magic-context 桌面端停机（本机实锤）

**本机取证结论**（修正过程中的两个误判，最终以日志为准）：

- `SQLite boot busy timeout` 行（storage-db.ts:260-270）是**每次成功开库都会打
  的诊断行**，不是失败信号；失败信号是 `storage fatal: failed to open`
  （本机 4 天内 0 次）。
- 10-04 的 busy 行与 CLI「每 prompt 一进程」节奏 1:1 对应，且每条后跟
  transform pass（功能正常）；10-05 09:02 后 busy 行转稀疏（桌面长驻
  app-server boot），但 **0 次 transform pass、0 条失败日志、0 条
  storage_unavailable 事件**。
- 结论：桌面 app-server 进程开库成功，但 transform 从未创建或从未执行，
  且该缺席**完全静默**。可疑门：`:776 enabled`（features.magicContext /
  配置）、create-app.ts:783-785 动态 import 失败、`:811 if (!db)` 的 null
  分支（pendingAsyncOpens 竞争 / schema fence / migration guard——这三类
  返回 null 不打 storage fatal）。
- 次要独立 bug：percentage=0.0% 是**从未写过的默认值**被当读数渲染
  （usage-summary `finite(x, 0)`）；且 `transform-postprocess-phase.ts:2547-2549`
  在 TTL execute 后单独推进 `last_response_time`，制造「有活动但 0%」的误导组合。

**方案**：先 e2e 复现定位真因（桌面发消息 → 观察 transform_absent 原因），
同时补三块机制修复，任何一块都独立成立：

1. **可观测性**：`enabled=false`、动态 import 失败、`if (!db)` null 三条
   路径全部发结构化事件（`magic_context.transform_absent`，带 reason），
   让「压缩停机」在桌面日志/事件面可见。语义边界（judge P2-4）：动态
   import 失败当前是**冒泡 throw**（fail-closed 性状），修复仅「发事件后
   仍照旧 throw」；真正静默（enabled 门 / db_null）才是「发事件 + return
   undefined 降级」路径。
2. **boot busy 有界重试**：`openDatabase` 抛 busy/瞬时类错误时，bootstrap
   装配处按退避序列有界重试（复用 `MIGRATION_LOCK_RETRY_DELAYS_MS` 模式），
   上界后维持现有 fail-closed throw；fence/guard 等确定性 null 保持立即定性。
   实现注（锚点取证任务 C 结论）：`openDatabase` catch（storage-db.ts:2679-2690）
   以 `new Error("[magic-context] storage unavailable: …")` 重构错误且不带
   `cause`，底层 `SqliteAcquisitionBusyError`/`MigrationLockBusyError` 类型
   在装配点**不可判别**；包公共面的 `isTransientSqliteError` 只认 code、
   对该包装 Error 无效，message 子串分类过于脆弱。因此 5e（见变更点）必须
   在 `storage-db.ts` catch 处保留类型信息（FORK 注释：附 `cause` 或导出
   typed 包装），bootstrap 按类型判定 busy/瞬时，禁止按 message 文本分类。
3. **usage 0 展示**：读不到真读数时 usage summary 返回 null（面板收起），
   不渲染假 0%。

### ① 编辑重发（模型侧闭环修复 + 文本侧 e2e 定位）

模型侧三处组合修：协议补字段 → UI 带当前选择 → 停止旧模型写回。
文本侧先 e2e 复现（两个候选：编辑器提交值回退 `ChatPromptEditor.tsx:211-217`；
running-turn 抢占缺口 `fork-edit-retry.ts:143-148` vs
`session-flow.ts:396-407` 判据不一致），复现哪个修哪个。
agent 默认模型：订阅 `NodeModelSelectionConfigRepository.onDidChange`
（全仓现无订阅者），把 configuredDefault 改为可变读取。

### ② 切会话跳顶（方案 A+B，不做倒序重构）

- A：初始滚动落点延迟到「本会话首批真实测高完成」后执行。
- B：`timelineRowHeightCache` 按 sessionKey 分区，切回会话即命中真实高度。

### ③ 前台子智能体手动关闭（最小改动方案 A）

`conversationStatusPanelModel.ts` 拿不到 `controlWorkId` 时回退
`subagent.agentId`（协议已有该字段；runtime `stopTask` 按 agentId 可停）；
`runner.ts` 前台路径补 `isTerminalRuntimeTask` 早退防终态覆写成 failed；
目录页透传已有的 `handleCancelBackgroundWork`。

### ④ 同步派遣返回 childSessionId

3 文件：契约（接口+zod 双改）、runner 输出对象、handler schema+模型可见渲染。
命名沿用 `childSessionId`（与异步侧一致）。锚点抽查补充：`handlers/agent.ts:53-80`
异步分支的 JSON schema 同样 `additionalProperties:false` 且缺该字段，与
contracts 异步 zod（已有字段）存在既有不一致——4c 两分支同补，顺带消解。

### ⑥ exec 输出文件 GiB 级膨胀（三包证据修正后的真形态）

取证证据包：`cache/exec-log-frontend-writers.md`、`cache/exec-log-background-tasks.md`、
`cache/exec-log-db-truncate-tests.md`。事实链：

- Bash 工具（前台与 `run_in_background`）的 stdout/stderr 由子进程**经继承
  fd OS 直写** `~/.omz/cli/exec/<sessionId>/<toolCallId>-stdout.log`
  （`adapters/src/exec/bash-file-output.ts:32-47`、`node-execution-adapter-run.ts:74-80`），
  Node 侧零缓冲；另一采集路径 `OutputCollector`（50MB 预算+背压+硬截断，
  `output-collector.ts:140-173`）被该直写路径明确绕过。
- 唯一闸门是 **5GiB 看门狗**（`BASH_RUNTIME_OUTPUT_LIMIT_BYTES`，
  `execution-utils.ts:11`）：`stat` 每 5s 轮询，超限杀进程并给出
  "Background command killed: output file exceeded 5GB"，但**文件原样保留**。
  事故 5.13GiB/次 = 5GiB 上限 + 轮询间隔超调，时间线（61 分钟内 5 次）
  排除「60min 子代理超时杀」的解释——每次都是写满被看门狗杀的。
- sqlite 层（`messages.ts:113 savePart` / `message-persistence.ts:354`）
  **没有任何截断**；用户观察到的「~338 字符入库」实为后台任务的固定通知
  文案（`bash-model-content.ts:131,142`，实测同型记录 323 字符）。真正的
  截断在 executor 序列化层（envelope preview 2,000 字符 + resultBudget
  30,000，`result-serialization.ts` / `bash-model-content.ts:10`）。
- `storageCatalog.ts:29` 把 `cli/exec` 归 toolOutputs 类且 `toolOutputs:"none"`
  不可清理；exec 目录与 agents 产物目录均无保留期/轮转/自动回收。
- 已有可复用先例：`capForegroundArtifactStream`（`node-execution-adapter-results.ts:137-161`，
  物理 truncate）、`OutputCollector.writePersisted` 硬上限模式。

**方案**（三道护栏，各自独立成立）：

1. **上限下调 + 可配置**：`BASH_RUNTIME_OUTPUT_LIMIT_BYTES` 5GiB → 默认
   256MiB，新增 env `ZCODE_EXEC_OUTPUT_LIMIT_BYTES` 可覆盖（合法范围
   1MiB..1GiB）。256MiB 取舍：容得下大型构建/测试输出（真实使用里
   `pnpm build` 级输出在几十 MiB），同时把事故单文件上限压 20 倍。
   前后台一致：`bash.ts:311-316` 每请求硬填 `maxPersistedBytes` 会把 env
   架空（request 值优先级最高），须移除硬填、统一走 adapter 侧 env 解析。
2. **超限杀进程后物理截断**：新增头尾截断 helper（保留头尾各 ~1MiB，中间
   替换为一行 `[truncated N bytes]` 标记；`capForegroundArtifactStream`
   仅做头部 truncate，只作参考不作复用），挂在「看门狗杀进程且**子进程
   确认退出后**」的收尾处（`bash-file-output.ts:65-87` onLimit 只触发
   requestStop，不在回调内截断——terminateProcessTree 即发即忘，提前截断
   会被持有继承 fd 的子进程重新撑大）。这是根治项：上限再低，N 次重试
   也会堆 N×上限，只有截断才能保证落盘体积有界。
3. **目录可清理**：`storageCatalog.ts` 的 `CLEANABILITY.toolOutputs:"none"`
   统管 `cli/artifacts、cli/agents、cli/exec…` 整组——不动整组，为
   `cli/exec` 单列可清理子类别并接入清理入口消费面。

## 最终项目结构

无新包。改动集中在既有文件 + 新增测试脚本：

```
omz/
├─ apps/zcode-cli/packages/
│  ├─ bootstrap/src/app/
│  │  ├─ magic-context-turn-transform.ts      ⑤ 可观测性+重试（fork 自有层）
│  │  ├─ create-app.ts                        ⑤ transform_absent 事件
│  │  ├─ magic-context-usage-summary.ts       ⑤ usage null 语义
│  │  ├─ process-provider-registry-runtime.ts ① 默认模型实时
│  │  └─ zcode-protocol-v4/commands/handlers/
│  │     ├─ fork-edit-retry.ts                ① 模型解析+抢占判据
│  │     └─ session-flow.ts                   ① 抢占判据对齐
│  ├─ contracts/src/tools/agent.ts            ④ 契约双改
│  ├─ adapters/src/exec/
│  │  ├─ execution-utils.ts                   ⑥ 上限常量下调+env 覆盖
│  │  ├─ bash-file-output.ts                  ⑥ 看门狗杀后物理截断
│  │  └─ node-execution-adapter-run.ts        ⑥ 截断收尾挂点
│  ├─ core/src/
│  │  ├─ subagent/runner.ts                   ③ 终态修正 ④ 输出加字段
│  │  ├─ tool/handlers/agent.ts               ④ schema+渲染
│  │  └─ runtime/methods/turn-model.ts        ① 写回收敛
│  └─ magic-context/
│     ├─ src/core/hooks/magic-context/
│     │  └─ transform-postprocess-phase.ts    ⑤ lastResponseTime 语义（FORK）
│     └─ scripts/test-boot-busy-retry.mjs     ⑤ 新增
├─ packages/
│  ├─ shared/src/zcode-protocol-v4/command.ts ① editUserQuery.modelSelection
│  └─ ui/src/v4/
│     ├─ SessionPane.tsx                      ① 编辑带模型 ③ 目录透传
│     ├─ ConversationStatusPanel.tsx          ③（由 model 层驱动，可不动）
│     ├─ conversationStatusPanelModel.ts      ③ controlWorkId 回退
│     ├─ ConversationTimeline.tsx             ② 落点延迟
│     ├─ timelineRowHeightCache.ts            ② 按 session 分区
│     └─ prompt-editor/ChatPromptEditor.tsx   ①（若 e2e 命中提交值回退）
└─ docs/（仓库外）本 spec + memory
```

## 变更点清单

| # | 文件 | 改动 | 区域 |
|---|---|---|---|
| 5a | `bootstrap/src/app/magic-context-turn-transform.ts:770-830` | 三条静默路径发 `magic_context.transform_absent`（reason: disabled/import_failed/db_null:<细分>）；`:810` 开库包 busy 有界重试。db_null 细分（round-2 新 P1-3）：`describeStorageUnavailability` 未从包公共面导出、bootstrap 不可调——改用已导出的 `getSchemaFenceRejection`/`getMigrationOnOpenRefusal` 组合出 fence/migration_guard/busy_or_open_failure，busy 细分结合 5e 的 cause 判定。退避常量 migrations.ts:34 未导出——bootstrap 本地复制前 4 档 [1s,2s,4s,8s] 并注释来源 | fork 层 |
| 5b | `bootstrap/src/app/create-app.ts:782-897` | 动态 import 失败捕获并入 5a 事件 | fork 层 |
| 5c | `bootstrap/src/app/magic-context-usage-summary.ts:67` | `usedPercent` 无真读数时 null | fork 层 |
| 5d | `magic-context/.../transform-postprocess-phase.ts:2547-2549` | TTL execute 后仅在存在过真读数时推进 lastResponseTime（FORK 注释） | core 区 |
| 5e | `magic-context/.../storage-db.ts:2679-2690,2783-2789` | catch 重构错误时保留底层类型（附 `cause` 或 typed 包装并导出判定），供 5a 重试分类（FORK 注释） | core 区 |
| 5f | `magic-context/scripts/test-boot-busy-retry.mjs`（新增） | 第二进程 `BEGIN IMMEDIATE` 占锁制造 busy，断言重试后成功/上界 throw | 新增 |
| 1a | `packages/shared/src/zcode-protocol-v4/command.ts:131-137` | `editUserQuery` 加 `modelSelection: modelSelectionSchema.optional()` | shared |
| 1b | `packages/ui/src/v4/SessionPane.tsx:2456-2491` | `handleEdit` 提交带 composer 当前 modelSelection | ui |
| 1c | `bootstrap/.../fork-edit-retry.ts:337-379` | intent 的 modelSelection 取 `payload.modelSelection ?? 原快照`（显式覆盖优先） | fork 层 |
| 1c' | `contracts` 的 `TurnInputIntentMetadata` + `bootstrap/.../input-intent.ts:67-101` | 增加可选 `modelSelectionPinned?: boolean`；显式携带=置 pin 的**全集**（round-2 新 P1-2）：sendText（session-flow.ts:203）、sendGoal（handlers/goal.ts:68-69）、createSession firstInput（handlers/session-mgmt.ts:88-93）、legacy session/send（server-operations.ts:1974-1978）。**定调：pin 是 admission 期进程内标志，不跨持久化、不跨 wire**——input-intent-persistence.ts:23-49、product-projection.ts:3400-3407/:3530-3548、input-intent.ts:104-130（queue 提升路径）均不透传 pin（恢复/提升项按非显式处理、不写回，有意语义，注释声明）；T-E1 增补 goal/createSession/legacy 三路径断言 | contracts+fork 层 |
| 1d | `core/src/runtime/methods/turn-model.ts:47-50` | 仅显式 pin 的选择写回 session；intent 继承的快照不再静默覆盖+持久化。实现注：`:49-60` 是「写回+persist+emitModelSelected」三连，收窄写回须连同事件面一起评估（UI 模型指示是否跟随变化），core（cli 侧非逐字区，注释说明） | core |
| 1e | `bootstrap/.../session-flow.ts:419-427` | 抢占判据补 `runtime.getActiveForegroundExecutionId() !== undefined`（与 :396-407 对齐） | fork 层 |
| 1f | `bootstrap/.../process-provider-registry-runtime.ts:82-96` + 消费面 | 订阅 `onDidChange`，configuredDefault 改可变读取。范围（judge P1-5，仅改单文件不够）：frozen registry 改 getter 读 repository，消费点逐个转活读——`create-app.ts:592`（闭包，确认活读）、`create-app.ts:978-980`（build 时拷贝静态化 → 改引用/getter）、`runtime-config.ts:285`（装配期求值 → 惰性）、`zcode-protocol-entrypoint.ts:191`（确认活读）；dispose 时退订 | fork 层 |
| 1g | `packages/ui/src/prompt-editor/ChatPromptEditor.tsx:211-217` | 提交值统一受控来源（条件：T-E2 命中再改） | ui |
| 4a | `contracts/src/tools/agent.ts:44-55,79-92` | `AgentCompletedOutput`+zod 加 `childSessionId: string` | contracts |
| 4b | `core/src/subagent/runner.ts:1170-1186` | 输出对象加 `childSessionId: lifecycle.childSessionId` | core |
| 4c | `core/src/tool/handlers/agent.ts:23-52,137-151` | AGENT_TOOL_OUTPUT_SCHEMA completed 分支加字段（接口+zod 双改）；formatAgentOutputForModel 同步分支透出；**异步分支 `:53-80` 的 JSON schema 同步补齐**（既有 additionalProperties:false 下缺字段的不一致，顺带消解） | core |
| 3a | `packages/ui/src/v4/conversationStatusPanelModel.ts:334-344` | `controlWork` 未命中时回退 `{controlWorkId: subagent.agentId, cancellable: true}`（status 非 waiting 时） | ui |
| 3b | `core/src/subagent/runner.ts:382-436` | catch 开头 `isTerminalRuntimeTask` 早退，防 killed 被覆写 failed；抛 ToolCancelled 语义 | core |
| 3c | `packages/ui/src/app-shell/SubagentDirectorySidePane.tsx` + 上游 | 透传 `onCancelBackgroundWork`，目录行加停止（父 pane 非 readOnly 时显示） | ui |
| 2a | `packages/ui/src/v4/ConversationTimeline.tsx:1587-1655,1778-1811` | 初始落点 guard：等本会话首个 measured 高度后再 scrollToBottom/restore。检测信号（judge P2-9）：以 `virtualizer.measurementsCache` 出现本会话首项（或 rowElementRegistry 首个 set 回调）为 guard 释放信号；分工：guard 只拦「切换后首次落点」，释放后离底恢复归 `:1657-1669` 二次 restore effect、贴底跟随归 `:1778-1811` 底部锚定，三者不得重复执行落点 | ui |
| 2b | `packages/ui/src/v4/timelineRowHeightCache.ts` + `ConversationTimeline.tsx:1589` | 键加 sessionKey 前缀分区；LRU 上限不变。**同步移除/收窄 `:1589` 的全量 `clear()`**（judge P1-3：不清则分区在切会话瞬间被抹掉、命中率恒 0；改为仅清当前 sessionKey 分区或删除，`rowElementRegistry` 的 `:1592-1595` 清空逻辑保留——跨会话 rowId 冲突由它兜底） | ui |
| 6a | `adapters/src/exec/execution-utils.ts:11` + `core/src/tool/handlers/bash.ts:63,311-316` + `adapters/src/exec/node-execution-adapter-lifecycle.ts:129` | 看门狗上限 5GiB → 默认 256MiB，env `ZCODE_EXEC_OUTPUT_LIMIT_BYTES` 可覆盖（1MiB..1GiB）。落点（judge P1-2 + round-2 新 P1-1）：`persistedOutputLimit` 优先级 `request.maxPersistedBytes ?? options ?? 常量`，**两处硬填都会把 env 架空**——bash.ts:311-316（前台）与 lifecycle.ts:129（后台，**正是事故路径**：子代理 run_in_background 每次硬填常量覆盖 request），两处都移除/改走 adapter 默认（env 解析），前后台一致（参照 `bash-output-policy.ts` 的 resolve 范式）；硬编码文案 `"output file exceeded 5GB"` 两处（`node-execution-adapter-run.ts:342`、`node-execution-adapter-results.ts:176`）同步动态化 | adapters+core |
| 6b | `adapters/src/exec/bash-file-output.ts:65-87` + `node-execution-adapter-run.ts` | 看门狗杀进程后对超限文件物理截断：**新 helper**（judge P2-6：`capForegroundArtifactStream` 仅头部 truncate，无头尾+标记能力，仅作参考）——头尾各 ~1MiB + `[truncated N bytes]` 标记行。时序（judge P1-1）：截断必须在子进程**真正退出后**执行——file 分支复用 `run.ts:235-240` 的 closePromise（或 `pendingBashProcessTreeKills` 对应 kill 的 completion，设上界 await）；`watchLimit` 的 onLimit 只触发 requestStop，**不在回调内直接截断**（Windows taskkill 与 POSIX 两阶段 SIGKILL 均异步，提前截断会被持有继承 fd 的子进程重新撑大） | adapters |
| 6c | `packages/services/src/storage/domain/storageCatalog.ts:29,79-91`（judge P2-3 更正路径） | `cli/exec` 纳入可清理。类别设计（judge P2-11 + round-2 新 P1-4）：优先 per-path 覆盖（避开新类别要动的 `packages/shared/src/storage.ts:9-21` STORAGE_CATEGORY_IDS、`storageCategoryPresentation.ts:17-29` icons 齐套、i18n `resourceManager.storage.category.<id>`）；若必须单列类别则上述 4 文件 + i18n 两份全部落地。**在飞保护（关键）**：`cleanPlan.ts:26-51` 给 exec 清理加时间窗/不活跃保护（参照 subagentTranscripts 24h 窗口），防一键清掉运行中后台任务的输出文件；T-C2 补「运行中任务文件不被清」断言；`cli/artifacts`、`cli/agents` 清理性状不变 | services+shared |
| 6d | `adapters/scripts/test-bash-output-limit.mjs`（新增） | OutputCollector/上限/截断行为用例（OutputCollector 可直接喂 Buffer 无需 spawn） | 新增 |

## 详细实现步骤

### phase-mc-observability（⑤ 可观测性，先行——即使真因未定也必须落）

- Step 1 — phase-mc-observability — blocking: yes — qa: auto：
  `magic-context-turn-transform.ts` 装配处：`:776 enabled` 为 false、
  `:811 db === null`（细分 pending/fence/guard，经
  `describeStorageUnavailability`）、create-app 动态 import 失败，三条路径
  各发结构化事件 `magic_context.transform_absent`（logger.warn 级）+
  现有日志；补 bootstrap 侧测试断言事件发射。
- Step 2 — phase-mc-observability — blocking: no — qa: manual_user：
  桌面实机复现取证：启动桌面 → 任一会话发一条消息 → 抓
  `%TEMP%\zcode\magic-context\magic-context.log` 与宿主事件，确认
  transform_absent 的 reason（预期命中 disabled / db_null / import_failed
  之一）。取证报告落 `cache/desktop-repro.md`（准出条件）。**此步输出
  决定 Step 5 是否需要追加定向修复**；不阻塞其余 Step 开工。

### phase-mc-boot-retry（⑤ busy 重试）

- Step 3 — phase-mc-boot-retry — blocking: yes — qa: auto：
  5e `storage-db.ts` catch 保留底层错误类型（FORK 注释：附 `cause` 或 typed
  包装并导出 busy/瞬时判定；**禁止 message 子串分类**——锚点取证任务 C
  已证包装后类型信息丢失）；随后 bootstrap `:810` 按
  `MIGRATION_LOCK_RETRY_DELAYS_MS` 前 4 档 `[1s,2s,4s,8s]` 退避有界重试，
  仍败维持现有 fail-closed throw；fence/guard 确定性 null 不重试。选型：
  `createMagicContextTurnTransform` 本身是 async（:770-772），重试直接
  `await` sleep 即可，不冻宿主、不走 `openDatabaseAsync`。
- Step 4 — phase-mc-boot-retry — blocking: yes — qa: auto：
  新增 5f `magic-context/scripts/test-boot-busy-retry.mjs`：子进程
  `BEGIN IMMEDIATE` 占锁（显式 `MAGIC_CONTEXT_DB_DIR` 隔离，绝不碰真实
  `~/.omz`；机制已实证：storage-db.ts:911、data-path.ts:229-241），断言
  busy → 重试 → 解锁后成功；锁不释放 → 上界后 throw。纳入 `test:all`
  （package.json scripts 增补）。

### phase-mc-usage-display（⑤ 假 0%）

- Step 5 — phase-mc-usage-display — blocking: no — qa: auto：
  5c usage summary null 语义 + 5d lastResponseTime 条件推进（FORK 注释），
  附测试：无真读数的会话面板不显示 0%。

### phase-edit-model（① 模型侧）

- Step 6 — phase-edit-model — blocking: yes — qa: auto：
  1a 协议加字段（zod 单测）+ 1c/1c' handler 覆盖优先与 pin 标记 + 1d 写回
  收敛（以 `modelSelectionPinned` 为判据，连同 `turn-model.ts:51-60` 的
  `emitModelSelected` 三连一起收窄）；CLI 侧测试：编辑重发后 turn 使用的
  modelSelection == 提交时选择，且 session_model_selection 不被旧快照
  覆盖（对照 v4 命令层既有测试模式）。
- Step 7 — phase-edit-model — blocking: yes — qa: manual_user：
  桌面实机验收：切模型 → 编辑旧消息重发 → 请求落在新模型（CDP 或抓
  provider 请求日志验证）。

### phase-edit-text（① 文本侧，e2e 先行）

- Step 8 — phase-edit-text — blocking: yes — qa: auto：
  e2e 复现（用户不人工复现，由我方自动化）：两脚本各击一个候选——
  (a) CDP 驱动编辑器：打开编辑 → 改文本 → 立即提交，断言
  `dispatchCommand("editUserQuery")` 的 newText；竞态命中则提交值为旧正文。
  (b) headless CLI：活跃生成中发 editUserQuery，断言旧 turn 被抢占
  （`v4 prompt admitted` 出现且无 queue delivery）。命中哪个修哪个（1g/1e）。
- Step 9 — phase-edit-text — blocking: yes — qa: auto：
  按命中结果实施 1g（提交值统一受控来源）或 1e（抢占判据对齐），并把
  Step 8 脚本转为常驻回归用例。

### phase-agent-default-model（① 默认模型实时）

- Step 10 — phase-agent-default-model — blocking: no — qa: auto：
  1f 订阅 onDidChange + 惰性读取（含 1f 列出的全部消费点转活读）；测试：
  同进程内改默认模型配置 → 新建会话初始选择跟随（不改运行中会话的粘住
  语义）。

### phase-dispatch-session-id（④）

- Step 11 — phase-dispatch-session-id — blocking: yes — qa: auto：
  4a/4b/4c 三处同 PR（接口+zod+schema+渲染，**含 4c 异步分支 schema 补齐**）；
  测试：同步 Agent 调用返回含 `childSessionId` 且与 SubagentStopped 事件的
  childSessionId 一致；`.strict()` 校验通过（漏改任何一边该测试必须红）。

### phase-subagent-stop（③）

- Step 12 — phase-subagent-stop — blocking: yes — qa: auto：
  3b 终态修正（测试：前台子代理 stopTask 后 registry 终态 killed、父通知
  cancelled、不覆写 failed）；3a controlWorkId 回退（model 层单测，沿用
  conversationStatusPanelModel 既有测试文件模式）。
- Step 13 — phase-subagent-stop — blocking: no — qa: manual_user：
  3c 目录页停止按钮透传；桌面实机：前台派遣 agent → 状态面板/目录页出现
  停止 → 点击 → 终态「已取消」（CDP `v4-background-work-cancel-*`
  testid 可驱动）。

### phase-timeline-anchor（②）

- Step 14 — phase-timeline-anchor — blocking: yes — qa: auto：
  2a 落点延迟 guard（单测：无 measured 高度时 scrollToBottom 不执行；
  首个 measured 后执行一次）；2b 缓存分区（单测：切回会话命中率、
  LRU 上限不放大）。
- Step 15 — phase-timeline-anchor — blocking: no — qa: manual_user：
  桌面实机：长会话间来回切换，首帧不闪顶、无中间跳动（录屏验收）。

### phase-exec-output-cap（⑥）

- Step 16 — phase-exec-output-cap — blocking: yes — qa: auto：
  6a 上限下调+env 覆盖（含 bash.ts 硬填值移除与两处 message 动态化）+
  6b 看门狗杀进程**并确认子进程退出后**物理截断（头尾各 ~1MiB +
  `[truncated N bytes]` 标记）；6d 新增
  `adapters/scripts/test-bash-output-limit.mjs`：a) 超过上限的输出文件被
  截断为头尾+标记、体积 ≤ 上限+标记余量（用真实 `node -e` 死循环灌输出，
  测试内显式 `ZCODE_STORAGE_DIR` 隔离到临时目录）；b) env 覆盖生效与非法
  值回落默认——**须含一条经 `createExecutionRequest` 构造的请求级用例**
  （judge P1-2：仅 adapter 单测绿而前台路径不生效属虚假验收）；c) 未超限
  文件字节不变。adapters `package.json` scripts 增补 6d。
- Step 17 — phase-exec-output-cap — blocking: no — qa: manual_user：
  6c `cli/exec` 单列可清理子类别并接入清理入口；验收：清理入口（现有
  storage 清理命令/UI）能把 exec 大文件清掉，`cli/artifacts`、`cli/agents`
  清理性状不变，正常会话日志不受影响。

## 测试策略

分层：magic-context `scripts/*.mjs`（无 vitest，node 脚本 + `node:test`）；
bootstrap `node --test scripts/test-magic-context-*.mjs`；contracts/core 走
既有 tsx/node 测试模式；ui 用 tsx --test（v4-perf 族）；桌面验收 CDP 脚本
（模板 `.cu-shots/cdp-verify-*.mjs`，untracked）。全部命令实跑并贴结果。

### 测试用例

- T-M1 — blocking: yes — transform_absent 事件用例（Step 1）。构造条件
  （judge P2-5）：enabled 门可直构；db_null 门须显式 `fail_closed_blocking=false`
  （默认 true 时 `:816-818` 先 throw、到不了 `:819-823` 事件分支）；
  import_failed 若无法自动注入坏模块，并入 Step 2 人工取证（cache/desktop-repro.md）
  准出，不阻塞 T-M1 其余两门。
- T-M2 — blocking: yes — boot busy 重试成功 + 上界 throw 两例（Step 3/4）
- T-M3 — blocking: no — 无真读数 → usedPercent null（Step 5）
- T-E1 — blocking: yes — editUserQuery 模型覆盖优先 + 不写回（Step 6）
- T-E2 — blocking: yes — 编辑提交值/抢占 e2e 复现脚本（Step 8/9）。
  常驻落点（judge P2-7）：候选 (b) headless 抢占用例落 tracked 路径
  `apps/zcode-cli/packages/bootstrap/scripts/test-edit-retry.mjs`
  （`node --test`，进 package.json scripts）作为 blocking 自动门禁；
  候选 (a) CDP 编辑器脚本留 `.cu-shots/`（untracked），命中后按需转正。
- T-E3 — blocking: no — 默认模型同进程实时（Step 10）
- T-D1 — blocking: yes — 同步派遣 childSessionId + strict 校验（Step 11）
- T-S1 — blocking: yes — 前台 stop 终态 killed/父通知 cancelled（Step 12）
- T-S2 — blocking: yes — controlWorkId 回退命中（Step 12）
- T-U1 — blocking: yes — 落点 guard + 缓存分区分测（Step 14）
- T-C1 — blocking: yes — 超限截断（头尾+标记、体积有界）+ env 覆盖/非法值回落（Step 16）
- T-C2 — blocking: no — `cli/exec` 可清理且不误伤（Step 17）
- T-X1 — blocking: no — 门禁回归：根 typecheck/lint、cli turbo typecheck、
  magic-context test:all（38+新增）、oxfmt 零新增、desktop 差分（全批次）

## 风险与回滚方案

- **⑤ 重试与 fail-closed 契约冲突**：限定 busy/瞬时类 + 上界后仍 throw；
  回滚 = revert 5a-5e 单个 commit（每 Step 独立提交）。
- **⑤ Step 2 复现可能指向配置/环境而非代码**（如用户侧 features.magicContext
  被关）：产出取证报告，修复转为「配置面告警」，机制修复（可观测性）仍保留。
- **1d 改 turn.ts/turn-model.ts 触及 core turn 主链**：改动最小化（仅收窄
  写回条件），靠 T-E1 + 既有 turn 测试回归；异常即 revert 1d，其余 1a-1c
  独立成立（UI 带选择 + handler 覆盖已消解主要症状）。
- **④ zod .strict() 双改漏边**：T-D1 以「漏改必红」设计。
- **② 滚动回归面大**：方案 A/B 均不动锚定状态机语义；既有 conversation
  投影/导航测试全绿为门槛；Step 15 录屏人工把关。
- **多进程重试放大锁竞争**：退避序列错峰（1s 起）；重试仅装配期一次，
  不在 pass 内循环。
- **⑥ 截断丢失调试信息**：头尾各 1MiB + 截断字节数标记已保住「开头
  命令回显 + 结尾报错」两段最常用诊断信息；上限与头尾大小均 env 可调。
  若用户后续仍想留全量，回滚 = 6b 单 commit revert（上限下调与清理独立）。
- **⑥ 上限下调误伤大输出**：256MiB 默认 > 已知最大合法构建输出一个数量
  级；env 可临时上调；超限杀进程行为与现状一致（只是更早触发）。
- **⑥ 清理范围扩大误删**：6c 仅放开 `cli/exec` 类目，清理动作仍走现有
  storage 清理入口的既有确认/范围语义，不新增自动删除路径。
- 回滚粒度：每 Step 一个 commit（pathspec 提交），任一 phase 可单独 revert。

## Context Bundle

```yaml
iteration_name: bugfix-batch-20261009
requirement_path: 用户口述（对话内五缺陷，无 prd.md）
spec_path: docs/iterations/bugfix-batch-20261009/spec.md
explore_summary: >
  三轮共 11 个 readonly explore/取证：①编辑重发/模型链路（模型侧闭环：协议无字段+
  快照复用+写回；文本侧 2 候选）②虚拟列表跳顶（估计总高<视口钳0）③子代理
  生命周期（stopTask 链路已通，前台缺按钮+终态覆写）④同步派遣（childSessionId
  内部已有未透出，3 文件+异步分支 schema 既有不一致）⑤mc 触发链+boot 失败传播
  （busy 行是成功诊断行；桌面进程静默无 transform，三条静默门；openDatabase
  catch 抹错误类型）+ 本机日志/DB 取证；⑥exec 输出膨胀（三包：OS 直写 fd、
  5GiB 看门狗杀进程留全量文件、sqlite 层无截断/338字符=后台通知文案、
  storageCatalog 不可清、capForegroundArtifactStream 可复用）。锚点抽查
  33/33 命中零偏移。证据包 5 份在 cache/ 下。
impact_files:
  - apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts
  - apps/zcode-cli/packages/bootstrap/src/app/create-app.ts
  - apps/zcode-cli/packages/bootstrap/src/app/magic-context-usage-summary.ts
  - apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts
  - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts
  - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts
  - apps/zcode-cli/packages/contracts/src/tools/agent.ts
  - apps/zcode-cli/packages/core/src/subagent/runner.ts
  - apps/zcode-cli/packages/core/src/tool/handlers/agent.ts
  - apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts
  - apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/transform-postprocess-phase.ts
  - apps/zcode-cli/packages/magic-context/scripts/test-boot-busy-retry.mjs（新增）
  - apps/zcode-cli/packages/adapters/src/exec/execution-utils.ts
  - apps/zcode-cli/packages/adapters/src/exec/bash-file-output.ts
  - apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts
  - apps/zcode-cli/packages/adapters/scripts/test-bash-output-limit.mjs（新增）
  - apps/zcode-cli/packages/core/src/tool/handlers/bash.ts
  - apps/zcode-cli/packages/magic-context/src/core/features/magic-context/storage-db.ts
  - packages/services/src/storage/domain/storageCatalog.ts
  - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/input-intent.ts
  - apps/zcode-cli/packages/bootstrap/scripts/test-edit-retry.mjs（新增）
  - apps/zcode-cli/packages/magic-context/package.json + apps/zcode-cli/packages/adapters/package.json（测试脚本增补）
  - packages/shared/src/zcode-protocol-v4/command.ts
  - packages/ui/src/v4/SessionPane.tsx
  - packages/ui/src/v4/conversationStatusPanelModel.ts
  - packages/ui/src/v4/ConversationTimeline.tsx
  - packages/ui/src/v4/timelineRowHeightCache.ts
  - packages/ui/src/app-shell/SubagentDirectorySidePane.tsx
  - packages/ui/src/prompt-editor/ChatPromptEditor.tsx（条件）
constraints:
  - src/core/ FORK 注释登记；不重排不改风格
  - fail_closed_blocking 默认 true，busy 重试须有上界
  - openDatabase 同步 API；复用既有退避常量
  - E2E 绝不写真实 ~/.omz（显式 DB_DIR）
  - zod .strict() 契约双改
  - 有意设计不得顺手改（会话粘模型/后台脱钩/retry 重发原文）
  - 门禁：根 typecheck/lint + cli turbo + mc test:all + oxfmt + desktop 差分
blocking_steps: [1, 3, 4, 6, 8, 9, 11, 12, 14, 16]
```
