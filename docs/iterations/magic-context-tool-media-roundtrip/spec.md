---
date: 2026-11-28
---

# magic-context-tool-media-roundtrip 技术规格（SPEC）

> **v2（2026-11-28，第 1 轮审查后）**：三个审查者（全局 judge、包侧、bootstrap 侧）共报 3 个 P0、6 个 P1，全部是文档问题，方案方向被核对通过。已改：`mediaLayout` 的每一项保留**原块**（媒体块的 `dataUrl` 键保留、值置 `null`），还原时同键覆写，键序与原块逐字节一致——v1 写的「去掉 dataUrl 再尾插」会让 bootstrap `sameContent` 的 `JSON.stringify` 比较恒假，每 pass 误判已改写；「引用的 attachment 不存在」统一为只省略该媒体项、条目保留；T-M5 的 fixture 改为超过占位阈值；还原函数签名改为最小结构类型并新增返回类型别名；媒体判据与文本抽取口径逐条对齐 contracts 与既有 `contentText`；回归门禁改用 `node --test` 直跑 fork-inherit 脚本；T-M4 不再承诺先红。

> **v3（2026-11-28，第 2 轮审查后）**：三个审查者独立指出 v2 的同一处新错：layout 写成「原块对象本身 + 值置 null」，字面执行会就地改写 canonical 历史（entry 是零拷贝借用），第二个 pass 起媒体永久丢失。改为**原块的浅拷贝**，明文禁止突变宿主数据，风险表「base64 两份」改为一份，T-M1 加不可变断言。另：T-M5 里依赖 host 层的断言挪到 test-host.mjs（新 T-M6）；返回类型的 readonly 与 bootstrap 调用点之间写明 unknown 过渡；媒体判据改为与 contracts 逐字同构（大小写、分号、trim、dataUrl 口径）；还原规则补判别键与两分支共用的跳过语义；回滚补测试提交归属；去掉 lint 基线具体数字；修正三处引用行号；风险表一处编辑残片与一个文件名引用随后补正（第 3 轮三人结论为 Go / ready / ready；之后又按包侧 P2 钉死了运行时收窄口径、video 臂与 contracts 完全同构、补 tail-hygiene-walk 与测试脚本清单）。第 4 轮（全局 judge Go、包侧 ready）之后再修：风险表行首管道符、T-M2 的 fixture 分组、两个畸形角、priors 条目改写、红灯信号描述。

## 需求来源

用户口述（2026-11-28）：支持图片能力的模型调用 Read 工具读图片后仍然读不到图，只能靠发消息时的附件传图。经定位是 magic-context 宿主适配层在往返投影中把工具结果里的媒体块丢了。用户已拍板：

- 按方案一修：让工具结果的往返投影对称地保留非文本媒体块。
- 承载用上游 v1 的 `state.attachments` 形状，另带还原信息；LKG 输入指纹对 base64 用占位；视频同批修。
- ZCode 的 `core` / `contracts` / `adapters` 不改。

记忆文件：`docs/apm/memory/20261128-magic-context-tool-media-roundtrip.md`。

## 设计目标

- magic-context transform 开启时，带图片/视频/文件块的工具结果（Read 图片与视频、Read PDF、Bash 图片输出、node_repl `emitImage`、MCP 图片）活着到达模型输入层，行为与 transform 关闭时一致。
- 未被 transform 改写的工具结果条目在反投影后与原始条目内容逐字节等值并复用原对象；无媒体的工具结果条目的投影形状逐字节不变。唯一的例外是 `isError` 的结果（照旧只保留 error 文本）。
- 工具结果被 ctx_reduce 丢弃后媒体一并消失，不再发图、不再计费。
- 媒体按上游既有口径计入 token 估算；base64 不进 tags / source_contents，不进 LKG 输入指纹。
- 不改 `packages/core`、`packages/contracts`、`packages/adapters`；`magic-context/src/core`（上游逐字移植件）只动 LKG 指纹一处并登记 FORK 偏离。

## 现状与根因

