# spec-check-loop · round 3 · judge（终验轮）

- 被审文档：`D:\Dev\Js\oh-my-zcode\docs\iterations\oh-my-zcode-fork\spec.md`（现 **376 行**，上轮 375 行；doc-fix 把 D-7/S32 合写注记拆为两条，净 +1）
- 上轮结论：`cache/speccheck-v010-r2.md` — **No-Go**，唯一阻塞 SP-01R（L374 Apache-2.0 残留）+ P3 四条 F1..F4 + SP-10 建议豁免
- 本轮性质：**终验轮**——逐项验证 6 处 doc-fix 闭合 + 残留文本扫描 + 新引入问题排查
- 方法：spec 全文重读（376 行）＋ 关键声明回代码/证据核对（`git grep` 于 `D:\Dev\Js\oh-my-zcode\omz` @ `aba59a9`＝tag `v0.1.0` HEAD，已核；spec 本身在 `docs/` 不在 git 仓内，按要求用 Select-String 直搜）
- 结论：**Go**

## 1）逐项闭合验证（6/6 闭合）

| 项 | 级别 | 状态 | 落点与证据 |
|---|---|---|---|
| **SP-01R** L376 Apache-2.0 残留 | P0 | **闭合 ✔** | L376 已改为「上游许可实为 ZCode=Apache-2.0、magic-context=**MIT**（撰写时误判为『双方 Apache-2.0』，S34 已按实际处理）：保留各自 LICENSE 与版权声明、NOTICE 标注修改、第三方声明重生成（详见 `omz/NOTICE.md` 与 `…/magic-context/LICENSE.magic-context`）」。全文 `Apache` 命中仅 3 处：L21（`.reference/ZCode`＝Apache-2.0，**正确**）、L262（带勘误，正确）、L376（带勘误，正确）；另扫「双方 / 均为 / license / LICENSE」无第四处许可声明。仓内 `omz/LICENSE` 首行确为 `Apache License / Version 2.0`，`LICENSE.magic-context` 载明 `upstream license: MIT / Copyright (c) 2025 Ufuk Altinok / @cortexkit/opencode-magic-context 0.44.4`——与 spec 表述逐项对齐 |
| **F1** marketplace id 计数 | P3 | **实质闭合，留 1 处 P4** | L258 改为「实际落地 id 为 `oh-my-zcode-official`，全仓 19 文件 109 处（非仅两份清单——id 字面量散布引用，只改清单会错配；计数为 v0.1.0 终测口径）」。实测：`git grep -o "oh-my-zcode-official"` = **109 处 ✔**；`git grep -l` = **20 文件**（文档 4：CONTEXT.md / NOTICE.md / UPSTREAM-SYNC.md / apps/zcode-cli/README.md；代码 16），spec 写 19 → **差 1**（见 §2 P4-1）。结论方向与「非仅两份清单」仍成立 |
| **F2** EXEMPT-2b 加载点口径 | P3 | **闭合 ✔（且口径为真）** | L16 改为「加载点计数以 cr-fix-spec MF-30 登记口径为准：产物实测 5 静态 require + 2 动态 import」。三源一致：①`cr-fix-spec-v0.1.0.md:149-150` MF-30 原文即「更正为『5 静态 require + 2 动态 import』」；②`docs/.iteration-state.yaml:52` EXEMPT-2b 原文「…+5 处静态 require 改懒加载（v0.1.1）」；③代码实测——**静态 5 处**：`adapters/src/config/schema.ts:8`、`bootstrap/src/app/magic-context-historian.ts:68`、`magic-context-turn-transform.ts:140`、`magic-context-usage-summary.ts:33`、`bootstrap/src/zcode-protocol/magic-context-config.ts:3`；**动态 2 处**：`cli/src/command-center/handlers/ctx.ts:98`、`core/src/tool/handlers/ctx-context.ts:56`。r2 当年统计得「4 处静态」漏计 `adapters/src/config/schema.ts:8`，实际 5 处与登记值一致——新口径正确 |
| **F3** 注记错位 | P3 | **闭合 ✔** | D-7 范围澄清句现独立为 L229，紧随 `### Phase 2b 原生压缩移除（D-7）+ UI 调整（D-12/D-13）`（L227）节头；S32 四既成事实留 L256，紧随 `### Phase 3 品牌与后端`（L254）。标签亦分化（原「D-7/S32 范围澄清」→「范围澄清」/「S32 品牌面四个既成事实」），读者按任一 Phase 检索都能命中正确口径 |
| **F4** 验收状态缺 T-B/T-T | P3 | **闭合 ✔** | L13 补「T-B1/T-B2 与 T-T1..T-T5 已随各阶段门禁执行」；并回核 spec 正文 L326-332 确有 T-B1 / T-B2 / T-T1..T-T5 正式用例条目（Phase 0 Step 3/4/5、Phase 1 Step 13/8…），编号非虚构 |
| **SP-10** S22 ctx-recomp 注记 | P2 | **维持豁免关闭 ✔** | L296 原文未动，与 `magic-context/src/host/ctx-recomp.ts` 头注释（「这就是 SPEC 的『首版…简化语义』…简化的是执行不是表达」）及 `setMagicContextRecompRunner` 实现无冲突，无失实。不再挂账 |

