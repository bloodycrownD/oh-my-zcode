---
date: 2026-10-16
---

# magic-context 记忆管理（设置页记忆区改造）技术规格（SPEC）

## 需求来源

用户口述（2026-10-16 会话）+ brain-storm 调研归档 `docs/apm/memory/20261016-memory-settings-brainstorm.md`。核心诉求：

1. 设置页原生「工作区记忆」（`appSettings.memoryEnabled`，默认关）用处不大，移除其入口；
2. 「记忆」分区改造为 magic-context 跨会话项目记忆的管理面板（列表 + 人工废弃）；
3. 评估解锁 `ctx_memory` 的 archive action，让 agent 也能在对话内废弃记忆。

三份 spec 级探索报告（协议通道范式 / magic-context 记忆操作面 / 原生移除面与测试）支撑本规格，关键证据均为文件+行号级核实。

## 设计目标

- 「记忆」分区语义切换：原生工作区记忆入口退场（UI 层），原位呈现 magic-context 项目记忆管理（按当前 workspace 的项目身份）。
- 人工废弃 = archive 软删（`status='archived'` + mutation log），与上游设计同款；不做硬删、不做人工新增（二期候选）。
- 注入面正确收敛：废弃必须走「`archiveMemory` + `queueMemoryMutation` 同事务成对写」，依赖既有 m1 corrections 渲染（`<removed id/>`）与 m0 自然重折叠。
- 原生记忆线静默保持关闭：协议字段 `memoryEnabled` **保留不删**（规避 strict schema 兼容窗口与默认翻转），UI 不再暴露开关，onboarding 停写，存量 true 自动归零。

## 总体方案

### 架构（数据流）

```
设置页「记忆」分区 MemoryManagementSection (packages/ui)
  └─ services.zcodeAgentService.listMagicContextMemories / archiveMagicContextMemories
      └─ workspace RPC（stdio JSON-RPC，信封 .strict()，workflows/list 同族结构化返回）
          └─ CLI bootstrap zcode-protocol/magic-context-memories.ts（新 handler）
              ├─ effective 门（magicContext.enabled 关 → available:false，不建库不落盘）
              ├─ resolveProjectIdentityForSession（workspace → 项目身份，与写入同一空间）
              └─ @zcode/magic-context barrel → host/memory-admin.ts（新，fork 适配层）
                    ├─ list：getMemoriesByProject(statuses×3, expiryCutoff=0) + getMemoryCountsByStatus
                    └─ archive：单事务 { archiveMemory + queueMemoryMutation }（ownership 预验证）

对话内（phase-ctx-memory-archive，已拍板纳入本期见 D4）：agent 工具 ctx_memory action="archive"
  └─ core/tool/handlers/ctx-memory.ts archive 分支 → 同一 host/memory-admin.ts 组合函数
```

两条写路径（UI RPC 与 agent 工具）共享同一组合函数，物理上保证「archive 必与 mutation 成对」。

### 关键设计决策（D1–D6）

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| D1 | 原生记忆处理 | **UI 层替换**（分区原位改造 + 删原生 viewer 组件），协议字段保留、默认 false 照发 | 字段删除有 strict 兼容风险（新 CLI+旧 Host → 会话创建失败）与默认翻转风险（删 `server-operations.ts:3205-3207` override 后原生提取默认全开，CLI `features.memory`/`memory.use` 默认 true） |
| D2 | 管理数据通道 | **workspace RPC**（`workspace/listMagicContextMemories` + `workspace/archiveMagicContextMemories`） | /ctx-* ACK 仅文本；services 层无 SQLite/magic-context 依赖（不可直读）；workflows/list 为成熟结构化范例 |
| D3 | 命令集 | list（结构化条目+计数）+ archive（批量软删+reason）；不做 un-archive/新增/merge/硬删 | un-archive 需 epoch-bump 全量重渲（上游注释）；`insertMemory` 对 `sourceType:"user"` 有守卫，人工新增留给二期对齐上游 dashboard 方向 |
| D4 | ctx_memory archive 解锁 | **纳入本期**（用户 2026-10-16 拍板） | 后端全链就位，只缺契约枚举+handler 分支+组合函数出口；让「口头废弃」与「点按钮废弃」同路径 |
| D5 | 废弃语义 | archive 软删 + reason 存 `metadata_json.archive_reason` | mutation_type CHECK 白名单 `('archive','delete','update','superseded')`；可审计可逆 |
| D6 | 降级语义 | list 对旧 CLI（-32601）返回 `supported:false`（readPromptLanguage 口径）；archive 抛可读错误（readMagicContextConfig 口径）；magicContext 关闭/库不可开 → `available:false` 空列表 + 占位 UI | 旧 CLI 天然回 -32601；ctx-status 的「关掉不建库」纪律沿用 |