| 环节 | 位置 | 行为 |
|---|---|---|
| Read 图片输出 | `core/src/tool/handlers/read.ts` `formatReadImageOutput`（约 100-115） | 返回 `[{type:"image", mediaType, dataUrl, source:{id:"read-image", placeholder:"Read image"}}]` |
| 工具结果入 runtime entry | `core/src/runtime/helpers/tool-result.ts:62-65`、`runtime/methods/turn-tools.ts:356-364` | `modelContent` 原样成为 `role:"tool"` 条目的 content，无文本化 |
| **正投影（丢图点 1）** | `magic-context/src/host/types.ts` `toolResultToPart`（约 322-338）+ `contentText` | 非字符串 content 只抽 text 块拼成 `state.output`，图片块无位置可放，纯图片结果 output 为 `""` |
| **反投影（丢图点 2）** | `bootstrap/src/app/magic-context-turn-transform.ts` `toolOutputOf`（722）、`isUnchanged`（739-782）、`rebuildEntry`（784-828） | 只认字符串 output；带媒体的结果 `sameContent` 恒假，每 pass 都 rebuild 成 `""` |
| provider 投影 | `adapters/src/model/transform.ts:198-215` | image 块 → AI SDK `image-data`；`@ai-sdk/anthropic@3.0.81` 转成原生 `tool_result` 内嵌 image block |
| 持久化 / 冷恢复 | `core/.../tool-result-media-persistence.ts`、`session-history-hydrator.ts:148-171` | base64 落 artifact store，恢复时重建块；canonical 历史里图片完好 |

反投影有三条路径都要过 `rebuildEntry`：正常（约 2194）、fail-open / passthrough（约 2278）、LKG 重放（约 2307，originals 为空、全部 rebuild）。

**不可动的边界（探索得出）**：

- `state.output` 必须保持 string。`tool-drop-target.ts:289` 的 `partHasCompletedResult` 以 `typeof output === "string"` 判定结果已到；`tag-part-guards.ts:32` 只给 string output 打标；`tag-messages.ts:1575/1584/1603` 对 output 直接做 `byteSize` / `stripTagPrefix` / `prependTag`。上游参照源的 `tag-part-guards.ts` 与移植版逐字相同。
- 上游 v1 的媒体契约就是 `state.attachments: [{mime, url, filename?}]`，移植版里已有配套：`image-token-estimate.ts` 的 `estimateToolAttachmentImageTokens` 按像素估 token（`tag-messages.ts:1585`、`final-wire-token-estimate.ts` 的 tool 分支、`tail-hygiene-walk.ts:740` 三处都调用）；`tool-drop-target.ts` 的 `skeletonRealToolPart`（139）与 `editMarkerToolPart`（206）在 `stripAttachments` 时置 `state.attachments = []`，`apply-operations.ts:94/104/414` 在 `hasAttachments()` 为真时传入 strip。
- tool tag 从不写 `source_contents`（`tag-messages.ts` 只在 1501、1649 行写 text 与 file）。
- `isUnchanged` 是 `rebuildEntry` 的严格镜像（doc 注释 727-738），两处必须同一提交改，否则每 pass 误判「已改写」，outcome 恒为 `applied`。
- `lkg-slot.ts` 的 `lkgContentFields` 对输入做全字段扁平化进指纹；`lkg-replay.ts` 的 `buildLkgPrefix` 产出的 `jsonPrefix` 是**重放输出**的序列化（`lkg-replay.ts:615-624` 解析回放），不能占位。
- bootstrap 的测试跑已构建的 `dist/`；`magic-context/scripts/test-transform.mjs` 每次现场编译 `src/core`（用例须注册在文件末尾循环之前）。

## 总体方案

### 承载形状（tool part 的 `state` 上）

```ts
state.output: string
  // 文本部分按 "\n\n" 拼接，抽取口径逐分支沿用 contentText（host/types.ts:340-350），纯媒体结果为 ""。只增不改。
state.attachments?: Array<{ mime: string; url: string; filename?: string }>
  // 上游 v1 同形。仅媒体块；mime := block.mediaType 原样；url := block.dataUrl 原样（同一字符串引用，不复制）。
  // 本实现不写 filename（保留上游形状字段，没有消费方）。
state.mediaLayout?: Array<{ attachment?: number; block: object }>
  // 与原始 content 的块一一对应、保持原序。每项的 block 是原块的**浅拷贝**（`{...block}`，保键序），
  // 绝不与宿主 message.content 里的块共享引用；媒体项另带 attachment = 它在 attachments 的下标，
  // 且只在拷贝上把 dataUrl 的值置 null（键保留）。
```

