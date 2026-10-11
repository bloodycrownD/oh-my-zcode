# CR Fix Spec: v1.0.1 发布 diff 评审（v1.0.0 → v1.0.1）

## 元信息
- repo：`D:\Dev\Js\oh-my-zcode\omz` ｜ base_sha：`3ec8617`（v1.0.0）/ head_sha：`f13e0e1`（v1.0.1）
- prd/spec：`docs/iterations/oh-my-zcode-fork/features/{add-model-fetch-and-presets,omz-logo-skin,prompt-language-option}/`、`bugs/readonly-provider-config-fallback/`、`omz/docs/specs/desktop-agent-bundle-externals.md`、`omz/docs/specs/desktop-app-rename-omz.md`
- review_round：1 → 3 ｜ dag_version：3（wave-1 scope×4 → 主代理 spec-fix r1 → wave-2 review-full（建议 ready，附修正）→ 主代理 spec-fix r2 吸收终审修正 → wave-3 增量补审 4a19e57）
- 状态：**已执行（dev-ready 2026-10-09）**——code-dev-loop 4 impl 并行 + 主代理 docs/fix 节点 + verify×2 + cr-func（首轮 no：补 DF-C-orch-1 单测与 PL-G-1 spec 登记后 delta 复核 yes）；全部 32 条落地，门禁与 40 个新测试全绿；工作区未提交待用户过目（base=4a19e57）
- doc-review（spec-check-loop）：r1 judge 全量抽验 ~70 锚点均命中、结论 Go，附带 10 条文档级修正（P0×3 引用错误/无默认分支、P1×4、P2×3）；主代理 doc-fix 已全部落盘（DF-A-1 默认路径、MD-B-1/AS2-A-1 默认姿态、AS2-B-2 重锚点、AS2-B-3 OQ 引用、BR-G-01 验收指向、MD-D-1/GL-A-1 双向联动、MD-A-2 全量清单、MD-B-3 回指、OQ-9 注）；**r2 复审：Go（execute-ready）——10/10 修正核实落盘，P0/P1=0，残余 P2×3 措辞（BR-G-01 括注、Detail.tsx 行号、本行占位）已随手清零**。
- 评审节点：wave-1 并行 readonly —— review-scope-desktop-fix / review-scope-brand / review-scope-prompt-lang / review-scope-model-fetch（全部 scope-ready: no）；wave-2 —— review-full（fix-spec 26 条锚点全查、建议 fix-spec-ready: yes）；wave-3 —— review-scope-brand-assets2（增量 4a19e57 补审，scope-ready: no，发现 AS2-B-1 等，已落盘）。主代理自查 release 提交琐碎面（CHANGELOG 准确性 / 版本号 / remoteWorkspaceServiceCollection.ts 死代码清理——`localApiClient` 全仓零引用，**通过**）。
- **范围注记（r3 终版）**：评审期间用户落了 `4a19e57`（mac icns/安装器图标/DMG 背景补齐，2026-10-09 00:51）并把 **tag v1.0.1 移到该提交、已推 origin**——v1.0.1 发布面实际 = `3ec8617..4a19e57`。本 CR 主体评 `3ec8617..f13e0e1`（5 提交），增量已由 wave-3 补审（AS2-* 条目）。已复核：4a19e57 改了脚本并重生成全部 PNG/ICO，但 BR-G-01 三项子问题（scale 精度/Z 折线化/无 `--check`）**均未被顺手修掉**；BR-G-01/BR-B-03 执行时以当前 HEAD 为基线重核行号。
- CRLF 噪音甄别（已验证，供执行者免重复排查）：`browserGuestManager.ts`（9268 行）纯 CRLF→LF 规整零实改；`electron-builder.config.js` 实改 19 行；`cua-permission-panel.html` 实改 1 行；`web/index.html` 实改 9/8 行。

---

## Must-fix（P0 → P1 → P2）

### DF-A-1 [P0]（评审员报 P1，主代理升级）打包版桌面下 CLI 侧随包基线解析不出，stale env 机器仍「启动即退」
- 维度：A + C-orch ｜ 来源：review-scope-desktop-fix/A-1
- 文件：`apps/zcode-cli/packages/cli/src/provider-runtime-env.ts:184-187`（候选仅 CLI dist / 仓库根两种布局）；对照 `packages/desktop/src/main/desktopProviderConfig.ts:25-29`、`packages/desktop/electron-builder.config.js:569-573,618-620`（打包态基线在 `resources/config/provider/zcode-builtin.json`，agent bundle 在 `resources/glm/zcode.cjs`）；旁证 `packages/services/src/node.ts:1841-1850`
- 问题：修复主路径依赖「无条件解析真实随包基线」，但候选清单缺桌面打包布局：dev 入口命中仓库基线（修复有效，与作者实测一致）；packaged 入口 `<app>/resources/glm/zcode.cjs` ① `<entryDir>/provider/` 不存在、② 上溯 5 层必然 miss → stale 显式值探针失败清空后两空 → 抛「无法定位 CLI ZCode Built-in Provider Config」→ 子进程退出。即带残留 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的机器上，**打包版仍复现本 bug 要修的「read-only 控制面/agent 启动即退」**。
- 升级理由：bug PRD「影响范围/预期行为」覆盖全桌面（含打包态）；CHANGELOG 已向用户宣称修复；桌面打包态是本项目唯一重要用户面（用户拍板）。**降级条件**：若用户裁定打包态不属本轮验收面 → 回落 P1（其余改法不变）；用户未拍板前按 P0 全文执行。
- 改法：
  1. 候选清单补桌面打包布局：`resolve(entryDirectory, "../config/provider/zcode-builtin.json")`（`resources/glm` → `resources/config/provider`，与 electron-builder `to:` 对齐）。
  2. C-orch 收敛（**默认路径**：抽公共函数 `resolveBundledZCodeBuiltinProviderConfigPath({entryDirectory,dataBaseDir,sea})` 到 `@zcode/provider-node`，CLI 与 `desktopProviderConfig.resolveDefaultZCodeBuiltinProviderConfigFilePath` 共用同一函数；若本轮不动 desktop 侧，则至少完成改法 1 并在 CLI 函数头留 TODO 引用本条目）。
  3. 可选兜底：CLI 解析失败时接受继承的 `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE`（`existsSync` 校验后）作最后候选（仅此一条不够，须与 DF-C-orch-1 一并处理覆盖关系）。
