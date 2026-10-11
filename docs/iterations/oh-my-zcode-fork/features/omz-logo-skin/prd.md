---
date: 2026-10-08
dependency: []
---

# omz-logo-skin Feature PRD

## 背景与变更动机

omz 品牌改名（productName/appId/关于页/i18n 文案）完成后，视觉层面的标志仍是上游 ZCode 的「Z」字标。用户要求把标志的 Z 改成 OMZ，让产品视觉与品牌一致。

## 范围说明（相对原需求）

- 应用内所有「Z」标志渲染点换成 OMZ 三字母字标（与原 Z 同一设计语言：笔画厚 32/字高 218、末端 0.95 斜切、对角斜率呼应原 Z 对角线；Z 字母逐字沿用原字形）。
- 应用方标（侧栏/顶栏 18×18 深色圆角方壳）内部换 OMZ 白色小字标。
- Windows 侧二进制图标（icon.png / icon_windows.png / icons 全尺寸 / icon.ico 三份同源拷贝 / web favicon）再生成。
- CLI TUI 的 ASCII 块字 LOGO 由 "ZCODE" 换成 "OMZ"。
- 文案残留清理：HTML `<title>`、alt/aria-label、desktop package.json 品牌字段。

**原「不做」中的 mac 资产已完成**（4a19e57，v1.0.1 tag）：macOS icns（含 installer icns）与 DMG 背景重绘、`icon_installer.*` 重绘（均复用应用方标）。**仍不做**（登记为后续）：未使用的 `ZCodeWordmarkLogo` 组件与 `logo-zai-square.svg` 处置；`third-party/inventory.json` 哈希漂移重生成。

## 影响模块与接口

- packages/ui：ZCodeAboutLogo、RootStartupLoading、App/WindowsTopLeftLogo/WorkspaceSidebarCollapsedRail/DesktopTopOverlay（logo 指向新 app-logo.svg）、ConversationDraftEmptyState（明暗两套）、assets/Z.svg、新 assets/app-logo.svg。
- packages/desktop：renderer/index.html 与 cua-permission-panel.html（title/logo）、aboutWindow.ts、package.json 品牌字段、build/ 全部 Windows 图标。
- packages/web：index.html（title/logo/内嵌 favicon base64）、public/favicon.ico。
- apps/zcode-cli/packages/tui：ZCODE_LOGO_LINES。
- 新增 `scripts/generate-omz-brand-assets.mjs`：字标几何唯一事实源 + PNG/ICO 再生成管线（纯 Node，无新依赖）。

## 验收标准

1. 设置页/侧栏/顶栏/启动壳/关于页/空状态页看到的标志均为 OMZ 字标。
2. Windows 任务栏/窗口图标为 OMZ 方标（应用重启后生效；打包产物取 build/icon.ico）。
3. `logo-zai.svg` 保持原样（Z.ai 供应商图标与 app logo 解耦，不串改）。
4. 字标在深/浅背景下均可读（ASCII 目检 + 实机截图验证）。

## 测试用例

- 深色/浅色主题下侧栏收起态、设置页顶栏、启动加载页、关于面板目检。
- `generate-omz-brand-assets.mjs` 重跑产物与仓库资产字节一致（可重复再生成）。
