# ToolSearch 落地前置推演：turn-loop 插入缝等价性证明（Step 20a / T-TS0）

- 迭代：upstream-v316-fullsync；phase-toolsearch（P8）
- 上游快照：D:\Dev\Js\oh-my-zcode\.reference\ZCode（v3.16.2）
- 结论：**推演通过，phase 不停**；但 spec 预定缝序「MC transform → 工具暴露决策 → 投影」**不可行**，
  落地序修正为「工具暴露决策 → 公告提交 → MC transform → 投影」，证据见 §3。
- 判定日期：2026-10-22

## 1. 两侧缝的形态

### 上游（v3.16.2，core/src/runtime/methods/turn-loop.ts）

```
工具收集 getTurnTools → [混入物: refreshOffPeak/agentListing/microcompact/rapidRefill]
→ buildToolSearchAnnouncement(...) → persistRuntimeReminderMessage（落盘！混入物）+ commitTurnRequestEntries
→ prepareRuntimeProviderRequest(this, {model, tools, registry, entries, applyCacheControl})
     ├─ buildToolExposure: 目录分类 + defer 判定 + 工具过滤/deferLoading + projectToolReferences（改写 entries）
     └─ buildRuntimeProviderRequestMessages: 投影（吃 exposure.entries + loadedToolCallIds）
→ runModelBackedTurnStep({tools: prepared.request.tools, toolSearch: prepared.toolSearch})
```

上游无 Magic Context：`prepareRuntimeProviderRequest` 把「暴露决策+投影」内化为一步。

### omz（本仓 HEAD，turn-loop.ts）

```
:61-65 工具收集（getTools + disallowlist 过滤）→ 各 reminder 提交 →
:114  providerEntries 快照 →
:119  runMagicContextTurnTransform（MC 缝，flag off 时逐引用等值直通）→
:131  providerProjection（cache-control 后置）→
:137  recordableEntries 过滤 → :141 recordableProjection（双投影同源不变量）
```

omz 缝的意义（Step 19b 注释）：transform 在双投影之前跑一次，两条投影看到同一份字节。

## 2. 判定一：MC 需要看到 deferred 工具吗 → **不需要，MC 不受暴露决策影响**

证据（读源码，未改 MC 包）：

1. `core/src/runtime/helpers/magic-context-turn-transform.ts`：`MagicContextTurnTransformInput`
   只有 `entries / model / sessionId / workingDirectory`——**没有 tools 字段**。MC transform
   的每次 pass 看不到工具集，暴露决策前后 MC 输入不变。
2. MC 包三端口（transform / provider / historian）均不注册工具描述：包内无 `registry` /
   `ModelToolContract` 消费；`getToolSetHash` 只用 turn-loop 传入的 model 标识刷键
   （bootstrap 装配注释「liveModelBySession / getModelKey / getToolSetHash 每 pass 用
   turn-loop 传入的 model 刷新」），不枚举工具。
3. MC 自有工具（ctx_*）是 core registry 里的普通内置条目：无 `mcpPresentation`、
   omz 化分类表下不声明 `shouldDefer`（见 §5），`isDeferredTool` 判 false → 恒常驻。
   暴露决策对 MC 工具面零改动。

结论：暴露决策与 MC transform 之间**无数据依赖经 tools 通道**；唯一共享通道是
`entries`（见 §3）。

## 3. 判定二：缝序——spec 预定序不可行，落地序修正

### 3.1 反例：暴露决策放在 MC transform 之后会打穿 local 模式

MC 正投影（包内 `host/types.ts: toolResultToPart`）把 `role:"tool"` 条目的
content 经 `contentText` **文本化**：只有 `text` 块的文字被保留拼接；
`tool_reference` 块（`{type:"tool_reference", toolName}`，无 text/content 字段）
**直接丢弃**。反投影（bootstrap `rebuildEntry`）把 tool 结果重建为
`content: string`。
（2026-10-24 勘误：MC 正投影已改为保留含 `tool_reference` 的块数组，见 §3.3；
本段保留为当时的推演依据，落地序不回退。）

推演：若按 spec 预定序「MC transform → 暴露决策 → 投影」：

1. 模型调用 ToolSearch，executor 产出 `formatModelContent` = tool_reference 块数组，
   以块数组进入 canonical（turnRequestState.entries）。
2. 下一 model step：`requestEntries = MC(providerEntries)`——本轮 ToolSearch 结果的
   块数组被文本化为**空串**（tool_reference 无文字）。
3. 暴露决策的 `projectToolReferences` 在 requestEntries 上找不到 tool_reference 块
   → `<functions>` 定义展开**永不发生**，模型收到空工具结果。local 模式在 MC
   开启（默认开）时全断。

### 3.2 落地序（修正案）及其等价性