- 验收/测试：临时目录构造 `<root>/resources/glm/zcode.cjs` + `<root>/resources/config/provider/zcode-builtin.json`，跑 `prepareCliProviderRuntimeEnv`（stale 显式值）断言不抛、返回 BUNDLED=该基线、stderr 有回落告警；dev 两布局保持原断言。手工：打包产物内 `resources/glm/zcode.cjs app-server --stdio` 在带 stale env 的 shell 下存活并响应。

### DF-G-1 [P1] Built-in 回落修复零测试落盘
- 维度：G ｜ 来源：review-scope-desktop-fix/G-1
- 文件：无新增测试（`apps/zcode-cli/packages/cli/test/`、`packages/provider-node/test/` 均不存在；spec 自称 tsx 实测但零落盘）
- 问题：fallback 失效路径（回落告警、双候选皆坏重抛、成对探针失败、解析失败）全无回归网；DF-A-1 正是无测试才漏出。
- 改法：新增 `packages/provider-node/test/zcodeBuiltinFallback.test.ts` 与 `apps/zcode-cli/packages/cli/test/provider-runtime-env.test.ts`（node:test / `tsx --test` 风格，挂可执行脚本）。用例至少：① bundled 失效（旧 schema ZodError）+ fallback 有效 → read() 成功 + stderr 含回落告警；② bundled 失效 + fallback 缺失/同坏 → 抛原始 AggregateError 不二次包装；③ active 有效不触碰 fallback；④ CLI 主路径显式失效+基线可解析 → BUNDLED=基线；⑤ 成对路径显式可读原样透传/不可读落主路径；⑥ 基线不可解析+显式有效 → 不新增失败；⑦ packaged 布局候选解析（DF-A-1 回归锁）。
- 验收：`tsx --test` 全绿并纳入脚本。

### BR-B-01 [P1] web 运行时标题覆盖 index.html 的 omz，改动实际不生效
- 维度：B ｜ 来源：review-scope-brand/B-01
- 文件：`packages/web/src/main.tsx:256`（`document.title = "ZCode - Web"`）、`:276`（`"ZCode - Web + Server"`）
- 问题：web 入口启动后无条件重写 document.title，浏览器标签始终 ZCode，index.html 的 omz title 改动无效。
- 改法：两处改 `"omz - Web"` / `"omz - Web + Server"`，收敛为单一品牌常量防第三处漂移。
- 验收：加载 web 页（正常与 bootstrap 失败两条路径）断言 document.title 为 omz；`git grep "ZCode - Web"` 零命中。

### BR-G-01 [P1] 资产再生成管线输出与仓库资产不一致，PRD 重跑验收不可通过
- 维度：G（+B）｜ 来源：review-scope-brand/G-01
- 文件：`scripts/generate-omz-brand-assets.mjs:77`（fmt 仅 2 位小数）、`:205/:213`、`:166/:184`；对照 `packages/ui/src/assets/app-logo.svg:4` 与 5 处内联三 path
- 问题：① `boxScale=14.4/776=0.0185567` 经 fmt 变 0.02，生成的字标与仓库资产不同（重跑必然漂移）；② 脚本 Z 用折线化发射，仓库内联 Z 保留原 C 曲线；③ 无 `--check`/测试。4a19e57 改过该脚本并重生成资产，**wave-3 已确认三项子问题均未被顺手修掉**（锚点按当前 HEAD 有效）。
- 改法：(a) `scale(${boxScale.toFixed(7)})`（或内联 0.0185567）；(b)（r2 修正措辞）SVG 输出（form-a/form-b）的 Z 路径不再经 `flattenD`/`polyToD`，直接复用 `Z_PATHS_D` 原始 d 文本 + 组 transform，栅格化仍用 `zPolys` 折线点集；(c) 加 `--check <repoRoot>`：发射临时目录后与仓库映射比对——SVG/PNG/ICO/ICNS/DMG/内嵌 favicon 文件逐字节，5 处内联为 JSX/HTML 内嵌 path 非整文件、按提取的 `d` 串比对（form-a↔5 处内联、form-b↔app-logo.svg、icon-{s}.png↔{s}x{s}.png、icon.ico↔三份拷贝、32×32↔web 内嵌 base64），不一致退出非零；**（r3 扩展映射）**再纳入 `packages/desktop/build/icon.icns`/`icon_installer.{icns,ico}`/`dmg_background{,@2x}.png`，并断言 icns 内嵌 PNG 与对应尺寸源 PNG 逐字节一致（见 AS2-B-2）；(d) 输出名↔仓库名映射写入脚本注释。
- 验收：重跑 + `--check` 全绿（对应 omz-logo-skin prd.md:40「`generate-omz-brand-assets.mjs` 重跑产物与仓库资产字节一致（可重复再生成）」；spec.md:44 测试策略的「产物 PNG/ICO 头部字节校验；三份 ico 哈希一致性」为其子集）。

