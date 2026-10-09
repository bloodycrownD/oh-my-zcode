# Changelog

## v1.0.3（2026-10-09）

两处本地已验证修复的上游落地：magic-context 会话卡死修复、macOS 打包 ad-hoc 签名开关（CI mac 产物默认开启）。

### 修复

- **magic-context tool drop 残留孤儿 tool-call，会话卡死且重启/重放不恢复**：ZCode 把一个 tool call 拆成两个 part——assistant 消息上是 running 的 invocation（只有 input），user 结果消息上才是 completed/error 的 result（有 output）；而 tool 弧分类把 `type:"tool"` 一律当 result，FIFO 配对收不到 invocation 入队，result 一侧又复用了 user 宿主绑定（本是为 OpenCode「调用/结果同消息」形态准备的快路径）。两个 part 落进不同 composite key 后，drop 只清 result 一侧，invocation 成孤儿：客户端持续报 `AI_MissingToolResultsError: Tool result is missing for tool call ...`，坏字节还会被 LKG 固化逐 pass 重放。现在 `extractToolCallObservation` 按弧是否闭合（`partHasCompletedResult`）分流——完成/出错 → result、pending/running → invocation（anthropic 的 `tool_use`/`tool_result` 形态不变）；result 复用宿主绑定补 `role === "assistant"` 条件，user-role 宿主交回 FIFO 配对；`tag-messages` 与 `read-session-chunk` 两个 FIFO 消费方同时修正。缺陷链路与规则见 `docs/specs/magic-context-tool-arc-pairing.md`，transform 常驻测试 +3 例（38 cases 全过）。

### 功能

- **macOS 打包 ad-hoc 签名开关 `ZCODE_MAC_ADHOC_SIGN`**：无证书时 `identity: null` 让 bundle 完全不签名（没有 `_CodeSignature`），浏览器下载（带 com.apple.quarantine 隔离属性）后被 Gatekeeper 判「已损坏」且无法自救。开关打开后以 ad-hoc（identity `"-"`）完整封签，报错回到真实可行动的「无法验证开发者」提示。identity 回退链为 真实证书 → ad-hoc → 不签名；`notarize` 恒 false、`hardenedRuntime` 只跟随真实证书签名；默认关闭，本地与 CI 现状行为不变。CI 的 mac 产物自本版起默认 ad-hoc 封签（按 matrix 注入开关）——未公证包首次打开仍需右键 → 打开（或系统设置放行 / `xattr -rd com.apple.quarantine`），彻底解决需要开发者证书 + 公证。

## v1.0.2（2026-10-09）

v1.0.1 发布 diff 全量代码评审（32 项）+ 三线实机 E2E 验证后的修复批次：启动稳定性、品牌一致性收尾、模型体验补漏与测试基建。

### 修复

