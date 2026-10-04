// ============================================================
// ctx_reduce / ctx_expand Tool Handlers (Step 21)
// ============================================================
// magic-context 上下文回收面的 ZCode 侧薄封装。**真身在 `@zcode/magic-context`**
// （D 组第一批：`core/tools/ctx-reduce/**` + `core/tools/ctx-expand/**`），本文件
// 只做三件事：
//
//   1. 用 `@zcode/contracts` 的 zod 面做运行时校验，并把 ctx 工具的 execute()
//      （永远 resolve 成一段文本）包成 `{ text }` 以满足 ToolEntry 的 outputSchema；
//   2. 把 `ToolExecutionContext` 投影成包侧的 `CtxToolContext`
//      （`sessionID` / `directory` / `callID`）；
//   3. 声明权限与预算。
//
// **包是动态 import 的**，与 `runtime/helpers/magic-context-turn-transform.ts` 同一理由：
// `features.magicContext === false`（用户显式关闭的退路态，T-M8）时，CLI 启动不该把
// 整棵 magic-context 模块图（zod schema + sqlite chokepoint + 迁移模块）拉进内存。
// 静态 import 会在 core 的工具注册那一刻就发生，flag 就再也管不住它了。
//
// 幂等语义在包内（`ctx_reduce` 的 `commandIdLedger`，键推导逐字照搬上游）：
// 同一条 toolCallId 重复调用不会二次入队 pending_ops（T-M11 前半）。

import {
  CTX_EXPAND_TOOL_NAME,
  CTX_REDUCE_TOOL_NAME,
  CtxExpandInputJsonSchema,
  CtxExpandInputSchema,
  CtxReduceInputJsonSchema,
  CtxReduceInputSchema,
  CtxToolTextOutputJsonSchema,
  CtxToolTextOutputSchema,
  type CtxExpandInput,
  type CtxReduceInput,
  type CtxToolTextOutput,
} from "@zcode/contracts";
import type { ModelMessageContent } from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

/** ctx_expand 一次最多回 15K token 的原文；转成字节预算留一倍余量给模型侧的包装。 */
const CTX_EXPAND_MODEL_BYTES = 60_000;
/** ctx_reduce 只回一句确认文本；上限只防「工具把整个会话打印出来」这类失控。 */
const CTX_REDUCE_MODEL_BYTES = 4_000;
const CTX_TOOL_TIMEOUT_MS = 30_000;

/** 包侧能力缺席（flag off / db 打不开）时的用户可见文本。 */
const CTX_MAGIC_CONTEXT_UNAVAILABLE =
  "Magic Context is not available in this session; ctx tools are inert.";

type MagicContextModule = typeof import("@zcode/magic-context");

/**
 * 动态加载 magic-context 包。**永不抛**：加载失败等价于「本会话没有 magic-context」，
 * 由调用方转成上面那句缺席文本，而不是把一次工具调用变成一个工具错误。
 */
async function loadMagicContext(): Promise<MagicContextModule | null> {
  try {
    return await import("@zcode/magic-context");
  } catch {
    return null;
  }
}

/** 按会话 id 打开包侧 db 句柄；打不开（fence / 迁移未完成）时返回 null。 */
async function openMagicContextDatabase(
  magicContext: MagicContextModule,
): Promise<Awaited<ReturnType<typeof magicContext.openDatabase>>> {
  try {
    return magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
  } catch {
    return null;
  }
}

function toCtxToolContext(context: ToolExecutionContext) {
  return {
    callID: context.toolCallId,
    directory: context.workingDirectory,
    sessionID: context.sessionId,
  };
}

const ctxReduceHandler: ToolHandler = async (input, context) => {
  const parsed = CtxReduceInputSchema.parse(input) as CtxReduceInput;
  const magicContext = await loadMagicContext();
  if (!magicContext) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  const db = await openMagicContextDatabase(magicContext);
  if (!db) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  // protectedSet 不传 → 包内走 `getProtectionWindowForSession(db, sessionId)`，
  // 即真身自己的读路径（与 transform 用的是同一份窗口语义）。
  const tools = magicContext.createCtxReduceTools({ db });
  const text = await tools.ctx_reduce.execute(parsed, toCtxToolContext(context));
  return { text } satisfies CtxToolTextOutput;
};

const ctxExpandHandler: ToolHandler = async (input, context) => {
  const parsed = CtxExpandInputSchema.parse(input) as CtxExpandInput;
  const magicContext = await loadMagicContext();
  if (!magicContext) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  const db = await openMagicContextDatabase(magicContext);
  if (!db) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  const tools = magicContext.createCtxExpandTools({ db });
  const text = await tools.ctx_expand.execute(parsed, toCtxToolContext(context));
  return { text } satisfies CtxToolTextOutput;
};

/**
 * `ctx_reduce`：把「工作往后不再需要」的东西盖个章。
 *
 * permission 归类：`sideEffectScope: "session"`、`riskLevel: "low"`、
 * `needsApproval: false` —— 与 `TodoWrite` 同档，也与 SPEC「ctx_reduce 写 db 但属
 * 用户显式控制」一致。它写的是本会话自己的 `pending_ops` 一行：不碰工作区（因此
 * `isWorkspaceMutatingToolCall` 为 false，amend-resume 的导入缓存不会被它关掉）、
 * 不碰 messageHistory、不发网络请求。
 *
 * `concurrentSafe: false`：幂等账本是按 commandId 记的，而 commandId 来自
 * toolCallId；同一会话里两次并发调用各自有独立 toolCallId，因此它们本就不该互相
 * 看见对方的排队结果——串行组让「排了什么」在模型视野里保持一个确定的顺序。
 */