**拍板记录**：D4 已由用户确认纳入本期（2026-10-16），对应 Step 2/3 与 T-A1/T-A2 为交付门槛。

**doc-fix r1**（2026-10-18，spec-check-loop 第 1 轮 No-Go 修订）：P0-1 三面 outcome 枚举统一（变更点 2/4/5 + T-A1/T-A2/T-R2）；P1-1 换号同步复活路径收口；P1-2 record 字段停写裁定；P1-3 门禁清单补全；P1-4 e2e 对账依据改 SQLite；P2×7（上游判据内联标注/文本更新范围收窄/i18n 孤儿键/counts 口径差订正/T-B1 不设注入缝/reason 上限写明/Host 作用域）。

**doc-fix r2**（2026-10-18，第 2 轮复审后修订）：i18n parity 命令路径订正为仓库根 `node scripts/check-i18n-parity.mjs`；兼容性末条 merged 口径方向订正（superseded 行 status 置 archived、**进列表**，counts 归 merged 桶）；rejected 文案两态裁定（superseded→inactive 风格 / ownership→工具面不透明 was not found，防泄漏纪律）；Step 2/3 摘要与变更点同步；services 单测命令形式与 NODE_OPTIONS cmd 形式注明；变更点 12 ② 落点订正 + updateRecordPreferences 死面登记观察项。

**doc-fix r3**（2026-10-18，第 3 轮复审后修订）：T-U1 parity 路径同步（r2 漏改）；entries 增 `supersededByMemoryId` + 合并徽章 + T-R1 断言（merged 行展示闭环）；phase B「可选/可裁剪」标签与 D4 拍板冲突订正；结构清单 onboardingRecord.ts 路径笔误订正；观察项「Step 10」指代订正；rejected 子因区分方式写明。

## 最终项目结构

```
新增
  apps/zcode-cli/packages/magic-context/src/host/memory-admin.ts          # fork 适配层：组合废弃函数（单事务）
  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-memories.ts  # RPC handler
  apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-memories-rpc.mjs   # 契约测试
  apps/zcode-cli/packages/core/scripts/test-ctx-memory-archive.mjs                # 工具面测试
  packages/ui/src/settings/MemoryManagementSection.tsx                  # 记忆管理面板
修改
  apps/zcode-cli/packages/magic-context/src/index.ts                     # barrel 4c 段补出口（fork 自有段，非逐字区）
  apps/zcode-cli/packages/contracts/src/tools/ctx-context.ts             # action 枚举 + ids/reason（.strict()）
  apps/zcode-cli/packages/core/src/tool/handlers/ctx-memory.ts           # archive 分支 + 描述文本
  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts         # import + dispatch 两 case
  packages/shared/src/zcode-protocol/index.ts                            # schemas + 方法名（四处手工对齐纪律）
  packages/shared/src/test-ids.ts                                        # TID_SETTINGS_MEMORY_* 重组
  packages/services/src/zcode-agent/zcodeAgent.ts / zcodeAgentService.ts # 接口 + 实现 + 降级
  packages/ui/src/SettingsPage.tsx / settings/settingsPageConfig.ts      # 分区挂载替换 + 标题
  packages/ui/src/i18n/locales/zh-CN.ts / en-US.ts                       # settings.memory.* 族重组（双份同步）
  packages/ui/src/onboarding/OccupationOnboarding.tsx                    # 摘记忆勾选
  packages/services/src/onboarding/onboardingRecordService.ts            # 停写 memoryEnabled + syncSettingsFromRecord/Patch 摘除该键
  packages/shared/src/onboardingRecord.ts                               # memoryEnabled 改 nullable().optional()（调用方省略传）
  apps/zcode-cli/packages/{core,bootstrap}/package.json                  # 测试脚本登记
  CHANGELOG.md（Unreleased）
删除
  packages/ui/src/settings/MemorySettingsSection.tsx / MemorySettingsViewer.tsx / memoryUpdatedAt.ts
不动（明确边界）
  apps/zcode-cli/packages/magic-context/src/core/**（逐字移植区，storage/inject/mutations 零改动）
  packages/ui/src/settings/magicContextSettingsForm.ts（14 例闸门文件）
  packages/services/src/memory/*（IMemoryService 文件式服务保留，协议层 memoryEnabled 字段全链保留）
```

