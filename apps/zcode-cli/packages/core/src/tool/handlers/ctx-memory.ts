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
// fork 的动作面：`write`（默认）与 `archive`（迭代 magic-context-memory-
// management 解锁的批量废弃——逐 id outcome、允许部分成功；文案映射见下方
// `formatMemoryArchiveText`）。上游其余动作（update/merge/get）的读写锁与工作区
// 可见性规则更重，不做（详见契约文件的裁定注释）。
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

/** `archiveProjectMemories` 的逐 id outcome（单一事实源在包侧 host/memory-admin）。 */
type MemoryArchiveOutcomeEntry = ReturnType<MagicContextModule["archiveProjectMemories"]>[number];

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
 * write / archive 共用的会话前置三件套：加载包 → 打开库 → 解析项目身份。
 * 任一环失败返回**用户可见文本**（write 路径原有的三段文本原样迁入），
 * 成功则给出后续细则所需的三个句柄/身份。
 */
type MagicContextSession =
  | {
      magicContext: MagicContextModule;
      db: Awaited<ReturnType<MagicContextModule["openDatabase"]>>;
      projectIdentity: string;
    }
  | { errorText: string };

async function openMagicContextSession(workingDirectory: string): Promise<MagicContextSession> {
  const magicContext = await loadMagicContext();
  if (!magicContext) return { errorText: CTX_MAGIC_CONTEXT_UNAVAILABLE };

  const db = await openMagicContextDatabase(magicContext);
  if (!db) return { errorText: CTX_MAGIC_CONTEXT_UNAVAILABLE };

  // 身份解析与 promotion / ctx_search 共用同一个非抛错入口；undefined = 这个
  // 目录当前不参与记忆特性（家目录未授权 / git 身份暂不可用），写入同样不适用。
  const projectIdentity = magicContext.resolveProjectIdentityForSession(workingDirectory);
  if (!projectIdentity) {
    return {
      errorText: `Error: Memory features are paused for ${workingDirectory} (no usable project identity).`,
    };
  }

  return { magicContext, db, projectIdentity };
}

/**
 * write / archive 共用的失败文案（原 write 路径的 catch 语义原样收进这里）。
 * 两类文本都按 action 分叉：authority 拒绝的措辞与「失败动词」不同。
 */
