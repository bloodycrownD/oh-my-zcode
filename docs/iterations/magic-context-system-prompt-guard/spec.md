---
date: 2026-10-19
---

# magic-context-system-prompt-guard spec（v4 · 待下轮审查）

doc-fix r1（2026-10-19，闭合第 1 轮审查 1 P0 + 2 P1 + 8 P2）：迁移号改 fork 车道 v10000（P1-2，已核实 runMigrations pending 选择无 floor 过滤、getCurrentVersion 只数 <10000，migrations.ts:3313-3317/:3334-3338/:3205-3211）；版本联动测试入改动面与门禁（P0-1：smoke-storage.mjs:86、test-boot-busy-retry.mjs seed）；stamp 覆盖存量 tag 写明 + 新增 T-G11（P1-1）；caveman 豁免改「承重」口径（P2-1）；T-G9 补迁移行断言（P2-2）；提示词落点更正为 core/agents/（P2-3）；错误文案定交集（P2-4）；execute-flush 死码加守卫（P2-5）；Pi 折叠与 compacted 入非目标登记（P2-6/P2-8）；R3 补 migration-on-open guard（P2-7）；R2 补 system_prompt_hash bust（P2-3 连带）。

doc-fix r2（2026-10-19，闭合第 2 轮审查 3 P0 + 2 P1 + 4 P2；关键事实均主代理亲读代码核实）：**读侧口径拍板**——`getPersistedSchemaVersion` 去 `WHERE version < FORK_MIGRATION_VERSION_FLOOR` 过滤改全量 MAX（P0-A，storage-db.ts:384-397；连带修复 fence 拒绝语义、guard 早退、async 探测门、smoke 断言链）；guard「每次首开常驻探测」风险消除（P0-B，:956-957/:2717/:2799-2802——读侧修复后迁移完成即早退，R3 重写）；smoke 联动清单补全 :105-111/:127/:144-148（改 `MIGRATIONS.length`，数组已导出 migrations.ts:267）/:187-197 与 boot seed (94),(10001)（P0-C）；prompt 变体锚点纠正——:90/:141 是主档、:169/:176 是子代理档，口径改为「所有含 stamping 指引的变体全加」（P1-A）；R3b fence 取舍明写 95..9999 上游库被放行（P1-B）；T-G9 载体改 smoke-storage（P2-A）；T-G11 措辞对齐 assignTag 收养路径（P2-B）；execute-flush 判据点名 `getTagById`（P2-C，storage-tags.ts:2312-2322）；caveman 豁免面扩三处（eligibility :141-151 / rules-switch :171-216 / replay :352-393）+ target 兜底 + 存量自愈链（P2-D）。

doc-fix r3（2026-10-19，闭合第 3 轮审查 2 P0 + 1 P1 + 8 P2；上轮 9 条闭合 8 条，P2-4 T-G11 措辞残留本轮重写；新锚点均主代理亲读核实）：**工具描述落点纠正**——模型可见描述有两份（宿主 full `ctx-context.ts:126-134` + 包内 light `light-descriptions.ts:30` 经 `prompt-surface-runtime.ts:78`），`constants.ts` 是死文案（两调用方只 `.execute`），变更点 7 改三落点 + test-ctx-tool-descriptions 断言（P0-1，F15）；**bootstrap G-2 fence 用例入联动**——`test-magic-context-memories-rpc.mjs:881-925` 的「窗口 MAX+1」构造在读侧修复后必红且不在 `test:all`，改「全量 MAX 行 10000→10001」+ Step 9 显式补跑（P0-2，F18）；caveman/strip/execute-flush 补验收 T-G12/G13/G14（P1-1）；zh 孪生四变体同步禁律句（P2-1，F16，:71/:115/:138/:145）；sibling-conflict 回退分支改 `isMigrationApplied` + T-G15（P2-2，F17，migrations.ts:3380-3381）；stampTagMessageRole 改 `IS NOT` NULL 安全 + T-G16（P2-3）；T-G11 重写为 initFromDb 生产路径 + 冷 tagger 收养双用例（P2-4）；storage-clone 列清单补列（P2-5，变更点 15）；T-G9 补 fixture 构造法（P2-6）；execute-flush 限制登记（P2-7）；过期措辞三点登记 FORK 注释清单（P2-8）。

## 需求来源

用户口述（会话 sess_902d4d67，2026-10-19）：

1. 现象：会话 sess_8a943109-9f51-4e0d-ba50-86fc8b2d9451 的 agent「认为自己是子会话」——系统提示词（身份/边界/工作流规则）丢失后行为错乱。轨迹查看器显示三条「系统提示词 → `[dropped]`」+ 两条 user 注入 → `[dropped §4§]/[dropped §5§]`。
2. 指令：「根治吧」——system prompt 段必须永远不可被清扫。

根因已实锤（`~/.omz/cli/db/magic-context.db`，tags 表，sess_8a943109）：tag 1–5 全部 `status='dropped'`、`drop_mode='full'`（14/260/4861 tokens 的三条 system 段 + skills/agentsMd 两条注入）。逐路径排除后唯一可达路径 = **agent 自行调用 ctx_reduce 盖章 1–5**（emergency 只动 tool、routine 只动 system-injection 匹配项、dedup 只动 tool）。

## 零、已核实的设计输入（探索报告锚点，2026-10-19 main）

