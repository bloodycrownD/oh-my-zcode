---
date: 2026-10-16 15:00
title: 答疑：设置页两条记忆线辨析 + magic-context 记忆可管理性 + 记忆区改造可行性
keywords: 记忆, memory, 工作区记忆, memoryEnabled, 跨会话项目记忆, magic-context, magic-context.db, ctx_memory, ctx_search, 记忆管理, archive, brain-storm
abstract: 用户想移除设置页「需要在设置开启」的原生跨会话记忆、并把记忆区改成 magic-context 记忆管理。三路探索辨明设置页有两条记忆线：①「记忆」分区=上游原生工作区记忆（默认关、文件式，且被 D11 互斥裁定压住注入面）；②「上下文管理」分区= magic-context 跨会话项目记忆（默认开、SQLite）。magic-context 记忆非关键词 KV 而是关系表+FTS5；fork 现状 ctx_memory 只放开 write（archive/update/merge/get 后端就位未接线）、dreamer/TTL 不生效，记忆只进不出；人工管理零入口但数据层原语（archive 软删、计数查询、mutation log corrections）全部就位，记忆管理 UI 数据层可行，缺的是 CLI↔UI 列举/操作 RPC。
---

user:
调研一下：1. omz原生是提供跨会话记忆的，只是需要在设置开启？其实我觉得用处不大，可以移除。2. magic context是否提供了跨会话记忆？它的记忆系统是否可管理？3. 我觉得设置页面的记忆其实可以改成magic context的记忆管理。我理解magic context的记忆是类似于关键词kv那种的？agent可以自己进行废弃过时的？人工也可以废弃？

assistant:
按 brain-storm 派 3 个只读探索子代理（设置页记忆链路 / magic-context 记忆子系统 / 文档与历史脉络），结论如下。

