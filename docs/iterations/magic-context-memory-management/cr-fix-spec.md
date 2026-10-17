# CR Fix Spec: magic-context-memory-management

## 元信息
- repo / base_sha / head_sha: D:\worktree\magic-context-memory-management / 2301debc / 33c23274
- prd_path / spec_path: 未提供 / docs/iterations/magic-context-memory-management/spec.md
- review_round / dag_version: 2 / 3
- 状态: fix-spec-ready

本轮评审：round 1 = wave-1 五路 review-scope（6×P2）；round 2 = review-full（追加 MF-1/MF-2 两条 P2，修正 1 处路径笔误、精化 2 处改法）。合计 8×P2、0×P0、0×P1；spec_deviations none（五路 + full 复核）。

## Must-fix（按 P0 → P1 → P2）

### scope-d/G-1 [P2] dispatch 两处 case 无常驻自动化守卫（四处手工对齐坐标 ③ 失守）
- 维度: G（+C-orch 对齐证据）
- 文件: apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-memories-rpc.mjs（新增断言；被测对象 src/zcode-protocol/server.ts）
- 问题: 契约测试直调 handler、services 降级测试走假 app-server，均不经 server.ts dispatch（全仓无测试 import zcode-protocol/server.js，既有惯例）。误删任一 case 或重构 switch 时 15/15、ui-config 14/14、typecheck 全绿，方法静默变 -32601；唯一真路由证据（Step 11 e2e driver）已按迭代登记删除。
- 改法:（推荐 a，成本最低）在契约测试加「源守卫」断言（沿用 T-O1 源守卫先例）：读 src/zcode-protocol/server.ts 文本，断言同时存在 `case zcodeProtocolMethods.workspaceListMagicContextMemories:` 与 `case zcodeProtocolMethods.workspaceArchiveMagicContextMemories:`，且分别 `return await listMagicContextMemories(...)` / `return await archiveMagicContextMemories(...)`；失败文案点明「四处手工对齐坐标 ③（CLI switch case）」。备选 b：固化一次性 e2e driver 为 scripts/test-magic-context-memories-e2e.mjs（真实 cli/dist/zcode.cjs app-server + services 客户端 + USERPROFILE/HOME 临时重定向）并登记 package.json。
- 验收/测试: 手工注释掉 server.ts 任一 case → 断言必须红；恢复后与原 15 例同跑绿。
- 来源: review-scope-d / round 1

### scope-d/G-2 [P2] 四个降级/失败分支无常驻覆盖（含 Step 6 点名的身份解析失败）
- 维度: G
- 文件: apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-memories.ts（:255-265、:352-358、:243-252、:344-349）；测试同 G-1 文件
- 问题: ① list 身份解析失败 → available:false/unavailable 信封；② archive 身份解析失败 → -32010 fail-visible；③ openDatabase 返 null（list 信封）与 ④ archive null（抛可读 ProtocolRequestError，与 throw 分支「原文透传」是两种可观察行为，已登记裁定要求严格区分）——四分支均无断言。身份解析失败是 spec Step 6 明文职责且两方法行为不同，属行为级缺口。
- 改法: 契约测试新增用例（另起一次性项目目录，不动 seedDb）：list 用 workspacePath=os.homedir()（只读探测、不写盘；MAGIC_CONTEXT_DB_PATH 已隔离；若设 HOME/USERPROFILE 须在 import 前）→ 断言 supported:true/available:false/reason:"unavailable"/entries 空/counts 全零/truncated:false；archive 同 workspacePath → 断言 reject 为 code -32010、message 含 no usable project identity、无 outcomes 无 mutation 行。openDatabase-null 分支：能低成本构造（写不兼容 schema 版本行）则各补一例，否则在测试头注释显式登记「不可达+理由」。
- 验收/测试: 新用例先红后绿（改掉对应分支返回形态必须失败）；原 15 例 + 新例全绿，ui-config 14/14 不受影响。
- 来源: review-scope-d / round 1

### scope-b/G-1 [P2] 工具契约 CtxMemoryInputSchema 边界零测试守卫；4096/100 三处拷贝无 drift guard
- 维度: G
- 文件: apps/zcode-cli/packages/contracts/src/tools/ctx-context.ts；apps/zcode-cli/packages/core/scripts/test-ctx-memory-archive.mjs（断言落点，contracts 包无 test script）；packages/shared/src/zcode-protocol/index.ts:2251-2252（wire reason 上限注释/字段）
- 问题: CtxMemoryInputSchema 的 .strict()、action 枚举缺省 write、ids min(1)/max(100)、reason max(4096) 在仓库内无任何测试；wire 面 T-R1 覆盖的是 shared 侧另一处声明，4096/100 数值多处拷贝（工具契约 / shared wire 契约 / 工具文案；另有 UI 第四处 REASON_MAX_LENGTH=4096，MemoryManagementSection.tsx:70——UI 依赖方向不能 import contracts，保持注释锚定）仅注释对齐，无机制防漂移。
- 改法: ① 在 core 测试（test-ctx-memory-archive.mjs 或新增）加行为断言：CtxMemoryInputSchema.safeParse 对 {action:"archive",ids:[]} 拒、ids 101 拒、reason 4097 拒、action:"bogus" 拒、缺省 action 等价 write、未知键拒（strict）；② drift guard：contracts 包导出常量（如 CTX_MEMORY_REASON_MAX_LENGTH / CTX_MEMORY_IDS_MAX），工具契约引用；core 测试断言两 schema（工具契约与 shared wire 契约经 packages/shared/dist 导入）的 max 数值相等；文案里的数字注释锚定常量名。
- 验收/测试: 新断言绿；人为改任一处 4096→2048 时 drift 断言红。
- 来源: review-scope-b / round 1；review-full / round 2 修正路径与落点