**不突变宿主数据**：runtime entry 是零拷贝借用（`borrowReadOnlyRuntimeEntries`，`host/types.ts:244-253` 只拷数组、永不拷嵌套条目），既有投影路径全部克隆块（`contentToParts` 的 `{...block}`，`:273-301`）。若 layout 持原块引用并就地置 null，canonical 历史会被改写：第二个 pass 起投影读到 `dataUrl: null`，媒体永久丢失，而 `isUnchanged` 反而判等并把带 null 的原对象发给模型。T-M1 用「投影后原 entry 的 `JSON.stringify` 不变、`layout.block !== 原块`」把这条钉进测试。

**为什么 block 保留 `dataUrl` 键而只置值**：bootstrap 的 `sameContent`（`magic-context-turn-transform.ts:712-720`）用 `JSON.stringify` 逐字节比较块，键序敏感。Read 图片原块键序是 `type, mediaType, dataUrl, source`（`read.ts:100-112`）；若把 dataUrl 整个删掉再在还原时尾插，键序变成 `type, mediaType, source, dataUrl`，`isUnchanged` 恒假，每 pass 重建、outcome 恒 `applied`。保留键位、同键覆写，还原出的对象与原块逐字节相同。

- 没有媒体块的工具结果：不写 `attachments`、不写 `mediaLayout`，投影形状与今天逐字节相同。
- `isError` 的工具结果：`toolResultToPart` 按 `message.isError === true` 跳过媒体收集，照旧只投影 error 文本，不写 `attachments` / `mediaLayout`（adapters 对 error 结果整体文本化）。
- 媒体判据对齐 `contracts/src/model/media-policy.ts:17-34`（包内不 import contracts）。只有一处刻意加严：候选门要求 `dataUrl` 为非空 string（contracts 的 image 臂不查 dataUrl，file 臂只查 `!== undefined`；空 dataUrl 的块 provider 侧本就会报错，不收）。候选块三条任一成立即媒体：
  - `type === "image"`；
  - `type === "file"` 且 `mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"` 且 `text === undefined || text.length === 0`；
  - (`type === "video"` 或 `type === "file"`) 且 `mediaType.toLowerCase().startsWith("video/")`。

  其余块（text、带非空 text 的 file、resource_link、reasoning、无 dataUrl 的 image/video、`mediaType` 不是 `video/*` 的 video 块等）不进 attachments，只在 layout 里保留浅拷贝，往返仍逐字节等值。
- 不新增对 `src/core` 的 drop 改动：上游已有的 `attachments = []` 就是丢弃语义。反投影遇到 layout 引用的 attachment 不存在时，**只省略该媒体项，条目与文本照常保留**（role `tool` 条目绝不能整条消失，否则留下孤立的工具调用，模型会拒收）。缺失只会出现在 `state.output !== base` 的分支：所有清空 attachments 的路径（`tool-drop-target.ts:139/206`）都同时把 output 换成 `[dropped §N§]`。

### 还原规则（唯一实现放包的 host 层）

在 `magic-context/src/host/types.ts` 新增并从 barrel 导出（登记进变更点清单）：

```ts
export type ZCodeToolResultContent = string | readonly ZCodeModelMessageContentBlock[];

toolResultContentOf(part: {
  state?: { output?: unknown; error?: unknown; attachments?: unknown; mediaLayout?: unknown };
}): ZCodeToolResultContent
```

参数是最小结构类型（bootstrap 侧的 `ToolPart` 字段全是 `unknown`，`magic-context-turn-transform.ts:595-601`，不能直接喂给 `ToolLikePart`），函数内部做运行时收窄，口径钉死为：块先过 `isRecord`（与 `contentText` 同谓词，`host/types.ts:341-343`），非记录块跳过、不进 layout（这样才能恒保持 `base === output`）；`mediaType` 不是 string 一律按非媒体；`attachments` 不是数组或 `attachments[i].url` 不是 string 时按缺失跳过该媒体项；`mediaLayout` 不是数组走第 1 条；`mediaLayout[i]` 本身非 record、或媒体项的 `block` 非 record 时整项跳过。`isError === true` 时省略 `attachments` / `mediaLayout` 两个键（不写空数组）。