| # | 事实 | 锚点 |
|---|---|---|
| F1 | ZCode 把 0–3 条 `role=system` 段投影为带 id 运行时条目（`mc1/mc2/mc3`），每请求都在 wire 上；subagent ≤2 条；关 magic-context 仍有 dynamic 段 | core/src/context/builder.ts:264-311；host/types.ts:358-415 |
| F2 | `tagMessages` 无 role 过滤，system 段 text part 照常打标（type="message"，tag 1/2/3）；tags 表**无 role 列**；`type` 只有 message/tool/file | tag-messages.ts:610,782-893；storage-db.ts:1157-1171；types.ts:1-59 |
| F3 | ctx_reduce queue 层无 type/role 门禁：只拒 unknown/compacted/inert/already-queued；protection window 只保护 tool 型 | ctx-reduce/tools.ts:145-226；protection-window.ts:133-134,228-230 |
| F4 | `applyPendingOperations` 的 message 分支对任何 role 统一替换为 `[dropped §N§]` 并落 dropped（target 缺席也落） | apply-operations.ts:433-462（buildReplacementContent :63-65） |
| F5 | `applyFlushedStatuses` 每 pass 重放 dropped 状态（message 分支 :547-550 重写占位符） | apply-operations.ts:503-554 |
| F6 | 中和层只豁免 user：`stripDroppedPlaceholderMessages`（:190）、`stripSystemInjectedMessages`（:78）会把 marker-only 的 system 消息整条中和成 `[dropped]`/空哨兵；`replaySentinelByMessageIds` 无 role 概念 | strip-content.ts:61-124,175-242；sentinel.ts:20,257-284 |
| F7 | heuristic 三路径均无法碰纯文本 system 段：emergency/dedup 只动 tool；routine 注入剥离要求 `stripSystemInjection` 匹配（`<system-reminder>` 等 marker） | heuristic-cleanup.ts:134-137,187,229-285,305；system-injection-stripper.ts:27-52 |
| F8 | ctx_reduce drop **不清 source_contents**；tagMessages 每 pass 从 source_contents 恢复 pristine 原文再加 §N§ 前缀（:902-911）→ 自愈有完整原文可用 | tag-messages.ts:895-912；storage-source.ts:26-38 |
| F9 | 迁移先例：v27/v92 用 tableExists+ensureColumn 加列；版本推导 `LATEST_MIGRATION_VERSION=reduce(max)`（migrations.ts:3190-3193）自动尾随数组最大号，但 `LATEST_SUPPORTED_VERSION` 是显式常量 94 须手改；**fork 车道**：`FORK_MIGRATION_VERSION_FLOOR=10_000`（"First version reserved for downstream migrations; upstream versions stay below it"，migrations.ts:11-12），`getCurrentVersion` 只数 `<10000` 行（:3205-3211）而 `runMigrations` pending 选择**无 floor 过滤**（:3313-3317/:3334-3338，且 :3329-3333 注释明示框架为 floor 之上的 downstream 行设计共存）——fork 号段迁移可正常执行；全仓尚无 5 位号先例；跳上游号有先例（v85/v87 空号） | migrations.ts:11-12,1242-1272,3140-3161,3190-3212,3288-3358；storage-db.ts:170 |
| F10 | 契约测试基建：test-ctx-tools.mjs（临时 db + dist import + 文案断言）；test-transform.mjs（tsc staging 纯函数面，可 import apply-operations/sentinel/strip） | magic-context/scripts/ 两文件 |
| F11 | RULE.md 硬约束：src/core/ 为上游逐字移植件——fork 适配点一律写 FORK 注释块（源位置/上游语义/ZCode 差异）；移植件 oxfmt 豁免保持可 diff；测试不得碰用户真实库（显式传 db） | docs/apm/RULE.md |
| F12 | 版本联动既有断言（bump 必红，须同步改）：`smoke-storage.mjs:86` 断言 `LATEST_SUPPORTED_VERSION===94` 且 `:87-91` 断言与 `LATEST_MIGRATION_VERSION` 相等（`test:all` 的一环，package.json:18/30）；`test-boot-busy-retry.mjs:210-223` `seedFencedDatabase` 写 (94,…),(95,…) 伪装库比 build 新，fence 判定 `persistedVersion<=latestSupportedVersion` 才放行（storage-db.ts:428-443）——bump 后须把 future version 抬到新 ceiling 之上 | scripts/smoke-storage.mjs:86-91；scripts/test-boot-busy-retry.mjs:210-223,437,457；storage-db.ts:428-443 |
| F14 | **读侧第二函数**：`getPersistedSchemaVersion`（storage-db.ts:384-397）与 `getCurrentVersion` 同口径过滤 `WHERE version < FORK_MIGRATION_VERSION_FLOOR`——fork 行 v10000 永不计入。调用方全清单（rg 实证）：`schemaVersionIsSupported` :403、`enforceSchemaFence` :433、`enforceMigrationOnOpenGuard` 早退 :956-957（`persisted >= latest` 才早退；sync 路径 :2717 无条件调用 guard；async 探测门 :2800 `< latest` 才 `inspectProcessesAsync`）、boot 日志 :1137、smoke :105/:157、barrel storage.ts:55。若只抬 `LATEST_SUPPORTED_VERSION` 到 10000 而不动它：fence 对任何 seed 永不拒绝、guard 永不早退（每次进程首开都探测兄弟进程，多进程常驻=Desktop+CLI 并存时**永久 storage_unavailable**）、smoke :106/:108-111/:147/:169/:190 全红。`MIGRATIONS` 数组已导出（migrations.ts:267），smoke :144-148 的 `LATEST_MIGRATION_VERSION - 2` 计数断言可改 `MIGRATIONS.length` | storage-db.ts:384-397,403,428-443,949-960,1137,2713-2722,2793-2809；migrations.ts:267,3205-3212 |
| F13 | 遗漏路径排查（第 1 轮审查核实，全部 dropped 写点）：`apply-operations.ts:462`、`execute-flush.ts:22`（**零调用死码**，直接 `updateTagStatus(op.tagId,"dropped")` 无 role 守卫）、`heuristic-cleanup.ts:200/253/342`、`transform-postprocess-phase.ts:1201`（summary tag，合成 assistant）、`storage-tags.ts:1358`（Pi 折叠传播 `applyDroppedStatusIfNeeded`，经 `foldDuplicateIntoSurvivor :1419-1441`，不经 pending_ops）；**队列生产者**不止 ctx_reduce：`compartment-runner-drop-queue.ts:66/72` 也为 message/file tag 入队（防线二可兜）；`markTagsCompactedByMessageIds`（storage-tags.ts:1781-1808）可把 message 型 tag 置 `compacted`（非 dropped、不改 wire 呈现）；`replaySentinelByMessageIds` 全仓唯一调用方 transform-postprocess-phase.ts:2920（参数类型加 `role?` 属放宽，兼容）；真实 `/ctx-flush` 消费路径= `explicitFlush → shouldApplyPendingOps → applyPendingOperations`（transform-postprocess-phase.ts:2193-2229，防线二覆盖）；caveman **三处应用面**（eligibility caveman-cleanup.ts:141-151、rules-switch 重写 :171-216、`replayCavemanCompression` :352-393）的 filter 均不看 role——**system 段照进**，experimental 开启（transform.ts:2220）时 `applyCompressedText` 可改写/重放系统提示词文本 | 各文件如上 |
| F15 | **模型可见的 ctx_reduce 描述有两份，`ctx-reduce/constants.ts` 是死文案**（第 3 轮审查实锤）：full preset 走宿主 `core/src/tool/handlers/ctx-context.ts:126-134` 的 `ctxReduceToolEntry.metadata.description` 数组；light preset 走包内 `core/tools/light-descriptions.ts:30` `CTX_REDUCE_LIGHT_DESCRIPTION`（经 `core/shared/prompt-surface-runtime.ts:41/:78` 映射覆盖）；`CTX_REDUCE_DESCRIPTION` 只挂在 `createCtxReduceTools` 返回对象上，两个调用方（ctx-context.ts:91-92、run-ctx-command.ts:250-256）只调 `.execute` 从不读 `.description`；`core/scripts/test-ctx-tool-descriptions.mjs:26-35` 钉的是宿主那份 | ctx-context.ts:91-92,122-143；light-descriptions.ts:30；prompt-surface-runtime.ts:41,78；handlers/index.ts:376-396；test-ctx-tool-descriptions.mjs:26-35 |
| F16 | **中文提示词孪生**：生产中文会话走 `bootstrap/src/app/magic-context-prompt-section-zh-cn.ts`（`magic-context-turn-transform.ts:1228-1233` `isChinesePromptLanguage` 分支），其四处 stamping 变体（:71 主档、:115 light 主档、:138 子代理、:145 子代理 light）与英文一一对应；`test:mc-section-zh` 只做 resolver/直调一致性 | magic-context-prompt-section-zh-cn.ts:71,115,138,145；magic-context-turn-transform.ts:1228-1233 |
| F17 | **sibling-conflict 回退分支**：runMigrations 的 PK 冲突容忍（migrations.ts:3374-3384）用 `getCurrentVersion` 判「版本是否前进」（:3380-3381）——fork 行 v10000 被该读数过滤，兄弟进程抢先写 v10000 时误判未前进 → 抛 "manual repair" fatal；该路径随本次 fork 迁移首次可达 | migrations.ts:3205-3212,3313-3317,3374-3384 |
| F18 | **其余版本联动面**（第 3 轮审查补）：`bootstrap/scripts/test-magic-context-memories-rpc.mjs:881-925` G-2 fence 用例以「version<10000 窗口 MAX+1」构造（:895/:903），读侧修复后必红，且该脚本**不在** magic-context `test:all` 内；`storage-clone.ts:546/:550` SELECT/INSERT 显式列清单硬编码（新列不会自动传播）；措辞过期点：test-boot-busy-retry:210 注释 `fence(94)`、storage-memory.ts:27 `LATEST_MIGRATION_VERSION=94`、migrations.ts:3415 日志 | 各文件如上 |

