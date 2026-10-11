---
date: 2026-10-08 22:10
title: 桌面启动修复×2 + omz 品牌改名落地；全量标识符改名执行后回滚
keywords: 数据准备进程意外退出, agent bundle externals, transport_closed, Built-in Release 均不可用, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, bundledFallback, omz 改名, 标识符回滚, browserGuestManager CRLF, node 24 .tools, dev-desktop.cmd
abstract: 一天内完成三个交付：①桌面启动「数据准备进程意外退出」修复（glm/zcode.cjs 的 external 依赖 @zcode/magic-context 从未随包，stage-agent-bundle 平铺闭包+builder 平台目录取件绕 node_modules 剪枝+bundle 后校验）；②「Bundled 与 Active 均不可用/模型加载失败」修复（本机用户级 env 指向旧 ZCode 3.14.4 缓存，provider-node 加 bundledFallbackFilePath 全链回落）；③omz 品牌改名（身份/AUMID/数据目录/关于/右键/i18n，三族标识符保留）。随后全量标识符改名（2072 文件）用户撤回、完整回滚。附本机环境事实与 browserGuestManager.ts CRLF 历史遗留说明。
---

user:
桌面启动报「数据准备进程意外退出或连接中断」，另外模型加载失败报「Bundled 与 Active ZCode Built-in Release 均不可用」。附了另一环境的修复日志，要求在本仓库（不带这些修复）独立复现并修复。

assistant:
两个都复现并修复了。①启动卡死：zcode.cjs 是 CJS bundle，@zcode/magic-context 因 top-level await+import.meta.url 被 esbuild external，但暂存只拷 zcode.cjs 不搬依赖；且 electron-builder 会剪掉拷贝根下的 node_modules（app-builder-lib filter.js）。修复三件套：stage-agent-bundle.mjs 按生产闭包平铺 glm/node_modules（magic-context+zod+ai-tokenizer，43MB）+暂存后 require.resolve 断言与 --version 自检；electron-builder 资产条目改从平台目录取件绕剪枝；bundle.mjs 加打包后校验。实测打包产物用 ZCode.exe ELECTRON_RUN_AS_NODE 跑通。spec：docs/specs/desktop-agent-bundle-externals.md。②模型加载：根因是本机用户级全局环境变量 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向旧 ZCode 3.14.4 的 ~/.zcode 缓存（schema 不兼容），桌面 Main 原样透传导致 Bundled=Active=坏文件。修复：NodeZCodeBuiltinProviderConfigSource 加 bundledFallbackFilePath，Bundled 无效回落随包基线（与构建脚本语义对齐），经 shared hostInitLocalMessageSchema→Host→Services→provider-node 九处接线。实机验证 Registry 就绪、model-selection 0 失败。另发现 dev 构建清单漏 magic-context，补进 build-desktop-agent-cli.mjs。

user:
应用改名做了吗？改成 omz（另一环境日志里干过）。

assistant:
按日志范围完成品牌改名：desktop-product-identity.mjs（productName=omz/omz Preview、appId=dev.omz.app(.preview)、Linux 可执行名/包名=omz(-preview)、dev AUMID=dev.omz.app.dev）、runtimeApplicationName=omz/omz Preview/omz Dev（数据目录随之变 %APPDATA%\omz Dev，与旧 ZCode 目录互不干扰）、关于面板、Explorer 右键（新键 omz.OpenInOmz+清理旧键）、Linux 桌面项 Name=、i18n 品牌词 zh/en 180 处（只动 value，保留 key 与 ZCode Agent/Built-in 技术名词）。zcode:// scheme、ZCODE_* env、@zcode/* 包名按日志保留。spec：docs/specs/desktop-app-rename-omz.md。实测 omz Dev 数据目录生成。

user:
ZCODE_*、@zcode/*、zcode:// 这些不能也全改成 omz 吗？你上次把自己杀了是不是也因为改名不充分？

assistant:
澄清：自杀未遂与改名无关——是按进程名杀 "ZCode" 命中了宿主（E:\App\Others\ZCode\ZCode.exe 的正式客户端，agent 跑在其内），教训是杀进程必须按路径前缀（已写入 RULE.md）。三族标识符量化评估：zcode:// 仅 5 处引用值得改（与旧安装分家）；ZCODE_* 302 个名字收益近零；@zcode/* 1833 文件 2974 处 import 且 UPSTREAM-SYNC.md 有上游同步流程，纯亏。

user:
全改吧，不和上游同步了，增量看更新就行。

assistant:
执行了全量改名 codemod（2072 文件：@omz/ 3571 处、OMZ_ 1627 处、omz:// 11 处+MIME 4 处）+scheme 注册手工收尾+pnpm install 重建 lockfile。

user:
算了，不改了，回滚还来得及吗？

assistant:
来得及（全程未提交）。反向 codemod 同规则逆跑（3571/1624/12/4 全还原，保护了本就存在的 OMZ_DATA_DIR_NAME）+6 处手工 scheme 改动还原+pnpm-lock.yaml git 恢复+install 重建 @zcode 链接。对账验证：@omz/、omz://、杂散 OMZ_ 全零；zcode:// 逐文件与 HEAD 一致；typecheck 全过；dev 应用重启 Registry 就绪。最终 git 就是三项成果的 22 文件+docs/。决策已入 RULE.md：三族标识符维持原样，再提全量改名须重新拍板。

user:
（背景事实备忘）

assistant:
本机环境与遗留：①node 24.14.0 在 D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64（mise 未装），corepack 已激活 pnpm 10.33.2，dev 启动器 .tools\dev-desktop.cmd（PATH 前置+ZCODE_DATA_BASE_DIR=~/.omz-dev-home 隔离）；②用户级 env ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 仍指向旧 3.14.4 缓存——运行时已回落兜底但每次启动会有 4-10 条回落告警，建议用户删除该环境变量；③browserGuestManager.ts 显示永久 M 是历史问题（.gitattributes 要求 *.ts eol=lf 但提交 blob 是 CRLF，内容零差异），下次提交捎上 LF 规范化即了结；④工作目录曾清理 2.7GB 临时文件；electron --dir 出包在本机会卡 winCodeSign symlink 特权（开发者模式可解）。
