# CR Fix Spec: v0.1.0 全量评审（Phase 2a 集成 + 2b + 3）

## 元信息
- repo: D:\Dev\Js\oh-my-zcode\omz
- base_sha: 1fa2d0e（phase1/cr-fixed） / head_sha: aba59a9（v0.1.0）
- prd_path: 未提供 / spec_path: docs/iterations/oh-my-zcode-fork/spec.md
- review_round: 3 / dag_version: 3（wave-1 evidence×5 → wave-2 review-scope×5 → spec-fix r1 → wave-3 review-full → spec-fix r2 吸收三条改法级修正与五条盲区建议 → review-full-r2 轻量终校通过）
- 状态: fix-spec-ready（待用户确认开工）
- 评审节点与产物：cache/cr-v010-review-{mc-core,mc-host,protocol,ui-tui,brand-dist,full,full-r2}.md（R1/R5 为主代理手工等效审查，网络故障降级，已标注；review-full 第 4/5 节因断线未写完但修正项已全数给出并被 r2 终校验证落实）
- 执行注意：以下条目凡涉及 `magic-context` 包与 `cli` 包的文件改动，属评审裁定的越界豁免（原 dev-loop scope 外），执行时按本 fix-spec 的 scope 为准。

## Must-fix（按 P0 → P1 → P2；同文件同维保持最高严重度）

### MF-01 [P0] magicContext.enabled 二级开关完全未接线（spec 契约 8 违背）
- 维度：A/G ｜ 文件：`bootstrap/src/app/runtime-config.ts:190-193`、`create-app.ts:778-788`、`core/src/runtime/helpers/magic-context-turn-transform.ts:209-211`、`magic-context/src/host/config/schema.ts:240`
- 问题：spec 契约 8 定义 `effective = features.magicContext && magicContext.enabled`；实际 `runtimeConfig.magicContext.enabled` 只镜像 features flag，装配门只查这一位，`createMagicContextTurnTransform({enabled:true})` 硬编码。`config.enabled` 全仓仅被 `findConfigReadinessError` 读一次。D-12 设置页把它当表单字段提交——UI 报保存成功但行为不变。
- 改法：`runtime-config.ts:190-193` 改算 `features && (config.magicContext?.enabled ?? true)`（冷生效）；为满足 D-12 热生效，给端口加 `isEnabled()` 活值谓词由 core helper 现读（runtime.config 冻结，不能直读）。
- 验收：enabled=false 冷启动 → 不插桩/工具不注册/无 DB 写（T-M8 零差异）；设置页切换 enabled 下一 turn 生效（T-U1 级；**r2 口径界定（review-full N-5）**：热生效验收限定「实现了 `getConfigPort` 的 resident session」——轻量 embedder 与测试 record 不实现该能力、收不到 fan-out 属既有设计，勿写出只在后者上通过的验收）。
- 来源：review-mc-host/G-1

### MF-02 [P0] CDN 旧 id 别名容忍不可达：真实环境官方插件市场刷新必败
- 维度：B/A ｜ 文件：`adapters/src/plugins/marketplace.ts:356-382`、`contracts/src/plugins/index.ts:22-24`、`adapters/src/plugins/official-marketplace.ts:121-128`
- 问题：CDN 仍发布 `zcode-plugins-official`；刷新路径 `:366-373` 先抛（trustedId=canonical 而 name≠canonical），`:375` 仅在 name=canonical 时才调 writeCdn 分片——4c8a580 的别名分支永不可达。isOfficialMarketplaceId 只认新 id。E2E B7「别名容忍成立」结论失实（沙箱根本没发生刷新）。
- 改法（**r2 修正版**——r1 版直接扩集 `isOfficialMarketplaceId` 会使 `:356` 保留字检查在「trustedId=canonical + manifest=旧名」的受信任刷新路径上**提前自撞抛错**，review-full 2.1 实证）：
  1. `contracts/src/plugins/index.ts` 拆两个语义：`isOfficialMarketplaceId(id)` =「canonical ∪ legacy」扩集；新增 `isCanonicalOfficialMarketplaceId(id)` 只认 canonical。
  2. `marketplace.ts:356` 保留字检查改为：`isOfficialMarketplaceId(name) && !isCanonicalOfficialMarketplaceId(input.trustedId ?? "") && name !== input.trustedId` 才抛——受信任的 canonical 刷新不再被旧名自撞。
  3. `marketplace.ts:366` 守卫改为「manifest 名不在 canonical∪legacy 集合才抛」；`:375` 判定改 `isOfficialMarketplaceId(loaded.manifest.name)`（旧名 manifest 也能进 writeCdn 分片；rebuild:81 本就把 merged name 归一 canonical，持久化不变）。
  4. 复核 `bootstrap/src/plugins.ts:1084/1094/1111/1184` 四处 `isOfficialMarketplaceId` 调用点——扩集后语义从 canonical 变为 canonical∪legacy（方向无害：旧名声明纳入保留诊断），逐处登记确认。
  5. 注释登记过渡语义（CDN 换新名后摘除 legacy）+ **与 OQ-6 互相回指**：本条只治 marketplace manifest/刷新侧；`plugins.enabledPlugins` 的 `xxx@zcode-plugins-official` 旧后缀仍按 OQ-6 不迁移——「市场能刷新但旧后缀插件条目不复活」是预期，勿误报为本条未修好。
