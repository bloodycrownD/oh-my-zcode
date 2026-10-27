# CR Fix Spec: 编辑态 / 队列 mention 胶囊恢复（fix/composer-mention-restore）

## 元信息

- repo：D:\Dev\Js\oh-my-zcode
- base_sha：`9c6322da`（main） / head_sha：`25d4be5c`（fix/composer-mention-restore）
- 提交：`f2019413`（编辑态胶囊恢复）→ `ef39230c`（盘符误判修复）→ `25d4be5c`（队列项渲染胶囊）
- prd_path / spec_path：未提供（缺陷修复，无业务 spec）
- 评审模式：diff（单轮 readonly 子代理评审 → 主代理落盘）
- review_round：1 / dag_version：1
- 状态：**draft**（待用户确认后转 fix-spec-ready）

## 已核实的背景

用户缺陷：从消息或提示词队列重新编辑时，编辑器里的 skill / 文件胶囊消失，显示成
`[$skill](C:\\...\\SKILL.md)` 字面量。修复把「文本恢复」从纯 TextNode 改为按 markdown
反解并重建 `PromptMentionNode`，已真机验证有效。

本轮评审要回答的是「这个修法是否还有未覆盖的入口和未收窄的判据」。

---

## Must-fix（按 P0 → P1 → P2）

### B-1 [P1] 提示词历史回填仍是纯文本重建，胶囊在同一条路径上二次退化

- 维度：B（正确性）/ C-orch（同语义多路径）
- 文件：`packages/ui/src/LexicalChatInput.tsx:1019-1043`（`applyHistoryEntry`，关键在 `:1026-1040`）
- 问题：本分支把「恢复」都换成了 `setTextWithMentions`，但 `PromptHistoryPlugin` 的历史
  回填仍自带一段 `root.clear()` + `for (const line of nextValue.split("\n\n")) paragraph.append($createTextNode(line))`。
  而历史条目保存的就是编辑器 markdown（`ConversationComposer.tsx:1117` 取 `textRef.current.trim()`，
  `:1228` 写入 `appendPromptHistoryEntry`，`lib/promptHistory.ts:16-28` 原样存）。
  复现：发一条带 `[$brain-storm](C:\\...\\SKILL.md)` 的 prompt → 输入框被 `resetEditor` 清空 → 按 ↑
  → 编辑器出现字面量。这是主输入框的常用交互（`LexicalChatInput.tsx:1485` 挂主导航）。
- 改法：把 `replaceEditorTextWithMentions` 的段落循环抽成模块级 `$replaceRootWithPromptMarkdown(root, text)`
  （内部用 `parseMentionMarkdownParts` 建段落 + mention 节点），`replaceEditorTextWithMentions` 与
  `applyHistoryEntry` 共用。`applyHistoryEntry` **必须继续传 `HISTORY_NAVIGATION_UPDATE_TAG`**
  （不能换 `PROGRAMMATIC_UPDATE_TAG`，否则 `SlashCommandPlugin` 会误开 `/` 面板，见
  `lib/editorUpdateTags.ts:4-11`）。顺带消掉 `split("\n\n")` 的三份复制（`:195`、`:214`、`:1030`）。
- 验收/测试：发含 `[$x](path)` / `[@a.ts](./a.ts)` / `[@L](plugin://id)` 的 prompt → 按 ↑ 后
  `data-mention-id` 节点数 > 0 且 `getMarkdown()` 与该条历史逐字节相等；再按 ↓ 回空态。
  源码形状守卫（`packages/ui/test/` 下现有 guard 同款）断言 `applyHistoryEntry` 内不得出现裸
  `$createTextNode(line)`。
- 来源：review-diff / round 1

### B-2a [P1] `#锚点` 与空 destination 被反解成文件胶囊，编辑态可见文字被改写