```
工具收集（:61-65，保持上游语义：暴露前 tools 用于 reminder 判定）
→ providerEntries 快照（:114）
→ 暴露决策 buildToolExposure（读 canonical entries，块完整）
→ 公告 buildToolSearchAnnouncement → commitTurnRequestEntries（仅内存，D4）
→ MC transform([...exposure.entries, announcement])
→ 双投影（吃 MC 输出，同源不变量保持）
→ runModelBackedTurnStep({tools: exposure.tools, toolSearch: exposure.context})
```

逐条等价性：

| # | 断言 | 依据 |
| - | ---- | ---- |
| a | local 模式存活 | 暴露决策先展开：`<functions>` 定义以 **text 块**进入 entries；MC 文本化只把同条目 text 块合并为字符串，定义文字到达模型 |
| b | default（mode off）逐字节等价 | mode off 时 exposure = 恒等：tools 全量透传（剥离 deferLoading）、entries 无 tool_reference 块（omz 无 ToolSearch 调用）、`projectToolReferences(mode off)` 对无公告历史逐引用共享原对象；无公告提交。MC/双投影与现状完全一致 |
| c | MC 输入仍与模型可见集同源 | 暴露决策后的 entries 即模型将看到的对话（加公告）；MC 的舱位/drop 决策基于真实请求字节，比预定序（基于已失真字节）**更**准确 |
| d | MC cache 前缀稳定 | `projectToolReferences` 对未改写条目**原引用共享**（history.ts `projected.push(entry)`）；MC `isUnchanged` 复用原 entry 对象的条件不被破坏 |
| e | 双投影同源（Step 19b 不变量） | 两投影都吃 MC 输出数组；改动不触碰 :131/:141 的关系 |
| f | 公告可见性与 omz reminder 族一致 | 公告在 MC 之前提交（同 plan_mode_exit/runtime_mode/output_style）：MC 可见、可按既有 tag/drop 语义处置；delta 扫描读 canonical（含上轮公告），公告 source 登记 per-request 组、不落盘 |

### 3.3 native 模式 × MC：引用保留（正投影与反投影已闭合）

native 模式依赖 tool_reference 块原样到达 Anthropic 服务端展开。原推演结论是 MC 正投影
对 role:"tool" 块数组一律文本化（§3.1），native 引用块在 MC pass 后必失。2026-10-24
同时修正 MC 正投影与 bootstrap 反投影后，该结论两端都不再成立，**端到端已闭合**：

- **已修（MC 包）**：`apps/zcode-cli/packages/magic-context/src/host/types.ts` 的
  `toolResultToPart` 在块数组含 `{type:"tool_reference"}` 时把 `state.output` 设为逐块
  浅拷贝的原数组（顺序/内容不变），纯文本与媒体块数组仍走 `contentText`；
  `core/hooks/magic-context/tool-drop-target.ts` 的 `partHasCompletedResult` 把数组输出
  也算作闭合结果，避免结构化结果被误判为调用中间态、拆成两个 composite key。两处改动
  均带 `FORK` 注释。
- **已补（bootstrap 反投影，2026-10-24）**：`apps/zcode-cli/packages/bootstrap/src/app/
  magic-context/projection.ts`（拆分后旧文件 `app/magic-context-turn-transform.ts` 只剩 160 行
  工厂门面，旧指针 `:724-727`/`:760-766`/`:821-834` 全部失效）。`toolOutputContentOf`(:176-193) 是新增的块数组策略：纯文本块按正投影
  `contentText` 的同一规则以 `"\n\n"` 还原为字符串，出现任何非文本记录块（`tool_reference` /
  image / 未来块）则整段按原序浅拷贝**结构化保留**（不文本化、不丢），畸形项（非对象、
  `type:"text"` 但 text 非字符串）显式丢弃并在注释里写明理由；`toolOutputOf`(:199-204) 字符串
  与 `state.error` 路径逐字节不变、数组走上述策略；`isUnchanged` 的工具分支(:242) 因此能在
  内容一致时判未改动（原 entry 逐引用复用、cache 前缀不抖），`rebuildEntry`(:304) 重建时写回的
  是文本或块数组而不再是 `content:""`；`status === "error"` 仍映射 `isError`。**端到端保住
  文本与引用**。
- **回归**：
  1. `apps/zcode-cli/packages/magic-context/scripts/test-tool-reference-projection.mjs`
     （T-TR1 引用块存活、T-TR2 纯文本仍文本化，2/2），登记为该包
     `test:tool-reference-projection` 并挂入 `test:all`；
  2. `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-tool-reference-roundtrip.mjs`
     （T-RT1..T-RT7：string 往返 / 纯文本块还原 / 纯引用块保留 / 混合两者都在 / isUnchanged
     判定 / 畸形与未知 type 块的显式策略 / error 状态保 isError，7/7），登记为 bootstrap
     `test:tool-reference-roundtrip` 并追加到根 `test:v4-perf` 末尾。该脚本直接以 Node 原生
     类型剥离加载 `projection.ts` 源码（不读 `dist/`），避免忘 build 时测旧产物。