## 变更点清单

### A. barrel + 组合函数（phase-mc-barrel）

1. `magic-context/src/index.ts` barrel 4c 段（fork 自有段，约 453-481 区）补导出：`getMemoriesByProject`、`getMemoryCountsByStatus`、`getMemoriesByIds`（已在）、`archiveMemory`、`queueMemoryMutation`、`normalizeStoredProjectPath`、`Memory`/`MemoryStatus` 类型。
2. 新 `src/host/memory-admin.ts`：`archiveProjectMemories(db, projectPath, ids, reason?)` —— `getMemoriesByIds` 预验证（ownership：`project_path` 归一后等于传入身份；上游判据 `isPrimaryMutableMemory`〔上游 plugin `tools/ctx-memory/tools.ts:342-347` 的内部符号，非本仓导出——fork 侧在此内联等价实现〕：active/permanent 且未 superseded）→ `db.transaction(...).immediate()` 内对预验证通过的 id 逐条 `{ archiveMemory(db, id, reason); queueMemoryMutation({ projectPath, mutationType: "archive", targetMemoryId: id }) }` → 返回逐 id outcome。**outcome 四值枚举（单一事实源，RPC 与工具面均直通/映射此表）**：`archived`（预验证通过，本事务成对写）/ `already-archived`（status=archived 且未 superseded 且 ownership 符——跳过，不二次写 mutation 行）/ `rejected`（ownership 不符，或已 superseded——子因须在返回结构中可区分，供工具面选文案：superseded→inactive 风格 / ownership→不透明 was not found）/ `missing`（id 不存在），各附 message。另出 `listProjectMemoriesForAdmin(db, projectPath)`（statuses=["active","permanent","archived"]，expiryCutoff=0）与 `getProjectMemoryCountsForAdmin(db, projectPath)` 薄封装。barrel re-export。

### B. ctx_memory archive 解锁（phase-ctx-memory-archive，已拍板纳入本期）

3. `contracts/src/tools/ctx-context.ts`：`CtxMemoryInputSchema`（`.strict()`）action 扩为 `z.enum(["write","archive"]).optional()`（显式 `"write"` 须仍合法）+ `ids: z.array(z.number().int()).min(1).max(100).optional()` + `reason: z.string().max(4096).optional()`。
4. `core/tool/handlers/ctx-memory.ts`：archive 分支照上游 `tools.ts:932-1002` 结构（ids 去重 → 调 `archiveProjectMemories` → 按逐 id outcome 组文案：全部 `archived` → 确认文案 `Archived memories [ID: ...] (reason).`；`already-archived` → `[ID] is already archived`（无 mutation 副作用）；`rejected` 两态——superseded → 上游 inactiveMemoryError 风格拒绝文案、ownership 不符 → 不透明 `was not found`（沿上游 tools.ts:949-958 与本仓 storage-memory.ts:979-986 防泄漏纪律，不暴露外部记忆 id 存在性）；`missing` → `was not found`）；复用既有 commandId 幂等账本与 `ModuleMemoryAuthorityError` 捕获。工具描述文本更新仅限两处：`ctx-memory.ts` :220 区「The only action is write」句改写 + `contracts/src/tools/ctx-context.ts` 参数描述（reason 上限 4096 须写明）；`context/sections/magic-context.ts` 与 core 逐字区其它文件核对后预期 no-op 并登记（不扩改文范围）。