- 验收：adapters 新单测（旧名 manifest + trustedId=canonical → **刷新成功**/分片落盘/merged=canonical；第三方名 + 非 trusted → 仍抛 reserved）；隔离 HOME 真实网络刷新 → `cdn-marketplace.json` 出现且无 lastRefreshFailure。
- 来源：review-brand-dist/B-1（主代理代码回读验证）

### MF-03 [P1] 调度器 shutdown 的 abort 信号在装配层被丢弃
- 维度：C-orch ｜ 文件：`bootstrap/src/app/magic-context-historian.ts:339`（runSession 无 signal 形参）→ `:315`→`:401-416`→`:475` 全链无 signal；包侧 `historian-scheduler.ts:132` 已传
- 问题：shutdown() 停不掉在飞的 provider 请求；包侧注释明写 MUST honour signal。
- 改法：runSession 加 signal 形参一路透传至 `startCompartmentAgent`；给 `createHiddenCompletionExecutor` options 加 `externalSignal` 注入点（与 slot.controller AbortSignal.any 或手动联动）。
- 验收：单测——shutdown() 后 mock sidecar 的 abortSignal 变 aborted、slot 状态记 aborted。
- 来源：review-mc-host/C-orch-2

### MF-04 [P1] 调度器 fire-and-forget pass 无 settle 保护（与 S24-fix2 前提冲突）
- 维度：C-orch ｜ 文件：`core/src/runtime/helpers/magic-context-turn-transform.ts:1137`（settle 只护 transform 内部 run）→ `:1156 onPassSucceeded`→`:839 notifyTurnSuccess`（新起 run 纯 fire-and-forget）
- 问题：一进程=一轮语义下，turn 成功后的调度器 pass 系统性被进程退出截断（drain 预留泄漏/compartment 不落库，`:970-985` 注释自陈该风险）。
- 改法：`:1156` 后对调度器新 run 补有界 settle（同 60s 语义）；或显式承认 best-effort 并修正注释（二选一，倾向前者）。
- 验收：turn 成功后进程立即结束 → compartments 落库、无 drain 预留泄漏（E2E 级）。
- 来源：review-mc-host/C-orch-3

### MF-05 [P1] shutdown/drain/dispose 零调用方 + spec 的 hooks.ts 缺失
- 维度：C-orch/A ｜ 文件：装配层（create-app.ts）；spec.md:192（hooks.ts：session start/end、turn 后 drain）
- 问题：`drainHistorianSchedulerWithTimeout`/`historian.shutdown`/`config-bridge.dispose` 无生产调用方；config-bridge.ts:882 订阅 ConfigPort 永不退订。与 app/types.ts:114 注释落差。
- 改法：装配层加生命周期接线（drain→shutdown→bridge.dispose 顺序）。**r2 补锚点（review-full 2.3/3.3）**：真实挂载点在 `bootstrap/src/app/session-facade.ts:264-308` 的 `close()` 链——插在 `:274 closeDynamicWorkflowRuns` 之前、`:294 closeSessionResources` **之前**（historian 在飞请求必须先于 store/execution port 关闭收口，否则写库到已关闭 store 上是隐性 bug）；参照 `create-app.ts:958-960` 的 `closeDynamicWorkflowRuns` 注入范式把钩子递进去；整段套 `:274-289` 的 try/catch + logger.warn 兜底——historian 关闭抛错不得吃掉后续资源关闭。spec hooks.ts 其余钩子按需落或登记收窄。
- 验收：app 关闭后调度器无在飞 pass、ConfigPort 订阅计数归零（单测）；关闭顺序断言（historian drain 完成先于 closeSessionResources）。
- 来源：review-mc-host/C-orch-4

