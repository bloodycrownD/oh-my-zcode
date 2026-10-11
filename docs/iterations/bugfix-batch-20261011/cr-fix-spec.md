# CR Fix Spec: bugfix-batch-20261011
- 波次①（Step 1-3 settle）：base/head `d69ef5e4`/`cfaf198e`
- 波次②（Step 4-6 模型）：`8bb5a132`+`899cb577`+`39a4939f`+`48167077`（区间内排除 Step 8 三提交另案）

## 元信息
- repo：D:\Dev\Js\oh-my-zcode
- base_sha / head_sha：`d69ef5e4` / `cfaf198e`（3 commits：`67a48e96` 形态透传 / `2255ac5b` 两处 settle 条件化 / `cfaf198e` 单测分化+新测）
- prd_path：无（用户口述，见 spec「需求来源」）
- spec_path：docs/iterations/bugfix-batch-20261011/spec.md（Step 1-3 + 测试策略 T-S 系列 + FORK 纪律节）
- review_round / dag_version：1 / 1
- 结论模式：diff（单轮，readonly 评审；本会话无 Task 子代理工具，按 skill 兜底条款由主代理**手工等效审查**）
- 状态：draft

## Must-fix（按 P0 → P1 → P2）

### 波次②（模型 Step 4-6，CR round 1，2026-10-10）

#### MF-ML-1 [P1] UI 层切模型下发断言整类未交付（裁定=b 登记收窄+实机升级，用户可否决改 a 补测）
- 维度：A / G
- 处置：spec 测试策略 ui 条目注明「`handleSelectModel → dispatchConfigCas("switchModelConfig")` 渲染层下发由 Step 7 manual_user 桌面实机直证（CDP 锚点 `chat-model-select-trigger`/`v4-model-config` 已备于 cache/cdp-anchors.md，切模型→排队提升用新模型列为必测项）；协议命令侧由 test-model-live.mjs+verify-e2e 覆盖」；**升级：Step 7 实机验收清单显式加入「切模型后 UI 无 toast 错误 + 提升轮模型变更时间线 marker」两断言**。
- 备选 a（若用户否决）：补 `packages/ui/test/sessionPaneSelectModelDispatch.test.ts`（mock store/rpc，断言 sessionId≠null 时经 barrier enqueue switchModelConfig、null 时不下发、CAS reject 只 warn 不弹 toast）挂根 test:v4-perf。
- 验收：spec ui 条目与 Step 7 清单同步更新；或 a 路径测试全绿。

#### MF-ML-2 [P2] test-subagent-live-model.mjs 头注释误引用例编号
- 文件：apps/zcode-cli/packages/bootstrap/scripts/test-subagent-live-model.mjs（头注释）
- 处置：`T-MU1/T-MU2` → `T-ML5`（T-MU1/2 属 Step 15 mural 面）。

#### MF-ML-3 [P2] `?? 0` 防御分支注释论据失实 + 零直证
- 文件：queue.ts:164 注释；test-model-live.mjs 补一用例
- 处置：注释改「TS/zod 层 admittedAt 必填（queueItemSchema extends conversationInputIntentSchema）且 queue 不持久化（snapshot.ts:257）——`?? 0` 仅防御异常/跨版本数据：任何真实切换都晚于 0，活值胜出」；test-model-live.mjs 补用例（item 缺 admittedAt + 已切换 → 提升用活值）。

#### MF-ML-4 [P2] 测试挂载不一致 + subagent 测试零门禁入口
- 文件：bootstrap/package.json、根 package.json test:v4-perf、spec Step 19 登记
- 处置（裁定=两测试统一进根聚合）：bootstrap 补 `"test:model-live": "node --test scripts/test-model-live.mjs"`；根 test:v4-perf 的裸路径改为 `pnpm --dir apps/zcode-cli/packages/bootstrap run test:model-live`（build 前置保留）并追加 `test:subagent-live-model` 同款；spec Step 19 登记两入口。

#### MF-ML-5 [P2] spec 脚本名/文件面与交付不符
- 文件：spec 测试策略节 + 变更点 3a
- 处置：`test-subagent-override-live.mjs` → `test-subagent-live-model.mjs`；3a 的 `profile.ts` 删去并注「per-spawn 活读已在 runner.ts resolveProfiles 达成，profile.ts 无需改」。

