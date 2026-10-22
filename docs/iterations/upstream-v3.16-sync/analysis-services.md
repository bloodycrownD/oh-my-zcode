# 上游 v3.15.1 → v3.16.2 同步分析（services / desktop / server / shared / client / provider 等区域）

- 分析范围：`packages/services`、`packages/desktop`（src + scripts）、`packages/server`、`packages/shared`、`packages/client`、`packages/provider`、`packages/provider-node`、`packages/web-share`、`packages/zcode-server-cli`、`packages/zcode-cua`、`packages/android`
- 基准：`aac47556`（上游 v3.15.1）→ `3c5b2276`（上游 v3.16.2，2026-10-20）
- omz 现状：本仓库工作区 HEAD（分支 `trace-nm-borrow`，HEAD `14032fea`）
- 本报告为只读分析，未修改任何实现文件

---

## 0. 先说三个决定全局的前提

### 0.1 omz HEAD 不是 aac47556 的后代 —— 本次 diff 只是「上游内部增量」，不是「omz 与上游的差距」

```
git merge-base HEAD aac47556  →  空（exit 1）
```

`aac47556` 只是被 fetch 进本地对象库的上游提交，**不是** omz 的同步基线。omz 自己的上游同步产物在分支 `upstream-v3.15.1-backport`（已 backport 26 项）。

因此本报告的每一个「上游新增文件」对 omz 而言都是**零基线**：omz 侧没有同名文件、没有半成品、没有已就位的接线点。这意味着：

- 同一个上游主题，omz 的移植成本 = 上游实现成本 × （1 + omz 适配层重做系数），不是「打个补丁」；
- omz 的实际差距 **远大于** 本次 diff 统计出的 1714 文件 / +158k / −29k；
- 反过来，omz 侧「没有这个文件」也**不等于**「没有这个能力」——需要逐主题核对能力归属（本报告已对每个主题做了能力级核对）。

### 0.2 上游 v3.16.2 是 **单次 squash 提交**

```
git log --oneline --no-merges aac47556..3c5b2276 → 1 条：0a1fc56d chore: sync ZCode source
```

没有任何中间提交可作 bisect 锚点，主题聚类只能靠文件内容与上游 docs 佐证。这对回滚粒度是硬约束：**无法按上游提交粒度 cherry-pick**，只能按本报告切出的主题手工重做。

### 0.3 规模分布（我负责区域）

| 维度 | 数值 |
| --- | --- |
| 变更文件总数 | 1714（src 439 / test+e2e+fixtures 1275） |
| 代码行 | +158573 / −29621（src 部分 +34108 / −9340） |
| src 按包 | desktop +13887/−3665（146 文件）、services +12718/−4407（149）、shared +3607/−456（77）、zcode-server-cli +2457/−559（29）、server +1174/−161（24）、provider +79/−46、client +81/−24、web-share +34/−16、zcode-cua +38/−4、provider-node +33/−2 |
| 测试规模 | unit 455 文件 +45497/−13627；e2e 539 文件 +35728/−5054；manual-review 270 文件 +40889/−1513；fixtures 11 文件 +2351/−87 |
| 测试新增行按包 | desktop 97578、services 17836、shared 3224、zcode-server-cli 3063、server 1894、provider-node 479、client 247、provider 115、zcode-cua 29 |
| 上游新增 docs | 325 文件 +28588/−5016（其中 `docs/architecture/r3-source-server-remote-architecture.md` +1169、`docs/testing/conversation-session-e2e-coverage-matrix.md` +2148、`docs/conversation-session-case-catalog.md` +1602、`docs/issues/remote-connection-ux/*` 27 篇、`docs/web-remote-control/relay-v2-pairing.md` +659） |

**omz 缺失的上游整包**：`packages/android`（全新 Android 客户端）、`packages/web-share`、`packages/share-ui`、`packages/stream-animate`、`packages/e2e-report`、`apps/dev-docs`。其中 `packages/android` 对 omz 等同于「引入一个新产品」，不属于「同步」范畴。

---

## 1. 协议与数据库迁移（单列，全仓门禁面）

> 这一节的内容直接决定「现有用户 SQLite 库还能不能打开」，是本次同步中**唯一不可逆**的部分。

### 1.1 `packages/shared/src/sqlite-migrations/` —— 上游全新迁移基础设施

上游 v3.16.2 引入 13 个新文件（omz 侧**完全不存在**该目录）：

| 文件 | 行数 | 内容摘要 |
| --- | --- | --- |
| `CONTRACT.md` | +15 | 契约说明：只有启动 composition 可调用；`BEGIN IMMEDIATE` 串行 admission；备份走独立连接；checksum 只由 `SQL.trim()` 计算；`touchedTables` 缺失/空/非法表名必须在任何 SQL 写入前拒绝；`schema_migration` 由 runner 独占；`previousIds` 只用于开发期改号；空间不足尝试后续卷；恢复保留加法 schema；唯一副作用入口 = `migrate`/`restore` |
| `contract.ts` | +83 | 稳定端口：`SqliteMigration`、`MigrationOptions`、`MigrationResult`、`MigrationChecksumError` |
| `runner.ts` | +116 | 迁移执行器：按 DB 路径做 single-flight 串行；`begin immediate`；逐条 checksum 校验 + `previousIds` 改号记账复制；先备份再执行；`journalTable === "tasks_schema_migration"` 时**保留 `time_applied` 且不加 `app_version` 列**（显式兼容历史形状）；其他库用 `applied_at` + `app_version` |
| `backup.ts` | +151 | 迁移前只备份 `touchedTables`；备份元数据记录 journal，恢复只清理对应账本 |
| `backup-volumes.ts` | +30 | 空间不足时尝试后续卷，全失败记 `skipped`，由调用方提示 |
| `restore.ts` | +67 | 从备份恢复：保留加法 schema，新列取默认；恢复后删除对应 migration 记录；未知迁移 ID 保留 |
| `legacy.ts` | +94 | 旧迁移形态适配层 |
| `table-snapshot.ts` | +54 | 表结构快照（用于 touchedTables 校验 / 备份） |
| `module.ts` / `index.ts` | +10 / +26 | architecture-governance 模块清单与启动组合入口 |
| `contract.example.ts` / `contract.test.ts` | +21 / +239 | 契约样例与单测（含 fixture 哈希机械验证） |

**性质**：新功能（迁移基础设施下沉到 shared，CLI 与 Host 共用）。
**上游动机**：无独立 docs 新增，动机写在 `packages/shared/src/sqlite-migrations/CONTRACT.md` 与 `packages/shared/src/zcode-protocol/index.ts` 新导出的 `STORAGE_MIGRATION_COMMAND` / `storageMigrationReportSchema`（启动进程共用 `storage-migrate` 命令名及 version=1 的严格 JSON 完成 schema）。
**omz 现状**：**目录不存在**。omz 的迁移执行器内联在 `packages/services/src/session/tasksDatabase/migrations.ts`。
**撞红线**：不撞。
**移植建议**：**不建议整体移植**（会牵动 `runTasksDatabaseMigrations` 的同步→异步签名、备份目录注入、启动编排重排）。建议只借用其**契约思想**（`touchedTables` 必填、checksum 语义、备份先行），用 omz 现有 runner 增量加迁移。
**工作量**：整体 L（>2 天）；只借契约思想 S（<半天）。
**主要风险**：上游 runner 强制要求 `options.backupDirectories` 非空，且 `runTasksDatabaseMigrations` 改为 async——omz 现有调用链（`packages/services/src/session/tasksDatabase/startup.ts` → `packages/desktop/src/host/tasksStorageWorker.ts`）是同步事务模型，直接换会破坏「Host Worker 独占启动准备」边界。

### 1.2 `packages/services/src/session/tasksDatabase/` —— 迁移序列逐条（**高危面**）

上游 v3.16.2 重构了迁移序列，omz 现状与兼容性判定如下。

**账本（ledger）兼容性**：✅ 兼容。

- omz 现状账本：`tasks_schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL)`
- 上游新 runner 在 `journalTable === "tasks_schema_migration"` 时**显式保留该形状**（不加 `app_version` 列），并保留 `time_applied`
- checksum 算法：omz = `sha256(JSON.stringify(checksumInput))`；上游 = `sha256(sql.trim())` 且 `sql = JSON.stringify(checksumInput)` → **两者字节相同**

**逐条迁移对照**：

| 迁移 ID | scope | omz 现状 | 上游 v3.16.2 | checksum 兼容 | 内容摘要 | 移植建议 |
| --- | --- | --- | --- | --- | --- | --- |
| `0001_adopt_task_schema` | base | ✅ 已有 | 保留（`touchedTables` 扩到含 `task_groups`/`task_group_members`/`task_group_view_node_orders`/`task_group_workspace_bootstraps`，但 **checksumInput 未变**） | ✅ checksum 一致 | 建 `tasks`/`automations`/`automation_runs`/`off_peak_tasks` 表 + 冻结列 + 索引 + `idx_off_peak_bound_active` 唯一索引 | 不动（**注意：touchedTables 变化不影响既有库，但若引入新 runner，其备份范围会变化**） |
| `0002_provider_selection` | base | ✅ 已有 | 保留（checksumInput 不变） | ✅ | `importLegacyAutomationSelections`：老 automation 选择项回填 | 不动 |
| `0003_official_glm_selection` | base | ✅ 已有 | 保留（checksumInput 不变） | ✅ | `OFFICIAL_GLM_SELECTION_MIGRATION_SQL` | 不动 |
| `0004_project_execution_scopes` | base | ❌ 无 | **新增** | N/A | 给 `automations` 与 `off_peak_tasks` 各加 3 个 TEXT 列：`project_id`、`host_id`、`additional_directories`；注释明确「调度器可独立打开 Repo，不能等待项目归属转换」 | **需用户拍板**：与「项目（project）」体系强绑定，见 §3.1 |
| `0006_task_group_admissions` | base | ❌ 无 | **新增**（注意 ID 从 0006 起，**跳过 0005**） | N/A | 建 `task_group_admissions` 表（SQL 在 `packages/services/src/task-groups/migration-v6.ts`） | 随 §3.2「task-groups」主题一起移植 |
| `0004_controller_remote_identity` | controller-remote | ❌ 无 | **新增** | N/A | 建 `controller_remote_identity_migrations` 表（`packages/services/src/session/tasksDatabase/controller-remote-schema-v4.ts`，+17 行） | 随 §2.1 source-server 主题；不移植则不需要 |
| `0005_source_server_workspace_schema` | source-server | ❌ 无 | **新增** | N/A | 建 6 张表：`workspace_alias`、`workspace_migration_schema_version`、`workspace_migration_ledger`、`workspace_migration_conflicts`、`workspace_migration_ledger_v2`、`workspace_migration_conflicts_v2`（`source-server-schema-v5.ts`，+213 行） | 随 §2.1；不移植则不需要 |