### PL-B-1 [P1] auto 语义热路径缺 Intl 探测，与冷启动分叉（Windows 中文系统热更新落英文直至重启）
- 维度：B（兼 A，对应 open spec_deviation）｜ 来源：review-scope-prompt-lang/B-1
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/prompt-language.ts:142-147`；对照 `app/runtime-config.ts:256-264` + `app/app-config-options.ts:60-87`（冷路径 env → `Intl.DateTimeFormat().resolvedOptions().locale`）
- 问题：Windows/GUI 启动下 LANG/LC_* 常缺位，冷启动靠 Intl 得 zh-CN；设置页选/回切 `auto` 时热路径只探测 env → en-US，运行中会话立刻变英文提示词，重启才恢复。PRD 测试用例 1「auto+中文系统→zh-CN」在此路径不成立。
- 改法：① `app-config-options.ts` 导出 `resolveIntlLocale()`（或 `detectAppLocale(env, intlLocale?)`）；② `PromptLanguageDependencies` 加 `intlLocale?` 注入缝，`resolveEffectivePromptLanguage` 改 `resolveLocale(promptLanguage, detectLocale({ env, intlLocale: intlLocale ?? resolveIntlLocale() }))`；③（推荐彻底单点）与 `runtime-config.ts` 的 `resolvePromptLanguage` 合并为一个导出函数两处共用；同步订正 `prompt-language.ts:137-140` 注释为事实。
- 验收/测试：断言 `auto + LANG=zh_CN.UTF-8 → zh-CN`、`auto + env 空 + intl zh-CN → zh-CN`、`auto + env 空 + intl en-US → en-US`、显式值透传；冷/热两路径对同一 (env,intl) 输出一致。
- spec_deviation 联动（r2 收紧闭合条件）：代码修复后**还须订正** `features/prompt-language-option/spec.md:36/:38`——:36 补 Intl 后成立；:38 已知边界收窄为「宿主 uiDetectedLocale 不透传到协议热路径」（冷路径仍优先 uiDetectedLocale，`app-config-options.ts:68-73`），此即 OQ-9 拍板项（spec 措辞收窄 vs 协议透传 detectedLocale，二选一）。仅当代码修复 + spec 订正（或用户确认收窄）后该 deviation 才 closed。

### PL-G-1 [P1] promptLanguage 新功能零常驻测试
- 维度：G ｜ 来源：review-scope-prompt-lang/G-1
- 文件：无（缺口；spec 只有「tsx 临时脚本 20 项断言」口头证据）
- 改法（均有现成模板）：
  1. `apps/zcode-cli/packages/bootstrap/scripts/test-prompt-language-rpc.mjs`（模板 `scripts/test-magic-context-config-rpc.mjs`）：断言三态 update 写盘且保留其它顶层键、每 resident session `configPort.set`/`runtime.updateConfig` 恰一次；非法值（"fr"/数字/null）→ -32602 且磁盘内存均未触碰；read 有 session 走 ConfigPort/无 session 读文件/缺省损坏回 "auto"；result schema round-trip。
  2. `apps/zcode-cli/packages/core/scripts/test-prompt-language-context.mjs`（模板 `scripts/test-sidecar-model-request.mjs`）：language=zh-CN/en-US/undefined 下断言 cli_prefix/identity 三段/dynamic_behavior/context_management/session_guidance/desktop 段（仅 presentationSurface=zcode_desktop）；同次构建的 memory/env-info/skills/工具描述仍英文；workflowActor 分支 zh 下全英文。
  3. `packages/services/test/promptLanguageDegradation.test.ts`：read 在 -32601 回 `{supported:false, promptLanguage:"auto"}`；update 在 -32601 抛可读错误。
- 验收：脚本进 `apps/zcode-cli` 测试族清单（UPSTREAM-SYNC.md 第 4 节同款门禁），spec 测试策略登记为常驻测试；PL-B-1 的 auto 断言并入。

### MD-G-1 [P1] 模型列表候选路径链零测试落盘
- 维度：G ｜ 来源：review-scope-model-fetch/G-1
- 文件：`packages/services/src/model-provider/providerModelList.ts:44-218`（spec 声称的「tsx 实测 5 分支」为一次性脚本，仓库不可复现）
- 改法：新增 `packages/services/test/providerModelList.test.ts`（node:test+assert/strict，`createProviderModelLister` 注入 fake fetch 作测试缝）：① openai 顺序 `{base}/models→{base}/v1/models→源站 /v1/models→源站 /models`；② anthropic 顺序 `{base}/v1/models→{base}/models→源站两条`，protocol 候选带 authorization+x-api-key+anthropic-version、源站仅 Bearer；③ 全 404 恰 4 次调用且错误含已试 label（r2 前置条件：baseUrl 须含路径如 `https://x.test/api`，否则源站候选与基址候选去重后不足 4 次）；④ 401 只 1 次调用且含「请检查 API Key」；⑤ `timeoutMs:20`+永不 resolve mock → 超时文案；⑥ 脏 payload 去重清洗 `[ "b","a","a","",42,{id:"c"},{model:"x"},null ] → ["a","b","c"]`、data 非数组 → []；⑦ 任一 throw 的 message 不含 apiKey 字符串。
- 验收：`npx tsx --test` 全绿。

### AS2-B-1 [P1]（r3 新增，增量提交核心交付物）DMG 背景箭头纵向错位：箭头不指向图标行
- 维度：B + C ｜ 来源：review-scope-brand-assets2/B-1
- 文件：`scripts/generate-omz-brand-assets.mjs:538`（`const ay = 300 * scale;`，箭头块 537-548）；联动 `CHANGELOG.md:10`「重绘同构图」
- 问题：DMG `contents` 图标行在 y=220（`electron-builder.config.js:730-736`，app 图标 (130,220)、Applications link (410,220)）。逐像素解码对比：旧背景箭头 y≈203（与图标行同排）；新背景箭头中心 y=300——比图标行低 80px，悬空落在图标标签下方，不指向「应用程序」；CHANGELOG「同构图」不成立。属明确回归。
- 改法：`const ay = 220 * scale;`（与 contents 精确对齐；复刻旧构图取 203）；重跑脚本覆盖 `build/dmg_background{,@2x}.png`（@2x 等比 1080×760）；x 向不动。CHANGELOG「同构图」措辞随之成立。
- 验收：重生成后墨迹带箭头中心 y≈220；mac 实机 DMG 目检箭头指向图标行（并入合并后 QA）。