#### OQ-1 口径补充（spec 一句话）
- `sameModelSelection` 已把 reasoningLevel 纳入比较（切 thought 也记 lastModelSwitchAt、也触发 promote 覆盖）——spec「模型选择变值」补注「含 reasoningLevel/thought 级变更，与 sameModelSelection 比较面一致」。插入锚点：spec 缺陷②分述 b 刀句末（「模型选择语义」节亦可，二选一并在 spec 标注）。

### 波次③（记忆 Step 8-9，CR round 1，2026-10-10）

#### MF-MC-1 [P2] T-MC0b 门测试缺 autoPromote=false 臂（门半开零覆盖）
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-memory-promotion.mjs
- 处置：新增 T-MC0b2——`runHistorianOnce(session, { memoryEnabled: true, autoPromote: false })`：compartments 落 1（防假阴性前提）+ memories 计数不变（Issue #44 双门 `:556-559` 的右臂）。

#### MF-MC-2 [P2] unanchored promotion skip 缺可观测日志
- 文件：compartment-runner-incremental.ts（skipUnanchoredPromotion 判定处）
- 处置：按上游 `:957-967` reason 枚举补 sessionLog（含 facts 计数）；至少一条 discard-last 场景断言日志出现。落位 apps/zcode-cli/packages/magic-context/scripts/test-memory-promotion.mjs（新增 T-MC0c：双舱 fixture，末舱紧贴 eligible head 触发 discarded_last），断言 sessionLog 含 reason=discarded_last 且 facts 计数在场；fork 无上游 publishableEvents，events_publishable 计数按 fork 可观测字段裁剪或省略（仅强制 reason+facts）。

#### SD-MC-1（步骤-commit 映射重排，登记即闭）
- spec Step 8/9 与实际 commit 的映射（944b4967 承载全部 4 缝 mv、a10e74a1 承载测试）已在 spec r5 修复中按「Step 9 已由 Step 8 提交吸收」口径闭环，此处仅登记。

#### OQ-MC-2（rename 呈现勘误，spec 三态段补一句）
- 大文件内容整体替换（壳 66/50 行 vs 真身 1267/296 行，共享行 <20%）git 呈现 D+A 而非 R——轨迹靠同 commit 对偶删除 + FORK-NOTE「WHAT CHANGED VS THE SEAM IT REPLACED」段可追溯；spec 壳缝①措辞按此修正。

### 波次④（ctx 配置 Step 10-11，CR round 1，2026-10-11）

#### MF-CTX-1 [P2] ctx-search id 短路路径可见性分歧（archived/expired 可回；状态守卫为 no-op）
- 文件：apps/zcode-cli/packages/core/src/tool/handlers/ctx-search.ts（id 形状短路块）
- 处置：id 块补与 FTS 一致的过滤（status ∈ active/permanent 且 expires_at 未过，经 getMemoriesByIds 返回值判断）；现 status 守卫（仅三值枚举、恒真）删除或改为真实过滤。
- 验收：archived id → No results found；expired id → No results found；active id 直查命中（单测或探针）。

#### MF-CTX-2 [P2] 设置页文案对未接线消费者过度承诺
- 文件：packages/ui/src/i18n/locales/zh-CN.ts + en-US.ts（memoryEnabled/promptSurface/muralEnabled 三组 description）
- 处置：加接线态限定（如「随记忆注入/提示词面/画布渲染接线后生效」），与 schema.ts「运行期消费方按各自 Step 接线」注释口径对齐，中英同步。
- 验收：Step 12/13/15 接线前三开关拨动无行为反馈，文案不含无保留行为断言；中英一致。

#### MF-CTX-3 [P2] core 测试两例名不副实
- 文件：apps/zcode-cli/packages/core/scripts/test-ctx-search-memory.mjs
- 处置：「resolves an id-shaped query directly and ignores other projects」补跨项目断言（foreign 项目 id 不可见）或改名收敛；「honors limit, date range」补 limit:1 截断 + 合法 from/to 过滤断言或改名收敛。
- 验收：每个用例名 ⊆ 断言集合。

