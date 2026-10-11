# spec-check-loop · round 2 · judge（验证轮）

- 被审文档：`D:\Dev\Js\oh-my-zcode\docs\iterations\oh-my-zcode-fork\spec.md`（现 375 行，含新增「执行状态与勘误注记」节 L7-16 + 6 处行内注记）
- 仓库：`D:\Dev\Js\oh-my-zcode\omz` @ `aba59a9`（tag `v0.1.0`，HEAD 一致，已核）
- 上轮 must-fix：`cache/speccheck-v010-r1.md`（P0×1 / P1×6 / P2×3 = SP-01..SP-10）
- 本轮性质：**验证轮**——只判定 SP-01..SP-10 是否闭合 + 新增内容本身的事实一致性
- 方法：spec 全文重读 + 关键声明回代码/证据文件核对（git tag、config 链路、UI 组件、许可文件、数据目录、marketplace id 计数、iteration-state、cr-fix-spec MF 条目）

## 1）相对上轮

| 项 | 级别 | 状态 | 落点 |
|---|---|---|---|
| SP-01 许可事实错误 | P0 | **半闭合（残留 P0）** | 主修处 L260 已勘误为 MIT ✔；**L374 未改，仍写「Apache-2.0 双方（ZCode / magic-context）」✘** |
| SP-02 UsageQuerySource 判断 | P1 | 已闭合 ✔ | L240 【勘误】+ 代码核实：枚举已删 `compact`，唯一使用点 `session-store.port.ts:830` 为 `UsageQuerySource \| string`，零影响——勘误表述与代码一致 |
| SP-03 白名单缺 dynamic-workflow 占位 | P1 | 已闭合 ✔ | L303 Step 28 白名单补【执行注记】占位条目，与 L240 编辑型清单呼应，spec 内部矛盾消除 |
| SP-04 S29 三锚点失效 | P1 | 已闭合 ✔ | L304 三个锚点收窄；代码核实：`runSettingsActionAsync` 确在 `SettingsPage.tsx:112` 本地未导出；`MagicContextSettingsSection.tsx:204` 外壳为 `SettingsGroupCard`，全仓仅存 `SettingsResourceGroupHeader`（无裸 `SettingsResourceGroup`）——注记准确 |
| SP-05 /compact 命令面 | P1 | 已闭合（P3 落位瑕疵） | L254 明写「含用户可见 `/compact` 命令面（解析/路由/help/目录项）…T-M9 即目标行为」；瑕疵见 F3 |
| SP-06 S32 四既成事实 | P1 | 已闭合 ✔（含 1 处 P3 数字） | L254 ①②③④ + L16 EXEMPT-2a/2b；①②③ 经代码/证据核实（见 §3） |
| SP-07 执行状态缺失 | P1 | 已闭合 ✔ | L11-L13（完成矩阵 34/35、tag 链、cr-fix-spec 未执行 + MF-01 方向、契约 8 以 spec 为准） |
| SP-08 行号漂移 | P2 | 已闭合 ✔ | L14 统一注记「执行/重放以符号名为准」 |
| SP-09 验收矩阵状态 | P2 | 基本闭合（留 1 处 P3） | L13 T-M*/T-U*/T-P* 已标；**T-B1/T-B2/T-T1..T-T5 未列**（见 F4） |
| SP-10 S22 ctx-recomp 注记 | P2 | 未闭合，建议**豁免关闭**（见 F5） | — |

**统计**：9/10 已闭合，1 项半闭合（SP-01 残留），1 项（SP-10）为可选 P2 且代码注释已自证。

## 2）剩余问题

### P0（must-fix，1 条）

**SP-01R [P0] 许可声明第二处未勘误：兼容性节仍称 magic-context 为 Apache-2.0**
- 位置：`spec.md:374`「**上游合规**：Apache-2.0 双方（ZCode / magic-context）：保留 LICENSE 与版权头、NOTICE 标注修改、第三方声明重生成。」
- 证据：同仓 `apps/zcode-cli/packages/magic-context/LICENSE.magic-context` 明确记载 upstream `@cortexkit/opencode-magic-context 0.44.4` = **MIT，Copyright (c) 2025 Ufuk Altinok**；commit `27b7109` 已按 MIT 落地（LICENSE.magic-context + 33 处头注释订正）。全仓 `git grep -i Apache` 仅命中 L260 一处——即主修处；L374 是**唯一残留的错误事实**。
- 影响：与上轮 SP-01 同源。下游（合规复检 / 上游同步重放 / 第三方声明生成）若只读「兼容性与迁移说明」节，仍会按 Apache-2.0 处理 magic-context，与已落地的 LICENSE.magic-context 直接冲突。
- 方向：**b（spec 改）**，一行。
- 建议改法：L374 改为「**上游合规**：ZCode 为 Apache-2.0（根 LICENSE）；magic-context 上游为 MIT（见 `apps/zcode-cli/packages/magic-context/LICENSE.magic-context`，Copyright (c) 2025 Ufuk Altinok）；保留各自 LICENSE 与版权头、NOTICE 标注 fork 与修改、第三方声明重生成。」