### DF-C-orch-1 [P2] fallback 未接进 agent spawn env 的 BUNDLED 通道（平行分叉）
- 维度：C-orch ｜ 来源：review-scope-desktop-fix/C-orch-1
- 文件：`packages/services/src/node.ts:1847-1850`；`apps/zcode-cli/packages/cli/src/provider-runtime-env.ts:136-143`
- 问题：BUNDLED 语义是「随包基线」但下发的可能是失效显式值；CLI prepare 又会覆盖——两通道无 parity 无互证。
- 改法：`[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: options.zcodeBuiltinProviderConfigFallbackFilePath ?? options.zcodeBuiltinProviderConfigFilePath` + 注释说明覆盖关系。**（r2 注记：非纯防御性）** 成对显式早退路径（`provider-runtime-env.ts:80-85`）不返回 BUNDLED——打包桌面下会继承 `node.ts:1850` 注入的（可能 stale 的）BUNDLED，Agent 侧 registry（`process-provider-registry-runtime.ts:38-46`）把它当 bundled 基线、Active 坏即整段判死；不得以「DF-A-1 方案 2 已收敛」为由省略本条。
- 验收：断言桌面 child 的 BUNDLED 指向打包基线（env 构造抽纯函数后单测）。

### DF-C-1 [P2] 成对路径探针有文件系统写入副作用
- 维度：C（+B）｜ 来源：review-scope-desktop-fix/C-1
- 文件：`apps/zcode-cli/packages/cli/src/provider-runtime-env.ts:68-79`
- 问题：探针经 `NodeZCodeBuiltinProviderConfigSource.read()` 会 `mkdir`+`withFileLock` 在（可能属于另一旧安装的）用户目录创建 lock 目录，且每次拉起都走一次；纯校验不应写盘。
- 改法：改无写入校验 `readFile`+`JSON.parse`+`decodeZCodeBuiltinRelease`（`@zcode/provider-node` 已导出），catch 即失效；删探针的 source 构造与 `dispose()`。
- 验收：单测指向不存在目录的显式值执行后目录未被创建；判定结果与旧探针一致。

### DF-C-2 [P2] electron-builder.config.js 整文件 CRLF 化（746/737 噪音 diff）+ `*.js` 未锁 LF
- 维度：C ｜ 来源：review-scope-desktop-fix/C-2
- 文件：`packages/desktop/electron-builder.config.js`（`git ls-files --eol` = i/crlf w/crlf，BASE 为 LF）；`.gitattributes`
- 改法：以 `git show 3ec8617:<path>` 为基底重放本提交 19 行实改还原 LF；`.gitattributes` 补 `*.js text eol=lf`（或至少该文件单列）。
- 验收：`git diff --numstat 3ec8617 f13e0e1 -- <file>` 与 `--ignore-cr-at-eol` 版本一致（≈14/5）。

### BR-B-02 [P2] CUA 权限面板 title 被运行时文案覆盖（HTML 改动未生效）
- 维度：B ｜ 来源：review-scope-brand/B-02
- 文件：`packages/desktop/src/renderer/cuaPermissionPanelMessages.ts:17,:26`（仍 ZCode Computer Use 权限/Permissions）；`cua-permission-panel.html:123`（appName 兜底残留）
- 改法：documentTitle 改 `"omz Computer Use 权限"`/`"omz Computer Use Permissions"`；html appName 兜底同步。**不要**动 CUA helper 应用名（`packages/zcode-cua/broker-helper-constants.js:1`，macOS TCC 身份）。
- 验收：`git grep "ZCode Computer Use"` 本面板链路仅剩 helper 常量。

### BR-B-03 [P2] app-logo.svg 灰色描边环控制点抄错
- 维度：B ｜ 来源：review-scope-brand/B-03
- 文件：`packages/ui/src/assets/app-logo.svg:3`、`scripts/generate-omz-brand-assets.mjs:212`（脚本为声明源，两处同改；4a19e57 后先重核行号）
- 改法：`C17.5 2.13652 17.1969 2.13652 16.6461 0.853871` 改回 `C17.5 2.13652 17.1969 1.40459 16.6461 0.853871`（第二控制点 y 抄重了 cp1，右上外环变形）。
- 验收：与 `provider-icons/logo-zai.svg` 壳 path 除填充外一致。

### BR-C-01 [P2] 空状态明/暗线框有效线宽约为原设计一半
- 维度：C/B ｜ 来源：review-scope-brand/C-01
- 文件：`packages/ui/src/v4/ConversationDraftEmptyState.tsx:232`（scale 0.48582 组）、`packages/ui/src/assets/Z.svg:9`（scale 0.51546 组）
- 改法：light 组加 `strokeWidth={2.06}`（1/0.48582）、Z.svg 描边组 `stroke-width="1.94"`（1/0.51546）；若有意变细则显式写死并登记 spec。
- 验收：与 v1.0.0 同尺寸渲染对比线重一致。

### BR-C-02 [P2] 本提交触及文件内的陈旧品牌注释
- 维度：C ｜ 来源：review-scope-brand/C-02
- 文件：`packages/desktop/scripts/desktop-product-identity.mjs:55,72`、`packages/desktop/src/main/desktopRuntimeEnv.ts:55`、`packages/ui/src/v4/ConversationDraftEmptyState.tsx:2`、`packages/desktop/src/renderer/cua-permission-panel.html:52`
- 改法：品牌词 ZCode→omz（标识符 `ZCODE_*`/`@zcode/*`/`zcode://` 保持原样；`desktopRuntimeEnv.ts:66` 的 `~/ZCodeProject` 仍准确勿改）。
- 验收：上述文件 `git grep "ZCode"` 仅剩标识符匹配。

### PL-A-1 [P2] FORK 登记未按硬约束 4 字段成块（上游移植区合规）
- 维度：A/C ｜ 来源：review-scope-prompt-lang/A-1
- 文件（8 处）：`core/src/context/sections/cli-prefix.ts:4-5`、`sections/desktop.ts:3-4`、`sections/identity.ts:4-7`、`context/dynamic-sections.ts:3-4`、`context/builder.ts:103-105`、`context/types.ts:123-127`、`runtime/types.ts:234-240`、`context/prompt-copy-zh-cn.ts:1-18`
- 问题：登记存在但缺「源位置」「上游语义」字段；builder.ts 一条注释未列 6 个调用点改动面；prompt-copy-zh-cn.ts 无段→上游文件映射。
- 改法：按仓内范式（`magic-context/src/core/hooks/magic-context/transform.ts:1221-1240` 三段式）升级 8 处：补「源位置：上游 ZCode v3.14.3 `core/src/context/<file>`」与改动前语义；builder.ts 列调用点（:107/:124/:135/:140/:149/:171）；只改注释不动代码排版。
- 验收：每处含 4 字段；diff 无代码行变更。

