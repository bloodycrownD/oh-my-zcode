# 证据包：cr-fix-spec.md sub / e2e 域（③ 子智能体停止 + ④ 同步派遣 sessionId + e2e 渲染）

- 包性质：spec-check-loop r1 evidence 取证代理产出；只取证、不下结论（无 Go/No-Go、无 P0/P1 定级）
- 审查对象：docs/iterations/bugfix-batch-20261009/cr-fix-spec.md
- 仓库：D:\Dev\Js\oh-my-zcode\omz；分支 dev/bugfix-batch-20261009
- **sha=5a35027**；轮次=spec-check r1
- 取证方式：只读（Read/findstr/git log）；未修改任何代码或 spec 文件

---

## 条目 1：sub/G-1（P1）runtimeOutputSchema 同一性断言

### spec 原文摘录（cr-fix-spec.md:51-56）

> #### sub/G-1 ④ schema 双改防线可绕过——runtimeOutputSchema 同一性无断言
> - 维度：B+G；来源：review-scope-subagent r1
> - 文件：`apps/zcode-cli/packages/core/scripts/test-subagent-sync-dispatch.mjs:170-178`（被测 `core/src/tool/handlers/agent.ts:269`）
> - 问题：测试只 safeParse contracts schema，未断言 handler 的 `runtimeOutputSchema` 与契约同一对象——换成不含 childSessionId 的本地副本时三条断言仍全绿而运行时校验当场失效。
> - 改法：T-D1b 增 `assert.equal(agentToolEntry.runtimeOutputSchema, AgentOutputSchema)`；对 `taskToolEntry.runtimeOutputSchema` 断言同一引用（锁住 Task 别名浅拷贝与未来 entry 拆分）。
> - 验收：5+1 例全绿；变异验证（临时换本地 schema 必须红）。

### 代码事实

| # | 事实 | 文件:行 |
|---|---|---|
| F1.1 | `agentToolEntry` 定义 :251-307；`runtimeOutputSchema: AgentOutputSchema` 恰在 **:269**（spec 行号准确；字段在 entry 上真实存在） | core/src/tool/handlers/agent.ts:251,269 |
| F1.2 | `taskToolEntry` = `{...agentToolEntry, capability, metadata:{...}}` **浅拷贝**（未触碰 runtimeOutputSchema），与 agentToolEntry.runtimeOutputSchema 是同一对象引用 | core/src/tool/handlers/agent.ts:314-327 |
| F1.3 | 测试脚本 import 形态：`const { agentToolEntry } = await import(new URL("../src/tool/handlers/agent.ts", import.meta.url).href)`——**已 import agentToolEntry，未 import taskToolEntry**；tsx 直吃 TS 源码（:41-43 注释：必须 tsx，裸 node 不行），契约侧从 `../../contracts/src/tools/../index.ts` 直取源码（:58-61） | core/scripts/test-subagent-sync-dispatch.mjs:41-43,52-64 |
| F1.4 | T-D1b 现有三条断言：:170-171 `AgentOutputSchema.safeParse(output)` 通过（contracts schema）；:174-176 删 childSessionId 后必须失败；:177-178 **注释写「handler 的 runtimeOutputSchema 与契约同一个 schema 对象，行为必须一致」，其下断言实为 `harness.registry.get(AGENT_ID)?.status === "completed"`**——注释与断言名实不符，正是 spec 所指缺口 | 同文件:164-182（spec 引 :170-178 为 T-D1b 断言体，准确） |
| F1.5 | 运行时闸门真实存在：`validateOutput` → `validateRuntimeSchema(output, entry.runtimeOutputSchema)`（safeParse，失败即 ToolExecutionFailed）；另 `stringifyOutputForModel` 在 result-serialization.ts:361 调 entry.formatModelContent——「运行时校验当场失效」的失效链有真实消费点 | core/src/tool/executor/validation.ts:9-10,42-47；result-serialization.ts:360-361 |
| F1.6 | **生产注册路径不走静态 entry**：index.ts:303-316 按 `entry.metadata.name === "Agent"/"Task"` 分别返回 `createAgentToolEntry(...)` / `createTaskToolEntry(...)`；createTaskToolEntry → `createTaskToolEntryFromAgent(createAgentToolEntry(options))`，两层 spread 后 runtimeOutputSchema 仍同一引用，但**静态 taskToolEntry 的断言覆盖不到工厂产出的注册形状** | core/src/tool/handlers/index.ts:303-316；agent.ts:329-344,346-372 |
| F1.7 | 现有用例数：脚本共 5 个 test（T-D1a :143 / T-D1b :164 / T-D1c :184 / T-S1a :236 / T-S1b :281） | 同文件 |
| F1.8 | 全仓测试侧对 agentToolEntry/taskToolEntry 的引用仅此脚本一处（:62 import、:196、:200 使用）；formatAgentOutputForModel 非独立导出，无他测 | core/scripts/test-subagent-sync-dispatch.mjs:62,196,200 |