#### OQ-CTX 登记（不进 must-fix，转后续波次）
- commandId 账本两份同构（core ctx-memory.ts / 包 ctx-reduce tools.ts）：可接受；core 若再接 ctx 工具应在 barrel 出共享账本面（Step 12/16 复核）。
- Step 12 落 light-descriptions 时 full（core handler）/light（包）描述的 drift guard 机制由 Step 12 显式裁定。
- Step 15 需把 config.mural.enabled 透传进 pack options（inject-compartments.ts:2550-2554 已有消费端语义，bootstrap buildTransformDeps 未传）。
- Step 13 接 memory.enabled 时在 schema 注释与 features.memory（D-11）互指，防误伤。

### 波次⑤（prompt-surface Step 12-14，CR round 1，2026-10-11）

#### MF-PS-1 [P2] getToolSetHash 闭包陈旧化——长驻进程 preset 翻转后审计指纹恒旧
- 文件：apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:1653
- 问题：`getToolSetHash: () => promptSurfaceConfigIdentity(config.prompt_surface)` 闭包捕获装配期 config 对象；`bridge.onChange → applyConfigToDeps` 只原地改写 `deps.promptSurface`（config-bridge 每次 refresh 产新对象），指纹不刷新 → 长驻进程（桌面/app-server/TUI）设置页翻转 preset 后 `m0ToolSetHashPrev == New` 恒等，transform_decisions 看不到翻转。零折叠影响（toolSetHash 永不折叠 m[0]），仅审计保真；与 Step 12 提交自述「预设翻转必须留得下审计操作数」相悖。CLI 一进程一轮无此问题。
- 改法（最小，不动 applyConfigToDeps）：构造后赋值 `deps.getToolSetHash = () => promptSurfaceConfigIdentity(deps.promptSurface)`（TransformDeps 该字段可选，构造后赋值过类型检查）。
- 验收：bootstrap 测试驱动 ConfigPort `magicContext.prompt_surface.default` full→light，断言 `deps.getToolSetHash()` 前后不等且 transform_decisions.m0_tool_set_hash_new 为新身份；magic-context test-prompt-surface 26 + core tiering 5 + section 10 + transform 38 全不回归。

#### OQ-PS 登记（转后续波次/fix 节点顺手）
- `context/sections/magic-context.ts` buildMagicContextSectionEntry("")：契约注释称空内容返回 null，但 `"".startsWith(heading)` 先抛错使空串→null 成死代码；Step 18 收口时把空串纳入 null 路径（防未来 resolver 以 "" 表达不注入时每轮崩 context build）。
- i18n `settings.context.promptSurfaceOverrides.empty` 两 locale 定义未使用（死 key）：Step 19 清理或保留备用。
- spec 同步（fix 节点一并落）：① Step 13/14 步骤表错位——实际互斥在 09b52efe（标 Step 13）、设置面消费在 e81dc870（标 Step 14）而步骤表无对应行，补 commit 映射 K-note + 把「设置面消费」显式写进步骤表；② D11 措辞——spec 写「sections/memory.ts 不注入」，实现在 builder.ts 以段在场为门（语义等价），spec 文本对齐；③ 行数口径——211/163/284 实为 210/162/283（含尾 LF 计法），spec/FORK-NOTE 统一注明。

### 波次①（settle Step 1-3，CR round 1）

#### MF-1 [P2] T-S1 后半（idle-only promotion lease）与 T-S2「折叠落库」缺直证
- 维度：A / G
- 文件：
  - apps/zcode-cli/packages/bootstrap/scripts/test-settle-background.mjs
  - docs/iterations/bugfix-batch-20261011/spec.md（登记）或 cache/ 证据包（覆盖映射）
- 问题：spec Step 3 规定新测断言三件事，本轮只全量交付第一件（「model step 不等两处 settle」：顺序 + <100ms 计时 + 钩子 0 调用 + 在飞 run 仍在场）与第三件的前半（close drain 收口契约：drain 等在飞 pass 落定再 shutdown；registerClose 恰好注册 1 次且可调用）。其余两点无直证：
  - 「turn 完成后 idle-only promotion lease 即可获取」（T-S1 后半，blocking）只在测试注释里推理——core `runtime-command-queue.ts` 的 `acquireForegroundPromotionLease` 五条件门本批未改动，且全仓无任何单测直接覆盖它；
  - 「折叠落库」（T-S2）只用**桩调度器**证明 drain 契约（`getLastStatus === "success"` 是桩返回），真工厂用例未断言临时库里有折叠行。