### MF-06 [P1] /ctx-* 不认 feature flag：off 态开库 + harness 错写 "opencode"
- 维度：G ｜ 文件：`cli/src/command-center/handlers/ctx.ts:72-75,217-226`、`magic-context/src/host/ctx-status.ts:191-197`、`storage-ops.ts:94`、`core/shared/harness.ts:34`
- 问题：off 态敲 /ctx-status 仍 openDatabase；/ctx-reduce 写出 `pending_ops.harness="opencode"`（host/harness.ts:2-11 自称 correctness bug）。读面不带 harness 过滤，错写污染归因列。
- 改法：handleCtxCommand 开库前取 effective flag，false 直接回 UNAVAILABLE 不开库；/ctx-reduce 的自建工具路径补 harness="zcode" 归一（或复用 initializeMagicContextHost 的 harness）。**r2 硬约束（review-full N-1）**：effective 必须**同源**——经 `CommandCenterApp` 可选能力 `isMagicContextEnabled?()` 暴露，其值由 create-app 从 `runtimeConfig.magicContext.enabled` 透传（与 MF-01 同一字段同一次求值）；`ctx.ts` **不得**自行读 `features` 或重算，否则 features=true+enabled=false 时命令面与 turn-loop 分叉。
- 验收：off 敲四命令全回 UNAVAILABLE 且不建库；on 时 /ctx-reduce 的 pending_ops.harness=="zcode"；与 MF-01 合并的 on/off 双态 E2E 含「两处 effective 同源」断言（enabled=false 时 /ctx-status 与 transform 同步关闭）。
- 来源：review-mc-host/G-5（吸收 iteration-state 已登记的 /ctx-status off 建库遗留项）

### MF-07 [P1] update RPC 信封 config 空值：静默重置整域并写盘
- 维度：C/G ｜ 文件：`packages/shared/src/zcode-protocol/index.ts:2146-2151`、`bootstrap/src/zcode-protocol/magic-context-config.ts:122,132,147,163`
- 问题（**r2 修正**）：review-full 2.2 在 zod@4.6.5 下实跑推翻 r1 前提——`.strict()` 信封里 `z.unknown()` 键**缺席已被 nonoptional 检查拒绝**（`{workspace}` 现在就抛 invalid_type）；**真实可达路径是 `config: null` / `config: undefined`**（键存在值为空，JSON-RPC 线上合法），二者穿过 strict 后命中 handler `:122` 的 `?? {}` → 全默认域 → 写盘+fan-out+applied:true，静默重置后果与原裁定一致。现有测试的 `config:{}` 用例与「值为空」语义不同，两条路径均零覆盖。
- 改法：信封 `.refine((p)=>p.config!==undefined && p.config!==null, {message:"config is required and must not be null: 整域替换，缺席或空值等于重置", path:["config"]})`（勿用 .default/.catch）；handler `:122` 的 `?? {}` 改为显式抛 -32602 纵深防御；订正 :2142-2144 注释（说明键缺席走 object 层 nonoptional、空值走本 refine）。
- 验收：config-rpc 套件新增**两条**用例——`{workspace}`（键缺席 → -32602）与 `{workspace, config:null}`（空值 → -32602 + 磁盘与 ConfigPort 均未动）；三套 typecheck+lint 绿。
- 来源：review-protocol/C-1

### MF-08 [P1] RewindStrategy.FileOnly 死枚举 + 4 恒假条件 + 永不可达的 compaction 文案
- 维度：A ｜ 文件：`contracts/src/rewind/index.ts:29,69-74`、`core/.../rewind.ts:244-247,326-329`、`rewind-message.ts:250-253,351-354`
- 问题：evaluateRewindTarget 无 FileOnly 产生点；wire schema 仍宣告；两处 `===FileOnly` 分支下的用户可见英文串（"…stayed at the compacted context."）是 Step 28 残留扫描唯一漏网的面向用户 compaction 措辞（藏在恒假分支里）。
- 改法：删 FileOnly 成员+wire 项；两处比较简化；删 strategyText 三元及响应串插值。
- 验收：`rg "FileOnly|file_only"` 归零；补 evaluateRewindTarget 收窄行为单测。
- 来源：review-protocol/A-1

