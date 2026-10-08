# 桌面应用品牌更名 omz（desktop-app-rename-omz）

## 范围

桌面应用对用户的**品牌**由 ZCode 收敛为 omz。更名只影响打包身份与用户可见文案；
与协议、数据兼容相关的标识一律**保持不变**：

- `ZCODE_*` 环境变量、`ZCODE_ENV`、`ZCODE_PREVIEW_IDENTITY`；
- `@zcode/*` 包名、`zcode://` 深链 scheme、`zcode.desktop` 文件 ID 与
  `x-scheme-handler/zcode` MIME 注册；
- `oh-my-zcode` CLI 名与 `~/.omz` CLI 数据目录；
- i18n 中的技术名词「ZCode Agent」「ZCode Built-in」与 `x-zcode-*` 头、`.zcodeignore` 等
  基础设施词。

## 改动清单

| 面 | 位置 | 内容 |
|---|---|---|
| 打包身份 | `packages/desktop/scripts/desktop-product-identity.mjs` | `productName` = `omz` / `omz Preview`；`appId` = `dev.omz.app` / `dev.omz.app.preview`；Linux 可执行名/包名 = `omz` / `omz-preview`。产物名随之变为 `omz-<version>-<platform>-<arch>.*` |
| Windows AUMID | 同上 | 开发态 `dev.omz.app.dev`（原 `cn.aminer.zcode`）；打包态沿用 appId |
| 运行时应用名 | `packages/desktop/src/main/desktopRuntimeEnv.ts` | `runtimeApplicationName` = `omz` / `omz Preview` / `omz Dev`；数据目录随 Electron `appData/<name>` 变为 `~/Library/Application Support/omz` 等，与旧 `ZCode` 安装互不干扰 |
| 关于面板 | `packages/desktop/src/main/about.ts` | 标题/版权品牌词 |
| 深链确认文案 | `packages/ui/src/i18n/locales/*.ts` | 「打开 ZCode」类用户文案（scheme 本身不变） |
| Linux 桌面项 | `desktopLinuxDeepLinkRegistration.ts` | `Name=` 跟随 productName 自动更名；desktop 文件 ID 与 MIME 因绑定 `zcode://` scheme 保持 `zcode.desktop`，归属标记 `Comment=ZCode Desktop App` 为历史版本识别保留 |
| Explorer 右键 | `packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts` | 注册键 `omz.OpenInOmz`、文案「在 omz 中打开 / Open in omz」；安装时清理旧 `ZCode.OpenInZCode` 键 |
| 界面品牌词 | `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | value 中的品牌词 `ZCode` → `omz`（key 与技术名词不动） |
| 打包兜底 | `electron-builder.config.js` | mac `productFilename` 兜底常量 |

## 兼容性说明

- `appId` 变化使新旧包在系统层面是**两个应用**：可并排安装，不会互相升级/覆盖；
  旧 `ZCode` 的快捷方式 AUMID 与新 `omz` 不同，任务栏不会合并。
- 运行时数据目录按应用名隔离，新包首启为全新数据；旧数据不迁移（如需迁移属于独立需求）。
- Preview 身份与正式身份的隔离逻辑不变，只是名字从 `ZCode Preview` 变为 `omz Preview`。

## 验收场景

- `pnpm --filter @zcode/desktop exec electron-builder --dir` 产物名为
  `omz-<version>-win-<arch>` 前缀；安装后开始菜单/任务栏显示 omz。
- 关于面板标题「关于 omz / About omz」，版权行含 omz。
- Windows 资源管理器目录右键出现「在 omz 中打开」，且不再有旧「在 ZCode 中打开」。
- 启动屏、欢迎页、登录页、托盘等用户文案显示 omz；日志中 `zcode://` 深链照常工作。
- `ZCODE_ENV=test` 产物身份为 `omz Preview`，`ZCODE_PREVIEW_IDENTITY=1` 生产包同为
  `omz Preview` 并可与正式 `omz` 并排安装。