### 可疑点清单（sub/G-1）

| 编号 | 可疑点 | 事实/文件:行 |
|---|---|---|
| S-G-1 | **验收「5+1 例」与改法矛盾**：改法文字是「T-D1b 增 assert.equal(...)」——往既有 test 内加断言，用例数仍是 5；「5+1」暗示新增一个 test()。二者只则其一 | 改法 vs 验收；现有 5 例（.mjs:143/164/184/236/281） |
| S-G-2 | 静态 taskToolEntry 断言 ≠ 生产注册形状；「锁住未来 entry 拆分」只覆盖静态底料，不覆盖工厂（createAgentToolEntry/createTaskToolEntry 的 spread 链无断言） | index.ts:303-316；agent.ts:329-372 |
| S-G-3 | 测试脚本需扩展 import（:62-64 只解构了 agentToolEntry，追加 taskToolEntry 才可执行 spec 断言）——小事，但 spec 改法未提及 import 改动 | test-subagent-sync-dispatch.mjs:62-64 |
| S-G-4 | 变异验证可行性结论：**可行**——把 agent.ts:269 临时换成本地 schema 对象，`assert.equal(agentToolEntry.runtimeOutputSchema, AgentOutputSchema)` 立即不等即红；变异是单行单点、易回滚 | agent.ts:269 |

---

## 条目 2：sub/C-orch-1（P2，含 N-2）重复 childSessionId 回退语义

### spec 原文摘录（cr-fix-spec.md:98-102）

> #### sub/C-orch-1 ③ 重复 childSessionId 下回退语义与注释不一致
> - 维度：C-orch；来源：review-scope-subagent r1
> - 文件：`packages/ui/src/v4/conversationStatusPanelModel.ts:324-353`
> - 改法（r1 并入 N-2）：选 (b) 明确契约：map 重复置 null 语义保留，注释改为「重复身份仍回退 agentId——回退目标是任务自身 id，非按标题/时间猜测，无误停风险」；同时 ambiguous 回退路径（:348-352 硬编码 `cancellable: true`）改为尊从上游 cancellable（与非重复路径 :354-358 `controlWork.cancellable !== false` 对称），上游 cancellable=false 不被抹成可停。
> - 验收：T-S2 补「两条 work 同 childSessionId → 仍回退 agentId 且 cancellable 尊从上游（cancellable=false 用例断言不可停）」；5+1 例全绿。

### 代码事实（行号逐条核对）

