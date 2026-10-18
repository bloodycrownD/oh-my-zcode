# session-memory-and-context spec（P2+P3，v3 · execute-ready）

doc-fix r1（2026-10-18，闭合第 1 轮审查 2 P1 + 8 P2）：cleanup 改 clearSession 方案（逐会话事务+预查归因，P1-1）；workspaceSessions 枚举源/时间列/强制入列钉死（last_response_time，P1-2）；F7/F8 事实纠偏（返回值语义、tab union 真实锚点、rebaseStatus、clearSession 跨 harness 语义入非目标）；恢复按钮剪贴板定稿；Step 6 fixture 补齐与 T-S3/T-S7 载体补全。
r2 复审（Go/execute-ready）P3 三条顺手闭合：workspace-global 归属登记（五处注册）、F8 锚点精确化、恢复命令主形态 start-end。

基线：session-memory-and-context 分支（brainstorm c7e9adb0 + P1 已交付 02fe6385/92016fa5）。
前置调研事实全部实读核实（brainstorm §三 + 本文件 §零），行号锚定 worktree HEAD。

## 零、已核实的设计输入

| # | 事实 | 锚点 |
|---|---|---|
| F1 | notes 表零写入者零读取者（包内外均无调用方，barrel 未导出）→ notes 管理面一期不做（恒空面板无价值） | rg 全包实证（2026-10-18） |
| F2 | `Memory.sourceSessionId` 类型已带（nullable），`listProjectMemoriesForAdmin` 全量返回 | storage-memory.ts:341/:312，memory-admin.ts:204 |
| F3 | list wire entry 现无 sourceSessionId；schema strict | shared zcode-protocol/index.ts（entry 段） |
| F4 | UI sess_id 即 mc session_id（session_projects 直存同值） | session-project-storage.ts:32-90 |
| F5 | compartments 表自带 title/content/p1-p4/importance（纯 db 预览可行）；tags 表无原文列，原文在会话文件 | storage-db.ts:1191-1209/:1157-1171 |
| F6 | `getCompartments` / `readMagicContextStatusSnapshot` 已导出 | barrel index.ts:275/:391-397 |
| F7 | `deleteSessionScopedRows(db, sessionIds, harness, {rustModuleCleanupAcknowledged})`：33 表依赖安全序删除、内置 Rust marker 保护（pending_session_cleanup harness LIKE '%:rust'）、**返回值=通过 marker 过滤后的会话数而非实删行数**（零行会话也计 1）；不排除普通活动会话（组合层责任）。`clearSession(db, sessionId, ack=false)`（storage-meta-session.ts:287-306）是其单会话正确包装：`db.transaction().immediate()` + `withSqliteBackgroundWriter` 写协调 + 慢事务日志；**签名不带 harness → 该 session 全部 harness 行整删**（单 CLI harness 场景无实际差异，登记为已知语义） | storage-session-tables.ts:16-134 |
| F8 | 侧边栏标签 = `OpenTabLauncherItemId` 枚举 + `resolveOpenTabLauncherItemIds`（animatedSidePanePanelModel.ts:3-50，:23-25 条件式 push 样板、shouldOffer 定义 :44-50）；tab union 在 **lib/workspaceSidePane.ts:516-535**；新 tab 须同时定义归属（workspace-global 登记 WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES :1054-1058，否则 ownerTaskId 默认收窄 :1090-1133）与会话可见性（parentSessionId 样板 :1900-1927） | 见左 |
| F9 | tag 恢复走会话文件（renderItemByTag 混合 db+raw session），RPC 化成本高 | ctx-expand/tools.ts:81/render.ts:285-315 |

## 一、目标

1. **P2 会话记忆标签**：会话侧边栏新增「会话记忆」标签 =「本会话写入的跨会话项目记忆」管理面板（列表/分页/分类/废弃，复用设置页面板能力）。
2. **P3 会话上下文标签**：会话侧边栏新增「会话上下文」标签 = 当前会话 compartments 浏览（预览/在会话中恢复）+ workspace 会话残留清单与安全清理。

## 二、非目标