**ID 命名风险（须记录）**：上游把 `0004_*` 同时用于 base scope（`0004_project_execution_scopes`）和 controller-remote scope（`0004_controller_remote_identity`），而两者写进**同一张** `tasks_schema_migration` 账本。因为完整 ID 不同，不会触发 checksum 冲突；但 `areTasksDatabaseMigrationsApplied(db, scope)` 只校验本 scope 的 ID 集合，跨 scope 的「同一号不同义」会让运维/排障时按序号推断版本变得不可靠。omz 若移植，应改成全局唯一编号（如 `0004_base_project_execution_scopes`）。

**配套代码搬迁（上游）**：
- 上游**删除** `packages/services/src/session/tasksDatabase/startup.ts`（−124 行），把编排搬进新的 `packages/desktop/src/host/database-startup/` 模块（`hostDatabaseStartup.ts` 由旧 `hostDatabaseStartup.ts` **改名**而来，另加 `contract.ts` / `module.ts` / `CONTRACT.md`，`storagePreparationProcesses.ts` 改名，`tasksStorageWorker.ts` 改内容）。
- omz 现状：`packages/services/src/session/tasksDatabase/startup.ts` **仍在**，`packages/desktop/src/host/{hostDatabaseStartup,storagePreparationProcesses,tasksStorageWorker}.ts` 是**平铺**在 `host/` 下，没有 `database-startup/` 子模块。
- 上游新 CONTRACT.md 明确「先读取旧 settings，再调用 project-storage 的启动入口迁移和维护索引…所有退出路径关闭 MessagePort…不改变历史 SQL、checksum 或 attachment」——**「不改变历史 SQL/checksum」是上游自己的承诺，omz 移植时必须保持同一承诺**。

**性质**：新功能 + 重构。
**上游动机**：`packages/services/src/project-storage/CONTRACT.md`（`0005_projects`、旧 ID `0001_projects` 改号、`0006_default_workspace_tasks` 一次性纠正）；`docs/task/task-sqlite-index.md`（+105）。
**omz 现状**：只有 `0001`/`0002`/`0003` 三条；无备份/恢复能力；无 `touchedTables` 声明；无 `previousIds` 改号机制。
**撞红线**：不撞。
**移植建议**：
- 必做且低风险：**补 `0004_project_execution_scopes` 与 `0006_task_group_admissions`**（这两条是 base scope，未来任何项目/任务组特性都依赖），**用 omz 现有 runner 实现，不换 runner**；
- 谨慎：若引入上游新 runner，必须先验证「既有 omz 用户库」在 `journalTable === "tasks_schema_migration"` 分支下能原样打开（论文层面兼容，但 `backupDirectories` 强制非空 + async 签名是改造面）。
- 不建议：一次性移植 source-server / controller-remote 两个 scope（它们的服务端实现 omz 没有）。
**工作量**：S（补两条 base 迁移，<半天）；M（引入新 runner + 备份/恢复 + 异步化启动编排，<2 天）；L（三个 scope 全套，>2 天）。
**主要风险**：
1. **checksum 不匹配导致既有库直接不可用**（`MigrationChecksumError` 会让 `areTasksDatabaseMigrationsApplied` 抛错）——这是不可逆风险；
2. 迁移 runner 从同步变 async 后，`packages/desktop/src/host/tasksStorageWorker.ts` 的 MessagePort 生命周期与「Host Worker 是 app 库启动准备的唯一执行者」不变量需重新验证；
3. 备份目录注入失败会让启动直接失败（上游是 fail-closed），omz 用户的磁盘布局（`~/.omz` vs `~/.zcode`）需按品牌红线重做路径推导。

### 1.3 `packages/shared/src/zcode-protocol/`（legacy 主协议）

上游 +61/−19，全部为**增量**，但有 **1 处破坏性**。

| 变更 | 性质 | 兼容性 | omz 影响 |
| --- | --- | --- | --- |
| `zcodeSessionListParamsSchema` **删除** `includeArchived: z.boolean().default(false)` | **破坏性** | ⚠️ 旧客户端传该字段会因 `.strict()` 失败 | **omz 正在用**：见 §1.5 |
| 新增 `zcodeProviderRefreshRegistryParamsSchema` / `Result` + 方法 `provider/refreshRegistry` | 新功能 | 兼容 | 可独立移植（Worker 从所属 Environment 的正式 Config Store 重建进程内 Provider Registry） |
| `zcodeSessionCreateParamsSchema` / `zcodeSessionResumeParamsSchema` / `zcodeSessionRuntimePreferencesResultSchema` 新增 `additionalDirectories: z.array(nonEmptyString).max(256).optional()` | 新功能 | 兼容 | 与 §3.1「执行目录快照」绑定 |
| `zcodeSessionRuntimePreferencesResultSchema` 新增 `toolSearchMode: appToolSearchModeSchema.default("off")` | 新功能 | 兼容 | 注意 `default()` 对旧 payload 的补值行为 |
| `zcodeRuntimeCapabilitiesSchema` / `zcodeProtocolMcpServerSchema` 新增 `historyFirst` / `alwaysLoad` | 新功能 | 兼容 | 可选字段，无破坏 |
| `zcodePluginInfoSchema` 新增 `uiSurfaces`；`zcodePluginUiSurfaceSchema` 从「插件 UI 面板入口」段**上移**到公共段 | 重构 + 新功能 | 兼容（导出位置变，导出名不变） | 低风险 |
| `zcodePluginStoreListingSchema` 新增 `publisherType: z.enum(["official","community"]).optional()` | 新功能 | 兼容 | 与 §5.5 插件主题绑定 |
| 新增 `ModelExecutionSelectionFallback` 类型导出、`export * from "../off-peak-execution.js"` | 新功能 | 兼容 | `off-peak-execution.ts` 需一并移植（§5.4） |
| 新增导出 `STORAGE_MIGRATION_COMMAND` / `storageMigrationReportSchema`（来自 `sqlite-migrations/contract.ts`） | 新功能 | 兼容但**依赖新目录** | 若不移植 sqlite-migrations 则不能移植这一行 |
| 导出 `sessionsIndexReconcileParamsSchema` / `Result`（来自 v4） | 新功能 | 兼容 | 低风险 |

**性质**：新功能为主 + 1 处破坏性参数删除。
**上游动机**：`docs/conversation-protocol-declaration.md`、`docs/task/task-sqlite-index.md`。
**omz 现状**：`packages/shared/src/zcode-protocol/index.ts` 相对 base 已 fork +391/−339，**重度分叉**（fork 加了 magic-context 相关的协议字段、删掉了上游若干行）。**不能整文件替换**。
**撞红线**：不撞（但新增的 `off-peak-execution` 与 `sqlite-migrations` 导出需要取舍）。
**移植建议**：
- `provider/refreshRegistry`：**建议移植**（修复 Provider 配置热更新，独立、无 DB 依赖）；
- `additionalDirectories`：**建议移植**（与 §3.1 同批，否则 automation/定时任务无法携带执行目录快照）；
- `historyFirst` / `alwaysLoad` / `publisherType` / `uiSurfaces`：**建议移植**（纯可选字段）；
- `includeArchived` 删除：**不建议**（见 §1.5），需在 omz 协议里保留该字段；
- `STORAGE_MIGRATION_COMMAND` 导出：**随 §1.1 决定**。
**工作量**：S（逐条 cherry-pick 可选字段）/ M（若带 `off-peak-execution` + `sqlite-migrations` 导出）。
**主要风险**：omz 协议文件重度分叉，逐字段手改易漏；`includeArchived` 的 `.strict()` 语义一旦被上游严格化，omz 的 `listSessions({ includeArchived: true })` 调用会**运行时炸**。

### 1.4 `packages/shared/src/zcode-protocol-v4/`（V4 wire）

| 变更 | 性质 | 备注 |
| --- | --- | --- |
| `command.ts`：`createSession` 新增 `sessionId?`（Host 预留归属，CLI 仍拒绝覆盖既有会话）与 `additionalDirectories?` | 新功能 | `sessionId` 是**新语义**：Host 侧预分配会话 ID |
| `controller.ts`：`windowHostTaskAddressSchema` / `windowHostControllerWorkspaceFactSchema` / `workspace.removed` delta 新增 `sourceServerId?` / `serverDisplayName?` | 新功能 | 绑定 §2.1 |
| `delta.ts` + `snapshot.ts`：新增 `runtimeInitializationSchema`（`initializing`/`ready`/`failed`）并挂到 `statePatch` 与 `conversationSnapshot` | 新功能 | 「冷历史可读 ≠ runtime 已可执行」，缺席兼容旧发送端 |
| `sessions-index.ts`：新增 `sessionsIndexReconcileParamsSchema`/`Result`；`sessionSummarySchema` 新增 `lastOutcome: "completed"|"error"|"interrupted"` | 新功能 | 显式 ID 查询持久事实，不创建/恢复运行实例 |
| `snapshot.ts`：`errorAttributionSchema` 新增 `highspeedCardId`（string/null/undefined 三态）与 `highspeedFallbackUnavailable` | 新功能 | Highspeed 卡回退语义 |
| `toolDisplay.ts`：`toolResultDisplaySchema` 由 private 改为 **export** | 重构 | 纯导出面扩大，零风险 |
| `transport.ts`：`hostCapabilitiesSchema` + `clientHelloSchema` 新增 `historyFirst?` | 新功能 | `clientHello` 是 `.strict()`，但新键可选 |
| `telemetry.ts`：新增 `skillName` / `pluginId` / `pluginComponent` 字段 | **红线 1 命中** | ❌ **不移植** |

**性质**：新功能。
**omz 现状**：v4 目录文件几乎齐全（omz 与上游同名文件 60+ 个），分叉集中在 `transport.ts`（fork +87/−14）、`snapshot.ts`（+53/−4）、`command.ts`（+42/−37）、`toolDisplay.ts`（+17/−17）。
**撞红线**：`v4/telemetry.ts` 命中红线 1 → 不移植（且该文件 `sanitizeTelemetrySkillName` 依赖已被删除的 `shared/telemetry.ts`，**必须一起不移植**）。
**移植建议**：`runtimeInitialization`（**建议**，修复冷恢复显示「可执行」的错觉）、`sessionsIndexReconcile` + `lastOutcome`（**建议**，低风险增量）、`createSession.sessionId` / `additionalDirectories`（随 §3.1）、`highspeedCardId`（**需用户拍板**，omz 是否使用 Highspeed 卡）、`sourceServerId`（随 §2.1）。
**工作量**：S（每条独立可摘）/ M（成批）。
**主要风险**：`v4` 是全仓门禁面，omz 在 `transport.ts`/`snapshot.ts` 有自身分叉，手改时必须保住 fork 的 `transport.ts` 增量（fork +87 行）。

### 1.5 ⚠️ `includeArchived` 移除 —— omz 的活跃依赖点（**必须人工处理**）

