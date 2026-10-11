# CR v0.1.0 wave-1 取证包 — evidence-ui-tui-i18n

| 项 | 值 |
|---|---|
| head_sha | `aba59a94e5ae42bdc6de506de2560581580e3ee8` |
| base_sha | `1fa2d0e` |
| 节点 id | `evidence-ui-tui-i18n` |
| 取证范围 | `packages/ui/**`、`apps/zcode-cli/packages/tui/**`、`apps/zcode-cli/packages/i18n/**` 在 BASE..HEAD 的全部变更 |
| 模式 | readonly 取证（未修改任何代码/文档，仅写本证据包） |
| 覆盖提交 | `66b1596`(s26-w4) `abc5712`(s26) `8f78349`(s27-w1) `ce87d22`(s27-w2) `7cae56c`(s28-pre) `1189755`(s28-pre2) `e94c895`(s29) `cf1f5df`(s30) `8267303`(s32) `aba59a9`(s35-fix) 等 14 个 |

> 说明：本包**只摆事实与可疑点，不下结论**。判定留给 review 节点。

---

## 6. diff 统计（本范围）

`git diff --stat 1fa2d0e aba59a9 -- packages/ui apps/zcode-cli/packages/tui apps/zcode-cli/packages/i18n`

```
 52 files changed, 1189 insertions(+), 732 deletions(-)
```

### 6.1 分片统计

| 子范围 | 文件数 | +/− |
|---|---|---|
| `apps/zcode-cli/packages/tui` | 6 | 0 / +369 − |
| `apps/zcode-cli/packages/i18n` | 3 | +30 / −46 |
| `packages/ui` | 43 | +1159 / −317 |

### 6.2 按关注点归类

**S27 压缩删除面（TUI/UI 死链 + key）**

| 文件 | 变更 |
|---|---|
| `apps/zcode-cli/packages/tui/src/app-compact-timeline.ts` | **整删**（−183） |
| `apps/zcode-cli/packages/tui/src/app-events.ts` | −34 |
| `apps/zcode-cli/packages/tui/src/app-keyboard.ts` | −14 |
| `apps/zcode-cli/packages/tui/src/app-model.ts` | −15（`TimelineMessage` / `role:"timeline"` 类型摘除） |
| `apps/zcode-cli/packages/tui/src/app-submit.ts` | −51（`/compact` 提交路径整删） |
| `apps/zcode-cli/packages/tui/src/app-transcript-components.tsx` | −72（`CompactTimelineRow` 整删） |
| `apps/zcode-cli/packages/i18n/src/types.ts` | −12（`status.compact*` 3 + `transcript.compact.*` 8 类型） |
| `apps/zcode-cli/packages/i18n/src/locales/{en-US,zh-CN}.ts` | 各 −16（对应 key）+4（`/ctx-*`）+5（品牌） |
| `packages/ui/src/v4/SessionPane.tsx` | −40（compact 分支 + 3 toast + `handleSendCompressionCommand`） |
| `packages/ui/src/v4/ConversationRowView.tsx` | −53（marker 渲染 case + `MARKER_ARCHIVE_ICON`） |
| `packages/ui/src/v4/ConversationComposer.tsx` | −5 |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | −5 / +1 |
| `packages/ui/src/v4/ConversationQueuePanel.tsx` | −12 |
| `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | −7 |
| `packages/ui/src/v4/ConversationUserInputContent.tsx` | −14 |
| `packages/ui/src/v4/slashCommands.ts` | −7 |
| `packages/ui/src/v4/pendingCommandRegistry.ts` / `pendingCommandReplay.ts` | −6 / −8 |
| `packages/ui/src/v4/chatLoadingVisibility.ts` | −8 |
| `packages/ui/src/mentions/nodes/mentionIconDom.ts` / `promptMentionDecoration.ts` | −11 / −5 |
| `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | −8（`getContextCompressionCommand` + 2 死 prop） |
| `packages/ui/src/chat-input-toolbar/display.tsx` | −6（re-export 摘除） |
| `packages/ui/src/lib/zcodeTaskUsageFallback.ts` | −16 |
| `packages/ui/src/lib/zcodeUiError.ts` | −1 |
| `packages/shared/src/test-ids.ts`（**范围外，仅记录**） | −4（2 个无消费者 TID）/ +2（新 TID） |

**S29 UI 配置面（新增）**

| 文件 | 行数 |
|---|---|
| `packages/ui/src/settings/MagicContextSettingsSection.tsx` | +263（新建） |
| `packages/ui/src/settings/MagicContextSettingsFields.tsx` | +252（新建） |
| `packages/ui/src/settings/magicContextSettingsForm.ts` | +232（新建） |
| `packages/ui/src/settings/settingsPageConfig.ts` | +9 |
| `packages/ui/src/lib/settingsNavigation.ts` | +3 |
| `packages/ui/src/SettingsPage.tsx` | +10 |
| `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` | 各 +42（`settings.context.*` 30 键） |

**S30 面板新段（新增/改动）**