**判别键与不变量**（两个分支共用）：layout 项是否媒体只看 `typeof item.attachment === "number"`（投影只给媒体块写这个键，非媒体项不写键，不写 `undefined`）；`attachments[i]` 不存在则**跳过该媒体项，两个分支同样生效**；`mediaLayout` 存在时 `state.output` 恒为 string（构造不变式，非 string 时按第 1 条回退）。

1. 无 `mediaLayout`（或它不是数组）→ 返回字符串，回退链与今天的 `toolOutputOf`（`:722-725`）同语义：`state.output` 是 string 则返回它；否则 `state.error` 是 string 则返回它；否则 `""`。
2. 有 `mediaLayout`：`base` = 按 layout 顺序、对每项 block 用与 `contentText` 相同的谓词抽出的文本按 `"\n\n"` 拼接（由构造保证 `base === state.output`，除非 transform 改写过）。
   - `state.output === base`（未被改写）→ 按 layout 逐项还原：非媒体项返回 `block`；媒体项返回 `{...block, dataUrl: attachments[i].url}`。
   - `state.output !== base`（被打上 `§N§` 前缀或被 drop）→ `[{type:"text", text: state.output}, ...按原序还原的媒体项]`。非媒体块不再单独出现：它们的文本已并入 output，不带文本的（resource_link 等）被丢弃——与今天的行为一致，属预期。

`bootstrap` 的 `isUnchanged` 与 `rebuildEntry` 都改为调用 `toolResultContentOf`，`toolOutputOf` 删除（全仓只有 `isUnchanged:763` 与 `rebuildEntry:799` 两个调用点）。`isUnchanged` 的 tool 分支：`sameContent(toolResultContentOf(only), source.content)`。返回的 `readonly ZCodeModelMessageContentBlock[]` 不能直接赋给 contracts 的 `ModelMessageContent`（可变数组、闭合联合），两个调用点都经一次 `as unknown as ModelMessageContent` 过渡（沿用 `:695` 的既有惯例，包仍不 import contracts）。

### LKG 输入指纹

`lkgContentFields` 遇到以 `data:` 开头且长度超过 1024 的字符串时（1×1 PNG 的 data URL 只有约 114 字符，不会也不需要占位），指纹里记 `data:<sha256(全文)>`，不展开原文。不同图片仍得到不同指纹，同一图片的指纹稳定；多张 MB 级 base64 不再撑大指纹 token 数组。`jsonPrefix`（重放输出）不动，仍带完整媒体，受既有 24MB/槽、64MB 总量预算约束。

### 涉及但不改的既有行为（写进预期，避免被当回归）

- 图片在后续每一轮都随历史重发，直到被 core 的 40MiB 媒体预算挤出，或模型 `inputFormat.supportsImage` 为 false 时被 `adapters/src/model/media-transform-policy.ts` 的 `unsupportedInputMediaText` 换成占位文本。这与 transform 关闭时一致。
- `session-inheritance.ts` 的 `toolKey(tool, output)`：纯图片结果 output 为 `""`，fork 继承时这类调用的锚点区分度下降。本次不处理，列为已知限制。
- 视频与 PDF 文件在 `estimateToolAttachmentImageTokens` 里不计 token（上游口径：只计 `image/*`）。本次不处理。
- `raw-message-provider.ts:186` 的读路径同样走 `projectRuntimeEntries`，historian 看到的 tool part 从此带 attachments，相关 token 估算会上升——媒体真的会上路，属正确行为。`tail-hygiene-walk.ts:740` 同理。
- LKG 的 per-session priors（64MB 上限，`lkg-replay.ts:74/111`）持有的正是 `lkgContentFields` 的产物（`lkg-replay.ts:78-81`、`:97-119`）。改动后投影里开始出现 base64，但 Step 2 的占位让超过 1024 的 `data:` 字符串不再进 fields，所以 priors 基本不会被 base64 撑大；≤1024 的短 `data:` 字符串仍原样保留，有界。
- `tool-drop-target.ts:607-608` 的 `measureReclaim` 调 `skeletonRealToolPart` 时不带 strip，估算里不含被 strip 的图片 token：回收信用偏小、应急驱逐偏保守。本改动让这条路径首次有实际媒体，方向保守，不处理。

