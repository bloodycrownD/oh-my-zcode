# 问题复现套件

这里只放**复现**，不放修复。行为断言在缺陷存在时真实失败、修复后转绿；`bug1` / `bug3` 另有少量源码级守卫（防止调用点回退），重构时需要同步更新。当前覆盖 4 个 bug 族（10 个用例）；模型选择器空显示、虚拟列表、长历史 E2E 的回归脚本仍只在各自的 artifacts 目录，未并入这里。

```bat
pnpm test:repro
:: 或
node_modules\.bin\vitest.CMD run --config repro/vitest.config.ts
```

该目录不在默认 `vitest.config.ts` 的 include 列表内，不会进入常规 CI。

## 用例

- `bug1-composer-config.test.ts`：空正文时文字草稿不落盘（B2），模式/模型改由 config store 持久化；常规 `sendText` 不写 v2 Recent，New Task 回落 `build` + 目录第一项。
- `bug2-manifest-page.test.ts`：model-only 轮的 `firstMessageId` 落到轮内 assistant，页游标从轮中间开始，整页物化缺行。
- `bug3-submission-gate.test.ts`：旧档位被投影成无 `options` 的 selection，`createComposerSubmissionConfig` 返回 null，按钮与 Enter 同时失效。
- `bug4-unread-running.test.ts`：前台完成记录后任务已重新运行，blur 仍补写 `mark-unread`，蓝点顶掉运行中图标。

## 因果验证（突变检查）

临时改生产代码 → 对应用例转绿 → 立即 `git checkout -- <file>` 还原。已实测：

| 用例          | 临时改动                                                         | 结果                                                     |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| bug1 空草稿   | `composerDraftStore` 读取/删除不再要求正文非空                   | 1/1 绿（CR 后改为：草稿不落空正文，配置走 config store） |
| bug1 sendText | `pendingCommandRegistry.acceptComposer` 在缺 composer 时合成回执 | 1/1 绿                                                   |
| bug2 三条     | `turn-manifest-entry` 把 trigger messageId 补进 `messageIds`     | 3/3 绿（页游标用例由真实 builder 驱动）                  |
| bug3          | `composerSubmissionConfig` 失效档位回落模型默认档                | 2/2 绿                                                   |
| bug4 补写     | `flushOnLeave` 回读当前状态并在 running 时跳过                   | 1/1 绿                                                   |
| bug4 指示器   | `deriveTaskLeadingIndicator` 让 loading 优先于 unread            | 1/1 绿                                                   |

## 模型选择器空显示（真实 Electron E2E，3/3）

WDIO + Electron 实机结果（spec 与 artifacts 在 `<artifact-dir>`）：

- **S：已有会话，草稿有 mode、无 selection**。`useDraftConfigControl` 首帧取 `draft.modelSelection`，把 `sessionConfig.modelSelection` 丢掉；3/3 复现，`data-model=""`、trigger=`选择模型`、sendDisabled=true。
- **D/E：草稿 selection 在当前目录不可解析**。用真实形态 `bigmodel-api / GLM-5.3 / max`（provider-not-found），3/3 复现，同样空显示且发送禁用。
- **A/B：New Task 空草稿 + mode**。被 `useDraftConfigControl.ts:221-224` 的补偿补回，3/3 正常，不是本次直接原因。
- **C4：冷启动首读窗口**。`data-model` 非空但 normalized 空，只持续 20~106ms，不是持久空显示。

修复（`packages/ui/src/v4/composer/useDraftConfigControl.ts`）：

- Session 首帧：`draft.modelSelection` 缺失或硬失效时回落到 `sessionConfig.modelSelection`，再退到目录 preferred。
- Root 草稿：view ready 且 `selectionIssue` 为 `provider-not-found` / `model-not-found` 时，旧选择替换为 `preferredSelection`；瞬时 loading 与 reasoning-level 失效不替换。

修后 E2E 回归：同一 spec 18/18 通过，A/B/C/D/E/S 各 3 次签名一致；D/E/S settled 均为 `e2e-upstream / deepseek-v4-flash / high`、trigger 显示模型名、sendDisabled=false（A 组空正文仍禁用，预期）。修复分支只命中一次，无重复 setState，无 React 告警。报告在 `%TEMP%\zcode-model-empty-repro\artifacts\report-postfix.json`。

## 仍未钉死的部分

- **bug1 sendText 的调用点**：用例驱动的是真实 `PendingCommandRegistry`，但 `SessionPane` 里“只给 createSession 挂回执”的三元表达式仍是代码阅读结论，没有组件级执行。要完全钉死需要挂载真实 `SessionPane` 走一次发送。
- **bug3 的真实触发**：用例证明“失效选择会让门禁为 null”，但当前应用 LevelDB 里解析出的 21 份真实草稿全部带有效 model/selection；日志里 `model-selection.getView` 也都是 OK（偶发一次 575ms）。也就是说，门禁因果已定，**用户现场是哪条输入让它失效还没定**。需要一次应用内探针：`canSend=false` 时记录 `draft.modelSelection / effectiveSelection / selectionIssue / viewStatus / pending / routingAllowsSend / attachmentsReady`。
- **bug4 补写的状态源**：突变用的是 `getTaskMeta().status`，但产品里 running 的权威是 sessions-index 的 activity，`rowToMeta` 又是 sticky `cli_last_outcome`。修法到底该读哪个源、还是在新一轮开始时清掉 pending 记录，需要先定。

## 现场数据佐证

- 真实会话（id 已脱敏为 `sess_<redacted>`）的 turn 211：`turn_id` 是 user 消息，`first_message_id` 是 assistant 消息。
- 同一会话 2026-10-29/30 的 CLI 日志已有 `row page alignment mismatch`，说明该缺陷早于 v1.1.0。
- 2026-11-01 日志有 `v4 row manifest windowed fallback … reason=inconsistent`，对应“重启有时能加载回来”。
- 应用 LevelDB（`<app-data>/session/Local Storage/leveldb`）只读扫描：解析出 21 份 `zcode-v4-composer-drafts`，其中存在 `text=""` 但 `mode/modelSelection` 完整的草稿；`zcode-composer-recent:v2` 与旧 `zcode-model-selection-recent-v1` 的计数都是 **0**。这直接支持 bug1 的两条：空正文配置当前读不到，Recent 在真实运行中从未写入。
- `~/.omz/v2/tasks-index.sqlite` 曾现场捕获到一条 `unread_at`，同时对应会话仍在 running（最后一条 assistant `finish=null`、4 个 Agent 工具 running），随后被聚焦自动清除；这支持 bug4“蓝点=未读而非结束”的判定。