| # | spec 声称 | 实测 | 文件:行 |
|---|---|---|---|
| F2.1 | map 构建 :327-331，:330 重复置 null | `const existing = get(work.childSessionId); set(work.childSessionId, existing === undefined ? work : null)`——首次存 work，**第二次起一律 null，连第一个 work 对象也整体丢弃**；map 值类型 `BackgroundWorkSummary \| null`（:307） | conversationStatusPanelModel.ts:307,327-331 |
| F2.2 | :338 `!controlWork` | `const controlWork = get(subagent.childSessionId); if (!controlWork) {`——**null（重复身份）与 undefined（未命中/前台派遣）合流同一分支，代码上无法区分两种情形** | 同文件:337-338 |
| F2.3 | :348-352 硬编码 cancellable:true | 回退分支 `{...subagent, controlWorkId: fallbackAgentId, cancellable: true}`（前置条件 :346-347：agentId undefined 或 status==="waiting" 则原样返回不给控制） | 同文件:346-352 |
| F2.4 | :354-358 非重复路径 cancellable!==false | 命中分支 `{...subagent, controlWorkId: controlWork.workId, cancellable: controlWork.cancellable !== false}` | 同文件:354-358 |
| F2.5 | 文件行域 :324-353 | 实际相关区块为 :323-359（map 构建 :323-332、投影 :334-359）；spec 改法自称的 :354-358 **落在所引文件行域 :324-353 之外**（header 行域偏窄，不影响正文定位） | 同文件 |

### 改法可行性关键取证（数据流）

| # | 事实 | 文件:行 |
|---|---|---|
| F2.6 | **`RunningSubagentSummary` 没有 cancellable 字段**（字段全集：childSessionId/agentId/toolCallId/subagentType/title/summary/status/startedAt）——投影行自身不携带任何可停信息，:348-352 的 `...subagent` spread 翻不出上游 cancellable | packages/shared/src/zcode-protocol-v4/snapshot.ts:433-442 |
| F2.7 | 唯一上游 cancellable 来源是 `BackgroundWorkSummary.cancellable: z.boolean().optional()`（注意 optional——缺省 ≠ false，语义是「未声明」） | snapshot.ts:411-428（cancellable 在 :424） |
| F2.8 | 重复组的 cancellable 信息在 :330 被**整体丢弃**（map 只留 null 哨兵） | conversationStatusPanelModel.ts:330 |
| F2.9 | null 哨兵共 **3 处消费**：:338（投影回退分支）、:364（:363-377 权威 work 补齐循环 `if (!controlWork \|\| ...) continue;`）、:327-331（构建）。任何「保留重复组信息」的改法（副表 / 富哨兵）都必须同步适配三处 | 同文件:327-331,338,363-364 |
| F2.10 | 模型输出行类型 `cancellable?: boolean`（optional，非 boolean）——「不可停」的规范表达是 false 或 undefined，与 UI 判据 `!== false` 配合 | conversationStatusPanelModel.ts:44-47 |
| F2.11 | UI 真实消费：停止按钮渲染条件 `subagent.controlWorkId && subagent.cancellable !== false`——cancellable=false ⇔ 按钮消失，验收断言与产品语义对齐 | ConversationStatusPanel.tsx:1436 |

**数据流结论（事实层面）**：在不改 map 构建处的前提下，:348-352 处手上只有 `subagent`（无 cancellable，F2.6）和 `null`（F2.8 已丢信息）——「ambiguous 路径尊从上游 cancellable」**不可能**只靠改 :348-352 一行达成，必须同时在 map 构建处保留重复组信息（如副表存 `BackgroundWorkSummary[]` 或把 null 换成携带 cancellable 的结构），并适配 F2.9 的三处消费点。spec 改法文字只点了 :348-352 与注释，未提 map 构建处改造——这是改法可落地性的核心疑点。

### 验收可测性

| # | 事实 | 文件:行 |
|---|---|---|
| F2.12 | T-S2 文件 `packages/ui/test/conversationStatusPanelControlWorkFallback.test.ts`，现有 **5 个用例**（:62 / :73 / :80 / :99 / :106）——「5+1」口径与改法（新增一条 test）自洽 | 该测试文件 |
| F2.13 | harness 可直接构造重复组：`build(runningSubagents, backgroundWorks)`（:55-60）+ `work()` 工厂支持 overrides（:86-97），喂两条同 childSessionId 的 work 零基建成本；文件经 registerHooks 兜底 `@/` 别名（:10-35）、直 import `../src/v4/conversationStatusPanelModel.js`（:37-38，tsx 解析 .ts）；根 package.json:32 `test:v4-perf` 清单已含该文件 | 测试文件 + package.json:32 |
| F2.14 | 既有 :99-104 用例已锁「单条 work cancellable:false → 命中路径 cancellable=false」；新验收用例（两条 work 同 childSessionId + cancellable=false）在**当前代码上必红**（当前 :348-352 恒 true）——spec 未明说 test-first「先红后绿」顺序，也未要求变异验证 | 测试文件:99-104；模型:348-352 |