- **升级 magic-context 需 rebase**：上述 FORK 改动偏离上游 v3.16.2，升级 MC 包时必须重放
  并复跑上述脚本，不能直接以新版本覆盖。
- omz 化政策不变：local 模式为 omz 主推形态（任意 provider 可用）；native 仅
  anthropic-messages 协议可用（`resolveToolSearchCapability.protocolSupported`）。
- `resolveToolSearchMode` 的 native 校验、auto 降级逻辑照搬上游（capability 缺失时
  native 报错 / auto 回退 local/off），不因 MC 添加隐藏 gate——MC 是会话内可关的
  独立功能面，交叠行为显式登记优于隐式互斥。

### 3.4 公告块注入时序与持久层

- 公告 entry 由 `commitTurnRequestEntries` 进入 turnRequestState（内存），随双投影
  上路；**不调用** `persistRuntimeReminderMessage`（混入物不迁）、不进 session 落盘、
  不进 hydrator。D4 渗入 = 0。
- 代价（已接受）：fork/resume/重启后公告事实清零，deferred 集合重新全量公告一次
  （多一条 reminder，非错误）；上游为此落盘的增量防重语义在 omz 会话内
  （同 runtime 进程）由 canonical entries 里的公告 metadata 维持。

## 4. 判定三：公告块不进持久层的投影层承载

- `RuntimeMessageMetadata` 增可选 `toolSearchAnnouncement?: {addedNames; removedNames;
  readdedNames}`（内存内 delta 事实）+ `RuntimeMessageSource` 增
  `tool_search_announcement`（system-reminder per-request 组，
  descriptor(current_turn/per_current_turn/isMeta)——投影 wrap/reorder 必需，缺席即
  `renderProjectedEntryToModelMessage` throw）。
- 上游把它登记在 PERSISTED 组（resume_history）+ hydrator schema + compactBoundary
  联动，全部不迁（D4）；omz 的 mode off 回退剥离由 `projectToolReferences(mode off)`
  按 metadata 识别公告条目完成（纯内存投影行为）。

## 5. 判定四：shouldDefer 分类表（omz 自研工具 defer 政策）

判定入口 = `isDeferredTool(tool, metadata)`（tool/search/exposure.ts，照搬上游公式）：

```
非 ToolSearch/DeferredToolCall 本体
且 非 providerNative
且 metadata.alwaysLoad !== true
且（metadata.shouldDefer === true 或 metadata.mcpPresentation !== undefined）
```

omz 显式分类表（落在 exposure.ts 头注释 + 本表）：

| 类别 | shouldDefer | 判定来源 | 结果 |
| ---- | ----------- | -------- | ---- |
| 内置核心工具（Read/Edit/Write/Bash/Grep/Glob/Todo*/Agent/Workflow/ctx_*/guarded/ 等全部自研面） | 不声明（omz 不迁上游 ~28 处 handler 级 `shouldDefer: true` 标注） | 无 mcpPresentation、无 shouldDefer | **恒常驻**，不入目录 defer 集 |
| MCP 工具 | core/src/mcp/index.ts 注册时声明 `shouldDefer: true`（照搬上游 MCP 集成点） | mcpPresentation 全量在场（omz 既有 UI 投影来源） | **默认 defer**；`alwaysLoad`（server 配置/`_meta["anthropic/alwaysLoad"]`）豁免回常驻 |
| ToolSearch / DeferredToolCall 控制入口 | —（isDeferredTool 硬排除） | enabled/mode 决定暴露 | 永不被 defer |

即：上游公式天然实现 omz 政策——**builtin 侧零标注 = 零 defer，MCP 侧注册点一处声明 =
全量 defer**；分类表以「不迁上游 handler 标注 + MCP 注册点声明」落地，无需新判定层。

## 6. 混入物隔离清单（不迁三件）

| 上游混入物 | omz 处置 |
| ---------- | -------- |
| `refreshOffPeakTurnAfterTakeover`（off-peak/turn.ts） | 不迁；omz 无 off-peak 面 |
| `persistRuntimeReminderMessage` + `buildProjectionAnchor` | 不迁；公告仅 `commitTurnRequestEntries`（§3.4） |
| message-history D4 字段（modelCallWrapper/toModelToolCall/compactBoundary.preCompactDiscoveredTools 落盘/hydrator schema） | 不迁；`resolveDeferredToolCall` 移植时去掉 modelCallWrapper 标记（解包后直接以目标名执行，结果条目 toolName=目标名，provider 按 toolCallId 配对） |

## 7. 生效面与回滚

- 生效条件：`config.toolSearch.mode ≠ off` **且** 目录内存在 deferred 工具（MCP）。
  omz 默认 mode=off：全部改动处于休眠态，既有会话/请求字节零变化（断言 b）。
- 回滚 = revert toolsearch 提交组；MC/turn-loop 接缝处为纯插入（不改 :119/:131/:141
  既有行序），revert 后无残迹。
