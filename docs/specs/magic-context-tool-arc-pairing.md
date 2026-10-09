# magic-context tool 弧的 FIFO 配对与 ZCode 拆分形态（magic-context-tool-arc-pairing）

## 背景

magic-context 把一次 tool call 称为一条「弧」（arc）：invocation（调用侧，只有
input）+ result（结果侧，有 output）。drop/reclaim 以 composite key
`<ownerMsgId>\x00<callId>` 定位一条弧，两侧必须落进**同一个** key 才能被完整移除。
owner 的推导靠 FIFO 配对（`tag-messages.ts` 的 `deriveToolOwnerMessageId`、
`read-session-chunk.ts` 的同款逻辑）：invocation 入队（owner = 宿主消息 id），
result 出队（owner = 队头弹出的 invocation 宿主）。

宿主有两种消息形态：

- **OpenCode 同消息形态**：assistant 消息上一个 `{ type: "tool" }` part，
  调用完成后 `state.output` 直接写回同一个 part（调用/结果同消息）。
- **ZCode 拆分形态**：一个 tool call 拆成两个 part——assistant 消息上是
  running 的 `{ type: "tool" }`（invocation，只有 `state.input`），user 结果
  消息上才是 completed/error 的 `{ type: "tool" }`（result，有 `state.output`）。

Anthropic 原生形态（`tool_use` / `tool_result` 两种 part 类型）与 OpenCode 的
`tool-invocation` 形态天然用类型区分调用/结果两侧，不受本 spec 影响。

## 缺陷链路（已修复）

ZCode 拆分形态下，两个 part 都是 `type: "tool"`，而修复前
`extractToolCallObservation` 把 `type: "tool"` **一律**分类为 `"result"`：

1. **分类错位**：assistant 上的 running invocation 也被当成 result，FIFO 队列
   永远收不到入队；`boundToHostingMessage` 又让 user-role 宿主上的 result 直接
   复用宿主绑定（该优化是为 OpenCode「调用/结果同消息」形态写的），绕过了
   FIFO 出队。
2. **只清 result 侧**：两侧分别推导出不同的 ownerMsgId → 落进两个不同的
   composite key → drop 只命中 result 一侧的 entry。
3. **孤儿 invocation**：assistant 上的 running part 留在 wire 上，请求里出现
   没有 tool result 配对的 tool call。
4. **MissingToolResults**：宿主持续报
   `AI_MissingToolResultsError: Tool result is missing for tool call ...`，
   重启/重放都不恢复（每次 pass 都重新错位）。
5. **LKG 固化**：一旦某个带孤儿 call 的 pass 成功结束并被冻结成 LKG slot，
   错误字节被逐 pass 重放，会话卡死在坏前缀上。

## 规则

1. **`type: "tool"` 按 `partHasCompletedResult` 分流**（`tool-drop-target.ts` ·
   `extractToolCallObservation`）：弧闭合（`state.output` 为 string，或
   `state.status === "error"`）→ `"result"`；pending/running → `"invocation"`。
   其余形态（`tool-invocation` / `tool_use` / `tool_result`）保持按类型分类不动。
   该函数的两个消费方（`tag-messages.ts` 的 owner 推导、`read-session-chunk.ts`
   的 toolObservations 扫描）都用同一 FIFO 语义，一处修正两边同时受益。
2. **result 复用宿主绑定仅限 assistant 宿主**（`tag-messages.ts` ·
   `boundToHostingMessage`）：`message.info.role === "assistant"` 时才允许
   result 跳过 FIFO、复用宿主已加载的 composite 绑定（OpenCode 同消息形态的
   快路径）；user-role 宿主（ZCode 拆分形态）必须走 FIFO 配对，否则 owner 会
   被钉在 result 自己的消息上，与 invocation 侧分裂。

## 验收场景

`pnpm run test:transform`（`apps/zcode-cli/packages/magic-context`）新增 3 例：

1. running 的 `{ type: "tool" }` part（无 output、无 error status）→
   `kind: "invocation"`；
2. completed（`state.output` 为 string）与 error（`state.status === "error"`）
   的 `{ type: "tool" }` part → `kind: "result"`；
3. Anthropic 形态不变：`tool_use` → `"invocation"`，`tool_result` → `"result"`。

行为验收（ZCode 拆分形态的会话走 drop）：assistant running part 与 user
completed part 归入同一 composite key，drop 返回 `removed` 且两侧 part 同时
离线；不再出现 `AI_MissingToolResultsError`。