## 最终项目结构

```
apps/zcode-cli/packages/magic-context/
  src/host/types.ts                         # ToolLikePart 增字段；toolResultToPart 带媒体；新增 toolResultContentOf
  src/index.ts                              # 导出 toolResultContentOf
  src/core/hooks/magic-context/lkg-slot.ts  # 指纹对 data URL 占位（FORK 登记）
  scripts/test-host.mjs                     # T-M1 ~ T-M3、T-M6
  scripts/test-transform.mjs                # T-M4、T-M5
apps/zcode-cli/packages/bootstrap/
  src/app/magic-context-turn-transform.ts   # isUnchanged / rebuildEntry 改用 toolResultContentOf
  scripts/test-tool-result-media-roundtrip.mjs   # 新建，T-H1 ~ T-H5
  package.json                              # test:tool-result-media-roundtrip
apps/zcode-cli/packages/adapters/
  scripts/test-tool-result-media-projection.mjs  # 新建（非阻塞），T-A1
  package.json                              # test:tool-result-media-projection
docs/
  iterations/magic-context-tool-media-roundtrip/spec.md
  apm/memory/20261128-magic-context-tool-media-roundtrip.md
```

## 变更点清单

| 文件 | 改动 |
|---|---|
| `magic-context/src/host/types.ts` | `ToolLikePart.state` 增 `attachments?`、`mediaLayout?`；新增类型别名 `ZCodeToolResultContent`；`toolResultToPart` 用新 helper 拆 content；新增 `toolResultContentOf`；每个改动点带 `FORK（magic-context-tool-media-roundtrip / Step N）` 注释说明为什么不能进 output |
| `magic-context/src/index.ts` | barrel 导出 `toolResultContentOf` 与 `ZCodeToolResultContent` |
| `magic-context/scripts/test-host.mjs` | T-M1 ~ T-M3、T-M6 |
| `magic-context/scripts/test-transform.mjs` | T-M4、T-M5（注册在末尾循环之前） |
| `magic-context/src/core/hooks/magic-context/lkg-slot.ts` | `lkgContentFields` 的 string 分支加 data URL 占位；文件内 FORK 注释块（源位置 / 上游语义 / ZCode 差异 / 改动面） |
| `bootstrap/src/app/magic-context-turn-transform.ts` | 删 `toolOutputOf`；`isUnchanged` tool 分支与 `rebuildEntry` tool 分支改用 `toolResultContentOf`；FORK 行内注释 |
| `bootstrap/scripts/test-tool-result-media-roundtrip.mjs` | 新建；结构仿 `test-mural-media-blocks.mjs`（dist 驱动、临时目录隔离、`MAGIC_CONTEXT_DB_DIR`） |
| `adapters/scripts/test-tool-result-media-projection.mjs` | 新建；结构仿 `test-tool-result-cache-control.mjs` |

## 详细实现步骤

