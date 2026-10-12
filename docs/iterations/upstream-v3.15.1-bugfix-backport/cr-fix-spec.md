# CR Fix Spec: upstream-v3.15.1-bugfix-backport

## 元信息
- repo: D:\Dev\Js\oh-my-zcode（分支 upstream-v3.15.1-backport）
- base_sha: 39d1141b（迭代文档基线，本批代码改动前）
- head_sha: 24f7aee8
- spec_path: docs/iterations/upstream-v3.15.1-bugfix-backport/spec.md
- prd_path: 未提供（spec 即 PRD）
- review_round: 7
- dag_version: 8
- 状态：**用户已下令开工执行**（scl-r3 No-Go=0 P0/1 P1/7 P2 全部为文档补写级，已当场吸收：验收脚本 tsx --tsconfig 运行口径、kind 收窄表达式、零拷贝预置 ref 上游超集（spec_deviations 登记）、探测缺席 pageByCountOnly 回退、FORK 偏离声明×2、b/A-1 接线残余声明、d/G-2 platform 覆写机制、Closure 口径回填）
- 评审来源：review-scope-a/b/c/d（r1）+ review-full（r2，上游行号复核+独立快扫）+ review-full-2（r3）+ review-full-3（r4 终验）；e2e-run 真机 6/6 pass

## Must-fix（按 P0 → P1 → P2）

### b/A-1 [P1] 快照 reports 截 256 条后 count 用截断长度，模型面把总条数说错
- 维度：A + B
- 文件：`apps/zcode-cli/packages/core/src/tool/executor/workflow-artifact.ts:58`、`:81`（`count: items.length`）、`:67`（注释「count 恒是真实总条数」被本批破坏）；调用点 `background-tasks.ts:686`、`:1049`；产出侧 `dynamic-workflow-run-observation.ts:296-313`
- 问题：Step5 把 reports 钳到 256 条并产出 `reportCount`，但 core 的 `<reports count=…>` 与 manifest 仍按 `items.length` 报数 → 报满 run（>256 条）完成通知里总数被说成 256；`reportCount` 全仓无生产消费者（仅测试引用）。
- 改法：`background-tasks.ts` 增 `workflowSnapshotReportCount(snapshot)`（`"reportCount" in snapshot` + `typeof number` 收窄，与 `workflowSnapshotReports` 同款）；`:686`/`:1049` 传 total；`workflow-artifact.ts` 两个 builder 签名加 `total?: number`，**表达式照抄上游：`count: Math.max(total ?? 0, items.length)`**（上游 workflow-artifact.ts:63/92）。上游对照：`.reference/ZCode/.../background-tasks.ts:677-680,1042-1045,1150-1153`。
- 验收：fork 无 core/tests/ 形态——**转写为 core `scripts/test-workflow-report-count.mjs`**（**node --test + import `../dist/...` 口径**，选型理由：与「排在 `@zcode/bootstrap... build` 之后」自洽——该过滤连带构建 core dist（bootstrap/package.json:54 core 是依赖）；勿按 tsx+src 惯例放到 build 前），断言：>256 条时 `<reports count>`/manifest count=真实总数；无 `reportCount` 的老快照退回 items.length；接线根 `test:v4-perf` + core/package.json test 条目（归 wave-4 单写者）+ 登记 `cache/test-wiring-map.md`（上游用例参照 `background-task-control.test.ts:1405-1424`、`dynamic-workflow-run-track.test.ts:408-420` 断言本体）。**接线残余风险声明**：生产接线点 `background-tasks.ts:686/:1049` 不传 total 时 builder 默认 items.length、现有测试无感——该两行由 typecheck + cr-func 代码复核覆盖（本批不为此抽生产函数，避免通知路径重构；若 cr-func 复核发现漏传即 must-fix）。
- 来源：review-scope-b / r1；r2 补写落点与表达式