### PL-B-2 [P2] `isChinesePromptLanguage` 不认 `zh_CN` 等 POSIX 风格标签
- 维度：B/C ｜ 来源：review-scope-prompt-lang/B-2
- 文件：`apps/zcode-cli/packages/core/src/context/prompt-copy-zh-cn.ts:24-28`
- 改法：`const normalized = language.trim().toLowerCase().replaceAll("_", "-");`（一行；不为 core 加 `@zcode/i18n` 依赖），注释改「对齐 normalizeLocale 的 `_`→`-` 与 zh* 规则」。
- 验收：并入 PL-G-1 core 测试——`zh_CN`/`zh-TW`/`ZH`→true，`en`/`auto`/undefined→false。

### MD-A-1 [P2] 删组件后遗留 10×2 孤儿 i18n key
- 维度：A（i18n）｜ 来源：review-scope-model-fetch/A-1
- 文件：`packages/ui/src/i18n/locales/en-US.ts:2857-2864,2901-2903` 与 `zh-CN.ts:2673-2680,2712-2714`
- 问题：删 StartPlanCard/BigModelRegistrationHint 后 10 个 key 两语言零引用（quotaSectionTitle/eligibleNewUser/preview.*/entitlementSummary.*/entitlementGroup.*/codingPlan.bigmodel.unregisteredHint/registerAction）。
- 改法：两语言**各删 10 个 key**（r2 行数订正：en-US 11 行 = 2857-2864 + 2901-2903；zh-CN 11 行 = 2673-2680 + 2712-2714；`unregisteredHint` 值跨 2 行），parity 保持相等（5901→5891），spec 登记「coding-plan 复用需重新加 key」。父提交已无消费者的 `startPlan.title/meta.today/meta.tomorrow/status.*/highlight.*`（非本提交引入）可同批清理或登记，由用户拍板（见 OQ-14）。
- 验收：parity 相等；被删 key 全仓零引用。

### MD-A-2 [P2] `presetLoading`/`customLoading` 恒等死 alias
- 维度：A ｜ 来源：review-scope-model-fetch/A-2
- 文件：`packages/ui/src/settings/ModelProviderSection.tsx:880-881`、`model-provider-section/Navigation.tsx:61-70`、`SectionLayout.tsx:25-30`（`presetLoading` **全量删除**，出现处：ModelProviderSection:880/899；Navigation:63/67/329/337/361；SectionLayout:12/26/29/36/49/79）
- 改法：删 `presetLoading` 及传递，收敛单一 `providerListLoading`；删 Navigation 的 `groupId === "preset"` 分支与对应 prop；**（r2 补）**同批删 `Detail.tsx:135-140` 不可达的 `selectedNavItem.type === "preset"` 分支（`useModelProviderNavigation` 零 preset 引用，导航已不产出 preset item）。
- 验收：`git grep presetLoading` 零命中；`Detail.tsx` 无 preset 分支残留。

### MD-A-3 [P2] ProviderPlaceholderCards.tsx 文件尾缺换行
- 维度：A ｜ 来源：review-scope-model-fetch/A-3
- 改法：补结尾 LF（对该文件跑包内 oxfmt 即可）。

### MD-B-1 [P2] `effectiveConfig.api.headers` 被丢弃，legacy 导入的自定义鉴权头不上行
- 维度：B ｜ 来源：review-scope-model-fetch/B-1
- 文件：`packages/services/src/model-provider/providerModelList.ts:146-162` + `providerRuntime.ts:73-84`
- 问题：legacy 导入保留自定义 headers 的 provider 拉列表会 401 且提示「请检查 API Key」误导。
- 改法：`ProviderModelListSource` 增 `headers?`，readSource 传 `provider.effectiveConfig.api?.headers`；fetchCandidate 先展开 source.headers 再用显式鉴权头覆盖同名；补「自定义头随请求发出」用例。**（r2 验收补充）**日志/错误不得包含自定义头值（headers 可能含 x-api-key 类秘密），断言并入 MD-G-1 用例。
- 注意（**默认**：按改法执行，即纳入 headers）：PRD 只承诺 baseUrl+apiKey；仅当用户明确拍板不做时才走登记路径（登记 spec 边界并保留错误文案不误导——与 MD-B-2 的文案修正联动）。

### MD-B-2 [P2] 两处错误文案失真（超时报成 JSON 错；全链 405 报 404）
- 维度：B ｜ 来源：review-scope-model-fetch/B-2
- 文件：`packages/services/src/model-provider/providerModelList.ts:80-82,94-96,175-185`
- 改法：signal 传入 `readModelIdsFromResponse`，catch 先判 `signal.aborted`/AbortError 复用超时文案，否则报「HTTP ${status}，响应不是合法 JSON」；全链失败改「未找到模型列表端点（已尝试 …）」附最后 status。
- 验收：并入 MD-G-1 用例（超时/405/空 body 三分支）。

### MD-B-3 [P2] 「API Key 不经过 renderer」注释与事实不符
- 维度：B/DOC ｜ 来源：review-scope-model-fetch/B-3
- 文件：`packages/services/src/model-provider/providerFacadeServices.ts:76-80`、`providerRuntime.ts:27-31,68-69`、`providerModelList.ts:18`
- 改法：三处注释改为真实性质「renderer 不把 key 交给主机组请求，主机本地读取；返回值仅模型 ID」（`getView().effectiveConfig` 本就携带 key 且 renderer 表单直接读取）；同批订正 `CHANGELOG.md:16` 措辞（GL-A-1）。

