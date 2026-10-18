# session-memory-and-context spec（P2+P3，v1）

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
| F7 | `deleteSessionScopedRows(db, sessionIds, harness, {rustModuleCleanupAcknowledged})`：30+ 表依赖安全序删除、内置 Rust marker 保护（pending_session_cleanup harness LIKE '%:rust'）、返回实删数；**不排除普通活动会话**（组合层责任） | storage-session-tables.ts:16-134 |
| F8 | 侧边栏标签 = `OpenTabLauncherItemId` 枚举 + `resolveOpenTabLauncherItemIds` + tab union + TabsContent 分支 | animatedSidePanePanelModel.ts:3-42，app-shell/types.ts |
| F9 | tag 恢复走会话文件（renderItemByTag 混合 db+raw session），RPC 化成本高 | ctx-expand/tools.ts:81/render.ts:285-315 |

## 一、目标

1. **P2 会话记忆标签**：会话侧边栏新增「会话记忆」标签 =「本会话写入的跨会话项目记忆」管理面板（列表/分页/分类/废弃，复用设置页面板能力）。
2. **P3 会话上下文标签**：会话侧边栏新增「会话上下文」标签 = 当前会话 compartments 浏览（预览/在会话中恢复）+ workspace 会话残留清单与安全清理。

## 二、非目标

- notes 表管理面（F1 恒空）；session_facts 管理面（机制内部物，无管理语义）。
- dropped tags 单条原文预览（F9 混合 IO；只出元数据统计）。
- un-archive、compartment 重建（/ctx-recomp 已有）、跨 harness 清理（只清本 harness）。
- magic-context `core/**` 任何改动；barrel（src/index.ts，fork 出口编排面）允许加导出。
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
  - `current`: `{ sessionId, compartments: [{sequence, startMessage, endMessage, title, contentPreview(前 500 字), importance, createdAt}], compartmentCount, lastCompartmentEndMessage }`——`getCompartments` 直读（F6），当前会话可能零分区（新会话），空数组合法。
  - `tagSummary`: `{ total, dropped, droppedTokenCount }`——按 sessionId 聚 tags 表（status/token_count 列直接 SUM/COUNT）。
  - `workspaceSessions`: `{ total, truncated, sessions: [{sessionId, updatedAt, compartmentCount, tagCount, tokenEstimate, isCurrent}] }`——workspace 全部会话（session_meta.updated_at 倒序；isCurrent=sessionId===currentSessionId；实施 Step 0 核对 session_meta 实际时间列名，若无 updated_at 则取 compartment_events/tags 的 MAX(created_at) 兜底口径并在 schema 注释登记）。
- handler 落点：bootstrap 新文件 `zcode-protocol/magic-context-session-context.ts`（照 memories handler 样板：effective 门/身份解析/降级三段）。

### 4.2 新 RPC ②：`workspace/cleanupMagicContextSessions`

- params：`workspace` + `sessionIds: string[] 1..50`（批上限低于 archive 的 100：DELETE 重语句多表，批更保守）+ `currentSessionId: string`。
- 语义：**fail-visible 整批拒绝**若 `sessionIds` 含 currentSessionId（-32010 可读错误「当前会话不可清理」，不改库）；否则 barrel 导出 `deleteSessionScopedRows`（harness=getHarness()）调用，返回 `{ outcomes: [{sessionId, outcome: "deleted" | "protected"}] }`——protected=Rust marker 跳过（F7 内置），实删数=deleted 数。幂等：重复清理已不存在的 session → deleted 0 行也不报错（outcomes 恒回，del 不到的行天然无操作）。返回体带 `reclaimedSessions: number`。
- **不做**：按时间自动清理、定时器、全部清理快捷键（一期手动勾选）。

### 4.3 dispatch 与守卫

- server.ts dispatch +2 case（方法名直通新 handler）。
- 源守卫测试（test-magic-context-memories-rpc.mjs 段内或新文件）：剥注释+行锚定断言两 case 存在与 return 字面量（照既有「源守卫」用例样板）。

### 4.4 UI（会话上下文标签）