上游 v3.16.2 从 `zcodeSessionListParamsSchema` 删掉 `includeArchived`，并**删除** `packages/services/src/session/zcodeTaskListTypes.ts`（−89）与 `packages/services/src/zcode-agent/repairSubagentTaskIndex.ts`（−47）。

**omz 现状（HEAD 实证）**：

```
packages/services/src/zcode-agent/repairSubagentTaskIndex.ts:27:  includeArchived: true,
packages/services/src/zcode-agent/zcodeAgent.ts:221:               includeArchived?: boolean;
packages/services/src/zcode-agent/zcodeAgentService.ts:2854:       includeArchived: params.includeArchived ?? false,
packages/services/src/zcode-session/zcodeSession.ts:59:             includeArchived?: boolean;
packages/shared/src/zcode-protocol/index.ts:1510:                   includeArchived: z.boolean().default(false),
```

`repairSubagentTaskIndex` 是 omz 在线的**子代理索引修复**：老版本曾把冷恢复 child 写入主列表，该函数用 `listSessions({ includeArchived: true, runtimePolicy: "existing-only" })` 精确确认「哪些 session 是 subagent_child 且不在可见集合」，然后软删派生索引行——**删错了会污染用户历史**。

**移植建议**：**不建议移植这条删除**。若要跟上上游，必须同时：(a) omz 协议保留 `includeArchived`；(b) omz 保留 `repairSubagentTaskIndex`；(c) 保留 `zcodeTaskListTypes.ts`。否则需要重写一套「不依赖 archived 查询」的子代理身份判定。
**工作量**：M（若强行对齐上游，需重写判定 + 补 e2e，<2 天）。
**主要风险**：**历史数据误删**（P0 级数据正确性风险），远高于「落后上游一个版本」的成本。

### 1.6 `packages/shared/src/validation.ts` / `validationAppSettings.ts` / `platform.ts` / `channels.ts`

- `validation.ts` +247/−87：新增 `sourceServerArtifactPolicySchema`（§2.1）、`localeSchema` 引用、`mobilePluginDiscoveryTelemetrySchema`（**红线 1**）、删掉 `webRemoteControlReconnectWorkspaceResultSchema` 一支（§2.2）。
- `validationAppSettings.ts` +76/−2：AppSettings schema 增补（对应 §1.3 的 `toolSearchMode` 等）。
- `platform.ts` +69/−25、`channels.ts` +62/−32：新增 source-server / web-remote-relay / project 相关 channel 与平台能力。
- omz 现状：`validation.ts` fork +11/−148、`channels.ts` fork +5/−240、`platform.ts` fork +10/−122 → **分叉较大，勿整文件替换**。
- 建议：**逐条摘取可选字段**，不整体替换（每次替换都会冲掉 fork 的删除）。

---

## 2. 远程架构主题

### 2.1 source-server R3 统一远程主链（最大主题）

**涉及文件与规模**（新增为主）：

| 层 | 文件 | 规模 |
| --- | --- | --- |
| shared | `src/source-server/{contracts,compatibility,connectionErrors,connectionLog,errorCodes,release,index}.ts` | +426/+115/+119/+69/+74/+84/+6 = **+893** |
| server | `src/source-server/{transportAdapter,sourceServerTransportRuntime,sourceServerProbe,sourceServerReleaseDownload,index}.ts` | +511/+149/+172/+28/+1 = **+861** |
| desktop host | `src/host/sourceServerDirectory.ts`、`sourceServerConnectionManager.ts`、`sourceServerManagementService.ts`、`sourceServerReleaseResolver.ts`、`sourceServerOperationLogs.ts`、`sourceServerMigrationCounts.ts`、`sourceServerRecoveryPolicy.ts`、`sourceServerStartupReconnect.ts`、`sourceSettingsServiceCollection.ts`、`connectDesktopSourceServer.ts`、`connectSourceServerTarget.ts`、`remoteWorkspacePreparation.ts`、`serverRemoteDuplexTransport.ts`、`botRemoteWorkspaceResolver.ts` | **+3481**（其中两个巨型文件 1486 / 1460） |
| services | `src/source-server-workspace/*`（+345）、`src/source-server-management/sourceServerManagement.ts`（+72）、`src/session/sourceServerWorkspaceAliasRepo.ts`（**+2354**）、`src/session/controllerRemoteIdentityMigration.ts`（+318） | **+3089** |
| desktop host（改造） | `src/host/index.ts` **+1361/−307**、`windowRemoteConnectionRegistry.ts` +1043/−96、`remoteWorkspaceServiceCollection.ts` +194/−390、`serverRemoteConnection.ts` +166/−23 | **+2764/−816** |
| server（改造） | `src/http.ts` −65/+78、`src/entry-http.ts` +18/−7、`src/remote/*` 合计约 +160/−60 | +220 |
| 协议 | `zcode-protocol-v4/controller.ts`（`sourceServerId`）、`zcode-protocol/index.ts`（`sourceServerUpdate*` 等） | 见 §1.3/§1.4 |

**变更性质**：新功能（架构级）+ 大量重构。
**上游动机**（docs 路径）：
- `docs/architecture/r3-source-server-remote-architecture.md`（**+1169 行**，事实规格）
- `docs/architecture/r3-source-server-remote-open-issues.md`（**+499 行**，24 条 P0/P1/P2 台账）
- `docs/remote/README.md`（+53）、`docs/remote/project-first-remote-navigation-spec.md`（+365）、`docs/remote/provider-provisioning.md`（+102/−…）
- `docs/archive/remote-r3/`（17 篇归档，每篇 +10 行 = 归档标记）
- `docs/testing/r3-remote-automation-plan.md`（+265）、`r3-remote-server-harness.md`（+600）、`r3-remote-automation-case-matrix.md`（+254）
- `packages/shared/src/source-server/` 与 `packages/services/src/project-storage/CONTRACT.md` 自带契约文档

**上游做了什么**（要点）：
1. 引入 `sourceServerId`（= 远端 `install.json.installationId`，不引入第二套身份）、`ConnectionProfile`、`SourceServerRecord`、compatibility manifest；
2. Transport Adapter（SSH 用 `ssh2 forwardOut`、WSL/Docker 走 `zcode server proxy-stdio` stdio 桥）只负责「发现 / 安装 / 启动 / 传输」，**废弃旧 `deployServer` 资产编排**；
3. 远端安装：上传发行包 archive → 远端本地安装 → `serve --daemon`；首装与升级同一条链；
4. daemon 保活：优先注册 launchd/systemd `--user` OS service，失败才 detached fallback；探测成功但注册失败 **fail-closed**（不用 fallback 掩盖权限错误）；
5. ingress 鉴权升级为「OS 用户身份边界」（`run/ingress-token` 0600 文件 token），叠加在 R2 一次性 host capability ticket 之上；
6. 生命周期：启动自动重连、在线断连重试、离线探测、断连恢复、待确认请求恢复；
7. 版本兼容：双端 compatibility manifest、只升级旧端、完整 Server CLI 远程更新 + 重新握手；
8. 统一远程主链：**三种连接方式全部改为连接常驻 Server daemon，删除「部署临时 stdio zcode-server」的旧业务主链**（R3 App 内不保留旧主链）。

**omz 现状**：
- omz **没有** `source-server` 概念的任何一层（shared/server/desktop/services 全无同名文件）。
- omz 的远程现状 = `packages/server/src/remote/*`（ssh/wsl/docker backend + `remoteAsset*` 部署编排 + `zcodeAgent*Deploy`），即上游 **R2** 形态的「部署临时 stdio」旧主链；`packages/shared/src/remoteTarget.ts` 的 `RemoteTarget` 有 `kind: "server"` 直连（上游保留为 dev-only 调试入口）。
- omz 的 desktop host 已有 `windowRemoteConnectionRegistry.ts` / `remoteWorkspaceServiceCollection.ts` / `desktopRemoteSessions.ts`，即**窗口级 Local Host ↔ 远端会话**这一层已存在，但**没有**「远端常驻 daemon + Profile + 升级」这一层。
- **命中任务说明里的「手机远控/web-remote 沿用上游」假设**：omz 实际**没有** web-remote-control 实现（详见 §2.2），也没有 source-server。
- 品牌约束：上游新增代码里 `publicZCodeErrorCodeSchema`、`zcode-server` 命令名、`~/.zcode`、`ZCODE_*` env 大量出现 → 移植必须改名（红线 4）。

**撞红线**：不撞红线 1/2/3；但**触碰红线 4（品牌）**，且 `packages/services/src/zcode-agent/*` 的联动改动会间接影响 fork 的 CLI 侧语言接线（见 §5.1，标「需人工适配」）。

**移植建议**：**不建议移植（需用户拍板）**。
- 若 omz 的产品路线是「SSH/WSL/Docker 远程工作区」，则 R3 是上游给出的收敛终局，值得立项，但工作量远超一次同步迭代；
- 若 omz 只维护「本地 + 少量远端」场景，则 R3 收益低而风险高（它要**废弃** omz 现在能用的旧主链）。
- 折中路径：**只摘「可独立成立的小块」**——`packages/shared/src/source-server/{errorCodes,connectionLog,compatibility}.ts`（错误码/日志/兼容清单，纯数据）、以及 `packages/server/test/staticRoutePathContainment.test.ts`（安全测试，见 §5.8）。

**工作量**：L（>2 天，按上游实测这是数十人日的架构工程；上游自己留了 24 条 open issue + 6 条「待验证/待修复」）。
**主要风险**：
1. R3 明确「删除旧业务主链」「App 内不保留可运行的旧远程主链」→ 半移植会产生**两套远程主链并存**的状态，比不移植更糟；
2. `sourceServerWorkspaceAliasRepo.ts`（2354 行）+ `windowRemoteConnectionRegistry.ts` 恢复/换代逻辑（R3-ISSUE-005/006/011/021 等多条 P1 未闭环）是历史高 bug 密度区；
3. 上游 open issues 台账里 **P1 未闭环项**：R3-ISSUE-020（发布证据）/023/024（WSL 误报缺 tar）等。

### 2.2 web-remote relay v2（手机远控配对 v2）

**涉及文件与规模**：
- `packages/shared/src/web-remote-relay/`（全新 10 文件）：`contract.ts` +182、`adapters/heartbeat.ts`、`domain/retry.ts`、`domain/heartbeatTiming.ts`、`module.ts`、`index.ts`、`CONTRACT.md`、`contract.example.ts`、`contract.test.ts`
- `packages/desktop/src/main/web-remote-relay/`（全新 10 文件）：`contract.ts`、`index.ts`、`module.ts`、`webRemoteControlTransport.ts` +283、`webRemoteControlV2Http.ts` +62、`webRemoteControlDeviceStorage.ts`、`CONTRACT.md` 等
- `packages/desktop/src/main/webRemoteControlManager.ts` +655/−296
- `packages/desktop/src/main/webRemoteControlTransport.ts` **−790（删除）**、`webRemoteControlRelayAuthProvider.ts` −103、`webRemoteControlRelayAuthStorageProvider.ts` **删除**
- `packages/shared/src/web-remote-control.ts` +90/−183
- `packages/client/src/webRemoteControlRelayPayloadSerializer.ts` +8/−4、`packages/client/src/remoteServiceAccess.ts` +53/−1
- 删除上游 v1：`docs/issues/web-remote-control-relay-v2/07-contract-v1-removal-and-docs.md` 明确「v1 契约移除」

