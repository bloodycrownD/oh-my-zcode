---
date: 2026-10-13
agile_trace: true
---

# system-language-unification 实现规格（SPEC）

## 根因 / 方案摘要

v1.0.4 的 `prompt-language-option` 把「界面语言」（`LocalePreference = system | zh-CN | en-US`，存 `~/.omz/v2/setting.json`）与「模型语言」（`PromptLanguage = auto | zh-CN | en-US`，存 `~/.omz/cli/config.json` 顶层 `promptLanguage`）设成两行相互独立的设置。用户已明确否定该分立设计的意义（「难道有英文界面中文提示词的需求吗？两者统一是方便理解的」），本规格把两者合并为设置页一行「系统语言」。

合并口径（用户拍板，必须遵守）：

1. 值域沿用界面语言那套 `LocalePreference = system | zh-CN | en-US`；「系统」沿用界面语言既有宿主探测（Electron `app.getLocale` → `navigator.language`），**不新做** CLI 侧 `detectedLocale` 协议透传（= 不重开已被否定的 OQ-9 通道）。
2. 模型语言（agent 提示词语言）从此**跟随界面语言的解析结果**：host 侧在界面语言确定/变化时，把解析后的具体 locale（zh-CN / en-US）通过既有协议 `workspace/updatePromptLanguage` 写入。
3. `config.json` 的 `promptLanguage` 域降级为内部实现细节，UI 不再暴露；`auto` 值保留给无桌面宿主的 TUI / 独立 CLI 兜底（CLI 侧 env → Intl 探测不变）。
4. 界面语言的保存链路（含 setting.json 回写、跨窗口广播、宿主菜单）保持现状不动；模型语言同步失败必须静默，不得让「系统语言」行因 CLI 可用性报错或禁用。

## 变更点清单

**packages/ui**

- `src/settings/ModelLanguageSetting.tsx`：**整文件删除**（模型语言行连同「不支持/保存失败」两套降级 toast 一起退出 UI）。
- `src/settingsPageHelpers.tsx`：删除模型语言行挂载、`ModelLanguageSetting` import 与 `promptLanguageWorkspacePath` prop；「界面语言」行 label/description 改述为「系统语言」并说明模型提示词语言跟随。值域、自动保存、无服务降级形态全部沿用原界面语言行现状。
- `src/SettingsPage.tsx`：移除传给 `GeneralSectionContent` 的 `promptLanguageWorkspacePath`。
- `src/i18n/locales/{zh-CN,en-US}.ts`：`settings.locale` / `settings.localeDescription` 改文案；删除 `settings.modelLanguage*` 7 个 key（两端同步删除，parity 门禁保持相等）。
- `src/i18n/IntlProvider.tsx`：context 新增 `localeChangeToken`（本窗口主动提交界面语言的序号，单调递增）。只在 `setLocalePreference`（设置页 select 与 footer 语言子菜单两条入口的共同落点，`system` 态解析值变化引起的回写也在同一函数内完成）里递增；广播接收侧直接改 state、不调用 `setLocalePreference`，因此序号不递增——复用现有 `applyingBroadcastRef` 防回环语义而非新增第二条写路径。
- `src/lib/promptLanguageSync.ts`（新增）：纯同步函数 `syncPromptLanguageWithInterfaceLocale`（无 `@/` 依赖，可进 node 单测）。读 `workspace/readPromptLanguage`，`supported:false`（旧 CLI -32601 降级）或值与界面解析 locale 一致则跳过，否则 `workspace/updatePromptLanguage(具体值)`。返回 outcome 供调用方决定是否重试。
- `src/hooks/useSystemLanguagePromptSync.ts`（新增）：唯一 mount 点封装上述同步。触发时机：① `localeChangeToken` 变化（发起窗口的界面语言变更）；② workspace 变为可用（启动时无 workspace 的漏同步 + 存量用户首次迁移，覆盖旧 `auto` 或用户曾手选的旧值）。单飞 + 完成后重跑一次，避免并发读写同一条用户级配置。无 workspace / 旧 CLI / RPC 失败：静默跳过（debug/warn 日志，无 toast、不回滚界面语言）。
- `src/Root.tsx`：`RootInner` 挂载 `useSystemLanguagePromptSync({ workspacePath: activeWorkspacePath })`。只在发起变更的窗口执行：接收广播的窗口序号不递增，因此不会重复写。