- 新组件 `SessionContextSection.tsx`（会话侧边栏标签内容）：
  - 段①「当前会话」：compartments 列表（标题/消息区间/token/importance + 行内展开 contentPreview 全文）；每行「在会话中恢复」按钮 = 把 `/ctx-expand <tag或ordinal>` 预填主会话输入框（输入框预填通道实施时核对 task store 的 draft 写入；若无公开通道则降级为「复制命令」剪贴板按钮——Step 内二选一并登记）。
  - 段②「丢弃标签摘要」：total/dropped/tokenCount 三徽章。
  - 段③「工作区会话残留」：session 清单表格（时间倒序、isCurrent 置顶禁勾、每行 compartment/tag/token 统计）+ 勾选 +「清理所选」确认对话框（列出将删除的会话数与 token 量预估、文案明示「删除该会话的全部压缩分区与标签，不可恢复」）+ 逐批 outcome toast（deleted N / protected M）。
- 清理后刷新：重拉 listMagicContextSessionContext。

## 五、步骤分解（实施顺序）

- **Step 0**（核对，无代码）：session_meta 时间列实读；输入框预填通道有无（决定 4.4 恢复按钮形态 a/b）；两结论登记进本 spec 的实施附注。
- **Step 1**：shared 协议（entry 字段/list 参数/两新方法 schema/testids TID_SESSION_*）+ dist 重建。
- **Step 2**：magic-context barrel 导出 `deleteSessionScopedRows`（+注释：供宿主会话清理，marker 保护语义见 F7）。
- **Step 3**：bootstrap：list handler 过滤串联 + 新 handler 文件 + dispatch 2 case + 源守卫用例。
- **Step 4**：services 透传（list 加参 + 2 新方法）+ 类型。
- **Step 5**：UI：MemoryManagementSection props 化 + 侧边栏两标签注册 + SessionContextSection + i18n（zh/en 双侧，parity 门禁）。
- **Step 6**：契约测试新文件 test-magic-context-session-context-rpc.mjs（①：正常/降级三分支/分页截断/isCurrent 标记；②：currentSessionId 混入整批拒/deleted/protected 幂等复清；list sourceSessionId 过滤 + total 口径）；既有 19 例回归绿。
- **Step 7**：门禁（tsc 全链/lint/arch/parity/契约/ui-config）+ CHANGELOG + 迭代登记。
- **Step 8**：真机 e2e（可选，对齐 Step 11 形态）：spawn + 协议直调 ①② + SQLite 对账（清理后 compartments/tags 行消失、memories 不受影响）。

## 六、验收断言（blocking）

- T-S1：list 带 sourceSessionId 只回该会话写入行，total 按过滤后集合，与 SQLite `WHERE source_session_id=?` 对账一致。
- T-S2：entry.sourceSessionId nullable 直通（历史行 null 回显）。
- T-S3：会话记忆标签在无活动会话时不可开（launcher 条件式），活动会话下面板列表= T-S1 同集。
- T-S4：sessionContext 正常返回（当前会话零分区合法）+ disabled/unavailable/unsupported 三降级信封 + workspaceSessions truncated。
- T-S5：cleanup 含 currentSessionId → 整批 -32010 拒且**库零变更**（mutation 无、行数不变）；正常批次 → outcomes 逐 session、实删行 SQLite 对账、memories 表行数不变（F7 表清单不含 memories，实证）。
- T-S6：protected 会话（手工插 pending_session_cleanup rust marker 行）→ outcome=protected 且该会话行保留。
- T-S7：清理确认对话框文案含「不可恢复」；isCurrent 行禁勾。
- T-G：tsc/lint/arch/parity/契约 19+新/ ui-config 14 全绿。

## 七、风险与兼容

- **wire entry strict 加字段**：旧 UI + 新 CLI 会拒（strict 拒未知键）——闭环同轮交付无此组合；登记为「升级需配对」。
- **清理误删活动会话**：双重防线（UI 禁勾 + handler 整批拒 currentSessionId）；Rust marker 由 F7 内置。
- **session_meta 无时间列**（Step 0 若证真）：残留清单排序退化为 compartment_events MAX(created_at)，口径在 schema 注释登记。
- **恢复按钮预填通道缺失**：降级剪贴板复制（文案提示粘贴执行），功能不阻塞。
- **性能**：workspaceSessions 聚合 30+ 表只碰 compartments/tags/session_meta 三表 COUNT/SUM，50 会话量级无风险；不加索引（现查即用，慢了再说——登记 OQ）。

## 八、open questions（不阻塞）

1. 清理批上限 50 是否合适（首次实测后可调）。
2. workspaceSessions 是否需要按时间过滤快捷键（「只看 30 天前」）。
3. 会话记忆标签是否要展示「本会话写入后被合并/废弃」的全集（当前=写入全集含 archived，与设置页口径一致，无需改）。