- Step 1 — phase-host-projection — blocking: yes — qa: auto：`host/types.ts`。扩 `ToolLikePart` 类型；定义 `ZCodeToolResultContent`；写 `splitToolResultContent(content, isError)`（content → `{text, attachments?, mediaLayout?}`，layout 每项保留原块，文本抽取与 `contentText` 同谓词）与 `toolResultContentOf(part)`；`toolResultToPart` 改用它。纯文本条目产出必须与改前逐字节相同（T-M3）。已核实 `isToolPartWithOutput`（`tag-part-guards.ts:27-33`）只要求 `typeof output === "string"`、不要求非空：纯图片结果**会**被打标（output 变成 `"§N§ "` 一类），token 由 `estimateToolAttachmentImageTokens` 入账，属预期。
- Step 2 — phase-lkg-digest — blocking: yes — qa: auto：`lkg-slot.ts` 的 `lkgContentFields` string 分支加 data URL 占位（阈值 1024 字符、sha256）。该函数只用于输入指纹（全仓消费方仅 `lkg-replay.ts:80` 与 `lkg-slot.ts:365` 的 `lkgContentDigest`），不参与 `jsonPrefix`（`lkg-replay.ts:323-358`）。同文件的 `messageContentFields` / `signatureForFields` 是签名侧，刻意不动。登记 FORK 注释块，写明消费面全集。
- Step 3 — phase-host-reverse — blocking: yes — qa: auto：`magic-context-turn-transform.ts`。`isUnchanged` tool 分支与 `rebuildEntry` tool 分支改用 `toolResultContentOf`；删除 `toolOutputOf`；三条反投影路径（正常 / passthrough / LKG 重放）都经 `rebuildEntry`，无需分别改。
- Step 4 — phase-tests-package — blocking: yes — qa: auto：`test-host.mjs` 加 T-M1 ~ T-M3、T-M6；`test-transform.mjs` 加 T-M4、T-M5（注册在末尾循环之前；该脚本只编译 `src/core`，放不进依赖 host 层的断言）。先红后绿：T-M5 的指纹断言只依赖 `src/core`，按记忆 #314 串行——用例先落、对 HEAD 源码跑一次确认红，再落 Step 2；T-M1 ~ T-M3、T-M6 依赖新导出，对改前的 dist 跑时红在用例体内（`test-host.mjs:53-60` 是动态 import 后解构，缺导出只得到 `undefined`，调用时抛 TypeError，不是 import 链接失败），落 Step 1 后重建 dist 跑绿。T-M4 是锚定既有打标/计费行为的回归用例，在 HEAD 上本来就绿，不承诺红。
- Step 5 — phase-tests-bootstrap — blocking: yes — qa: auto：新建 `test-tool-result-media-roundtrip.mjs` 与 script；覆盖 T-H1 ~ T-H5。依赖先 build `@zcode/magic-context`、`@zcode/core`、`@zcode/bootstrap`。
- Step 6 — phase-adapters-regression — blocking: no — qa: auto：新建 `test-tool-result-media-projection.mjs`（T-A1），锁定「anthropic → image-data、openai-chat-completions → 后置 user、supportsImage=false → omitted 文本、video → 强制 textify」的既有契约。adapters 源码不改。
- Step 7 — phase-gates — blocking: yes — qa: auto：`pnpm --filter @zcode/magic-context build` 等三包 build → `pnpm --dir apps/zcode-cli exec node ../../node_modules/turbo/bin/turbo run typecheck` → 根 `pnpm typecheck` / `pnpm lint`（warning 数不高于当前基线、0 error）→ apps/zcode-cli 包内 oxfmt（改动文件零新增不合规，`src/core/` 豁免）→ 改动文件归一 LF → 回归：magic-context `test:all`、bootstrap `test:magic-context`、`test:mural-media-blocks`、新建的 `test:tool-result-media-roundtrip`，以及 `cd apps/zcode-cli/packages/bootstrap && node --test scripts/test-magic-context-fork-inherit.mjs`（该文件没有 npm script 入口，直跑）。
- Step 8 — phase-real-verify — blocking: no — qa: manual_user：桌面真机（记忆 #302 / #315 的隔离与启动要点）：用支持图片的模型让它 Read 一张 PNG，确认模型能描述图片内容；查 `~/.omz/cli/debug/model-io-<sessionId>.jsonl` 末条请求的 `request.body.messages`，`tool_result` 的 content 里应出现 `[data omitted from model-io: image/png, N chars]`，修复前该处只有空文本。先确认该模型配置 `properties.inputFormat.supportsImage === true`。

## 测试策略

### 测试用例

包侧（`magic-context/scripts/test-host.mjs`，吃 dist）。所有「等值」断言用 `JSON.stringify` 逐字节比较，`deepStrictEqual` 对键序不敏感、会放过 v1 的键序缺陷：