**packages/shared**

- `src/test-ids.ts`：删除 `TID_SETTINGS_MODEL_LANGUAGE_SELECT_TRIGGER` / `_ITEM`。协议方法、schema、`ZCodePromptLanguage` 类型**不改**。

**packages/services**（不改实现）

- `zcodeAgentService.read|updatePromptLanguage` 与 `zcodeAgent` 接口原样保留（同步走的就是这两条既有方法）；`read` 的 -32601 → `supported:false` 降级语义继续作为静默跳过的判据。`test/promptLanguageDegradation.test.ts` 只按新消费方改写注释口径，断言不变。

**apps/zcode-cli（不改）**

- 协议 handler、`promptLanguage` schema、env→Intl 的 auto 解析全部原样复用；仅 `adapters/src/config/schema.ts:324-326` 的「与 ui.locale 相互独立」注释订正为「跟随界面语言」。

## 状态所有者与事件顺序

- 界面语言唯一所有者：`IntlProvider`（`localePreference` + `systemLocale` → `locale`）。模型语言唯一真源：CLI 进程的 `ConfigPort` / `config.json`，UI 不持有第二份 promptLanguage 状态。
- 事件顺序（发起窗口）：

```text
用户选择系统语言（设置页 select / footer 子菜单）
  → IntlProvider.setLocalePreference
    → 解析具体 locale（system 走宿主探测）
    → broadcast(state:locale) 通知其他窗口（接收窗口只改本地 state，不同步模型语言）
    → settingService.update({locale, localePreference})
    → localeChangeToken += 1
      → useSystemLanguagePromptSync 读 readPromptLanguage
        → 不一致则 updatePromptLanguage(具体值) → CLI 写盘 + ConfigPort.set + runtime.updateConfig
```

- 存量 / 启动顺序：`RootInner` mount 时同步为 pending；workspace 变为可用后执行一次同步（覆盖旧 auto 与旧手选值）。
- 幂等边界：读值与界面解析 locale 一致即不写；并发触发单飞合并为一次读+一次写。

## 验收场景

1. 设置页只余一行「系统语言」（system / zh-CN / en-US），原「模型语言」行消失；footer 语言子菜单仍可改且同样触发同步。
2. 切换系统语言后 `~/.omz/cli/config.json` 顶层 `promptLanguage` 变为对应具体值（zh-CN / en-US），运行中会话下一轮生效（CLI 热更新既有链路）。
3. `system` 态下模型语言跟随宿主探测出的具体 locale，不再长期停在 `auto`。
4. 存量用户（promptLanguage=auto 或旧手选值）在首次进入 workspace 后被改写为界面语言解析值。
5. 无 active workspace、旧 CLI（-32601）、RPC 失败：界面语言照常保存，模型语言同步静默跳过（仅日志）。
6. 广播接收窗口（如手机远控）不重复写 promptLanguage。

## 测试策略

- `pnpm typecheck`、`pnpm lint`、`node scripts/check-i18n-parity.mjs`（zh/en key 集合相等）。
- 新增 `packages/ui/test/systemLanguagePromptSync.test.ts`：无 workspace 跳过、旧 CLI 不支持跳过、值一致不写、值不一致写具体值、读/写失败只记日志不抛。
- `npx tsx --test packages/services/test/promptLanguageDegradation.test.ts`：services 降级链路回归（断言不变，仅注释口径更新）。

## 风险与回滚方案

- 回滚即还原本次 diff；`config.json` 中残留的 `promptLanguage` 具体值可被 CLI schema 容忍，行为等价于显式选择。
- 合并后不再有「界面英文 + 提示词中文」组合，属用户拍板的预期行为变化（CHANGELOG 用户面登记）。