## 一、设计目标

1. system prompt 段（`role=system` 消息的 tag）在任何路径下**永不可被清扫**：queue 拒绝、apply 拒绝、replay 不再复现历史事故。
2. 已受损会话（如 sess_8a943109）在下次请求时**自动恢复**系统提示词全文（wire 上原文回来）。
3. 纵深防御：即使未来出现新的清扫路径，中和层也不再产出 system 消息的裸 `[dropped]` 哨兵（事故可追溯、可见）。
4. 对移植件最小侵入：不动 assignTag/allocateTag/insertTag 签名链，新增列写入走独立 UPDATE。

## 二、总体方案：一个持久判据 + 四层防线 + 自愈 + 教育层

**持久判据**：`tags.message_role TEXT NULL` 新列（migration **v10000，fork 车道**——`FORK_MIGRATION_VERSION_FLOOR=10_000` 本就为 downstream 迁移保留，且本变更（ZCode 把 system 段投上 wire）是 fork 特有需求，占上游 v95 有撞号风险；执行层已核实支持，见 F9）。打标时把 `message.info.role` 写入（仅 message/file 型 tag；tool 型恒 NULL；**无论 tag 是新分配还是存量命中都写**，见变更点 5）。queue/apply/replay 三层读它做判据；apply 层另用 `target.message.info.role` 内存双保险（覆盖列尚 NULL 的升级过渡期——system 段永远在 wire 上，target 恒存在）。

**读侧口径（v3 拍板，P0-A/B）**：`getPersistedSchemaVersion` 去 `WHERE version < FORK_MIGRATION_VERSION_FLOOR` 过滤，改全量 `MAX(version)`（storage-db.ts:384-397）。两函数职责自此分明：`getCurrentVersion`（migrations.ts）= 上游车道游标，供 pending 选择（fork 行防重放靠 `isMigrationApplied` 行级判重，:3313-3317 已核实）；`getPersistedSchemaVersion` = ledger 全量 head，供 fence/guard/boot log/smoke。修复后：fence 能拒绝 10001 库（T5/T6 语义恢复）、guard 在迁移完成后早退（`persisted(10000) >= latest(10000)`，不再每次首开探测兄弟进程——否则多进程常驻场景永久 storage_unavailable，见 F14）、async 探测门同理跳过、smoke 断言链（:106/:108-111/:127/:169/:190）自然恢复一致。boot log 文案 "upstream migration lane" 措辞随之不再精确（显示 effective head），FORK 注释登记。

**防线一（queue）**：ctx_reduce 请求含 system tag → 整体 hard error（含混合请求；盖到 system 段必是 blanket-stamp 失误，应停下重看）。错误文案列**与 system 的交集** tag 号。

**防线二（apply）**：pending op 目标是 system tag → `reject("system_protected")` + `removePendingOp`（防重试循环）+ 不落 dropped。兜住旧版本已入队的 op、非 ctx_reduce 的队列生产者（compartment-runner-drop-queue，F13）与 `/ctx-flush` 真实消费路径（`explicitFlush → applyPendingOperations`，F13）。`execute-flush.ts` 的直写函数虽是零调用死码，同 patch 顺手加 role 守卫（防复活绕过）。