### 可疑点清单（sub/C-orch-1 + N-2）

| 编号 | 可疑点 | 事实/文件:行 |
|---|---|---|
| S-C-1 | **改法与数据流不匹配（关键）**：「ambiguous 尊从上游 cancellable」只改 :348-352 不可行——该处拿不到上游 cancellable（RunningSubagentSummary 无此字段、map 重复组信息已在 :330 丢弃）；必须同步改 map 构建处并适配 :338/:364 两处 null 消费。spec 改法段落完全未提 map 构建改造 | snapshot.ts:433-442；conversationStatusPanelModel.ts:330,338,363-364 |
| S-C-2 | **聚合语义未定义**：两条重复 work 的 cancellable 不一致时（如一条 false、一条 undefined/true）听谁的？现有代码对任何重复一律 null，不区分是否一致；验收只给了「cancellable=false 用例」未说是否两条都 false。保守规则（任一 false → false）需 spec 明示，否则两个实现者会产出两种行为 | conversationStatusPanelModel.ts:330；spec 验收行 |
| S-C-3 | **自洽性疑点**：选(b)前半保留「map 重复置 null 语义」与后半「ambiguous 也尊从上游 cancellable」并存时，(b)同时要求改注释——spec 给的注释文案（「回退目标是任务自身 id……无误停风险」）没有覆盖「cancellable 不一致听谁的」与「为何此时可信上游」；若注释只按 spec 文案落地而代码保留 null 简化语义，注释与代码存在再次打架风险。另 :339-345 既有注释解释的是 undefined（前台派遣）情形，ambiguous（null）合流进同一分支后注释与路径的对应关系变模糊 | spec 改法行 vs conversationStatusPanelModel.ts:324-326,337-345 |
| S-C-4 | header 文件行域 :324-353 窄于实际改区（:323-359，含 spec 自己引的 :354-358）——纯行域标注瑕疵，不影响定位 | 模型:323-359 |

---

## 条目 3：e2e/R-1（P2）异步派遣渲染补 sessionId 行

### spec 原文摘录（cr-fix-spec.md:129-133）

> #### e2e/R-1 ④ 异步派遣渲染补 sessionId 行（e2e 实测发现）
> - 维度：B；来源：e2e 实机（模型自述「工具结果里未单独列出 sessionId 字段」）
> - 文件：`core/src/tool/handlers/agent.ts` formatAgentOutputForModel 异步渲染分支（:180-198；同步 sessionId 行在 :175 —— r1 行号校正）
> - 改法：异步分支渲染与同步分支对齐补 `sessionId: <childSessionId>` 行；T-D1 补断言（format 输出含 sessionId）。
> - 验收：T-D1 增例绿。

### 代码事实（r1 行号复核）