### scope-c/C-1 [P2] MemoryCategory 注释计数错误（写 13 值，实为 12 值）
- 维度: C（注释事实错误，无功能影响）
- 文件: packages/shared/src/zcode-protocol/index.ts:2200、:2219；apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-memories.ts:46
- 问题: 三处注释称 MemoryCategory「13 值 accept-both：v2 五类 + legacy 九类桥接」；实读 types.ts 为 12 个字面量（v2 与 legacy 重叠 CONSTRAINTS/NAMING，5+9−2=12），13 在任何口径下不成立且与自身括号说明自相矛盾。
- 改法: 三处 `13 值` → `12 值`，并写明去重口径：「12 值 accept-both：v2 五类 + legacy 九类，重叠 CONSTRAINTS/NAMING 去重后 12」。
- 验收/测试: `rg -n "13 值" apps packages` 归零（当前 3 处）。
- 来源: review-scope-c / round 1

### scope-e/J-1 [P2] 无工作区占位文案复用「上下文管理」分区 i18n 键，指向错分区
- 维度: J（兼 C 文案一致性）
- 文件: packages/ui/src/settings/MemoryManagementSection.tsx:325（键在 zh-CN.ts:2012 / en-US.ts:2144）
- 问题: 无工作区时面板渲染 settings.context.noWorkspace（「…再配置上下文管理。」），用户身处「项目记忆」分区被指向另一分区，用户可见错位。
- 改法: 新增 `settings.memory.management.noWorkspace`（zh「请先打开一个工作区，再管理项目记忆。」/ en "Open a workspace before managing project memories."），:325 改用新键；双 locale 同步保持 parity。
- 验收/测试: `node scripts/check-i18n-parity.mjs` 绿（两侧 +1 对称）；无工作区打开「项目记忆」分区显示新文案。
- 来源: review-scope-e / round 1

### scope-e/B-1 [P2] 读取失败与空态占位同屏：错误态下断言「暂无记忆」自相矛盾
- 维度: B（错误处理/边界）
- 文件: packages/ui/src/settings/MemoryManagementSection.tsx:338-348（错误横幅）、:449-459（空态 TID_SETTINGS_MCM_EMPTY）；另涉 :372-394（counts 徽章与操作区）
- 问题: load 失败 → loading=false、entries=[] → 错误横幅与「该项目暂无项目记忆。」同屏；空态是对数据的肯定断言，此刻并未读到数据。
- 改法: 空态分支加错误门——`loading && entries.length===0 ? loading态 : loadError!==null && entries.length===0 ? null : visibleEntries.length===0 ? EMPTY : list`（错误且无数据时由横幅独占主区，不渲染 EMPTY）。counts 徽章保持最近一次成功值（不清零）：错误横幅在场时旧 counts 与错误并存是可接受的（横幅已解释数据不可用），不额外处理。
- 验收/测试: 断网/令 list 抛错且无已加载数据时，面板只显示横幅+重试，无 EMPTY 文案；counts 显示最近成功值（非误导性 0）；重试成功恢复；TID_SETTINGS_MCM_EMPTY 仅在成功读取且为空时出现。
- 来源: review-scope-e / round 1；review-full / round 2 精化 counts 口径

### review-full/MF-1 [P2] 批量废弃无 100 条上限：>100 条勾选被 wire -32602 整批拒
- 维度: B（边界）+ C-orch（跨端信号混用）
- 文件: packages/ui/src/settings/MemoryManagementSection.tsx（submitArchive :265-275、toggleAllVisible :248-263、PAGE_SIZE=200 :68）
- 问题: selectableVisibleIds 无上限，「全选当前列表」最多可勾 200 id；wire memoryIds 1..100（shared :2289，bootstrap 测试已钉 101 拒），services/UI 均不分片不钳制——counts.total>100 的项目全选废弃 100% 失败，用户只得到协议层英文错误 toast。此前在 .iteration-state.yaml 登记 P3 观察，本轮按「已认定+改法明确」升格 must-fix。
- 改法（择一，推荐 a）: a) submitArchive 内按 100 分片顺序调用，合并 outcomes 后统一组 toast（成功数/失败数）；b) 勾选/全选钳制 100 条并提示「一次最多废弃 100 条」；c) 提交前 >100 直接 toast 明确上限并 return（最小改动，用户手动减选）。
- 验收/测试: 构造 >100 条记忆项目 → 全选废弃成功（a）或得到中文上限提示且不发请求（b/c）；断无 -32602 协议错误 toast。
- 来源: review-full / round 2（新发现）