- notes 表管理面（F1 恒空）；session_facts 管理面（机制内部物，无管理语义）。
- dropped tags 单条原文预览（F9 混合 IO；只出元数据统计）。
- un-archive、compartment 重建（/ctx-recomp 已有）。
- **不做 harness 收窄清理**：`clearSession` 签名无 harness 参数，语义=该 session_id 全部 harness 行整删（含 ':rust' marker 行会被其内部守卫自动跳过）。单 CLI harness 场景无实际差异，接受该语义并登记。
- magic-context `core/**` 任何改动；barrel（src/index.ts，fork 出口编排面）允许加导出（本迭代导出 `clearSession`，见 4.2）。
- 工具面（contracts/core ctx 工具）改动。

## 三、P2 设计

### 3.1 协议（additive）

- **entry +1 字段**：`zcodeMagicContextMemoryEntrySchema` 加 `sourceSessionId: z.string().nullable()`；`toWireEntry` 直通 Memory 列。同轮 UI 同步（strict schema 自产自销，无旧版本兼容面）。
- **list params +1 参数**：`zcodeWorkspaceListMagicContextMemoriesParamsSchema` 加 `sourceSessionId: z.string().min(1).optional()`。语义：组合层在 category 过滤**之后**追加全等过滤（`memory.sourceSessionId === params.sourceSessionId`），`total`/`truncated` 按组合过滤后集合计算（与 category 同一口径，bootstrap magic-context-memories.ts:275-283 处同一函数内串联两段 filter）。
- **无新方法**：archive 复用（同库 id 直通）。

### 3.2 组合层与透传

- bootstrap list handler：+3 行（filter 串联 + total 不变逻辑复用）。
- services `listMagicContextMemories` params 类型 + 透传一行（zcodeAgentService.ts:3140 段同款条件展开）。
- dispatch 零改动（无新方法）。

### 3.3 UI

- `MemoryManagementSection` props 化：新增 `sessionScope?: { sessionId: string }`——传入时：list 请求恒带 sourceSessionId、counts 徽章隐藏（会话子集口径无五桶意义，counts 是全项目口径会误导）、标题/描述走会话侧键。其余（分页/分类/勾选/废弃/展开）原样复用。
- 侧边栏注册（P2/P3 共用面）：`OpenTabLauncherItemId` + "session-memory" / "session-context" 两枚举值；launcher 清单：有活动会话（activeTaskId）才出现两标签（对照 selection-side-conversation 的条件式样板 animatedSidePanePanelModel.ts:23-25）；tab union + TabsContent 渲染分支 + i18n 标签键。
- 会话身份来源：当前活动会话 id（task store），F4 直传。

## 四、P3 设计

### 4.1 新 RPC ①：`workspace/listMagicContextSessionContext`

- params：`workspace` + `currentSessionId: string`（1..256）+ 可选 `sessionLimit: int 1..200 默认 50`（残留清单截断）。
- 返回（strict）：
  - `supported/available/reason`：降级三段（disabled/unavailable/unsupported 同 list 口径）。
  - `current`: `{ sessionId, compartments: [{sequence, startMessage, endMessage, title, contentPreview(前 500 字), importance, createdAt, rebaseStatus}], compartmentCount, lastCompartmentEndMessage }`——`getCompartments` 直读（F6；**rebaseStatus 透传**：`"unresolved"` 行的 startMessage/endMessage 序数不可信（compartment-storage.ts:85-94 rebase 语义），UI 对该行禁用「在会话中恢复」按钮）。当前会话可能零分区（新会话），空数组合法。
  - `tagSummary`: `{ total, dropped, droppedTokenCount }`——**复用 `readMagicContextStatusSnapshot`**（ctx-status.ts:41-69 的 tags 三桶 `{count, tokens}` 同源口径），不做第四份 SUM/COUNT。
  - `workspaceSessions`: `{ total, truncated, sessions: [{sessionId, updatedAt, compartmentCount, tagCount, tokenEstimate, isCurrent}] }`。口径钉死：
    - **枚举源** = `session_projects`（WHERE harness=ZCODE_HARNESS_ID AND project_path=身份解析路径）——session_meta 无项目列，不经此表无法界定「本项目会话」（枚举先例 session-activity.ts:92-95）。
    - **排序** = LEFT JOIN `session_meta.last_response_time` DESC、NULL 归底（session_meta 无 updated_at 列；`last_response_time` 是 core 自身持续写的会话最后响应时间（storage-meta-persisted.ts:2190 写、:378/:394 读并映射 updatedAt），次级兜底仅 `MAX(compartment_events.created_at)`，不加 tags 兜底——避免漏掉只有对话活动、无压缩产物的会话时排序错乱）。
    - **current 强制入列**：`currentSessionId` 若不在枚举结果（F4 写入有 home-dir 守卫可跳过绑定，session-project-storage.ts:81-86），UNION 强制补一行（各计数列 0、isCurrent=true）——保证 T-S7 的「isCurrent 行禁勾」恒有行可禁。
    - `tokenEstimate` = 该会话 `SUM(tags.token_count)`（与 tagSummary.tokens 同义口径）。
