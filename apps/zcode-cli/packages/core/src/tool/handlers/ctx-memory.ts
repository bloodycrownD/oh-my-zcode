// ============================================================
// ctx_memory Tool Handler (Step 10 / D14)
// ============================================================
// magic-context 记忆**写入面**的 ZCode 侧薄封装。给模型一条显式的能力：把
// 「不值得再找一遍」的事实钉进项目记忆库，让后续所有会话（以及 m0/m1 注入、
// ctx_search 检索）都能看见它。211 行系统提示词段的 MEMORY_GUIDANCE 硬引用本工具
// （Step 13 装配），因此它的存在本身就是提示词不说谎的前提。
//
// 幂等是两条相互独立的链，都不能少：
//
//   1. **调用级幂等（commandId 账本）**：同一条 toolCallId 的重复调用（provider
//      重试、executor 重放）直接回放首次确认文本，绝不二次写入、绝不二次
//      seen_count 递增。键推导沿用 ctx_reduce 的 commandIdLedger 惯例
//      （callID → `oc-<session>-<callID>`，超 128 字节取 sha256；无 callID 时走
//      单调序号）；前缀不同仅因这本账在 ZCode 侧、不进包内逐字区。
//   2. **内容级幂等（前置哈希检查 + insertMemoryIdempotent）**：写入前按
//      `computeNormalizedHash` 精确查重——已存在则 `updateMemorySeenCount`
//      并回报现有 id（与上游 ctx_memory 的 write 分支同款链路）；穿过前置检查
//      的竞争写由 `insertMemoryIdempotent` 的唯一约束 + seen_count 递增收口。
//      **复用 Step 8 已移植的 storage-memory 真身**，不在宿主侧重写去重规则。
//
// fork 首版只有 `write` 一个动作：上游的 update/archive/merge/get 读写锁与
// 工作区可见性规则更重，本批注入链只消费「写入 + 检索」闭环（详见契约文件的
// 裁定注释）。
//
// 包是**动态 import** 的，与 ctx-context.ts / ctx-search.ts 同一理由：
// `features.magicContext` 关闭时整棵 magic-context 模块图不进内存。

import {
  CTX_MEMORY_TOOL_NAME,
  CtxMemoryInputJsonSchema,
  CtxMemoryInputSchema,
  CtxToolTextOutputJsonSchema,
  CtxToolTextOutputSchema,
  type CtxMemoryInput,
  type CtxToolTextOutput,
} from "@zcode/contracts";
import { createHash } from "node:crypto";
import type { ModelMessageContent } from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const CTX_TOOL_TIMEOUT_MS = 30_000;
/** 只回一句确认文本；上限只防「工具把整个记忆库打印出来」这类失控。 */
const CTX_MEMORY_MODEL_BYTES = 4_000;
/** 账本上界：一次会话里重复调用的命令 id 是极少数，2000 足以覆盖provider 重试。 */
const COMMAND_ID_LEDGER_MAX_ENTRIES = 2000;

/** 包侧能力缺席（flag off / db 打不开）时的用户可见文本。 */
const CTX_MAGIC_CONTEXT_UNAVAILABLE =
  "Magic Context is not available in this session; ctx tools are inert.";

type MagicContextModule = typeof import("@zcode/magic-context");

/**
 * 动态加载 magic-context 包。**永不抛**：加载失败等价于「本会话没有 magic-context」。
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

/**
 * commandId 推导。与包内 ctx_reduce 的 `commandIdForInvocation` 同构：
 * 有 callID 时 `oc-<session>-<callID>`（超 128 字节取 sha256），无 callID 时
 * 单调序号兜底。键只在本进程的账本里有意义，不进 wire。
 */
function commandIdForInvocation(sessionId: string, toolContext: ToolExecutionContext): string {
  const callId =
    (typeof toolContext.toolCallId === "string" && toolContext.toolCallId.trim()) || "";
  if (callId) {
    const stableId = `oc-${sessionId}-${callId}`;
    if (Buffer.byteLength(stableId) <= 128) return stableId;
    return `oc-${createHash("sha256").update(stableId).digest("hex")}`;
  }
  fallbackCommandSequence += 1;
  const monotonicId = `oc-${sessionId}-${fallbackCommandSequence}`;
  return Buffer.byteLength(monotonicId) <= 128
    ? monotonicId
    : `oc-${createHash("sha256").update(monotonicId).digest("hex")}`;
}