**防线三（replay 自愈）**：`applyFlushedStatuses` 遇 dropped 的 system tag → 跳过占位符替换 + `updateTagStatus(...,"active")`。机制闭环：tagMessages 已恢复原文（F8），跳过替换后 wire 即原文，一次 cache bust 即修复目标。中和哨兵的 frozen replay（`replaySentinelByMessageIds`）对 system 消息跳过（seen 标记但不中和；frozen set 残留无害，懒处理不动持久化）。Pi 折叠若把 system tag 置 dropped（F13，低可达、不经 pending_ops），同样由此层自愈兜底。

**防线四（中和层豁免）**：`stripDroppedPlaceholderMessages`/`stripSystemInjectedMessages` 豁免 `role=system`；heuristic routine 注入剥离对 system 跳过（防御性：routine 要求整条消息被 stripSystemInjection 吃光，纯文本 system 段够不到）；**caveman eligibility 豁免是承重的**——eligibility 只看 type/status/byteSize，system 段照进，experimental 开启时 `applyCompressedText` 会改写系统提示词文本（F13），必须豁免。

**教育层**：工具描述禁令句落在**模型可见的两份描述**——宿主 full 描述（`core/src/tool/handlers/ctx-context.ts:126-134`）+ 包内 light 描述（`light-descriptions.ts:30`，经 prompt-surface-runtime 映射覆盖 light preset）；`ctx-reduce/constants.ts` 同步加（保持迁移件 diff 最小，非模型面，见 F15）。magic-context 系统提示词正文（英文四变体 + 中文孪生四变体）各加一句禁令。

## 三、最终项目结构（改动面，全部在 apps/zcode-cli）

```text
packages/magic-context/src/
├── core/features/magic-context/
│   ├── migrations.ts            # v10000（fork 车道）: ensureColumn tags.message_role + sibling-conflict 分支改 isMigrationApplied + :3415 日志措辞
│   ├── storage-db.ts            # 基础 DDL + 漂移自愈块 + LATEST_SUPPORTED_VERSION→10000 + getPersistedSchemaVersion 全量 MAX
│   ├── storage-tags.ts          # TAG_SELECT_COLUMNS/TagRow/toTagEntry + stampTagMessageRole（`IS NOT` NULL 安全比较）
│   ├── storage-clone.ts         # 显式列清单补 message_role（潜在路径；FORK 注释）
│   ├── memory/storage-memory.ts # :27 过期注释 LATEST_MIGRATION_VERSION=94→10000（F18）
│   ├── tagger.ts                # （不动——签名链保持）
│   └── types.ts                 # TagEntry.messageRole?: string|null
├── core/hooks/magic-context/
│   ├── tag-messages.ts          # text/file 打标点后 stampTagMessageRole（存量也写；FORK 注释）
│   ├── apply-operations.ts      # 防线二 + 防线三（FORK 注释）
│   ├── execute-flush.ts         # 死码加 role 守卫（限制已登记；FORK 注释）
│   ├── heuristic-cleanup.ts     # routine 分支 system 跳过（防御性；FORK 注释）
│   ├── caveman-cleanup.ts       # 三处应用面 system 豁免（承重；FORK 注释）
│   ├── strip-content.ts         # 两函数豁免扩 system（FORK 注释）
│   └── sentinel.ts              # replaySentinelByMessageIds 跳过 system（FORK 注释）
├── core/tools/ctx-reduce/
│   ├── tools.ts                 # 防线一：hard error（交集文案；FORK 注释）
│   └── constants.ts             # 描述句（同步，非唯一落点——模型可见描述在宿主 full + 包内 light）
├── core/tools/light-descriptions.ts     # CTX_REDUCE_LIGHT_DESCRIPTION 加禁令句（light preset 模型视野）
├── core/agents/magic-context-prompt.ts  # 教育句（四处 stamping 变体：主档/light 主档/子代理档×2）
└── scripts/
    ├── test-ctx-tools.mjs       # T-G1/G2/G3
    ├── test-transform.mjs       # T-G4/G5/G6/G7/G8/G10/G11/G12/G13/G14/G16（tagMessages/caveman/strip 均在 SUBJECT；executeFlush 直调）
    ├── smoke-storage.mjs        # T-G9 + :86/:144-148 版本联动断言（test:all 一环）
    └── test-boot-busy-retry.mjs # seedFencedDatabase future version → 10001（联动；:210 注释同步）

packages/core/src/tool/handlers/ctx-context.ts   # 宿主 full 描述数组加禁令句（模型实际视野）
packages/core/scripts/test-ctx-tool-descriptions.mjs  # 禁令句存在性断言
packages/bootstrap/src/app/magic-context-prompt-section-zh-cn.ts  # 中文孪生四变体加禁律句
packages/bootstrap/scripts/test-magic-context-section-zh.mjs      # 禁律句存在性断言（根 test:v4-perf 经 test:mc-section-zh 覆盖）
packages/bootstrap/scripts/test-magic-context-memories-rpc.mjs    # G-2 fence 用例构造改全量 MAX 行 10000→10001（不在 test:all，Step 9 显式补跑）
packages/magic-context/src/core/features/magic-context/memory/storage-memory.ts  # :27 注释 94→10000
```

## 四、变更点清单（文件级）