- handler 落点：bootstrap 新文件 `zcode-protocol/magic-context-session-context.ts`（照 memories handler 样板：effective 门/身份解析/降级三段）。逐会话聚合 SQL 由 bootstrap 直写（同仓先例 magic-context-usage-summary.ts:110；列名漂移风险以契约测试对账兜住）。

### 4.2 新 RPC ②：`workspace/cleanupMagicContextSessions`

- params：`workspace` + `sessionIds: string[] 1..50`（批上限低于 archive 的 100：DELETE 重语句多表，批更保守）+ `currentSessionId: string`。
- **降级**：无 envelope，照 archive 的 fail-visible 口径——effective 关闭/库打不开 → -32010 可读错误（原文透传，不建库）；旧 CLI -32601 由 services 原文透传；UI toast 呈现。Step 6 加对应用例。
- 语义（顺序执行）：
  1. `sessionIds` 含 `currentSessionId` → 整批 -32010「当前会话不可清理」，**库零变更**（双重防线之服务端侧；UI 侧 isCurrent 禁勾是第一道）。
  2. **预查 protected**：单条 SQL `SELECT session_id FROM pending_session_cleanup WHERE session_id IN (…) AND harness LIKE '%:rust'`（bootstrap 直写，谓词复刻 F7 内置过滤；列名漂移由契约测试锁）。命中集 → `outcome: "protected"`，不进删除。
  3. 其余逐会话 `clearSession(db, sessionId)`（barrel 导出，F7 事务+写协调包装；内部 marker 过滤二次兜底）→ `outcome: "deleted"`。**逐会话独立事务**：单会话失败不回滚其他会话，失败者 throw 中断并把已完成 outcomes 丢弃——fail-visible 整批语义与 archive 一致（重试幂等：已删会话再清=零行删除不报错）。
  - 返回 `{ outcomes: [{sessionId, outcome: "deleted" | "protected"}], reclaimedSessions: number }`——`reclaimedSessions`=deleted 数（「已发起清理的会话数」口径，非 SQL 行数；实际回收行数由测试 SQLite 对账验证，不上 wire）。
- **不做**：按时间自动清理、定时器、全部清理快捷键（一期手动勾选）。
- `ZCODE_HARNESS_ID`：barrel 已导出（src/index.ts:38-44），handler 侧枚举用。

### 4.3 dispatch 与守卫

- server.ts dispatch +2 case（方法名直通新 handler）。
- 源守卫测试（test-magic-context-memories-rpc.mjs 段内或新文件）：剥注释+行锚定断言两 case 存在与 return 字面量（照既有「源守卫」用例样板）。

### 4.4 UI（会话上下文标签）

