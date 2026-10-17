// ============================================================
// ctx_reduce / ctx_expand / ctx_search / ctx_memory Tools — magic-context 上下文回收与记忆面
// ============================================================
// SPEC Step 21（ctx_reduce/ctx_expand，下划线命名有先例：`submit_result`）与
// Step 10（ctx_search=D4 / ctx_memory=D14）。四个工具的**实现**都不在本文件：
// ctx_reduce / ctx_expand 的真身在 `@zcode/magic-context`（D 组第一批）；
// ctx_search / ctx_memory 的实现在 `@zcode/core` 的 `tool/handlers/`（D4/D14 的
// fork 契约面：FTS5 关键词检索 + 幂等写入，无向量路径）。本文件统一持有
// provider 可见的声明面：名字常量、zod（v3）输入 schema、输出 schema。
//
// 语义边界（与 SPEC 一致）：
//   - `ctx_expand` **纯读**：读 magic-context.db 的 tags / compartments 与会话历史，
//     返回被丢弃或已压缩内容的原文。`sideEffectScope: "none"`，`readOnly: true`。
//   - `ctx_reduce` 写 magic-context.db 的 `pending_ops` 一行——但那是**用户显式控制**
//     的排队动作（模型替用户把「不再需要」的东西盖个章），不碰工作区、不碰
//     messageHistory、不发网络请求。因此 `sideEffectScope: "session"`（把状态交回本
//     会话自己的上下文面），`needsApproval: false`——它与 `TodoWrite` 同档：写的是
//     本会话的进度状态，不是用户的仓库或外部世界。
//   - `ctx_search` **纯读**：对项目记忆库做 FTS5 关键词检索。同样
//     `sideEffectScope: "none"`，`readOnly: true`。fork 契约面**只检索 memory 一个
//     来源**（上游另有 message / git_commit / primer / note 四路，向量与 note 面按
//     N1/N2 终局不做），因此 schema 不声明 `sources`——声明了就必须实现，否则是
//     对模型说谎。
//   - `ctx_memory` 写本项目记忆库一行（insertMemoryIdempotent，幂等），或按 id
//     批量软删（archive，迭代 magic-context-memory-management 解锁）。它写的是
//     **用户级数据目录**（`~/.omz/cli/db/magic-context.db`）里本项目自己的记忆，
//     不是工作区文件，因此 `sideEffectScope: "session"`（协议内作用域，非工作区
//     改写）、`needsApproval: false`——与 ctx_reduce 同档：写的是用户自己的记忆库，
//     由模型显式调用且内容可见，不是外部世界。
//
// 输出面刻意是**一段文本**而不是结构化对象：上游 ctx 工具的 execute() 永远 resolve
// 成字符串（确认文本、错误文本、恢复出来的原文）。把它包成 `{ text }` 只是为了让
// ToolEntry 的 outputSchema 有形状可校验。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const CTX_REDUCE_TOOL_NAME = "ctx_reduce";
export const CTX_EXPAND_TOOL_NAME = "ctx_expand";
export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_MEMORY_TOOL_NAME = "ctx_memory";

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
 * `ctx_search`（D4）：项目记忆库的关键词检索。
 *
 * `query` 是**含混的自然语言问句也可以**——fork 的检索层
 * （magic-context `storage-memory-fts.ts` 的 `searchMemoriesFTS`）先按空格分词逐词
 * 命中（每词引号包裹，FTS5 操作符全部按字面处理），零命中时自动放宽为词根 OR
 * 重查（`relaxedFtsQuery`）。调用方不需要、也不应该自己写 FTS5 语法。
 *
 * `from` / `to` 是**可选的 UTC 日期界**（`YYYY-MM-DD`，闭区间；`to` 缺省不设上界），
 * 按记忆行的 `created_at` 过滤。日期解析在 core 的 handler（宿主侧胶水），契约层
 * 只约束形状。
 *
 * 刻意没有 `sources`：fork 只检索 memory 一个来源（上游其余四路按 N1/N2 终局不做）。
 */
export const CtxSearchInputSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        "Keywords or a natural-language question carrying the exact terms expected in the answer.",
      ),
    limit: z.number().optional().describe("Maximum results (default 10, capped at 50)."),
    from: z.string().optional().describe("Earliest date, YYYY-MM-DD (inclusive, UTC)."),
    to: z.string().optional().describe("Latest date, YYYY-MM-DD (inclusive, UTC; default open)."),
  })
  .strict();

export type CtxSearchInput = z.infer<typeof CtxSearchInputSchema>;

export const CtxSearchInputJsonSchema = toToolJsonSchema(CtxSearchInputSchema);

/**
 * `ctx_memory`（D14）：把一条值得跨会话保留的事实钉进项目记忆库；迭代
 * magic-context-memory-management 起亦支持批量废弃（`archive`）。
 *
 * `action` 声明为 optional 的 `z.enum(["write","archive"])`：缺省即 `"write"`
 * （显式 `"write"` 与省略是同一个合法形状，确认文案完全一致）；`"archive"` 用
 * `ids`（1–100 个 id）与可选 `reason` 做批量软删（逐 id outcome）。上游其余动作
 * （update/merge/get）的读写锁与工作区可见性规则更重，fork 不做；未知 action
 * 值在解析层得到可自我纠正的错误，而不是被 provider schema 静默丢掉。
 *
 * `category` 的五个取值与 magic-context 包内 `V2_MEMORY_CATEGORIES` 一一对应
 * （historian 分舱写入的同五个分类）。**drift guard**：core 的
 * `scripts/test-ctx-search-memory.mjs` 断言两处名单一致；改一边必须同步另一边。
 */
export const CTX_MEMORY_CATEGORIES = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING",
] as const;

export const CtxMemoryInputSchema = z
  .object({
    action: z
      .enum(["write", "archive"])
      .optional()
      .describe('Either "write" (default when omitted) or "archive".'),
    content: z
      .string()
      .optional()
      .describe("The memory text — one standalone fact, phrased to make sense on its own."),
    category: z
      .enum(CTX_MEMORY_CATEGORIES)
      .optional()
      .describe(
        "Kind of fact (required): project rule, architecture, constraint, config value, or naming.",
      ),
    ids: z
      .array(z.number().int())
      .min(1)
      .max(100)
      .optional()
      .describe("Memory IDs to archive (required when action is 'archive'): 1–100 ids."),
    reason: z
      .string()
      .max(4096)
      .optional()
      .describe("Why the memories are being archived (optional; at most 4096 characters)."),
  })
  .strict();

export type CtxMemoryInput = z.infer<typeof CtxMemoryInputSchema>;

export const CtxMemoryInputJsonSchema = toToolJsonSchema(CtxMemoryInputSchema);

/**
 * 四个 ctx 工具共用的输出形状：一段文本。
 * 不用 `.strict()` 之外的任何约束——文本内容由工具实现决定，契约层不预判。
 */
export const CtxToolTextOutputSchema = z
  .object({
    text: z.string(),
  })
  .strict();

export type CtxToolTextOutput = z.infer<typeof CtxToolTextOutputSchema>;

export const CtxToolTextOutputJsonSchema = toToolJsonSchema(CtxToolTextOutputSchema);