1. `migrations.ts`：① 追加 **v10000**（fork 车道）`ensureColumn("tags","message_role","TEXT")`（tableExists 守卫，v92 风格）；FORK 注释登记「占 fork 车道首号；上游版本保持 <10000，getCurrentVersion 不数本行（:3205-3211）故不影响上游车道判定」。② **sibling-conflict 回退分支适配**（v4，P2-2）：`:3374-3384` 的 PK 冲突容忍分支用 `getCurrentVersion` 判断「版本是否前进」（:3380-3381）——fork 行 v10000 被该读数过滤，兄弟进程抢先写 v10000 时 re-read 仍 94，不大于旧值 → 误抛 "version did not advance… manual repair" fatal。改为 `isMigrationApplied(db, migration.version)`（行已存在即 continue，:3313-3317 已有判重函数）；补 sibling-conflict 单测（构造 error+已存在行，见 T-G15）。③ FORK 注释顺手更新 `:3415` 日志措辞（upstream lane → 含 fork 车道的 effective head）。
2. `storage-db.ts`：① 基础 `CREATE TABLE tags` DDL 加 `message_role TEXT`；② `:2196-2242` 漂移自愈 ensureColumn 块加同列；③ `LATEST_SUPPORTED_VERSION` 94→**10000**；④ **`getPersistedSchemaVersion`（:384-397）去 `WHERE version < FORK_MIGRATION_VERSION_FLOOR` 过滤改全量 MAX**（读侧口径，见 §二；FORK 注释登记「上游语义=upstream-lane 读数，fork 车道后改为 ledger 全量 head；getCurrentVersion 保持游标职责」）。**联动（全部必改，P0-A/P0-C）**：`scripts/smoke-storage.mjs` :86 版本断言 94→10000、:87-111/:127/:169/:190 随读侧修复自动恢复一致（firstVersion=head=10000）、:144-148 计数断言 `LATEST_MIGRATION_VERSION - 2` → `migrations.MIGRATIONS.length`（数组已导出 migrations.ts:267；v85/v87 空号使两者原本相差 2，fork 加号后 `-2` 算式必错）；`scripts/test-boot-busy-retry.mjs:210-223` `seedFencedDatabase` 的 future version 95→**10001**（读侧修复后 persisted=10001 > ceiling 10000 → fence 拒绝，T5/T6 `db_null:fence` 语义恢复）；**`packages/bootstrap/scripts/test-magic-context-memories-rpc.mjs:881-925` G-2 fence 用例**（v4，P0-2——该脚本**不在** magic-context 的 `test:all` 内，不进联动必静默漏网）：其构造法是「只把 `version < 10000` 读窗口的 MAX 行 +1」（:895/:903）——读侧修复后 getPersistedSchemaVersion 读全量 MAX=10000，伪造的 95 被淹没 → fence 放行 → :914-925 断言全红。改为「把全量 MAX 行（10000）抬到 10001」（UPDATE ... WHERE version = 10000 或按全量 MAX 定位），`versionBefore/versionAfter` 与 `:923-924` 断言随读数变为 10000/10001，断言结构全保留；Step 9 显式补跑该脚本；⑤ `memory/storage-memory.ts:27` 过期 FORK 注释 `LATEST_MIGRATION_VERSION=94` → 10000（F18）。
3. `storage-tags.ts`：`TAG_SELECT_COLUMNS`（:2045）加 `message_role`；`TagRow`/`isTagRow`（NULL 宽松）/`toTagEntry`（:829-831）透出 `messageRole`；新增 `stampTagMessageRole(db, sessionId, tagNumber, role)`（挨着 updateTagStatus :933；SQL `UPDATE tags SET message_role=?1 WHERE session_id=?2 AND tag_number=?3 AND message_role IS NOT ?1`——**`IS NOT` 做 NULL 安全比较**（v4，P2-3）：原案 `(message_role IS NULL OR message_role<>?1)` 在 role=null 时条件恒真，每 pass 重写 NULL 产生 WAL 写，与 R4「稳定后零 WAL 写」不符；`MessageInfo.role` 是可选字段（tag-messages.ts:236-245）故 null 必然出现，prepared 缓存模式同 :45——不加调用方读列判断的二次守卫，统一只靠 SQL 守卫）；「第二 pass 零写」由 T-G16 锁死（`stampTagMessageRole` 返回 `run()` 的 changes 数）。
4. `types.ts`：`TagEntry` 加 `messageRole?: string | null`。
5. `tag-messages.ts`：text 打标点（:873-893，`const tagId = existingTagId ?? assignTag(...)` **解析出 tagId 之后无条件**调用 `stampTagMessageRole(db, sessionId, tagId, message.info.role ?? null)`——存量 tag（existingTagId 命中）与新分配 tag 同样写，每 pass 执行；`mcN` 是序数 id（host/types.ts:363），system 段数量变化会让同一 tag 改绑 role，每 pass 重写兼承担纠正职责）与 file 打标点（:1026-1083，tagId 解析后同法）各加一处；tool 打标不写（tool part 不会出现在 role=system 消息上）。FORK 注释块登记。
6. `ctx-reduce/tools.ts`：:196（compacted 冲突检查后）从 `allTags`（:145）建 system 集，非空则返回 `Error: Refusing to drop ${ids} — system prompt segments are protected and never archivable.`（整体拒绝，不部分入队；**`${ids}`=请求与 system 集的交集**，复用 `formatIds` :279-281——混合请求让 agent 看清具体是哪几个 system 段）。FORK 注释。
7. **工具描述禁令句——三个落点**（v4，P0-1；r3 实锤：模型实际看到的 ctx_reduce 描述有**两份**，`ctx-reduce/constants.ts` 的 `CTX_REDUCE_DESCRIPTION` 是**死文案**——只挂在 `createCtxReduceTools` 返回对象上，两个调用方（core/src/tool/handlers/ctx-context.ts:91-92、bootstrap/src/ctx-commands/run-ctx-command.ts:250-256）只调 `.execute` 从不读 `.description`）：① **宿主 full 描述** `packages/core/src/tool/handlers/ctx-context.ts:126-134` 描述数组（Keep 行后加一句 `Never stamp a system prompt segment — tags on system (prompt) messages are protected and never archivable; a drop request containing them is refused.`）；② **包内 light 描述** `magic-context/src/core/tools/light-descriptions.ts:30` `CTX_REDUCE_LIGHT_DESCRIPTION`（经 `core/shared/prompt-surface-runtime.ts:78` 映射覆盖 light preset 的模型视野）加对应轻量句；③ `ctx-reduce/constants.ts` 同步加（保持与上游迁移件 diff 最小，**非唯一落点**）。④ `packages/core/scripts/test-ctx-tool-descriptions.mjs:26-35` 增加禁令句断言（防再次落错对象）。FORK 注释。
8. `apply-operations.ts`：
   - 防线二：`applyPendingOperations` :361 取出 target 后、:364 synthetic 分支前——`tagById` 旁建 `tagMessageRoleById`；命中（列或 `target?.message?.info.role`）→ `reject("system_protected")` + 非 synthetic 时 `removePendingOp` + `continue`。
   - 防线三：`applyFlushedStatuses` :515 `status==='dropped'` 分支开头——system（列或 target role）→ `updateTagStatus(db,sessionId,tag.tagNumber,"active")` + `continue`（不 setContent）。FORK 注释。