### C. 协议 + services + CLI handler（phase-memory-rpc）

5. `packages/shared/src/zcode-protocol/index.ts`：
   - `zcodeWorkspaceListMagicContextMemoriesParamsSchema`（`{workspace}` `.strict()` + 可选 `category`/`limit`(≤200, 默认 200)/`offset`）；Result：`{workspace, supported(默认 true), available, reason?, entries: [{id, category, content, importance, status, seenCount, createdAt, updatedAt, expiresAt, archiveReason?, supersededByMemoryId: number|null}], counts: {total, active, permanent, archived, merged}, truncated}`。
   - `zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema`（`{workspace, memoryIds: number[] 1..100, reason?}`）；Result：`{workspace, outcomes: [{id, outcome: "archived"|"already-archived"|"missing"|"rejected", message?}]}`——outcome 逐 id 直通组合函数四值枚举（见变更点 2）。
   - 方法名表 `zcodeProtocolMethods`（3485 区后）加两条。四处手工对齐：schema 导出 + 方法名 + CLI switch case + services 方法。
6. `packages/services/src/zcode-agent/zcodeAgent.ts` + `zcodeAgentService.ts`（3022-3090 区旁）：接口与实现，`getReadOnlyClient` 范式；list 的 catch 识别 `isProtocolMethodNotFoundError` → 返回 `{supported:false, available:false, entries:[], counts:零值}`；archive 的 catch 抛可读错误（UI toast 消费）。`SQLITE_BUSY` 转译为可重试提示。
7. `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-memories.ts`（新）+ `server.ts` dispatch（624-625 区旁两 case）：`parseParams` → effective 门（magicContext.enabled 关 → `{available:false, reason:"disabled"}`，不开库）→ `openDatabase(getMagicContextDatabasePath())`（打不开 → `available:false, reason:"unavailable"`）→ `resolveProjectIdentityForSession` 解析 workspace 身份 → 调 barrel/host-admin 函数组 result；archive 捕获 `ModuleMemoryAuthorityError` → `ProtocolRequestError` 可读消息。
8. 契约测试 `test-magic-context-memories-rpc.mjs`（仿 `test-magic-context-config-rpc.mjs`：registerHooks + dist import + 临时 DB 经 `MAGIC_CONTEXT_DB_PATH` 注入），登记 `bootstrap/package.json` scripts。

### D. 设置页改造（phase-memory-ui）