- 新组件 `SessionContextSection.tsx`（会话侧边栏标签内容）：
  - 段①「当前会话」：compartments 列表（标题/消息区间/token/importance + 行内展开 contentPreview 全文）；每行「在会话中恢复」按钮——**恢复形态定稿**：公开预填通道 `requestComposerTextInsert` 存在（zcodeSessionStoreWorkspaceSlice.ts:421-451）但其唯一生产消费按 `focused && sessionId === null` 收窄（SessionPane.tsx:3415）= 只有**草稿（新任务）composer** 消费，活动会话大概率收不到 → 一期直接走**剪贴板降级**：按钮复制 `/ctx-expand tag=<N>`（或 `message=<N>` / `<start>-<end>`，语法照 run-ctx-command.ts:75/94）+ toast 提示粘贴执行；Step 0 复核 gate 结论，若上游放开消费面再切预填（登记 OQ）。`rebaseStatus==="unresolved"` 行禁用恢复按钮（4.1）。
  - 段②「丢弃标签摘要」：total/dropped/tokenCount 三徽章。
  - 段③「工作区会话残留」：session 清单表格（last_response_time 倒序、isCurrent 置顶禁勾、每行 compartment/tag/token 统计）+ 勾选 +「清理所选」确认对话框（列出将删除的会话数与 token 量预估、文案键含「不可恢复」字样——T-S7 以 i18n 键存在性 + 组件引用该键做断言）+ 逐批 outcome toast（deleted N / protected M）；清理失败（-32010）toast 原文。
- 清理后刷新：重拉 listMagicContextSessionContext。
- **tab 归属语义**（F8 纠偏后钉死）：两新 tab 的数据面=「打开标签时的当前活动会话」快照（tab 内容随其渲染时的 activeTaskId 取数；不加 ownerTaskId/parentSessionId 收窄——残留清理与跨会话浏览本来就不属于单一会话私有；切换活动会话不自动关 tab，数据在下次刷新时跟随新活动会话）。「会话记忆」tab 同理（列表=当前活动会话的写入集）。**归属登记为 workspace-global**：两 tab id 加入 `WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES`（workspaceSidePane.ts:1054-1058），否则 `stampSidePaneTabsOwnership` 会把开启方 ownerTaskId 冻结进 tab、切会话后被默认收窄隐藏。T-S3 的 launcher 条件式= activeTaskId 存在时才出现两标签。

## 五、步骤分解（实施顺序）

- **Step 0**（核对，无代码；两项审查已预挖实证，Step 0 只复核落定）：① session_meta 时间列——已实证无 `updated_at`、有 `last_response_time`（storage-db.ts:1782-1785，core 侧 storage-meta-persisted.ts:2190/:378/:394 读写），4.1 口径按此写死，Step 0 复核 DDL 无漂移即可；② 恢复按钮预填通道——已实证 `requestComposerTextInsert` 存在但消费 gate 限草稿 composer（SessionPane.tsx:3415），一期剪贴板降级（4.4），Step 0 复核 gate 现状。两复核结论登记进本 spec 实施附注。
- **Step 1**：shared 协议（entry 字段/list 参数/两新方法 schema/testids TID_SESSION_*）+ dist 重建。
- **Step 2**：magic-context barrel 导出 `clearSession`（+注释：供宿主会话残留清理；事务/写协调/marker 兜底语义见 F7；**不导出 deleteSessionScopedRows**——宿主直调会丢事务包装）。
- **Step 3**：bootstrap：list handler 过滤串联 + 新 handler 文件（sessionContext/cleanup 可同文件两导出）+ dispatch 2 case + 源守卫用例。
- **Step 4**：services 透传（list 加参 + 2 新方法）+ 类型。
- **Step 5**：UI：MemoryManagementSection props 化 + 侧边栏两标签注册（枚举/launcher/union/**WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES 归属登记**/TabsContent 五处，F8 纠偏锚点）+ SessionContextSection + i18n（zh/en 双侧，parity 门禁；「不可恢复」文案键名登记）。恢复按钮复制命令主形态 `/ctx-expand <startMessage>-<endMessage>`（compartment 行身份是序数区间，非 tag）。
- **Step 6**：契约测试新文件 test-magic-context-session-context-rpc.mjs（①：正常/降级三分支/分页截断/isCurrent 标记与强制入列；②：currentSessionId 混入整批拒/deleted/protected（预查谓词）/幂等复清/降级 fail-visible）；list sourceSessionId 过滤 + total 口径用例。**既有 19 例需 fixture 补齐**（entry 新增必填 sourceSessionId，手工 entry 构造 test-magic-context-memories-rpc.mjs:357-374 逐条补键）+ 新增「entry 缺 sourceSessionId 拒」负例——回归口径=更新后 19 例全绿。launcher 条件式（T-S3）以 packages/ui dist 直测 `resolveOpenTabLauncherItemIds`/`shouldOffer*` 纯函数（ui-config 测试同款 import 基建）；对话框文案/禁勾（T-S7）以 i18n 键存在性 + 组件源引用断言（源守卫式）。
- **Step 7**：门禁（tsc 全链/lint/arch/parity/契约更新后全绿/ui-config 14）+ CHANGELOG + 迭代登记。
- **Step 8**：真机 e2e（可选，对齐 Step 11 形态）：spawn + 协议直调 ①② + SQLite 对账（清理后 compartments/tags 行消失、memories 行数不变、protected 会话行保留）。