**变更性质**：新功能（v2 替换 v1，含契约破坏）。
**上游动机**：
- `docs/web-remote-control/relay-v2-pairing.md`（**+659 行**）
- `docs/issues/web-remote-control-relay-v2/`（7 篇：01-relay-v2-login-pairing +205、02-shared-v2-contract-and-fake-relay、03-desktop-v2-register-token-pair、04-desktop-auth-gate-and-lifecycle、05-mobile-login-and-qr-direct-connect、06-mobile-device-list-and-last-device、07-contract-v1-removal-and-docs）
- `docs/web-remote-control/web-remote-control-architecture.md` +240/−…、`web-remote-login.md` +118/−…

**omz 现状（重要，与任务简报假设不符）**：**omz 完全没有 web-remote-control / relay 实现**。

实证：
```
git ls-tree -r --name-only HEAD | grep -i "web-remote|webremote|relay"
→ packages/ui/src/WebRemoteControlDialog.tsx
→ packages/ui/src/WorkspaceWebRemoteControlTrigger.tsx
→ （其余是 databaseStartupRelay / hostLogRelay / CLI 的 tui-session-event-relay，均无关）
```
- 上游 v3.15.1 已有 `packages/shared/src/web-remote-control.ts`、`packages/desktop/src/main/webRemoteControl*.ts`（9 个文件）——**omz 全部没有**；
- omz 保留的两个 UI 文件名相似但**功能不同**：omz 的 `WebRemoteControlDialog.tsx` 实际是「Bot Channel（微信/飞书/Lark/Telegram）配置入口」，与上游的「手机远控」无关。

**结论**：relay v2 在 omz 侧**不存在移植基线**。要拿到 v2，必须先把上游 v1（web-remote-control 栈 + mobile 端）整套引入——那是**产品功能引入**，不是「上游同步」。
**移植建议**：**不建议**（作为同步项）。若 omz 产品路线需要「手机远控」，则应作为**独立特性立项**（先评估引入 v1 的成本与 omz 的 relay 服务端部署形态），而不是把 v2 当作补丁移植。
**工作量**：不移植 = 0；引入 v1 + v2 = L（>2 天，且含服务端 relay 部署）。
**主要风险**：
1. 若**只**移植 v2 的 shared 契约而不移植 v1，会产出一套无对端的死契约；
2. relay 涉及 JWT/token 鉴权与外网链路，omz 无现网 relay 运维经验；
3. 上游自己把 v1 契约整体移除，v1→v2 是破坏性切换，不是增量。

### 2.3 远程连接 UX 与连接注册表重构

**涉及文件与规模**：
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` **+1043/−96**（恢复/换代逻辑大改）
- `packages/desktop/src/host/windowHostControllerService.ts` +295/−59、`windowHostControllerProjection.ts` +54/−14
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` +194/−390（**删除** `remoteConnectionServiceCollection.ts` −111、`legacyRemoteWorkspaceRpcContract.ts` −44、`remotePromptAttachments.ts` −92）
- `packages/desktop/src/main/desktopRemoteSessions.ts` +659/−102、`desktopMainIpcRemote.ts` +166/−37
- `packages/services/src/remote-projects/`（全新 12 文件 +270 行）：`contract.ts` +73、`index.ts` +380、`connection-membership.ts` +103、`workspace-settings.ts` +121、`validation.ts`、`url/contract.test.ts`、`legacy/contract.test.ts`、`workspace-settings/contract.test.ts`、`CONTRACT.md`、`module.ts`、`contract.example.ts`、`contract.test.ts`
- `packages/services/src/project-workspace-navigation/`（全新 6 文件）
- `packages/services/src/bot-project-runtime/`（全新 6 文件，+175）

**变更性质**：重构 + 新功能。
**上游动机**：
- `docs/issues/remote-connection-ux/`（**27 篇**，含 07-existing-project-upgrade-intent +283、11-ssh-credential-missing-after-restart +113、25-data-directory-restart-startup-failure +128）
- `docs/architecture/remote-device-connection-ux-spec.md`（+359）
- `docs/remote/project-first-remote-navigation-spec.md`（+365）
- `docs/ui/ssh-remote-workspace-tooltip.md`、`docs/ssh-remote-app-global-state-authority.md`

**omz 现状**：`windowRemoteConnectionRegistry.ts` / `remoteWorkspaceServiceCollection.ts` / `desktopRemoteSessions.ts` 三个文件 omz 都有，且 `desktopRemoteSessions.ts` fork +6/−120、`remoteWorkspaceServiceCollection.ts` fork +3/−124 → **有分叉但不算深**；`remote-projects` / `project-workspace-navigation` / `bot-project-runtime` 三个模块 omz **完全没有**。
**撞红线**：不撞。
**移植建议**：**需用户拍板 / 拆小**。
- 可独立成立的小块：`windowRemoteConnectionRegistry` 的**恢复与换代状态机**（`beginRecovery` / `completeRecovery` / `failRecovery` / `rollbackRecoveryReplacements` / `scheduleLogicalReplacementRetry` / `WindowRemoteConnectionTransitionStaleError`）是纯缺陷修复型重构，且上游用 `transitionEpoch` 显式解决「异步操作期间状态换代」的竞态——**这类修复对 omz 同样有价值**；
- 但 `entriesBySourceServerId` 归属模型、`remote-projects` 模块、项目优先导航 UI 是 R3 产品面，**必须与 §2.1 同批决策**。
**工作量**：注册表恢复逻辑单独 M（<2 天）；整主题 L。
**主要风险**：连接换代竞态（上游 R3-ISSUE-011「多 workspace logical replacement 不是完整原子操作」P1 未闭环）；`dispose()` 被加入 `WindowRemoteConnectionHandle` 接口 → **omz 现有所有 handle 实现都要改签名**（编译期可捕获，但会波及调用方）。

### 2.4 远程身份与 workspace identity 迁移

- `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts` **+2354**（新建，带 3 个测试文件 2184+ 行）
- `packages/services/src/session/controllerRemoteIdentityMigration.ts` +318
- `packages/services/src/session/offPeakWorkspaceIdentityMigration.ts` +34
- `packages/shared/src/remote-workspace-identity.ts`（omz 已有，未改）
- 性质：新功能（远端 workspace identity 归一 + 冲突消解）。
- omz 现状：omz 已有 `packages/shared/src/remote-workspace-identity.ts` 与 `buildServerRemoteWorkspaceIdentity`，但**没有** alias 仓库与迁移台账。
- 建议：**随 §2.1 决策**；单独移植无意义（没有 source server 就没有 alias 需要归一）。
- 工作量：L；风险：workspace identity 归一错了 = 用户「远端项目历史丢失」。

---

## 3. 项目 / 任务组织体系主题（上游新增的一整层）

### 3.1 project-storage / project / project-catalog / startup-storage / window-project-directory（全新模块群）

**涉及文件与规模**（全部为上游新增，omz 零基线）：

| 模块 | 文件数 | src 行数 |
| --- | --- | --- |
| `packages/services/src/project-storage/` | 28（含 12 个 contract.test） | ~+1400（`project-repository.ts` +420、`schema.baseline.sql` +229、`migrate-projects.ts` +214、`legacy-tasks.ts` +147、`schema.ts` +87、`contract.ts` +112、`remote-policy.ts`、`default-workspace/migration.ts`、`downgrade/`、`migration-order/`、`project-order/`、`legacy-provider/`、`remote-single-root/`、`shared-owner/`） |
| `packages/services/src/project/` | 8 | +330（`index.ts`）、`autoArchiveScheduler.ts` +111、`legacy-single-root.ts` +166 |
| `packages/services/src/project-catalog/` | 8 | +（`selection-id.ts`、`contract.ts`、`index.ts`） |
| `packages/services/src/project-workspace-navigation/` | 6 | ~+130 |
| `packages/services/src/startup-storage/` | 6 | +（启动期项目导入） |
| `packages/services/src/window-project-directory/` | 6 | +（窗口级项目目录服务） |
| `packages/services/src/task-facts/` | 6 | +168 |
| `packages/services/src/task-groups/` | 8 | +336（`repository.ts`）+132（`index.ts`）+`migration-v6.ts` |
| `packages/services/src/session/tasksDatabase/source-server-schema-v5.ts` | 1 | +213 |
| `packages/desktop/src/host/{remoteWorkspacePreparation,botGroupTaskScope}.ts` | 2 | +173 |

**变更性质**：新功能（架构级，「项目」成为一等组织实体）+ 重构。
**上游动机**：
- `packages/services/src/project-storage/CONTRACT.md`（**极详细**，逐条规定 `0005_projects`（旧 ID `0001_projects`）、`0006_default_workspace_tasks`、ID 编号规则、`cli_*` 列语义、`handoff_pending` bit、group 独立性、自动归档筛选、`additional_directories` 快照不可变、远程单目录合同等）
- `packages/services/src/project/CONTRACT.md`、`project-catalog/CONTRACT.md`、`project-workspace-navigation/CONTRACT.md`、`task-facts/CONTRACT.md`、`task-groups/CONTRACT.md`
- `docs/specs/2026-09-09-virtual-project-design.md`（**+1203 行**）、`docs/specs/2026-09-10-virtual-project-implementation.md`（+218）、`docs/specs/2026-09-11-virtual-project-development-deviations.md`（**+847 行**）
- `docs/specs/project-creation-folder-confirmation.md`（+172）、`docs/specs/project-editor-dialog-ui.md`（+69）、`docs/ui/task-grouped-view.md`（+120）、`docs/ui/sidebar-task-view-switcher.md`、`docs/ui/project-primary-root-availability.md`
- `docs/task/task-sqlite-index.md`（+105）

**omz 现状**：**完全没有**这一层。omz 的组织模型是「workspace + task（无项目层）」；`packages/services/src/storage/` 是**磁盘用量扫描**模块（`fsWalker`/`cleanPlan`/`storageCatalog`），与上游 project-storage **同名不同物**（上游的 `storage/` 只是加了 CONTRACT.md + 两个测试文件，实际项目存储在 `project-storage/`）。
**撞红线**：不撞（但 §1.2 的 `0004_project_execution_scopes` 与 `0006_task_group_admissions` 两条迁移与本主题绑定）。
**移植建议**：**不建议**（整体）。**若** omz 想做「项目」体验，应作为独立产品特性立项，而非上游同步的副产品——上游的 project-storage 契约里有大量与 R3 远端强耦合的规则（远程持库宿主只允许恰好一个固定 root、客户端 hostId 不能改变持库身份等），脱离 R3 单搬会得到半残实现。
**可独立摘取的小块**：`packages/services/src/task-facts/`（+168，纯只读事实投影，无 R3 耦合）、`packages/services/src/task-groups/repository.ts` + `migration-v6.ts`（+336，任务分组）。
**工作量**：L（>2 天）。
**主要风险**：
1. `project-storage` 契约里的 `0005_projects` 迁移**改号**（旧 ID `0001_projects`）——omz 现有用户库没有这些表，无兼容负担，但也无收益；
2. `0006_default_workspace_tasks` 是「一次性纠正系统 default 目录误迁移」的补丁迁移，说明上游自己也在这块返工；
3. 项目/任务归属错误 = 用户「任务找不到 / 归档错位」。

