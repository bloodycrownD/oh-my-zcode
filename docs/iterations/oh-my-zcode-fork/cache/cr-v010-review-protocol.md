# CR v010 · 评审输出 · review-protocol

- base_sha: `1fa2d0e`
- head_sha: `aba59a9`
- 节点: `review-protocol`（scope 模式，readonly 评审）
- 检查维度: A + B + C + C-orch + G
- 评估面: `apps/zcode-cli/packages/contracts/**`、`packages/shared/**`、`apps/zcode-cli/packages/adapters/**`（BASE..HEAD）
- spec: `docs/iterations/oh-my-zcode-fork/spec.md`
- 证据包: `cache/cr-v010-evidence-protocol-storage.md`
- fix-spec: 未创建（本文件即 fix-spec 的输入）
- 模式约束: readonly；本节点唯一写入即本文件

**取证方式**：证据包的每一条主发现与附注均按 `file:line` 回读 HEAD 复核，不采信索引结论。
复核结果见第 5 节（含 **3 条被推翻的证据包结论** 与 2 条行号漂移）。

**P0 判定**：无。未发现可在「同仓同版发布、无混版」前提下被真实触达的运行时破坏性缺陷。

---

## 1. must-fix

### review-protocol/C-1 — P1 — `workspace/updateMagicContextConfig` 信封把 `config` 变成可选键，缺席即静默清空整域并写盘