### MF-09 [P1] 设置页 per-model token 覆盖静默丢失（数据损坏级）
- 维度：C ｜ 文件：`packages/ui/src/settings/magicContextSettingsForm.ts:64-67`（读）+ `:140-146`（写）
- 问题：schema 的 `execute_threshold_tokens.default` 可选且支持 per-model keys；读侧无 default 坍缩 null；写侧 null 即 delete 整表——抹掉用户看不见的 per-model 键。dirty 用 stringify 全域比对使零改动时保存按钮可点，点一下即销毁配置。违反文件 :55 自述不变式。
- 改法：写侧改为只摘 default 分支保留 per-model 键（`const {default:_,...rest}=prev; keys(rest).length?rest:delete`）。
- 验收：test-magic-context-ui-config.mjs 补 per-model-only 用例 + stringify 相等回归。
- 来源：review-ui-tui/C-01

### MF-10 [P1] 清空「历史预算占比」写入越下界 0
- 维度：B/J ｜ 文件：`packages/ui/src/settings/MagicContextSettingsFields.tsx:63-70,163`
- 问题：decimal 分支不走 parseOptionalNumber，`Number("")===0` 且 finite → 守卫放行 → 写 0（schema 下界 0.05）→ 保存必被 -32602 拒；同处也放行非空越界值。
- 改法：空串优先 onChange(null)；按 :220-222 自述意图在 UI 层挡越界（不采纳或 clamp）。
- 验收：onChange("") 收 null；清空弹回 0.15 且保存禁用；0.9 不采纳。
- 来源：review-ui-tui/C-02

### MF-11 [P2] publishUsageSummary 空 catch 与注释承诺不符
- 文件：`core/src/runtime/helpers/magic-context-turn-transform.ts:806-814` ｜ 改法：`.catch(()=>sink(null))` ｜ 验收：注释与行为一致；单测失败路径推 null。来源：review-mc-host/G-6

### MF-12 [P2] 两个 deferred 缝文件含裸 NUL 字节（git 判 binary）
- 文件：`magic-context/src/core/deferred/{ctx-reduce-availability,embedding-failure}.ts`（偏移 4127/5996，主代理字节级已验证）｜ 改法：裸 0x00 → `\u0000` 转义（对齐上游）｜ 验收：两文件恢复文本 diff；git grep 正常命中。来源：review-mc-core/C-1

### MF-13 [P2] storage-db.ts 未使用 import（S24-fix 漏删）
- 文件：`.../features/magic-context/storage-db.ts:21`（harnessOwnsOpenCodeStore，grep=1 仅 import）｜ 改法：删该项；**不**顺手清零消费 barrel 导出（上游表面，见 Deviations）｜ 验收：包 build 过、grep 零命中。来源：review-mc-core/C-2

### MF-14 [P2] UPSTREAM-SYNC.md 把 core 侧原语列为"必填字面量"落点（与实际类型不符）
- 文件：`UPSTREAM-SYNC.md` §3 ｜ 改法：改为「字面量强制点=包内 host/hidden-completion-executor.ts；core 侧是通用门面（可选 boolean 透传）」｜ 验收：文档 review。来源：review-mc-core/C-3

### MF-15 [P2] storage.ts barrel 头注与代码分叉（FTS/project-docs-hash）
- 文件：`.../features/magic-context/storage.ts:13-16`（storage-db.ts:1108 FTS backfill 真实调用、project-docs-hash 190 行被 inject-compartments:39 消费——均主代理验证）｜ 改法：头注两处改为与实际一致｜ 验收：纯注释。来源：review-mc-core/C-4

### MF-16 [P2] DB 解码零校验 + 首启提示的复制建议与旧会话不兼容的张力
- 文件：`adapters/src/storage/session-store/codecs.ts:115-122`、`cli/src/data-dir-notice.ts:57-68`、spec L357 ｜ 改法：不加兼容层（守 D-7）；formatNotice 追加「旧会话记录可能无法在新版本中打开」；spec L357 补「DB 解码不做 schema 校验」事实登记｜ 验收：manual——旧 compaction part 复制进来表现为「该 part 不渲染」而非整条消失。来源：review-protocol/B-1