9. 新 `packages/ui/src/settings/MemoryManagementSection.tsx`：挂 SettingsPage「记忆」分区（section id `memory` 不变，导航锚点稳定）；列表（分类过滤徽章、状态徽章、合并徽章〔supersededByMemoryId 非空 → 「已合并」〕、计数汇总、分页/截断提示）+ 逐条/多选废弃（确认对话框带 reason 输入）+ 刷新 + toast；`supported:false` / `available:false` 占位态；加载失败横幅+重试（复用 MagicContextSettingsSection 范式）。**不展示 seenCount 为「使用次数」**（其语义是写入去重计数，展示为「重复写入」或省略）。Host 作用域沿用现 memory 分区语义：数据取本机 Host（保留 `SettingsPage.tsx` :1281 区 `<ServiceProvider services={localHostServices}>` 包裹），远程 workspace 场景下管理的是本机 CLI 记忆库，占位文案注明。
10. `SettingsPage.tsx`：`activeSection==="memory"` 分支换挂新组件；删 `handleMemoryEnabledChange`、`memoryWorkspaceDisplayNames`、`MemorySettingsSection` import；**存量迁移**：分区挂载时若 `settings.memoryEnabled===true` → 自动写回 false 并提示一句（关闭隐形开关的最后出口）。
11. 删 `MemorySettingsSection.tsx` / `MemorySettingsViewer.tsx` / `memoryUpdatedAt.ts`；`settingsPageConfig.ts` memory 条目改 titleId（标题保持「记忆」或「项目记忆」，实现定）；i18n `settings.memory.*` 族重组：删 viewer 族键 + `settings.memory.workspaceMemory`/`settings.memoryDescription`（zh:2076-2077 / en:2210-2211，同样只被将删组件消费），新增 `settings.memory.management.*`（zh-CN/en-US 双份同步）；`test-ids.ts` `TID_SETTINGS_MEMORY_*` 16 常量重组为新面板钩子（沿用 shared 常量族惯例）。
12. onboarding 摘勾选：`OccupationOnboarding.tsx` 删记忆勾选项（保留 proactiveSuggestions 语义不动）；停写 `memoryEnabled` 三面收口——① `shared/src/onboardingRecord.ts` 该字段改 `z.boolean().nullable().optional()`，调用方直接**省略不传**（null 保留「该页被跳过」既有语义不污染；旧记录有值/null 照常解析，上传载荷缺键按缺省处理）；② 该键停写的真实落点=UI 调用方省略传（`OccupationOnboarding.tsx` :214-220/:233-239；record 服务本身 spread 不补写该键，onboardingRecordService.ts:96-106）；③ **换号同步复活路径收口**：`OnboardingSettingsSyncPatch`（`services/src/onboarding/onboardingRecord.ts:14`）与 `syncSettingsFromRecord` 返回值（`onboardingRecordService.ts:195-213`，现返回 `memoryEnabled: latest.memoryEnabled ?? false`）同步移除该键，杜绝挂载归零后被同步写回 true。观察项登记：`updateRecordPreferences` 的 Pick 仍含 memoryEnabled（services/src/onboarding/onboardingRecord.ts:48-52、服务 :216-219）——变更点 10 落地（Step 8 交付）后成死面，无复活风险（record 侧该键已无消费点），可顺势收窄或留观察；`OccupationOnboarding.tsx:183` 的 memoryEnabled 预填读点随摘勾选一并清理。

### E. 回归与验收（phase-regression / phase-e2e）

13. CHANGELOG Unreleased 登记；全量门禁 + mc 专项。
14. 真机验收（合并后用户执行）。

## 详细实现步骤