## 六、验收断言（blocking）

- T-S1：list 带 sourceSessionId 只回该会话写入行，total 按过滤后集合，与 SQLite `WHERE source_session_id=?` 对账一致。
- T-S2：entry.sourceSessionId nullable 直通（历史行 null 回显）。
- T-S3（载体=ui dist 纯函数直测）：无活动会话时 resolveOpenTabLauncherItemIds 不含两新 id；有 activeTaskId 时含。会话记忆标签列表=T-S1 同集。
- T-S4：sessionContext 正常返回（当前会话零分区合法）+ disabled/unavailable/unsupported 三降级信封 + workspaceSessions truncated + isCurrent 强制入列（当前会话未绑定时也有一行）。
- T-S5：cleanup 含 currentSessionId → 整批 -32010 拒且库零变更（mutation 无、行数不变）；正常批次 → outcomes 逐 session（deleted/protected）、SQLite 对账（该会话 compartments/tags/session_meta 行消失；memories 表行数不变——SESSION_SCOPED_TABLES 33 项无 memories，实证）；幂等复清零行不报错。
- T-S6：protected 会话（fixture 手插 pending_session_cleanup `harness='zcode:rust'` marker 行）→ 预查命中 outcome=protected 且该会话行保留。
- T-S7（载体=i18n 键 + 组件源引用断言）：清理确认对话框文案键含「不可恢复」语义且被组件引用；isCurrent 行禁勾（源断言）。
- T-G：tsc/lint/arch/parity/契约（更新后 19+新例）/ ui-config 14 全绿。

## 七、风险与兼容

- **wire entry strict 加必填字段**：双向配对升级——「新 CLI + 旧 UI」（entry 多键被旧 strict schema 拒）与「旧 CLI + 新 services」（缺键被新 resultSchema 拒，services client.request 第三参真 parse）都会拒；同轮交付覆盖，登记为「升级需配对」。
- **清理误删活动会话**：双重防线（UI isCurrent 禁勾 + handler 整批拒 currentSessionId）；Rust marker 由 clearSession 内置守卫 + handler 预查双保险。
- **bootstrap 直写 SQL 漂移**（枚举/聚合/protected 预查三处）：列名漂移以契约测试对账兜住（fixture 行驱动断言）。
- **恢复按钮预填通道 gate**：已实证限草稿 composer（SessionPane.tsx:3415），一期剪贴板降级不阻塞；gate 放开后切预填（OQ1）。
- **性能**：workspaceSessions 聚合碰 session_projects/session_meta/compartments/tags 四表 COUNT/SUM/LEFT JOIN，50 会话量级无风险；不加索引（现查即用，慢了再说——登记 OQ2）。

## 八、open questions（不阻塞）

1. 恢复按钮：上游放开 requestComposerTextInsert 会话内消费后，剪贴板切预填。
2. 清理批上限 50 与 workspaceSessions 聚合索引：首次实测后可调。
3. workspaceSessions 是否需要按时间过滤快捷键（「只看 30 天前」）。
4. 会话记忆标签是否要展示「本会话写入后被合并/废弃」的全集（当前=写入全集含 archived，与设置页口径一致，无需改）。