### 3.2 taskIndexRepo 瘦身与 legacy 迁移外移

- `packages/services/src/session/taskIndexRepo.ts` **+356/−1878**（净删 1522 行）
- 迁移出去的部分：`packages/services/src/project-storage/legacy-tasks.ts` +147、`migrate-projects.ts` +214
- 上游 `taskIndexRepo.ts` 的 `touchedTables` 扩展、`normalizeWorkspaceKeys` / `migrateLegacyTaskMetaJson` 等大块函数被删（行号跨度 `@@ -208,6 +122,19 @@`、`@@ -418,128 +316,40 @@`、`@@ -808,104 +586,6 @@`、`@@ -1072,446 +752,22 @@`、`@@ -2249,665 +1386,6 @@`）
- 性质：重构（瘦身）+ 依赖搬迁。
- omz 现状：`taskIndexRepo.ts` fork **+0/−96**（几乎未动）→ **分叉很小，是本报告中少见的「低冲突高价值」文件**。
- 建议：**不建议直接移植**（净删除 1522 行且删除内容与 project-storage 强耦合），但**应关注其瘦身背后的动机**：上游把「legacy 行迁移」从 Repo 的 `ensureReady()` 里搬出去，改为启动期一次性迁移——这个**架构原则**对 omz 同样成立（omz 的 `taskIndexRepo` 里还有大量 `migrateLegacyTaskMetaJson` 逻辑在运行时跑）。
- 工作量：直接移植 M；只做「原则对齐」S。
- 风险：删除 legacy 迁移逻辑后，老库的历史 task meta 迁移缺失 → 老用户界面字段为空。

### 3.3 automation / off-peak / task 服务面

- `packages/services/src/session/automationService.ts` +22/−78、`automationCronValidation.ts` +73、`automationRepo.ts` +33/−4
- `packages/services/src/session/offPeakTaskService.ts` +116/−6、`offPeakMockGateway.ts` +82/−19、`offPeakTaskRepo.ts` +28/−5
- `packages/services/src/session/zcodeTaskService.ts` +14/−77、`zcodeTaskListTypes.ts` **−89（删除）**、`repairSubagentTaskIndex.ts` **−47（删除）**
- `packages/services/src/session/claude-native/*` 合计 −49
- 性质：重构 + 缺陷修复（automation cron 校验、claude-native 导入持久化精简）。
- omz 现状：`automationService.ts` fork +0/−22、`offPeakTaskService.ts` fork +0/−675（**深度分叉**）、`offPeakMockGateway.ts` fork +0/−830（**深度分叉**）、`zcodeTaskService.ts` fork +11/−22 → **冲突高**。
- 建议：**不建议**整块移植；逐条摘取可独立成立的小修（如 `automationCronValidation.ts` 新增校验规则）。
- 风险：off-peak 调度是 omz 已有特性，fork 已深度定制（−675/−830 行删除 = omz 大幅简化过这套），上游新逻辑会与之冲突。

---

## 4. 桌面（desktop）主题

### 4.1 desktop host 编排与 host-database-startup 模块化

- `packages/desktop/src/host/index.ts` **+1361/−307**（Host 编排入口，接入 source-server、off-peak resident executions、project navigation abort controller）
- `packages/desktop/src/host/database-startup/`（新模块 6 文件）：`contract.ts` +34、`module.ts` +15、`CONTRACT.md` +7、`contract.example.ts` +5、`contract.test.ts` +16；`hostDatabaseStartup.ts` 由旧文件改名、`storagePreparationProcesses.ts` 改名、`tasksStorageWorker.ts` +9/−8
- `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts` +112、`windowHostAttachmentRegistry.ts` +17、`windowTopicResourceRelay.ts` +11/−9
- 性质：重构（模块化 + 编排扩张）。
- 上游动机：`packages/desktop/src/host/database-startup/CONTRACT.md`（「Host Worker 是 app 库启动准备的唯一执行者…先读取旧 settings，再调用 project-storage 的启动入口迁移和维护索引…不改变历史 SQL、checksum 或 attachment」）。
- omz 现状：`host/index.ts` fork **+4/−540**（omz 大幅删减过 Host 编排）；`database-startup/` 子目录不存在；`hostDatabaseStartup.ts`/`storagePreparationProcesses.ts`/`tasksStorageWorker.ts` 平铺在 `host/`。
- 建议：**部分移植**——`database-startup/` 的**目录化 + contract/module 拆分**是低风险的结构治理（不依赖 R3 即可做，且是上游 architecture-governance 的 managed module 形态，omz 有 `architecture-policy.yaml` 校验器会对齐要求）。**建议做**。
- 工作量：S（<半天，纯搬文件 + 加 module.ts）。
- 风险：低。唯一注意点是 `host/index.ts` 的 `+1361` 行里 **绝大部分是 source-server 接线**（`connectDesktopSourceServer` / `SourceServerDirectory` / `SourceServerConnectionManager` / `runStartupReconnectBatch` / `resolveSourceServerReleaseAsset` / `sourceServerDisplayNameById` 等），**不能随模块化一起搬**。

### 4.2 autoUpdater 更新流程修复

- `packages/desktop/src/main/autoUpdater.ts` **+159/−62**
- 新增：`isUpdateTargetLocked()`、`recoverFromFailedUpdateInstall()`、`publishDownloadedUpdate(info)`（新增「已下载待安装」状态机）、`resolveUpdateReleaseChannel(settingService)`、per-channel 的 `isSkippedUpdateVersion`、Windows 任务栏 overlay badge（另见 §4.3）
- `packages/desktop/scripts/auto-update-install-reentry-smoke.mjs` **+217（新增）**
- 性质：**缺陷修复 + 新功能**。
- 上游动机：
  - `docs/plans/2026-10-13-macos-update-install-reentry.md`（+55）
  - `docs/desktop/auto-update-superseded-ready-package.md`（+18）
  - `docs/desktop/macos-dmg-signing-notarization.md`（+22）
- omz 现状：`autoUpdater.ts` fork **+0/−1924**（omz 大幅删减过自动更新）→ **分叉极深**。
- 建议：**需用户拍板**。`recoverFromFailedUpdateInstall()`（安装失败后回滚重入）与「已下载待安装」状态机是**通用缺陷修复**，但 omz 的 autoUpdater 已被大幅重写（−1924 行），逐函数搬运需要重新对齐 omz 自己的更新链路。
- 工作量：M（<2 天）— 只做「安装失败恢复 + 已下载状态」两个点；L — 全量对齐。
- 风险：更新链路是**发布阻断级**——改坏会导致用户无法升级。omz 已有 `packages/desktop/scripts/auto-update-install-reentry-smoke.mjs` 缺失，建议补齐同名冒烟脚本作为门槛。

### 4.3 桌面 main 杂项（新功能为主）

| 文件 | 规模 | 内容 | 建议 |
| --- | --- | --- | --- |
| `src/main/fileApplications.ts` | **+321（新增）** | 「用哪个应用打开这个文件」：macOS/Windows/Linux 三平台的 PDF/Office/媒体应用候选表 + 路径解析（mac 用 `mdfind`/bundle id，Windows 扫 Program Files，Linux 找 bin） | **建议移植**（`docs/file-preview-open-apps.md` +54 已成文；纯新文件、零依赖、可独立成立） |
| `src/main/unreadBadge.ts` | +313/−7 | 新增 `maxWindowUnreadCounts`、`supportsWindowOverlayBadge`、`resolveBadgeOverlayLabel`、`syncUnreadBadgeForPlatform` + 32×32 徽标位图生成（`TASKBAR_BADGE_IMAGE_SIZE`、像素字模） | **建议移植**（`docs/desktop/windows-taskbar-unread-badge.md` +66；Windows 任务栏角标，omz 有 `windowsAumidIcon.ts` 可复用上下文） |
| `src/main/desktopTray.ts` | +118/−1 | 托盘菜单项调整 | **需核对**（omz 有托盘自定义） |
| `src/main/startupWorkspace.ts` | +14/−61 | 启动工作区逻辑精简（移出） | 不建议（omz 分叉） |
| `src/main/desktopMainIpcRemote.ts` | +166/−37 | 远端 IPC 扩展 | 随 §2.1 |
| `src/main/desktopWindowLifecycle.ts` | +54/−6 | 窗口生命周期 | 低优先 |
| `src/main/browserView/browserGuestManager.ts` | +41/−74 | BrowserView 管理精简 | 低优先 |
| `src/main/pluginSandbox/host.ts` | +68/−1 | 插件沙箱 | 随 §5.5 |
| `src/preload/index.ts` | +59/−34 | 预加载桥接 | 随其他主题 |

**建议优先级**：`fileApplications.ts`（S，独立新文件）、`unreadBadge.ts` 的 overlay 部分（S–M）→ 性价比最高的两项。

### 4.4 desktop scripts 工具链

- 新增 `packages/desktop/scripts/r3-remote-spec-inventory.mjs`（+123）：R3 远程规格清单工具
- 新增 `packages/desktop/scripts/mcp-apps-host-fixture/{background-main.ts +502,interaction-main.ts +102,managed-renderer.tsx +119,agent.ts +49,managed-*.ts +…}`：MCP Apps 宿主夹具（背景主进程 + 交互主进程 + 受管渲染层）
- `gen-ui-fixture/` 新增 5 个检查脚本（`style-checks.ts` +125、`standalone-checks.ts` +70、`preview-corner-checks.ts` +55、`control-state-checks.ts` +50、`compact-button-checks.ts` +48）
- `prepare-agent-node-bundle.mjs` +57/−29、`ensure-e2e-desktop-build.mjs` +11/−2、`build-metadata.mjs` +11/−1、`desktop-product-identity.d.mts` +41（fork 也新增了同名文件，fork +41/−0 → **上游与 fork 内容相同**）
- 性质：新功能（测试/夹具工具链）。
- omz 现状：omz 的 `desktop/scripts` 存在 `gen-ui-fixture/`（有 `style-checks.ts`? 前面对比显示 omz 有 `packages/desktop/scripts/gen-ui-fixture/style-checks.ts` +125 → **omz 已有同名同规模文件**，说明这块 fork 已同步过）、`mcp-apps-host-fixture` omz **没有**。
- 建议：`r3-remote-spec-inventory.mjs` 随 §2.1；`mcp-apps-host-fixture` **需用户拍板**（MCP Apps 是上游新产品面，omz 是否要）；`gen-ui-fixture` 检查脚本 **建议移植**（纯测试资产，低风险）。
- 工作量：S–M。

