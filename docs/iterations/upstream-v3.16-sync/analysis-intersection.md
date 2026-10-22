# 上游 v3.15.1 → v3.16.2 同步：fork ∩ 上游交集文件处置分析

> 分析对象：`docs/iterations/upstream-v3.16-sync/fork-upstream-intersection.txt`（378 个「fork 改过 ∩ 上游 v3.15.1→v3.16.2 也改过」的文件）
> 参照：上游 v3.15.1 = `aac47556`，上游 v3.16.2 = `3c5b2276`，fork 根 = `baseline/v3.14.3`，fork HEAD = `14032fea`（分支 `trace-nm-borrow`）
> 方法：对每个文件同时取 `git diff baseline/v3.14.3..HEAD -- <file>`（fork 改了什么）与 `git diff aac47556..3c5b2276 -- <file>`（上游改了什么），
> 并用 `git merge-file` 以「上游 v3.15.1 为 base / fork HEAD 为 ours / 上游 v3.16.2 为 theirs」做三方合并，客观测冲突块数；
> 再按文件在双方树中的存在性与内容族（遥测 / 原生压缩 / 品牌字面量 / magic-context / 轨迹面板 / 占用面板 / i18n 中文化）人工复核判定。

---

## 0. 一个必须先讲清楚的结构性事实

**fork 从未整体合入上游 v3.15.1。** 这不是推测，是逐文件核对的结论：

| 口径 | 数值 |
| --- | --- |
| fork HEAD 文件树规模 | 7306 个文件 |
| 上游 v3.15.1 文件树规模 | 16880 个文件 |
| 上游 v3.16.2 文件树规模 | 18266 个文件 |
| upstream v3.15.1 相对 v3.14.3 改动的文件 | 11745 个（修改 1894 / 新增 9835 / 删除 15 / 重命名 1） |
| 修改类 1894 个中，fork 完整采用（blob 逐字节等于 v3.15.1） | **18 个** |
| 修改类 1894 个中，fork 部分采用 | 454 个 |
| 修改类 1894 个中，fork 保持 v3.14.3 原样（未采用） | 1221 个 |
| 新增类 9835 个中，fork 侧存在同名文件 | **4 个** |

在本 378 个交集文件里，fork 相对「上游 v3.15.1」的位置分布为：

| fork 相对 v3.15.1 的位置 | 文件数 | 含义 |
| --- | --- | --- |
| 完全等于 v3.15.1 | 1 | 上游 v3.16 补丁可原样重放 |
| 部分采用 v3.15.1 | 3 | 需局部融合 |
| 上游 v3.15.1 未改此文件 | 49 | fork 与 v3.15.1 同基线，v3.16 补丁可原样重放 |
| **未采用上游 v3.15.1 改动（仍是 v3.14.3 底子）** | **237** | **v3.16 补丁即使机械可打，也可能打在错误的基线上** |

推论（决定后续处置口径的三条）：

1. **「低摩擦重放」的上游补丁本身不等于功能到位。** 237 个文件 fork 缺 v3.15.1 的增量。
   典型：`packages/ui/src/app-shell/WorkspaceShellLayout.tsx` 上游 v3.15.1 改了 +2516/-1542，
   fork 至今仍是 v3.14.3 的 1960 行版本（v3.15.1 是 2949 行）；上游 v3.16.2 又把它改成 2799 行。
   只重放 v3.16 的 +2388/-2538 会得到一个既不是 v3.15.1 也不是 v3.16.2 的四不像。
   这 78 个「全量上游增量（v3.14.3→v3.16.2）比 v3.16 增量还大 50 行以上」的文件是本次同步真正的工作量所在。
2. **`git merge-file` 的 CLEAN 结论在 83 个文件上是假阳性**（CLEAN 但 fork 缺 v3.15.1 基线），
   这 83 个文件在下面被单独标为「重放前须先补基线」，不能只看合并是否干净就放行。
3. **上游 v3.16.2 新增 1693 个文件，fork 侧同名文件只有 1 个**（`packages/desktop/scripts/desktop-product-identity.d.mts`，内容已一致）。
   其余 1692 个上游新文件对 fork 无侵入，但其中 `office-runtime` 等是新增运行时能力（见第 3 节）。

---

## 1. 处置统计

| 处置档位 | 文件数 | 占比 | 判据 |
| --- | --- | --- | --- |
| 【丢弃】 | **81** | 21.4% | 上游改动落在 fork 已删除/整改的族上（遥测、原生压缩、品牌字面量），fork 侧该文件已不存在或该面已被整块清空 |
| 【人工适配-分叉】 | **174** | 46.0% | fork 对该文件有实质性自研改动（四 phase 改造、轨迹/占用面板、prompt-language、i18n 中文化等），上游改动需逐段手工融合 |
| 【低摩擦重放】 | **123** | 32.5% | fork 侧基线与上游 v3.15.1 一致（或上游 v3.15.1 未改此文件），上游 v3.16 补丁可原样重放 |
| 合计 | **378** | 100% | |

### 1.1 风险分布

| 档位 / 风险 | 文件数 |
| --- | --- |
| 人工适配 / 中 | 101 |
| 人工适配 / 高 | 73 |
| 丢弃 / 低 | 81 |
| 低摩擦重放 / 中 | 83 |
| 低摩擦重放 / 低 | 40 |

> 「高」风险定义：三方合并冲突块 ≥ 5，或 fork 侧自研残差 ≥ 200 行，或上游改动 ≥ 200 行。

### 1.2 丢弃档的 81 个文件按族归组

| 族 | 文件数 | 代表文件 |
| --- | --- | --- |
| conversation-share（分享族，fork 未启用） | 26 | `packages/services/src/conversation-share/*` |
| oauth / login（登录族，fork 走自有鉴权） | 13 | `packages/services/src/oauth/*`、`packages/web/src/auth/*` |
| offpeak（闲时任务族，fork 已随官方端点全清移除） | 10 | `packages/services/src/session/offPeak*` |
| 原生压缩族 | 7 | `apps/zcode-cli/packages/core/src/compact/*`、`runtime/methods/compact-*` |
| 遥测族 | 6 | `packages/ui/src/lib/messageTelemetry.ts`、`packages/shared/src/telemetry.ts`、`packages/ui/src/v4/telemetry/*` |
| provider-config / 编码方案 | 6 | `packages/ui/src/settings/model-provider-section/use*CodingPlanProducts.ts` |
| feedback 族 | 3 | `packages/ui/src/feedback/*` |
| usage / entitlement 族 | 2 | `packages/ui/src/hooks/useUsageEntitlement.ts` |
| 其他（更新器/崩溃采集/帮助配置/记忆设置等） | 8 | `packages/desktop/src/main/autoUpdater.ts`、`desktopCrashCapture.ts`、`packages/ui/src/WelcomeScreen.tsx`、`packages/ui/src/settings/MemorySettings*` |