### MF-17 [P2] saved-workflow project scope 注释矛盾（常量 .zcode 对、注释 .omz 错）
- 文件：`contracts/src/tools/saved-workflow.ts:19,25,43-46`、`packages/shared/src/zcode-protocol/index.ts:2729`、**r2 补三处（review-full 3.5 实测 rg 命中，不补则验收必失败）**：`core/src/tool/handlers/saved-workflows/store.ts:53`、`packages/ui/src/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.ts:20`、同文件 `:62`（用户可见日志文案；**跨 scope 授权**：packages/ui 属 ui-tui scope，本条显式授权执行者跨入）
- 改法：上列站点全部改回 `.zcode/workflows`（全局档 ~/.omz 不变）；:18 加分层锚定注释；补一致性断言
- 验收：`rg "\.omz/workflows"` 仅剩全局档语义。**与 MF-33 去重归属**：saved-workflow.ts:43-46 由本条独占编辑，MF-33 对该文件只复核不重复改。
- 来源：review-protocol/C-orch-1 + review-full 3.5

### MF-18 [P2] adapters config schema 三行缩进压列 0
- 文件：`adapters/src/config/schema.ts:434-436` ｜ 改法：恢复 2 空格｜ 验收：单文件 oxfmt --check 过。来源：review-protocol/G-1

### MF-19 [P2] ConfigValue<"magicContext"> 恒等装饰分支 + mapping 2 无测试
- 文件：`contracts/src/config/index.ts:170-172,91-106` ｜ 改法：删恒等分支改注释；加编译期锚点（`const _: ConfigKey = "magicContext"` 使删 key 编译失败）；test-magic-context-domain 补 mapping 2 前缀用例｜ 验收：临时删 key → typecheck 红。来源：review-protocol/G-2

### MF-20 [P2] 写盘层「不回显」理由与协议 result 回显互相打脸
- 文件：`adapters/src/config/file-config.adapter.ts:41-52` ｜ 改法：注释改为「域值由协议层统一回显，写盘层再回显是第二份出口」；删「十几 KB」半句｜ 验收：无行为改动。来源：review-protocol/C-2

### MF-21 [P2] DEFAULT_MAGIC_CONTEXT_CONFIG "transcribed" 注释失真 + 恒真断言 + 无键集合断言
- 文件：`magic-context/src/host/config/schema.ts:219-224`、`magic-context/scripts/test-config.mjs:74`、`adapters/scripts/test-magic-context-domain.mjs:170-176` ｜ 改法：注释 transcribed→derived；:74 换顶层键集合断言；domain 侧补「adapters re-export 与包内导出同一对象」assert.equal｜ 验收：临时加带 default 新键 → test-config 红。来源：review-protocol/C-3

### MF-22 [P2] i18n 漏删 3 条零消费 key + 1 陈旧注释
- 文件：`packages/ui/src/i18n/locales/{en-US:4730/4731/4680, zh-CN:4429/4430/4382+注释:4381}` ｜ 改法：删 `chat.contextUsage.compress/compressDescription`、`chat.queue.runNow` 双语 + 陈旧注释｜ 验收：grep 零命中；parity 不变。来源：review-ui-tui/A-01

### MF-23 [P2] knip 口径双破：4 条新增未用导出
- 文件：`packages/ui/src/settings/magicContextSettingsForm.ts`、`chat-input-toolbar/magicContextUsageRows.ts`（NO_HISTORIAN_MODEL_VALUE/MagicContextNumberFieldSpec/MagicContextUsageRow/MagicContextUsageRowInput）｜ 改法：去 4 个 export｜ 验收：knip stash 对比零新增 + 零 magic-context 命中；desktop typecheck 过。来源：review-ui-tui/G-01

### MF-24 [P2] 设置分区 5 个输入控件无 a11y 标注
- 文件：`MagicContextSettingsFields.tsx` ｜ 改法：本分区 5 控件补 aria-label（不动 SettingsPageParts 共用原语）｜ 验收：axe 或人工核对。来源：review-ui-tui/J-01

### MF-25 [P2] MIN-MAX 三处真相（i18n 文案硬写数字零校验）
- 文件：`zh-CN.ts:2021/2028/2032`+en 对应、`magicContextSettingsForm.ts:223-232` ｜ 改法：i18n description 去掉硬数字（描述性措辞），SPECS 表保留为唯一 UI 侧副本｜ 验收：grep "20–90" 等数字串归零。来源：review-ui-tui/C-04