### MD-C-1 [P2] combobox 关闭态竞态 + 焦点丢失候选
- 维度：C ｜ 来源：review-scope-model-fetch/C-1
- 文件：`packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx:105-111,130,267-274,288-298`
- 问题：关闭弹窗的 effect 不清 `modelsPickerOpen`；fetch 在关闭后 resolve 会把候选写进已关闭（下次打开）的弹窗；已展开时点输入框会经 Trigger 语义关掉 Popover 丢候选。
- 改法：关闭 effect 加 `setModelsPickerOpen(false)`；`handleFetchModels` 用 seqRef/AbortController 守卫（`seq !== seqRef.current || !openRef.current` 则丢弃）；`onOpenChange(false)` 时若 `document.activeElement === inputRef.current` 则忽略关闭（或改 `PopoverAnchor` + 显式 outside/blur 语义）。
- 验收：手测关闭后重开无旧候选闪入；展开态点输入框定位光标不丢候选。

### MD-C-2 [P2] combobox 键盘不可达（纯鼠标路径）
- 维度：C ｜ 来源：review-scope-model-fetch/C-2
- 文件：同上 `:277-303,312-365`
- 改法：输入框补 `role="combobox"`/`aria-expanded`/`aria-controls`/`aria-activedescendant`（CommandList 赋 id）；onKeyDown 在 picker 打开时接管 ArrowDown/Up（activeIndex 切换）、Enter（填入并关闭）、Escape（关闭并 stopPropagation 防连锁关 Dialog）；或输入框作 `CommandInput` 移入 Command 复用 cmdk 键盘逻辑。
- 验收：纯键盘完成「聚焦→弹候选→上下选→回车填入」。

### MD-C-3 [P2] wheel 事件 preventDefault 在被动监听下无效
- 维度：C ｜ 来源：review-scope-model-fetch/C-3
- 文件：同上 `:138-148`
- 改法：保留显式 scrollTop 驱动，删无效的 preventDefault/stopPropagation 并修正注释（与既有 RemoteConnectionFields 范式一致所以仅 P2）。

### MD-D-1 [P2] spec/PRD 文本与实现终态漂移（文档同步）
- 维度：A ｜ 来源：review-scope-model-fetch spec_deviations #1/#2/#6
- 文件：`docs/iterations/oh-my-zcode-fork/features/add-model-fetch-and-presets/{prd,spec}.md`
- 改法：spec 补记第 5 个 key `fetchModelsNoMatch`（两轮反馈定型 combobox 的产物；spec:42 实机证据「渲染芯片并点选填入」标注为历史证据）；PRD 同步 2 处：:17（范围说明——「密钥不经过 renderer」按主机侧口径改写见 GL-A-1，「芯片点选填入」→「可输入下拉」）、:29（验收标准 3「并点选填入」→「点选或回车填入」）；spec「providerListLoading」与 MD-A-2 收敛后口径一致。#3（同 pathspec 打包跨主题改动）仅登记无需动作。
- 验收：文档与实现一致，无歧义表述。

### GL-A-1 [P2] CHANGELOG「密钥不经过 renderer」声明与事实不符
- 维度：A ｜ 来源：review-full（GLOBAL-A-1，r2 新增）
- 文件：`CHANGELOG.md:16`
- 问题：renderer 本就持有并直接读写 apiKey（`packages/ui/src/lib/providerSettingsFormTypes.ts:57`、`packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts:55`）；拉取的真实性质只是「key 不作为该 RPC 参数、由主机本地读取」。与 MD-B-3 同因。
- 改法：改写为「拉取请求由主机侧发起（走代理/CA 传输层），API Key 不作为 RPC 参数传递」；与 MD-B-3 同批执行，并同批订正 `docs/iterations/oh-my-zcode-fork/features/add-model-fetch-and-presets/prd.md:17` 的同因表述（跨仓文档，改法见 MD-D-1）。
- 验收：CHANGELOG 措辞与实现事实一致；`git grep "密钥不经过"` 在 omz 仓与 docs/ 下均零命中。

### AS2-B-2 [P2]（r3 新增）icon.icns 小尺寸/@2x 档位相对旧资产回退
- 维度：B + G ｜ 来源：review-scope-brand-assets2/B-2
- 文件：`scripts/generate-omz-brand-assets.mjs:484-489`（`ICNS_PNG_ENTRIES`，现行仅 ic07..ic10=128/256/512/1024；相关注释在 :482-483）
- 问题：旧 icon.icns 含 ic04/ic05/ic07..ic10 + **ic11(32)/ic12(64)/ic13(256)/ic14(512)**，新文件只有 ic07..ic10——16pt/32pt 与 @2x 原生槽位缺失，macOS 只能降采样（Finder 小图标清晰度下降）；且 :482-483 注释未说明 ic11..ic14（32/64/256/512 的 @2x 槽位）语义，易被误读为 512 的 @2x 由 ic09 承担（实为 ic10=1024）。
- 改法：`ICNS_PNG_ENTRIES` 追加 `{type:"ic11",size:32},{type:"ic12",size:64},{type:"ic13",size:256},{type:"ic14",size:512}`（可选再补 icp4=16/icp5=32）；同时订正 :482-483 注释为「ic07..ic10 = 128/256/512/1024px；ic11..ic14 = 32/64/256/512px @2x 槽位」；重生成 `packages/desktop/build/icon.icns`/`icon_installer.icns` 并同步 `public/logo/icons/icon.icns` 拷贝。
- 验收：解析 icns chunk 清单含新档位且内嵌 PNG 与对应源 PNG 逐字节一致；并入 BR-G-01 `--check`。

### AS2-A-1 [P2]（r3 新增）dmg 卷图标注释与新资产语义相反 + icon_installer.png 无消费方
- 维度：A + C ｜ 来源：review-scope-brand-assets2/A-1
- 文件：`packages/desktop/electron-builder.config.js:728-729`
- 问题：注释仍写「避免复用应用图标」，但 `icon_installer.icns`/`.ico`/`.png` 已与 `icon.*` 逐字节相同、CHANGELOG 明言「统一复用应用方标」——三方矛盾；`icon_installer.png` 无任何消费方（仅生成脚本引用）。
- 改法：注释改为「安装盘/安装器图标统一复用应用方标（macOS 卷图标与 NSIS 安装器同视觉）」；处置 `icon_installer.png`（**默认**：保留，并在脚本注释注明「DMG 装饰素材备份，electron-builder 未消费」；经用户确认后再删文件）。
- 验收：注释/资产/CHANGELOG 三方一致。