**两处需要人工复核的丢弃判**（上游改动确实落在 fork 已清空的遥测面上，但文件本身 fork 还在）：

- `packages/shared/src/zcode-protocol-v4/telemetry.ts` —— 上游 v3.16 只往 `toolLifecycleFactSchema` 加 `skillName`/`pluginId`/`pluginComponent` 字段；
  fork 已把整个 `toolLifecycleFactSchema` 删掉（只留 `turn.started`/`turn.terminal` 两条事实），字段无处落地 → 丢弃。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` —— 上游只加 `skillTelemetryFactFields`/`pluginId` 遥测事实；
  fork 已删该 helper（文件从 700+ 行缩到 152 行）→ 丢弃。

### 1.3 分目录汇总

| 目录 | 总数 | 丢弃 | 人工适配 | 低摩擦重放 |
| --- | --- | --- | --- | --- |
| `packages/ui/src/v4` | 36 | 8 | 15 | 13 |
| `packages/ui/src` | 27 | 4 | 16 | 7 |
| `apps/zcode-cli/packages/core/src/runtime/methods` | 24 | 4 | 12 | 8 |
| `packages/shared/src` | 19 | 4 | 11 | 4 |
| `packages/desktop/src/main` | 16 | 6 | 7 | 3 |
| `packages/ui/src/settings` | 15 | 5 | 4 | 6 |
| `packages/ui/src/root` | 11 | 5 | 5 | 1 |
| `(仓库根)` | 8 | 0 | 8 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app` | 8 | 0 | 3 | 5 |
| `apps/zcode-cli/packages/core/src/tool/handlers` | 8 | 1 | 3 | 4 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol` | 7 | 1 | 4 | 2 |
| `packages/services/src/conversation-share` | 6 | 6 | 0 | 0 |
| `packages/services/src/session` | 6 | 3 | 1 | 2 |
| `packages/services/src/zcode-agent` | 6 | 0 | 4 | 2 |
| `packages/shared/src/zcode-protocol-v4` | 6 | 1 | 1 | 4 |
| `packages/ui/src/lib` | 6 | 2 | 3 | 1 |
| `packages/ui/src/settings/model-provider-section` | 6 | 2 | 1 | 3 |
| `packages/ui/src/store` | 6 | 1 | 2 | 3 |
| `apps/zcode-cli/packages/adapters/src/model` | 5 | 0 | 0 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4` | 5 | 1 | 2 | 2 |
| `apps/zcode-cli/packages/cli/src` | 5 | 0 | 2 | 3 |
| `apps/zcode-cli/packages/core/src/runtime/helpers` | 5 | 1 | 2 | 2 |
| `packages/desktop/src/host` | 5 | 2 | 2 | 1 |
| `packages/web/src/auth` | 5 | 5 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers` | 4 | 0 | 4 | 0 |
| `apps/zcode-cli/packages/core/src/runtime` | 4 | 0 | 4 | 0 |
| `packages/ui/src/app-shell` | 4 | 0 | 4 | 0 |
| `apps/zcode-cli/packages/adapters/src/exec` | 3 | 0 | 1 | 2 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store` | 3 | 0 | 0 | 3 |
| `apps/zcode-cli/packages/bootstrap/src` | 3 | 0 | 2 | 1 |
| `apps/zcode-cli/packages/contracts/src/interfaces` | 3 | 0 | 2 | 1 |
| `apps/zcode-cli/packages/core/src/tool/executor` | 3 | 0 | 1 | 2 |
| `packages/desktop` | 3 | 0 | 1 | 2 |
| `packages/desktop/src/renderer/src` | 3 | 0 | 3 | 0 |
| `packages/desktop/src/scheduler` | 3 | 1 | 2 | 0 |
| `packages/services/src` | 3 | 0 | 3 | 0 |
| `packages/services/src/model-provider` | 3 | 1 | 1 | 1 |
| `packages/services/src/oauth` | 3 | 3 | 0 | 0 |
| `packages/ui/src/feedback` | 3 | 3 | 0 | 0 |
| `packages/ui/src/resource-manager/storage` | 3 | 0 | 0 | 3 |
| `apps/zcode-cli/packages/adapters/src/mcp` | 2 | 0 | 2 | 0 |
| `apps/zcode-cli/packages/adapters/src/plugins` | 2 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/skills` | 2 | 0 | 0 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands` | 2 | 0 | 2 | 0 |
| `apps/zcode-cli/packages/cli/scripts` | 2 | 0 | 2 | 0 |
| `apps/zcode-cli/packages/contracts/src/tools` | 2 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/agent` | 2 | 0 | 2 | 0 |
| `apps/zcode-cli/packages/core/src/compact` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/context` | 2 | 0 | 0 | 2 |
| `apps/zcode-cli/packages/i18n/src/locales` | 2 | 0 | 0 | 2 |
| `packages/client/src` | 2 | 0 | 1 | 1 |
| `packages/ui/src/ToolCallBlocks/renderers` | 2 | 1 | 1 | 0 |
| `packages/ui/src/chat-input-toolbar` | 2 | 0 | 1 | 1 |
| `packages/ui/src/hooks` | 2 | 2 | 0 | 0 |
| `packages/ui/src/i18n/locales` | 2 | 0 | 2 | 0 |
| `packages/ui/src/onboarding` | 2 | 0 | 0 | 2 |
| `packages/ui/src/v4/composer` | 2 | 0 | 1 | 1 |
| `packages/web/src/share` | 2 | 2 | 0 | 0 |
| `scripts` | 2 | 0 | 2 | 0 |
| `apps/zcode-cli` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/adapters/src/commands` | 1 | 0 | 0 | 1 |
| `apps/zcode-cli/packages/adapters/src/config` | 1 | 0 | 0 | 1 |
| `apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/cli` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/contracts/src/events` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/contracts/src/model` | 1 | 0 | 0 | 1 |
| `apps/zcode-cli/packages/contracts/src/plugins` | 1 | 0 | 0 | 1 |
| `apps/zcode-cli/packages/core/src/mcp` | 1 | 0 | 0 | 1 |
| `apps/zcode-cli/packages/core/src/subagent` | 1 | 0 | 0 | 1 |
| `apps/zcode-cli/packages/core/src/system-reminder` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/core/src/tool` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/tools/prompt-trajectory` | 1 | 0 | 1 | 0 |
| `config/provider` | 1 | 0 | 1 | 0 |
| `packages/desktop/scripts` | 1 | 0 | 0 | 1 |
| `packages/desktop/src/main/browserView` | 1 | 0 | 0 | 1 |
| `packages/desktop/src/preload` | 1 | 0 | 1 | 0 |
| `packages/provider/src` | 1 | 1 | 0 | 0 |
| `packages/server/src` | 1 | 0 | 1 | 0 |
| `packages/server/src/remote` | 1 | 0 | 0 | 1 |
| `packages/services` | 1 | 0 | 0 | 1 |
| `packages/services/src/hooks` | 1 | 0 | 0 | 1 |
| `packages/services/src/oauth/repo` | 1 | 1 | 0 | 0 |
| `packages/services/src/plugins` | 1 | 0 | 1 | 0 |
| `packages/services/src/session/claude-native` | 1 | 0 | 1 | 0 |
| `packages/services/src/setting` | 1 | 0 | 1 | 0 |
| `packages/shared/src/zcode-protocol` | 1 | 0 | 1 | 0 |
| `packages/ui` | 1 | 0 | 1 | 0 |
| `packages/ui/src/WorkspaceSidebar` | 1 | 0 | 0 | 1 |
| `packages/ui/src/login` | 1 | 1 | 0 | 0 |
| `packages/ui/src/mentions` | 1 | 0 | 1 | 0 |
| `packages/ui/src/remote-connection` | 1 | 0 | 1 | 0 |
| `packages/ui/src/v4/telemetry` | 1 | 1 | 0 | 0 |
| `packages/ui/src/workspace-grouped-tasks` | 1 | 0 | 0 | 1 |
| `packages/web/src` | 1 | 0 | 1 | 0 |
| `packages/zcode-server-cli/src/runtime` | 1 | 0 | 0 | 1 |
| `packages/zcode-server-cli/src/server-core` | 1 | 0 | 1 | 0 |
| `third-party` | 1 | 0 | 1 | 0 |

---

## 2. 热点 60 文件逐文件处置表

热点口径：`packages/ui/src/**` 与 `apps/zcode-cli/packages/**` 范围内，按 `max(fork 改动行数, 上游改动行数)` 取前 60。
「fork 摘要」= fork 相对 v3.14.3 改了什么（族标签）；「上游摘要」= 上游 v3.15.1→v3.16.2 改了什么（族标签）。
`冲突块` = 三方合并的冲突块数；`残差` = fork HEAD 相对上游 v3.15.1 的偏离行数。

| # | 文件 | fork 改动 | fork 摘要 | 上游改动 | 上游摘要 | 处置 | 冲突块 | 残差 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | +8/-23 | 其他 | +2388/-2538 | 遥测+压缩+品牌字面量+模块重组+office+插件市场+MCP/OAuth+模型/provider+子智能体+工具/工作流+测试 | 【人工适配-分叉】 | 57 | 4057 | 高 |
| 2 | `packages/ui/src/WorkspaceSidebar.tsx` | +3/-29 | 遥测+品牌 | +3/-1963 | 遥测+品牌字面量+i18n+模块重组+插件市场+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 1 | 475 | 高 |
| 3 | `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` | +0/-1958 | 遥测+品牌+轨迹 | +10/-1 | 插件市场+MCP/OAuth | 【丢弃】 | 0 | — | 低 |
| 4 | `packages/ui/src/WorkspaceGroupedTasksSection.tsx` | +3/-11 | 品牌 | +0/-1946 | 遥测+品牌字面量+i18n+模块重组+模型/provider+工具/工作流+测试 | 【低摩擦重放】 | 0 | — | 低 |
| 5 | `packages/ui/src/v4/SessionPane.tsx` | +270/-1362 | 遥测+压缩+MC+品牌+i18n+占用面板 | +878/-619 | 遥测+压缩+品牌字面量+模块重组+office+模型/provider+子智能体+工具/工作流+测试 | 【人工适配-分叉】 | 42 | 2967 | 高 |
| 6 | `packages/ui/src/lib/messageTelemetry.ts` | +0/-1502 | 遥测+品牌 | +21/-1 | 遥测+插件市场+MCP/OAuth+工具/工作流 | 【丢弃】 | 0 | — | 低 |
| 7 | `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | +0/-1184 | 压缩+品牌+i18n | +354/-271 | 品牌字面量+i18n+模块重组+插件市场+模型/provider+工具/工作流+测试 | 【丢弃】 | 0 | — | 低 |
| 8 | `packages/ui/src/i18n/locales/en-US.ts` | +279/-183 | 压缩+MC+品牌+轨迹+i18n+占用面板+omz词汇 | +911/-202 | 遥测+品牌字面量+模块重组+插件市场+MCP/OAuth+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 15 | 1096 | 高 |
| 9 | `packages/ui/src/SettingsPage.tsx` | +79/-644 | 遥测+MC+品牌+轨迹+i18n+omz词汇 | +656/-422 | 品牌字面量+i18n+模块重组+插件市场+MCP/OAuth+模型/provider+子智能体+工具/工作流+测试 | 【人工适配-分叉】 | 13 | 789 | 高 |
| 10 | `packages/ui/src/i18n/locales/zh-CN.ts` | +266/-179 | 压缩+MC+品牌+轨迹+占用面板+omz词汇 | +844/-192 | 品牌字面量+模块重组+插件市场+MCP/OAuth+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 13 | 1045 | 高 |
| 11 | `packages/ui/src/remote-connection/RemoteConnectionConnectingStep.tsx` | +1/-58 | 遥测+品牌 | +885/-76 | 遥测+品牌字面量+模块重组+工具/工作流+测试 | 【人工适配-分叉】 | 5 | 59 | 高 |
| 12 | `packages/ui/src/Root.tsx` | +35/-314 | 遥测+品牌+i18n | +573/-250 | 品牌字面量+i18n+模块重组+MCP/OAuth+模型/provider | 【人工适配-分叉】 | 20 | 607 | 高 |
| 13 | `packages/ui/src/settings/AutomationsSection.tsx` | +33/-756 | 遥测+品牌+i18n | +8/-5 | 品牌字面量+模块重组+测试 | 【人工适配-分叉】 | 3 | 821 | 高 |
| 14 | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` | +27/-10 | 遥测+MC+轨迹 | +404/-366 | 遥测+品牌字面量+模块重组+office+插件市场+MCP/OAuth+模型/provider+子智能体+工具/工作流 | 【人工适配-分叉】 | 4 | 128 | 中 |
| 15 | `packages/ui/src/v4/ConversationTimeline.tsx` | +527/-221 | 遥测+品牌 | +103/-18 | 品牌字面量+模块重组+测试 | 【人工适配-分叉】 | 8 | 915 | 高 |
| 16 | `packages/ui/src/v4/ConversationShareConfirmationDock.tsx` | +0/-742 | 压缩+品牌+i18n | +341/-194 | 压缩+模块重组+工具/工作流+测试 | 【丢弃】 | 0 | — | 低 |
| 17 | `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts` | +0/-725 | 遥测+压缩+MC+轨迹 | +76/-28 | 压缩+品牌字面量+模块重组+MCP/OAuth+模型/provider+工具/工作流 | 【丢弃】 | 0 | — | 低 |
| 18 | `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | +81/-621 | 遥测+压缩+MC+品牌+占用面板 | +1/-1 | 品牌字面量+模块重组+测试 | 【人工适配-分叉】 | 1 | 844 | 高 |
| 19 | `packages/ui/src/settings/OffPeakEditView.tsx` | +0/-695 | 品牌+i18n | +64/-55 | 品牌字面量+模块重组+工具/工作流+测试 | 【丢弃】 | 0 | — | 低 |
| 20 | `packages/ui/src/SSHDialog.tsx` | +0/-10 | 遥测+轨迹 | +46/-578 | 遥测+品牌字面量+模块重组+插件市场+MCP/OAuth+模型/provider+测试 | 【人工适配-分叉】 | 4 | 34 | 中 |
| 21 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` | +9/-606 | 遥测+压缩+品牌 | +8/-1 | 遥测+品牌字面量+模块重组+插件市场+MCP/OAuth | 【丢弃】 | 3 | 619 | 低 |
| 22 | `packages/ui/src/WorkspaceHeaderSections.tsx` | +0/-39 | 其他 | +284/-322 | 压缩+品牌字面量+轨迹+模块重组+插件市场+MCP/OAuth+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 11 | 535 | 高 |
| 23 | `packages/ui/src/WelcomeScreen.tsx` | +0/-557 | 品牌+i18n | +2/-4 | 品牌字面量+模块重组+MCP/OAuth+模型/provider+测试 | 【丢弃】 | 0 | — | 低 |
| 24 | `packages/ui/src/settings/model-provider-section/useCodingPlanProducts.ts` | +0/-546 | 品牌+i18n | +86/-122 | i18n+模型/provider+测试 | 【丢弃】 | 0 | — | 低 |
| 25 | `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx` | +0/-506 | 遥测+品牌+i18n | +12/-13 | 品牌字面量+模块重组+模型/provider+工具/工作流+测试 | 【丢弃】 | 0 | — | 低 |
| 26 | `packages/ui/src/settings/McpSettingsSection.tsx` | +29/-0 | 品牌 | +173/-325 | 品牌字面量+模块重组+插件市场+MCP/OAuth+工具/工作流+测试 | 【人工适配-分叉】 | 16 | 541 | 高 |
| 27 | `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` | +9/-0 | 其他 | +297/-198 | 品牌字面量+模块重组+office+插件市场+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 12 | 112 | 高 |
| 28 | `packages/ui/src/ChatEmptyState.tsx` | +4/-47 | 遥测 | +0/-491 | 遥测+品牌字面量+i18n+模块重组+模型/provider+测试 | 【低摩擦重放】 | 0 | — | 低 |
| 29 | `apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts` | +0/-489 | 压缩+品牌+轨迹 | +12/-120 | 压缩+品牌字面量+模块重组+模型/provider+工具/工作流 | 【丢弃】 | 0 | — | 低 |
| 30 | `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | +14/-470 | 遥测+MC+品牌+占用面板 | +232/-37 | 压缩+品牌字面量+模块重组+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 8 | 606 | 高 |
| 31 | `packages/ui/src/v4/conversationProjectionStore.ts` | +423/-60 | 其他 | +16/-5 | 品牌字面量+模块重组 | 【人工适配-分叉】 | 1 | 553 | 高 |
| 32 | `packages/ui/src/root/useRootWorkspaceActions.ts` | +5/-93 | 遥测 | +295/-171 | 品牌字面量+模块重组+模型/provider | 【人工适配-分叉】 | 4 | 104 | 中 |
| 33 | `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts` | +0/-462 | 遥测+压缩+轨迹+占用面板 | +2/-0 | 工具/工作流 | 【丢弃】 | 0 | — | 低 |
| 34 | `packages/ui/src/hooks/useUsageEntitlement.ts` | +0/-458 | 品牌 | +42/-12 | 品牌字面量+模块重组+模型/provider | 【丢弃】 | 0 | — | 低 |
| 35 | `packages/ui/src/v4/ConversationComposer.tsx` | +15/-229 | 遥测+压缩+轨迹 | +329/-85 | 品牌字面量+i18n+模块重组+office+插件市场+模型/provider+测试 | 【人工适配-分叉】 | 17 | 445 | 高 |
| 36 | `packages/ui/src/root/useRootOAuthEffects.ts` | +0/-410 | 遥测+品牌+i18n | +45/-30 | 品牌字面量+模块重组+MCP/OAuth+模型/provider+测试 | 【丢弃】 | 0 | — | 低 |
| 37 | `packages/ui/src/settings/OffPeakTaskList.tsx` | +0/-406 | 品牌+i18n | +2/-2 | 品牌字面量+模块重组+测试 | 【丢弃】 | 0 | — | 低 |
| 38 | `packages/ui/src/store/conversationShareSelectionStore.ts` | +0/-402 | 品牌 | +58/-259 | 品牌字面量+模块重组 | 【丢弃】 | 0 | — | 低 |
| 39 | `packages/ui/src/lib/conversationShareError.ts` | +0/-365 | 品牌+i18n | +25/-0 | 品牌字面量+模块重组 | 【丢弃】 | 0 | — | 低 |
| 40 | `apps/zcode-cli/packages/adapters/src/mcp/index.ts` | +10/-351 | 品牌+轨迹 | +12/-0 | MCP/OAuth | 【人工适配-分叉】 | 2 | 994 | 高 |
| 41 | `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` | +3/-67 | 遥测+品牌+轨迹 | +292/-60 | 压缩+模块重组+模型/provider+子智能体 | 【人工适配-分叉】 | 6 | 131 | 高 |
| 42 | `packages/ui/src/feedback/FeatureRequestDialog.tsx` | +0/-352 | 品牌+i18n | +5/-2 | 模块重组 | 【丢弃】 | 0 | — | 低 |
| 43 | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | +304/-28 | 遥测+MC+品牌+轨迹+占用面板+omz词汇 | +22/-2 | 品牌字面量+模块重组+模型/provider+子智能体 | 【人工适配-分叉】 | 3 | 491 | 高 |
| 44 | `packages/ui/src/TaskListItem.tsx` | +6/-88 | 遥测+品牌 | +144/-185 | 遥测+品牌字面量+模块重组+模型/provider+工具/工作流+测试 | 【人工适配-分叉】 | 13 | 251 | 高 |
| 45 | `packages/ui/src/settings/ModelProviderSection.tsx` | +60/-247 | 品牌 | +17/-9 | 模型/provider+测试 | 【低摩擦重放】 | 0 | 361 | 中 |
| 46 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts` | +116/-147 | 遥测+MC+品牌+占用面板 | +286/-18 | 品牌字面量+模块重组+插件市场+MCP/OAuth+工具/工作流 | 【人工适配-分叉】 | 1 | 333 | 高 |
| 47 | `packages/ui/src/root/useRootPlatformEffects.ts` | +0/-297 | 品牌 | +60/-53 | 品牌字面量+模块重组 | 【人工适配-分叉】 | 6 | 345 | 高 |
| 48 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | +95/-196 | 压缩+MC+占用面板 | +49/-1 | 模型/provider+子智能体+工具/工作流 | 【人工适配-分叉】 | 1 | 820 | 高 |
| 49 | `packages/ui/src/login/LoginApiKeyForm.tsx` | +0/-286 | 品牌+i18n | +2/-3 | 品牌字面量+模块重组+模型/provider+测试 | 【丢弃】 | 0 | — | 低 |
| 50 | `apps/zcode-cli/packages/core/src/compact/microcompact.ts` | +0/-282 | 压缩+品牌+轨迹 | +16/-11 | 压缩+模块重组+工具/工作流 | 【丢弃】 | 0 | — | 低 |
| 51 | `apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts` | +0/-277 | 品牌+轨迹 | +2/-0 | 其他 | 【丢弃】 | 0 | — | 低 |
| 52 | `packages/ui/src/v4/ConversationShareSelectionDock.tsx` | +0/-269 | 品牌+i18n | +0/-269 | 品牌字面量+i18n+模块重组+模型/provider+测试 | 【低摩擦重放】 | 0 | — | 低 |
| 53 | `packages/ui/src/v4/ConversationTurnGroup.tsx` | +59/-201 | 压缩+品牌+i18n | +19/-122 | 品牌字面量+模块重组+工具/工作流+测试 | 【人工适配-分叉】 | 10 | 583 | 高 |
| 54 | `packages/ui/src/settings/SubagentsSection.tsx` | +6/-20 | 其他 | +157/-90 | 品牌字面量+模块重组+插件市场+模型/provider+子智能体+测试 | 【低摩擦重放】 | 0 | 46 | 中 |
| 55 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | +18/-170 | 压缩+品牌+轨迹+omz词汇 | +166/-78 | 品牌字面量+模块重组+模型/provider+子智能体+工具/工作流 | 【人工适配-分叉】 | 3 | 279 | 高 |
| 56 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` | +6/-231 | 压缩 | +4/-0 | 工具/工作流 | 【低摩擦重放】 | 0 | 486 | 中 |
| 57 | `packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts` | +0/-237 | 品牌 | +49/-6 | 品牌字面量+模块重组+模型/provider | 【丢弃】 | 0 | — | 低 |
| 58 | `packages/ui/src/v4/ConversationShareSelectionPanel.tsx` | +0/-229 | 品牌+i18n | +190/-29 | 模块重组+工具/工作流+测试 | 【丢弃】 | 0 | — | 低 |
| 59 | `packages/ui/src/v4/ConversationRowView.tsx` | +131/-95 | 遥测+压缩 | +2/-2 | 品牌字面量+模块重组+测试 | 【低摩擦重放】 | 0 | 462 | 中 |
| 60 | `packages/ui/src/feedback/FeedbackSubmitSections.tsx` | +0/-215 | 品牌 | +12/-3 | 品牌字面量+模块重组+测试 | 【丢弃】 | 0 | — | 低 |

### 2.1 热点表的读法补充

- `残差` 大的文件（如 `WorkspaceShellLayout.tsx` 残差 4057、`SessionPane.tsx` 残差 2967）表示 fork 至今仍是 v3.14.3 底子，
  上游 v3.16 补丁即使打得上，产物也缺 v3.15.1 那一层。**重放前必须先决定是否补 v3.15.1 基线。**
- `fork 摘要` 含「轨迹」「占用面板」「MC」「提示词语言」的文件是 fork 自研面，上游 v3.16 的一切改动都要逐段融合；
  这些面同时是本次同步最容易被上游改写覆盖掉的地方（`SessionPane.tsx`、`contextUsage.tsx`、`ConversationTimeline.tsx`、`ConversationTurnGroup.tsx` 尤甚）。
- `fork 摘要` 为「其他」但残差不小的文件（如 `conversationProjectionStore.ts` +423/-60、`AnimatedSidePanePanel.tsx` +9/-0），
  是 fork 自己的重构（轨迹回合化 / 侧栏重组），上游同区域改动不冲突但语义会打架（`conversationProjectionStore.ts` 上游加 `requiresAcceptedInputProjection`，
  fork 侧同一 store 已有自己的投影失效代际语义，两者会打架）。

---

## 3. 根配置与依赖面变化

### 3.1 Node 版本要求：未变

| 口径 | 上游 v3.15.1 | 上游 v3.16.2 | fork HEAD | 结论 |
| --- | --- | --- | --- | --- |
| `mise.toml` 的 `node` | 24.14.0 | 24.14.0 | 24.14.0 | 未变 |
| `mise.toml` 的 `pnpm` | 10.33.2 | 10.33.2 | 10.33.2 | 未变 |
| `.nvmrc` | `24` | `24` | `24` | 未变 |
| `package.json` `engines.node` | `>=24.0.0` | `>=24.0.0` | `>=24.0.0` | 未变 |
| `package.json` `packageManager` | `pnpm@10.33.2` | `pnpm@10.33.2` | `pnpm@10.33.2` | 未变 |

`mise.toml` 上游本次**零改动**；fork 侧唯一改动是 `ZCODE_DATA_BASE_DIR` 从 `~/.zcode-dev-home` 改到 `~/.omz-dev-home`（品牌改名，保留）。
**移植影响：无。** 门禁里的 Node 24.14.0 约束不变。

### 3.2 `pnpm-lock.yaml` importers 段：新增 29 条依赖条目，0 条删除

| importer | 新增依赖 |
| --- | --- |
| `.`（根） | `@zcode/zcode-cua` |
| `apps/zcode-cli/packages/office-runtime` | `@aiden0z/pptx-renderer`、`@extend-ai/react-xlsx`、`@fontsource/noto-sans-sc`、`@modelcontextprotocol/core`、`@modelcontextprotocol/ext-apps`、`@modelcontextprotocol/sdk`、`docx-preview`、`exceljs`、`fast-xml-parser`、`jszip`、`pdfjs-dist`、`playwright-core`、`react`、`react-dom`、`zod`、`esbuild`、`vitest`、`typescript`、`@types/node`、`@types/react`、`@types/react-dom` |
| `apps/zcode-cli/packages/documents-plugin` | `@zcode/office-runtime` |
| `apps/zcode-cli/packages/pdf-plugin` | `@zcode/office-runtime` |
| `apps/zcode-cli/packages/presentations-plugin` | `@zcode/office-runtime` |
| `apps/zcode-cli/packages/spreadsheets-plugin` | `@zcode/office-runtime` |
| `packages/shared` | `ws`、`@types/ws` |
| `packages/ui` | `@radix-ui/react-popper` |

去重后新增顶层依赖名 26 个：

```
@aiden0z/pptx-renderer  @extend-ai/react-xlsx  @fontsource/noto-sans-sc
@modelcontextprotocol/core  @modelcontextprotocol/ext-apps  @modelcontextprotocol/sdk
@radix-ui/react-popper  @types/node  @types/react  @types/react-dom  @types/ws
@zcode/office-runtime  @zcode/zcode-cua
docx-preview  esbuild  exceljs  fast-xml-parser  jszip  pdfjs-dist
playwright-core  react  react-dom  typescript  vitest  ws  zod
```

**关键新增运行时依赖**（需要决策的两类）：

1. **office-runtime 族（22 个依赖 + 1 个新 workspace 包 + 4 个 plugin 包）** —— 上游 v3.16.2 新增 `apps/zcode-cli/packages/office-runtime`
   （`@zcode/office-runtime@0.2.0`，文档查看器运行时），并新增 `documents-plugin` / `pdf-plugin` / `presentations-plugin` / `spreadsheets-plugin` 四个插件包依赖它。
   依赖里含 `pdfjs-dist@5.4.296`、`docx-preview`、`exceljs`、`jszip`、`@aiden0z/pptx-renderer`、`@extend-ai/react-xlsx`（pptx/xlsx 渲染）、
   `playwright-core@1.59.1`（PDF 渲染回退）、`@fontsource/noto-sans-sc`（中文字体子集）—— 体积与许可面显著增加。
   **fork 当前完全没有 `packages/office-runtime`**，若要移植这族能力，需要连带评估第三方许可清单（`THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` 已经是高冲突文件）。
2. **`@zcode/zcode-cua`（根 devDependency，workspace:*）** —— fork **已有** `packages/zcode-cua`（`@zcode/zcode-cua@0.6.3`，上游 v3.16.2 是 `0.6.5`），
   只是根 `package.json` 没声明这个 workspace 依赖。上游把它加进根 devDeps 并加了 `prepare: husky && pnpm build:cua` 与 `build:cua` 脚本。
   fork 若要跟上游一致，需注意 CUA 是「不可用即 fail-closed」的占位包（`zcodeCuaPlaceholder: true`），不构成运行时风险。
3. **`ws` / `@types/ws` 进 `packages/shared`**、`@radix-ui/react-popper` 进 `packages/ui`** —— 小体量，可直接跟。
4. **新的 `patchedDependencies`** —— 上游加了 `@radix-ui/react-collapsible@1.1.12` 补丁（fork 的 `patches/` 下没有此文件），
   同时 fork 现有的 `@ai-sdk/*` 两个补丁上游也保留，两边可合并。

### 3.3 根 `package.json`（上游 v3.15.1 → v3.16.2）

| 变化 | 详情 | 对 fork 的影响 |
| --- | --- | --- |
| `version` 3.15.1 → 3.16.2 | 上游版本号 | fork 用自己的 `oh-my-zcode@1.0.17`，不跟 |
| `prepare` 增加 `&& pnpm build:cua` | 新增 CUA 构建 | fork 需先有 `packages/zcode-cua` 的 build 脚本（当前 fork 的该包**没有** `scripts.build`，上游有 `tsc --noEmit -p tsconfig.json`） |
| `verify:pre-push` 增加 `db:schema:check` + `test:architecture` | 新增 SQLite schema 契约门禁 | 依赖上游新增的 `scripts/check-sqlite-schema.ts` + `schema.baseline.sql`，移植成本中等 |
| `typecheck` 改写 | 加 `packages/shared/tsconfig.testing.json`、`packages/desktop/tsconfig.main.json`、`packages/desktop/tsconfig.remote-main.json`、`packages/zcode-cua` | fork 的 typecheck 脚本体系不同，需手工对齐而非覆盖 |
| 新增 `build:cua` / `architecture:adopt` / `db:schema:check` / `db:schema:update` / `prepare:remote-assets:linux` | 5 个新脚本 | 逐个判定是否引入 |
| 删除 `build:web-remote-control` / `:v3` / `:v4` | 3 个脚本 | 上游删了；fork 保留与否待定 |
| `prepare:remote-assets` 改指 `@zcode/server-cli` | 打包路径变化 | 需确认 fork 的 desktop 打包链 |
| `pnpm.patchedDependencies` 新增 `@radix-ui/react-collapsible@1.1.12` | 新补丁文件 | 需把 `patches/@radix-ui__react-collapsible@1.1.12.patch` 一并带入 |

### 3.4 `.oxlintrc.json`

上游把 `max-lines` 从 **400 放宽到 800**，并加了一张 20+ 条目的「只告警不拆分」override 名单（`mcp/index.ts`、`create-app.ts`、`v4-gateway.ts`、`turn.ts` 等），
`ignorePatterns` 增加 `packages/zcode-cua`。

**fork 现状是 `max-lines: 400`（比上游更严）**，且 fork 自己的 `.oxlintrc.json` 已加 `.reference/**`、`.tools/**` 两条忽略。
本次同步**不应直接接受上游的 400→800 放宽**——那会静默放松 fork 的行数门禁，
而 fork 刚刚在 trace-nm-borrow 迭代里明确用「max-lines 400 约束新组件独立文件」作为设计约束。
建议：**只挑上游 override 名单中 fork 确实需要的条目**（且以 warn 而非 error 引入），保留 400 主线。

### 3.5 `.gitattributes`

上游新增 3 条规则：

| 规则 | 用途 | fork 是否需要 |
| --- | --- | --- |
| `*.baseline.sql text eol=lf` | SQLite schema baseline 与运行时 dump 逐字节比对，Windows autocrlf 检出成 CRLF 会误报 schema 差异并阻断 pre-push | 跟（若引入 `db:schema:check`） |
| `apps/zcode-cli/packages/office-runtime/fixtures/*.pdf binary` | 文档查看器测试 PDF 按字节解析 xref，换行转换会破坏偏移 | 仅在移植 office-runtime 时跟 |
| `apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/vendor/** -text` | Gen UI vendor 快照带 sha256 清单，按字节保真 | 视是否移植 visualize-plugin |

**fork 侧 `.gitattributes` 自有改动更大**：`*.js` / `*.json` / `*.ts` / `*.tsx` 全局锁 LF（上游没有），
以及 `THIRD-PARTY-NOTICES.md` / `third-party/upstream/**` / `third-party/native-search/licenses/**` / `third-party/runtime/*.txt` 的 `-text -whitespace`。
上游新增的 `docs/knip/docs/LICENSE` 与 `docs/knip/docs/licenses/**` 两条 fork 没有（fork 无 `docs/knip`）。
处置：**人工适配-分叉**——上游 3 条逐条判断后追加，不要覆盖 fork 现有的全局 LF 规则。

### 3.6 `pnpm-workspace.yaml` / `tsconfig.base.json` / `vitest.setup.ts`

- `pnpm-workspace.yaml`：上游本次**零改动**。fork 与上游的唯一差别是 fork 没有 `apps/dev-docs` 这一条 workspace glob（fork 无该包）——保持现状。
- `tsconfig.base.json`：上游本次**零改动**。
- `vitest.setup.ts`：上游本次**零改动**。
- `vitest.config.ts`：上游有改动（见下）。

### 3.7 `vitest.config.ts`（上游 v3.15.1 → v3.16.2）

上游改动 4 处：

1. 串行隔离组 `forkIsolatedTests` 新增 8 个用例（`r3RemoteProcess`、`personal-config-read-lock`、`stateStorage`、`notarizeMacosScript`、
   `publishReleaseScript`、`remoteFrontendBuildSource`、`dev-cua-plugin-runtime`、web 侧 `webRemoteControlTransport`）——都是「并发下 5s/30s 限时被打穿」的真实接线测试；
2. 新增 `forceRerunTriggers`（`configDefaults.forceRerunTriggers` + `**/{vitest,vite}.config.*` + `**/vitest.setup.ts`），
   修的是「affected 图不额外追踪 setupFiles，公共 setup 必须触发全量选择」；
3. `exclude` 增加 `packages/zcode-cua/**`；
4. `projects` 增加 `packages/zcode-cua/vitest.config.ts`。

**fork 侧 `vitest.config.ts` 相对 v3.14.3 零改动**（与上游 v3.15.1 同基线），因此这 4 处属于【低摩擦重放】。
但第 1 条新增的 8 个用例文件在 fork 侧**大部分不存在**（fork 无 `dev-cua-plugin-runtime.test.ts`、无 `notarizeMacosScript.test.ts` 等），
照抄会直接让 vitest 报「找不到测试文件」——重放时必须按 fork 实际存在的用例文件裁剪该列表。

### 3.8 `scripts/` 目录

上游 v3.16.2 对 `scripts/` 的改动：新增 21 个文件、修改 12 个、删除 2 个。

**新增（21 个）**，按主题归组：

| 主题 | 文件 | 对 fork 的移植评估 |
| --- | --- | --- |
| 架构治理拆分 | `architecture/adopt.mjs`、`architecture/context.mjs`、`architecture/git-base.mjs`、`architecture/report.mjs`、`architecture/resolver.mjs`、`architecture/violations.mjs`、`architecture/upstream-admission.mjs`、`architecture/upstream-snapshot.json`、`architecture/upstream-snapshot.mjs` | 上游把 `architecture-check.mjs` 拆成多模块。**fork 已有自己的 `.agents/skills/architecture-governance` 体系 + `scripts/architecture/`**，需先比对再决定是否引入；`upstream-admission.mjs`（上游准入）恰是本次同步场景，可能直接可用 |
| SQLite schema 契约 | `check-sqlite-schema.ts`、`restore-sqlite-migration.ts`、`sqlite-schema-contract.mjs`、`test/sqlite-schema-contract.test.mjs` | 依赖 `apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql`（上游新增文件）。**新能力，需评估** |
| CLI lint 准入 | `cli-lint-admission.mjs`、`run-cli-lint.mjs`、`test/cli-lint-admission.test.mjs`、`test/cli-test-environment.test.mjs` | fork 已有 `packages/cli` 的 turbo lint，重复度待判 |
| 受影响测试调度 | `affected-unit-tests/process.mjs`、`affected-unit-tests/scope.mjs` | 上游把 `run-affected-unit-tests.mjs` 拆模块。fork 的 `test:unit:affected` 门禁依赖此脚本，**优先级高** |
| 许可与依赖 | `license-identifiers.mjs`、`test/license-identifiers.test.mjs`、`bootstrap-patched-dependencies.mjs`、`test/bootstrap-patched-dependencies.test.mjs` | fork 有自己的 `scripts/licenses.mjs` 门禁，需比对 |
| 升级校验 | `verify-project-upgrade.mts` | 新能力 |
| 新测试 | `test/architecture-governance-review.test.mjs`、`test/architecture-upstream-admission.test.mjs`、`test/source-size-policy.test.mjs`、`test/affected-unit-test-cli.test.mjs` | `test:architecture` 脚本要一起扩 |

**修改（12 个）**：`architecture/architecture-check.mjs`、`architecture/index.mjs`、`architecture/policy.mjs`、`audit-zcode-agent-remnants.mjs`、`bootstrap.mjs`、
`build-desktop-agent-cli.mjs`、`dev-desktop-cua-env.mjs`、`dev-web-remote-control-desktop.mjs`、`licenses.mjs`、`run-affected-unit-tests.mjs`、`run-lint-staged-vitest.mjs`、
`test/architecture-governance.test.mjs`、`test/conversation-session-formal-admission-*.test.mjs`、`test/run-affected-unit-tests.test.mjs`。

其中 `scripts/bootstrap.mjs` 是 **SOP 第 5 节已登记的已知不适配项**（上游的 submodule 三行，fork 已删，同步回来要重新删掉）；
`scripts/build-desktop-agent-cli.mjs` 也在 378 交集文件里（【人工适配-分叉】，冲突 1 处）。

**删除（2 个）**：`scripts/prepare-prebuilds.mjs`、`scripts/prepare-prebuilds.sh`。fork 无同名文件 → 直接跟随上游删除，无影响。

### 3.9 `config/provider/zcode-builtin.json`

上游 v3.16.2 改动：`revision` 31 → 33；新增 `xiaomi-mimo-token-plan` 模板（token-plan baseUrl + `mimo-v2.6-pro`/`mimo-v2.6-flash`）；
`xiaomi-mimo` 模板名改为「Xiaomi MiMo API」并加 `mimo-v2.6-*` 模型；
批量把几十条 `modelMatch` 正则从 `.*xxx(?:[.\-:/\[].*)?` 简化为 `.*xxx.*`（并顺手修了两条互相错位的 `glm-4\.7-flashx` / `glm-4\.7-flash` 匹配串）；
多条 `maxOutputTokens.max: 128000` 被删除、`contextWindow` 值调整（部分模型从 1000000 改为不指定）。

**fork 侧此文件已改过 +2/-390**（品牌/端点相关），三方合并 1 处冲突但改动面覆盖 596 行。
**这是一份纯配置资产，语义全在数据里**——逐条 modelMatch / contextWindow / maxOutputTokens 的取值正确性只能靠 provider 目录比对，
不能靠 diff 判读。建议处置：**取上游 revision 33 的完整内容，再逐条回灌 fork 的品牌/端点差异**，然后用 provider 目录做取值回归。

---

## 4. 建议的推进顺序

1. **先定 v3.15.1 基线政策**（决定后面所有事）：本次同步到底要不要把 fork 缺的 v3.15.1 增量（尤其 237 个文件里那 78 个「全量上游增量 ≫ v3.16 增量」的）一起补进来。
   - 若**补**：本次工作量应按 `git diff baseline/v3.14.3..3c5b2276` 来估，而不是 `aac47556..3c5b2276`。
   - 若**不补**：则 83 个「CLEAN 但基线缺失」的文件必须显式标记为「本轮不重放」，否则会产出语义错乱的中间态。
2. **丢弃档 81 个**：绝大多数是 fork 已删文件的空转，直接跳过；只有 2 个遥测面文件需要人工确认「上游新增字段确实无处落地」。
3. **低摩擦重放档 123 个**：按依赖顺序（`packages/shared` → `packages/services` → `packages/ui` → `apps/zcode-cli`），其中 83 个必须先过基线政策这一关。
4. **人工适配档 174 个**：其中 73 个高风险按「先合协议层（shared/contracts）再合 UI」的顺序做，避免 UI 层反复返工。
5. **根配置**：`package.json` 逐脚本判定、`oxlintrc` 保留 400、`.gitattributes` 逐条追加、office-runtime 族单独开一轮评估（许可面 + 体积）。

---

## 附：方法与可复现命令

```bash
# fork 改动面
git diff --numstat baseline/v3.14.3..HEAD -- <file>
# 上游改动面
git diff --numstat aac47556..3c5b2276 -- <file>
# 三方合并冲突数（base=上游 v3.15.1, ours=fork HEAD, theirs=上游 v3.16.2）
git show aac47556:<file> > b; git show HEAD:<file> > o; git show 3c5b2276:<file> > t
git merge-file -p -L ours -L base -L theirs o b t   # exit 0 = 无冲突，>0 = 冲突块数
# 文件在双方树中的存在性
git ls-tree -r <rev> | findstr <path>
```

> 本报告为只读分析产物，未修改 fork 任何实现文件。