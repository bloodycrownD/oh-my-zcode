---
date: 2026-10-08
agile_trace: true
---

# omz-logo-skin 实现规格（SPEC）

## 根因 / 方案摘要

原 Z 字标以两种矢量形态、7 个渲染点存在：形态 A（单字 Z 三笔 path，5 处内联拷贝：ZCodeAboutLogo.tsx / RootStartupLoading.tsx / aboutWindow.ts / renderer/index.html / web/index.html）与形态 B（logo-zai.svg 深色圆角方壳 18×18，被 app logo 与 Z.ai 供应商图标共用）。仓库无任何 SVG→PNG/ICO 工具链（无 sharp/resvg/electron-icon-builder）。

方案：新建 `scripts/generate-omz-brand-assets.mjs` 作为字标几何唯一事实源——参数化构造 O（切角方环，evenodd 内外八边形，角切方向与 Z 笔画末端斜切一致）、M（双竖笔 + 两条斜笔底部会聚，斜笔水平厚 48 与 Z 粗对角线同一手法）、Z（原三笔 path 逐字沿用），发射 SVG 与栅格化产物；纯 Node 扫描线栅格化（even-odd + 4x 超采样 + zlib PNG 编码 + PNG 内嵌 ICO 容器），不引入依赖。

实现中发现并修复两个几何 bug：①平移 path 时只移了 M 命令起点没移 L/H/V 绝对坐标（改为统一「折线化→平移点→再发 path」）；②M 斜笔交叠区在 even-odd 栅格化下会掏洞（改为 O 环成组 even-odd、M/Z 子路径独立叠加填充；SVG 侧 M path 用 nonzero 子路径天然并集）。

## 变更点清单

| 位置 | 变更 |
|---|---|
| scripts/generate-omz-brand-assets.mjs（新增） | 字标几何 + SVG 发射 + PNG（16..1024 九档、icon.png 留边 / icon_windows.png 满幅）+ icon.ico（7 尺寸 PNG 内嵌）+ ASCII 目检输出；默认写仓库外目录，人工过目后拷贝 |
| packages/ui/src/assets/app-logo.svg（新增） | 形态 B：沿用 logo-zai.svg 的方壳/描边 path，内部 OMZ 白色字标（g transform 缩放进壳） |
| App.tsx / WindowsTopLeftLogo.tsx / WorkspaceSidebarCollapsedRail.tsx | import 从 logo-zai.svg 改指 app-logo.svg（DesktopTopOverlay 经 props 间接生效）；alt 改 "omz" |
| ZCodeAboutLogo.tsx / RootStartupLoading.tsx / aboutWindow.ts / renderer/index.html / web/index.html | 形态 A 三 path 换 OMZ（viewBox 0 0 776 218；web 版保留逐 path `<animate>` 结构）；展示宽度按新宽高比 3.56:1 调整（w-14→w-16、56→64px、30→34px、w-8→w-10） |
| ConversationDraftEmptyState.tsx / assets/Z.svg | 空状态明（线框 currentColor+遮罩渐隐）/暗（渐变描边+模糊幽灵副本）两套换 OMZ，g transform 缩放进 400×320 / 436×360 画布 |
| apps/zcode-cli/packages/tui/src/app-empty-transcript.tsx | ZCODE_LOGO_LINES 六行 ASCII "ZCODE"→"OMZ"（长度驱动的高度逻辑不变） |
| build/icon.png、icon_windows.png、build/icons/{16..1024}×9、build/icon.ico、packages/web/public/favicon.ico、public/logo/icons/*（png+ico） | 再生成拷贝（三份 ico 原本同哈希，同步换） |
| packages/web/index.html | 内嵌 base64 favicon 换新 32×32；`<title>` → omz |
| renderer/index.html、cua-permission-panel.html | `<title>` → omz / omz Computer Use |
| packages/desktop/package.json | description/author/productName → omz |
| OnboardingWelcomeView.tsx | aria-label "ZCode"→"omz" |

保留不动：logo-zai.svg（Z.ai 供应商图标）、logo-zai-square.svg、ZCodeWordmarkLogo（未使用）、MODEL_PROVIDER 图标。（原列于保留清单的 icns×3、icon_installer.*、dmg_background×2 已于 4a19e57（v1.0.1 tag）重绘并复用应用方标，该条保留声明失效。）

## 详细改动说明

- OMZ 几何参数：H=218、笔画厚 T=32、角切 (30.4,32)、M 斜笔斜率 0.42/水平厚 48、字间距 44、总宽 776（O176+M256+Z256）。
- Z 的三笔 path 中顶部横笔的退化贝塞尔（回程曲线）简化为直线闭合，其余曲线逐字保留。
- 图标构图：方壳 0.1837..17.3163（半径 2.7316）黑→#151718 垂直渐变 + 0.367 厚 #B7BCBF 外描边环 + OMZ 白字标占宽 14.4/18；icon.png 留 7% 透明边、icon_windows 满幅。
- 第三方 inventory.json 中 ZCodeAboutLogo.tsx 的 sha256 会漂移（licenses/notices 消费，无哈希强制校验）——已登记，未重生成。

## 测试策略

- ASCII 覆盖图目检（O 环孔、M 会聚与计数器、Z 原形、笔画均衡）。
- 隔离渲染深/浅底预览 PNG；产物 PNG/ICO 头部字节校验；三份 ico 哈希一致性。
- 实机：dev 应用重启后任务栏/窗口图标、设置页/侧栏/启动页/关于页截图目检（CDP 通道）。

### 测试用例

1. `node scripts/generate-omz-brand-assets.mjs <dir>` 产出齐全且 wordmark.ascii.txt 字形正确。
2. dev 应用启动：任务栏图标 = OMZ 方标；侧栏 logo = OMZ；关于面板 = OMZ。
3. 浅色/深色主题切换：空状态水印两套均正常显示。

## 风险与回滚方案

- 字标为手工几何构造，审美上未经设计师评审；参数都在生成脚本顶部，可调后重跑。
- PNG/ICO 为 PNG 内嵌式 ICO（Vista+），Electron/资源管理器均支持；如遇旧工具兼容问题，改用 BMP 内嵌重打包。
- 回滚：git checkout 相关文件 + 重跑生成脚本前先备份旧图标（本次直接覆盖，回滚走 git）。