export const ctxReduceToolEntry: ToolEntry = {
  capability: "Mark context items the work ahead no longer needs so Magic Context can reclaim them",
  metadata: {
    name: CTX_REDUCE_TOOL_NAME,
    description: [
      `Stamp an item on your desk as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays fully readable until Magic Context clears stamped items in one sweep, and the newest tags are protected so stamping recent output is harmless. A cleared item goes to the archive — a recent one leaves a \`[dropped §N§]\` placeholder, an older one leaves nothing — and \`ctx_expand(tag=N)\` is the way back. So the question before stamping is not "have I finished reading this?" but "does this need to stay on my desk for what comes next?" — a file you read and will keep editing stays; the grep that found it goes.`,
      "",
      `Stamp: file reads, search results and tool outputs the work ahead no longer needs; build/test output after you acted on it; repeated or redundant dumps; data written to disk; status/log output that only confirmed what you expected.`,
      `Keep: user messages (never stamp one for its directive), your own conversation text, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may still matter.`,
      "",
      `Look at each tag before stamping it; never blanket-stamp a range like "1-50". Many small targeted stamps beat one sweep. \`drop\` accepts "3-5", "1,2,9", "1-5,8,12-15".`,
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CTX_TOOL_TIMEOUT_MS,
    maxOutputBytes: CTX_REDUCE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: ctxReduceHandler,
  formatModelContent: formatCtxToolTextModelContent,
  inputSchema: CtxReduceInputJsonSchema,
  outputSchema: CtxToolTextOutputJsonSchema,
  runtimeInputSchema: CtxReduceInputSchema,
  runtimeOutputSchema: CtxToolTextOutputSchema,
  permission: {
    permission: "magicContext.reduce",
    reason:
      "ctx_reduce only queues this session's own Magic Context drops; it never writes the workspace",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    // 永久放行只按工具名，不按 input：`drop` 每次都是不同的数字串，按输入记规则等于
    // 永远记不住，也等于给了一个「以后随便盖」的永久授权。
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: CTX_REDUCE_MODEL_BYTES,
    maxModelBytes: CTX_REDUCE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CTX_REDUCE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: CTX_TOOL_TIMEOUT_MS,
    maxMs: CTX_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ctx_reduce was cancelled before its drops were queued",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/**
 * `ctx_expand`：把已经离开桌面（或已被压缩）的内容原样取回。
 *
 * permission 归类：仓库既有的**低风险只读类**——`readOnly: true` +
 * `sideEffectScope: "none"` + `riskLevel: "low"` + `needsApproval: false`，与
 * `ListSavedWorkflows` / `TodoRead` 同款。它只读 magic-context.db 的 tags /
 * compartments 与本会话的历史，不写任何一侧。
 */
export const ctxExpandToolEntry: ToolEntry = {
  capability: "Recover original context content that Magic Context dropped or compacted",
  metadata: {
    name: CTX_EXPAND_TOOL_NAME,
    description: [
      `Recover original content that is no longer on your desk. It takes two kinds of number, and they are never interchangeable:`,
      `- \`tag=N\`: the number from a §N§ tag or a \`[dropped §N§]\` placeholder. Returns that one item whole: a text, or a tool call with its full input and output.`,
      `- \`message=N\`, \`start\`/\`end\`: message ordinals, the positions shown in \`<session-history>\` headings (\`## start-end\`) and in search hits. An ordinal counts whole messages; a tag counts each text and tool result separately, so the same number points at different things.`,
      "",
      `Earlier turns are summarized in <session-history> under \`## start-end · date · title\` headings. When the summary isn't enough — exact wording, a value, an error message, the reasoning behind a decision — expand the range: ctx_expand(start=120, end=245).`,
      "",
      `Returns the raw transcript as [N] U:/A: lines, capped at ~15K tokens; an oversized range returns the head and says where to continue.`,
      "",
      `Finer recovery:`,
      `- verbose=true lists each message separately with its ordinal and a per-part preview so you can pick one.`,
      `- message=N returns that one message in full — every text part and every tool call's complete input and output — from stored history. This is the way back to a tool output you released with ctx_reduce.`,
    ].join("\n"),
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CTX_TOOL_TIMEOUT_MS,
    maxOutputBytes: CTX_EXPAND_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: ctxExpandHandler,
  formatModelContent: formatCtxToolTextModelContent,
  inputSchema: CtxExpandInputJsonSchema,
  outputSchema: CtxToolTextOutputJsonSchema,
  runtimeInputSchema: CtxExpandInputSchema,
  runtimeOutputSchema: CtxToolTextOutputSchema,
  permission: {
    permission: "magicContext.expand",
    reason: "ctx_expand only reads Magic Context's own store and this session's stored history",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // 纯读，且参数里没有任何路径主体（sessionId 来自上下文），所以只按工具名匹配。
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: CTX_EXPAND_MODEL_BYTES,
    maxModelBytes: CTX_EXPAND_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CTX_EXPAND_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: CTX_TOOL_TIMEOUT_MS,
    maxMs: CTX_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ctx_expand was cancelled before the requested range was read",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    // 输出是恢复出来的原文（可能含用户数据），按 summary 记而不是 full。
    recordOutput: "summary",
  },
};

/**
 * 模型面就是那段文本本身。ctx 工具的输出**已经是**给模型读的句子（确认文本 / 错误
 * 文本 / 恢复出来的原文），再包一层容器只会让模型多解析一次。
 */
function formatCtxToolTextModelContent(output: unknown): ModelMessageContent {
  const parsed = CtxToolTextOutputSchema.safeParse(output);
  if (!parsed.success) return "ctx tool returned an invalid result.";
  return parsed.data.text;
}
