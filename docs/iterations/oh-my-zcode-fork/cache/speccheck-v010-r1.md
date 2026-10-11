# spec-check-loop · round 1 · judge 审查输出

- 被审文档：`D:\Dev\Js\oh-my-zcode\docs\iterations\oh-my-zcode-fork\spec.md`（35 步 4 阶段开发 spec）
- 仓库：`D:\Dev\Js\oh-my-zcode\omz` @ aba59a9 (tag v0.1.0)
- 轮次：1（judge，无上轮）
- **本结论由主代理手工等效审查产出（标注：手工审查）**——judge 子代理三次网络失败（输出停留骨架），按 skill 失败处理规则降级；审查底座=主代理本会话亲读的 spec 全文 + CR v0.1.0 全部评审产物 + iteration-state 偏离登记，关键事实均已在本会话内经代码回读验证（验证记录见 cr-v010-review-*.md）。
- 下游消费者视角：①cr-fix-spec-v0.1.0 执行参照 ②S31 Batch2 排期 ③上游同步重放基线。

## 元问题判定（doc-fix 风格）

**建议定位：历史计划文档 + 勘误/状态注记**（不重写正文原句）。理由：spec 是 35 步的执行计划与决策记录，正文保持"当时怎么拍板"的历史真实性；与代码事实的偏差用统一的「执行状态与勘误注记」节 + 少量行内【勘误】标记承载——与本项目"偏离登记"文化一致，也满足三类下游消费者不被误导的要求。

## 1）相对上轮

无（首轮）。

## 2）剩余问题

### P0

**SP-01 [P0] 合规节许可声明事实错误：magic-context 并非 Apache-2.0**
- 证据：spec L247「保留 Apache-2.0 LICENSE（ZCode 与 magic-context 均是）」；代码事实：上游 @cortexkit/opencode-magic-context 0.44.4 为 **MIT**（Copyright (c) 2025 Ufuk Altinok），S34 已按 MIT 落地（LICENSE.magic-context + 33 头注释订正，commit 27b7109）。
- 方向：**b（spec 改）**。下游影响：未来上游同步/合规复检者按此句会做错许可处理。
- 修改建议：L247 改为「保留 Apache-2.0 LICENSE（ZCode）；**magic-context 上游为 MIT（勘误：本 spec 撰写时误判为 Apache-2.0，已按 MIT 实际处理，见 LICENSE.magic-context）**」。

### P1

**SP-02 [P1] L229 UsageQuerySource 影响判断错误（称"牵动 usage_stats 查询源"，实际零影响）**
- 证据：spec L229 编辑型清单「`UsageQuerySource` 的 `"compact"` 枚举值（`:871`，删除会牵动 usage_stats 查询源）」；CR 复核：唯一使用点 session-store.port.ts:830 写成 `| string`，core 侧另有独立本地类型，删除零影响（cr-v010-review-protocol §3 SD-5）。
- 方向：b。建议：该括号注记补勘误「（勘误：实测零影响——使用点带 `| string` 兜底）」。

**SP-03 [P1] spec 内部矛盾：L229 要求保留 dynamic-workflow 占位、L290 残留扫描白名单却未列它**
- 证据：L229「`dynamic-workflow/src/engine/types.ts:654` 该 union 成员是保留占位——不删」；L290 Step 28 白名单枚举（布局词/数字缩写/context-usage-log-compact/流边界契约/magic-context 语境）不含该占位。
- 方向：b。建议：L290 白名单补「dynamic-workflow 引擎契约占位（见编辑型改动清单）」。

**SP-04 [P1] S29 三个复用/结构锚点已失效或收窄，未标注**
- 证据：①「`runSettingsActionAsync` 包裹」——该函数已被遥测移除掏空为恒等函数且是 SettingsPage 本地未导出（SettingsPage.tsx:112）；②「复用 `SettingsResourceGroup`」——实为 SettingsGroupCard 场景（全仓无裸 SettingsResourceGroup）；③「`useSettingService.ts` 或专用 hook」——实现内联在组件（含竞态版本号，功能等价）。（cr-v010-review-ui-tui OQ-2/OQ-3）
- 方向：b（注记收窄，不改验收——T-U1 已按 RPC 级验证通过）。

**SP-05 [P1] 变更点清单未显式含「/compact 用户可见命令面移除」**
- 证据：D-7 三张清单覆盖代码/协议/i18n，S26/S27 实际删除了 CLI 解析路由 + help 条目 + TUI 提交路径 + `/help compact` 目录项（T-M9 验收即按此设计）；spec 正文无一句明说"用户可见命令消失"。
- 方向：b。建议：变更点清单 Phase 2b 节补一句「含用户可见 `/compact` 命令面（解析/路由/help/目录）整体移除，T-M9 的'命令不存在/普通文本'即目标行为」。

**SP-06 [P1] S32 品牌面的四个既成事实未回写（双轨/别名过渡/electron 不改/EXEMPT-2a·2b）**
- 证据（均已在 iteration-state/UPSTREAM-SYNC 登记，spec 无载）：①工作区级 `<cwd>/.zcode` 刻意保留（用户级才改 .omz）；②marketplace id 过渡期旧 CDN 名别名容忍（cr-fix-spec MF-02 将落地）；③electron 桌面身份（dev.zcode.app/ZCode.app）不属 L1 未改；④build:sea --all 的 EXEMPT-2a 与 SEA 运行时 loader 的 EXEMPT-2b（v0.1.1）。
- 方向：b。建议：S32/D-10 处加执行注记四条。

**SP-07 [P1] 执行状态缺失：S31 pending、S34 已完成+tag、契约 8 与 MF-01 的关系**
- 证据：spec 全文以将来时写 35 步；实际 34 步完成（tag v0.1.0=aba59a9）、S31 推迟待排期；契约 8（effective=features&&enabled）**代码未实现、方向 a——spec 不改**，由 cr-fix-spec MF-01 修代码回 spec。下游执行者若不读 iteration-state 会误判起点。
- 方向：b（加状态节）。建议：文档头加「执行状态与勘误注记」节：步骤完成矩阵（S1-S30/S32-S35 done，S31 deferred）、tag 链、cr-fix-spec 待执行声明（含"契约 8 以 spec 为准"）。

### P2

**SP-08 [P2] 行号引用普遍漂移**（CR 各节点多次报告，如 spec 引 `:693` 实为 572 行文件等）。建议在状态节统一注记「行号为撰写时锚点，执行以符号名为准」。
**SP-09 [P2] T-* 验收矩阵状态未标注**（T-M1..T-M12/T-U1/T-P1 已过；T-U2 manual 半过；T-P2 自动部分过/manual 留）。建议状态节带一张简表。
**SP-10 [P2] S22 ctx-recomp「首版简化语义」注记**（runner 装配后已切真实条数，iteration-state s21 有载）——低优先，可选。

## 3）结论

**No-Go** —— 1 条 P0（SP-01 许可事实错误）+ 6 条 P1。修复全部为文档注记级（方向 b），doc-fix 一轮可闭合；契约 8 等方向-a 项明确不改，避免 doc-fix 误把 spec 改去迁就代码缺陷。