- **带残留旧版环境变量的机器上，打包版桌面仍「启动即退」（v1.0.1 修复的盲区）**：v1.0.1 的修复只在开发布局验证过——CLI 侧解析「随包基线」的候选清单缺桌面打包布局（`resources/glm` → `resources/config/provider`），打包产物在残留 stale `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的机器上仍会抛「无法定位 CLI ZCode Built-in Provider Config」退出（read-only 控制面与会话 agent 均受影响）。现在解析收敛为 `@zcode/provider-node` 公共函数，CLI 与桌面 Main 共用同一候选清单（CLI 打包/桌面打包/桌面 dev/CLI dev 四布局），并在解析失败时接受继承的 `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` 兜底；agent spawn env 的 BUNDLED 恒指真实随包基线（fallback 优先、显式值仅兜底，单测锁定）。附带：成对环境变量探针改为纯读取校验，不再对（可能属于另一旧安装的）显式文件目录产生 mkdir/文件锁写副作用。
- **模型语言「自动」在 Windows 中文系统热切换回落英文**：运行中把「模型语言」切到「自动」（或从显式值切回）时，热路径只探测 `LANG`/`LC_*`（Windows 常缺位）会解析为英文直至重启，与冷启动（env → `Intl`）分叉。现在热路径与冷启动同源（公共函数单点），冷热一致有测试锁定；`zh_CN` 等 POSIX 风格标签也能正确识别为中文。
- **模型列表拉取三处补漏**：legacy 导入的自定义请求头（`api.headers`）随拉取上行——此前被丢弃，依赖自定义鉴权头的 provider 会 401 且误提示「请检查 API Key」（同名头大小写不敏感覆盖，显式鉴权头优先，头值不进日志/错误）；超时不再误报为「响应不是合法 JSON」、全链 405 不再误报 404（错误文案附最后状态与已尝试路径）；「密钥不经过 renderer」类注释与 CHANGELOG 措辞订正为事实（API Key 不作为 RPC 参数传递，由主机本地读取）。
- **「添加模型」可输入下拉的竞态与键盘可达性**：拉取未完成时关闭弹窗，晚到的响应不再把旧候选写进下次打开的弹窗（此前存在幽灵候选闪入）；已展开候选时点击输入框定位光标不再丢候选；补齐 combobox ARIA 契约（role/aria-expanded/aria-activedescendant），纯键盘（↓/↑ 选择、Enter 填入、Esc 收起候选且不连锁关弹窗）可完成全流程。
- **web 标签页标题回退 ZCode**：web 入口 `main.tsx` 运行时覆盖 `document.title` 的两处品牌串漏改（静态 `<title>` 已改但会被覆盖），现收敛为单一品牌常量；CUA 权限面板的运行时标题同理修正。

### 品牌

- **资产再生成管线可复现**：字标缩放精度修正（0.0185567，不再四舍五入漂移）、Z 字形保留原始贝塞尔曲线（不再折线化）、新增 `--check` 模式——36 项资产映射逐字节比对（SVG/PNG/ICO/ICNS/DMG/内嵌 favicon + 5 处内联 `d` 串），「重跑产物与仓库资产字节一致」首次可机验。
- **macOS 图标档位与 DMG 背景修正**：icns 补回 ic11..ic14（32/64/256/512 的 @2x 槽位——v1.0.1 重生成时档位回退，Finder 小图标此前只能降采样）；DMG 背景箭头纵向归位（与图标行 y=220 对齐，v1.0.1 补齐 mac 资产时错位约 80px 不指向「应用程序」）。
- **web 内嵌 favicon 与重生成图标同步**（v1.0.1 重绘全量图标后内嵌副本漂移）；`app-logo.svg` 描边环一处贝塞尔控制点抄错订正（与 Z.ai 供应商图标壳形逐字一致）；空状态明/暗线框线宽补偿（缩放后有效线宽此前约为原设计一半）；**原生菜单/托盘品牌词补齐**——Windows 帮助菜单「关于 omz」、托盘 tooltip「omz」/「打开 omz」（v1.0.1 改名在 shared 原生菜单 catalog 的漏网项，E2E 实机发现）；陈旧品牌注释清理与 DMG 卷图标注释对齐（安装器图标统一复用应用方标）。

### 工程

- 四组常驻测试落盘（共 40 用例）：Built-in 基线回落（含桌面打包布局回归锁）、模型语言（RPC 写盘/上下文构建三态/旧 CLI -32601 降级）、模型列表拉取（候选路径链/超时与错误分类/鉴权头/脏数据/密钥不泄漏）；资产 `--check` 纳入门禁（UPSTREAM-SYNC.md 测试族 15→17 项）。
- `electron-builder.config.js` 行尾归一 LF 并以 `.gitattributes` 锁定（`*.js text eol=lf`，消除 746/737 行的整文件噪音 diff）；设置页 i18n 清理删除组件遗留的 10×2 个孤儿 key（parity 5891=5891）；`presetLoading` 死别名与不可达 preset 分支清理。
- 全部 32 项经三线实机 E2E 验证：打包布局模拟 + stale env 真实 bundle、桌面实机（含真实端点拉取与键盘操作）、web 运行时标题；相关 feature/bug 的 PRD/SPEC 文档同步订正。

### 已知限制

- macOS 安装包仍未签名/未公证，首次打开需右键 → 打开（沿用 v1.0.1）。
- DMG 背景箭头指向与 icns 小尺寸槽位表现为像素级/结构级验证（箭头中心 y≈219.5、ic07..ic14 齐备），mac 实机视觉终判建议发版后目检确认。

## v1.0.1（2026-10-09）

品牌视觉定型 omz + 模型体验补齐（中文提示词、拉取模型列表、预设清理）与三处稳定性修复。

### 变更

- **桌面应用品牌由 ZCode 收敛为 omz**：打包身份（`productName` = `omz`、`appId` = `dev.omz.app`、Linux 可执行名/包名 = `omz`、Windows 开发态 AUMID）、运行时应用名（数据目录随之变为 `omz`/`omz Dev` 等，与旧 `ZCode` 安装互不干扰）、关于面板、深链确认文案、Linux 桌面项显示名、资源管理器右键项（新键 `omz.OpenInOmz` 并清理旧 `ZCode.OpenInZCode`）、界面 i18n 品牌词全部改为 omz，Windows 产物名随之变为 `omz-<version>-win-x64.exe`。`ZCODE_*` 环境变量、`@zcode/*` 包名、`zcode://` 深链 scheme 与 `~/.omz` 数据目录保持不变，详见 [docs/specs/desktop-app-rename-omz.md](docs/specs/desktop-app-rename-omz.md)。
- **品牌标志 Z → OMZ**：应用内全部 Z 字标渲染点（启动壳/关于面板/引导页/侧栏与顶栏方标/空状态明暗两套/CLI TUI ASCII）与全平台二进制图标（Windows icon.ico×3 同源/九档 png/icon_windows/web favicon、macOS icon.icns×2/DMG 背景 dmg_background×2）替换为 OMZ 三字母字标（设计语言沿用原 Z：笔画比例、末端斜切、对角斜率；Z 字母逐字沿用原字形）；安装器图标（icon_installer.*，原“包裹箱插画”）统一复用应用方标；DMG 安装背景以 OMZ 字标重绘同构图；新增 `scripts/generate-omz-brand-assets.mjs` 作为可复用的再生成管线（纯 Node 栅格化 + ICO/ICNS 容器写入，无新依赖）。
- **模型语言选项与中文提示词**：`~/.omz/cli/config.json` 顶层新增 `promptLanguage: "auto" | "zh-CN" | "en-US"`（缺省 auto，中文环境自动中文），设置页「通用 → 模型语言」可切换（自动保存、热生效于下一轮对话）；agent 系统提示词的身份/沟通规范/行为段/桌面上下文段支持中文（文案集中在 `prompt-copy-zh-cn.ts`，英文原文保留为回退），中文提示词显式要求以简体中文交流、技术名词保持原文。协议 `workspace/read|updatePromptLanguage` 旧 CLI 自动降级。
- **设置页移除 zai/bigmodel 预设可见面**：左栏「智谱」预设占位组（OAuth 早已删除的死占位卡）与「添加供应商」模板选择器的智谱分组（zai-api/zai-standard-api/bigmodel-api/bigmodel-standard-api 四张模板卡）整体移除；`config/provider/zcode-builtin.json` 的模板数据保留不动（存量用户从模板创建的 provider 依赖稀疏 overlay，删除数据属破坏性变更，登记为后续可选）。

### 新增

- **「添加模型」支持拉取模型列表**：`IProviderSettingsService.listProviderModels` 在主机侧按 provider 的 api 类型请求模型列表端点（走 host 代理/CA 传输层，API Key 不作为 RPC 参数传递）；模型 ID 输入框为可输入下拉框——拉取后聚焦/输入即弹出候选、输入即过滤、点选即填入，也保留任意手输。**路径兼容**（实测各家网关差异）：anthropic-messages 按 `/v1/models` 约定先试（对齐 SDK 消息端点 `{base}/v1/messages`），OpenAI 系先试 `{base}/models`；404/405 时逐条回落（含源站根路径 `/v1/models`、`/models` 兜底，覆盖 DeepSeek `/anthropic` 这类只在 OpenAI 面提供列表的双面网关及 API 类型与基址错配的配置）；全部 404 时错误信息列出已尝试路径。

### 修复

- **设置页「读取上下文管理配置失败」（read-only 控制面进程启动即退出）**：CLI 入口 `prepareCliProviderRuntimeEnv` 在显式 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 存在时把该值直接当随包基线且无兜底（成对快捷路径更是零校验透传），残留旧安装 env 的机器上 app-server 启动即抛「Bundled 与 Active 均不可用」退出（桌面侧表现为 read-only 协议请求 `stdout_closed`）。现在无条件解析真实随包基线并作为 `bundledFallbackFilePath` 兜底（与桌面侧/构建脚本 D-16 同语义），显式值失效时回落并告警；返回 env 的 bundled 基线恒指向真实基线。

- **桌面端「Bundled 与 Active ZCode Built-in Release 均不可用 / 模型加载失败」**：用户级环境变量 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 若指向旧版本缓存（如 ZCode 3.14.4 的 `~/.zcode` 运行时文件，schema 已不兼容），桌面 Main 会把它当作 Bundled 基线原样透传给 Host，双候选同源失效后所有 provider/model RPC 持续失败。现在 `NodeZCodeBuiltinProviderConfigSource` 支持 `bundledFallbackFilePath`：Bundled 基线无效时回落随包基线（打包 `resources/config/provider/zcode-builtin.json`、开发态仓库 `config/provider/zcode-builtin.json`）并输出可检索告警，语义与构建脚本 `builtin-provider-config.mjs` 一致；接线经 shared `hostInitLocalMessageSchema` → Desktop Main/Host → Services → provider-node 全链路。

- **桌面版启动停在「数据准备进程意外退出或连接中断」**：`glm/zcode.cjs` 的运行期 external 依赖 `@zcode/magic-context`（连同闭包内的 `zod`、`ai-tokenizer`）从未随桌面包暂存，Host 的存储准备 Worker 一启动就 `Cannot find module` 静默退出，用户侧只看到 `Storage preparation failed: transport_closed`。现在 `stage-agent-bundle.mjs` 按生产依赖闭包把 external 依赖平铺到 `glm/node_modules/`，并在暂存后实跑 `zcode.cjs --version` 自检（含 require.resolve 断言）；`electron-builder.config.js` 的 agent 资产条目改为从平台目录取件，绕开 electron-builder 对「拷贝根下 node_modules」的剪枝；`bundle.mjs` 新增打包后校验，源已暂存而产物缺失时直接失败。规则与验收场景见 [docs/specs/desktop-agent-bundle-externals.md](docs/specs/desktop-agent-bundle-externals.md)。

### 已知限制

- macOS 安装包仍未签名/未公证，首次打开需右键 → 打开（沿用 v1.0.0）。

## v1.0.0（2026-10-06）

首个正式版本：本地化 fork 定型（官方端点退场）+ 长会话性能治理完成。

### 变更

- **官方端点与账号域全线退场**：自动更新链（electron-updater、强更 gate、菜单/托盘/设置页更新入口）、登录与订阅账号态（UI 订阅额度族、CLI `/login`、官方 MCP 鉴权）、闲时任务（off-peak）链路、会话分享域（发布/导入/web 落地页）、帮助/反馈/社区入口、OAuth/支付 deep link 死管道整删。模型 provider 收敛为本地配置两组（preset / custom），仅凭自备 API 即完整可用；zh/en 键集对齐（5893 键，新增 parity 门禁）。
- **长会话性能**：投影层增量渲染（accumulator + copy-on-notify 引用复用 + renderUnits 增量缓存）、turn 目录窄投影（侧边消息 rail 的目录合并 / 跳转 / 上滚分页）、内存护栏（shiki tokensCache LRU 上限 500 + 订阅表上界）、全局秒级 tick 下线改局部组件自刷新。979 消息会话实测：滚动 longtask 121→43（2.8x）、阻塞时长 12293→3553ms（3.5x）、滚动行程归一 5.8–7.1x、heap 增长 +81.8MB→−3.7MB。
- **测试基建**：`pnpm test:v4-perf` 单命令聚合全部本期 blocking 测试（125 项），测试文件纳入根 typecheck 工程。

### 修复

- **v0.1.1 全量代码评审的 22 条 must-fix**：无行变更帧引用复用、共享缓存 (scopeKey, phase) 口径统一、rail 可见性单一真源、rowElementRegistry 跨 pane 撞号过滤、跳转 loading 接入 aria-busy 与禁点、目录翻页截断显式提示等，全部落地并通过独立终验（22+1 条矩阵 + 四门禁复跑）。
- **升级兼容**：旧版本 provider 缓存含已删字段（access.accountType/mode）时按随包基线回落，不再「模型配置加载失败」；bootstrap 严格模式编译错修复。

### 已知限制

- macOS 安装包未签名/未公证，首次打开需右键 → 打开。
- GitHub Release 单文件上限 2 GiB：超限产物不上传 Release，仍在 workflow 的 Artifacts 中完整保留。
- CLI 单文件（SEA）运行时仍需显式加载层（推迟项）。

## v0.1.1（2026-10-05）

### 新增

- **免登录完整使用**：只配置外部 API（DeepSeek、OpenCode Go、bigmodel-api key 等自定义 provider）不再被首启欢迎页强制选择品牌身份或登录，直接进入主界面；会话、工具调用、设置全部可用。不登录仅缺少账号态功能（剩余额度/Pro 展示、Coding Plan 订阅管理、官方 MCP 配额、会话分享），均静默降级。
- **`/ctx-*` 命令接入桌面端**：`/ctx-status`（状态快照）、`/ctx-reduce`（排队回收上下文）、`/ctx-expand`（取回已丢弃内容）、`/ctx-recomp`（分舱重算）在桌面 composer 输入 `/` 即可见、可执行，结果以底部信息浮层展示（状态快照常驻可手动关闭）。与 CLI/TUI 共用同一份实现，行为一致。
- **发布自动化**：推送 `v*` tag 即自动构建并发布四平台安装包——macOS（dmg + zip，arm64/x64）、Windows（NSIS exe）、Linux（AppImage / deb / rpm / pacman）——并附到 GitHub Release。

### 修复

- **设置页「折叠模型」无法设置**：选中任何模型都被静默清空（模型选择器编码与落盘格式的转换不对称），保存按钮永不点亮。已修复并补转换链测试锁定。
- **magic-context 设置改自动保存**：移除「保存 / 放弃修改」按钮，任何改动自动写盘并即时生效；保存失败弹提示并回滚到上次成功状态。
- **v0.1.0 全量代码评审的 33 条修复**，要点：
  - `magicContext.enabled = false` 时 transform 直通且不再打开/创建 magic-context 数据库（此前存在不生效与多余落盘两类缺陷）
  - 内置市场 CDN 旧 id 别名容忍——官方市场刷新必败的问题修复
  - `workspace/updateMagicContextConfig` 拒绝空 config，杜绝整域静默重置
  - 设置页清空「Token 覆盖」只摘除 default 分支，不再误删用户已有的 per-model 键
  - 生命周期/中断守卫、协议信封校验、UI 无障碍标注、品牌与合规文档口径等其余各项

### 已知限制

- macOS 安装包未签名/未公证，首次打开需右键 → 打开。
- GitHub Release 单文件上限 2 GiB：超限产物不上传 Release，仍在 workflow 的 Artifacts 中完整保留。
- CLI 单文件（SEA）运行时仍需显式加载层（推迟项，计划 v0.1.1+ 版本处理）。

## v0.1.0（2026-10-04）

首个可用版本：magic-context 上下文管理 MVP（裁剪/折叠/分舱、historian 旁路模型、执行阈值与预算参数域、用户级配置与设置页、`/ctx-*` 命令）；移除上游 `/compact` 链路（由 magic-context 取代）；品牌由 ZCode 过渡为 omz；tarball + install.sh 主分发通道与 E2E 终验通过。

## v0.1.0 之前

继承上游 ZCode v3.14.3 基线（tag `baseline/v3.14.3`）：phase1 移除遥测并完成基线评审修复；phase2a magic-context MVP；phase2b 移除 compact。