- Step 1 — phase-mc-barrel — blocking: yes — qa: auto：barrel 补导出 + 新 `host/memory-admin.ts` 组合函数（单事务成对写、ownership/inactive 预验证、list/counts 薄封装、`normalizeStoredProjectPath` 出口）。
- Step 2 — phase-ctx-memory-archive — blocking: yes — qa: auto：契约 action 枚举扩 `"archive"` + `ids`/`reason` 字段；ctx-memory handler archive 分支（复用幂等账本）+ 工具描述更新（仅变更点 4 两处，其余核对后预期 no-op 登记）。
- Step 3 — phase-ctx-memory-archive — blocking: yes — qa: auto：`core/scripts/test-ctx-memory-archive.mjs`（批量/幂等/mutation 行成对/superseded 与 ownership 双态拒绝/authority 拒绝）+ `core/package.json` 登记。
- Step 4 — phase-memory-rpc — blocking: yes — qa: auto：shared 两对 schema + 方法名（四处对齐：schema 导出/方法名/CLI case/services 方法）。
- Step 5 — phase-memory-rpc — blocking: yes — qa: auto：services 接口+实现（list 的 -32601→supported:false 降级；archive 可读错误；BUSY 转译）+ 降级单测（仿 `promptLanguageDegradation.test.ts`，假 app-server 回 -32601）。
- Step 6 — phase-memory-rpc — blocking: yes — qa: auto：CLI `magic-context-memories.ts` handler（effective 门→不开库、身份解析、limit 200、逐 id outcome、authority 错误映射）+ `server.ts` dispatch。
- Step 7 — phase-memory-rpc — blocking: yes — qa: auto：`test-magic-context-memories-rpc.mjs` 契约测试（临时 DB）+ scripts 登记。
- Step 8 — phase-memory-ui — blocking: yes — qa: auto：新 `MemoryManagementSection.tsx` + SettingsPage 挂载替换 + 存量 `memoryEnabled=true` 自动归零迁移 + 删三组件 + i18n/TID 重组（不碰 `magicContextSettingsForm.ts`）。
- Step 9 — phase-memory-ui — blocking: yes — qa: auto：onboarding 摘记忆勾选 + 停写 `memoryEnabled` 三面收口（schema 改 optional 省略传、保存路径停写、syncSettingsFromRecord/Patch 摘除该键；旧记录解析兼容）。
- Step 10 — phase-regression — blocking: yes — qa: auto：typecheck 27 包 / lint（`-c .oxlintrc.json --ignore-pattern ".tools/**"`，基线 0e）/ architecture:check / test:v4-perf（Windows cmd 须 `cmd /c "set NODE_OPTIONS=--max-old-space-size=4096&& pnpm run test:v4-perf"`）/ mc 专项（`test:magic-context-config-rpc`、`test-magic-context-ui-config.mjs` 14 例、magic-context `test:ctx-search-memory`、`test:tool-name-closure`）/ **本迭代新增三项显式列入**：bootstrap `node scripts/test-magic-context-memories-rpc.mjs`、core `node scripts/test-ctx-memory-archive.mjs`、services 降级单测（Step 5 交付件，`tsx --test packages/services/test/<file>.test.ts` 单文件跑，package.json 既有惯例）/ i18n parity `node scripts/check-i18n-parity.mjs`（仓库根执行；三项均不依赖 test:v4-perf 聚合，后续若接入聚合须登记）/ CHANGELOG。
- Step 11 — phase-e2e — blocking: no — qa: manual_user：真机验收：面板列表与计数对账以 SQLite 直查为准（`~/.omz/cli/db/magic-context.db` 的 `memories`/`memory_mutation_log`，或经新 list RPC 自洽核对；`/ctx-status` 快照无 memory 桶，不作对账依据）；废弃一条后新会话注入面不含该条（或活动会话下轮出 `<removed/>`）；对话内「废弃 #N」走 agent 工具成功；onboarding 不再出现记忆勾选；断开 CLI 模拟旧版 → 面板占位态。

## 测试策略

### 测试用例

- T-B1 — blocking: yes — Step 1/7：组合函数单事务性（archive 与 mutation 行同生同灭）——组合函数预验证后事务内为纯 UPDATE/INSERT 无既有失败注入点，**不设测试专用注入缝**，由 T-R2 间接钉住（断言 outcomes 与 mutation 行一致）。
- T-A1 — blocking: yes — Step 3：ctx_memory archive 批量+幂等（重复废弃 → 该 id outcome=already-archived、文案含 already archived、不新增 mutation 行）+ 首次废弃 mutation 行成对存在。
- T-A2 — blocking: yes — Step 3：superseded → rejected + inactive 风格文案；ownership 不符 → rejected + 不透明 was not found（防泄漏纪律）；authority 项目拒绝（fail-visible）。
- T-R1 — blocking: yes — Step 7：list 契约——信封 strict、三 status 全回、limit 截断+truncated、entries 含 supersededByMemoryId（merged 行判定）、counts 与 `getMemoryCountsByStatus` 对账（各自口径）、disabled → `available:false` 且不建库。
- T-R2 — blocking: yes — Step 7：archive 契约——不存在 id → missing、跨项目 id → rejected（ownership）、已 archived 未 superseded → already-archived（无新 mutation 行）、正常 → archived + mutation 行成对。
- T-R3 — blocking: yes — Step 5：services 降级——-32601 → `supported:false`；archive 错误消息可读进 toast。
- T-U1 — blocking: yes — Step 8：typecheck + i18n 双语键集一致（`node scripts/check-i18n-parity.mjs`，仓库根执行）；`test-magic-context-ui-config.mjs` 14 例保持绿（不动 form 文件）。
- T-O1 — blocking: yes — Step 9：onboarding 不再写 `memoryEnabled`（三断言：保存路径 settings 侧不写、appendRecord 载荷不含该键、换号同步 syncSettingsFromRecord 不回写——扩展现有 services 测试或新断言）。
- T-G1 — blocking: yes — Step 10：全部回归门禁绿。
- T-E1 — blocking: no — Step 11：真机 e2e 场景全过。