### MF-26 [P2] placeholder="5m" 绕过 i18n
- 文件：`MagicContextSettingsFields.tsx:175` ｜ 改法：删 placeholder（description 已有示例）或入 i18n｜ 验收：无硬编码展示串。来源：review-ui-tui/A-02

### MF-27 [P2] 保存失败 toast 丢弃服务端字段级错误
- 文件：`MagicContextSettingsSection.tsx:142-148` ｜ 改法：toast 追加 error.message（formatIssues 已含字段路径）｜ 验收：-32602 时用户看到字段名即可（r2 口径：MF-07 的 refine 消息较长，toast 含 config 字段名即达标，不要求完整可读）。来源：review-ui-tui/C-03

### MF-28 [P2] 面板直接呈现 SQLite 列名 m[0]/m[1]
- 文件：`magicContextUsageRows.ts:104-109` ｜ 改法：换用户可读标签（如 "系统段缓存/历史段缓存"，入 i18n）｜ 验收：面板无裸列名。来源：review-ui-tui/C-05

### MF-29 [P2] darwin SEA 配置为修复前陈旧产物（magic-context=0）
- 文件：`apps/zcode-cli/packages/cli/dist/sea-config-darwin-arm64.json` ｜ 改法：删除陈旧文件；发布 SOP 写明「sea-config 全 target 重建后方可发布」｜ 验收：dist 无 magic-context=0 的 sea-config。来源：review-brand-dist/C-1

### MF-30 [P2] EXEMPT-2b 加载点计数失真（7 处 vs 登记 5 处）
- 文件：`docs/.iteration-state.yaml`、`UPSTREAM-SYNC.md` ｜ 改法：更正为「5 静态 require + 2 动态 import」｜ 验收：两文档一致。来源：review-brand-dist/A-1

### MF-31 [P2] 终验报告补 install 演练证据勘误
- 文件：`cache/phase3-final-e2e-report.md` ｜ 改法：注记「M1 修复后 install 证据在 .e2e-s35/」（主代理已实证两文件内容为真）｜ 验收：报告含勘误。来源：review-brand-dist/A-2

### MF-32 [P2] 用户可见品牌残留 4 处
- 文件：`cli/src/env.ts:136`（zcode-beta 死触发）、`tui-runtime-loader.ts:120-138`+`sea-playwright-runtime.ts:120-134`（SEA 缓存根 zcode/sea-assets）、`i18n locales`（Starting ZCode…）、`README.md:88/README.en.md:82`（npm i -g 承诺 vs private:true）｜ 改法：删死触发（默认处置，OQ-3 待拍板）；缓存根改 `.omz/sea-assets`；启动串改 omz；README 安装节改 install.sh 口径｜ 验收：grep 归零；README 不承诺未发布渠道。来源：review-brand-dist/C-2

### MF-33 [P2] S34 合规口径三处矛盾 + 5 处机械注释不一致 + L1 重放规则措辞
- 文件：`LICENSE.magic-context:9,15-18`、`UPSTREAM-SYNC.md:11,64,80,83`、`NOTICE.md:12`、5 处注释（skillsService:134-138/:1209、saved-workflow:43-46（**该文件由 MF-17 独占编辑，本条只复核不重复改**）、shared/storage.ts:6、skills/skills.ts:25/31/39）｜ 改法：LICENSE 措辞改「上游以根 LICENSE 声明（无 per-file 头）；33 个误标头已订正 MIT」；.reference 路径统一 `<repo>/../.reference/`；UPSTREAM-SYNC L1 规则补「仅用户级 HOME 下 .zcode；工作区级刻意保留」；NOTICE 品牌行同注；5 处注释按代码事实改｜ 验收：文档两两一致。来源：review-brand-dist/C-3

## Spec deviations
- 经 fix-spec 处置（随上述条目闭合）：契约 8 enabled（MF-01）；hooks.ts（MF-05）；i18n 全删（MF-22）；MIN-MAX（MF-25）；T-P2（MF-02）；README（MF-32）；NUL（MF-12）；workflow 占位白名单（随 K 节 spec 修订）；UsageQuerySource spec 措辞（随 K 节 spec 修订——实际零影响）
- 已接受（登记，无需动作）：queueItemSchema 结论；工作区级 .zcode 保留；electron 身份不改；EXEMPT-2a/2b；v0.1.0 重指；src/core 既有 FORK 偏离集
- 建议收窄（**待用户确认**）：①S29 未抽专用 hook（功能等价含竞态版本号，接受内联实现）②`/compact` 命令面移除的 spec 显式确认（D-7 已含，建议 spec 变更点清单补一句「含用户可见命令」）③historian.*/language 不热生效（E 组 pass 级白名单语义）