### 4.5 zcode-server-cli 打包 / 远端资产 / 更新交接

- `packages/zcode-server-cli/src/packaging/`：`stage.ts` +220/−323、`stageArchives.ts` +118（新增）、`stageCli.ts` +73/−20、`stageDependencies.ts` +210（新增）、`stageRemoteAssetsCli.ts` +77（新增）、`remoteAssetRelease.ts` +103（新增，产出 `SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME` 描述文件 + sha256）
- `packages/zcode-server-cli/src/runtime/updateHandoff.ts` +206（新增）、`updateCommand.ts` +130/−6
- `packages/zcode-server-cli/src/supervisor/supervisor.ts` +143/−36、`src/cli.ts` +206/−32、`src/platform/serviceManager.ts` +166/−23
- `packages/zcode-server-cli/scripts/`：`verify-remote-ssh.mjs` +84/−75、`verify-proxy-stdio-docker.mjs` +138（新增）、`verify-proxy-stdio-wsl.mjs` +122（新增）
- 性质：新功能（组件化归档打包 + 远端资产发布 + 更新交接 + proxy-stdio 验证）。
- 上游动机：`docs/remote/zcode-agent-remote-deployment.md`（−355，大幅重写）、`docs/architecture/r2-server-cli-and-daemon.md`（+160/−…）、`docs/desktop/oss-cdn-multi-target-migration.md`。
- omz 现状：`packages/zcode-server-cli` 存在（omz 已 fork 品牌），但 `packaging/` 的结构与上游 v3.16.2 差异大；omz 无 `proxy-stdio` 概念（那是 R3 的 WSL/Docker 桥）。
- 建议：**建议移植 `packaging/stageArchives.ts` + `stage.ts` 的组件归档化 + `remoteAssetRelease.ts` 的发布描述文件**（这是「服务端发行包」基建，与 R3 解耦；但 `SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME` 名字带 source-server，需改名）；`proxy-stdio` 随 §2.1；`updateHandoff` 建议随更新链路一起做。
- 工作量**：M（<2 天）— 打包层；L — 含 proxy-stdio。
- 风险：打包/发布链改错 = **无法发版**（omz 的发版流程重度依赖 server CLI 产物）。品牌红线：包内 `ZCODE_*` env、`~/.zcode` 路径需改名。

---

## 5. 服务与共享层主题

### 5.1 zcode-agent 层（**需人工适配**）

- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` **+190/−582**
- `packages/services/src/zcode-agent/zcodeAgentService.ts` +295/−49（fork +376/−924）
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` +172/−178
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` +70/−59（fork +26/−68）
- `packages/services/src/zcode-agent/zcodeAgent.ts` +25/−2（fork +151/−16）
- `packages/services/src/zcode-agent/zcodeAgentPluginParams.ts` +26/−10、`zcodeAgentConnectionScope.ts` +18（新增）、`independentPlanSupport.ts` +18（新增）
- `packages/services/src/zcode-agent/{zcodeTaskListTypes.ts −89, repairSubagentTaskIndex.ts −47}`（删除）
- 性质：重构 + 缺陷修复（task 列表/适配层瘦身、syncer 重写、连接作用域拆分）。
- 上游动机：`docs/task/task-sqlite-index.md`（+105）、`docs/task-list-refresh-semantics.md`（+149/−…）、`docs/task-first-submit-visibility.md`（+51）。
- omz 现状：这些文件**全部有 fork 分叉**（`zcodeAgentService.ts` fork +376/−924、`zcodeTaskServiceAdapter.ts` fork +234/−408）→ **冲突高**。
- **红线 2（magic-context）标注**：本次上游 diff 在我的区域内**没有** `promptLanguage` / `magic-context` 关键词命中（已 grep 验证），所以**没有直接冲突**；但 omz 的 prompt-language 适配层主要落在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/prompt-language.ts` 与 `apps/zcode-cli/packages/adapters/src/config/*`，而上游本次改的 `zcodeTaskServiceAdapter` / `zcodeAgentService` 正是 **CLI ↔ Host 的协议适配层**。因此：
  - 移植 `zcodeTaskServiceAdapter` / `zcodeAgentService` 时，**必须人工核对** CLI 侧的 `prompt-language` 注入与 `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts` 的 degradation 分支是否被影响；
  - 建议：先在 omz 侧给 CLI prompt-language 补一条回归断言，再动 adapter。
- 建议：**不建议**整块移植。优先摘取：
  - `zcodeAgentConnectionScope.ts`（+18，纯新文件，连接作用域显式化）；
  - `independentPlanSupport.ts`（+18，纯新文件）；
  - `zcodeTaskIndexSyncer` 的语义修正（+172/−178，需要逐 hunk 判读）。
- 工作量：M；**风险**：中—高（adapter 是 CLI↔Host 主干，omz 已深度定制）。

### 5.2 bots 远端工作区重构

- 上游**删除** `packages/services/src/bots/botRemoteWorkspaceBridge.ts`（−337）、`botRemoteRuntimeServices.ts`（−95）
- 新增 `packages/services/src/bot-project-runtime/`（6 文件，+175）
- `packages/services/src/bots/botsService.ts` +280/−317（引入 `IProjectService` / `IRemoteProjectService` / `ProjectCatalogSnapshot`）
- `packages/services/src/bots/bots.ts` +13（新增 `BotRemoteWorkspaceResolver` 注入点）
- `packages/desktop/src/host/botRemoteWorkspaceResolver.ts` +126
- 性质：重构（把 bots 的远端工作区解析从 services 内联搬到 Host 侧 + project 体系）。
- 上游动机：`docs/bots.md`（+22）、`docs/bots-e2e-case-catalog.md`（+27/−…）。
- omz 现状：`botRemoteWorkspaceBridge.ts` / `botRemoteRuntimeServices.ts` **omz 仍有**（上游删，omz 未删）；omz 的 bots 是自定义重点（`WebRemoteControlDialog` 实为 bots 入口）。
- 建议：**不建议**直接移植（与 project 体系强耦合）。omz 的 bots 是自有产品面，**保持上游删除不动**即可；仅当 omz 要接 R3 时才需要对齐。
- 工作量：M；风险：中（bot 投递链路是 omz 自有资产）。

### 5.3 provider 权益继承（entitlementSourceProviderId）

- `packages/provider/src/account-provider-resolution.ts` +79/−46：新增「连接可从另一个 provider 继承权益状态」的解析（`entitlementSourceProviderId` + 递归 `resolveProvider` + 环检测 `resolving: Set<ProviderId>` + `Object.freeze` 状态）
- `packages/provider/src/` 新增 `provider/src/account-provider-resolution.ts` 的测试 +114/−43
- 性质：新功能（Provider 权益继承）。
- 上游动机：`docs/model-provider-project-access-token.md`（+2/−1）、`docs/remote/provider-provisioning.md`（+102/−…）、`docs/builtin-provider-maintenance/*`（8 篇新文档）。
- omz 现状：`packages/provider/src/account-provider-resolution.ts` fork +0/−180（omz 删过）→ 分叉中等。omz 有 `feat/official-endpoints-removal` 分支在做官方端点下线，**与该主题的「权益继承」语义可能冲突**。
- 建议：**需用户拍板**。若 omz 要下线官方端点，这条「从别的 provider 继承权益」的逻辑可能正是官方端点移除后的过渡机制 → **建议结合 `feat/official-endpoints-removal` 一起评估**。
- 工作量：S–M；风险：低（纯函数，无 DB）。

### 5.4 off-peak 常驻执行

- 新增 `packages/shared/src/off-peak-execution.ts`（+73）、`packages/services/src/session/offPeakResidentExecutions.ts` **+252**（`OffPeakResidentExecutions` 类：`register` / `admit` / `renew` / `takeover` / `release` / `retakeGuard` / `isUserOwned` / `deliverTicket`）
- `packages/desktop/src/host/index.ts` 接线：`trackOffPeakRunOutcome` 增 `residentExecutions.register` + `onDynamicOffPeakLifecycle` 订阅
- `packages/services/src/session/offPeakTaskService.ts` +116/−6、`offPeakMockGateway.ts` +82/−19
- 性质：新功能（闲时任务的常驻执行 + 票据交接）。
- 上游动机：`docs/off-peak-task/spec.md`（+42/−…）、`tech-design.md`（+65/−…）、`background-lifecycle-plan.md`（+263）。
- omz 现状：`offPeakTaskService.ts` fork **+0/−675**、`offPeakMockGateway.ts` fork **+0/−830** → **omz 已大幅删除/简化了这套**。omz 是否还在用 off-peak（闲时/低峰任务）需确认。
- 建议：**需用户拍板**。若 omz 已裁掉 off-peak 功能 → **不移植**；若仍保留 → 建议只移植 `OffPeakResidentExecutions` 这个**自包含的新类**（+252 行，无外部耦合）。
- 工作量：S（单类）/ M（含接线）。
- 风险：中（票据交接失败 = 闲时任务重复执行或丢失）。

### 5.5 插件管理面

- `packages/services/src/plugins/pluginManagementService.ts` +164/−10（新增 `IPluginManagementService` + `withPluginTelemetry` 导出）
- 协议：`zcodePluginInfoSchema.uiSurfaces`、`zcodePluginStoreListingSchema.publisherType`、MCP `alwaysLoad`
- 桌面：`src/main/pluginSandbox/host.ts` +68/−1
- 性质：新功能 + 重构。
- 上游动机：`docs/plugin-management-lifecycle-case-catalog.md`（+104/−…）、`docs/plugins/plugin-market-interactions-scope.md`（+223）、`docs/builtin-provider-maintenance/*`。
- omz 现状：`packages/services/src/plugins/` 存在；`packages/shared/src/pluginMarketplaces.ts` 存在（上游删了 `packages/shared/test/pluginMarketplaces.test.ts`）。
- 建议：**需用户拍板**：`withPluginTelemetry` 命名即触碰**红线 1（遥测移除）** → 移植时**必须剔除 telemetry 包装**，只保留 `IPluginManagementService` 的生命周期管理能力。
- 工作量：M；风险：中（`uiSurfaces` 协议变更涉及 CLI 侧枚举，omz CLI 侧不匹配会 strip 字段）。

### 5.6 onboarding 引导误弹修复（localUsageEvidence）