let fallbackCommandSequence = 0;

/**
 * 调用级幂等账本：commandId → 那次调用已经回给模型的确认文本。
 * 有界（超上限丢最旧），与包内 BoundedSessionMap 同款语义——账本只为「同一
 * commandId 的重复投递」服务，不承载历史。
 */
const commandIdLedger = new Map<string, string>();

function settleCommand(commandId: string, text: string): string {
  if (commandIdLedger.size >= COMMAND_ID_LEDGER_MAX_ENTRIES) {
    const oldest = commandIdLedger.keys().next();
    if (!oldest.done) commandIdLedger.delete(oldest.value);
  }
  commandIdLedger.set(commandId, text);
  return text;
}

const ctxMemoryHandler: ToolHandler = async (input, context) => {
  const parsed = CtxMemoryInputSchema.parse(input) as CtxMemoryInput;
  // action 契约层已限定为 `"write"`（optional，缺省即 write）：显式带
  // action:"write" 与「不带 action」在 schema 层就是同一个合法形状，确认文案
  // 也因此完全一致，这里不再读取它。

  // 幂等闸门在参数校验之后、取任何 db 写之前：一次已确认过的 commandId 重放
  // 上次的确认文本，memories 一行都不多、seen_count 一次都不涨。
  const commandId = commandIdForInvocation(context.sessionId, context);
  const settled = commandIdLedger.get(commandId);
  if (settled !== undefined) {
    return { text: settled } satisfies CtxToolTextOutput;
  }

  const content = parsed.content?.trim();
  if (!content) {
    return {
      text: "Error: 'content' is required when action is 'write'.",
    } satisfies CtxToolTextOutput;
  }

  const category = parsed.category;
  if (!category) {
    return {
      text: "Error: 'category' is required when action is 'write'.",
    } satisfies CtxToolTextOutput;
  }

  const magicContext = await loadMagicContext();
  if (!magicContext) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  const db = await openMagicContextDatabase(magicContext);
  if (!db) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  // 身份解析与 promotion / ctx_search 共用同一个非抛错入口；undefined = 这个
  // 目录当前不参与记忆特性（家目录未授权 / git 身份暂不可用），写入同样不适用。
  const projectIdentity = magicContext.resolveProjectIdentityForSession(context.workingDirectory);
  if (!projectIdentity) {
    return {
      text: `Error: Memory features are paused for ${context.workingDirectory} (no usable project identity).`,
    } satisfies CtxToolTextOutput;
  }

  try {
    // sourceType "agent"：这是模型/工具发起的写入（上游同名语义；"user" 被
    // storage-memory 保留给未来的 dashboard 手工录入，写路径一律拒绝）。
    //
    // 前置精确查重（与上游 ctx_memory 的 write 分支同款链路）：同一条事实重复
    // 钉入时不制造重复行，seen_count 递增并回报现有 id——工具描述里「Writing a
    // fact that already exists creates no duplicate」就是由这一步兑现的。
    const normalizedHash = magicContext.computeNormalizedHash(content);
    const existing = magicContext.getMemoryByHash(db, projectIdentity, category, normalizedHash);
    if (existing) {
      magicContext.updateMemorySeenCount(db, existing.id);
      const text = `Memory already exists [ID: ${existing.id}] in ${category} (seen count incremented).`;
      return { text: settleCommand(commandId, text) } satisfies CtxToolTextOutput;
    }

    // 竞争窗口的第二道闸：两个写者同时穿过上面的前置检查时，唯一约束让其中一个
    // 走 seen_count 递增收口（insertMemoryIdempotent 的既有语义）。
    const result = magicContext.insertMemoryIdempotent(db, {
      projectPath: projectIdentity,
      category,
      content,
      sourceSessionId: context.sessionId,
      sourceType: "agent",
    });

    const text = result.inserted
      ? `Saved memory [ID: ${result.memory.id}] in ${category}.`
      : `Memory already exists [ID: ${result.memory.id}] in ${category} (seen count incremented).`;
    return { text: settleCommand(commandId, text) } satisfies CtxToolTextOutput;
  } catch (error) {
    // Rust 模块托管项目的写入权威在上游 ck-mc 模块（fork 不移植，D-6）：命中即
    // 明确拒绝，而不是绕过 authority 表写坏双源。这是 fail-visible，不是故障。
    if (error instanceof magicContext.ModuleMemoryAuthorityError) {
      return {
        text: `Error: Memory writes for this project are managed by the memory module (${error.code}); refusing the TypeScript-side write.`,
      } satisfies CtxToolTextOutput;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `Error: Failed to save memory. ${message}`,
    } satisfies CtxToolTextOutput;
  }
};