### P3（不阻塞，3 条）

**F1 [P3] 执行注记 L256 的 marketplace id 计数与 HEAD 实测不符**
- spec L256【执行注记】：「实际落地 id 为 `oh-my-zcode-official`，全仓 17 文件 106 处」。
- HEAD 实测：`git grep -o "oh-my-zcode-official"` = **19 文件 / 109 处**（含 CONTEXT.md、NOTICE.md、UPSTREAM-SYNC.md、README 4 个文档文件；仅代码/配置为 16 文件 / 104 处）。
- 判断：数字为 S32 当时的快照，后续提交（s35 help 列 /ctx-*、CONTEXT.md 落盘）致漂移；**结论方向（id 字面量散布引用、非仅两份清单）成立**，仅计数过时。建议改为「17+ 文件 / 100+ 处」或标注「计于 S32，HEAD 已漂移至 19/109」。

**F2 [P3] EXEMPT-2b 的「7 处加载点」在登记源里对不上、且无法从代码验证**
- spec L16：「SEA 运行时需显式路径加载层，**7 处加载点**」。
- `docs/.iteration-state.yaml:52`（EXEMPT-2b 原文）：「需按 sea-playwright-runtime/tui-runtime-loader 范式补显式路径加载层 + **5 处静态 require** 改懒加载（v0.1.1）」。
- 代码实测：静态 `import ... from "@zcode/magic-context"` 共 **4 处**（`bootstrap/src/app/magic-context-historian.ts:68`、`magic-context-turn-transform.ts:140`、`magic-context-usage-summary.ts:33`、`zcode-protocol/magic-context-config.ts:3`），另 2 处已是懒加载（`cli/.../ctx.ts:98`、`core/.../ctx-context.ts:56`）。
- 判断：4/5/7 三个数字互不相同；该加载层尚未实现，「7 处」无代码依据。建议按 iteration-state 原文写「N 处静态 require 改懒加载」或去掉具体数字。

**F3 [P3] SP-05 的注记落在 Phase 3 标题下，与所注对象（D-7/Phase 2b）错位**
- 位置：spec L253 `### Phase 3 品牌与后端` 之后紧跟 L254【执行注记 2026-10-05 · D-7/S32 范围澄清】，前半句（`/compact` 命令面）属 D-7/Phase 2b，后半句（四事实）属 S32/Phase 3。
- 影响：读者按标题检索「Phase 3」会撞见 D-7 的说明，按「Phase 2b」检索则看不到「命令面消失即目标行为」这句验收口径（T-M9 的判据依据）。建议拆为两条注记分别置于 Phase 2b 节末（L238 后）与 Phase 3 节首（L254）。

**F4 [P3] 验收矩阵只覆盖 T-M*/T-U*/T-P*，基线与遥测门禁 T-B1/T-B2/T-T1..T-T5 无状态**
- spec L13：「T-M1..T-M12、T-U1、T-P1 已过…T-U2 与 T-P2 的 manual 部分留待实机…」。
- 事实侧这些用例均已执行（`.iteration-state.yaml:118` phase1_metrics：根 typecheck 0err / lint 71w0e / knip 719→718 / T-T1 白名单外代码级命中 0 / 构建成功；`cache/s13-*.log`、`p1-tt1-scan-clean.log` 为证；T-B1/T-B2 见 `phase_status:115` dev-ready + EXEMPT-1）。
- 影响：读状态节者会以为 Phase 1/0 门禁「状态不明」。建议 L13 补一句「T-B1/T-B2/T-T1..T-T5 随 Phase 0/1 完成（EXEMPT-1 记录 SEA host-only）」。

**F5（豁免建议，关闭 SP-10）[—] S22 ctx-recomp 未加注记，但代码注释已自证 spec 表述**
- iteration-state `:88`（s21）：「ctx-recomp 首版简化语义（runner 装配后自动切真实条数）」；spec L294 原文已写「首版可只做『触发一次 compartment 重算』的简化语义并在帮助文案注明」。
- 代码 `magic-context/src/host/ctx-recomp.ts` 头注释明写：「**这就是 SPEC 的『首版…简化语义』**…差别是：简化的是*执行*不是*表达*」，并已实现 `setMagicContextRecompRunner` 装配 + 真实重算条数回执（`recompacted`）。
- 判断：spec 表述与实现不冲突（无失实），SP-10 仅为「可补一句更精确」的措辞级建议。**建议本轮豁免关闭**，不再作为 must-fix 挂账。

## 3）抽查一致性（关键声明 vs 代码/证据）

