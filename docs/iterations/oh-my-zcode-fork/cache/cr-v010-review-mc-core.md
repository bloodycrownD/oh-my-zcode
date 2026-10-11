# CR v0.1.0 — review-mc-core

- repo: D:\Dev\Js\oh-my-zcode\omz
- BASE_SHA: 1fa2d0e / HEAD_SHA: aba59a9
- 模式: scope（节点 review-mc-core）
- 维度: A + B + C + C-orch + G
- spec: docs/iterations/oh-my-zcode-fork/spec.md
- evidence: cache/cr-v010-evidence-mc-core-port.md
- 状态: 完成
- **本结论由主代理手工等效审查产出（标注：手工审查）**——子代理连续 6 次网络失败后按 skill 失败处置规则降级；E1 证据包的每条主发现均已由主代理按 file:line/字节级回读验证（验证记录见各条"验证"栏）。

## must-fix

### review-mc-core/C-1 — P2 — 两个 deferred 缝文件含裸 NUL 字节，git 判为 binary
- 文件：`apps/zcode-cli/packages/magic-context/src/core/deferred/ctx-reduce-availability.ts`（字节偏移 4127/共 7220）、`.../deferred/embedding-failure.ts`（偏移 5996/共 6400）
- 维度：C（移植保真/可审性）
- 问题【已验证：主代理 PowerShell 逐字节扫描，两文件 NUL 命中如上】：上游对应位置是转义序列 `\u0000`，移植后变成真字节 0x00。运行时语义等价，但 git diff/grep/PR review 对这两文件退化为 "Binary file matches"，`git grep FORK-NOT-PORTED` 已实际吞掉一处命中——与"逐字移植件"政策冲突且损害可审性。
- 改法：把两处裸 0x00 字节替换为上游原样的 `\u0000` 转义序列（编辑后 `git diff` 应显示这两文件恢复为文本 diff）。
- 验收：`git grep -c "FORK-NOT-PORTED" -- <两文件>` 正常返回计数；`git diff --stat` 对两文件不再显示 binary。
- 来源：evidence-mc-core-port §发现1 + 主代理字节级验证