- 改法（**已裁定：混合方案 a+b**——主代理裁定，用户可否决 (b-落库) 的登记收窄并升级为路径 c：在 test-settle-background.mjs 内以真工厂真临时库直证折叠行落库（与 a-lease/b-落库互斥的第三选项））：
  - **(a-lease) 补强**：core 侧补 `acquireForegroundPromotionLease` 五条件门单测（`apps/zcode-cli/packages/core/scripts/`，`tsx --test`，**仅加测试、不动 core 源码**，遵守 core 零改动纪律；用例：五条件逐一 occupied→refuse、全空→acquire、执行期互斥）。这是「排队不被 settle 卡」论断的机制直证，全仓当前零覆盖。**挂载**：core/package.json 补 `"test:promotion-lease": "tsx --test scripts/test-promotion-lease.mjs"`（core 是逐脚本约定，裸放不进 script 会命中 knip 未用文件）；是否入根 test:v4-perf 由 fix 节点声明（建议入）。行号口径：五条件块为 runtime-command-queue.ts:125-134。
  - **(b-落库) 登记收窄**：在 spec 测试策略 T-S2 条目与 cache/settle-chain.md 写明覆盖映射——「折叠落库」由 magic-context 既有 historian 测试（`magic-context/scripts/test-historian.mjs` 18 项 + bootstrap `test-magic-context-historian.mjs`）+ MF-05 close drain 契约用例 + T-S3 实机覆盖；新测不重复断言临时库折叠行。
- 验收/测试：T-S1 后半（lease）有 core 单测直证；T-S2 有登记覆盖映射；`node --test scripts/test-settle-background.mjs` 继续全过；新 lease 单测全过。
- 来源：review(diff, 主代理手工审查) / round 1

## Spec deviations
- SD-1（**fixed**，2026-10-10 裁定）：同 MF-1——按混合方案闭合（a-lease 补单测 + b-落库登记收窄）；T-S1 后半改为「由 core lease 单测直证」，T-S2 改为「登记覆盖映射」。T-S3 实机保持终验。

## Open questions / 待拍板
1. stash 披露核实备注：实现者自述「误 pop 他人 stash（dev/phase-0 WIP）后 checkout HEAD 还原」。git 事实——区间内 `packages/adapters` 零提交、工作区该 3 文件（`scripts/test-magic-context-domain.mjs`、`src/config/file-config.adapter.ts`、`src/config/schema.ts`）无改动、`stash@{0}`（06f7b41f，2026-10-05 创建）**仍在且 reflog 显示从未被 pop**。即「误 pop」的措辞与实际 stash 状态不完全一致（可能 pop 失败或被回退），但披露的**终态**（3 文件还原、无残留）经核实成立。建议实现者更正过程描述，不影响本轮交付。
2. `zcode-protocol-entrypoint.ts:221` 的 server 工厂对协议进程内的 per-workspace app（`createWorkspaceZCodeApp` 通路）也强制 `processExitsAfterTurn: false`，超出 spec「三入口」字面但方向正确（协议宿主长驻）。建议 spec 补记该第四通路。
3. 长驻形态每个 model step 都会对同一在飞 run 追加一次 60s `unref` 计时器（与改前前台 settle 同构，非本批新增模式；无在飞 run 时不落日志）。确认可接受。

## 已豁免（用户确认不修）
- 无

## 合并后 QA（manual_user，不阻塞）
- T-S3（spec，blocking: no，实机）：busy 队列 + 折叠进行中时，排队消息 promote 延迟不含 settle 时长（时间线对比）。
- 运维确认：长驻形态 `getLastNoFireCause` 稳定显示 `in_flight` 属预期行为（spec 已登记，不得当故障修）。