### AS2-B-3 [P2]（r3 新增，闭合 omz-logo-skin spec:27 deviation）web 内嵌 favicon 与重生成 32×32 不一致
- 维度：B ｜ 来源：review-scope-brand-assets2（spec_deviation 3 / 见 OQ-6）
- 文件：`packages/web/index.html`（内嵌 base64 favicon 为 767B 旧 32×32）↔ `packages/desktop/build/icons/32x32.png`（4a19e57 后 693B）
- 问题：`omz-logo-skin/spec.md:27` 变更点「web 内嵌 favicon 换新」在 4a19e57 重生成后再度失配。
- 改法：以当前 32×32.png 重新生成内嵌 base64 写回 index.html；纳入 BR-G-01 `--check` 的 32×32↔web 内嵌映射防再漂移。
- 验收：解码 index.html 内嵌 favicon == 当前 32x32.png 逐字节。

### AS2-D-1 [P2]（r3 新增）omz-logo-skin PRD/spec 的「mac 图标不做」声明过时（文档同步）
- 维度：A ｜ 来源：review-scope-brand-assets2（spec_deviation 1）
- 文件：`docs/iterations/oh-my-zcode-fork/features/omz-logo-skin/prd.md:20`（「不做：macOS icns 与 DMG 背景重绘、icon_installer.*」）、`spec.md:32`（「保留不动：icns×3、icon_installer.*、dmg_background×2」）
- 问题：4a19e57 已完成这些项，PRD/SPEC 未随提交更新。
- 改法：两处状态订正 deferred → done（引用 4a19e57）；「不做」清单同步（若用户拍板 icon_installer 改安装专用视觉——AS2-A-1 的非默认路径——则再更新）。
- 验收：文档与资产现状一致。

---

## Spec deviations
- **open×1（闭合条件见 PL-B-1 r2 联动句）**：prompt-language spec「auto 语义：CLI 侧环境探测（LC_ALL/LANG/Intl）」vs 热路径仅 env → 须**代码修复 + spec 36/38 行订正**（或用户拍板收窄为 env-only/措辞收窄）方 closed；OQ-9 为前置拍板项，仅修代码不闭合。
- **文档同步（已写入 fix-spec）**：add-model-fetch-and-presets 的 4 条漂移 → **MD-D-1**；omz-logo-skin 的 mac 图标「不做」过时声明 → **AS2-D-1**；web favicon 变更点失配 → **AS2-B-3**（均同因同闭）。
- desktop-fix / brand（主体 5 提交面）：**none**（r2 复核成立）。

## Open questions / 待拍板（不阻塞）
1. [DF] 远端（SSH/WSL/Docker）host 与 zcode-server-cli 链路未接 `zcodeBuiltinProviderConfigFallbackFilePath`——远端机器 stale env 是否需覆盖？
2. [DF] `process-provider-registry-runtime.ts:33-38` 注释与现状不符（D-6 后实际不下发 Active 缓存路径），影响通道语义判断。
3. [BR] dev 身份分叉：`devElectronAppBundle.mjs` 仍 `ZCode Dev`/`dev.zcode.app.development` vs 运行时名已 `omz Dev`——是否统一（涉 dev TCC/协议注册）？
4. [BR] 双版本并存的右键键拉扯（旧版每次启动重加 `ZCode.OpenInZCode`、新版每次删）——是否接受？
5. [BR] 本 scope 外用户可见品牌残留：深链确认对话框（desktopDeepLinkRouter.ts:75-84 硬编码，rename spec 误标为 i18n）、CUA 浮层文案、macOS Finder workflow、Linux deep link 兜底——归属与优先级需拍板。
6. [BR] `4a19e57` 引入的新漂移：`packages/web/index.html` 内嵌 base64 favicon 仍是旧 32×32（`09f4412a`/767B），与重生成后的 `32x32.png`（`d05eaef9`/693B）不一致——范围外新发现，建议顺手修或并入 BR-G-01 的 `--check` 覆盖。
7. [PL] project 级 `promptLanguage`：schema 可写且优先级高于 user，但写入口固定 user 级——有意支持（补 parity）还是在 `normalizeProjectConfig` 剔除？
8. [PL] 热更新 fan-out 只达接收 RPC 的进程的 resident sessions，其它 workspace 已运行进程旧语言直至重建——PRD「运行中会话热更新」边界是否含跨 workspace？
9. [PL] 「auto 跟随宿主 UI 语言」口径：协议 agent 通道不传 detectedLocale，实际只有 env+Intl——spec 措辞收窄为「系统/进程 locale」还是后续透传 detectedLocale？**（r2 升级：PL-B-1 deviation 闭合的前置拍板项，不拍板则 deviation 停留 open；代码修复本身不阻塞——PL-B-1 可先按改法执行）**
10. [MD] 远端旧版 Host 无 `listProviderModels` 时 ProxyChannel 抛 Method not found 原样展示——需「远端版本过旧」文案？
11. [MD] 403 立即抛的产品假设（部分网关用 403 表未知路径）是否改「全链 403 才抛」？
12. [MD] 只认 `data[].id`：`{models:[...]}` 类结构显示「未获取到可用模型」而非可诊断错误——收敛即可还是加专门文案？
13. [MD] 15s 全链超时下慢网后段候选饥饿——需 UI 取消能力或单条超时？
14. [MD] `startPlan.title/meta.*/status.*/highlight.*` 等父提交既有孤儿 key 是否同批清理（并入 MD-A-1）？
15. [BR] 内部符号命名债（Z.svg 文件名、ZCode*Logo 组件名）——与「标识符不动」策略一致可接受，是否安排后续批量改名？
16. [GL] **发布事实确认（r2 新增）**：tag v1.0.1 已被移至 `4a19e57` 并推 origin——GitHub Release/产物是否按新 tag 重建过？若 Release 资产仍是 `f13e0e1` 时代构建，存在 tag 与产物错位（用户知晓即可，本 CR 无法判定）。后续修复一律计 v1.0.2。
17. [AS2] `renderPixels` 重绘语义变更（累加平均→source-over）波及**全部** Windows/web 图标（256×256 有 21054 个采样点差，方向判定为修复：层序与 app-logo.svg 一致）——CHANGELOG 未单列此像素级变化，是否在未发布段补记或认可现状？
18. [AS2] DMG `contents` 遗留越界坐标（非本提交引入）：`.background.tiff`/`.VolumeIcon.icns` 在 x=640 而窗口仅 540 宽（隐藏文件无可见影响）——是否顺手清进窗口内？
19. [AS2] 视觉终判留待 mac 实机：DMG 箭头位置（AS2-B-1 修后）、@2x Retina、icns 16/32pt 槽位表现无法在 Windows 机判——v1.0.2 发版前 mac 侧目检一次（已并入合并后 QA）。