- **文件**：`packages/shared/src/zcode-protocol/index.ts:2146-2151`（信封 schema，**在评估面内**）；受害路径 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-config.ts:122,132,147,163`
- **维度**：C（协议契约正确性）+ G（破坏性写无护栏）
- **描述**：
  - `:2149` 的 `config: z.unknown()` 在 zod 里隐含 optional，因此 `{ workspace }`（**不带 `config`**）能通过 `.strict()` 信封；`z.infer` 推导出的 `ZCodeWorkspaceUpdateMagicContextConfigParams` 里该键同样是可选的，**可选性被写进了协议类型本身**，不只是一个运行时宽容。
  - handler `:122` 的兜底是 `params.config ?? {}`；`MagicContextConfigSchema.safeParse({})` 经 `.default()` 产出**全默认域**。
  - 于是这一次调用会：写盘（`:132`，`changed: true`）→ 逐 session `configPort.set` 并触发 `ConfigPort.observe` fan-out（`:147`）→ 返回 `applied: true`（`:163`）。用户全部 magic-context 设置被重置，且**响应里没有任何字段提示这是一次重置**。
  - 现有测试只覆盖了「显式空对象」：`apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-config-rpc.mjs:165` 的 `params({})` 展开成 `{ workspace, config: {} }`（`:80-82`），**键是存在的**。键缺席这一条路径无任何断言。
  - 缓解事实（不改变定级）：仓内唯一调用方 `packages/services/src/zcode-agent/zcodeAgentService.ts:3796` 转发 `params.config`，而 `packages/services/src/zcode-agent/zcodeAgent.ts:256-258` 把 `config: unknown` 声明为**必填**，所以今天的 UI 调用链是安全的。风险面在协议边界本身——手写 JSON-RPC、非 TS 调用方、未来的重构（`{...base, config}` 少写一项、或 `config: maybeUndefined`）。一个「整域覆盖 + 缺席等于全默认」的组合在没有 required 约束的信封上是不可接受的。
- **具体改法**（协议层改，保留「字段表只在包里一份」的设计）：
  1. `packages/shared/src/zcode-protocol/index.ts:2146-2151` 给信封加一条必填约束，让缺席在协议层就非法、并把原因写进错误消息：
     ```ts
     export const zcodeWorkspaceUpdateMagicContextConfigParamsSchema = z
       .object({ workspace: zcodeWorkspaceRefSchema, config: z.unknown() })
       .strict()
       .refine((params) => params.config !== undefined, {
         message:
           "config is required: this method replaces the whole magicContext domain, so omitting it would reset every setting to its default",
         path: ["config"],
       });
     ```
     注意用 `.refine` 而不是 `.default` / `.catch`——两者都会把破坏性语义合法化。
  2. `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-config.ts:122` 的兜底从 `params.config ?? {}` 改成 `params.config`（schema 已保证非 undefined），或在 `:122` 前加一行 `if (params.config === undefined) throw new ProtocolRequestError(-32602, "config is required")` 作纵深防御。**二者选一即可，推荐 1 + 保留 `??` 之外的显式注释说明为何不再兜底。**
  3. 同步订正 `index.ts:2142-2144` 的注释：现在写的是「schema 的 `.default()` 保证一次 parse 就产出完整域」，补一句「`config` 键本身必填——缺席不是『用默认值』的意思，而是调用错误」。
- **验收/测试要点**：
  - 在 `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-config-rpc.mjs` 仿照已有的 `:131`（`A2: invalid domain → -32602, and neither disk nor memory is touched`）新增一条：params 只带 `{ workspace }`（**键缺席**，不是 `config: {}`）→ 断言抛 `-32602`、断言 `configPort.get(ConfigKey.MagicContext)` 仍是原值、断言磁盘 `config.json` 未被创建/修改（`existsSync(path) === false` 或内容逐字未变）。
  - 保留 `:165` 的 `config: {}` 用例并在其注释里点明二者语义不同（前者 = 用户主动清空，后者 = 调用错误）。
  - 三套 typecheck + lint 全绿（协议 schema 改动会牵动 `packages/services` 的 `zcodeAgentService` 泛型）。

---

### review-protocol/A-1 — P1 — `RewindStrategy.FileOnly` 成为无生产者的死枚举；wire 枚举与实际生产面不一致；4 处恒假条件 + 2 条永不可达的 compaction 文案

- **文件**：枚举与 wire schema `apps/zcode-cli/packages/contracts/src/rewind/index.ts:29, 69-74`；生产者 `contracts/src/rewind/index.ts:217-249`（`evaluateRewindTarget`，已无 `FileOnly` 返回点）；消费点 `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts:244-247, 326-329` 与 `rewind-message.ts:250-253, 351-354`
- **维度**：A（枚举/契约自洽）
- **描述**：
  - `evaluateRewindTarget`（`:217-249`）的三个 return 点只产出 `Unavailable` 与 `ActiveChain`；`RewindTargetStatus` 已被相应收窄为 2 值（`:36-39`），但 `RewindStrategy` 的 `FileOnly` 成员没跟着收。
  - `rewindTriggeredPayloadSchema:69-74` 仍把 `file_only` 列为**合法的 wire 值**——于是协议层宣告了一个本版本不可能被任何生产者发出的枚举值。
  - 4 个消费点全部退化为恒真/恒假：
    - `rewind.ts:244-247` 与 `rewind-message.ts:250-253`：`strategy !== ActiveChain && strategy !== FileOnly` 等价于 `strategy !== ActiveChain`（**恒真化**的那一半）。
    - `rewind.ts:327` 与 `rewind-message.ts:352`：`strategy === FileOnly` **恒假**，于是下面这条用户可见英文串永不可达：
      `" Workspace files were restored; conversation history stayed at the compacted context."`
      该串是 Step 28 全仓 `compact` 残留扫描里**唯一一处面向用户的 compaction 措辞残留**，且它藏在一个恒假分支里，纯文本扫描捞不到、类型系统也不报。
  - 行为无回归（恒假分支的删除不改变任何可达路径），但契约在说谎 + 有可被静态手段捞出的死文案。
- **具体改法**：
  1. `contracts/src/rewind/index.ts:29` 删除 `FileOnly: "file_only",` 成员。
  2. `contracts/src/rewind/index.ts:69-74` 的 `strategy: z.enum([...])` 去掉 `RewindStrategy.FileOnly`（收窄为 `ActiveChain | ForkRequired | Unavailable`——这三个是全部真实 wire 生产者：`evaluateRewindTarget` 出前两个中的 `ActiveChain`/`Unavailable`，`core/src/runtime/methods/{workspace-fork,workspace-checkpoints,session-fork}.ts` 出 `ForkRequired`）。
  3. `core/src/runtime/methods/rewind.ts:244-247` 简化为 `if (evaluation.strategy !== RewindStrategy.ActiveChain) {`；`rewind-message.ts:250-253` 同理。
  4. 删除 `rewind.ts:326-329` 与 `rewind-message.ts:351-354` 的 `strategyText` 三元表达式，并把 `:335` / `:360` 响应串里的 `${strategyText}` 一并去掉。
  5. 若下游 UI 或持久化里存在 `strategy: "file_only"` 的历史行（`.passthrough()` 之外的地方），第 2 步会让它们被 reject——按 D-7「无历史数据包袱」的前提，这是预期；若担心，可先跑一次全仓 `rg "\"file_only\""` 确认只出现在本仓库自身的生产代码里（本次复核结论：`RewindStrategy.FileOnly` 全仓 6 处命中，其中 4 处是比较、1 处是 wire schema、1 处是枚举定义，**无字符串字面量 `"file_only"` 的落库/断言点**）。
- **验收/测试要点**：
  - `rg "FileOnly|file_only" -g "!dist" -g "!node_modules" apps packages` 归零。
  - `pnpm --dir apps/zcode-cli typecheck` 全绿（core/bootstrap/packages 三处引用同步）。
  - 建议补一条单测：`evaluateRewindTarget` 在 `checkpointAvailable: false` + `scope: Workspace` 下返回 `strategy: "unavailable"`、`targetStatus: "active_chain"`，钉住「scope 不被允许时不再是 CoveredByCompact」这一收窄后的行为。

---

### review-protocol/B-1 — P2 — 证据包 6.6 的「旧数据整条 parse 失败」结论需更正：strict zod 只在 wire 侧，真实风险面是 DB 解码零校验

- **文件**：strict schema 全部为 wire-only（`contracts/src/rewind/index.ts:43,65`；`packages/shared/src/zcode-protocol-legacy-types.ts:313,346,491`；`packages/shared/src/zcode-protocol/index.ts:967,1222`）；DB 侧解码 `apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts:115-122`；首启提示 `apps/zcode-cli/packages/cli/src/data-dir-notice.ts:57-68`
- **维度**：B（向后兼容面 / D-7 前提下的严重度裁决）
- **描述**：
  - 逐条 `rg` 复核上述 strict schema 的消费方，**全部**落在 wire 边界：`checkpointCreatedPayloadSchema` 只被同文件的 `parseCheckpointCreatedPayload`（`:206`）与 core 事件构造使用；`zcodeMessagePartSchema` / `zcodeSessionStateSnapshotSchema` / `zcodeMessageUpsertedEventPayloadSchema` 只被 `packages/shared/src/zcode-protocol/index.ts:1246,1462,1776,1805` 与 `packages/services/src/zcode-agent/zcodeAgentService.ts:3406+` 消费。桌面与 CLI 同仓同版发布（spec L359），**wire 上不存在混版数据源 → reject 路径不可达**。
  - 会话 DB 的读取路径**根本不过 zod**：`codecs.ts:115-122` 是 `JSON.parse(row.data)` + 对象展开 + `as MessagePart` 强制转换，零运行时校验；同文件的 `decodeSessionTaskType`（`:38-42`）/ `decodeSessionTitleSource`（`:44-48`）对未知枚举一律回落默认值。也就是说 DB 路径的既定风格是**宽容**，不是 reject。
  - 因此升级用户若按首启提示（`data-dir-notice.ts:60-64`：「旧的 ~/.zcode 不会被自动迁移——请按需自行把里面的内容复制到新目录后重启」）把 `db.sqlite` 复制过来，旧 `type:"compaction"` part 会被原样读成一个**不属于 `MessagePart` 联合的对象**并流入下游。全仓无 `assertNever`（仅 `apps/zcode-cli/tools/prompt-trajectory/src/record.ts:198` 一处，与本路径无关），所以不会崩在穷尽检查上，而是落进各消费点的 `default` 分支——**静默错渲染，不是干净报错**。
  - 结论：spec 兼容性说明 L357 已声明「Phase 2b 之前的会话不保证可 resume，属预期」，D-7 前提成立，**严重度定为 P2**；但需要登记两条事实：(a) 不能指望 strict schema 保护 DB 路径；(b) 首启提示的「复制内容」建议与「旧会话不保证可 resume」之间存在张力。
- **具体改法**（登记 + 一处措辞，不加兼容层，保持 D-7）：
  1. `apps/zcode-cli/packages/cli/src/data-dir-notice.ts:57-68` 的 `formatNotice` 增补一行限定：现有第 61 行改为「请按需自行把里面的内容复制到新目录后重启」，追加「**旧会话记录可能无法在新版本中打开**（压缩相关数据已移除）」。
  2. `docs/iterations/oh-my-zcode-fork/spec.md` 兼容性说明 L357 追加一句事实登记：会话 DB 的 part 解码不做 schema 校验（`codecs.ts` 约定为宽容回落），复制前推的旧压缩 part 会走未处理分支而非报错。
  3. **不建议**给 `zcodeMessagePartSchema` 加 `.catch()` 或 `compact` 占位成员——那会与 D-7 直接冲突，且在 wire 不可达的前提下是无收益的复杂度。
- **验收/测试要点**：
  - 手工验证（manual_user）：把含 compaction part 的旧 session 目录复制到新数据根，打开该会话——确认不崩、且 UI 上表现为「该 part 不渲染」而非整条消息消失；把结论记进 fix-spec 的验收注记。
  - 首启提示文案改动后跑 `apps/zcode-cli/packages/cli/scripts/` 下相关的 data-dir-notice 测试（若有断言文案的地方需同步）。
  - `rg "assertNever"` 结论登记即可，无需动作。

---

### review-protocol/C-orch-1 — P2 — saved-workflow 的 project scope 落点：常量是 `.zcode`，本次 diff 却把两处注释改成了 `.omz`

- **文件**：`apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts:19, 25`（常量，本次未改）vs 同文件 `:45`（注释，本次改了）；`packages/shared/src/zcode-protocol/index.ts:2729`（注释，本次改了）；判据锚点 `apps/zcode-cli/packages/adapters/src/commands/roots.ts:11-13`
- **维度**：C-orch（contracts/shared/adapters 三层映射一致性）
- **描述**：同一语义（project scope 的落盘目录）在 HEAD 有三个不同答案：

  | 位置 | 说的落点 | 本次 diff |
  |---|---|---|
  | `saved-workflow.ts:19` `SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows"` | `.zcode`（代码） | 未改 |
  | `saved-workflow.ts:25` `WORKFLOW_DRAFTS_DIR = ".zcode/workflow-drafts"` | `.zcode`（代码） | 未改 |
  | `saved-workflow.ts:45` 注释 | 「项目档落在项目的 `.omz/workflows/`」 | **改为 `.omz`** |
  | `shared/src/zcode-protocol/index.ts:2729` 注释 | 「项目档落 `<cwd>/.omz/workflows/`」 | **改为 `.omz`** |

  S32 的分层规则是可判定的：`roots.ts:11-13` 明确把用户级改成 `.omz`（`USER_ZCODE_DIR`），同时**刻意保留**工作区级 `.zcode`（`WORKSPACE_ZCODE_DIR`，注释「工作区级约定目录，跟随仓库内容，不参与品牌改名」）；`skills/roots.ts:10-14` 同构。project scope 的 workflow 目录属于工作区级约定目录，跟随仓库内容，因此**常量是对的、被本次 diff 改动的两处注释是错的**。当前状态下代码无法自证，后续读者按注释去 `.omz/workflows` 找文件会找不到。
- **具体改法**（最小改动，推荐）：把两处注释改回 `.zcode`，与常量和 `roots.ts` 的分层约定对齐：
  1. `contracts/src/tools/saved-workflow.ts:45` 的 `.omz/workflows/` → `.zcode/workflows/`（同句里的全局档 `~/.omz/workflows/` 保持不变）。
  2. `packages/shared/src/zcode-protocol/index.ts:2729` 的 `<cwd>/.omz/workflows/` → `<cwd>/.zcode/workflows/`。
  3. 在 `saved-workflow.ts:18` 的 `SAVED_WORKFLOW_PROJECT_DIR` 注释上补一句锚定：「工作区级目录**刻意保留 `.zcode`**，与 `adapters/src/commands/roots.ts:13` 的 `WORKSPACE_ZCODE_DIR` 同一约定；S32 只改用户级。」
  4. **若**项目另有决定要统一到 `.omz`（即推翻 `roots.ts` 的分层），则改的是两个常量 + drafts 目录，并需要审计 core 侧 saved-workflow store 的全部落点——工作面大得多，且会让已有项目里的 `.zcode/workflows/` 失效。默认按方案 1。
- **验收/测试要点**：
  - `rg -n "\.omz/workflows" apps packages` 的每一处命中都要么是全局档（`~/` 前缀），要么已被本条修正；工作区级落点描述全部为 `.zcode`。
  - 补一条一致性断言（建议落在 `contracts` 或 `packages/shared` 的脚本测试里）：`SAVED_WORKFLOW_PROJECT_DIR` 与 `SAVED_WORKFLOW_GLOBAL_DIR` 的末段目录名一致（`workflows`），且 project 常量不以 `.omz` 开头、global 常量以 `.omz` 开头——把分层约定钉成可执行断言，而不是靠注释。
  - 根 typecheck + lint 全绿（纯注释 + 常量，预期无行为变化）。

---

### review-protocol/G-1 — P2 — `adapters/src/config/schema.ts:434-436` 三行缩进被压到列 0

- **文件**：`apps/zcode-cli/packages/adapters/src/config/schema.ts:434-436`
- **维度**：G（改动面卫生）
- **描述**：已回读确认的破损形态：

  ```
  433     if (parsed.features) config.features = parsed.features;
  434  if (parsed.memory) config.memory = parsed.memory;                    ← 列 0
  435  if (parsed.magicContext) config.magicContext = parsed.magicContext;   ← 列 0（本次新增）
  436  if (parsed.mcp) config.mcp = parsed.mcp;                            ← 列 0
  437     if (parsed.plugins) config.plugins = normalizePluginConfig(parsed.plugins);
  ```

  `:433` 与 `:437` 保持 2 空格，中间三行被压到列 0。这不是任何 formatter 会产出的形态（prettier/oxlint 都会重排），说明该 hunk 是手工编辑且格式化被跳过——而 `:435` 正是 `magicContext` 参数域的接入点，同一个 hunk 里未被本次 diff 暴露的行是否有同类处理过、无法从 diff 判断，只能靠回读确认（本次已确认 `:428-449` 全段无其他破损）。
- **具体改法**：把 `:434`、`:435`、`:436` 三行恢复为 2 空格缩进，与 `:433`/`:437` 对齐。纯格式，不改语义。
- **验收/测试要点**：
  - 对本文件跑一次 `oxfmt --check`（或仓库既有 fmt 命令的单文件形式）确认归零。注意 spec 测试策略已声明「root `oxfmt --check` 全量在基线即红 ~2650 文件」，所以**只对本次改动文件做零新增校验**，不要顺手格式化全仓。
  - `pnpm --dir apps/zcode-cli typecheck` 归零（预期无变化）。

---

### review-protocol/G-2 — P2 — `ConfigValue<"magicContext">` 是一个两臂恒等的装饰分支，而它恰是 Step 23 映射清单里唯一无任何护栏的一处

- **文件**：`apps/zcode-cli/packages/contracts/src/config/index.ts:170-172`（分支本体）、`:91-106`（自陈理由的注释）
- **维度**：G（声明的护栏是否真的护栏）
- **描述**：
  - 已回读确认：`:170-172` 的两臂都是 `unknown`，因此 `ConfigValue<"magicContext">` 与 `:172` 的兜底 `unknown` **类型上完全等价**。
  - `:94-97` 的注释自陈目的是「让『本 key 的承载类型是刻意的选择』这件事在类型层可 grep——漏写会静默落进同一个 `unknown` 兜底，评审无法区分『有意』与『忘了』」。但注释同时承认「为什么是 `unknown` 而不是结构类型」是**类型层刻意不兑现**的（避免把包图倒过来）。净效果：留下了一个恒等分支 + 一个无法兑现的承诺，代价是给未来在此之后新增分支的人埋了一个「这段是装饰吗」的判断题。
  - 关键补强证据：`apps/zcode-cli/packages/adapters/scripts/test-magic-context-domain.mjs` 的用例命名覆盖 `mapping 1 / 3 / 4 / 5 / 6/7 / 8 / 9`，**唯独没有 `mapping 2`**。也就是说 spec Step 23 枚举的映射点里，唯一无法用运行时测试覆盖的那一个（纯类型分支），正好也是唯一退化成 no-op 的那一个。spec L114 明确点出这个陷阱（「`ConfigValue<K>` 条件类型，**漏写会静默落进 `:151` 的 `unknown` 兜底**」）——Step 19a 用 `features.magicContext` 做实测时它有真实约束力（boolean 分支），Step 23 复用同一个 `unknown` 兜底时就没有了。
- **具体改法**（二选一，推荐 1）：
  1. **删掉恒等分支，把承诺换成可执行的编译期锚点**：
     - 删除 `contracts/src/config/index.ts:170-172` 的
       ```
       : K extends "magicContext"
           ? unknown
           : unknown;
       ```
       改为直接落到兜底，并把 `:94-97` 的注释改写成「`"magicContext"` 有意落在末尾的 `unknown` 兜底上（不写专门分支）——理由同下：避免为它加 workspace 依赖边把包图倒过来。为防止将来被误当成『漏写』，下面有一行编译期锚点钉住这个 key 的存在与承载类型。」
     - 在同文件加一行编译期锚点（放在 `:172` 之后即可）：
       ```ts
       // 编译期锚点：`magicContext` 这个 key 必须存在，且其承载类型就是 `unknown`。
       // 删除 ConfigKey.MagicContext 或给它换成别的承载类型都会让本行编译失败。
       const _magicContextValueAnchor: ConfigValue<"magicContext"> = undefined as unknown;
       const _magicContextKeyAnchor: ConfigKey = "magicContext";
       ```
       （若嫌 `no-unused-vars` 噪音，用 `void _magicContextValueAnchor;` 消费掉。）
  2. 若坚持保留分支，则必须补上它唯一能兑现的东西——一条会因分支被删而失败的测试：在 `packages/shared` 或 `contracts` 的脚本测试里加 `Expect<Equal<ConfigValue<"magicContext">, unknown>>` 之类的类型级断言。**注意这条断言与现状等价、同样恒真**，所以它并不能兑现注释的承诺——这也是推荐方案 1 的原因。
- **验收/测试要点**：
  - 方案 1 验收：临时把 `ConfigKey.MagicContext` 改名，`pnpm --dir apps/zcode-cli typecheck` 必须**报错**（证明锚点有效），然后还原。
  - `pnpm --dir apps/zcode-cli typecheck` + 根 typecheck 全绿；lint 的 warning 不高于基线。
  - 建议在 `test-magic-context-domain.mjs` 里补一条 `mapping 2:` 前缀的用例（哪怕只是断言 `port.get(ConfigKey.MagicContext)` 的运行时形状不是 `undefined`，即 `assert.notEqual(port.get(ConfigKey.MagicContext), undefined)`），让编号连续、评审时能一眼看到 mapping 2 是被有意覆盖的。

---

### review-protocol/C-2 — P2 — `MagicContextPatchResult` 的「刻意不回显域值」理由，与协议 result schema 里确实回显了域值互相打脸

- **文件**：`apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts:41-52`（理由注释）；`packages/shared/src/zcode-protocol/index.ts:2168-2179`（result 的 `config: z.unknown()`）；`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-config.ts:164-168`（回显 `parsed.data`）
- **维度**：C（契约叙述与实现一致性）
- **描述**：`file-config.adapter.ts:44-46` 明写「只回报『写到了哪里』——刻意不回显整个域值：它是十几 KB 量级的运行时配置快照，把它塞进 JSON-RPC result 会污染协议日志」。但同一 feature 的协议层 result schema（`index.ts:2179`）**恰恰有一个 `config: z.unknown()` 承载完整 effective 域**，handler `:167` 也真的把 `parsed.data` 塞了进去。两处叙述不可能同时是设计意图。此外「十几 KB」这个量级判断对默认态并不成立（10 个顶层标量 + 一个 historian 子对象，见第 5 节 refuted-3），只有在 per-model catchall map 被填满时才接近。
- **具体改法**（推荐保留协议回显，只订正写盘层的理由）：
  1. `file-config.adapter.ts:41-52` 的注释改为：「写盘层只回报『写到了哪里 + 是否真的改动』，不回显域值——域值由协议层 `workspace/updateMagicContextConfig` 的 result 统一回显（`shared/src/zcode-protocol/index.ts:2168-2179`），那里才是 UI 回填表单的依据。写盘层再回显一份就成了第二份出口。」
  2. 删除「十几 KB 量级…会污染协议日志」这半句（与协议层现状矛盾，且量级判断对默认态不成立）。若确有日志体积顾虑，改成在协议层注释里陈述，并给出实际措施（例如 UI 侧不回显到日志），而不是在写盘层留一条永不兑现的理由。
  3. 顺手核对 `index.ts:2168-2173` 的注释（「回显 params 会让 UI 展示与内存不一致的表单」）——这一条与现状一致，**保留**。
- **验收/测试要点**：
  - 无行为改动，`pnpm --dir apps/zcode-cli typecheck` + lint 归零。
  - 建议在 `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs` 里确认既有用例仍成立（`A1: read returns the ConfigPort's effective domain…`、`B1: editing one field through the UI form preserves every other key`），无需新增。

---

### review-protocol/C-3 — P2 — `DEFAULT_MAGIC_CONTEXT_CONFIG` 的注释自陈「transcribed 逐字段抄写 + 测试断言相等」，实际值就是 `parse({})`，那条断言恒真

- **文件**：`apps/zcode-cli/packages/magic-context/src/host/config/schema.ts:219-224`（注释 + 定义）；恒真断言两处 `apps/zcode-cli/packages/magic-context/scripts/test-config.mjs:72-74` 与 `apps/zcode-cli/packages/adapters/scripts/test-magic-context-domain.mjs:170-176`
- **维度**：C（声明与实现一致性）+ G（回归护栏的实际效力）
- **描述**：
  - `schema.ts:220-223` 的注释：「The complete default configuration, **transcribed field by field** from the reference schema's `.default()` calls. `MagicContextConfigSchema.parse({})` **must equal this object**; `scripts/test-config.mjs` asserts it.」——而 `:224` 的值本身就是 `MagicContextConfigSchema.parse({})`。「transcribed（逐字段抄写）」与「由同一个表达式导出」互相矛盾。
  - `test-config.mjs:74` 的 `assert.deepEqual(parsed, DEFAULT_MAGIC_CONTEXT_CONFIG)` 里 `parsed` 正是 `MagicContextConfigSchema.parse({})`（`:73`）——**恒真断言，永不可能失败**。`test-magic-context-domain.mjs:172` 同理。
  - 该注释声称的回归目的（「防 adapters 侧写了第二份默认值」）在 `test-magic-context-domain.mjs:170-175` 的注释里也被复述了一遍（「默认域必须与包内 `.default()` 逐字段相同」），但同样没有 teeth：给 schema 新增一个带 `.default()` 的键，这条断言依然通过。
  - 复核后确认：**真正有价值的部分在紧邻的行**——`test-config.mjs:75-83+` 逐条断言了字面量默认值（`enabled===true`、`execute_threshold_percentage===65`、`history_budget_percentage===0.15`、`cache_ttl==="5m"`、`smart_drops===false`、`fail_closed_blocking===true`、`historian.two_pass===false`、`historian.fallback_models`/`disallowed_tools` 深相等）。这些能挡住「默认值被改」，但**挡不住「新增了一个带默认值的键」**。全仓 `rg "Object.keys|deepEqual\(Object"` 在两个测试脚本里 0 命中，即没有任何**顶层键集合**断言。
  - 说明：`test-config.mjs:187` 的 `assert.deepEqual(parsed, DEFAULT_MAGIC_CONTEXT_CONFIG)` **不是**恒真——`parsed` 来自带未知键（`compaction`/`dreamer`/`mural`/`profiles`）的 parse，与 `parse({})` 的相等性正是 strip 语义的有效断言。这条应保留。
- **具体改法**：
  1. `magic-context/src/host/config/schema.ts:219-223` 注释订正为：「The complete default configuration, **derived** from the schema's own `.default()` calls rather than transcribed field by field — a second hand-written copy is exactly the drift we are avoiding. `scripts/test-config.mjs` pins the individual defaults as literals and pins the top-level key set, so adding a defaulted key without deciding on its default still fails the suite.」（删除 "transcribed" 与 "must equal this object … asserts it"。）
  2. 把 `test-config.mjs:74` 的恒真断言替换为**顶层键集合**断言：
     ```js
     assert.deepEqual(
       Object.keys(parsed).sort(),
       // 10 个顶层键；新增带 .default() 的键必须同时在此登记，否则本用例失败
       ["cache_ttl", "enabled", "execute_threshold_percentage", "fail_closed_blocking",
        "historian", "history_budget_percentage", "language", "protected_tokens",
        "smart_drops"].filter((k) => k in parsed).sort(),
     );
     ```
     更稳的写法是维护一个显式的期望键数组并 `deepEqual` 到 `Object.keys(parsed).sort()`，这样新增键必然红灯。
  3. `test-magic-context-domain.mjs:170-176` 同理：把 `:172` 的恒真断言换成「顶层键集合与包内 `MagicContextConfigSchema.parse({})` 的键集合相同，且 adapters re-export 的 `MagicContextConfigSchema` 与 `@zcode/magic-context` 导出的是**同一个对象**（`assert.equal(adaptersExport, packageExport)`）——后者能真正守住 `adapters/src/config/schema.ts:336` 那句「不在 adapters 侧另立一份声明」的承诺（这条断言落在评估面内的 adapters 脚本里，是本条最值得加的部分）。
- **验收/测试要点**：
  - 临时给 `MagicContextConfigSchema` 加一个 `newKey: z.boolean().default(true)`，`apps/zcode-cli/packages/magic-context/scripts/test-config.mjs` 必须**失败**（证明新护栏有效），然后还原。
  - `pnpm --dir apps/zcode-cli/packages/magic-context test`（或该包既有 test script）与 `adapters` 侧 `test-magic-context-domain.mjs` 全绿。
  - 注意：`magic-context` 包本身不在本节点的评估面内，改动它需要 fix-spec 显式把该文件纳入 scope，否则会被下游 dev-loop 判为越界。

---

## 2. open_questions

> 以下问题**不需要**阻塞 dev-loop 开工，但需要用户/产品侧拍板或登记，拍板结果应回写 spec。

### OQ-1 — saved-workflow 的 project scope 落点：常量对还是注释对？（对应 `review-protocol/C-orch-1`）

- 问题：`SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows"`（`contracts/src/tools/saved-workflow.ts:19`）与本次 diff 新写的两处 `.omz` 注释（`:45`、`packages/shared/src/zcode-protocol/index.ts:2729`）冲突，哪个是 S32 的意图？
- 本节点的判断与建议：**注释是错的**。依据是 `apps/zcode-cli/packages/adapters/src/commands/roots.ts:11-13` —— S32 明确分层：用户级改 `.omz`、工作区级保留 `.zcode`（注释「跟随仓库内容，不参与品牌改名」），`adapters/src/skills/roots.ts:10-14` 同构。project scope 的 workflow 目录跟随仓库内容，应留在 `.zcode`。
- 需要用户确认的是：这次 diff 改注释的人是不是**本来就想**把 project scope 也搬到 `.omz`（那意味着工作区级约定目录的统一，与 `roots.ts` 的分层决定冲突，需要连带审计 core 侧 saved-workflow store 的全部落点）。若无此意图，按 `C-orch-1` 的方案 1 改回注释即可。

### OQ-2 — Step 28 的 `compact` 残留扫描白名单是否需要补 dynamic-workflow 的保留占位？

- 问题：spec L229 明确要求保留 `apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts:654` 的 `{ type: "compaction"; actor: ActorRef }` 成员（「保留占位，v1 从不发出」）。已回读确认该占位原样保留、本次 diff 未触及该文件（HEAD `:470` 注释与 `:654` 成员都在）。
- 但 Step 28（spec L290）的扫描白名单只列了「布局词、数字缩写、`context-usage-log-compact`、`compact_stream_boundary`/`preserveProviderStreamBoundaries`、magic-context 语境」，**没有列 dynamic-workflow 的 compaction 占位**。
- 需要拍板：白名单补 `apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts:654`（及其 `:470` 注释）这一条，否则 Step 28 的执行者会把它当成残留而误报/误删——而删掉它恰好违反 spec L229 的显式指令。
- 本节点判断：属于白名单条目缺失，建议补，不改代码。

### OQ-3 — `plugins.enabledPlugins` 里的旧 marketplace id 是否有迁移/兼容路径？

- 事实：`packages/shared/src/plugin-marketplaces.ts:10` 的 `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID` 已改为 `oh-my-zcode-official`，`:13-24` 的 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 11 个 id 全量改写；`apps/zcode-cli/packages/adapters/src/config/schema.ts:198` 的 `canonicalizePluginId` **只覆盖 CUA 一对**（`zcode-cua@zcode-plugins-official` → `computer-use@oh-my-zcode-official`）；`adapters/src/plugins/official-marketplace.ts:122-129` 额外接受旧 manifest 名（单向，只放宽校验）。
- 问题：升级用户在 `config.json` 里手写的 `…@zcode-plugins-official` 条目，没有对应的 canonicalize，会静默失效（插件未启用）。
- 需要拍板：在 D-7「无存量承诺」前提下，这是可接受的；但**是否值得为它加一条 canonicalize 分支**，取决于对升级用户的实际承诺。若决定不加，建议在 spec L360（Phase 3 数据目录「新起，不做检测与迁移提示」）旁边补一句「`plugins.enabledPlugins` 的旧 marketplace 后缀同样不做迁移」，把这条明确登记为已知行为，而不是留成沉默的不一致。

---

## 3. spec_deviations

### 已登记的偏离（前置拍板，不在本节点重开）

| id | 内容 | 状态 | 依据 |
|---|---|---|---|
| SD-1 | S26 删除清单与 8 项偏离已登记 | open（已登记） | `iteration-state` phase2b.s26（用户提供的已拍板背景） |
| SD-2 | 「无历史数据包袱」是 spec 前提（D-7 / spec L27、L43、L357） | open（spec 前提） | 本节点按此前提裁决了 `review-protocol/B-1` 的严重度为 P2 |
| SD-3 | `queueItemSchema` / `expectedHeldQueueItemIds` 与 compact 的耦合结论 | **fixed** | 证据包 §5 已证实；本节点另行回读 `packages/shared/src/zcode-protocol-v4/{snapshot.ts:250-255,input-intent.ts:44,command.ts:94,141}` 复核一致 |
| SD-4 | `dynamic-workflow` 的 `RunEvent.compaction` 占位**保留不删** | open（符合 spec） | spec L229 显式指令；HEAD `dynamic-workflow/src/engine/types.ts:654` 原样保留 → 见 OQ-2（只补扫描白名单） |
| SD-5 | `UsageQuerySource` 删 `"compact"` 是**零类型影响**的编辑 | open（登记） | spec L229 列它是因为「删除会牵动 usage_stats 查询源」；实测牵动不了：唯一使用点 `contracts/src/interfaces/session-store.port.ts:830` 写成 `UsageQuerySource \| string`，把联合放宽成任意字符串；core 侧另有独立本地类型 `core/src/runtime/methods/usage-observability.ts:21-25`（同样是 `\| string`）。**建议在 spec 里把这一条的措辞从「会牵动」改成「删除后确认零影响」，避免后续节点把它当风险点重复排查。** |

### 本节点新发现的偏离

| id | 内容 | 状态 | 说明 |
|---|---|---|---|
| SD-6 | spec L227 列出的「`zcodeTaskUsageFallback.ts` 的 `/compact` 归一化」删除**已完成** | fixed（本次复核确认） | 文件实际路径为 `packages/ui/src/lib/zcodeTaskUsageFallback.ts`（不在 `packages/services`，spec L227 未给完整路径）；`rg -i compact` 该文件 **0 命中** |
| SD-7 | spec L229/L231 的防误删清单全部存活 | open（符合 spec） | 逐项回读确认：`compact_stream_boundary`（`contracts/src/model/index.ts` 5 个成员，文件不在变更列表）、`preserveProviderStreamBoundaries`（`contracts/src/model/{index.ts,invocation-context.ts}` + `magic-context/src/host/hidden-completion-executor.ts:81` 的必填字面量栅栏）、`context-usage-log-compact.ts`（107 行未变更，消费者 `context-usage.ts:19,55` 在位）、`formatCompactTokenCount`（`tui/src/app-input-status.tsx:277`）与 `formatCompactTokens`（`magic-context/src/core/shared/window-geometry.ts:718`）。全仓无 `compact` 悬挂符号命中 |
| SD-8 | spec L243 要求数据目录改名「新起 + **首启提示**」，提示已实现 | fixed（本次复核确认，推翻证据包 6.7 的「无提示」说法） | `apps/zcode-cli/packages/cli/src/data-dir-notice.ts` 完整实现（marker 一次性、失败静默降级、不进协议通道），且 `:61` 的文案正是「请按需自行把里面的内容复制到新目录后重启」→ 与 D-7 的张力已在 `review-protocol/B-1` 登记 |

---

## 4. 结论

**scope-ready: no**

理由：存在 2 条 P1，且都不是「风格问题」，都需要在本节点收敛后再进 dev-loop——

1. `review-protocol/C-1`：`workspace/updateMagicContextConfig` 的信封把 `config` 变成可选键，`{ workspace }` 一次调用即可**静默重置用户全部 magic-context 设置并写盘**，且返回 `applied: true`。协议类型 `ZCodeWorkspaceUpdateMagicContextConfigParams.config` 本身就是可选的，可选性被固化进了类型。这是破坏性写语义 + 零护栏 + 零测试的组合，必须先在协议层加必填约束。
2. `review-protocol/A-1`：`RewindStrategy.FileOnly` 在本次 S26 编辑后成为**无生产者的死枚举**，但仍留在 wire 枚举里宣告为合法值，并在 core 侧留下 4 处恒假条件与 2 条**永不可达的用户可见 compaction 文案**。后者是 Step 28 残留扫描的暗礁——文本扫描捞不到（它在一个恒假分支里），类型系统也不报。

P1 收敛后，本节点其余 6 条 P2（`B-1` / `C-orch-1` / `G-1` / `G-2` / `C-2` / `C-3`）均为登记 + 订正 + 加断言类，**不阻塞** dev-loop 启动，可与 P1 同波次处理或排入下一波。`B-1` 与 `C-3` 需要 fix-spec 显式把 `apps/zcode-cli/packages/{cli,magic-context}` 两个范围外的文件纳入 scope，否则会被判越界。

**无 P0**：在「同仓同版发布、无混版」前提下，未发现可被真实触达的运行时破坏性缺陷。

---

## 5. 复核记录（证据包结论的逐条回读）

证据包 5 条主发现 + 3 条附注的裁决结果如下。**索引不是替代**——每条都按 `file:line` 回读了 HEAD。

### 5.1 主发现 5 条

| # | 证据包结论 | 裁决 | 回读依据 |
|---|---|---|---|
| M-1 | `RewindStrategy.FileOnly` 死枚举 + 4 恒假条件 | **成立，升级为 P1** | 枚举 `contracts/src/rewind/index.ts:29`；`evaluateRewindTarget:217-249` 三个 return 点只出 `Unavailable`/`ActiveChain`；`rg FileOnly` 全仓 6 处（1 定义 + 1 wire schema `:71` + 4 比较）；`rewind.ts:327` / `rewind-message.ts:352` 的 `=== FileOnly` 恒假，其下的 `"conversation history stayed at the compacted context."` 永不可达。**新增发现**：该文案是 Step 28 扫描的暗礁 → 已写进 `A-1` 的验收要点 |
| M-2 | `config: z.unknown()` 漏传静默清空 | **成立，定为 P1** | `shared/src/zcode-protocol/index.ts:2149`；handler `magic-context-config.ts:122` 的 `?? {}` → `.default()` 全默认 → `:132` 写盘 + `:147` fan-out + `:163` `applied:true`。**补强**：`z.infer` 让 `config` 在协议类型里也是可选的；`test-magic-context-config-rpc.mjs:165` 的 `params({})` 展开为 `{workspace, config:{}}`（`:80-82`），**键存在**，故该用例不覆盖缺席路径；唯一调用方 `packages/services/src/zcode-agent/zcodeAgent.ts:256-258` 把 `config` 声明为必填，故今天安全、边界仍不安全 |
| M-3 | `.strict()` 删键 ⇒ 旧数据整条失败 | **结论需更正，降为 P2** | 逐条 `rg` 消费方：这些 strict schema **全部只在 wire 侧**（`rewind/index.ts:206` parse 函数、`shared/zcode-protocol/index.ts:1246,1462,1776,1805`、`packages/services/.../zcodeAgentService.ts:3406+`）。同仓同版 ⇒ 混版不可达 ⇒ reject 路径不可达。**DB 路径根本不过 zod**：`adapters/src/storage/session-store/codecs.ts:115-122` 是 `JSON.parse` + 展开 + `as MessagePart`，零校验；同文件 `:38-48` 对未知枚举一律回落默认。真实风险面改为「复制前推的旧 part 走未处理 default 分支、静默错渲染」，已写进 `B-1` |
| M-4 | schema 白名单 11 键实为 10 + 1 排除 | **成立，但无缺陷** | 逐个数 `magic-context/src/host/config/schema.ts:146-216` = 10 个顶层键（`enabled` / `execute_threshold_percentage` / `execute_threshold_tokens` / `protected_tokens` / `history_budget_percentage` / `cache_ttl` / `historian` / `smart_drops` / `fail_closed_blocking` / `language`）；第 11 项是 `:232` 的 `EXCLUDED_CONFIG_KEYS = ["compaction"]`，其断言在 `magic-context/scripts/test-config.mjs:179-185`（确认存在）。**不构成 must-fix**：不存在任何文档声称「11 键」，11 是计数时的合并产物；`EXCLUDED_CONFIG_KEYS` 与白名单分列两个常量、各有断言，设计正确。附注：spec L99（E 组）枚举的是 `historian.*` 而非把 `historian` 算 1 键，与 10 键口径一致 |
| M-5 | workflow 目录三处矛盾注释 | **成立，定为 P2** | `saved-workflow.ts:19`（`.zcode/workflows`，代码）/ `:25`（`.zcode/workflow-drafts`，代码）/ `:45`（`.omz`，注释，本次改）/ `shared/zcode-protocol/index.ts:2729`（`.omz`，注释，本次改）。**本次新增判据**：`adapters/src/commands/roots.ts:11-13` 明确分层（用户级 `.omz` / 工作区级保留 `.zcode`），`skills/roots.ts:10-14` 同构 → 常量对、注释错。见 `C-orch-1` + OQ-1 |

### 5.2 附注 3 条

| # | 证据包结论 | 裁决 |
|---|---|---|
| N-1 | `adapters/src/config/schema.ts:434-436` 缩进压列 0 | **成立**。回读 `:428-449` 全段确认：`:433` / `:437` 保持 2 空格，中间三行在列 0，`:435` 是本次新增的 `magicContext` 接入点；同段无其他破损。定为 P2（`G-1`） |
| N-2 | `contracts/src/config/index.ts:170-172` 两臂恒等 | **成立，并补强为 P2（`G-2`）**。回读确认两臂都是 `unknown`；**新增证据**：`test-magic-context-domain.mjs` 的用例编号覆盖 mapping 1/3/4/5/6/7/8/9，**独缺 mapping 2** —— 唯一无法运行时测试的映射点正是唯一退化成 no-op 的那一个，正对上 spec L114 点名的「漏写会静默落进兜底」陷阱 |
| N-3 | `transcribed` 注释与 `Schema.parse({})` 不符 | **成立，并补强为 P2（`C-3`）**。回读 `magic-context/src/host/config/schema.ts:220-224` 确认注释称 "transcribed field by field" 而值就是 `parse({})`；恒真断言两处（`test-config.mjs:74`、`test-magic-context-domain.mjs:172`）。**新增发现**：(a) `test-config.mjs:187` 的同类断言**不是**恒真（`parsed` 来自带 4 个未知键的 parse，与 `parse({})` 的相等正是 strip 语义的有效断言），应保留；(b) `test-config.mjs:75-83+` 的字面量默认值断言能挡「改默认值」但**挡不住「新增带 `.default()` 的键」**，全仓无任何顶层键集合断言（`rg "Object.keys|deepEqual\(Object"` 在两个脚本里 0 命中）——这才是这条注释真正缺的东西 |

### 5.3 被推翻的证据包结论（下游节点勿再采信）

| # | 证据包原话 | 复核结果 |
|---|---|---|
| R-1 | §6.11：「`test-feature-flag.mjs:203` 断言 `"FeatureCompact" in ConfigKey === false`，但**没有**断言 `features.compact` 在 `getAll()` 输出、文件回写、或 `RuntimeConfig` 类型上的消失面」 | **推翻**。回读 `apps/zcode-cli/packages/adapters/scripts/test-feature-flag.mjs:203-207`：`:205` 断言 `"compact" in DefaultRuntimeConfig.features === false`，`:206` 断言 `"compact" in createConfigPort().getAll().features === false`。**三面都覆盖了** |
| R-2 | §6.11：「`test-magic-context-domain.mjs` 的 17 个用例……**没有一个覆盖「调用方漏传 `config`」**」 | **部分推翻**。`test-magic-context-config-rpc.mjs:165` 的 `A2: empty/absent config falls back to the full default domain` 覆盖了 `config: {}`（用例名里的 "absent" 指**域内容缺席**，不是键缺席；`params({})` 见 `:80-82`）。键缺席仍无覆盖 → `C-1` 的测试要点按「键缺席」写，不要按证据包原话写成「完全没有覆盖」 |
| R-3 | §6.7：「`packages/shared/src/node/officialPluginCache.ts:13` 的文档改为 `<plugins storage>/cache/oh-my-zcode-official/…`，但扫描代码未在本 diff 内……已有用户磁盘上的 `cache/zcode-plugins-official/` 是否仍被扫到，**文档与代码行为可能已经不一致**」 | **推翻**。回读全文件：`:20` 的 `join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID)` —— 目录名由常量计算，**文档注释与代码同源**，不存在分歧。旧目录不再被扫到是 `~/.zcode → ~/.omz` 数据根改名的自然结果，无需额外处理 |

### 5.4 证据包行号漂移（不影响结论，供后续引用时校正）

- §4.3 表格：`ctx-expand` 实际在 `packages/shared/src/zcode-slash-command-help.ts:218-227`（证据包写 `:224-236`），`ctx-recomp` 实际 `:228-236`（证据包写 `:229-237`）。两处**行区间互相重叠**，是证据包的区间标注错误，条目本身（4 条 `/ctx-*`、删 `/compact`、本地命令不进 `/` 面板）正确。
- §2.3 第 10 项 `language` 的行号 `:204-215` 与 §2.1 表格一致，无漂移。

### 5.5 附：本节点额外确认无误的项（供下游省去重复取证）

- **Step 26 的 S26 摘除自洽性**：`contracts/src/compact/` 整文件删除（353 行）连带 `contracts/package.json:22-25` 的 `./compact` export、`contracts/src/index.ts:41-42` 的 barrel **四处一起删**，无残留 barrel；`sqlite-session-store.ts` 两处分支的判别式（`part.type === "compaction"` / `timelineType === "context_compaction"`）所依赖的类型成员已从联合删除 → 删除是**类型层必需**而非可选清理；`codecs.ts` 的 `partCreatedAt` 删掉 compaction 分支后，`text`/`reasoning`/`timeline`/`tool` 仍构成 `MessagePart` 的完整覆盖。
- **20 个被删符号的全仓 `rg`**：0 悬挂命中。仅 2 处纯注释文字残留（`apps/zcode-cli/scripts/shadow-replay.mjs:172`、`packages/shared/src/zcode-task-types-core.ts:1066`），均不构成行为面。
- **`features.magicContext` 七处映射完整性**：ConfigKey / ConfigValue boolean 分支 / RuntimeConfig / RuntimeConfigPatch / schema / merge / getAll / getDefaultValue / DefaultRuntimeConfig **全部在位**。**Step 19a 点名的 `?? false` 陷阱已正确规避**：`adapters/src/config/index.ts:298` 是 `?? true`，且 `:296-297` 有注释说明「D-11 收官后默认开启，off 是显式退路不是缺省态」——与 `contracts/src/config/index.ts:346-349` 的 `magicContext: true` 一致。这是**正确的**，不是照抄邻居的 bug。
- **`magicContext` 参数域映射**：`adapters/src/config/schema.ts:65` 复用包内 schema 对象（不复制第二份字段表，`:336` 原样 re-export，`:51-64` 注释自陈理由）；`:435` 接入 patch；`adapters/src/config/index.ts:137-138` merge 整域透传；`:305` getAll 回落；`:427-428` getDefaultValue 显式登记（因此 `:262` 的 `throw Config key not found` 不会命中）。`DefaultRuntimeConfig` 有意不登记该域（默认值全靠 `.default()`），与 `magic-context-config.ts:77-79` 的读侧前提一致，**该前提经回读成立**。
- **strip vs reject 的三档并存**（证据包 §6.4）：顶层 `.passthrough()` / `magicContext` 子对象 strip / `mcp`·`hooks` strict —— 已回读确认。strip 对 `magicContext` 是**刻意**选择（`magic-context/src/host/config/schema.ts:139-145` 与 `adapters/src/config/file-config.adapter.ts:266-267` 有注释自陈，且 `test-magic-context-domain.mjs:146` 有断言）。**未列为 must-fix**：三种策略并存是文件既有结构，本次 diff 只新增了与既有风格一致的一档。

---