【辨析：设置页有两条记忆线，用户说的「需要在设置开启」= 原生「工作区记忆」】
①「记忆」分区（sidebar id=memory）= 上游 ZCode 原生功能（随 v3.14.3 基线带入，非 omz 新增）：开关 appSettings.memoryEnabled，默认 false；文件式存储 ~/.omz/cli/memories/projects/<slug>-<hash>/memory/*.md（MEMORY.md 索引+主题文件，turn 后 extraction 写入）；桌面 MemorySettingsViewer 只读查看。经 session/requestRuntimePreferences RPC 下发 CLI。
②「上下文管理」分区（sidebar id=context）= magic-context「跨会话项目记忆」（v1.0.6 / bugfix-batch-20261011 Step 11 / commit 285054a0 落地）：开关 magicContext.memory.enabled，默认 true（对齐上游）；写盘 ~/.omz/cli/config.json magicContext 域，热生效。
关键事实：D11 互斥裁定（commit 09b52efe）——magicContext.enabled（默认 true）时任一 magic-context 段在场 → 原生 # Memory 段与 MEMORY.md 索引双双退场。即 omz 默认形态下原生记忆的注入面被压住，「用处不大」基本成立。

【magic-context 记忆系统：是跨会话的，非关键词 KV，是带丰富元数据的关系表】
- 存储：SQLite ~/.omz/cli/db/magic-context.db memories 表（按 project identity=git 路径归一化跨会话共享），字段含 category/content/normalized_hash/importance/seen_count/retrieval_count/status/expires_at/verification_status/superseded_by_memory_id 等，UNIQUE(project_path,category,normalized_hash)；另有 FTS5 全文索引（embedding 语义检索 N1 终局不做）。
- 注入：<project-memory> 公告板（#id: fact 行）+ m1 <memory-updates> 修正；选择排序=permanent→importance→强化时间降序。
- 去重：normalized_hash 精确查重→已存在则 seen_count+1；merge 用 superseded 链。
- agent 自废弃：上游 ctx_memory 五 action=write/update/archive/merge/get；ZCode fork 契约只放开 write（contracts/src/tools/ctx-context.ts z.literal("write")），archiveMemory/deleteMemory/updateMemory/mergeMemories 已在 storage-memory.ts 移植就位但工具面未接线。自动废弃（dreamer expire）终局不做（N3）；write 不写 expires_at → 实机 35 条全 active、全 seen=1、无过期——现状记忆只进不出。
- 人工废弃：零现成入口（/ctx 命令族全是运维命令；上游 CLI 无记忆子命令；上游 dashboard 未实现但 sourceType "user" 已为人工录入预留守卫）。数据层可行：archive=一条 UPDATE+reason（软删）、getMemoryCountsByStatus/按 category/status/project 查询、mutation log corrections 通道（<removed>/<updated>/<superseded by=>）均就位。

【改造可行性】
- 移除原生记忆：最小=lib/settingsNavigation.ts HIDDEN_SETTINGS_SECTIONS 加 "memory" 一行（零协议改动，上游同步压力最小）；彻底删面清单见探索（组件 3+SettingsPage 5 处+services memory/ 三文件+shared schema/协议字段+onboarding 回填链+i18n 20+ 键+desktop 一处；协议字段 sessionRuntimePreferences.memoryEnabled/v4 commandAck 回声涉及 CLI 契约须跨包同步）。
- 记忆区改 magic-context 管理：数据层可行，缺口=packages/shared 无「列出记忆」协议命令（只有 read/updateMagicContextConfig）→ 需 CLI 侧新增 list/archive RPC；注意 UI dist 被 apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs import（改表单须同步）；废弃后 prompt 收敛依赖 <memory-updates> corrections 渲染是否接线（未核实）；直写 db 须遵守 chokepoint/lease/module authority 并发纪律。
- 建议配套解锁 ctx_memory archive action（契约枚举+handler 分支），让「用户口头废弃」与「UI 点废弃」共享同一数据路径。

遗留未核实：corrections 渲染接线状态；/ctx-wrapup/flush/dream/embed 四命令实现状态；上游 dashboard 功能面；原生记忆开启后实机行为（extraction 是否仍跑）。

---

【spec-generate 启动（2026-10-16）】

用户口述需求：移除/隐藏设置页原生「工作区记忆」区，把记忆区改成 magic-context 记忆管理（列表+人工废弃为主，是否含解锁 ctx_memory archive action、人工新增记忆待拍板）。requirement_path=用户口述（即本文件上一轮调研）。目标：产出 docs/iterations/magic-context-memory-management/spec.md 待用户确认。已派 3 个 spec 级聚焦探索子代理（协议通道范式 / magic-context 记忆操作面与注入渲染 / 原生移除面与测试基建），闭合上轮遗留未核实项。

【spec-generate 探索结论（2026-10-16，三份报告要点）】
①通道：workspace RPC 是结构化列表正道（workflows/list 范例：shared schema→services→bootstrap handler→server dispatch 四处手工对齐）；/ctx-* ACK 仅文本；services 层无 SQLite 依赖不可直读库；barrel 缺口（getMemoriesByProject/archiveMemory/getMemoryCountsByStatus/normalizeStoredProjectPath 未导出）是显式改动项（index.ts 4c 段为 fork 自有可扩）。
②记忆操作面订正：archiveMemory 已就位（1210-1227）但全仓零调用方；update/merge 组合函数并不存在（上轮「疑似就位」订正）；**archive 必须与 queueMemoryMutation 同事务成对写**——mutation log 在 fork 无生产写入者，只 archive 不 queue 则缓存 m0 基线里的废弃记忆不收敛（m1 corrections 渲染已接线：<removed> 判据=不在 eligible 集）；收敛时机=下次 cache-busting pass 或自然 HARD 折叠，非即时。
③原生移除面订正：三个记忆开关域——appSettings.memoryEnabled（默认 false，唯一功能落点 server-operations.ts:3205-3207 把 false 翻译成会话级 memory.enabled=false override）vs CLI features.memory/use（默认 true，门原生文件提取，不受 prompt 互斥影响）vs magicContext.memory.enabled（默认 true）。协议字段删除有 strict schema 兼容风险（新 CLI+旧 Host→会话创建失败）+默认翻转风险（删 override 原生记忆默认全开）→ spec 裁定：字段保留不动，UI 层替换分区+onboarding 摘勾选+存量 true 挂载自动归零。

【spec 落盘（2026-10-16，待用户确认）】
docs/iterations/magic-context-memory-management/spec.md：11 Step 五 phase（mc-barrel 组合函数 / ctx-memory-archive / memory-rpc 双命令 / memory-ui 分区替换 / regression+e2e）。

【拍板（2026-10-16）】D4=ctx_memory archive 解锁纳入本期（用户确认；Step 2/3 与 T-A1/T-A2 已升级 blocking:yes）。整体 spec 确认题用户跳过（未提异议）——实现启动前如需可再补一次显式确认。spec 状态：可执行（待实现，建议走 code-dev-loop / 派 impl 子代理，探索报告不构成跳过 impl 的依据）。