- T-M1 — blocking: yes — `projectRuntimeEntry` 输入 `role:"tool"`、content 为单个 image 块（键序 `type, mediaType, dataUrl, source`）：`parts[0].state.output === ""`，`state.attachments` 为 `[{mime, url: dataUrl}]`，`state.mediaLayout` 为 `[{attachment: 0, block}]` 且 `block.dataUrl === null`、`block` 的键序与原块相同（`Object.keys` 相等、`block !== 原块`）；投影后原 entry 的 `JSON.stringify` 不变；`toolResultContentOf` 的 `JSON.stringify` 结果与原 content 相同。（Step 1）
- T-M2 — blocking: yes — content 为 `[text, file(application/pdf, dataUrl), image]`：output 等于 text 块，attachments 顺序为 `[pdf, image]`，layout 三项与原序一致；`toolResultContentOf` 的 `JSON.stringify` 结果与原 content 相同。另覆盖两组形态，每组都断言 attachments 的内容与 `toolResultContentOf` 的逐字节等值。（1）**收进 attachments**：`[image, text, text]`（node_repl 形态）、`[text, video]`（Read 视频，`read.ts:120-129`）、`file` + `video/*` 块、`mediaType: "Application/PDF; charset=binary"` 的 file 块（大小写与分号不敏感，命中 pdf 臂）。（2）**留在 layout、不进 attachments**：无 `dataUrl` 的 image 块、`dataUrl` 为空串的 file 块、`mediaType` 为 `audio/mp4` 的 video 块、带非空 `text` 的 pdf file 块。（Step 1）
- T-M6 — blocking: yes — 手工构造带 `mediaLayout` 与 `attachments` 的 part，把 `state.output` 换成 `[dropped §N§]`、`attachments` 置 `[]`：`toolResultContentOf` 结果为 `[{type:"text", text:"[dropped §N§]"}]`，不含任何媒体块。（Step 1、Step 4）
- T-M3 — blocking: yes — content 为 string、以及 `[text, text]`：part 上没有 `attachments` / `mediaLayout` 键，`JSON.stringify(part)` 与改前快照相同；`toolResultContentOf` 返回字符串 output。（Step 1）

包侧（`magic-context/scripts/test-transform.mjs`，现场编译）：

- T-M4 — blocking: yes — 手工构造带 `attachments` 的 tool part 走完打标（锚定既有行为，HEAD 上即绿）：`output` 带 `§N§` 前缀，`attachments` 与 `mediaLayout` 原样保留；同一 pass 内构造第二个同文本、无附件的 tool part（fixture 的附件用 `image/*` mime，只有图片会计 token），前者的 `token_count` 大于后者；`tags` 与 `source_contents` 表里没有任何 base64 片段。（Step 4）
- T-M5 — blocking: yes — 手工构造带 `attachments` 的 tool part 被真实 drop 路径处理后 `state.attachments` 为 `[]`、`state.output` 为 `[dropped §N§]`（还原断言在 T-M6）。LKG：fixture 用长度超过 1024 的 data URL（在合法 PNG base64 末尾填充后拼成，或直接用一张真实小截图）；`lkgContentFields` 对两张不同的图给出不同指纹、同一张给出相同指纹，且返回的 fields 数组里没有任何以 `data:image` 开头的长字符串；长度 ≤ 1024 的 `data:` 字符串（如 1×1 PNG）不占位、原样进 fields；`buildLkgPrefix` 的 `jsonPrefix` 解析后仍含完整 dataUrl。（Step 2、Step 4）

宿主侧（`bootstrap/scripts/test-tool-result-media-roundtrip.mjs`，吃 dist，桩 transform）：

- T-H1 — blocking: yes — 原样往返：Read 图片条目（`[image]`，带 `source.id: "read-image"`）经未改写它的 transform 后，返回的条目 `===` 原对象（身份断言，防每 pass 重建），且其 `content` 的 `JSON.stringify` 与原始相同。（Step 3、Step 5）
- T-H2 — blocking: yes — 重建路径：桩 transform 改写投影消息的 `info.id`，使 `originals` 里找不到原条目（等价于 LKG 重放路径的「全部重建」），`[text, image]` 条目还原出同样的两块、顺序与键序不变；桩 transform 再给 `state.output` 前插 `§N§ ` 后，还原为 `[{text: "§N§ …"}, image]`。（Step 3、Step 5）
- T-H3 — blocking: yes — 丢弃：桩 transform 把该 part 的 output 换成 `[dropped §N§]` 并把 attachments 置 `[]`，返回条目 content 为 `[{type:"text", text:"[dropped §N§]"}]`（字符串 `"[dropped §N§]"` 亦视为等价），不含任何 image 块。（Step 3、Step 5）
- T-H4 — blocking: yes — 同批媒体与零回归：video 块、`[text, file(application/pdf)]`（Read PDF）、无 `source` 的 image 块（Bash / MCP）都按 T-H1 往返等值并复用原对象；纯文本工具结果条目在 transform 未改动时仍是原对象，形状与改前一致。（Step 3、Step 5）
- T-H5 — blocking: yes — error 工具结果（`isError: true`，content 含 image 块与 text 块）：part 不带 `attachments` / `mediaLayout`，还原为 error 文本；output 非 string 且 `state.error` 为 string 的 part 还原为该 error 文本；两者都非 string 时还原为 `""`，不抛错。（Step 1、Step 3、Step 5）