## 已豁免（用户确认不修）
- 无。

## 合并后 QA（manual_user，不阻塞）
- **E2E 已执行（2026-10-09 03:5x，全 PASS）**：①DF stale-env CLI 四组（打包布局模拟/dev 布局/成对 env/对照——真实 bundle 存活+回落告警+探针零写入副作用，且本机 shell 实测带有真实 stale 变量对）；②桌面实机（带 stale env 重启 dev 桌面：启动存活+Registry 就绪+上下文管理分区渲染+模型语言 auto↔zh-CN 写盘往返+添加模型真实拉取（DeepSeek 源站 OpenAI 面回落生效）+combobox 键盘 ArrowDown/Enter 填入+竞态 50 采样零泄漏+设置页/关于面板品牌词零 ZCode）；③web 运行时标题 `omz - Web`（BR-B-01）。**E2E 新发现并已补修**：`packages/shared/src/desktopMenu.ts` 原生菜单/托盘裸品牌词（「关于 ZCode」/tray tooltip/「打开 ZCode」，zh+en 共 6 行）——原改名 spec 漏网项，与 BR-C-02 同类已顺手修复（parity/typecheck/lint/oxfmt 复验全绿；需下次桌面重启生效）。**遗留待 mac 实机**：DMG 箭头指向（AS2-B-1 修后）、@2x Retina、icns 16/32pt 槽位表现（OQ-19）。注意：dev 实例的 config.json 写入真实 `~/.omz/cli/config.json`（`getDefaultConfigPath()` 不受 ZCODE_DATA_BASE_DIR 重定向，既有已知行为，RULE.md 已登记）。
- 打包产物：带 stale `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的 shell 下 `resources/glm/zcode.cjs app-server --stdio --prepare-storage` 出 `startup/storagePath` 帧；设置页「上下文管理」分区正常读写（DF-A-1 端到端）。
- 桌面实机：设置页「模型语言」切 zh-CN 后**不重启**发下一轮对话验证中文提示词生效（PL-B-1 热路径）；「添加模型」拉取→过滤→键盘选中→回车填入全键盘路径（MD-C-2）。
- web 页标签标题为 omz（BR-B-01）；资产管线 `--check` 全绿后重跑一次确认仓库资产可复现（BR-G-01）。
- mac 侧（v1.0.2 发版前目检一次，OQ-19）：DMG 窗口箭头指向图标行（AS2-B-1 修后）、@2x Retina 背景清晰、icns 在 16/32pt 槽位表现（AS2-B-2 修后）。

## K 节建议（下游执行时闭合，本 skill 不自跑）
- 全部改动文件复核 LF（编辑类工具落 CRLF 的坑，见 RULE.md）；涉 `apps/zcode-cli` 子树的跑包内 oxfmt 判「零新增不合规」。
- DF-C-2 的 `.gitattributes` 变更后对既有 `*.js` 做 `git add --renormalize`。
- 修复完成后 CHANGELOG 未发布段补记（对应 v1.0.2）；GL-A-1 的 v1.0.1 段措辞订正同批；`4a19e57` 后 favicon 一致性（OQ-6）若修，一并入账。
- 根 `pnpm typecheck` / 根 lint（基线 71w/0e）/ `apps\zcode-cli && pnpm typecheck`（turbo 27/27）/ desktop 差分 typecheck——发布门禁口径照旧。

---

## Fix-Spec Closure

| 项 | 状态 |
|------|------|
| fix-spec-ready | **yes**（待用户确认开工） |
| fix_spec_path | `docs/iterations/oh-my-zcode-fork/cr-fix-spec-v1.0.1.md` |
| dag_version / review_round | 3 / 3（wave-1 scope×4 → spec-fix r1 → wave-2 review-full → spec-fix r2 → wave-3 增量 scope → spec-fix r3 定稿；未达 5 轮上限） |
| P0 / P1 / P2（已写入 fix-spec） | 1 / 7 / 24（合计 32 条） |
| 未写入的开放 must-fix | 0（五个评审节点 + review-full 全局维度的已认定项全数落盘） |
| spec_deviations | open×1：PL「auto 语义」（闭合路径已写入 PL-B-1，前置拍板项 OQ-9 二选一）；文档同步类均已写入（MD-D-1 / AS2-D-1 / AS2-B-3） |
| C-orch | ✅ 已查：DF 透传链分叉 2 项（DF-A-1/DF-C-orch-1）；PL 单点装配成立、仅 auto 双实现分叉（PL-B-1）；MD 单点链路成立；brand 主体 N/A（静态资产） |
| C 类合并后 QA | mac 实机目检（OQ-19）、stale env 打包产物验证、热切换中文提示词、combobox 全键盘操作（见「合并后 QA」节，均不阻塞） |
| manual_user | 未标阻塞；OQ-16（tag 移动后 Release 产物是否重建）需用户知晓 |