/**
 * `ctx_memory`：把一条值得跨会话保留的事实钉进项目记忆库。
 *
 * permission 归类：与 `ctx_reduce` 同档——写的是**用户自己的记忆库**（位于
 * `~/.omz/cli/db`，不是工作区文件，因此 `sideEffectScope: "session"` 不构成
 * 工作区改写、`isWorkspaceMutatingToolCall` 为 false），内容由模型显式给出且
 * 在用户视野里可查（readMagicContextConfig / <project-memory> 注入）。
 * `concurrentSafe: false`：写入共享记忆表，串行组让「钉了什么」在模型视野里
 * 保持确定顺序，也避免同一事实的并发重复写入互相看不到。
 */
export const ctxMemoryToolEntry: ToolEntry = {
  capability: "Pin a durable project fact into Magic Context's cross-session memory store",
  metadata: {
    name: CTX_MEMORY_TOOL_NAME,
    description: [
      `Durable facts about this project, shared with every agent working on it and kept for as long as the project lasts.`,
      ``,
      `Your active memories are already visible in your context as \`#id: fact\` lines. Write one when you learn something that must not have to be found again — a project rule, an architectural fact, a hard-won constraint, a config value, a naming convention — and especially when it cost you turns to find. One standalone fact per memory, phrased to make sense on its own. A pending intention with its evidence ("do X later, here is what we know") is not a memory.`,
      ``,
      `The only action is \`write\`: it needs \`content\` (the one fact) and \`category\` (PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, or NAMING). Writing a fact that already exists creates no duplicate — the existing memory's seen count is incremented instead.`,
      ``,
      `Use it proactively: the moment you hit a fact you had to dig for and will not want to dig for again, that is what this tool is for — you do not have to wait to be asked.`,
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CTX_TOOL_TIMEOUT_MS,
    maxOutputBytes: CTX_MEMORY_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: ctxMemoryHandler,
  formatModelContent: formatCtxToolTextModelContent,
  inputSchema: CtxMemoryInputJsonSchema,
  outputSchema: CtxToolTextOutputJsonSchema,
  runtimeInputSchema: CtxMemoryInputSchema,
  runtimeOutputSchema: CtxToolTextOutputSchema,
  permission: {
    permission: "magicContext.memory",
    reason:
      "ctx_memory writes one row in Magic Context's own project memory store; it never writes the workspace",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    // 永久放行只按工具名，不按 input：content 每次都是不同的文本，按输入记规则
    // 等于给了一个「以后随便钉」的永久授权（与 ctx_reduce 的 drop 同理）。
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: CTX_MEMORY_MODEL_BYTES,
    maxModelBytes: CTX_MEMORY_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CTX_MEMORY_MODEL_BYTES,
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
    userVisibleMessage: "ctx_memory was cancelled before the memory was written",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** 模型面就是那段确认文本本身（同 ctx-context.ts 的理由）。 */
function formatCtxToolTextModelContent(output: unknown): ModelMessageContent {
  const parsed = CtxToolTextOutputSchema.safeParse(output);
  if (!parsed.success) return "ctx tool returned an invalid result.";
  return parsed.data.text;
}