9. `sentinel.ts`：`replaySentinelByMessageIds` 参数类型扩 `info:{ id?: string; role?: string }`；循环内 `role==='system'` → `seen.add(id)` 但不中和。全仓唯一调用方 transform-postprocess-phase.ts:2920 以 `args.messages` 赋值，`MessageLike.info.role` 兼容（放宽不破坏）。FORK 注释。
10. `strip-content.ts`：两处豁免条件 `role === "user"` → `role === "user" || role === "system"`（:190、:78）。全部 4 个调用点在 transform-postprocess-phase.ts:2943-2961（含 hidden 数组），改动面收敛。FORK 注释。
11. `heuristic-cleanup.ts`：routine 循环 :236 后加 `targets.get(tag.tagNumber)?.message?.info.role === "system"` → continue（防御性）。FORK 注释。
12. `caveman-cleanup.ts`：**三处应用面统一豁免**（v3 扩面，P2-D）：eligibility（:141-151）、rules-switch 重写（:171-216，条件 `type==="message" && status==="active" && cavemanDepth>0`）、`replayCavemanCompression`（:352-393，同条件+targets.has）——三处 filter 各加 `tag.messageRole !== "system" && targets.get(tag.tagNumber)?.message?.info.role !== "system"`（列判据 + target 兜底双保险，兜住升级过渡期列未回填的存量行；caveman 在 tagMessages 之后跑，同 pass 的 stamp 通常已写，但 tags 快照读取时机不保证，双保险消除窗口）。存量自愈链：豁免 replay 后已压缩 system 行不再重放压缩字节，tagMessages 每 pass 从 source_contents 恢复 pristine（F8）→ wire 一个 pass 即恢复原文；`cavemanDepth` 残留值不清零（无害：eligibility/replay 均已豁免）。FORK 注释登记。
13. `execute-flush.ts`：死码（全仓零调用）`executeFlush` 的直写 `updateTagStatus(op.tagId,"dropped")`（:22）前加 system 守卫——判据走读库：`getTagById(db, sessionId, op.tagId)?.messageRole === "system"`（storage-tags.ts:2312-2322，走 TAG_SELECT_COLUMNS，变更点 3 改造后即含 messageRole）→ 命中则跳过该 op（不置 dropped、不计入 dropped 计数；removePendingOp 不执行，op 留队由防线二语义处理）。**已知限制（v4，P2-7）**：仅覆盖已回填行——该函数无 targets 上下文，升级首 pass 前/克隆后（列 NULL）的 system 行不在守卫范围内，此时依赖 stamp 下一 pass 回填；死码+防线二/三 target 兜底在先，接受此口径。直调测试 T-G14 锁死。FORK 注释。
14. `core/agents/magic-context-prompt.ts`（**注意归属：在 packages/magic-context 下，非 packages/core**；`packages/core/src/context/sections/magic-context.ts` 只是装配漏斗不做提示词）：**所有含 stamping 指引的变体全加**禁令句「Never stamp a system prompt segment — tags on system (prompt) messages are protected and never archivable」——主档 `BASE_INTRO`（:82 函数，stamping 段 :90）、light 主档 `BASE_INTRO_LIGHT`（:135 函数，:141）、子代理档 `SUBAGENT_REDUCE_INTRO`（:168，:169）、`SUBAGENT_REDUCE_INTRO_LIGHT`（:175，:176）。**不加**：`BASE_INTRO_NO_REDUCE`(:107)/`_LIGHT`(:150)（无 ctx_reduce 场景无从盖章）、PARTNER_FRAME_CLOSER 系列（:55-63，非 stamping 指引）、`buildMagicContextSection` 装配逻辑（:187-209）。子代理档加的理由：subagent 同样有 ctx_reduce 工具且 wire 上有 ≤2 条 system 段，防线一对其同样生效，教育句应同步。既有测试为 assert.match/夹具（test-prompt-surface.mjs:355-363、packages/core/scripts/test-magic-context-prompt-section.mjs:90-101），加句不红。**中文孪生同步（v4，P2-1）**：`packages/bootstrap/src/app/magic-context-prompt-section-zh-cn.ts` 的四处对应变体（主档 :71、light 主档 :115、子代理档 :138、子代理 light :145，生产中文会话经 `magic-context-turn-transform.ts:1228-1233` 的 `isChinesePromptLanguage` 分支走这份文案）加对应中文禁律句（「绝不给系统提示词段盖章——system（提示词）消息上的标签受保护、永不归档」）；`test:mc-section-zh` 只做 resolver/直调一致性，加句不红，另补一条禁律句存在性断言。
15. `storage-clone.ts`（v4，P2-5）：`:546` SELECT 与 `:550` INSERT INTO tags 的**显式硬编码列清单**补 `message_role`（含 `RawTagRow` 类型）——`copySessionStateForClone` 当前仅 barrel 导出无调用方，属潜在路径；不补则克隆瞬间 system tag 以 NULL 进新会话（后靠 stamp 下一 pass 回填自愈，但持久判据不应在克隆瞬间丢失）。FORK 注释。
16. 测试：见「六、测试策略」。

## 五、详细实现步骤