| # | spec 声称 | 实测 | 文件:行 |
|---|---|---|---|
| F3.1 | 同步 sessionId 行 :175 | `formatAgentOutputForModel` 定义在 **:154**（spec 未给函数行）；同步分支 :161-178；`sessionId: ${data.childSessionId}` 恰在 **:175**（agentId 行 :174 之后、usage :176 之前）——**准确** | core/src/tool/handlers/agent.ts:154,161-178 |
| F3.2 | 异步分支 :180-198 | launchLines :180-184；canReadOutputFile 分支 return :187-193；兜底 return :195-198——整个异步区块确为 **:180-198**，且**无 sessionId 行**，缺口坐实 | agent.ts:180-198 |
| F3.3 | 变量可用性 | 异步分支 `data` 已窄化为 AgentBackgroundedOutput（:186 用 data.canReadOutputFile、:190 用 data.outputFile 佐证）；`childSessionId: string` 是该类型**必填**字段 → `data.childSessionId` 可直接取，无空值分支 | contracts/src/tools/agent.ts:64-75（接口 :71）、:104-117（schema :112）、union :119-122 |
| F3.4 | 契约意图同向 | contracts :50-55 注释明写「同步派遣与异步派遣（AgentBackgroundedOutput.childSessionId）**必须一致透出**……过去同步分支漏该字段导致形状不对称」——本次修复方向与契约注释一致 | contracts/src/tools/agent.ts:50-55 |
| F3.5 | 生产可达性 | `stringifyOutputForModel(output, entry)` 对任意 tool output 调 `entry.formatModelContent(output)`——异步 launch 结果确实经 formatAgentOutputForModel 渲染，「模型看不到 sessionId」链条成立 | core/src/tool/executor/result-serialization.ts:360-361 |
| F3.6 | T-D1 测试落点 | T-D1c（:184-213）已测同步分支渲染（:196-198 `assert.match(modelText, /sessionId: <CHILD_SESSION_ID>/)`），并断言 outputSchema 两分支都声明 childSessionId（:200-212）；异步断言可放 T-D1c——构造 async_launched 输出需 isAsync/backgroundTaskId/outputFile/canReadOutputFile 全字段（schema strict，缺一即 safeParse 失败走 stringify 兜底，断言会拿不到格式文本） | test-subagent-sync-dispatch.mjs:184-213；contracts/src/tools/agent.ts:104-117 |

### 可疑点清单（e2e/R-1）

| 编号 | 可疑点 | 事实/文件:行 |
|---|---|---|
| S-E-1 | **补行落点未指明**：异步分支有 2 个 return（:187-193 canReadOutputFile 路、:195-198 兜底路）。sessionId 行加进 launchLines（:180-184）一次覆盖两路；若加在单个 return 会漏另一路。spec 只说「补行」未给落点——建议 spec 补一句「加在 launchLines」 | agent.ts:180-184,187-193,195-198 |
| S-E-2 | 验收口径含糊：「T-D1 增例绿」未说是否新增 test()。仍加进 T-D1c（现有 test）则该文件维持 5 例；若按「增例」新开 test 则为 6 例。与 sub/G-1 的 S-G-1 同类口径问题 | test-subagent-sync-dispatch.mjs:184-213 |
| S-E-3 | 条目间冲突核查（结论为无冲突）：e2e/R-1 改 agent.ts :180-184 渲染、sub/G-1 断言 agent.ts:269 schema 身份 + 改测试 T-D1b——不同代码区域、不同用例，互不冲突；两者同改 test-subagent-sync-dispatch.mjs（T-D1c vs T-D1b）也属同文件不同段。K 节 commit 建议已把「④测试防线+渲染」归同一 commit 域 | agent.ts:180-198,269；cr-fix-spec.md:171 |

---

## 跨条目汇总

| 条目 | 行号准确性 | 改法可落地性 | 验收可测性 | 主要疑点编号 |
|---|---|---|---|---|
| sub/G-1 | agent.ts:269 准；test:170-178 准（T-D1b 断言体） | 可行；import 需扩（未提） | 现 5 例；变异可行 | S-G-1（5+1 与改法矛盾）、S-G-2（工厂形状未覆盖）、S-G-3 |
| sub/C-orch-1 | :330/:338/:348-352/:354-358 全部准；header 行域偏窄 | **存疑**：只改 :348-352 拿不到上游 cancellable，必须同改 map 构建+三处 null 消费；聚合语义未定义 | 现 5 例，harness 可直接构造 | S-C-1（关键）、S-C-2、S-C-3 |
| e2e/R-1 | :175/:180-198 均准（r1 校正后） | 可行；childSessionId 必填可取 | 现 5 例，落 T-D1c | S-E-1（落点未指明）、S-E-2 |

（本包仅列事实与疑点，Go/No-Go 与级别判定由评审方给出。）