## 风险与回滚方案

| 风险 | 缓解 |
|---|---|
| 废弃后注入面不即时收敛（缓存 m0 基线存活到下次 cache-busting pass / 自然 HARD 折叠） | 机制保证 = mutation 行成对写（T-A1/T-R2 钉住）；UI 文案明示「已废弃，将在后续对话轮次生效」 |
| `SQLITE_BUSY`（面板与 CLI 写竞争） | handler 捕获转可重试错误；UI toast 重试；archive 本身是幂等 UPDATE |
| strict 协议兼容窗口 | 不删 `memoryEnabled` 字段（本期全链保留，默认 false 照发 → CLI override 继续压制原生记忆） |
| 隐形开关（隐藏后仍可被 onboarding 打开、存量 true 无处关闭） | Step 9 摘勾选 + Step 8 挂载自动归零迁移 |
| 上游同步压力 | `magic-context/src/core/**` 逐字区零改动；全部改动落 fork 自有面（barrel 4c 段、host/、contracts、core handler、bootstrap、shared、services、ui） |
| 逐字区纪律破坏 | 组合函数只放 `host/memory-admin.ts`（fork 适配层），storage 函数原样复用 |

**回滚**：全部改动为增量 RPC + UI 面板 + onboarding 收口，整体 revert 即恢复原生记忆分区与引导勾选；DB 无 schema 变更（表与 CHECK 约束原样），archived 行可 UPDATE 回 active（应急 SQL，无产品入口）。

## 兼容性或迁移说明

- 旧 CLI（无新方法）：list 降级 `supported:false` 占位，archive 报可读错误——桌面与 CLI 同包发布，窗口极短。
- 旧 Host + 新 CLI：不涉及（不改既有字段）。
- 存量 `appSettings.memoryEnabled=true` 用户：Step 8 挂载自动归零 + 提示；原生文件式记忆目录（`~/.omz/cli/memories/`）不迁移不删除（只读遗留）。
- counts 与列表的口径差（两处，已对 SQL 与写入路径核实）：① `expires_at=0`（非 NULL）死行——`getMemoriesByProject` 的 `(expires_at IS NULL OR expires_at > ?)`（storage-memory.ts:425）在 cutoff=0 下仍过滤，而 `getMemoryCountsByStatus` 无过期过滤（:572 全量按 status 分桶）→ 死行进 counts 不进列表（前提注：本仓 TS 写入侧只产 `null` 或 `now+ttl`〔promotion.ts:60-63〕，该类行来源为外部/历史数据）；② merged（superseded）行——superseded 写路径把 status 置为 'archived'（storage-memory.ts:514、:1186-1189），故 **merged 行同样进列表（status 显示 archived）**，但 counts 归 merged 桶、不进 archived 桶（:1275-1285），counts.total 含之；列表中该类行的区分展示用 supersededByMemoryId 字段（徽章「已合并」）。面板以列表为准，counts 仅作汇总参考（T-R1 对账按两函数各自口径断言，不做跨口径强等式）。
