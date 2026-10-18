# session-memory-and-context brainstorm（2026-10-18）

需求来源：用户口述（测试 magic-context-memory-management 桌面端期间提出，拍板「做 C，多做些更好」）。
前置迭代：magic-context-memory-management（dev-ready，HEAD e95982b2，未合并——本迭代基于其顶续做）。

## 一、需求

1. **记忆面板分页**：设置页记忆管理面板当前一次性全加载（limit 200 默认），要真分页（性能 + 翻页体验）。
2. **会话侧边栏新增标签（方案 C = 双标签）**：会话页面「选择要在侧边面板中打开的标签」里加：
   - **会话记忆**：会话层级的记忆管理（会话私有层）
   - **会话上下文**：压缩分区 / 已丢弃标签的管理（浏览 / 恢复 / 清理，即 /ctx-status 的面板化）

## 二、模型澄清（用户概念对齐记录）

mc.db 内容三层（DDL 实证）：

| 层 | 表 | 锚定 | 语义 |
|---|---|---|---|
| 跨会话记忆 | `memories`、`primers` | project_path | 所有会话共享注入 |
| 会话私有 | `notes(type='session')`、`session_facts`、`compartments`、`tags` | session_id | 仅本会话（持久化为 resume 服务，不跨会话注入） |
| 纯缓存 | 注入块缓存 m0/m1 | 进程内 | 性能优化无内容语义 |

- 「压缩分区 130 / 已丢弃标签 513 (46万 token)」= workspace 历史所有会话累积的压缩产物（旧会话残留是清理标的）。
- `tags` 表无原文列（索引：session_id/tag_number/status/token_count）；恢复数据源待 spec 挖（compartments.content/p1-p4 或 expand 真身内部路径）。

## 三、调研事实（2026-10-18，worktree e95982b2 实读）

### 数据面（magic-context 包）
- **notes CRUD 齐备**：`storage-notes.ts` 导出 `getSessionNotes`/`getNotes`/`addNote`/`updateNote`/`dismissNote`/`deleteNote` 等；**barrel（src/index.ts，fork 出口编排面）未导出**——加导出不碰 core 逐字区（上游同步安全）。
- **compartments 只读已导出**：`getCompartments`（/ctx-status 同源查询，:275）。
- **统计面已导出**：`readMagicContextStatusSnapshot`（预算/分区/dropped 桶，/ctx-status 数据源）。
- **会话级清理原语在包内**：`storage-session-tables.ts` 的 `SESSION_SCOPED_TABLES` + `deleteSessionScopedRows`（带 harness 约束 + Rust cleanup marker 保护：活动会话被 marker 保护直到 host 确认，防孤儿清扫删掉重试坐标）；barrel 未导出。
- **ctx_expand 真身已导出**：`createCtxExpandTools` + `CTX_EXPAND_*` 常量（barrel :313-319），host 可装配。
- **memories 的 session 关联**：`source_session_id` 列（写入时记录来源会话，历史数据可空）。

### UI 面（packages/ui）
- 侧边栏标签注册：`OpenTabLauncherItemId` 枚举（animatedSidePanePanelModel.ts:3-8）+ `resolveOpenTabLauncherItemIds` 清单 + tab union（app-shell/types.ts + lib/workspaceSidePane.ts）+ AnimatedSidePanePanel 的 TabsContent 渲染分支。加新标签样板清晰（对照 review/terminal/browser 任一现成标签）。
- 记忆面板复用：`MemoryManagementSection.tsx` props 化数据源即可双用（设置页/会话标签）。

### 协议面
- 分页参数已备：`workspace/listMagicContextMemories` wire 已有 `limit(1..200)/offset/category/truncated`，UI 未消费——需求 1 纯 UI 改动 + 把分类过滤切到服务端参数（分页与过滤必须绑定，否则客户端过滤只作用于当前页）。
- 新 RPC 照 memories 三段式样板（shared schema → bootstrap handler → services，additive 兼容）。

## 四、范围草案

- **P1 记忆面板分页**（quick win）：服务端 category 过滤 + limit/offset 翻页 + counts 全量徽章不变；红利=本页全选天然 ≤100，MF-1 分片边界场景自然消解（OQ 结案）。
- **P2 会话记忆标签**：`notes(type='session', session_id=当前会话)` 列表/废弃 + 「本会话写入的 memories」段（source_session_id 过滤，跨会话库的会话视图）；2-3 条新 RPC。
- **P3 会话上下文标签**：当前会话 compartments/tags 浏览 + workspace 级统计（复用 status snapshot）+ 旧会话残留清理（deleteSessionScopedRows 包一层安全边界：仅非活动会话、确认对话框、行数/token 回收预估）+ 恢复入口（ctx_expand 通道二选一：RPC 组合真身 vs 会话命令通道）。

## 五、待挖点（spec 阶段必须闭合）

1. **notes 写入者是谁**：barrel 注释「ctx_note 工具 N2 终局不做」——若无运行时写入者，notes 表恒空，P2 的会话记忆要以「本会话写入的 memories」为主、notes 只读兜底。（查 getSessionNotes/replaceAllSessionNotes 的包内调用方）
2. **tags/compartments 原文路径**：恢复与内容预览的数据源（expand 真身内部读什么表什么列）。
3. **deleteSessionScopedRows 调用契约**：marker 保护的完整语义、候选 session 来源（谁的 session 算「非活动」）、harness 过滤。
4. **恢复通道选择**：RPC 直接组合 expand 真身（干净、要写）vs 复用 /ctx-expand 会话命令通道（快、污染会话输入框语义）。
5. **会话标签的会话身份对齐**：UI 侧 sessionId 与 mc.db session_id 的映射链（ZCode 会话 id 是否就是 mc 库的 session_id——查 session_projects 写入方）。

## 六、迭代边界建议

- 基线：magic-context-memory-management@e95982b2 顶（未合并；合并顺序两分支先后皆可）。
- 不碰：magic-context `core/**` 逐字区（barrel 出口编排除外）、memories 主链 schema。
- 顺序建议：P1 独立先行（半天）→ P2+P3 一张 spec 走 loop（跨五层但每层小步，模式与上一迭代同构）。
