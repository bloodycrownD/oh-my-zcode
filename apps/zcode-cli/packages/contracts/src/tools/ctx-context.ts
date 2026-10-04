// ============================================================
// ctx_reduce / ctx_expand Tools — magic-context 上下文回收面
// ============================================================
// SPEC Step 21（下划线命名有先例：`submit_result`）。两个工具的**实现**在
// `@zcode/magic-context`（D 组第一批真身），本文件只拥有 provider 可见的声明面：
// 名字常量、zod（v3）输入 schema、输出 schema。
//
// 语义边界（与 SPEC 一致）：
//   - `ctx_expand` **纯读**：读 magic-context.db 的 tags / compartments 与会话历史，
//     返回被丢弃或已压缩内容的原文。`sideEffectScope: "none"`，`readOnly: true`。
//   - `ctx_reduce` 写 magic-context.db 的 `pending_ops` 一行——但那是**用户显式控制**
//     的排队动作（模型替用户把「不再需要」的东西盖个章），不碰工作区、不碰
//     messageHistory、不发网络请求。因此 `sideEffectScope: "session"`（把状态交回本
//     会话自己的上下文面），`needsApproval: false`——它与 `TodoWrite` 同档：写的是
//     本会话的进度状态，不是用户的仓库或外部世界。
//
// 输出面刻意是**一段文本**而不是结构化对象：上游 ctx 工具的 execute() 永远 resolve
// 成字符串（确认文本、错误文本、恢复出来的原文）。把它包成 `{ text }` 只是为了让
// ToolEntry 的 outputSchema 有形状可校验。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const CTX_REDUCE_TOOL_NAME = "ctx_reduce";
export const CTX_EXPAND_TOOL_NAME = "ctx_expand";

/** `drop` 的取值语法与包内 `parseRangeString` 一致：`"3-5"`, `"1,2,9"`, `"1-5,8,12-15"`。 */
export const CTX_REDUCE_DROP_PATTERN = '"3-5", "1,2,9", "1-5,8,12-15"';

export const CtxReduceInputSchema = z
  .object({
    // 声明层刻意 optional：缺失时工具回「Error: 'drop' must be provided.」，那是模型
    // 能自我纠正的普通字段错误，而不是 provider 侧的 schema 拒绝（拒绝会让某些
    // provider 直接丢掉这次调用，模型看不到自己错在哪）。
    drop: z.string().optional().describe(`Tag IDs to drop: ${CTX_REDUCE_DROP_PATTERN}.`),
  })
  .strict();

export type CtxReduceInput = z.infer<typeof CtxReduceInputSchema>;

export const CtxReduceInputJsonSchema = toToolJsonSchema(CtxReduceInputSchema);

export const CtxExpandInputSchema = z
  .object({
    // tag 与 ordinal 是**两种永不可互换的数**：tag 数的是每条文本与工具结果，ordinal
    // 数的是整条消息。描述里必须把这件事说穿——模型最常见的错误就是把
    // <session-history> 标题里的序号当 tag 号传进来。
    tag: z
      .union([z.number(), z.string()])
      .optional()
      .describe(
        "Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
      ),
    start: z
      .number()
      .optional()
      .describe(
        "First message ordinal of the range (a <session-history> heading's start, or a search hit), not a tag number.",
      ),
    end: z
      .number()
      .optional()
      .describe("Last message ordinal of the range, inclusive, not a tag number."),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
      ),
    message: z
      .number()
      .optional()
      .describe(
        "Message ordinal from a <session-history> heading or a search hit, not a tag number. Returns that one message in full. Use alone.",
      ),
  })
  .strict();

export type CtxExpandInput = z.infer<typeof CtxExpandInputSchema>;

export const CtxExpandInputJsonSchema = toToolJsonSchema(CtxExpandInputSchema);

/**
 * 两个 ctx 工具共用的输出形状：一段文本。
 * 不用 `.strict()` 之外的任何约束——文本内容由包内工具决定，契约层不预判。
 */
export const CtxToolTextOutputSchema = z
  .object({
    text: z.string(),
  })
  .strict();

export type CtxToolTextOutput = z.infer<typeof CtxToolTextOutputSchema>;

export const CtxToolTextOutputJsonSchema = toToolJsonSchema(CtxToolTextOutputSchema);