- `packages/services/src/onboarding/localUsageEvidence.ts` **+163（新增）** + 测试 +26
- 核心：判定「本机是否存量用户」的证据源从「只看 tasks-index」扩为三项（tasks-index 投影 / **agent 会话库** / 旧版任务快照目录），并明确禁止的替代判据（文件存在性、目录存在性）。
- 缺陷背景（上游注释原文）：2026-10 线上误弹——索引是 session 同步器的衍生投影，同步器在 agent/provider 就绪后才回填历史任务，判定却在登录完成、主界面挂载时执行，早于回填 → 索引为空被当成新用户。
- 性质：**缺陷修复**（高价值、小体量）。
- 上游动机：`docs/onboarding-record-spec.md`（+92/−…）。
- omz 现状：`packages/services/src/onboarding/` 存在；omz 是否有同类误弹需自查。**注意品牌**：上游代码里写死 `~/.zcode/cli/config.json`、`~/.zcode/cli/db/db.sqlite`、`ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` → **移植必须改名到 `~/.omz`**（红线 4），且这些路径**必须与 omz 自己的 CLI 实际路径一致**，否则证据源 2 永远命中不了（修复失效但不致错）。
- 建议：**建议移植**（S），并同时：
  1. 改路径为 omz 品牌；
  2. 核对 omz CLI 的 `config.json` / `db.sqlite` 实际位置；
  3. 保留「非 ENOENT 异常上抛、UI 保守判不弹」的安全语义。
- 工作量：S；风险：低（只读判定）。唯一坑是路径改名。

### 5.7 conversation-share

- 上游：`packages/shared/src/conversation-share-content.ts` +253、`conversation-share-tool-presentation.ts` +61；`packages/services/src/conversation-share/{conversationShareWorkflowSnapshot.ts +439, conversationShareConnectionScope.ts +141, conversationSharePublicProjection.ts +113/−4, conversationShareService.ts +125/−13, conversationShareHttpClient.ts +74/−101}`；`packages/shared/src/conversation-share.ts` +91/−2
- 性质：重构 + 新功能（分享内容/工作流快照/连接作用域）。
- 上游动机：`docs/conversation-share-v1.md`（+425/−…）。
- **omz 现状：完全没有 conversation-share 能力**（`packages/shared/src/conversation-share.ts` 不存在、`packages/services/src/conversation-share/` 不存在；omz 只有 `packages/web/src/share/shareHeaderLayout.ts` 一个 UI 布局文件）。
- 建议：**不移植**（omz 无此特性，属产品引入而非同步）。
- 工作量：L；风险：—。

### 5.8 server 包 HTTP 与静态资源安全

- `packages/server/src/http.ts` −65/+78：删除内联 `remoteConnections` Map，改 `serverRemoteInfoOutputSchema.parse` 强校验 server-info；新增 `resolveHttpServerId` 导出、`virtualProjects` / `migrationFailedPathCount` / `workspaceIdentityMapper` 选项；channel server 包装 `SourceServerWorkspaceIdentityChannelServer`；新增 `ZCODE_COMPATIBILITY_MANIFEST` 暴露
- `packages/server/src/entry-http.ts` +18/−7：`createLocalServices` → **`createServerHostServices`**（新增 host 侧服务集合，含 workspaceIdentityMapper）
- `packages/server/test/staticRoutePathContainment.test.ts` **+100（新增）**：静态路由路径包含性（目录穿越）安全测试
- `packages/server/src/remote/*` 合计约 +160/−60（asset installer / preflight / deploy lock / docker/ssh/wsl backend 微调）
- 性质：安全加固 + 重构。
- omz 现状：`packages/server/src/http.ts` 存在；omz 无 `source-server` 相关，`createServerHostServices` 在上游 `packages/services/src/node.ts`（+410/−18）里，omz 的 `packages/services/src/node.ts` fork +67/−703 → **深度分叉**。
- 建议：
  - **`staticRoutePathContainment` 测试 + 对应防护：建议移植**（S，安全类，独立）；
  - `serverRemoteInfoOutputSchema.parse` 强校验：**建议移植**（S，防御性）；
  - `createServerHostServices` 接线：**不建议**（依赖 project/source-server 体系）。
- 工作量：S（安全部分）/ L（host services）。
- 风险：低（安全部分）；高（host services 换 composition root）。

### 5.9 小包

| 包 | 变更 | 结论 |
| --- | --- | --- |
| `packages/client` | `globals.d.ts` +8/−14、`messageport.ts` +7/−3、`remoteServiceAccess.ts` +53/−1、`webRemoteControlRelayPayloadSerializer.ts` +8/−4、`websocket.ts` +5/−2 | 大部分随 relay v2（§2.2，omz 无基线）。`remoteServiceAccess.ts` 的 +53 是「客户端跨 service 访问授权」——可独立评估（S） |
| `packages/provider-node` | `legacy-reasoning-level-renames.ts` +25（新增）、`legacy-reasoning-level.ts` +8/−2；测试大量新增（mimo-templates +166、zcode-builtin-model-aliases +85） | **建议移植** `legacy-reasoning-level-renames.ts`（S，纯数据兼容映射） |
| `packages/provider` | 见 §5.3 | 需用户拍板 |
| `packages/web-share` | `main.tsx` +1/−1、`vite.config.ts` +33/−15 | **omz 无该包** → 不移植（除非要引入分享站） |
| `packages/zcode-cua` | `broker-server.d.ts` +9/−1、`package.json` +6/−3、`tsconfig.json` +10、`vitest.config.ts` +13、测试 +29 | 小；omz 有 `packages/zcode-cua` → 建议随其他同步 |
| `packages/android` | 仅删一个 Kotlin 测试；整包为上游新增 | **omz 无该包** → 不移植 |

---

## 6. 四条红线核查结论

