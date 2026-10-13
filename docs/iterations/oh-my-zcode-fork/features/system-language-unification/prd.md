---
date: 2026-10-13
dependency: []
---

# system-language-unification Feature PRD

## 背景与变更动机

v1.0.4（prompt-language-option）在设置页 General 分区引入了「界面语言」与「模型语言」两行相互独立的设置：前者管 UI 文案（`LocalePreference = system | zh-CN | en-US`，存 `~/.omz/v2/setting.json`），后者管 agent 系统提示词语言（`PromptLanguage = auto | zh-CN | en-US`，存 `~/.omz/cli/config.json`）。两行值域的实际语言集合相同，仅 auto/system 命名不同，且探测逻辑分叉（界面走宿主 Electron `app.getLocale`，模型走 env→Intl）——同一台机器可能出现「界面英文 + 提示词中文」的割裂组合。

用户于 2026-10-13 拍板：「两设置并存没有意义，当时设计就不合理……用界面语言那套就行，两者统一是方便理解的」。本 PRD 修订 prompt-language-option 的分立设计，合并为单一「系统语言」设置。

## 范围说明（相对原需求）

- **合并**：设置页只剩一行「系统语言」，值域沿用界面语言那套 `system | zh-CN | en-US`；「系统」沿用界面语言既有宿主探测，不新做 CLI 侧 detectedLocale 协议透传（不重开 OQ-9）。
- **模型语言跟随**：agent 提示词语言始终跟随界面语言的解析结果，host 侧通过既有 `workspace/updatePromptLanguage` 协议写入解析后的具体 locale；`config.json` 的 `promptLanguage` 降级为内部实现细节，UI 不再暴露。
- **CLI 独立场景兜底**：无桌面宿主的 TUI / 独立 CLI 保留 env→Intl 的 auto 解析，协议与 handler 不改。

## 影响模块与接口

- `packages/ui`：设置页 General 分区（合并行）、`IntlProvider`（变更序号）、新增同步 hook 与纯函数。
- `packages/shared`：test-ids 清理；协议 schema 不改。
- `packages/services`：`read|updatePromptLanguage` 方法原样复用（同步链路的载体）。
- `apps/zcode-cli`：仅注释订正；协议 handler、auto 解析不改。
- 用户数据：存量 `promptLanguage`（auto 或旧手选值）在首次进入 workspace 后被改写为界面语言解析值（用户拍板的合并语义，CHANGELOG 已登记）。

## 验收标准

1. 设置页只余一行「系统语言」（系统/简体中文/English），原「模型语言」行消失；sidebar footer 语言子菜单同样生效。
2. 切换「系统语言」后，`~/.omz/cli/config.json` 的 `promptLanguage` 变为对应具体值，运行中会话下一轮生效（CLI 既有热更新链路）。
3. `system` 态下模型语言跟随宿主探测出的具体 locale；不再出现「界面英文 + 提示词中文」组合。
4. 无 active workspace、旧 CLI（-32601）、RPC 失败：界面语言照常保存，模型语言同步静默跳过，「系统语言」行不因 CLI 可用性报错或禁用。
5. 跨窗口广播接收侧不重复写 `promptLanguage`。
6. i18n parity：zh/en key 集合相等。

## 测试用例

- 新增 `packages/ui/test/systemLanguagePromptSync.test.ts`（6 例）：无 workspace 跳过 / 旧 CLI `supported:false` 跳过 / 值一致不写 / auto 或旧手选值改写具体值 / 读失败仅日志 / 写失败仅日志。
- 回归 `packages/services/test/promptLanguageDegradation.test.ts`（断言不变）。
- `node scripts/check-i18n-parity.mjs`（5901=5901）。
- 根 `pnpm typecheck` 0 err、`pnpm lint` 基线 74w/0e 持平、`pnpm architecture:check --changed` 0 新增违规。