## 2）遗留问题（均不阻塞）

**P4-1 [P4] L258「19 文件」应为 20 文件**
- 实测 `git grep -l "oh-my-zcode-official"` = 20 个跟踪文件（文档 4 + 代码/配置 16），`git grep -o` = 109 处。处数正确、文件数少 1。
- 影响可忽略（该注记已自标「计数为 v0.1.0 终测口径」，且结论方向不依赖数字），但作为 F1 的落地结果仍是「差一位」。
- 建议：`19 文件 109 处` → `20 文件 109 处`（或模糊为「20 文件 / 100+ 处」）。一行改动，可随手带上。

**P4-2 [P4—提示，非本 doc-fix 范围]** 「7 处加载点」旧数仍存于 `docs/.iteration-state.yaml` 的历史叙述与 `cr-fix-spec MF-30` 标题中；后者的「7 处 vs 登记 5 处」是**缺陷命名**（正确用法），前者归 MF-30 处置。spec 侧已不再复述该数字，无冲突。

## 3）新引入问题排查（无阻塞项）

- **结构完整性**：376 行；全文注记共 10 处落点（L9 引导语、L14 行号说明、L229、L242、L256、L258、L262、L305、L306、L376），无重复标签、无被拆注记遗留的孤儿句/半句；L229 前后接「全量删除清单」，L256 前后接「L1 改名」，上下文均完整。
- **残留文本扫描**（Select-String 全量）：`106`、`17 文件`、`7 处加载点`、`双方`（除 L376 勘误中的引述）、`均为` —— **全部零命中**，旧数字/旧口径已彻底清除。
- **既有闭合项无回归**：L242 `UsageQuerySource`【勘误】在位；L305 dynamic-workflow 引擎契约占位白名单【执行注记】在位；L306 Step 29 三锚点收窄三条【执行注记】在位；L11 tag 链 + 34/35 完成矩阵、L12 MF-01「代码修回 spec、spec 契约不改」方向声明在位；L14 行号漂移口径在位。
- **跨文档一致性**：spec L16 ↔ cr-fix-spec MF-30 ↔ iteration-state:52 三处「5 静态 + 2 动态」口径统一；L262/L376 双处许可勘误措辞互相一致（均含「S34 已按实际处理」）；L256 四事实与 L11/L12 状态节无矛盾。
- **仓库状态**：HEAD = `aba59a9`（tag `v0.1.0`），工作区仅一个未跟踪文件 `desktop-dev.log`，无影响判定的改动。

## 4）结论

**Go** —— 上轮唯一阻塞 SP-01R 已闭合：`兼容性与迁移说明`（L376）已勘误为「ZCode=Apache-2.0 / magic-context=MIT」，与仓内 `LICENSE.magic-context`、`omz/LICENSE` 双证一致；全 spec 文本扫描无任何「magic-context=Apache-2.0」的残留表述。F1（计数改 19/109）、F2（改 MF-30 口径 5 静态 + 2 动态）、F3（拆注记落位）、F4（补 T-B/T-T 状态）四处 P3 全部落地，其中 F2/F4 经代码与正文用例定义复核为真；SP-10 按 r2 建议豁免关闭。未发现 doc-fix 引入的新问题。

唯一遗留为 P4 级的 `19 文件 → 20 文件` 一位之差（L258），属注记级数字，不阻塞。

**下游放行口径**：本 spec 判 **spec-ready**，可交 `cr-fix-spec-v0.1.0.md` 执行（其 MF-01 / MF-02 / MF-30 与本轮核对结论不冲突，spec 侧不需再让；MF-30 的两文档登记源更正照原计划走）。P4-1 可随下一版文档修订顺手带上。