| 红线 | 命中情况（我负责区域） | 处置 |
| --- | --- | --- |
| **1. 遥测移除** | ❌ **命中**：`packages/shared/src/telemetry.ts` +153（新增 `PLUGIN_TELEMETRY_EVENTS`、`sanitizePluginTelemetryDetail`、`mobilePluginDiscoveryTelemetrySchema`、`sanitizeTelemetrySkillName`）、`packages/shared/src/zcode-protocol-v4/telemetry.ts` +10（`skillName`/`pluginId`/`pluginComponent`）、`packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts` +8/−4、`packages/shared/src/validation.ts` 引入 `mobilePluginDiscoveryTelemetrySchema` | **一律不移植**。⚠️ 注意 `zcode-protocol-v4/telemetry.ts` 的新增字段依赖 `shared/telemetry.ts` 的 `sanitizeTelemetrySkillName`——omz 已删除 `shared/telemetry.ts`，所以这两处**必须成对不移植**，否则编译断。§5.5 的 `withPluginTelemetry` 同理需剔除 |
| **2. magic-context 集成** | ✅ **无直接命中**：上游本区域 diff 中 `promptLanguage` / `magic-context` / `languageDegradation` 关键词 **0 命中**（已 grep 全量验证） | 但 §5.1 的 `zcodeTaskServiceAdapter` / `zcodeAgentService` 是 CLI↔Host 协议适配层，omz 的 prompt-language 注入落在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/prompt-language.ts` + `apps/zcode-cli/packages/adapters/src/config/*` + `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`。**移植这两处必须人工适配并补回归**（标「需人工适配」） |
| **3. 原生压缩移除** | ✅ **无冲突**：我负责区域内 `compact` 仅命中 `packages/desktop/scripts/gen-ui-fixture/compact-button-checks.ts`（+48，UI 夹具检查脚本，非压缩功能实现） | 不需处理。注意 `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-compact-delivery.json`（+4292）属 e2e 夹具，随 e2e 体系评估 |
| **4. 品牌改名** | ⚠️ **大面积命中**：上游新代码写死 `ZCode` / `zcode` / `ZCODE_*` / `~/.zcode` —— `publicZCodeErrorCodeSchema`、`zcode-server`（`zcode server proxy-stdio`）、`SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME`、`ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB`、`~/.zcode/cli/config.json`、`~/.zcode/cli/db/db.sqlite`、`@zcode/shared`（包名保持不变 ✅）、`zcode://` scheme（omz 保留 ✅） | 移植时：① 包名 `@zcode/*` **不改**；② `zcode://` scheme **不改**；③ `ZCODE_*` env、`~/.zcode` 路径、面向用户的错误码/字符串 **改名**为 omz 对应物；④ 新增文件命名（`zcode-server-cli`、`source-server`）需评估是否改。**特别提示**：`~/.zcode/cli/db/db.sqlite` 这类路径一旦漏改，§5.6 的证据源会静默失效（不报错、只是不生效）——最隐蔽的坑 |

---

## 7. 主题总表

| # | 主题 | 规模（src） | 性质 | 上游动机（docs） | omz 现状 / 分叉 | 撞红线 | 建议 | 工作量 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **sqlite-migrations 基础设施**（shared 13 新文件） | +~900 | 新功能 | `sqlite-migrations/CONTRACT.md` | 目录不存在，零基线 | 否 | **不建议整体移植**，借契约思想 | L / 借思想 S | runner 同步→异步化破坏 Host 启动边界；备份目录 fail-closed |
| 2 | **tasksDatabase 迁移序列** | +205/−107 (+3 新迁移文件 +280) | 新功能+重构 | `project-storage/CONTRACT.md`、`docs/task/task-sqlite-index.md` | 现有 0001-0003，checksum 与上游**兼容**；缺 0004/0006 | 否 | **建议补 base scope 两条**（用 omz runner）；source-server/controller-remote scope 不做 | S（补迁移）/ M（换 runner）/ L（全 scope） | checksum 不匹配 → 既有库不可用（不可逆）；`0004_*` 跨 scope 同号易误判 |
| 3 | **zcode-protocol（legacy）** | +61/−19 | 新功能 + 1 处破坏 | `docs/conversation-protocol-declaration.md` | 文件重度分叉（fork +391/−339） | 否 | **建议逐条摘可选字段**；`includeArchived` 删除**不建议**跟 | S–M | `.strict()` 语义使旧字段变成运行时炸；整文件替换会冲掉 fork 删除 |
| 4 | **zcode-protocol-v4** | +~110 | 新功能 | 同上 | 分叉在 transport/snapshot/command | v4/telemetry.ts 命中红线 1 | **建议** `runtimeInitialization`、`sessionsIndexReconcile`、`lastOutcome` | S–M | v4 是全仓门禁；fork 在 transport.ts 有 +87 行增量 |
| 5 | **`includeArchived` 移除** | −136 | 破坏性删除 | `docs/task-list-refresh-semantics.md` | **omz 活跃依赖**（repairSubagentTaskIndex） | 否 | **不建议移植**（保留协议字段与 repair 逻辑） | M（若强跟） | **历史任务误删（P0 数据风险）** |
| 6 | **source-server R3 主链** | +~10 000 | 架构级新功能 | `docs/architecture/r3-source-server-remote-architecture.md`(+1169)、`r3-source-server-remote-open-issues.md`(+499) | 零基线（omz 只有 R2 形态旧主链） | 品牌(4) | **不建议移植，需用户拍板立项** | L（数十人日） | 半移植 = 两套远程主链并存；上游 24 条 open issue 未闭环 |
| 7 | **web-remote relay v2** | +~1400 | v2 替换 v1（破坏性） | `docs/web-remote-control/relay-v2-pairing.md`(+659)、`docs/issues/web-remote-control-relay-v2/*`(7 篇) | **omz 完全无 web-remote 实现** | 否 | **不建议**（属产品引入，非同步） | 0 / 若引入 L | 只搬 v2 契约 = 无对端死契约；外网 relay 运维经验缺失 |
| 8 | **远程连接 UX / 连接注册表重构** | +~2600/−~500 | 重构+新功能 | `docs/issues/remote-connection-ux/*`(27 篇)、`docs/architecture/remote-device-connection-ux-spec.md` | 注册表文件分叉浅；`remote-projects` 等 3 模块零基线 | 否 | **拆分**：注册表恢复状态机 **建议**；产品面随 §6 决策 | M（状态机）/ L（整体） | 连接换代竞态（上游 R3-ISSUE-011 未闭环）；`dispose()` 改接口波及所有 handle 实现 |
| 9 | **project-storage / project / catalog / task-facts / task-groups / startup-storage / window-project-directory** | +~4000（7 个新模块，60+ 新文件） | 架构级新功能 | `packages/services/src/project-storage/CONTRACT.md`、`docs/specs/2026-09-09-virtual-project-design.md`(+1203) | 零基线；omz 的 `services/storage/` 是**同名不同物** | 否 | **不建议**（整体）；可摘 `task-facts`、`task-groups` | L | 项目/任务归属错误 = 任务丢失/归档错位；上游自身有 `0006_default_workspace_tasks` 纠正补丁说明仍在返工 |
| 10 | **taskIndexRepo 瘦身** | +356/−1878 | 重构 | `docs/task/task-sqlite-index.md` | fork 仅 −96，**分叉浅** | 否 | **不建议直接移植**；可对齐「legacy 迁移移出 Repo」原则 | M / 原则 S | 老库 legacy task meta 迁移缺失 |
| 11 | **desktop host 编排 + host-database-startup 模块化** | +1361/−307（host/index.ts）+ 新模块 6 文件 | 重构 | `packages/desktop/src/host/database-startup/CONTRACT.md` | host/index.ts fork −540；子模块不存在 | 否 | **建议移植目录化+contract/module 拆分**（不搬 source-server 接线） | S | 低；误把 R3 接线一起搬入会引入跨模块依赖 |
| 12 | **autoUpdater 更新流程** | +159/−62 + 新脚本 217 | 缺陷修复+新功能 | `docs/plans/2026-10-13-macos-update-install-reentry.md`、`docs/desktop/auto-update-superseded-ready-package.md` | fork −1924，**分叉极深** | 否 | **需用户拍板**；建议只做「安装失败恢复」「已下载待安装」两点 + 补冒烟脚本 | M | **发布阻断级**：改坏无法升级 |
| 13 | **desktop main 杂项**（fileApplications / unreadBadge / tray / 启动工作区） | +321 / +313/−7 / +118 / −47 | 新功能为主 | `docs/file-preview-open-apps.md`、`docs/desktop/windows-taskbar-unread-badge.md` | omz 无对应文件 | 否 | **建议移植** fileApplications + unreadBadge overlay（独立、纯新） | S–M | 低 |
| 14 | **desktop scripts 工具链** | +~1800（新增夹具与检查脚本） | 新功能 | `docs/testing/*` | `gen-ui-fixture` 部分已同步；`mcp-apps-host-fixture` 零基线 | 否 | `gen-ui-fixture` 检查脚本 **建议**；mcp-apps 需拍板 | S–M | 低 |
| 15 | **zcode-server-cli 打包/远端资产/更新交接** | +2457/−559 | 新功能 | `docs/remote/zcode-agent-remote-deployment.md`(−355)、`docs/architecture/r2-server-cli-and-daemon.md` | 存在但结构差异大 | 品牌(4) | **建议移植** 归档化打包 + 发布描述文件；proxy-stdio 随 §6 | M / L | **发版链路**：打包改错 = 无法发版；品牌路径漏改 |
| 16 | **zcode-agent 层**（adapter/agentService/syncer/processManager） | +~800/−~900 | 重构+缺陷修复 | `docs/task-list-refresh-semantics.md`、`docs/task-first-submit-visibility.md` | **全部分叉**（agentService fork +376/−924） | **magic-context 需人工适配(2)** | **不建议整块移植**；优先摘 `zcodeAgentConnectionScope.ts`、`independentPlanSupport.ts` | M | CLI↔Host 主干；omz prompt-language 接线在 CLI 侧，须先补回归断言 |
| 17 | **bots 远端工作区重构** | +~700/−~450 | 重构 | `docs/bots.md`、`docs/bots-e2e-case-catalog.md` | omz 保留被上游删除的两个文件；bots 是 omz 自有产品面 | 否 | **不建议**（保持 omz 现状） | M | bot 投递链路是 omz 自有资产 |
| 18 | **off-peak 常驻执行** | +73(shared) / +252(services) | 新功能 | `docs/off-peak-task/{spec,tech-design,background-lifecycle-plan}.md` | omz 已深度简化（fork −675/−830） | 否 | **需用户拍板**（omz 是否还保留 off-peak）；若保留，摘 `OffPeakResidentExecutions` 单类 | S–M | 票据交接失败 = 闲时任务重复/丢失 |
| 19 | **provider 权益继承** | +79/−46 | 新功能 | `docs/model-provider-project-access-token.md`、`docs/remote/provider-provisioning.md` | fork −180；omz 有 `feat/official-endpoints-removal` 分支 | 否 | **需用户拍板**（与官方端点下线联动评估） | S–M | 低（纯函数） |
| 20 | **插件管理面** | +164/−10 + 协议 | 新功能 | `docs/plugin-management-lifecycle-case-catalog.md`、`docs/plugins/plugin-market-interactions-scope.md` | omz 有 plugins 模块 | **遥测(1)** `withPluginTelemetry` | **需用户拍板**；移植时**必须剔除 telemetry 包装** | M | `uiSurfaces` 协议需 CLI 侧同步，否则字段被 strip |
| 21 | **onboarding localUsageEvidence** | +163 | **缺陷修复**（线上误弹） | `docs/onboarding-record-spec.md` | omz 有 onboarding 模块，需自查是否同症 | 品牌(4) 路径 | **建议移植**（含路径改名 + 核对 omz CLI 实际路径） | S | 低；**漏改 `~/.zcode` 路径 = 修复静默失效** |
| 22 | **conversation-share** | +~1400 | 重构+新功能 | `docs/conversation-share-v1.md` | **omz 无此特性** | 否 | **不移植** | L | — |
| 23 | **server HTTP / 静态资源安全** | −65/+78 + 新测试 100 | 安全加固 | `packages/server/test/staticRoutePathContainment.test.ts` | omz 有 http.ts；`createServerHostServices` 依赖新体系 | 否 | **建议移植** 静态路由包含性测试 + `serverRemoteInfoOutputSchema.parse` 强校验 | S | 低 |
| 24 | **小包**（client / provider-node / provider / web-share / zcode-cua / android） | +~250（不含 provider） | 混合 | — | web-share/android **omz 无该包** | 否 | provider-node `legacy-reasoning-level-renames.ts` **建议**；web-share/android **不移植** | S | 低 |
| 25 | **测试与 e2e 体系** | 1275 文件 +124 465/−20 281 | 测试基建 | `docs/conversation-session-case-catalog.md`(+1602)、`docs/testing/conversation-session-e2e-coverage-matrix.md`(+2148) | omz 无 `conversation-session` e2e 体系与 `manual-review` 目录 | 否 | **不建议**（随产品特性）；`manual-review/pending/` 270 文件是「待人工复核」 backlog 而非门禁 | L | 若误当门禁引入，CI 会被 pending 用例拖死 |

---

## 8. 给用户拍板的问题清单（按优先级）

1. **【最高】是否立项 R3 source-server 远程架构？** 这是本次同步中唯一「架构级」变更，omz 零基线，工作量以月计。上游自己的 open-issues 台账还有 6 条未闭环。
2. **【高】omz 是否需要「手机远控 / relay」产品能力？** omz 当前完全没有该实现。若需要，应作独立特性立项（先引 v1 再 v2），不要当同步项。
3. **【高】omz 是否需要「项目（project）」层级？** 这是上游 v3.16.2 的组织模型主线，与 R3 远程强耦合。
4. **【中】omz 的 `off-peak`（闲时任务）功能是否还在维护？** 若已裁掉，§5.4 整块作废。
5. **【中】omz 的 `feat/official-endpoints-removal` 与上游 provider 权益继承（§5.3）是否冲突？**
6. **【中】DB 面**：是否接受在 omz 现有 runner 上补 `0004_project_execution_scopes` + `0006_task_group_admissions` 两条 base 迁移？（建议：是。是否引入上游新 sqlite-migrations runner？建议：否，只借契约。）
7. **【低】协议面**：确认保留 omz 的 `includeArchived`（建议保留），并接受协议与上游存在这一处已知分叉。

## 9. 建议的同步批次（若决定做部分同步）

**批次 1（低风险 / 独立 / 小体量，建议本迭代做）**
- §1.3 `provider/refreshRegistry`、§1.4 `runtimeInitialization` / `sessionsIndexReconcile` / `lastOutcome`（协议增量）
- §1.6 `validation.ts` 的 source-server/relay schema（若不移植 §6/§7 则跳过）
- §5.6 `localUsageEvidence`（含 `~/.omz` 路径改名 + CLI 路径核对）
- §5.3 provider 权益继承（若拍板通过）
- §5.9 provider-node `legacy-reasoning-level-renames.ts`
- §4.3 `fileApplications.ts`、§4.3 `unreadBadge` overlay 部分
- §4.1 `database-startup/` 目录化（纯搬文件）
- §5.8 server 静态路由包含性测试 + `serverRemoteInfoOutputSchema.parse`
- §1.2 补 `0004_project_execution_scopes` + `0006_task_group_admissions` 两条 base 迁移（若 §9 批次第 3 步拍板）
- §5.5 插件管理面（**剔除 telemetry 包装**）

**批次 2（需要先做技术调研）**
- §2.3 连接注册表恢复状态机（抽出来单独修竞态）
- §3.2 taskIndexRepo 的「legacy 迁移移出 Repo」原则
- §4.2 autoUpdater 两个具体缺陷点（先补 `auto-update-install-reentry-smoke.mjs` 再改）
- §3.1 `task-facts` / `task-groups`

**批次 3（独立立项，不在同步流程内）**
- §2.1 R3 source-server（若拍板）
- §2.2 relay v2（若拍板）
- §3.1 项目体系（若拍板）
- §2.4 远端身份迁移、§5.2 bots 重构、§5.7 conversation-share、§5.4 off-peak（视拍板）

---

*报告完。分析过程为只读；仅新增本文件。*