- 维度：B（正确性）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:296-307`（`mentionPartFromLink` 的
  file/directory 兜底）
- 问题：`[见上文](#commit-3)` 走到兜底分支：`DESTINATION_PROTOCOL_PATTERN` 不命中、非 `$`，
  判成 file，`data.path = "#commit-3"`。`PromptMentionNode.displayLabel`
  （`nodes/PromptMentionNode.ts:19-26`）对 files 走
  `resolveFileDisplayDescriptor(path).fileName`，而 `.fileName = getPathLeaf(path)`
  （`lib/fileDisplay.tsx:121-122`、`lib/path.ts:5-9`），`#commit-3` 没有 `/` 分隔，原样返回。
  结果：点一下编辑，可见文字从「见上文」变成「#commit-3」+ 文件图标。markdown 仍原样保存
  （不会改写入库内容），但这正是 `mentionMarkdown.ts:348-353` 声明要避免的。`[x]()`（空 destination）
  同理会生成 `value: ""` 的胶囊。
- 改法：兜底分支前加窄判据——`destination === ""` 或 `destination.startsWith("#")`（非 `#sess_`，
  后者已在前分支返回）→ 返回 `null`，整段保持文本。不要顺手放宽成「只认 `./` 开头」，那会漏掉
  `buildFileMentionMarkdown` 产出的绝对路径形态（`/Users/...`、`C:/...`）。
- 验收/测试：`mentionMarkdownParts.test.ts` 补两例——`[见上文](#anchor)` 无 mention 且往返相等；
  `[x]()` 无 mention。
- 来源：review-diff / round 1

### B-2b [P1] 气泡解析器无协议判据，队列行会把 URL 渲染成文件/文件夹 chip

- 维度：B（正确性）/ H（兼容性）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:205-213`（`parseMentionMarkdown` 的
  file/directory 兜底）；新消费者 `packages/ui/src/v4/ConversationQueueRow.tsx:127-129`
  → `packages/ui/src/v4/ConversationUserInputContent.tsx:75-88`
- 问题：`parseMentionMarkdown` 的兜底与 B-2a 同形，但**完全没有协议判据**：`[Google](https://google.com)`
  变成 `{type:"file"}`；`[docs](https://example.com/)` 因末尾 `/` 被 `isDirectoryMentionDestination`
  判成**文件夹**。气泡里这属于既有渲染噪声，但 `25d4be5c` 把队列行接到了这个解析器上，
  于是队列行从「显示 markdown 字面量」变成「显示假文件 chip」——同一 PR 内与
  `f2019413` 的「外链必须保持纯文本」自相矛盾（该条已用单测 `non-plugin external links stay plain text` 钉住）。
- 改法：把链接分类收敛成单一函数（例如 `classifyMentionLink(label, destination)` 返回
  `{category, value, data} | null`），规则与 `mentionPartFromLink` 完全一致：非法/空/`#` 非 sess/
  命中 `DESTINATION_PROTOCOL_PATTERN`（盘符除外）/非法 `plugin://` → `null`。`parseMentionMarkdown`
  与 `mentionPartFromLink` 都调用它，消除两套判据漂移。气泡侧只取 `label` 出 `MentionTextPart`。
- 验收/测试：单测补 `parseMentionMarkdown("[Google](https://x)")` 不含 `file`/`directory` 分片；
  队列行手工验收——排队一条含 `[Google](https://google.com)` 的 prompt，行内应显示原文，
  不出现「Google + 文件图标」。**PR 说明需点出：这会改变消息气泡对 URL 的既有渲染（修 bug，不是回归）。**
- 来源：review-diff / round 1

### G-1 [P2] 新增 11 例单测没有接进任何门禁，永远不会被执行

- 维度：G（测试）
- 文件：`packages/ui/test/mentionMarkdownParts.test.ts`（新）；根 `package.json:33`（`test:v4-perf`）
- 问题：`git grep mentionMarkdownParts` 零命中。`packages/ui/package.json` 只有 `lint`；
  `tsconfig.test.json` 只把它纳入 typecheck（`include: ["test/**/*.ts"]`），不运行。
  提交说明里的验证是一次性手敲命令，行为约束在实际门禁里裸奔。
- 改法：把 `packages/ui/test/mentionMarkdownParts.test.ts` 追加到根 `package.json` 的
  `test:v4-perf` 第一段 `tsx --test ...` 列表（该段已在跑 `chatPromptEditorSubmitValue.test.ts` 等 ui 用例）。
- 验收/测试：`pnpm test:v4-perf` 的 `# pass` 增加 11；再把 `DESTINATION_PROTOCOL_PATTERN`
  临时改回 `*`（≥1 字符），确认该链变红——否则等于没接。
- 来源：review-diff / round 1

### C-1 [P2] 两处注释/日志与实现不符

- 维度：C（质量）/ F（注释）
- 文件：
  - `packages/ui/src/LexicalChatInput.tsx:223-225`
  - `packages/ui/src/v4/ConversationComposer.tsx:954`
- 问题：
  1. 注释称「provider 的 id 形态同为 `category:value`」，实际 provider 用**单数**前缀：
     `file:${relativePath}`（`fileMentionProvider.ts:11`）、`skill:${skill.id}`
     （`skillsMentionProvider.ts:44`）、`session:`（`sessionsMentionProvider.ts:67`）、
     `subagent:`（`subagentsMentionProvider.ts:55`）、`plugin:`（`pluginsMentionProvider.ts:66`）；
     本处是 `${part.category}:` 即复数。运行时无后果（`mentionId` 只写 `data-mention-id`，
     唯一读取方 `selectAfterPromptMentionById`（`LexicalChatInput.tsx:474-495`）拿 DOM 同值回查同一节点；
     `decoratePromptMention` 只用 category/value/data），但注释把「故意不一致」写成了「相同」。
  2. `ConversationComposer.tsx:954` 的 `logger.warn('[v4-composer] 草稿 editorState 恢复失败，退纯文本: ...')`
     在本次改动后回退路径是 `setTextWithMentions`（`:222`），日志会误导排障。
- 改法：注释改为「id 是编辑器本地标识，刻意不复用 provider 前缀；唯一消费方是同节点 DOM→节点回查，
  往返权威是 markdown」；日志改为「退 markdown→mention 恢复」。
- 验收/测试：无运行时行为；`pnpm typecheck` / `pnpm lint` + 人工 review。
- 来源：review-diff / round 1

---

## Spec deviations

none（缺陷修复，无业务 spec 可比对）

---

## Open questions / 待拍板

1. **裸 token 升级成胶囊的范围（需拍板）**：`parseInlineMentionTokensAsParts`（`mentionMarkdown.ts:310-346`）
   会把 `$5`（金额）、`@media`（CSS）、`/goal`、`#sess_x` 升级成 token 节点——`setMode("token")` 是原子节点，
   一次 Backspace 删整段。气泡层本来就这么显示（不是新分歧），但编辑态的可感知代价变大。
   可选收敛：只对链接形态 `[...](...)`（由 `build*MentionMarkdown` 产出、无歧义）建胶囊，裸 token 保持文本。
2. **白板 mention 无法往返（既有，建议 out of scope）**：`whiteboardMentionProvider.ts:16` 的 markdown 是
   `@${board.name}`，与 subagent 同形，恢复后一律变 subagents 胶囊。要修需给白板换可区分载体。
3. **路径含 `)` 截断（既有，建议 out of scope）**：`escapeMarkdownDestination`（`mentionMarkdown.ts:12-14`）
   只转义 `\` 和 `>`。往返仍逐字节成立（未解析部分原样成文本），但编辑态会出现假胶囊 + 尾部字面量。
   修它会改变落库形态，需兼容旧数据，建议单独立项。
4. **`applyExternalTextInsertRequestToComposer` 的 else 分支**：`ConversationComposer.tsx:269-274` 仍是
   「含 `](plugin://)` → `setTextWithMentions`，否则 `setText`」。现状可能是刻意的（任务/引导提示词是纯文本）；
   收敛成无条件 `setTextWithMentions` 会把推荐文案里的 `$5` 之类升级成胶囊（见 open question 1）。

## 已豁免（用户确认不修）

（暂无）

## 已核实无影响（避免重复报告）

- **往返逐字节**：`parseMentionMarkdownParts` 的每片要么是 `match[0]`、要么是原串切片，结构上必然可拼回；
  `text.split("\n\n")` 与 `$getPromptMarkdown`（`promptSerialization.ts:12-23`，只在非 inline 元素间插 `\n\n`）
  一一对应，首尾空行 / 多空行 / 单个 `\n` 均能还原；空串得到 1 个空段落且 `getMarkdown()` 仍为 `""`。
- **盘符修复（`ef39230c`）**：`C:` / `c:` / `C:foo` / `C:/Users` / UNC `\\server\...` 都不命中
  `^[a-zA-Z][a-zA-Z\d+.-]+:`；`normalizeMarkdownDestination` 对 `C:\` 原样返回；
  `unescapeMarkdownText` 与 `escapeMarkdownDestination` 对称，`data.path` 是真实路径。
- **`ChatPromptEditor` 的同步 guard**（`:196-203`）保留；草稿仍优先 `editorStateJson`
  （`ConversationComposer.tsx:208-215`），与 markdown 恢复不打架。
- **`mentionId` 形态不一致无运行时后果**（唯一读取方是 DOM→节点自洽回查），只影响注释准确性（见 C-1）。
- **队列行复用 `ConversationUserInputContent`**：组件是 `memo`，`item.text` 不变则不重跑解析；
  渲染全是 inline `<span>`，嵌在 `<span>` 里合法；`title` 保留完整原文。
- **`setTextWithPluginMentions` 改名**：全仓（含 `docs/`、`scripts/`、e2e）零引用，无外部消费者。

## 合并后 QA（manual_user，不阻塞）

- 发一条含 skill + 文件胶囊的 prompt，按 ↑ 回填 → 胶囊在，内容不变。
- 队列排队一条含 `[Google](https://google.com)` 的 prompt → 行内不出现文件图标。
- 消息里写一条 `[见上文](#anchor)` → 进入编辑态，文字仍是「见上文」。

## K 节建议（下游执行时闭合）

- B-1 抽函数后，`split("\n\n")` 的三份复制（`:195`、`:214`、`:1030`）应只剩一份。
- 修完重跑 `pnpm typecheck` + `pnpm lint`（目标仍是 0 errors）。

---

## 执行记录（2026-10-28）

- **B-1**：抽出模块级 `$replaceRootWithPromptMarkdown(text)`，`replaceEditorTextWithMentions` 与
  `applyHistoryEntry` 共用（后者仍传 `HISTORY_NAVIGATION_UPDATE_TAG`）；`split("\n\n")` 的三份复制收敛为一份。
  新增源码形状守卫：`applyHistoryEntry` 必须调用共享函数且不得出现裸 `$createTextNode(line)`。
- **B-2a**：`classifyMentionLink` 对空 destination 与 `#` 非 sess 目标返回 `null`，整段保持文本。
- **B-2b**：**范围收窄**。统一分类入口 `classifyMentionLink` 已落地（气泡层与编辑器层共用），
  编辑器侧对外链保持纯文本；**气泡侧保留历史口径**——`[Google](https://…)` 仍按 file/directory 展示，
  理由：改成纯文本会让消息里出现 markdown 字面量、选中复制还会丢 URL，那是气泡渲染层「支持链接渲染」的另一件事，
  风险评估高于收益。锚点/空目标已不再被当成文件。队列行因此与气泡层一致。
- **G-1**：`packages/ui/test/mentionMarkdownParts.test.ts` 已接入根 `package.json` 的 `test:v4-perf` 第一段。
- **C-1**：`mentionId` 注释改为「刻意不复用 provider 前缀」；草稿恢复失败日志改为「退 markdown→mention 恢复」。

Open questions 处置：

1. 裸 token 升级范围 → **按现状保留**（与气泡层一致，用户未要求收窄）。
2. 白板 `@name` 歧义 → out of scope（既有编码歧义）。
3. 路径含 `)` 截断 → out of scope（修它要改落库形态，需兼容旧数据）。
4. `applyExternalTextInsertRequestToComposer` 的 else 分支 → 保持 `setText`（任务/引导提示词是纯文本）。
5. `setTextWithPluginMentions` 改名 → 已核实全仓零引用，无外部消费者，安全。

## Fix-Spec Closure

| 项 | 状态 |
| --- | --- |
| fix-spec-ready | 待用户确认 |
| fix_spec_path | docs/iterations/cr-20261028-mention-restore/cr-fix-spec.md |
| dag_version / review_round | 1 / 1 |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 3 / 2 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（B-1 同语义三路径收敛） |
| C 类合并后 QA | 3 条，不阻塞 |