- Step 1 — phase-schema — blocking: yes — qa: auto：变更点 1–4（migration v10000 全链：DDL/自愈块/LATEST 10000/**getPersistedSchemaVersion 全量 MAX**/读侧/写入函数 + sibling-conflict 分支适配）+ 变更点 2 联动（smoke :86/:144-148、boot-busy-retry seed 10001 及 :210 注释、**bootstrap test-magic-context-memories-rpc.mjs G-2 构造改 10000→10001**）。跑 smoke-storage 验证 T-G9、跑 G-2 所在脚本验证联动。
- Step 2 — phase-tagging — blocking: yes — qa: auto：变更点 5（打标点写入，存量 tag 同样写；FORK 注释）。build 后用 test-ctx-tools 现有用例回归（tag 分配不破）+ T-G11 存量回填 + T-G16 第二 pass 零写。
- Step 3 — phase-queue-guard — blocking: yes — qa: auto：变更点 6–7（含宿主 full 描述与包内 light 描述三落点）。T-G1/G2/G3 + test-ctx-tool-descriptions 禁令句断言。
- Step 4 — phase-apply-guard — blocking: yes — qa: auto：变更点 8 前半（applyPendingOperations）+ 变更点 13（execute-flush 死码守卫）。T-G4/G5/G14。
- Step 5 — phase-replay-heal — blocking: yes — qa: auto：变更点 8 后半 + 9（applyFlushedStatuses + sentinel replay）。T-G6/G8。
- Step 6 — phase-strip-exempt — blocking: yes — qa: auto：变更点 10–12（strip 两函数 + heuristic routine + caveman 三处应用面）。T-G7/G10/G12/G13。
- Step 7 — phase-prompt-doc — blocking: no — qa: auto：变更点 14（提示词教育句，英文四变体 + 中文孪生四变体）+ zh 测试断言；跑 `pnpm --dir apps/zcode-cli/packages/bootstrap run test:mc-section-zh` 验证。
- Step 8 — phase-tests — blocking: yes — qa: auto：补齐 T-G1–T-G16 全部用例（与各 Step 交付同步写，此处收口补缺；T-G15 sibling-conflict 单测归属此处或 Step 1，先写先得）。
- Step 9 — phase-gates — blocking: yes — qa: auto：`pnpm --dir apps/zcode-cli --filter @zcode/magic-context build` + 包内 **`test:all`**（含 test:ctx-tools / test:transform / test:host / smoke-storage / test-boot-busy-retry 等全部脚本）全绿 + **显式补跑 `packages/bootstrap/scripts/test-magic-context-memories-rpc.mjs`（不在 magic-context test:all 内，需 bootstrap dist）与 `packages/core/scripts/test-ctx-tool-descriptions.mjs`** + 显式验收 `LATEST_SUPPORTED_VERSION === LATEST_MIGRATION_VERSION === 10000` + oxfmt（CLI 相对路径，改动文件零新增不合规；src/core/ 移植件豁免以保持上游可 diff）+ 根/CLI typecheck 基线对比（根 lint 71w/0e 基线）。

## 六、测试策略

### 测试用例