adapters（`adapters/scripts/test-tool-result-media-projection.mjs`，吃 dist）：

- T-A1 — blocking: no — `toAiSdkMessages` 对带 image 的 tool 结果：`providerKind: "anthropic"` 产出 `tool-result` 的 `output.type === "content"` 且含 `image-data`；`apiFormat: "openai-chat-completions"` 产出 `"Tool result media from X:"` 后置 user 消息；`inputFormat.supportsImage === false` 时文本含 `Media omitted from provider request`；带 video 的结果在 anthropic 下也走后置 user。（Step 6）

回归（既有套件必须保持全绿）：magic-context `test:all`、bootstrap `test:magic-context`（23 条）、`test:mural-media-blocks`（5 条）、`node --test scripts/test-magic-context-fork-inherit.mjs`。（Step 7）

真机：

- T-E1 — blocking: no — qa: manual_user — Step 8 的桌面验收。

## 风险与回滚方案

| 风险 | 处置 |
|---|---|
| 改后 `isUnchanged` 仍判不等，每 pass rebuild、outcome 恒 `applied` | 承载形状里 block 保留 `dataUrl` 键位（v2 的根因修复）；T-H1 / T-H4 断言返回条目 `===` 原对象（transform 未改动时），所有等值断言用 `JSON.stringify` |
| 打标后 output 为 `"§N§ "` 这类近空文本进模型 | 与今天文本结果被打标的形态一致；模型看到章号后紧跟图片，属预期（已核实 `isToolPartWithOutput` 不要求非空，纯图片结果会打标） |
| `jsonPrefix`（重放输出）带完整媒体（`mediaLayout[].block.dataUrl` 是 null，base64 只在 `attachments[].url` 出现一份），撑大 LKG 槽 | 受既有 24MB/槽、64MB 总量预算约束，超限走既有失效路径；不占位，否则重放丢图。真机若观察到 LKG 频繁失效再单独立项 |
| legacy `truncateToolPart`（`tool-drop-target.ts:163-187`）不清 attachments | 存量 legacy 被裁条目的媒体会随还原重新上路（`apply-operations.ts:101-103` 注释自陈 older skeleton modes still replay their media）；新 drop 全部按 `hasAttachments()` 传 strip，不产生新增 |
| fork 继承锚点区分度下降（纯图片结果 output 为 `""`） | 已知限制，本次不改；`session-inheritance` 命中率若明显下降在 `test-magic-context-fork-inherit.mjs` 里可见 |
| 旧会话 | 冷恢复靠 artifact store + `modelContentLayout`，与本次改动无关；缺 layout 的存量行仍只能拿到占位文本 |
| LKG 指纹占位改变存量会话的输入指纹 | 属安全失效：旧槽匹配不上，走一次完整 transform 后重建 |

回滚：改动分两个提交——包侧（Step 1、2）与 bootstrap 侧（Step 3），测试另成提交（Step 4-6）。合法的回滚组合只有两种：单独 revert bootstrap 侧（行为等同修复前：旧反投影只读 `state.output`，新字段被忽略），或包侧与 bootstrap 侧同批 revert。测试提交随对应的 impl 提交同批 revert（否则 T-H1 的 `===` 断言与包侧导出的 import 都会红）。**不能单独 revert 包侧**：bootstrap 的 `toolResultContentOf` import 会在模块加载期失败（对已构建 dist 的组合是运行时链接错误，不是构建期），不会静默但会起不来。两侧必须同批发布。