### review-mc-core/C-2 — P2 — storage-db.ts 未使用 import（S24-fix 漏删，四门禁盲区）
- 文件：`apps/zcode-cli/packages/magic-context/src/core/features/magic-context/storage-db.ts:21`
- 维度：C（死代码）
- 问题【已验证：`git grep -c harnessOwnsOpenCodeStore` 在该文件仅 1 次命中=import 本身】：S24-fix 删 `runToolOwnerBackfill` 时连带漏删。包 tsconfig 无 noUnusedLocals、根 oxlint ignore apps/zcode-cli、knip ignore src/**、oxfmt ignore src/core/**——四道门禁同时失效。
- 改法：删除该 import 中的 `harnessOwnsOpenCodeStore` 一项（若同行还有其它符号保留其余）。**不要**顺手清理 E1 提到的 `queueM0Mutation`/`clearCachedM0M1`/`storage-subagent-invocations` 零消费导出——它们是上游 barrel 表面，属移植保真范围（见 spec_deviations SD-1）。
- 验收：`pnpm --filter @zcode/magic-context build` 成功；grep 零命中。
- 来源：evidence-mc-core-port §发现2 + 主代理验证

### review-mc-core/C-3 — P2 — UPSTREAM-SYNC.md 把 core 侧 sidecar 原语列为"必填字面量"落点，与实际类型不符
- 文件：`omz/UPSTREAM-SYNC.md` §3（四条硬约束节）、`apps/zcode-cli/packages/core/src/runtime/methods/sidecar-model-request.ts:30`
- 维度：C（文档与代码一致性）——该文件属 S34 交付物，归本 scope 裁决
- 问题【已验证：sidecar-model-request.ts:30 为 `preserveProviderStreamBoundaries?: boolean` 并在 :306 原样透传；字面量+必填的编译期强制只在包内 host 层 hidden-completion-executor.ts:81】：SOP 把两处并列为"必填字面量"落点，未来按 SOP 重放上游同步的人会在 core 侧找并不存在的字面量约束。评审组（review-mc-host OQ-1 与本节点一致）裁定"core 侧可选 boolean 透传"本身是已接受设计（bootstrap 静态传 true + 运行期测试钉住），问题只在 SOP 记载失真。
- 改法：UPSTREAM-SYNC.md 该条改为：「字面量强制点=包内 host/hidden-completion-executor.ts（SidecarModelCallOptions 必填字面量 true）；core/runtime/methods/sidecar-model-request.ts 是通用门面（可选 boolean 透传），不得在此处寻找或添加字面量约束」。
- 验收：文档 review 一眼可判；无代码改动。
- 来源：evidence-mc-core-port §发现3 + review-mc-host OQ-1 交叉

### review-mc-core/C-4 — P2 — storage.ts barrel 头注与代码实际落地状态分叉
- 文件：`apps/zcode-cli/packages/magic-context/src/core/features/magic-context/storage.ts:13-16`
- 维度：C（注释准确性）
- 问题【已验证：`startMessageFtsRowidMapBackfill` 在 storage-db.ts:55/1108 真实调用；`project-docs-hash.ts` 190 行存在且被 inject-compartments.ts:39 消费】：头注声称「fork has no FTS tables（message-index 不搬）」「project-docs-hash 属 Batch 2 待落地」，两者都与代码相反。按头注做上游同步或清理的人会得出错误结论。
- 改法：头注两处改为与实际一致：message-index/FTS backfill 已搬（storage-db.ts:1108）；project-docs-hash 已落地（inject-compartments 消费链）。若 message-index 实为"部分搬"，写明搬了什么没搬什么。
- 验收：纯注释；`pnpm --filter @zcode/magic-context build` 过。
- 来源：evidence-mc-core-port §发现5 + 主代理锚点验证

## open_questions

- **OQ-1（未认定，勿进 must-fix）**：E1 称 historian 移植有两处未登记语义改写——(a) `fallbackModels` 的 `modelOverride ? undefined : fallbackModels` 判据消失（声称 :693）、(b) `parseModelOverride` 校验被删。**主代理回读复核发现锚点不符**：实际文件 `src/core/hooks/magic-context/compartment-runner-historian.ts` 全文 572 行（声称的 :693 不存在）；可见代码 `:373` 处 modelOverride 条件展开仍在、`:494` 处另有无条件 `args.fallbackModels`。是否构成"同 pass 双跑 fallback 链"取决于 executor 是否消费 `HiddenRunIdentity.fallbackModels`——本轮未完成该查证。处置：进 fix-spec「待查证」附录，查证后再定级。
- **OQ-2**：`historianReasoningBudgetDiagnostic` 诊断串被削（E1 称源于 S11）——涉及遥测移除期的诊断裁剪，需对照 .reference 原文确认是否丢了对排障关键的信息（S24-fix 曾因同类信息缺失卡过 T-M6 取证）。同入「待查证」。

## spec_deviations

- SD-1（fixed）：`queueM0Mutation`/`clearCachedM0M1`/`storage-subagent-invocations` 等零消费 barrel 导出——上游移植件表面，保持逐字（上游同步时随上游演进），非死代码清理对象。登记为已接受。
- SD-2（fixed）：src/core 偏离（data-path/migrations 跳 v85/v87/hostProcessLifetime/raw-message 单读单权威）已在 iteration-state phase2a 登记且代码注释块齐备（E1 核对通过）。
- SD-3（open）：两个 deferred 文件的 NUL 字节属"非逐字覆盖"形态——随 C-1 修复后 close。

## 结论

**scope-ready: no**（4 条 P2 must-fix 待修；无 P0/P1）。C-1/C-2 为机械修复，C-3/C-4 为文档订正，均可与其它 scope 的 fix-spec 条目合并执行。