### review-full/MF-2 [P2] shared list result reason 注释词表缺降级第三值 "unsupported"
- 维度: C（注释与实现不一致，与 scope-c/C-1 同类）
- 文件: packages/shared/src/zcode-protocol/index.ts:2251（注释）/:2252（字段）；对照 packages/services/src/zcode-agent/zcodeAgentService.ts（list catch）与 magicContextMemoriesDegradation.test.ts:126
- 问题: 注释写 available=false 原因词表 "disabled" | "unavailable"，但 services -32601 降级合成 reason:"unsupported"（schema 是 z.string().optional() 不枚举，当前无 bug；若按注释收窄枚举即降级信封 parse 失败）——三处口径不一的漂移风险。
- 改法: 注释补第三值：「available=false 的原因："disabled" | "unavailable"；旧 CLI 降级时 services 另用 "unsupported"（UI 以 supported:false 为主判据）」。
- 验收/测试: `rg -n '"unsupported"' packages/shared/src packages/services/src` 两处注释互指一致。
- 来源: review-full / round 2（新发现；memory #44 已登记该值，shared 注释未同步）

## Spec deviations
- none（wave-1 五路核实：已登记裁定 6 项实现一致，均 fixed；无 open）

## Open questions / 待拍板
1. scope-a/Q1 组合函数预验证在事务外，跨进程并发 archive 存在 TOCTOU（重复 mutation 行被 m1 coalesceMutations 折叠，用户不可见）——spec 明文「预验证事务外」，是否接受现状？（评审倾向：接受）
2. scope-a/Q2 ownership 判据内联 normalizeStoredProjectPath 比较，同包已有 storedPathBelongsToIdentity（:812）——是否收敛复用防两份判据漂移？（spec 点名导出 normalizeStoredProjectPath，现实现合规）
3. scope-a/Q3 legacy 裸路径行可被工具面按 id 归档但不出现在面板列表/counts（list 用精确 project_path 匹配）——spec 即如此规定，确认「面板只管理规范化身份行」为预期
4. scope-b 5 条小问题（not-found 文案双格式、light 描述宣称不存在动作属上游逐字区、no-op 登记缺位、Step 10 命令形式、write-only 元数据文案）——均未认定，见 round-1 报告，不阻塞
5. scope-c/Q1 services BUSY 判据是否并行消费 data.code（现仅 message 正则，是唯一全覆盖判据；纯加固）
6. scope-d/Q2 list 读段无 try/catch（SQLITE_BUSY 冒泡 -32603）——review-full 补充事实：services list catch 经 toRetryableMagicContextError 转成「读取记忆列表失败：记忆库正忙」可重试文案，UI 体验无缺口；剩余仅文件头注释与实现口径对齐问题（读段是否收敛 unavailable，或注释限定「开库段」）
7. scope-e/Q1 spec「逐条/多选废弃」实现为「勾选（含单选）+批量+确认框」，无行级按钮——能力覆盖单条，是否需行级入口
8. review-full/Q1 协议 category 参数无消费方（UI 客户端过滤已加载条目）——保留预留面还是收窄（>200 条项目服务端过滤更优）
9. review-full/Q2 工具面 openMagicContextDatabase catch 一切异常返 null（ctx-memory.ts:70-78），archive 遇 BUSY 得「ctx tools are inert」而非「库忙重试」——write 既有行为、spec 只要求 RPC 面转译，是否登记观察即可

## 已豁免（用户确认不修）
（无）

## 合并后 QA（manual_user）
- 面板视觉（徽章/对话框/分页）、onboarding 无记忆勾选、断开 CLI 后面板占位态、真实会话注入面收敛观察（T-E1 剩余人工项，见 .iteration-state.yaml step11_manual_pending）

## K 节建议（下游执行时闭合）
- test-magic-context-memories-rpc.mjs 测试头「前置构建」清单补 @zcode/model-option-map（registerHooks 抛 no compiled dist 的自解释项）
- shared 侧 limit 注释「host 层按同值截断」改写为「CLI host（bootstrap handler）按同值截断」（措辞歧义，scope-d/Q1）

## Fix-Spec Closure

| 项 | 状态 |
| fix-spec-ready | yes |
| fix_spec_path | docs/iterations/magic-context-memory-management/cr-fix-spec.md |
| dag_version / review_round | 3 / 2（round 1 = 五路 scope 并行；round 2 = review-full；round 2 后按其修正单补齐，评审明示无需再开波次） |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 8 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（五路必查项 + full 跨界复核；两处跨界发现已入 must-fix） |
| C 类合并后 QA | 面板视觉 / onboarding 勾选缺失 / 断开 CLI 占位态 / 注入面观察（见「合并后 QA」节） |