### b/A-2 [P1] workflow run 事件分页无字节界，一页可超单帧 16MiB 致详情页读不出（已拍板：方案 (a) 全链补齐）
- 维度：A（#25 后半未交付）+ B（transport.ts:656-665/:694 注释与实现矛盾）
- 文件：`packages/shared/src/zcode-protocol-v4/transport.ts:656-665,694`；`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1636-1647`；`bootstrap/src/app/dynamic-workflow-run-service.ts:542-551`；`contracts/src/interfaces/dynamic-workflow-run.port.ts:436-440`；`dynamic-workflow/src/engine/types.ts:848-880`；**贯穿点（r2 补）**：`v4-gateway.ts:380-383`、`bootstrap/src/app/types.ts:457-461`、`bootstrap/src/app/create-app.ts:1405-1415`（三处 host 内联方法类型声明）
- 问题：一页 ≤500 条、每条仅单条有界（`DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS`），聚合可远超单帧 16MiB（core.ts:66）→ `encodeTopicWireFrames` 抛 `proto.frameAssemblyTooLarge`（wire-codec.ts:184-186），详情页事件日志读不出。cr-func-1 D3 旧裁定「不实现字节界」依据不完整（未考虑该故障面），本条为重裁。
- 改法（全链补齐；scl-r1 改写 ② 为无歧义版本、补默认页口径）：① `contracts` port 增 `DynamicWorkflowRunEventsResult { events: DynamicWorkflowRunEvent[]; hasMore: boolean }`（**用 `DynamicWorkflowRunEvent[]`，勿用 StoredEvent——该类型属 @zcode/dynamic-workflow，contracts 未依赖且 port 文件 445-447 注释明文不引引擎类型**；上游 port:491-495）；② **`JournalStorePort` 增 `listEventPage`（SQLite 与内存两实现同语义，无「或」分支）——按 FORK「可选端口成员+能力探测」约定（types.ts:946-961）定为可选成员，run-service 侧探测，**探测缺席时回退现有 count-only 分页（`deps.journal.listEvents`，不实现字节界，照上游 `supportsEventPages(...) ? listEventPage : pageByCountOnly(...)` 口径，上游 run-service :610-612）**；`sequence-capture.ts:26-50` 逐方法显式转发器须同步补 `listEventPage` 转发（展开只拷贝自有属性，spread 不继承）；`DynamicWorkflowRunEventPage`（contracts :436-440）补 `maxBytes?: number`（上游 :484-489）；`JournalStorePort.listEvents` 保持 `StoredEvent[]` 不动**。【FORK 偏离声明×2：(i) 上游 `listEventPage` 住引擎端口外（dwf-journal-pages.ts:98-100「内存 journal 没有理由为它陪跑」），fork 放进引擎端口并要求内存同语义——理由=b/G-1 双实现契约测 + fork 既有 countTaggedReports 落端口先例；(ii) 上游 maxBytes 由 gateway 注入（上游 v4-gateway.ts:1654-1655），fork 定 run-service——host 面改动最小】（它有六个非 host 消费方：engine-world.ts:210、replay-order.ts:157、dynamic-workflow-run-introspection.ts:182、launch-anchor.ts:56/73/89、replay.ts:52、sequence-capture.ts:49——改它会全部打断）；**页化发生在 run port/host 链**：run port `listEvents`（contracts :634-637，现返回 `DynamicWorkflowRunEvent[]`，唯一消费点 create-app.ts:1410）返回类型改为 `DynamicWorkflowRunEventsResult`，据此同步三处 host 内联类型（`v4-gateway.ts:380-383`、`app/types.ts:457-461`、`create-app.ts:1405-1415`；`bootstrap/src/zcode-protocol/v4-bridge.ts:1653` 为语境类型跟随，无需编辑）；③ `dwf-journal-reads.ts` 用 `octet_length(payload_json)` 前缀和窗口 + 第一条恒带上（与 `listNodeRowsWithinBytes` 同习语；上游对照 `dwf-journal-pages.ts` 的 `listEventPage`/`pageEventRows`）；④ `journal-memory.ts` 同语义（双实现同语义是 b/G-1 验收前提，不可只落 SQLite 侧）；⑤ **maxBytes 注入层定为 run-service**（host/gateway 面不加参数，改动面最小）：run-service 传 `WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes`，**客户端省略 limit 时缺省页大小 = `maxEvents`（500，勿透传 undefined=旧行为不限）**，hasMore 改由存储判（消除与 limit+1 探测矛盾）；⑥ **恢复 `WORKFLOW_RUN_EVENTS_PAGE_LIMITS` export**（现为「去 export 守 knip」态，transport.ts:656 FORK 注释同步改为「cr-fix-spec b/A-2 恢复 export」）。
- 验收：并入 b/G-1 契约脚本（见下）：N 条大 payload 事件断言单页序列化字节 ≤ maxBytes、第一条恒带上、hasMore 正确、条数界不回归；「该页经 encodeTopicWireFrames 不抛 frameAssemblyTooLarge」；typecheck 全绿（含三处贯穿点）。
- 来源：review-scope-b / r1；r2 补承载形状与贯穿点