| # | spec 声明（位置） | 核对方式 | 结论 |
|---|---|---|---|
| A | **MIT 事实**（L260 勘误：magic-context 上游 MIT、@cortexkit/opencode-magic-context 0.44.4、Copyright (c) 2025 Ufuk Altinok、S34 按 MIT 处理、33 头注释订正） | 读 `apps/zcode-cli/packages/magic-context/LICENSE.magic-context`（载明 upstream license: MIT / copyright / snapshot）+ `git show --stat 27b7109`（LICENSE.magic-context + 33 个头注释文件，commit 说明亦自陈「与上游实际 MIT 许可有出入…按实际处理」） | **一致**（唯一残留错误在 L374，见 SP-01R） |
| B | **双轨数据目录**（L254①：用户级 HOME 下 `~/.omz`（新起+首启提示，不迁移），工作区级 `<cwd>/.zcode` 刻意保留） | 用户级：`cli/src/data-dir-notice.ts:20 OMZ_DATA_DIR_NAME=".omz"`、`:22 LEGACY_DATA_DIR_NAME=".zcode"`、`provider-runtime-env.ts:76/:81`、`env.ts:138`。工作区级：`adapters/src/commands/roots.ts:13` 与 `adapters/src/skills/roots.ts:13` `const WORKSPACE_ZCODE_DIR = ".zcode"` 仍在；`shared/src/workspace-hook-config.ts:177/:235/:245` 仍用 `.zcode/config.json` | **一致**（双轨事实成立） |
| C | **MF-01 方向声明**（L12：契约 8 `effective = features && enabled` 代码未实现，方向为**代码修回 spec**，本 spec 契约不改） | ①`bootstrap/src/app/runtime-config.ts:190-192`：`magicContext.enabled` = `runtimeConfig?.magicContext?.enabled ?? configResult.config.features.magicContext`——只是 features 的镜像，非 `features && 用户配置`；②`core/.../magic-context-turn-transform.ts:210-211` 只判「端口在场」+ `config.magicContext?.enabled === false`，无 features 合取；③`core/.../runtime-tools.ts:89 includeMagicContextTools` 仅由 `magicContext?.enabled === true` 推导；④cr-fix-spec MF-01 问题陈述同源（`config.enabled` 全仓仅 `findConfigReadinessError` 读一次）。另：MF-01 已明确列为**尚未执行**（spec L12 与 cr-fix-spec 状态「fix-spec-ready」一致） | **一致**（方向声明正确：spec 契约未被动过，缺口挂在代码侧待 MF-01 修） |
| D | **tag 链与完成矩阵**（L11：S1-S30、S32-S35 = 34/35；链 `baseline/v3.14.3 → phase1/telemetry-removed → phase1/cr-fixed(1fa2d0e) → phase2a/magic-context-mvp → phase2b/compact-removed → v0.1.0`，v0.1.0 曾指 27b7109 后重指 aba59a9） | `git tag -l` 六个 tag 全在；`git rev-parse v0.1.0` = `aba59a9…` = HEAD；`phase1/cr-fixed` = `1fa2d0e…`（与 cr-fix-spec base_sha 一致） | **一致** |
| E | **MF-02 / T-P2 自动面失实**（L13「T-P2 自动部分（含 CDN 别名）经 CR 发现验收结论失实，随 cr-fix-spec MF-02 修复后复验」+ L254② 别名过渡语义） | `cache/phase3-final-e2e-report.md:489-492`「`4c8a580` 的『接受旧 CDN id 别名』在改名后仍然生效…CDN 分片刷新在本环境可达」；cr-fix-spec MF-02 指出该刷新路径别名分支永不可达、E2E B7 结论失实 | **一致**（CR 推翻 E2E 的裁定已在 spec 与状态节两处对齐） |
| F | **SEA 豁免口径**（L16：S35 build:sea 验收按 EXEMPT-2a/2b 理解为「资产面验证」） | `cache/phase3-final-e2e-report.md:75`「build:sea — EXEMPT-2（跨平台 runtime 解包失败）+ 一个必须修的真阻断」；`:124/:148` install.sh 演练本身全绿 | **一致**（仅 F2 数字瑕疵） |

**抽查未发现新增内容引入的事实性错误**：新增节 6 条声明中，5 条（A/B/C/D/E）经代码或证据逐条核实为真，第 6 条（F）口径正确但带 1 处数字瑕疵。

## 4）结论

**No-Go** —— SP-01 只改了一半：主修处（L260）已勘误为 MIT，但**「兼容性与迁移说明」L374 仍写「Apache-2.0 双方（ZCode / magic-context）」**，与仓内已落地的 `LICENSE.magic-context`（MIT，Copyright (c) 2025 Ufuk Altinok）直接冲突，属上轮 P0 同源残留；该条为一行 doc-fix 可闭合。

其余 9 项 must-fix（SP-02..SP-09）全部闭合且注记与代码事实一致，SP-10（可选 P2）经代码注释自证、建议豁免关闭；另留 3 条 P3 观察项（marketplace id 计数过时、EXEMPT-2b 加载点数字无据、SP-05 注记落位错位 + T-B/T-T 状态缺列），均不阻塞合入。

**下游放行口径**：仅需 doc-fix 处理 SP-01R（L374 一行）+ 建议顺带做 F3/F4（各一处短注记）；完成后本 spec 可判 spec-ready，供 cr-fix-spec-v0.1.0 执行（其 MF-01/MF-02 与本轮核对结论互不冲突，spec 侧不需再让）。