## Open questions / 待拍板
1. historian `fallbackModels` 双链疑点（E1 锚点不符未裁定，:373/:494 待对照 executor 消费面查证）
2. `historianReasoningBudgetDiagnostic` 诊断串裁剪是否丢排障信息（对照 .reference）
3. `zcode-beta` 死触发：删除（MF-32 默认）vs 改名保留
4. SEA 缓存根改名后旧缓存失效是否可接受（默认接受）
5. `.zcodeignore` 与 locale 产品名 ZCode（~95/97 行）是否单独立项（R4 OQ-1：D-10 分层外，默认不动）
6. `plugins.enabledPlugins` 旧后缀不 canonicalize（D-7 下可接受，建议 spec 登记；**与 MF-02 互指**：MF-02 只治 marketplace manifest/刷新侧，旧后缀插件条目不复活是预期）
7. `/ctx-status` 双渲染并存与 `handlers/ctx.ts` 的 `fromConfigPort` 死字段（review-mc-host OQ-3 的两个 P3 级挂账：顺手修或明确不做）

## 已豁免（用户确认不修）
（无——如你对某条说"不修"，移到此节并附原话）

## 合并后 QA（manual_user）
- MF-02 修复后：真实环境打开插件市场刷新一次（T-P2 人工复核）
- MF-16：旧 ~/.zcode 会话复制到新目录打开，确认不崩、part 静默不渲染
- 桌面 UI 设置页实机走查（a11y/表单行为/面板标签）
- `--web` UI 冒烟（终验 M9 遗留）

## K 节建议（下游执行时闭合）
1. 全部改动文件跑 oxfmt --check（apps/zcode-cli 内用包内 oxfmt；编辑工具 CRLF 归一 LF）
2. knip stash 对比 + 零 magic-context 命中复跑（MF-23 后应回落基线）
3. 根 typecheck + CLI turbo + desktop-full 差分 + lint 71w/0e
4. 相关测试套件：config-rpc（+MF-07 两条用例）、ui-config（+MF-09/10 用例）、feature-flag/domain/ctx-commands、sidecar 6、historian 6、mc 全套
5. spec 文档四处修订（K 节内完成）：L290 白名单补 dynamic-workflow 占位；L229 UsageQuerySource 措辞改「零影响」；变更点清单补「/compact 含用户可见命令面」；S29 复用锚点标注失效（runSettingsActionAsync 已被掏空为本地恒等函数、SettingsResourceGroup 实为 SettingsGroupCard 场景）
6. E2E 回归：MF-01/06 的 on/off 双态（含同源断言）+ MF-02 真实 CDN 刷新（隔离 HOME）

## 执行编排建议（供 code-dev-loop）
- Wave A（P0）：MF-01 → MF-02（含单测+真实刷新冒烟）
- Wave B（生命周期组）：MF-05 → MF-03 → MF-04（同面设计，一个 agent 顺序做）
- Wave C（正确性散件）：MF-06/07/08/09/10/11
- Wave D（机械批）：MF-12..33（文档/注释/i18n/knip/a11y）

## Fix-Spec Closure
| 项 | 状态 |
|---|---|
| fix-spec-ready | yes（review-full-r2 轻量终校：8 项核对 5 yes + 3 partial，4 处文本级瑕疵已由主代理补齐——OQ-6 回指/MF-33 归属/MF-04 分段） |
| fix_spec_path | docs/iterations/oh-my-zcode-fork/cr-fix-spec-v0.1.0.md |
| dag_version / review_round | 3 / 3 |
| P0 / P1 / P2（已写入 fix-spec） | 2 / 8 / 23 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | 修复型随 MF 闭合；3 项收窄待用户确认（不阻塞开工，可在执行中确认） |
| C-orch | ✅（生命周期接线/同源 effective/双清单一致性均已成条） |
| C 类合并后 QA | 见「合并后 QA」节 |
| 置信度声明 | review-full 第 4/5 节因网络断线未完成，其抽查结论由 review-full-r2 的 8 项核对与本文件 r2 修正闭环补足；R1/R5 scope 为主代理手工审查（已标注，锚点均经主代理回读验证） |