## K 节建议（下游执行时闭合，本 skill 不跑 lint）
- 新测试已挂 `test:settle-background` script（符合包内逐脚本约定）✓，无需动作。
- Step 19 全门禁（根 typecheck / lint 71w/0e 基线 / oxfmt / knip / architecture:check --changed / magic-context build+test:all）由下游闭合；证据包已记录 Step 1/2/3 各自 `typecheck 27/27 successful` 与 `oxfmt --check` 通过。
- 区间 9 文件无调试残留（console.log/debugger/TODO 扫描为空）✓。

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | **ready**（spec-check r1 附条件放行，3 P1 + 8 P2 修订已全部落文 2026-10-11；波次①-④ 11 条目全裁定；fix 执行折入 wave-1.5 fix 节点） |
| 波次④ CR 结论 | 需产出 fix-spec：0P0/0P1/3P2（MF-CTX-1 id 路径可见性分歧实锤探针 / MF-CTX-2 文案过度承诺 / MF-CTX-3 测试名不副实）；FORK 纪律·四层一致·写路径单点·上游默认值对齐·提交边界全部核实兑现；OQ-CTX 四条转后续波次 |
| 波次⑤ CR 结论 | 可以合入：0P0/0P1/1P2（MF-PS-1 getToolSetHash 闭包陈旧化，审计保真项）；四文件逐字保真独立复验成立（210/162/283+markerCount164/light 4 常量）；六处改指全落位 deferred 19→15 壳清零；Step 13 11参与互斥/Step 14 分档链/测试四套件实跑全绿；spec 同步三件转 fix 节点 |
| 波次② CR 结论 | 需产出 fix-spec：0P0/1P1/4P2；五条 v1.0.4 红线全过（红线1/3 三文件区间零 diff + T-ML3/4 直证；红线2 注释逐字保留+显式 false；红线4 T-ML1a/b 三态覆盖；红线5 五形态全覆盖）；C-orch 四链收敛正确（写侧两既有入口，promote/subagent 只读，规则单点） |
| fix_spec_path | docs/iterations/bugfix-batch-20261011/cr-fix-spec.md |
| dag_version / review_round | 1 / 1 |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 1 / 11（合计 12 条：波次①1 / ②5 / ③2 / ④3 / ⑤1；spec-check r1 修订已落文） |
| 未写入的开放 must-fix | 0 |
| spec_deviations | open: [SD-1 T-S1后半/T-S2折叠落库断言收窄] |
| C-orch | ✅（单点判据落端口：`settlesInForeground` 一次求值；装配层钩子无条件装配、端口门收口；spec 授权的「端口门 vs 不装配」二选一落地正确；三入口透传为必要 hop） |
| C 类合并后 QA | T-S3 实机 + in_flight 运维确认（不阻塞） |
| fix 节点执行（wave-1.5，2026-10-11） | 12 must-fix + 3 追加：**6 done 提交（Closure 计数勘误 2026-10-11：fix 节点实际 8 提交 = 7 条目提交 + 1 oxfmt 归一）**（`ca42775c` MF-1 / `08ac3966` MF-ML-2/3 / `1138d6d0` MF-ML-4 / `2021b5d9` MF-MC-1/2 / `41f756df` MF-CTX-1/3 / `19490d3a` MF-CTX-2+追加C / `b4f0b6f2` MF-PS-1）。唯一源码级功能修复 = MF-CTX-1（ctx-search id 短路可见性谓词对齐 FTS）；MF-PS-1 为 bootstrap 装配层闭包改活读。spec 侧条目（MF-1 b / MF-ML-1 / MF-ML-4 / MF-ML-5 / OQ-1 / OQ-MC-2 / 追加 A/B）全部落 spec.md（docs/ 不入库）。**口径修正两处**：① MF-CTX-2 的「未接线」前置已被 Step 12/13/15 消费落地改变，改为 muralEnabled 补 vision 前置限定（中英）；② MF-PS-1 验收的 `transform_decisions.m0_tool_set_hash_new` 在 fork 无 durable writer（表恒空），改落同源审计列 `session_meta.cached_m0_tool_set_hash`。追加 C 的 OQ-PS 空串收口核验为 Step 18 已落地（勿重做），i18n 死 key 已清理。证据包 cache/fix-node-map.md。 |