| 文件 | 行数 |
|---|---|
| `packages/ui/src/chat-input-toolbar/magicContextUsageRows.ts` | +112（新建） |
| `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | +60（S30 部分） |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | +1 |
| `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` | 各 +8（`chat.contextUsage.magicContext.*`） |

**S32 品牌跟随（本范围 14 文件）**

`featureSuggestedPrompts.ts`(118) / `pluginIconSource.ts`(12) / `skillSourceFilter.ts`(6) / `builtinSkillI18n.ts`(4) / `BrowserSettingsSection.tsx`(2) / `pluginCreatorPrefill.ts`(2) / `OnboardingDialog.tsx`(2) / `mcpStore.ts`(2) / `TaskActionMenuContent.tsx`(2) / `useSavedWorkflowGlobalGroup.ts`(2) / `useSavedWorkflowsDirectoryWatch.ts`(6) / `workflowRunPanel.ts`(2) / `i18n/locales/*`（`.zcode/v2`→`.omz/v2`）/ `zcodeSessionStore*.ts`（注释）

---

## 1. S27 删除完整性复核

### 1.1 TUI `app-compact-timeline` 整删后的消费点（零残留实测）

| 原消费点 | spec 锚点 | HEAD 实测 |
|---|---|---|
| `app-events.ts` | L80-82 / L179-203 | 已删（4 个 Compact SessionEventType case + `turnPhase==="compact"` 分支）。HEAD `app-events.ts` 零 `compact` 引用 |
| `app-submit.ts` | L146-273 | 已删（`compactCommandFromText` import + 两条 turn 路径的 timeline 渲染 + `applyResult({...r, response:""})` 特判） |
| `app-keyboard.ts` | L236-243 | 已删（`Ctrl-R` 重放分支 + `latestRetryableCompactCommand` import） |
| `app-transcript-components.tsx` | `CompactTimelineRow` | 已删（`MessageRow` 顶部 `role==="timeline"` 早返回 + 72 行组件体） |
| `app-model.ts` | L41 | 已删（`TimelineMessage` 类型整块 + `Message.role` 的 `"timeline"` 成员 + `Message.timeline?`） |

**符号级零残留实测**（`git grep -n -E "compactCommandFromText|latestRetryableCompactCommand|applyCompactTimelineEvent|createLocalCompactTimelineMessage" aba59a9 -- .`）→ **0 命中**。

**文件级零残留**：`git grep -n "app-compact-timeline" aba59a9 -- .` → **0 命中**。

**TUI 包内 `compact` 全部 27 处命中逐条核对**（`git grep -i -n compact aba59a9 -- apps/zcode-cli/packages/tui/`）：

| 文件:行 | 命中内容 | 归类 |
|---|---|---|
| `app-input-status.tsx:181,277,279,280,283` | `formatCompactTokenCount` / `formatCompactDecimal` | 数字缩写（白名单） |
| `app-mode-command.ts:29,30,95` | `compactQuery` / `isCompactModeQuery` | 布局/查询词 |
| `app-modified-files.ts:23,28,81` | `compactStats` | 布局 |
| `app-sidebar-api.tsx:19,20,147,148` | `COMPACT_IDENTIFIER_PREFIX/SUFFIX_LENGTH` | 布局（id 缩写） |
| `app-tool-transcript.ts:122…368` | `compactLines` | 布局 |

→ **TUI 侧无任何对话压缩语义残留**。

### 1.2 UI 死 prop 透传链摘除后是否留孤儿 prop/类型

链路：`SessionPane` → `ConversationComposer` → `V4ComposerToolbar` → `ChatContextUsage`

| 环节 | 摘除动作 | 中间层残留检查 |
|---|---|---|
| `SessionPane.tsx` | 删 `handleSendCompressionCommand`（−11 行，`:3287-3296`）、删 `onSendCompressionCommand={...}` 透传（`:4130`）、删 `case "compact"` 分支（`:2264-2266`）、删 3 个 toast（`:2307-2315`）、删 `compactExpectedToQueue` 变量 | 无 `compression` 字样残留 |
| `ConversationComposer.tsx` | 删 props 声明 + JSDoc（`:428-431`）、解构（`:507`）、透传（`:1883`）、依赖数组项（`:1940`） | props 接口无残留；`deps` 数组同步摘除 |
| `V4ComposerToolbar.tsx` | 删 `V4ComposerToolbarProps.onSendCompressionCommand`（`:357`）、解构（`:376`）、两个 JSX prop（`:1003-1004`） | 接口/解构/JSX 三处同步 |
| `ChatContextUsage`（`contextUsage.tsx`） | 删 `getContextCompressionCommand` 函数（`:238-240`，恒返回 `"/compact"`）、删 `onSendCompressionCommand?` / `compressionDisabled?` 两个 props（`:264-265`） | — |
| `display.tsx` | re-export 从 3 名单变 2 名（`:46`） | `getContextCompressionCommand` 导出链全断 |

**孤儿检查实测**：`git grep -n "onSendCompressionCommand|compressionDisabled|getContextCompressionCommand" aba59a9 -- .` → **0 命中**。

**中间层是否留孤儿 prop**：4 个文件的 prop 声明、解构、透传、依赖数组四处**同步摘除**，未见单点遗漏（`ConversationComposer` 的依赖数组 `:1940` 明确摘了 `onSendCompressionCommand`）。

### 1.3 mention 图标 / TID / pendingCommand 零残留

| 项 | 实测 |
|---|---|
| `COMPACT_COMMAND_MENTION_ICON_NODE` | `mentionIconDom.ts` 已删（−11 行）；`promptMentionDecoration.ts` 的 `command === "compact"` 三元分支已删（−5 行）。`git grep COMPACT_COMMAND_MENTION_ICON_NODE aba59a9` → **0 命中** |
| `ScrollText` 图标 import | `ConversationUserInputContent.tsx` 的 lucide import 已摘（7→6 个）+ `commandName === "compact"` 分支已删。`git grep -n "ScrollText" aba59a9 -- packages/` → **0 命中**（全仓无其它消费者） |
| 无消费者 TID | `packages/shared/src/test-ids.ts` 删 `TID_CHAT_COMPACT_MARKER` + `TID_CHAT_COMPACT_RETRY_BUTTON`（spec 指定的两条）。注：此文件在**本节点范围外**，仅记录 |
| `pendingCommandRegistry.ts` | 删 `type:"compact"` 枚举成员 + `row.kind==="timelineMarker" && marker.type==="compact"` 的 settled 判定（−6 行）。HEAD 无 `compact` |
| `pendingCommandReplay.ts` | 删 `"compact"` 枚举成员 + `envelope.type === "compact"` 判定（−8 行）。HEAD 无 `compact` |
| `slashCommands.ts` | `V4VisibleSlashCommand` 联合删 `kind:"compact"` 成员 + `commandName==="compact" \|\| "compress"` 解析分支（−7 行）。HEAD 无 `compact` |
| `ModelTrajectoryPaneParts.tsx` | 两个 switch 的 `case "compact"` 已删（−4 行），i18n key `modelTrajectory.source.compact` 双语同步删 |
| `ConversationShareReadonlyTimeline.tsx` | `ReadonlyLabels.markerCompact` 字段 + `case "compact"` + zh/en 两处字面量（"上下文已压缩"/"Context compacted"）全删 |
| `zcodeUiError.ts` | `"Compact failed"` 从泛化错误集合摘除 |
| `zcodeTaskUsageFallback.ts` | 删 `isContextCompressionPrompt` 函数 + `latestUserPrompt` 参数 + `/compact` `/compress` 归一化特判（−16 行） |
| `chatLoadingVisibility.ts` | `work.kind === "compact"` 与 `marker.type === "compact"` 两个判定摘除 |
| `ConversationRowView.tsx` | `TimelineMarkerRowView` 的 `case "compact"` 大块（22 行）+ `MARKER_ARCHIVE_ICON` + `markerOrigin` prop + `useIsOfficeMode` 调用全删；`MarkerDividerRow` 的 `data-origin` 属性摘除 |

### 1.4 UI 包 `compact` 全部命中的归类

`git grep -i -n compact aba59a9 -- packages/ui/src` → **272 处**，逐类归并后：

| 类 | 代表 |
|---|---|
| 布局/密度词 | `density="compact"` / `variant="compact"` / `compactPlaceholder` / `compactLines` / `COMPACT_TODO_THRESHOLD`（workflow 任务折叠）/ `compactDirectoryNode`（文件树 compact 目录）/ `data-composer-compact`（工具条收缩态）/ `CompactLatestValue`（图表 sparkline）/ `compactEmptyStateWithDock` / `WorkflowRunCompactCard` / `ScopedErrorBoundaryVariant` 的 `"compact"` |
| 数字缩写 | `formatCompactTokenNumber` / `formatCompactNumber` / `formatCompactTokenUsage` / `formatSummaryCompactTokenUsage` / `formatCompactCount` / `formatCompactUnits` / `COMPACT_RESULT_MAX_LENGTH` / `COMPACT_ROWS` / `notation:"compact"` / `compactTokenUsageLabel`（contextUsage 内部变量名） |
| 工具调用紧凑态 | `getCompactToolCallStatusMessageId` / `isCompactToolCallRunningState` / `CompactToolCallState`（@zcode/shared 的工具调用展示态，与对话压缩无关） |
| 业务语义（quota/log） | `compactToday`（Coding Plan 配额展示）/ `prepareCompactLogArchive`（反馈日志归档）/ `compactLegacyTaskStopResult` |
| 变量名/字符串清理 | `const compact = value.replace(/\s+/g," ").trim()`（`quotaModelDisplayName`）/ `compactCurrency*`（金额区间正则）/ `compactName`（图标名归一） |
| **i18n 残留文案** | 见 §5.1 —— **3 条孤立 key**（`chat.contextUsage.compress` / `.compressDescription` / `chat.queue.runNow`），仅定义无消费 |

→ 除 §5.1 那 3 条 key 外，`packages/ui` 内**无对话压缩语义残留**。

---

## 2. i18n 现状

### 2.1 压缩 key 零残留复核

**CLI i18n 包（`apps/zcode-cli/packages/i18n`）**

| 原 key 组 | zh-CN 实测 | en-US 同步 | types.ts | HEAD 引用 |
|---|---|---|---|---|
| `status.compactFailed` / `.compacted` / `.compacting` | 3 条已删 | 3 条已删 | 3 条已删 | 0 |
| `transcript.compact.*`（completed/failed/interrupted/retry/retrying/skipped/started） | 7 条已删 | 7 条已删 | 7 条已删 | 0 |
| `cli.help` 中的 `/compact [instructions]` 行 | 已删 | 已删 | — | 0 |

实测：`git grep -i -n compact aba59a9 -- apps/zcode-cli/packages/i18n/` → 仅命中 `help` 文本内的 `omz` 品牌行附近无 compact 残留（见 §2.4）。

**桌面 UI i18n（`packages/ui/src/i18n/locales`）**

| 原 key 组 | 条数（zh） | HEAD |
|---|---|---|
| `chat.contextCompaction.*`（started/retrying/skipped/completed/completedAuto/failed/interrupted/retry） | 8 | 已删（双语同步） |
| `chat.contextOptimization.*`（started/skipped/interrupted/failed/completed） | 5 | 已删（双语同步） |
| `chat.compact.*`（runningBlocked/queued/duplicateBlocked） | 3 | 已删（双语同步） |
| `chat.modelSwitch.contextWindowGuard.*`（title/description/compress/runningBlocked/stillTooLarge） | 5 | 已删（双语同步） |
| `modelTrajectory.source.compact` | 1 | 已删（双语同步） |

共 **22 条**压缩相关 key 全部从双语 locale 删除，且**同时删净引用**（§1.4 的 grep 已验证引用侧 0 命中）。

**连带文案订正**（不是删除，是去压缩语义）：
- `chat.edit.resetConversationAndFiles.unavailable`：en `"...unavailable while compacting or an interaction is pending"` → `"...while an interaction is pending"`；zh `"压缩中或有待处理交互时不能重置文件"` → `"有待处理交互时不能重置文件"`（S28-pre2 提交 `1189755`）

### 2.2 zh/en 键集 parity 实测（双向 diff）

对两份 locale 的**顶层 `"key":` 行**做集合差（脚本口径：逐行 trim 后以 `"` 开头、取 `":` 前的键名）：

```
packages/ui/src/i18n/locales/en-US.ts  → en = 5890 键
packages/ui/src/i18n/locales/zh-CN.ts  → zh = 5889 键

en-only（zh 缺）  = 1 条：settings.memory.viewer.disabled
zh-only（en 缺）  = 0 条
```

**结论**：HEAD 的 zh/en 键集差集为**单向 1 条**（en 多 1 个键），**无 zh 独有键**。

### 2.3 S29 `settings.context.*` 与 S30/B5 面板 key 的双语 parity

**S29 设置分区 30 键**

```
en-US.ts 中 "settings.context.*" 顶层键 = 30
zh-CN.ts 中 "settings.context.*" 顶层键 = 30
en-only 差集 = 空（30 键双语齐备）
```

逐键清单（en/zh 各 30，键名完全一致）：

| 键 | en 值（摘要） | zh 值（摘要） |
|---|---|---|
| `settings.context.title` | Context Management | 上下文管理 |
| `settings.context.description` | 裁剪/折叠/分舱 + 热生效说明 | 同义中文 |
| `settings.context.noWorkspace` | Open a workspace before configuring… | 请先打开一个工作区… |
| `settings.context.loadFailed` | Failed to read the… | 读取…失败。 |
| `settings.context.saved` | settings saved and applied | 已保存并生效。 |
| `settings.context.saveFailed` | Failed to save… Try again. | 保存…失败，请重试。 |
| `settings.context.reset` | Discard changes | 放弃修改 |
| `settings.context.enabled.label` / `.description` | Enable context management / transform 直通语义 | 启用上下文管理 / 直通语义 |
| `settings.context.executeThreshold.label` / `.description` | 含 "Range 20–90" | 含 "取值 20–90" |
| `settings.context.executeThresholdTokens.label` / `.description` / `.placeholder` | 含 "No override" | 含 "不覆盖" |
| `settings.context.protectedTokens.label` / `.description` / `.placeholder` | 含 "Range 4000–1000000" | 含 "取值 4000–1000000" |
| `settings.context.historyBudget.label` / `.description` | 含 "Range 0.05–0.5" | 含 "取值 0.05–0.5" |
| `settings.context.cacheTtl.label` / `.description` | 5m/1h/never | 同义 |
| `settings.context.historianModel.label` / `.description` / `.select` / `.clear` / `.missingHint` | 折叠模型 + provider/model 格式说明 | 折叠模型 + 同义 |
| `settings.context.smartDrops.label` / `.description` | Smart drops / Experimental and off by default | 智能丢弃 / 实验特性，默认关闭 |
| `settings.context.failClosedBlocking.label` / `.description` | Block requests on failure | 故障时阻断请求 |

> **注意**：数值区间文案在 zh/en 两边都硬写进了 description（"20–90"/"取值 20–90"），与 §3.3 的 `MAGIC_CONTEXT_NUMBER_FIELD_SPECS` 是**两份独立常量**，文案与代码无联动（见 §5.4）。

**S30 面板 8 键**

```
en-US.ts 中 "chat.contextUsage.magicContext.*" = 8
zh-CN.ts 中 "chat.contextUsage.magicContext.*" = 8
en-only 差集 = 空
```

键清单：`title` / `budget` / `used` / `compartments` / `dropped` / `cache` / `cacheHit` / `cacheMiss`
（zh 值：Magic Context 预算 / 受保护预算 / 上下文已用 / 压缩分区 / 已丢弃标签 / 注入块缓存 / 命中 / 重建）

**S29 代码引用的既有 key 存在性核对**（防 T-M12 类缺失）：
- `common.retry` → en `:182` "Retry" / zh `:172` "重试" ✅ 双语存在
- `common.save` → en `:189` "Save" / zh `:179` "保存" ✅
- `common.saving` → en `:190` "Saving..." / zh `:180` "保存中..." ✅
- `chat.toolbar.model.manageModels`（`MagicContextSettingsFields.tsx:206` 引用）→ en `:4839` "Manage models" / zh `:4541` "管理模型" ✅ 双语存在
- `settings.modelProvider.connectionMode.startPlanBadge` / `settings.modelProvider.apiKey` / `settings.modelProvider.connectionMode.codingPlan`（Section `:155-162`）→ 既有 key

### 2.4 既有 en-only 缺口现状

| key | en-US | zh-CN | 性质 |
|---|---|---|---|
| `settings.memory.viewer.disabled` | `:2146` "Enable Workspace Memory to view saved memories." | **无** | **BASE 已存在**（`1fa2d0e:en-US.ts:2146`），非 S27/S29/S30/S32 引入；HEAD 亦无任何代码消费该 key |

即：这是**上游遗留的 en-only 缺口**，本轮 S27/S29/S30 未新增任何 en-only 键，S29/S30 新增的 38 键全部双语齐备。

### 2.5 S32 的 `cli.help` / `/ctx-*` 4 条双语落点

**落点文件**：`apps/zcode-cli/packages/i18n/src/locales/en-US.ts:70-73` 与 `zh-CN.ts:70-73`（均在 `cli.help` 模板字符串内，紧跟 `/goal` 行之后）。

**4 条命令逐条对照**：

| 命令 | en-US.ts:70-73 | zh-CN.ts:70-73 |
|---|---|---|
| `/ctx-status` | `Show the Magic Context status snapshot for this session` | `查看当前 session 的 Magic Context 状态快照` |
| `/ctx-reduce <tags>` | `Queue context tags the work ahead no longer needs` | `把后续工作不再需要的上下文 tag 排队回收` |
| `/ctx-expand [range]` | `Recover dropped or compacted context content` | `取回已被丢弃或压缩掉的上下文内容` |
| `/ctx-recomp [range]` | `Trigger one compartment recomputation pass (simplified)` | `触发一次分舱重算（简化版）` |

→ **4 条双语齐备、位置对齐、参数签名一致**（`<tags>` vs `[range]` 一一对应）。`/compact [instructions]` 行在其位删除（en `:59` 附近 / zh 同位置）。

**品牌行同步**：`cli.help` 首行 `zcode ${version}` → `omz ${version}`（en `:10` / zh `:10`）；用法行 `zcode [command] [options]` → `omz [...]`（en `:13` / zh `:13`）；`With no command, zcode opens…` → `omz opens…`（en `:15` / zh `:15`）。

> `/ctx-expand` 的 en 文案 `Recover dropped or compacted context content` 与 zh `取回已被丢弃或压缩掉的上下文内容` 中的 "compacted" 一词：此处指 **magic-context 自身的 drop/折叠语义**（ctx_expand 恢复被 drop 的内容），不是 S27 删除的原生压缩。列此为边界说明，不判定。

---

## 3. S29 设置面质量取证

### 3.1 三文件职责切分

| 文件 | 行数 | 职责（据文件头注释与实测） |
|---|---|---|
| `packages/ui/src/settings/MagicContextSettingsSection.tsx` | 263 | **读写链**：挂载读 RPC → 表单状态 → 保存写 RPC → 用服务端 effective 域回填；分区注册渲染入口 |
| `packages/ui/src/settings/MagicContextSettingsFields.tsx` | 252 | **纯渲染**：字段行集合，不发任何请求 |
| `packages/ui/src/settings/magicContextSettingsForm.ts` | 232 | **纯函数映射**：config ↔ form 双向转换 + 数值边界表 + 模型身份串互转 |

拆分理由（`MagicContextSettingsFields.tsx:4-7` 自述）：文件行数上限 400，拆点选在「总开关之后的全部字段」这条语义边界上。`magicContextSettingsForm.ts:1-19` 自述三条理由（整域覆盖必须显式读改写回 / 边界必须复述 schema / 纯函数可被 node 直接 import dist 产物跑 T-U1）。

### 3.2 受控状态、保存路径、错误处理

**受控状态**（`MagicContextSettingsSection.tsx:70-78`）

| state | 初值 | 用途 |
|---|---|---|
| `loading` | `true` | 读 RPC in-flight |
| `saving` | `false` | 写 RPC in-flight |
| `loadError` | `null` | 读失败文案 |
| `form` | `DEFAULT_FORM`（`:44-54`） | 10 个可编辑字段 |
| `baseConfig` | `null` | **读回的 effective 域基底**（整域替换的写回必须以它为底） |
| `loadVersionRef` | `useRef(0)` | 竞态版本号 |

**`DEFAULT_FORM` 与 schema `.default()` 对齐核对**（`MagicContextSettingsSection.tsx:40-54` 注释声称与 `MagicContextConfigSchema.parse({})` 一致）：

| 字段 | DEFAULT_FORM | schema `.default()`（`schema.ts:146-216`） | 一致 |
|---|---|---|---|
| `enabled` | `true` | `z.boolean().default(true)` `:147` | ✅ |
| `executeThresholdPercentage` | `65` | `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65` `:36/:153` | ✅ |
| `executeThresholdTokens` | `null` | `.optional()` 无 default（`:162`） | ✅（null = 键不存在） |
| `protectedTokens` | `null` | `.optional()` 无 default（`:171`） | ✅ |
| `historyBudgetPercentage` | `0.15` | `DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15` `:43/:179` | ✅ |
| `cacheTtl` | `"5m"` | `.default("5m")` `:185` | ✅ |
| `historianModel` | `""` | `model` optional 无 default + `historian` 整体 `DEFAULT_HISTORIAN_CONFIG`（无 model 键）`:75/:137` | ✅ |
| `smartDrops` | `false` | `.default(false)` `:194` | ✅ |
| `failClosedBlocking` | `true` | `.default(true)` `:200` | ✅ |

**受控更新**：`patch(key, value)`（`:113-118`）走 `setForm(current => ({...current, [key]: value}))`，泛型 `<K extends keyof MagicContextSettingsForm>` 保证类型安全。所有控件均为受控（3 个 Switch 用 `checked={form.x}`，4 个 NumberField 用 `value={form.x ?? ""}`，1 个 Input 用 `value={form.cacheTtl}`，1 个 ModelConfigSelect 用 `normalizedValue={modelPickerValue}`）。

**保存路径**（`handleSave`，`:129-150`）

```
services.zcodeAgentService.updateMagicContextConfig({ workspacePath, config: buildMagicContextConfigFromForm(baseConfig, form) })
  → 成功：setBaseConfig(result.config) + setForm(magicContextSettingsFormFromConfig(result.config, DEFAULT_FORM)) + toast(settings.context.saved)
  → 失败：logger.warn + toast(settings.context.saveFailed)（不抛）
```

保存后**用 CLI 回传的 effective 域回填而非本地草稿**（`:137-140` 注释：schema `.default()` 与未移植键的 strip 只有服务端知道）。

**错误处理矩阵**

| 场景 | UI 表现 | 证据行 |
|---|---|---|
| 无 workspace | 整分区渲染一句 `settings.context.noWorkspace`，不渲染表单 | `:173-179` |
| 读失败 | 表单仍可编辑（保留 DEFAULT_FORM）+ 顶部红色 `settings.context.loadFailed` 条 + 重试按钮（`common.retry`） | `:96-106` + `:193-202` |
| 读竞态 | `loadVersionRef` 版本号不匹配则丢弃响应（`setBaseConfig/setForm/setLoading` 三处均判版本） | `:85/:93/:97/:105` |
| 保存失败 | toast `settings.context.saveFailed`，`saving` 在 finally 复位 | `:142-148` |
| historian 模型缺失 | **不阻断保存**，仅渲染一条说明文案 `settings.context.historianModel.missingHint`；且仅在模型目录加载完成（`!modelSelectionLoading`）时才显示，避免把「还没读到」当「没配」 | `:185` + `Fields.tsx:217-221` |

**按钮可用性**：`canSave = !loading && !saving && targetWorkspacePath.length > 0`（`:124`）；`dirty` 用 `JSON.stringify(buildMagicContextConfigFromForm(baseConfig, form)) !== JSON.stringify(baseConfig)` 全域比对（`:125-127`）；reset/save 均 `disabled={... || !dirty}`（`:240/:251`）。

### 3.3 字段边界 MIN-MAX 与 schema 复述对照表

`MAGIC_CONTEXT_NUMBER_FIELD_SPECS`（`magicContextSettingsForm.ts:223-232`）逐项对照 `apps/zcode-cli/packages/magic-context/src/host/config/schema.ts` 实测：

| 字段 | UI spec（min/max/step） | schema 实测锚点 | schema 约束 | 一致 |
|---|---|---|---|---|
| `executeThresholdPercentage` | 20 / 90 / 1 | `schema.ts:61` `const ThresholdPercentageSchema = z.number().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE)` | `.min(20).max(90)` | ✅（step=1 为 UI 附加，schema 无 `.int()`） |
| `executeThresholdTokens` | 5000 / 2000000 / 1000 | `schema.ts:159` `z.number().min(5_000).max(2_000_000).optional()` + `:161` `.catchall(z.number().min(5_000).max(2_000_000))` | `.min(5000).max(2000000)` | ✅ |
| `protectedTokens` | 4000 / 1000000 / 1000 | `schema.ts:166-171` `z.number().int().min(PROTECTED_TOKENS_MIN).max(1_000_000)`，`PROTECTED_TOKENS_MIN = 4000`（`:46`） | `.int().min(4000).max(1_000_000)` | ✅（`.int()` ↔ step=1000 未在 UI 侧注明） |
| `historyBudgetPercentage` | 0.05 / 0.5 / 0.01 | `schema.ts:177-178` `z.number().min(0.05).max(0.5)` | `.min(0.05).max(0.5)` | ✅（schema 无 `.int()`，step=0.01 为 UI 附加） |

**4/4 边界数值与 CLI schema 精确一致。**

复述约束的处置（`magicContextSettingsForm.ts:214-222` 注释）：UI 层只是「体验」，驱动 `<Input type="number" min max step>` 让用户拿不到必然被拒的输入；**真正的拒绝只发生在 CLI handler 的 `MagicContextConfigSchema.safeParse`**（`magic-context-config.ts` 中抛 `ProtocolRequestError(-32602, ...)`）。

**未被 UI 复述边界的两个自由文本/枚举字段**：
- `cacheTtl`：schema `:184` 是 `z.union([z.string(), z.object({default:z.string()}).catchall(z.string())])` —— **无任何格式校验**，`"5m"/"1h"/"never"` 只是约定；UI 用 `type="text"` + `placeholder="5m"`（`Fields.tsx:172-180`），无枚举/pattern 约束
- `historianModel`：`z.string().trim().min(1).optional()`（`schema.ts:70-75`）—— 只挡空串，不校验 `provider/model` 是否真的存在

### 3.4 read-before-update 防抹字段逻辑

**问题前提**（`magicContextSettingsForm.ts:5-9` 自述）：S23 的 RPC 是**整域替换**而非 partial patch，UI 只提交编辑过的字段会静默抹掉其余字段。

**读侧**（`magicContextSettingsFormFromConfig`，`:77-104`）：把 RPC result 的 `config`（unknown）收敛成 10 字段表单；per-model 复合形态（`number | {default, [model]: number}`）只取 `default` 分支（`readPercentageDefault:57-61` / `readTokensDefault:64-67` / `readCacheTtlDefault:70-74`）。

**写侧**（`buildMagicContextConfigFromForm`，`:115-170`）：

| 保障 | 实现 | 行 |
|---|---|---|
| 未编辑键原样带回 | `const next = { ...previous, ...9 个编辑字段 }` | `:124-138` |
| per-model 对象的**其它模型键保留** | `isRecord(previousThreshold) && "default" in previousThreshold ? { ...previousThreshold, default: form.x } : form.x` | `:127-130`（threshold）/ `:132-135`（cacheTtl）/ `:142-143`（tokens） |
| 可选数字留空 → **删键**而非写 null | `z.number().optional()` 不接受 null，故 `delete next.execute_threshold_tokens` / `delete next.protected_tokens` | `:140-152` |
| historian 元数据保留 | `next.historian = { ...previousHistorian, model }`（只改 model 键，temperature/top_p/prompt/tools/permission/two_pass 等原样带回） | `:158-161` |

**historian 模型清空语义（S29 修过的 bug，现状）**

`magicContextSettingsForm.ts:154-167` 的三分支：

```ts
const previousHistorian = isRecord(previous.historian) ? previous.historian : {};
const model = form.historianModel.trim();
if (model) {
  next.historian = { ...previousHistorian, model };                 // 有值：只改 model
} else if ("model" in previousHistorian) {
  const { model: _dropped, ...rest } = previousHistorian;
  next.historian = rest;                                              // 清空：删 model 键，保留其它元数据
} else {
  next.historian = { ...previousHistorian };                          // 本来就没 model：原样
}
```

注释（`:155-157`）明确说明这是修过的坑：
> 「空值必须**删键**而不是写 "" 或留旧值——`z.string().trim().min(1).optional()` 拒绝空串，而保留旧值会让「清空」这个操作静默失效（用户点了清空却什么都没变，下一次保存又把旧模型写回 config.json）。」

→ **删键（而非写 "" 或保留旧值）的处置在 HEAD 仍在位**；`historian` 元数据在清空时仍被保留。

**UI 侧触发清空的入口**：`MagicContextSettingsFields.tsx:198-205` 的 `footerActions` 有一个 `key:"historian-model:none"` 的动作，`onSelect: () => patch("historianModel", "")`，`selected: form.historianModel.trim().length === 0`。

**服务端侧对称保障**：`magic-context-config.ts` 的 `updateMagicContextConfig` 回 `config: parsed.data`（effective 域，非 `params.config` 原样），UI 保存后立即用它回填（Section `:139-140`）。

**存疑点**：读 RPC 在有活跃 session 时走 `configPort.get(ConfigKey.MagicContext)`（已注册值，键进内存的是 `.default()` 解析结果），无 session 时走 `loadFileConfig` + `MagicContextConfigSchema.parse(...)`。两条路径返回的都是 effective 域，但**若 ConfigPort 里的值是 strip 之前的旧形状**（例如经由其他写入口），UI 拿不到被 strip 的键 —— 这一点在代码注释里有交代（`magic-context-config.ts` read 函数注释），未见测试覆盖。

---

## 4. S30 面板数据流

### 4.1 全链路（生产侧 → 投影 → 协议 → UI）

```
① 宿主读      bootstrap/src/app/magic-context-usage-summary.ts:50
                 readMagicContextUsageSummary(db, sessionId) → { usage: SessionMagicContextUsage | null }
② 推送触发    bootstrap/src/app/magic-context-turn-transform.ts:806-815
                 publishUsageSummary()（② 个时机：pass 成功 / provider usage 落库）
                 → options.usageRecorder?.onUsageRecorded(publishUsageSummary)  :815
                 ⚠ 不 await（注释：UI 用量面板必须永远不等一次 sqlite 读）
③ 投影写      bootstrap/src/zcode-protocol-v4/product-projection.ts:743
                 applyMagicContextUsage(usage|null|undefined) → ConversationDelta[]
④ 协议扇出    bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts:588
                 const deltas = this.projection.applyMagicContextUsage(usage)
⑤ UI prop     snapshot.usage.magicContext
                 → ConversationComposer.tsx:1853  composerUsage = snapshot?.usage ?? null
                 → :1875  usage={composerUsage}
⑥ 工具条      v4/composer/V4ComposerToolbar.tsx:335 usage: SessionUsageState | null
                 → :997  magicContext={usage?.magicContext ?? null}
⑦ 面板        chat-input-toolbar/contextUsage.tsx:829 buildMagicContextUsageRows({ labels, locale, magicContext })
⑧ 渲染        contextUsage.tsx:1015-1040  magicContextRows.length > 0 ? <div>…</div> : null
```

**测试锚点**：`bootstrap/scripts/test-magic-context-usage-projection.mjs` 覆盖 ①③④（`:235/:271/:286` 读路径、`:168-208` 投影缺席/吸收/清除语义）与 ⑦（`:81/:303` 直接 import UI dist 的 `buildMagicContextUsageRows`）。

### 4.2 「字段缺席 = 整段不渲染」的三重保障

**保障 A — 纯函数返回空数组**（`magicContextUsageRows.ts:59-61`）

```ts
export function buildMagicContextUsageRows({ labels, locale, magicContext }: MagicContextUsageRowInput): MagicContextUsageRow[] {
  if (!magicContext) {
    return [];
  }
```

`magicContext` 的类型是 `SessionMagicContextUsage | null | undefined`（`:41`），注释明写「缺席 = magic-context 关着 / 宿主还没读到读数 ⇒ 返回 `[]` ⇒ 整段不渲染」。

**保障 B — 组件条件渲染**（`contextUsage.tsx:1018`）

```tsx
{magicContextRows.length > 0 ? (
  <div aria-label={…title} className={cn("space-y-1.5", (renderableTaskUsage || hasCodingPlanUsageRemaining || hasStartPlanBalance) && "border-t border-border pt-3")} data-testid={TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT}>
```

- 段容器带 `data-testid`（`chat-context-usage-magic-context`，`packages/shared/src/test-ids.ts:480`，S30 新增）+ `aria-label`
- 上边框**条件化**：只有当上下文面板还有其它段时才加分隔线，独段时不画孤立横线
- `magicContextRows` 用 `useMemo` 缓存，deps `[intl, locale, magicContext]`（`:829-848`）

**保障 C — 面板整体早返回纳入新段**（`contextUsage.tsx:846-850`）

```tsx
if ((!renderableTaskUsage || !contextUsageLabel) && !hasCodingPlanUsageRemaining && !hasStartPlanBalance && magicContextRows.length === 0) {
  return null;
}
```

→ 即：**magic-context 是唯一有话说的一段时，整个触发器也要渲染**（注释 `:1013-1015`：provider 窗口还没建起来时它照样有话说，而那正是「为什么我的上下文被裁了」最需要被看见的时刻）。

**缺席语义的源头约定**（`magic-context-usage-summary.ts:19-25` + `product-projection.ts:404-410`）：宿主 `readMagicContextUsageSummary` 返回 `null` ⇒ 投影层**删掉整个 `usage.magicContext` 键**（不是写 `undefined`，注释解释：JSON 序列化后虽同样消失，但内存里会让 `usage.magicContext !== undefined` 判据说谎）；全零对象被明确否决（「那比不显示更坏」）。

### 4.3 5 行渲染内容与「不知道 vs 零」语义

`buildMagicContextUsageRows` 返回固定 5 行（`magicContextUsageRows.ts:66-108`）：

| row.id | label key | 值语义 |
|---|---|---|
| `budget` | `…magicContext.budget` | `budgetTokens === null ? "—" : formatTokens(...)` |
| `used` | `…magicContext.used` | `formatTokens(usedTokens) (percent)`，`usedPercent/100` 后交给 `Intl` percent 风格 |
| `compartments` | `…magicContext.compartments` | `numberFormatter.format(compartmentCount)` |
| `dropped` | `…magicContext.dropped` | `format(droppedTagCount) (formatTokens(droppedTagTokens))` |
| `cache` | `…magicContext.cache` | `cache === null ? "—" : "m[0] {hit/miss} · m[1] {hit/miss}"` |

**「不知道 ≠ 零」的显式设计**（文件头注释 `:52-56` + `UNKNOWN = "—"` `:34`）：
- `budgetTokens` 为 null（读不到）→ 破折号
- `cache` 为 null（迁移前的库缺列）→ 破折号，而非「都没命中」；宿主侧 `readInjectedBlockCache`（`magic-context-usage-summary.ts:86-101`）在 `row` 不存在或两列 `undefined` 时返回 `null`（catch 也 `null`）
- `protected floor` **不与 usedTokens 拼成 used/total**（`:58-60` 注释：「那会凭空造出一把不存在的尺子」）

**`cache` 的三态判定**（宿主侧 `isCachedBlock`，`magic-context-usage-summary.ts:104-109`）：SQLite BLOB `null` → false；零长 `Uint8Array` → false；`number > 0` → true；其它 → false。

**conflation（避免高频空 patch）**（`product-projection.ts:414-425` + `:734-745`）：`sameMagicContextUsage` 逐字段相等（含 `cache?.m0` / `cache?.m1`）时 `applyMagicContextUsage` 返回 `[]`，不下发 delta。注释：`usage` 是本投影里最高频的键之一，无变化的下发会把 delta 日志灌满。

### 4.4 `seedUsage` 不 clobber 修复现状

**修复点**（`product-projection.ts` S30 diff，两处）：

```ts
// seedUsage 第一条分支（约 :695）
...magicContextUsageField(current.magicContext),
// 注释：冷恢复种子只管 token 水位，不得顺手抹掉已经下发的 magic-context 摘要（D-13）。

// seedUsage 第二条分支（约 :719）
...magicContextUsageField(current.magicContext),
// 注释：同上：另一条种子路径也不许顺手抹掉 magic-context 摘要（D-13）。
```

`magicContextUsageField` 的形态是**显式 spread 而非赋 undefined**（`:404-410`）：
```ts
function magicContextUsageField(usage: SessionMagicContextUsage | undefined): { magicContext?: SessionMagicContextUsage } {
  return usage === undefined ? {} : { magicContext: usage };
}
```

→ **HEAD 该修复仍在位**（`git show aba59a9:…/product-projection.ts` 可见两处 spread 均存在）。

**相关 seed 调用点**（3 处，全在 `v4-gateway.ts`）：
- `:3018` `if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed)`
- `:3252` `if (loadedSeed) publisher.seedUsage(loadedSeed)`
- `:3259` `if (seed) publisher.seedUsage(seed)`

**测试覆盖**：`test-magic-context-usage-projection.mjs:205-208` 断言 `applyMagicContextUsage(SAMPLE)` 后再 `applyConversationDeltas`，随后 `applyMagicContextUsage(null)` 的 delta 应用后 `usage.magicContext` 键被移除。

### 4.5 V4ComposerToolbar 透传的形态

`V4ComposerToolbar.tsx:335` `usage: SessionUsageState | null`（**必填**，非可选）→ `:370` 解构 → `:997` `magicContext={usage?.magicContext ?? null}`。

即：**空值统一在 toolbar 层归一为 `null`**（而不是让 `ChatContextUsage` 处理 `undefined`），`ChatContextUsage` 的 prop 声明为 `magicContext?: SessionMagicContextUsage | null`（`contextUsage.tsx:256`，可选 + 可空）—— 宽松于实际调用，属兼容写法。

`ChatContextUsage` 同时新增了 `data-usage-used` / `data-usage-max` 之外的 e2e 契约属性保持不变（`V4ComposerToolbar.tsx:990-991`）。

---

## 5. 可疑点清单

> 全部为「摆事实 + 为什么可疑」，不含判定。每条给 `file:line`。
> 「S27 引入 / S29 引入 / S30 引入 / 既有」标注该可疑点由哪一步带入。

### 5.1 S27 引入 —— 3 条孤立 i18n key（零消费点）

| key | 定义位置 | 引用实测 |
|---|---|---|
| `chat.contextUsage.compress` | `packages/ui/src/i18n/locales/en-US.ts:4730` / `zh-CN.ts:4429` | **全仓 0 引用** |
| `chat.contextUsage.compressDescription` | `en-US.ts:4731` / `zh-CN.ts:4430` | **全仓 0 引用** |
| `chat.queue.runNow` | `en-US.ts:4680` / `zh-CN.ts:4382` | **全仓 0 引用** |

**为什么可疑**：
- 这 3 条正是 `getContextCompressionCommand` / `onSendCompressionCommand` / `compressionDisabled` 这条死链**唯一的 UI 文案载体**。spec 的 i18n 清理条目（`chat.contextCompaction.*` / `chat.contextOptimization.*` / `chat.compact.*`）列全了，唯独漏了 `chat.contextUsage.compress*` 这一组 —— 而 S27 把消费它的 prop 摘了，文案留下了。
- `chat.contextUsage.compressDescription` 的值是 `"Send {command} to compress the current context"` / `"发送 {command} 压缩当前上下文"`，**`{command}` 占位符**指向已删除的 `getContextCompressionCommand()` 恒返回的 `"/compact"`。文案本身含明确的压缩指令语义。
- `chat.queue.runNow`（"Run now" / "立即"）原唯一消费点是 `ConversationQueuePanel.tsx` 的 `intl.formatMessage({ id: isCompact ? "chat.queue.runNow" : "chat.queue.sendNow" })`，S27 改为恒 `chat.queue.sendNow`，旧 key 成了孤儿。
- `zh-CN.ts:4381` 还留着一行**陈旧注释**提到被删语义：`// compact 队列项曾单独显示"立即执行"，与同一队列中的即时动作文案不一致。`

**关联事实**：这 3 条 key 都在 `packages/ui` 自身的双语 locale 内，不影响 CLI i18n 包（后者已实测零残留）。

### 5.2 S29 引入 —— 4 处 knip 判定的未用导出

`.s34-knip.txt`（S34 提交跑的 knip）实测把以下 4 条判为 `Unused exports` / `Unused exported types`，且 **BASE 的 knip 基线 `p1-knip-baseline.txt`（408 条）中没有它们**：

| 符号 | 位置 | knip 判定 | 为何可疑 |
|---|---|---|---|
| `NO_HISTORIAN_MODEL_VALUE` | `packages/ui/src/settings/magicContextSettingsForm.ts:183` | Unused exports | `export const`，但**只在本文件内被 `:187` / `:199` 两处消费**，包外 0 引用 |
| `MagicContextNumberFieldSpec` | `magicContextSettingsForm.ts:208` | Unused exported types | `export interface`，只被同文件 `:232` 的 `satisfies` 用作约束，无外部消费者 |
| `MagicContextUsageRow` | `packages/ui/src/chat-input-toolbar/magicContextUsageRows.ts:25` | Unused exported types | `export interface`，只作为同文件 `:63` 的返回类型 |
| `MagicContextUsageRowInput` | `magicContextUsageRows.ts:34` | Unused exported types | `export interface`，只作为同文件 `:63` 的参数类型 |

**为什么可疑**：两个新文件的模块头注释（`magicContextSettingsForm.ts:14-18`、`magicContextUsageRows.ts:14-18`）都明确说「纯函数可被 CLI 侧测试直接加载 dist 产物」—— 但实测两套 bootstrap 测试脚本（`test-magic-context-ui-config.mjs:79`、`test-magic-context-usage-projection.mjs:81`）**只 import 函数，不 import 类型**。即：这 3 个 interface 的 `export` 是为「将来」预留的，当前无消费者。

**规模核对**：S34 实测 `Unused exports (411)` / 基线 `Unused exports (408)` → **净 +3**。同批净变化里，本范围贡献 4 条新增、同时移除 2 条 S27 遗留（`getContextCompressionCommand` × 2，见基线文件），其余为范围外增减。此处只陈述计数，不判定是否越过 spec 的「issue 不高于基线且无新引入项」口径（**该口径需要 review 节点按完整 knip 输出核对**）。

### 5.3 S29 引入 —— 数值输入框无可访问名称（a11y）

| 控件 | file:line | 现状 |
|---|---|---|
| 4 个 `NumberField`（executeThresholdPercentage / executeThresholdTokens / protectedTokens / historyBudgetPercentage） | `MagicContextSettingsFields.tsx:52-71`（Input 渲染）、`:105-165`（4 处使用） | `<Input type="number" min max step>` **无 `aria-label`、无 `id`**，且 `SettingsRow` 的 `label` 是纯 `<div>`（`SettingsPageParts.tsx` 的 `SettingsRow` 里 label 渲染为 `<div className="text-ui-base font-medium text-foreground">{label}</div>`，**不是 `<label>`，也无 `htmlFor` 关联**） |
| `cacheTtl` 自由文本 Input | `MagicContextSettingsFields.tsx:172-180` | 同上，**无 aria-label**，仅有 `placeholder="5m"`（硬编码字面量，未走 i18n） |
| `historianModel` 的 `ModelConfigSelect` trigger | `MagicContextSettingsFields.tsx:190-213` | 传了 `triggerLabel`（可见文字），但未传 `aria-label` |
| 3 个 `Switch`（enabled / smartDrops / failClosedBlocking） | `Fields.tsx:230` / `:244` / `MagicContextSettingsSection.tsx:214` | **有 `aria-label`** ✅ |
| 分区说明文字 `<p>` | `MagicContextSettingsSection.tsx:175-177` | 纯文本段落，无 `role`（可接受） |

**为什么可疑**：3 个 Switch 有 `aria-label`、5 个输入类控件没有 —— 同一文件内 a11y 处理不一致。读屏用户听到的 5 个输入框只有「编辑框」角色，读不出是「执行阈值」还是「历史预算占比」。

**参照对比**：`MemorySettingsSection.tsx`（既有分区）全文只有 1 处 `aria-label`（`:160`）；`SubagentsSection.tsx` 有 3 处（`:563/:1082/:1230`）。即整个设置页的输入类 a11y 覆盖率本就不高，**S29 沿用了既有 `SettingsRow` 范式而非更差**。

### 5.4 S29 引入 —— 数值边界「三处独立常量」无联动

同一组 MIN-MAX 在三个地方各写一遍：

| 位置 | 形态 |
|---|---|
| `apps/zcode-cli/packages/magic-context/src/host/config/schema.ts:61/:159/:169-170/:177-178` | zod 约束（**权威**） |
| `packages/ui/src/settings/magicContextSettingsForm.ts:223-232` `MAGIC_CONTEXT_NUMBER_FIELD_SPECS` | UI 输入框 min/max/step |
| `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` 的 `settings.context.executeThreshold.description` / `.protectedTokens.description` / `.historyBudget.description` | **文案里硬写的数字**："Range 20–90" / "取值 20–90"、"Range 4000–1000000" / "取值 4000–1000000"、"Range 0.05–0.5" / "取值 0.05–0.5" |

**为什么可疑**：schema 改动时，`MAGIC_CONTEXT_NUMBER_FIELD_SPECS` 有测试锚点可挂（`test-magic-context-ui-config.mjs` 已覆盖 form 映射），但**i18n 文案里的数字没有任何自动化校验** —— 上游改 schema 上下界，UI 输入框会跟着变（因为 spec 是常量），而 description 文案里的 "20–90" 会静默过期。这是 spec L1 同步改动的典型漏点。

**已核对的缓解事实**：4/4 数值当前与 schema 精确一致（见 §3.3）。

### 5.5 S29 引入 —— `type="number"` 的浏览器原生约束可被绕过

`MagicContextSettingsFields.tsx:63-70` 的 onChange：

```tsx
onChange={(event) => {
  if (props.inputMode === "decimal") {
    const next = Number(event.target.value);
    if (Number.isFinite(next)) props.onChange(next);
    return;
  }
  props.onChange(parseOptionalNumber(event.target.value));
}}
```

`parseOptionalNumber`（`:26-31`）只做 `Number(trimmed)` + `Number.isFinite`，**不校验 min/max**。

**为什么可疑**：`<Input type="number" min max>` 在多数浏览器里只影响步进器与表单校验，**不阻止用户键入超界值**（也允许用 spinner 之外的路径）。因此越界值可以进 `form` 状态：
- `dirty` 计算会显示「有改动」，save 按钮可点
- 真正的拒绝发生在 CLI 的 `-32602`（`magic-context-config.ts`），UI 侧只 toast 一句 `settings.context.saveFailed`
- 而 `settings.context.saveFailed` 的文案是 `"Failed to save the context management configuration. Try again."` / `"保存上下文管理配置失败，请重试。"` —— **不含服务端返回的具体越界字段名**，用户无从知道是哪个字段超界

文件头注释（`magicContextSettingsForm.ts:220-222`）自述这一层是「体验，不是第二份真相」，即**有意只做软约束**。此处只摆事实：软约束 + 粗粒度错误文案 = 用户拿不到「哪个字段越界」的信息。

**附带事实**：两个必填数字字段（percentage / historyBudget）的 onChange 带 `if (value !== null)` 守卫（`:116/:163`），即**清空输入框不生效**（`type="number"` 清空时 `value === ""` → `parseOptionalNumber` 返回 null → 被守卫吞掉），输入框会立即被受控值弹回；用户看不到「留空」的中间态。这是有意设计还是遗漏，未见注释说明。

### 5.6 S29 引入 —— 硬编码字面量绕过 i18n

| file:line | 字面量 | 上下文 |
|---|---|---|
| `MagicContextSettingsFields.tsx:175` | `placeholder="5m"` | cacheTtl 输入框，**未走 `intl.formatMessage`**，而同文件其它 placeholder（`:125-127` executeThresholdTokens、`:140` protectedTokens）都走了 i18n |
| `MagicContextSettingsFields.tsx:24` | `const MODEL_ITEM_NEVER_LOCKED = () => false;` | 非文案，无问题 |
| `MagicContextSettingsFields.tsx:195-196` | `showManageModelsAction={false}` / `lockReasonMessage=""` | 传空串占位（`lockReasonMessage=""` 是个空的可访问性文案槽位） |
| `MagicContextSettingsSection.tsx:215/242/253` | `data-testid="magic-context-*"` | 测试锚点，非文案 ✅ |
| `MagicContextSettingsSection.tsx:41-43`（注释） | `(65 / 0.15 / "5m" / true / true / false)` | 与 schema 默认值重复书写的注释常量 |

**为什么可疑**：`placeholder="5m"` 是**用户可见文案**，而同一 `<SettingsRow>` 的 label / description 都走了 i18n；`cacheTtl` 的 description 里已经解释了 "e.g. 5m or 1h"（i18n），placeholder 又硬写一遍英文/数字格式串。中文语境下 placeholder 无本地化（数值格式本身语言中性，影响有限）。

### 5.7 S30 引入 —— 面板段的「零状态」表达

`magicContextUsageRows.ts:34` `const UNKNOWN = "—"`（em dash，**硬编码符号，未走 i18n**）。

**为什么可疑**：同一文件里 7 个 label 全部由调用方注入（`MagicContextUsageRowInput.labels`），唯独「不知道」的呈现符号是模块内硬编码。若某 locale 需要不同的占位符（如 "N/A" / "未知"），需要改这个模块而非 locale 文件。同理 `contextUsage.tsx:108` 的 cache 行模板 `m[0] {hit} · m[1] {hit}` 里的 `m[0]` / `m[1]` / `·` 分隔符也是硬编码拼进 value 字符串（`magicContextUsageRows.ts:104-107`）。

### 5.8 S30 引入 —— `buildMagicContextUsageRows` 的参数形态与调用点不一致

| 侧 | 形态 |
|---|---|
| 定义 | `MagicContextUsageRowInput.labels` 是 **7 个具名 string 字段**（`:37-45`），`magicContext` 可空 |
| 调用（`contextUsage.tsx:829-848`） | 逐个 `intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.xxx })` 填充 |
| 测试（`test-magic-context-usage-projection.mjs:303`） | 传 `LABELS` 常量 |

**为什么可疑**：`contextUsage.tsx:159-167` 另有一份 `MAGIC_CONTEXT_ROW_LABEL_IDS` 的 7 项 `as const` 映射，与 `MagicContextUsageRowInput.labels` 的 7 个字段名**手工对齐**（`budget/cache/cacheHit/cacheMiss/compartments/dropped/used`）。两份 7 元结构靠字段名隐式配对，无类型层面的编译期约束保证不漏项 —— 若 `labels` 新增一项而 `MAGIC_CONTEXT_ROW_LABEL_IDS` 未加，`buildMagicContextUsageRows` 不会报错，只是该行不显示。

### 5.9 S30 引入 —— 后台订阅无反注册（内存泄漏观察点）

| file:line | 事实 |
|---|---|
| `bootstrap/src/app/magic-context-turn-transform.ts:258` | `onUsageRecorded: (listener: () => void) => void;` —— **返回 void，无取消订阅接口** |
| `:273` | `const recordedListeners: Array<() => void> = [];` |
| `:297-299` | `onUsageRecorded: (listener) => { recordedListeners.push(listener); }` —— 纯 push |
| `:815` | `options.usageRecorder?.onUsageRecorded(publishUsageSummary);` |
| `:286-294` | `notifyRecorded()` 遍历调用，异常吞掉 |

**为什么可疑（**观察点，非定论**）**：`recordedListeners` 只增不减，且 `createMagicContextUsageRecorder` 在 `create-app.ts:782` 按 **sessionId** 创建（每 session 一个 recorder）、`createMagicContextTurnTransform` 也按 session 创建一次。若这两者同为「每 session 一次」，则 listener 数组长度为 1，不构成增长；若存在同一 recorder 被多次 `createMagicContextTurnTransform` 的路径（例如 turn 重试 / fork 复用 session），listener 会累积。**代码中未见 `off`/`dispose` 之类的对偶接口，也未见 dispose 调用点** —— 列出供 review 核对 `createMagicContextTurnTransform` 的实际调用次数。

**对照**：`magic-context-turn-transform.ts:821-829` 的 `bridge.onChange(...)`（ConfigPort 热生效订阅）同样是 push-only 无反注册，同一模式。

### 5.10 S30 引入 —— `formatCompactTokenNumber` 的 locale 参数两处不同源

| 调用点 | 传参 |
|---|---|
| `magicContextUsageRows.ts:71` | `formatCompactTokenNumber(locale, value, { maximumFractionDigits: 1 })` |
| `magicContextUsageRows.ts:71` 邻近 `:68-70` | `new Intl.NumberFormat(locale)` + `new Intl.NumberFormat(locale, {maximumFractionDigits:1, style:"percent"})` |
| 既有 `contextUsage.tsx:93` | `formatCompactTokenNumber(locale, value, options)` |

**为什么可疑（弱）**：同一个 value 字符串里，`formatTokens()` 走 `formatCompactTokenNumber`（走 `@zcode/shared` 的本地化 compact 口径），而 `compartments` / `droppedTagCount` 走裸 `Intl.NumberFormat(locale)`（标准口径）。两条口径对同一 locale 的大数缩写形态**可能不同**（`formatCompactTokenNumber` 注释 `tokenNumberFormat.ts:13` 说「中文展示万/亿，英文展示 K/M/B」）。同一行的两个数字可能呈现不同风格。列为观察点。

### 5.11 S32 引入 —— 品牌跟随的覆盖面不完整

| 类 | 实测 |
|---|---|
| 已跟随（路径/目录/插件 id） | `.zcode/cli` → `.omz/cli`（`mcpStore.ts:254` 注释、`TaskActionMenuContent.tsx:188` 注释、`skillSourceFilter.ts:7/:11` 路径匹配、`OnboardingDialog.tsx:320` `~/.omz/AGENTS.md`、`useSavedWorkflowGlobalGroup.ts:99` / `useSavedWorkflowsDirectoryWatch.ts:20/:62` 注释）、`zcode-plugins-official` → `oh-my-zcode-official`（`builtinSkillI18n.ts:28-29`、`pluginIconSource.ts:10-15`、`BrowserSettingsSection.tsx:29`、`pluginCreatorPrefill.ts:6`、`featureSuggestedPrompts.ts` 全文） |
| 已跟随（i18n 数据目录文案） | `settings.dataBaseDirDescription`：`.zcode/v2` → `.omz/v2`（en `:2308` / zh `:2171`） |
| **未跟随：`.zcodeignore` 文件名** | `packages/ui/src/i18n/locales/{en-US.ts:4347/:4349/:4360, zh-CN.ts:4071/:4073/:4083}` 3+3 处仍写 `.zcodeignore`；代码侧 `settingsNavigation.ts` / `settingsPageConfig.ts` / `WorkspaceFileSearchSection.tsx`(6 处) / `services/src/file/{file,fileService,workspaceFileIgnore,workspaceFileMentionFilter}.ts` 共 10 文件仍用 `zcodeignore`。`git grep -c omzignore` → **0 命中**（未改名） |
| **未跟随：产品名 `ZCode` 文案** | zh-CN locale 内 **约 25 处** `ZCode` 字样（如 `:13` occupationOnboarding、`:158` computerUse.disabledToast "重启 ZCode 后生效"、`:2147-2151` settings.zcodeInteractionBehavior、`:3386-3387` sidebar.usage.plan.zcodeMcp、`:3987` settings.commands.source.zcodeAgent、`:4137` settingsSync.agent.zcode、`:5708/:5710` `zcode.error.*`） |
| **未跟随：key 名本身** | `settings.zcodeInteractionBehavior*`（4 键）、`sidebar.usage.plan.zcodeMcp*`（2 键）、`settings.commands.source.zcodeAgent`、`settingsSync.agent.zcode`、`zcode.error.*`（2 键）—— key 名含 `zcode` 但 value 已改或未改 |

**为什么可疑**：spec D-10 把改名分层为 L1（bin/npm name/数据目录/marketplace id/安装产物名/README）/ L2（`ZCODE_*` env / `@zcode/*` scope / `.zcode-plugin/`）/ L3（协议标识 / DB schema / 类型名）。**`.zcodeignore` 与产品名 `ZCode` 未被 spec 明确归入 L1/L2/L3 任一层** —— 现状是「路径类已改、产品名与 ignore 文件名未改」。`.zcodeignore` 的一致性风险在于：`services/src/file/workspaceFileIgnore.ts`(6 处) 与 UI 文案(6 处) 共 10 文件仍在用同一旧名，**当前是自洽的**，但若将来按 L1 改名，10 文件需同步。

**未在本范围**：`.zcode-plugin/` 目录名、`@zcode/*` scope、`ZCODE_*` env、`zcode-protocol*` / `zcode-artifact://` / DB schema / 类型名 —— 按 D-10 属 L2/L3 不动，**本包不作核对**。

### 5.12 S27 引入 —— `getRenderableTaskUsage` re-export 仍是无消费者（既有，非本轮引入）

`packages/ui/src/chat-input-toolbar/display.tsx:46` 仍 re-export `getRenderableTaskUsage`；全仓消费点只有 `contextUsage.tsx:311` 的**同文件内部调用**（导入路径 `@/chat-input-toolbar/contextUsage.js`，不经 `display.tsx`）。

**为什么可疑（弱）**：`display.tsx` 的这条 re-export 无任何外部消费者，是 knip 基线里已登记的条目（`p1-knip-baseline.txt` 两条：`display.tsx:49:3` + `contextUsage.tsx:203:17`）。**BASE 就存在**（`1fa2d0e` 同样的两行），S27 只是删掉了同一条 re-export 语句里的第三个名字（`getContextCompressionCommand`），顺带使该行号从 `:49` 移到 `:46`。故**非本轮引入**。

---

## 7. 本包未覆盖 / 需其他节点核对的项

| 项 | 原因 |
|---|---|
| `packages/shared/src/test-ids.ts` 的 2 个 TID 删除 | 该文件在**本节点范围外**（§1.3 仅记录） |
| `packages/services/**` 的 `zcodeAgentService.readMagicContextConfig` / `.updateMagicContextConfig` 客户端方法实现 | 范围外（§3/§4 只按调用点取证） |
| knip 是否越过 spec 口径（`issue ≤ 基线 408 且无 Phase 1 新引入项`） | §5.2 只给了本范围贡献的计数，完整核对需 review 节点按全量 knip 输出比对 |
| T-U1 端到端（UI 改 → config.json 落盘 → 不重启生效） | 属 manual 验收，本包只做静态取证 |
| T-U2（面板显示 magic-context 状态） | 属 manual 验收；本包核对了渲染条件与缺席语义（§4.2）与测试锚点存在 |
| 上游 `.reference/ZCode` 对照 diff | 不在本节点范围 |