- T-G1 — blocking: yes — 映射 Step 3（test-ctx-tools）：seed system role tag（insertTag+stampTagMessageRole）→ `ctx_reduce {drop:"1"}` → 返回含 `Error: Refusing to drop §1§` 文案且 `pending_ops` 0 行。
- T-G2 — blocking: yes — 映射 Step 3（test-ctx-tools）：混合 `"1,8"`（1=system、8=tool）→ 同样整体 Error + `pending_ops` 0 行 + **文案断言只出现 `§1§` 不出现 `§8§`**（交集口径）。
- T-G3 — blocking: yes — 映射 Step 3（test-ctx-tools，回归）：非 system tag 正常入队路径保持现有绿。
- T-G4 — blocking: yes — 映射 Step 4（test-transform，临时 db）：pendingOp 目标 tag `message_role='system'` → 不落 dropped、pending op 被删、target 内容不变。
- T-G5 — blocking: yes — 映射 Step 4（test-transform）：列 NULL 但 `target.message.info.role='system'` → 同 T-G4（内存双保险生效）。
- T-G6 — blocking: yes — 映射 Step 5（test-transform）：dropped 的 system tag + wire target → `updateTagStatus` 修 active + wire 保持原文（不出现 `[dropped §N§]`）。
- T-G7 — blocking: yes — 映射 Step 6（test-transform）：marker-only（`[dropped §9§]`）的 system 消息不被中和（assistant 对照组仍中和=回归不破）。
- T-G8 — blocking: yes — 映射 Step 5（test-transform）：`replaySentinelByMessageIds` 对 frozen set 中 system 消息 id 不中和、计入 seen（不报 missing）。
- T-G9 — blocking: yes — 映射 Step 1（**载体：smoke-storage.mjs 追加段**——test-host.mjs 无存储层基建（只 import host/* 与 harness），smoke 有临时库/dist/fence 断言基建）：老库（无 message_role 列）开库迁移后列存在、`schema_migrations` 含 version=10000 行、`getPersistedSchemaVersion()===10000`（读侧全量 MAX 修复后成立，:106 断言同时覆盖）；补「仅 `runMigrations`（不经 initializeDatabase，漂移自愈块不跑）也能补列」分支；幂等重开不报错。**fixture 构造（v4，P2-6；r4 修正论证）**：真正会失败的不是版本重放——`getCurrentVersion`/`hasPendingMigrations` 按 `> currentVersion` 选 pending（migrations.ts:3205-3212/:3223-3232），只插 version=94 时游标即 94，只执行 v10000；真正的坑是 fixture 若没有 `tags` 表，v10000 的 tableExists 守卫直接跳过、`message_role` 不会出现、列断言红。两种可行法：① 先正常建库（完整 ledger + tags 表 + v10000），再 `ALTER TABLE tags DROP COLUMN message_role` + `DELETE FROM schema_migrations WHERE version=10000`，即得「v94 老库」；② 手写完整上游 ledger + 旧 tags DDL。两法都天然保留 tags 表；runMigrations-only 分支同理由须有 tags 表。
- T-G10 — blocking: yes — 映射 Step 6（test-transform）：heuristic routine 对「整体是 `<system-reminder>` 包裹的 system 消息 tag」跳过（不剥不 drop；user 对照组仍正常处理）。
- T-G11 — blocking: yes — 映射 Step 2（test-transform，tagMessages 在 SUBJECT :62，staged 树+MAGIC_CONTEXT_DB_DIR 临时库）：**存量 tag 回填**，两个子用例：① **生产路径**——`insertTag` 造 `message_id='msg_1:p0'`（contentId 形式）的 active 存量行（无 message_role），tagger 先 `initFromDb()`（transform.ts:2073 同款）再跑 `tagMessages`——resolver 经 `tag-id-fallback.ts:92-96` 以 contentId 精确命中，断言该行 `message_role` 已写入（stamp 无条件，走哪条命中路径都回填）；② **冷 tagger 收养分支**——不 `initFromDb` 直接跑，走 `assignTag` 的 `dbExistingLookup`（tagger.ts:414-433/:534-548），同样断言写入（v4 措辞修正：生产常态是 ①，② 覆盖防御深度；两者都必须回填，因为 stamp 挂在 tagId 解析之后而非某个分支内）。
- T-G12 — blocking: yes — 映射 Step 6（test-transform，caveman 在 SUBJECT :84）：caveman 三入口各一断言——eligibility/rules-switch/replay 对 `messageRole='system'` 列命中与 `target.message.info.role='system'` 兜底命中**均不压缩、不重写、不重放**；保留非 system 对照组正常压缩（回归不破）。
- T-G13 — blocking: yes — 映射 Step 6（test-transform）：`stripSystemInjectedMessages`（strip-content.ts:78）对 system 消息不剥（T-G7 只覆盖了 `stripDroppedPlaceholderMessages` :190；两个函数各有豁免条件，须分别锁死）。
- T-G14 — blocking: yes — 映射 Step 4（直调 execute-flush，staged db）：pending op 指向 `messageRole='system'` 的 tag → `executeFlush` 跳过该 op（status 不变 dropped、pending op 保留）；非 system 对照组正常落 dropped。
- T-G15 — blocking: yes — 映射 Step 1/8：sibling-conflict 分支——真实 SQLite 上该分支不可确定性触发（事务内先 `isMigrationApplied` 重查、`BEGIN IMMEDIATE` 下无第二连接并发），须用 **Proxy 包裹真实 `Database`**：在 `INSERT INTO schema_migrations` 处注入 crafted PK 冲突 error（`isSiblingMigrationConflict` 认得的 SQLITE_CONSTRAINTPrimaryKey 形态，migrations.ts:3255-3276），并让 v10000 行在壳外预插（冲突行存在）；断言改用 `isMigrationApplied` 后 `continue`、**不抛** "version did not advance" fatal（v4 新增，锁死变更点 1②）。
- T-G16 — blocking: yes — 映射 Step 2（staged db）：同一 (tag, role) 连续两次 `stampTagMessageRole`——函数返回 `run()` 的 changes 数，第二次返回 0、`message_role` 不变；role=null 场景同理（`IS NOT` NULL 安全，锁死变更点 3 的 R4 声明）。

载体注意：test-ctx-tools 走 dist（先 build）；test-transform 的 tsc staging 面可 import apply-operations/sentinel/strip 纯函数，db 用例参照 test-ctx-tools 的 `MAGIC_CONTEXT_DB_DIR` 临时库模式，**显式传 db，不碰用户真实库**（RULE.md）。

## 七、风险与回滚方案

- R1（受控 cache bust）：受损会话自愈会改变 served bytes——这正是修复目标；未受损会话零变化（system tag 非 dropped 不进 replay 分支；queue/apply 只新增拒绝分支）。
- R2（replay 契约变卦）：byte-stable 重放契约对 system 段的「变卦」是刻意的，已在防线三声明。另：教育句使 magic-context 提示词字节变化，连带 bust `system_prompt_hash`（设计内，一次性）。
- R3（迁移体积与首开门禁）：v10000 单 ALTER 对 ~100MB 生产库秒级；94→10000 单调升不触发 schema fence 拒绝。升级**首开**还要过 `enforceMigrationOnOpenGuard`（storage-db.ts:949-1031，async 路径同义 :2799-2809）：库有 pending 迁移且探测到 live 兄弟进程/RPC discovery 时拒绝开库（返回 null → `storage_unavailable` 可观测降级，非数据损坏）——用户动作=关掉旧版本进程/重启后完成迁移。**读侧修复后 guard 恢复「迁移完成即早退」**（`persisted(10000) >= latest(10000)`，:956-957）：探测只在确有 pending 迁移的那一次首开发生，不是常驻行为；若不做读侧修复，guard 永不早退、每次进程启动都探测兄弟进程，多进程常驻（Desktop+CLI 并存）将永久 storage_unavailable——这正是变更点 2④ 必须与 ③ 同步交付的原因。
- R3b（fence 语义取舍，明写）：读侧全量 MAX 后，fence ceiling=10000，上游车道 95..9999 的库（本 build 的 MIGRATIONS 里不存在对应迁移、schema 契约未知）会被放行并直接使用——这是 fork 车道的固有代价，**接受**。依据：本 fork 的 MIGRATIONS 数组即本 build 认识的全部 schema，上游新迁移合入 fork 时数组会带上（届时 LATEST 随之抬升）；「运行过真·上游 v95+ build 又落回本 fork」的库在 ZCode 分发形态下（fork 整链自带）不构成现实路径。上游车道游标（getCurrentVersion）保持 <10000 语义，上游后续发自己的 v95/v96 与 fork 号互不干扰、无撞号重编号。
- R4（写放大）：`stampTagMessageRole` 变化守卫用 SQLite `IS NOT`（NULL 安全比较，含 role=null 场景），role 稳定后每 pass 0 行匹配、零 WAL 写；T-G16 锁死。
- R5（过渡期）：升级后首 pass 前 `message_role` 全 NULL——防线二靠 target 内存兜底（system 段恒在 wire）；冷读 pass 无 system target，天然不触碰。防线一在存量会话首个 tagMessages pass 完成回填前依赖列判据会漏——但 stamp 每 pass 无条件写（变更点 5），任何会话只要还活着跑过一次 pass 即回填；T-G11 锁死该行为。
- 回滚：单分支交付（建议 `magic-context-system-prompt-guard`），异常时 `git revert` 整支即回；migration v10000 只加列不删不改既有列，回滚代码后列残留无害（老代码不读该列）。

## 八、非目标

- 不做全库 role 回填 migration（活跃会话每 pass lazy 回填足够，死会话无消费方；见 R5/T-G11）。
- 不改 protection window 的 tool-only 语义（message 保护走本 spec 独立判据）。
- 不改 heuristic emergency/dedup（本来只动 tool 型）。
- **Pi 折叠不另设防线**（storage-tags.ts:1348-1361 `applyDroppedStatusIfNeeded` 可把 survivor 置 dropped、不经 pending_ops——ZCode 侧 system 段是序数 id 无 pi-msg-* 折叠加成，低可达；即使命中，下个 pass 由防线三自愈修回 active）。
- **compacted 路径不另设防线**（`markTagsCompactedByMessageIds` storage-tags.ts:1781-1808 可把 message 型 tag 置 compacted——非 dropped、不改 wire 呈现，tag 复用后仍带 §N§ 前缀；system 段在 served tail 恒定存在，宿主 trim 集合够不到）。
- 不修 UI 轨迹查看器（其显示如实反映 wire，wire 修复后自然正确）。
- 不处理 `[dropped §4§]/[dropped §5§]` 的 user 注入清扫（设计内行为，原文可 ctx_expand 取回）。