function magicContextFailureText(
  magicContext: MagicContextModule,
  error: unknown,
  action: "write" | "archive",
): string {
  // Rust 模块托管项目的写入权威在上游 ck-mc 模块（fork 不移植，D-6）：命中即
  // 明确拒绝，而不是绕过 authority 表写坏双源。这是 fail-visible，不是故障。
  if (error instanceof magicContext.ModuleMemoryAuthorityError) {
    return action === "archive"
      ? `Error: Memory archives for this project are managed by the memory module (${error.code}); refusing the TypeScript-side archive.`
      : `Error: Memory writes for this project are managed by the memory module (${error.code}); refusing the TypeScript-side write.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return action === "archive"
    ? `Error: Failed to archive memories. ${message}`
    : `Error: Failed to save memory. ${message}`;
}

/**
 * 「未归档」outcome 的单行文案（spec 变更点 4 的映射表）：
 *   - `already-archived`：幂等回执（该 id 本就归档且未 superseded，没有二次写
 *     mutation 行）；
 *   - `rejected`/superseded：上游 inactiveMemoryError 风格（上游 tools.ts:
 *     349-351 的 "archived or superseded; restore it before archiving"）；
 *   - `rejected`/ownership 与 `missing`：**共用同一条不透明「was not found」**
 *     ——不暴露外部项目记忆 id 的存在性（上游 tools.ts:949-958 与本仓
 *     storage-memory.ts:979-986 的防泄漏纪律）。
 * `archived` 行不经过本函数（由确认行统一覆盖）。
 */
function archiveOutcomeLine(entry: MemoryArchiveOutcomeEntry): string {
  if (entry.outcome === "already-archived") return entry.message;
  if (entry.outcome === "rejected" && entry.rejectionReason === "superseded") {
    return `Error: ${entry.message}`;
  }
  return `Error: Memory with ID ${entry.id} was not found.`;
}

/**
 * 批量归档的工具面文案：全部成功 → 上游同款确认文案（上游 tools.ts:997-1001，
 * reason 非空才带括号）；混合批次（fork 的逐 id 语义允许部分成功）→ 确认行 +
 * 逐 id 文案行。
 */
function formatMemoryArchiveText(outcomes: MemoryArchiveOutcomeEntry[], reason?: string): string {
  const archivedIds = outcomes
    .filter((entry) => entry.outcome === "archived")
    .map((entry) => entry.id);
  const lines: string[] = [];
  if (archivedIds.length > 0) {
    const plural = archivedIds.length > 1 ? "memories" : "memory";
    const trimmedReason = reason?.trim();
    lines.push(
      trimmedReason
        ? `Archived ${plural} [ID: ${archivedIds.join(", ")}] (${trimmedReason}).`
        : `Archived ${plural} [ID: ${archivedIds.join(", ")}].`,
    );
  }
  for (const entry of outcomes) {
    if (entry.outcome === "archived") continue;
    lines.push(archiveOutcomeLine(entry));
  }
  return lines.join("\n");
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
  // action 契约层 optional：缺省即 `"write"`（显式带 action:"write" 与「不带
  // action」在 schema 层就是同一个合法形状，确认文案也因此完全一致）；
  // `"archive"` 走下面的批量废弃分支。
  const action = parsed.action ?? "write";

  // 幂等闸门在参数校验之后、取任何 db 写之前：一次已确认过的 commandId 重放
  // 上次的确认文本，memories 一行都不多、seen_count 一次都不涨（两个 action
  // 共用同一本账）。
  const commandId = commandIdForInvocation(context.sessionId, context);
  const settled = commandIdLedger.get(commandId);
  if (settled !== undefined) {
    return { text: settled } satisfies CtxToolTextOutput;
  }

  // ── archive：批量废弃（软删，spec 变更点 4）───────────────────────────────
  if (action === "archive") {
    const archiveIds = parsed.ids;
    if (!archiveIds || archiveIds.length === 0) {
      // 与上游同款的可自我纠正错误（上游 tools.ts:934-939）；契约层 optional 是
      // 刻意的：缺失字段回普通错误，而不是 provider 侧 schema 拒绝。
      return {
        text: "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
      } satisfies CtxToolTextOutput;
    }

    const session = await openMagicContextSession(context.workingDirectory);
    if ("errorText" in session) {
      return { text: session.errorText } satisfies CtxToolTextOutput;
    }
    const { magicContext, db, projectIdentity } = session;

    try {
      // 首见序去重（上游 tools.ts:941-943）：`ids:[42,42]` 只归档一次、只写一条
      // mutation 行（组合函数 host/memory-admin 内亦有同款防御，这里不重写规则）。
      const dedupedIds = [...new Set(archiveIds)];
      const outcomes = magicContext.archiveProjectMemories(
        db,
        projectIdentity,
        dedupedIds,
        parsed.reason,
      );
      return {
        text: settleCommand(commandId, formatMemoryArchiveText(outcomes, parsed.reason)),
      } satisfies CtxToolTextOutput;
    } catch (error) {
      return {
        text: magicContextFailureText(magicContext, error, "archive"),
      } satisfies CtxToolTextOutput;
    }
  }

  // ── write：钉一条新事实（D14 原有路径）───────────────────────────────────
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

  const session = await openMagicContextSession(context.workingDirectory);
  if ("errorText" in session) {
    return { text: session.errorText } satisfies CtxToolTextOutput;
  }
  const { magicContext, db, projectIdentity } = session;

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
    return {
      text: magicContextFailureText(magicContext, error, "write"),
    } satisfies CtxToolTextOutput;
  }
};

/**
 * `ctx_memory`：把一条值得跨会话保留的事实钉进项目记忆库（write），或按 id
 * 批量废弃已有记忆（archive，软删）。
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
      `The \`action\` argument defaults to \`write\` — it needs \`content\` (the one fact) and \`category\` (PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, or NAMING). Writing a fact that already exists creates no duplicate — the existing memory's seen count is incremented instead. Pass \`action: "archive"\` with \`ids\` (one or more memory IDs, up to 100) and an optional \`reason\` (at most 4096 characters) to retire memories that are wrong or no longer true; archiving is a soft delete, so the memory stops being injected into later sessions.`,
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