### b/A-3 [P1] #25「附件预览放行 text/plain」在 fork 不可达（已拍板：补齐；scl-r1 扩为「两闸+字段链」）
- 维度：A（#25 前半未交付）+ B（不可达契约/死分支 + **数据链断链**）
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:2204-2207`（isPreviewable）、`:2307-2314`（resultMime 闸）；已放宽处 `transport.ts:1081-1110`；**UI 生产端（scl-r2 补，断链真源头）**：`packages/ui/src/v4/composer/attachmentUpload.ts:53-59,73-79`、`packages/ui/src/v4/composer/useComposerAttachments.ts:357-368`（+restore 路径）；**字段链（scl-r1 补）**：`packages/shared/src/zcode-protocol-v4/attachment-ref.ts:4-14`、`rows.ts:138-148`、`event-normalizer.ts:98-104`、`projection-rows.ts:80-87`、`v4-bridge.ts:279-299`；可选 `commands/attachment-refs.ts`（displayMetaOf）
- 问题：本批只放宽响应 schema，生产者两处更早的闸未动 → 放宽在 fork 无任何可达路径。**且改法引用的 `attachment.sourceKind` 在 fork 从 wire 类型到 v4 行投影全链不存在**：`AttachmentRef`（strict）无该字段 → 照抄 `attachment.sourceKind === "clipboard-text"` 即 TS2339 编译失败；即使强转绕过，行 schema/投影/hydration 均不携带 → 运行期谓词恒 false，修复仍不可达、谓词级验收假绿。sourceKind 仅存在于 UI 上传载荷（`ui/src/lib/chatAttachments.ts:122/248`）与会话附件记录（`contracts session.port.ts:327`、`shared zcode-task-types-core.ts:197`），到 v4 行投影即断链。上游有完整链（`.reference` attachment-ref.ts:11 `sourceKind` 可选 + 独立词汇文件 attachment-source.ts + rows.ts:158 行附件复用 attachmentRefSchema）。
- 改法（**「UI 生产端 + 字段链 + 两闸」，对齐上游**；scl-r1 依用户「#25 补齐」拍板裁定扩链，scl-r2 修正断链真源头=UI 生产端）：
  1. **UI 生产端（承重一跳，上游对照 `.reference` attachmentUpload.ts:48-51 / useComposerAttachments.ts:367-368、:1014-1015）**：① `packages/ui/src/v4/composer/attachmentUpload.ts:53-59`（localPath 分支）与 `:73-79`（put 分支）两个 return 前先 `const source = attachment.kind === "file" && attachment.sourceKind === "clipboard-text" ? { sourceKind: "clipboard-text" as const } : {}`（**必须带 `kind === "file"` 收窄——`ZCodePromptAttachment` 是 5 支联合，仅 File 支有 sourceKind，直接访问 TS2339**），再 `...source`；② `packages/ui/src/v4/composer/useComposerAttachments.ts:357-368`（远端 staged 分支）、restore 路径同改（restore 若引上游双值枚举需按 `=== "clipboard-text"` 收窄后再赋给 `ChatComposerAttachmentSourceKind`）；③ **零拷贝预置 ref**（`useComposerAttachments.ts:652-661`，桌面长粘贴最常用路径，不经过 uploadComposerAttachment）：预置 `attachmentRef = {ref: localPath, ...}` 处补同一 `...source` 传播（**上游超集**——上游该路径同样不带，但不补则修复在最常用桌面路径仍不可达，违背「补齐」拍板本意；登记 spec_deviations）。**上行必须携带**——行投影的 sourceKind 唯一数据源就是 wire payload（投影无其它来源可「补齐」）。
  2. **字段链（中段+读段）**：③ `attachmentRefSchema` 补 `sourceKind` 可选字段（对齐上游 :11；词汇按上游 `packages/shared/src/attachment-source.ts` 引入或内联，`clipboard-text` 等枚举）；④ `rows.ts:138-148` 行附件 schema 补 `sourceKind`（上游 rows.ts:158 复用 attachmentRefSchema，可同法）；⑤ `CanonicalTurnAttachment` 加 `sourceKind?`；⑥ `projection-rows.ts:80-87` 第一分支透传 wire 原对象的 `sourceKind`（event-normalizer.ts:353-354 已 `{...attachment}` 透传，无需改）；⑦ `v4-bridge.ts:279-299`（edit/retry 再 admission 的二次映射）同节点一并透传。**transcript-hydration 无改动落点**：冷路径 `:273-302` 的 `conversationInputIntent.attachmentRefs`（:300）自动继承 wire 值，仅需验收覆盖，勿改 `:422-438`（该函数无 sourceKind 来源，按字面改是无效改动）。**可选一致性**：CLI `commands/attachment-refs.ts` 的 `displayMetaOf` 补 sourceKind（上游 :26-31），使 clipboard-text「只留路径引用」语义在 v4 路径同样成立。
  3. **两闸**：isPreviewable 加 `mime === "text/plain" && attachment.sourceKind === "clipboard-text"`（fork 无 topic-history）；resultMime 闸加「请求 mime 与结果 mime 都是 text/plain 时对等豁免」（上游对照 `v4-gateway.ts:2211-2222,2321-2332`）。**可测 seam**：把 isPreviewable 判定抽为模块内可导出纯谓词 `isReadablePreviewAttachment(attachment)`。
- 验收（**数据链可达级，禁止只测谓词/禁止手工构造投影行**）：新增 `bootstrap/scripts/test-attachment-preview-text-plain.mjs`，**运行口径 `tsx --tsconfig ../ui/tsconfig.json --test`（judge 实测可行——UI 序列化模块 import `@/lib/*` 别名只在 packages/ui/tsconfig.json:12-13 声明，根无 tsconfig，裸 node --test/tsx 均 ERR_MODULE_NOT_FOUND；bootstrap package.json 条目按此写）**：①**经真实链路驱动**（UI 序列化→命令 payload→投影，覆盖 serialize+upload 与 staged 两路径；零拷贝预置 ref 路径由 ③ 的单元传播断言覆盖）：clipboard-text + text/plain → 可预览分支命中；非 clipboard-text 的 text/plain → false；image/png → true；②resultMime 对等豁免两态；③transport 负例（非 text/plain 仍拒）+ 零拷贝预置 ref 传播断言；④**双向自检：不落 UI 生产端字段时 ① 必须红**（防假绿）；⑤transcript 冷路径带 sourceKind 的投影行断言。接线 test:v4-perf + 登记 + **新脚本逐条进 knip ignore/entry（先例 knip.json:45-48）**。（注：本条新增 UI 域文件触碰=纯字段透传，无 UI 行为/i18n 变更。）
- 来源：review-scope-b / r1 CR；r2 补 seam；scl-r1 P0-1 扩链；scl-r2 修正生产端断链+hydration 口径

### b/G-1 [P1] 存储层下推与双实现同语义零自动化证据；engine 接线与 resume 全量读收窄（含 d/G-1、d/G-4、拍板项 Open#2）
- 维度：G（附 B）
- 文件：`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal-reads.ts`（新 222 行，无测试引用）；`dynamic-workflow/src/engine/journal-memory.ts:33-51,143-239`；`engine.ts:352-355`；现有 `bootstrap/scripts/test-dwf-read-narrowing.mjs` 全用替身
- 问题：①本批最险的 SQL（前缀和窗口定页/json_remove 分界/group by 计数）与内存侧等价性、存储层真的下推，均无自动化证据；替身自己按 limit 返回 → 实现回归测试仍全绿。②T-DWF-1 不覆盖 `engine.ts:355` 接线（删该行测试仍绿）。③（拍板项）engine resume 仍全量 `listNodes` 解每条 report item，上游已改 `readReplayRows`（workRows 不带结果 + artifactRows 带结果）+ `countNodes`。
- 改法（r2 钉死执行细节）：
  1. **落点钉 `bootstrap/scripts/test-dwf-journal-contract.mjs`**（理由：@zcode/dynamic-workflow 无 @zcode/adapters 依赖；根 test:v4-perf 首组 tsx --test 早于 bootstrap build，sqlite import 会缺 dist——**必须排在构建步骤之后**，与 test-dwf-read-narrowing 同区）。
  2. 契约测试：同场景分别喂 `InMemoryJournalStore` 与 sqlite 实现，断言两侧 deepEqual——kinds/withResult/limit/maxResultBytes（含 limit=0、单条超界「第一条恒带上」、maxResultBytes=0）、listEvents 的 types/reportItems（含 limit=0、排名不受 types/cursor/limit 影响）、countNodes/countTaggedReports；**sqlite 侧走公开路径：`openStartupSqliteSessionStore({ dbPath: ":memory:" })`（构造期即跑迁移，sqlite-session-store.ts:240）→ `.workflowJournalStore()`（:975-978；bootstrap 已有同款探测先例 `dynamic-workflow-run-journal.ts:43-55`）——勿用 `runSqliteSessionMigrations`（仅模块级 export，未进 @zcode/adapters 公开面/dist，按公开入口 import 会失败）与 `createDwfJournalStore(":memory:")`（形参是 DatabaseSync 非路径）；node:sqlite 需 Node 24 口径运行**。
  3. engine 级 resume 断言：seed 生效 / 删 `engine.ts:355` 后 FAIL。
  4. **（Open#2 升格）engine resume 收窄**：按上游 `engine-resume.ts:17-44`、`replay-order.ts:46-47` 形态改 `engine.ts:352` 一带——`readReplayRows`（workRows 不带结果 + artifactRows 带结果）+ `countNodes` 取代全量 listNodes 解码；**workRows 须按上游 `REPLAY_WORK_KINDS`（上游 replay-order.ts:21-27，从 NODE_KINDS 派生、排除 report/artifact）实现——fork 无 NODE_KINDS 运行时常量（仅 types.ts:428 类型联合），按该联合派生或直接写 `["ask","world-read","world-run"]` 字面量**；**`countNodes` 是可选端口成员（types.ts:948-951），缺席时按 FORK 惯例探测：保留一次窄读兜底（`{kinds:["report"], withResult:false}`），不得回落全量带结果读**（与 observation.ts:310-312「缺席即省略」语义对齐）；删旧路径即红。
- 验收：脚本实跑 pass + 接线登记；注释掉 limit 分支跑该脚本必须 FAIL（反假绿自检）；**并入 b/A-2 的字节页断言面**（单页 ≤maxBytes、第一条恒带上、hasMore、encodeTopicWireFrames 不抛——避免两套 scaffolding）。
- 来源：review-scope-b + review-scope-d / r1；r2 补落点/migration/顺序 + 吸收拍板项

### c/B-1 [P1] legacy 只读守卫在「升级成功」后未撤销，订阅被永久降级（已拍板：修）
- 维度：B（正确性/时序）
- 文件：`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:1283`（add）、`:1312-1342`（upgrade 成功分支）、`:3164`（守卫）
- 问题：`readLegacyTaskSnapshot` 任何读取成功都登记 `legacySnapshotTaskKeys`；`resumeSnapshotOrLegacy` 在 migrationSource=claudeCode 时升级为真 session 成功后 Set 不撤销 → 同进程内 `onDynamicTaskEvent` 对该 task 永久 local-only、不挂协议订阅，无自愈。影响面=bot 频道镜像（fork 默认关）与未来消费方。
- 改法（单一方案，r2 已核改法完整——`readLegacyTaskSnapshot` 仅 `resumeSnapshotOrLegacy`（:1308）一个调用点）：`legacySnapshotTaskKeys.add(taskKey(params))` 从 `readLegacyTaskSnapshot`（:1283）移除，改在 `resumeSnapshotOrLegacy` 的 `return { kind: "legacy", snapshot: legacySnapshot };`（:1356 附近）之前登记。
- 验收（scl-r2 钉落点）：**在 `packages/services/test/zcodeTaskServiceAdapterStreamFallback.test.ts` 内新增用例**（harness 已有 onDynamicSessionEvent/syncTaskMeta；`resumeSession` 抛 Session not found 与 `createSession` 成功的替身先例见 `importedClaudeRecovery.test.ts:59-102`，按需补齐）。断言：claudeCode legacy + createSession 成功 → `onDynamicTaskEvent` 协议订阅面被挂上（行为级，非内部 Set）；负例（非 claudeCode legacy）仍 local-only。该文件已在根 test:v4-perf 接线内，无新增接线；登记表补一行。
- 来源：review-scope-c / r1

### P2 清单（13 条）

#### a/G-1（=d/B-1） [P2] T-PROC-2 堆上界余量不足
- 文件：`packages/services/test/zcodeStdioTransportFraming.test.ts:35`
- 改法：`PEAK_HEAP_GROWTH_LIMIT_BYTES` 收紧至 **64MiB**（新实现实测 18.2MiB，余量 3.5x；旧 O(n²) 实测远超）。失败信息打印新旧对照值，以实跑打印为准（勿引固定括注数值——scope-a 探针 171.8MiB 与既有注释 ≈161MiB 口径不同，仅作参考）。
- 验收：重跑该文件 pass。来源：review-scope-a / r1

#### a/C-1（=d/C-2） [P2] T-PROC-3 用例名与断言矛盾
- 文件：`packages/services/test/zcodeAgentProcessManagerCleanup.test.ts:102`
- 改法：改名「reportError 非 false 时仅记日志、rejection 仍交给调用方（未变更行为 characterization）」，注释点明生产两调用点均传 `reportError:false`（zcodeAgentProcessManager.ts:761/777）。
- 验收：同名文件 3/3 pass。来源：review-scope-a / r1

#### d/G-2 [P2] 深链 `--` 终止符无单测钉子（含 fuses config 断言）
- 文件：`packages/desktop/src/main/desktopDeepLinkRouter.ts:228-258`
- 改法：新增 `packages/desktop/scripts/test-deep-link-terminator.mjs`，仿 `test-window-close-tray.mjs` electron-stub 范式：替身捕获 `app.setAsDefaultProtocolClient` 实参，win32 两态断言 args 末位 `--`；非 win32 断言用 `Object.defineProperty(process, "platform", ...)` 可恢复覆写驱动（或仅在非 win32 平台执行该断言、win32 跳过——`registerDeepLinkProtocol` 直读 process.platform/:232-234、:252-255，无注入 seam）。同脚本加 `electron-builder.config.js` 的 `electronFuses.enableNodeCliInspectArguments===false`（win32 分支 :471-472）纯配置断言。接线 test:v4-perf。
- 验收：去掉 `"--"` 后用例 FAIL。来源：review-scope-d + c open_q4 / r1

#### full/G-1 [P2] T-WIN-3 未覆盖 spec 口径「fake tray 抛错」；托盘失败→fail-closed 的唯一接线无钉子
- 文件：`packages/desktop/scripts/test-window-close-tray.mjs:86-132`；`packages/desktop/src/main/index.ts:1293`（`desktopTrayReady = createWindowsDesktopTray({...}) !== null`）
- 问题：spec §4 T-WIN-3 明文「fake tray 抛错」，实际只把 `desktopTrayReady` 当外部布尔注入裁决函数；`index.ts:1293` 映射行改成 `=== null` 现有 5 用例仍全绿。
- 改法：既有 electron-stub 范式下加载 `../src/main/desktopTray.js`（源文件为 `packages/desktop/src/main/desktopTray.ts`；`.js` 说明符=构建产物 import 口径，与 test-window-close-tray.mjs 同法），令替身 `Tray` 构造函数 throw，断言 `createWindowsDesktopTray(...)` 返回 `null`（desktopTrayReady=false 的来源契约）；加一态断言正常构造返回非 null（正常态替身需补 `Tray#on/setToolTip/setContextMenu` 与 `Menu.buildFromTemplate`；`desktopTray.js` 有模块级缓存，throw 态与正常态须各自新模块实例或先 throw 后正常调序，否则 throw 态命中 :31-33 早退守卫；非 win32 平台该正常态断言需注入 platform 或跳过）。
- 验收（r4 修正判据）：**有判别力的变异**=删掉 try/catch 令异常外扬（断言 `createWindowsDesktopTray` throws，用例 FAIL），或把 catch 改为返回非 null 假值（结果非 null → 「期望 null」的断言失败变红）——原「`return null`→`return desktopTray`」变异在 throw 路径下仍返回 null、无判别力，勿用。**边界声明**：`index.ts:1293` 的 `!== null` 映射行不在本用例覆盖内（反写依旧全绿）；如需钉住该映射，由 T-WIN-2 打包态手工验证承担（合并后 QA 已列）。来源：review-full / r2；r4 修正验收判据

#### d/G-3 [P2] 行为翻转的唯一钉子不在任何门禁
- 文件：`packages/services/test/nonCliAcpRetirement.test.ts`、`package.json:32`
- 改法：`nonCliAcpRetirement.test.ts`（连同 `importedClaudeRecovery.test.ts`）加入根 `test:v4-perf` 首个 tsx --test 组。
- 验收：test:v4-perf 总数相应增加且全绿；登记表更新。来源：review-scope-d / r1

#### d/C-1 [P2] 测试以 .ts 扩展名 import
- 文件：`packages/services/test/runtimeProcessEnvShell.test.ts:7`
- 改法：`../src/runtime-tools/runtimeCommandEnv.ts` → `.js`。
- 验收：typecheck + 该文件 pass。来源：review-scope-d / r1

#### c/C-1 [P2] legacy 快照读取用同步 IO 违反仓库规范
- 文件：`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3,1242`
- 改法：`readFileSync` → `fs/promises.readFile`（await），保留 existsSync 探测；与 `importedClaudeHistoryRepair.ts:108` 同法。**与 c/B-1 同文件，须同节点串行。**
- 验收：typecheck + nonCliAcpRetirement/importedClaudeRecovery 保持通过。来源：review-scope-c / r1

#### c/C-2 [P2] 新文件注释悬空引用
- 文件：`packages/shared/src/zcode-session-content-profile.ts:6`
- 改法：`docs/task/task-sqlite-index.md` 引用改为 `docs/iterations/upstream-v3.15.1-bugfix-backport/spec.md §2.1 #20` 或删除括注。
- 验收：人工核对。来源：review-scope-c / r1

#### d/K-1 [P2] UPSTREAM-SYNC.md 基线表未随 Step1 更新
- 文件：`UPSTREAM-SYNC.md:11,15,97`
- 改法：基线表更新为 `v3.15.1 @ aac47556`；位置表述按实际（`<repo>/.reference/`）；lint 基线注记 74w/0e 口径。
- 验收：与 `git -C .reference/ZCode log -1` 实测一致。来源：review-scope-d / r1

#### d/K-2 [P2] 登记表套件名不存在
- 文件：`docs/iterations/upstream-v3.15.1-bugfix-backport/cache/test-wiring-map.md:45`
- 改法：`test:magic-context-prompt-section` → `test:magic-context-section`（core/package.json:38）。**必须在 test-wiring-map 增补（b/A-1、b/A-2、b/A-3、b/G-1、d/G-2、d/G-3 的新脚本登记）完成之后执行，否则会被覆盖。**
- 来源：review-scope-d / r1；r2 补顺序

#### d/K-3 [P2] CHANGELOG「全部」与登记残余矛盾
- 文件：`CHANGELOG.md:13`
- 改法：删「全部」或改「主要读取路径」。来源：review-scope-d / r1

#### d/K-4 [P2] CHANGELOG 维护段内部术语
- 文件：`CHANGELOG.md:18`
- 改法：改写为「同步保持 fork 既有边界（品牌、上下文记忆集成等）不回退」。来源：review-scope-d / r1

#### d/A-1 [P2] iteration-state 门禁记录与 spec §5 十二条对不上
- 文件：`docs/.iteration-state.yaml:521,529` vs spec.md §5（12 条）
- 改法：按 §5 编号逐条回填。**r2 更正：architecture:check / @zcode/cli build / check-i18n-parity 的实跑证据未在本机日志找到——执行者必须现场核实或补跑后回填，不得凭记忆补记**；若有门禁从未实跑，本条升级 P1。
- 验收：逐条编号可对照 + 实跑证据（命令输出或日志）。来源：review-scope-d / r1；r2 更正证据口径

## Spec deviations

- **fixed（用户已拍板，round 1）**：spec §2.1 #25 范围漏列 v4-gateway 两处 hunk 与「分页 maxBytes」下推链——**拍板=补齐**（b/A-2 全链 + b/A-3 两闸），修复范围以本 fix-spec 为准；spec §2.1 #25 行下游执行时同步补注。
- fixed/acceptable（不阻塞，留痕）：① 上游 export 化符号去 export（knip 门禁，FORK 注释齐，测试不依赖；b/A-2 涉及的 WORKFLOW_RUN_EVENTS_PAGE_LIMITS 将按该条恢复 export）；② #12 join 改 joinSubagentSystemSectionContents（M3 裁定）；③ #10 注释 compact 字面改写；④ T-SVC-3 用 EISDIR 替代 EACCES；⑤ Step9 oxfmt 归一并入 Step10 commit；⑥ #34 自研判据 / #18 build 回退 / offPeakTaskId 不搬 / D3 旧裁定（被 b/A-2 取代）等已声明适配。

## Open questions（附录，未认定；不阻塞）

已收敛 8+1 条见前版；r2 补录 6 条遗漏：
- a-Q3：T-PROC-3 重试成功路径 / T-PROC-2 分帧边界（已推演等价）/ T-NET-2 proxy-204 端到端——覆盖增强，可选。
- a-Q4：瘦身只作用 sealed turn；无 turnId 的 model_request 不进该路径——设计边界，无压力证据。
- b-Q4：能力探测写法不统一（`countNodes?.()` vs `typeof countTaggedReports`）——风格，择机统一。
- c-Q1：resyncRollback 第二调用点无独立断言（与 fanOutDeltas 共用钳位函数）——边际风险低。
- c-Q3：T-SVC-1 sameMessage / 短 response 兜底分支未单测——上游同款语义。
- d-Q3：T-PROC-1/3 以 20ms setTimeout 等判定——CI 高负载可改 setImmediate。
其余既有：①CHANGELOG 补 #25 条目（b/A-3 落地后顺手补，#23 不补）；②introspection listActors 双读并入 introspection:224 backlog；③knip ignore→entry 择机改；④`.reference/`、`.tools/` 进 .gitignore（用户日后拍板）；⑤readPluginConfig SyntaxError 回退=spec 既定取舍；⑥#29 Windows 形态无效 SHELL 维持；⑦turn-tools.ts:58 死变量（基线遗留）；⑧apps/zcode-cli 域 lint 无门禁（流程决策）。

## 已豁免（用户确认不修）

（无——用户拍板 P2 全修）

## 合并后 QA（manual_user）

- T-WIN-2 打包态手工验证（fuses/深链注册表实机；e2e 已证 CLI 侧不涉，锚点在 desktop 宿主）。
- desktop 宿主链路的 #29 SHELL 修复实机验证（e2e-run 证实 CLI bundle 不含该代码路径——services 包属宿主域，T-WIN-1 单测为当前锚点）。

## K 节建议（下游执行时闭合）+ 执行编排（r2 建议，供 code-dev-loop 采用）

- **执行顺序**（scl-r1 修订：拆开 wave-2 同文件并行——**b/A-2 与 b/A-3 都改 `v4-gateway.ts`，禁并行子代理**）：wave-1 `[b/A-1 ∥ c(B-1→C-1 同节点串行) ∥ c/C-2 ∥ a/G-1 ∥ a/C-1 ∥ d/C-1 ∥ desktop 脚本节点（d/G-2 新建深链脚本 + full/G-1 托盘用例，两文件不同可同节点或并行；其 test:v4-perf 接线归 wave-4 单写者）]` → wave-2 `[b/A-2 单节点]` → wave-3 `[b/A-3（含字段链+两闸）∥ b/G-1（含 Open#2 收窄 + b/A-2 验收面）——b/A-3 的 shared 字段链文件与 b/G-1 的 engine/adapters 文件不相交，可并行]` → wave-4 `[wiring/docs 单写者节点：package.json/knip.json/test-wiring-map/iteration-state/CHANGELOG/UPSTREAM-SYNC/spec.md(#25 补注) + d/K-2 最后]` → 门禁。**b/A-2 节点完成的判定 = wave-3 契约脚本覆盖其全部断言面**（自身波次无可独立执行门禁，勿在 wave-2 宣称完成）。
- **单写者文件统一收口**：根 `package.json:32`、**`apps/zcode-cli/packages/bootstrap/package.json`（b/A-3 与 b/G-1 新脚本都要加 test:* 条目——两者 wave-3 并行，接线必须归末端单写者）**、**`apps/zcode-cli/packages/core/package.json`（b/A-1）**、knip.json、cache/test-wiring-map.md、docs/.iteration-state.yaml、CHANGELOG.md、UPSTREAM-SYNC.md、spec.md(#25 补注) 多条目触碰，由末端 wiring/docs 节点统一改，其余节点只产脚本与用例。
- c/B-1 与 c/C-1 同文件（zcodeTaskServiceAdapter.ts），禁并行子代理。
- d/A-1 门禁回填须实跑证据。e2e 沙箱清理：`.tools/e2e-home`、`.tools/e2e-ws`、`.tools/e2e-evidence`（取证已留档，确认后可删）。

## Fix-Spec Closure（spec-check-loop r3 后收口，用户下令执行）

| 项 | 状态 |
|---|---|
| fix-spec-ready | 执行中（r3 无 P0；1 P1+7 P2 已吸收；用户显式开工） |
| fix_spec_path | docs/iterations/upstream-v3.15.1-bugfix-backport/cr-fix-spec.md |
| dag_version / review_round | 8 / 7 |
| P0 / P1 / P2（本修条目） | 0 / 5 / 13（b/A-3 扩为「UI 生产端+字段链+两闸」，条目数不变） |
| 未写入的开放 must-fix | 0 |
| spec_deviations | 零拷贝预置 ref=上游超集（登记）；其余 fixed |
| C-orch | ✅（无 must-fix） |
| C 类合并后 QA | 已列（T-WIN-2 打包态、desktop 宿主 #29 实机；不阻塞） |
