// ============================================================
// ctx_search Tool Handler (Step 10 / D4)
// ============================================================
// magic-context 记忆检索面（关键词 / FTS5）的 ZCode 侧薄封装。契约面在
// `@zcode/contracts` 的 `tools/ctx-context.ts`；本文件做四件事：
//
//   1. 用 contracts 的 zod 面做运行时校验，把输出包成 `{ text }`；
//   2. 把 `ToolExecutionContext` 投影成检索需要的三个量（workingDirectory /
//      sessionId / toolCallId）；
//   3. **复用包侧真身**：`resolveProjectIdentityForSession`（身份解析）、
//      `searchMemoriesFTS`（含 `sanitizeFtsQuery` / `relaxedFtsQuery` 的查询消毒
//      与两级放宽）、`getVisibleMemoryIds`（已在 <project-memory> 渲染过的记忆，
//      与 inject-compartments 的 m0/m1 注入读同一列）。**不自造查询消毒逻辑**——
//      那是 Step 8 已移植的逐字层；
//   4. 声明权限与预算。
//
// **fork 契约面与上游的差异（Step 10 裁定，登记备查）**：
//   - 只检索 memory 一个来源。上游 unifiedSearch 的 message / git_commit /
//     primer / note 四路分别依赖 raw-message 检索 lane、git 索引、dreamer
//     产物；note 属 N2、向量语义召回属 N1，均终局不做。契约里因此没有 `sources`。
//   - 无向量路径：`searchMemoriesFTS` 是纯 FTS5 MATCH + bm25，不碰
//     memory_embeddings（embedding 运行时 N1 终局不做）。
//   - id 形状短路（`#7234` / `12, 34`）保留：<project-memory> 的 `#id: fact`
//     行会让模型自然把 id 抄进 query，FTS 对裸数字没有语义，这一路是上游
//     `parseIdShapedQuery` 的 fork 等价物（按身份过滤、排除已渲染 id，
//     解析不到时落回 FTS，与上游「a numeric query with no matching memory
//     still searches text」同语义）。
//
// **包是动态 import 的**，与 `ctx-context.ts` 同一理由：`features.magicContext`
// 关闭时，CLI 启动不该把整棵 magic-context 模块图拉进内存；静态 import 会在
// 工具注册那一刻就发生，flag 就再也管不住它。

import {
  CTX_SEARCH_TOOL_NAME,
  CtxSearchInputJsonSchema,
  CtxSearchInputSchema,
  CtxToolTextOutputJsonSchema,
  CtxToolTextOutputSchema,
  type CtxSearchInput,
  type CtxToolTextOutput,
} from "@zcode/contracts";
import type { ModelMessageContent } from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** 一次最多回 24K token 的命中原文；留余量给模型侧包装。 */
const CTX_SEARCH_MODEL_BYTES = 60_000;
const CTX_TOOL_TIMEOUT_MS = 30_000;
/** 缺省命中条数；契约层 cap 在 50，防「一次倒完整库」把上下文打爆。 */
const CTX_SEARCH_DEFAULT_LIMIT = 10;
const CTX_SEARCH_MAX_LIMIT = 50;
/** id 形状短路一次最多直查多少个 id（上游 ID_SHAPED_QUERY_MAX_TOKENS 同值）。 */
const CTX_SEARCH_MAX_ID_TOKENS = 16;

/** 包侧能力缺席（flag off / db 打不开）时的用户可见文本。 */
const CTX_MAGIC_CONTEXT_UNAVAILABLE =
  "Magic Context is not available in this session; ctx tools are inert.";

type MagicContextModule = typeof import("@zcode/magic-context");

/** 检索结果行的投影（只取 handler 渲染要用的量，不把包类型泄进 core 的类型面）。 */
interface MemorySearchHit {
  id: number;
  category: string;
  content: string;
  status: string;
  updatedAt: number;
}

/**
 * 动态加载 magic-context 包。**永不抛**：加载失败等价于「本会话没有 magic-context」，
 * 由调用方转成缺席文本，而不是把一次工具调用变成一个工具错误。
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

/** 输入 id 集合的构造：`#7234` / `12, 34` / `12 34` 都认，非法形状返回 null。 */
function parseIdShapedQuery(query: string): number[] | null {
  const tokens = query.split(/[\s,]+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > CTX_SEARCH_MAX_ID_TOKENS) return null;
  const ids: number[] = [];
  for (const token of tokens) {
    if (!/^#?\d+$/.test(token)) return null;
    const parsed = Number.parseInt(token.replace(/^#/, ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    ids.push(parsed);
  }
  return ids;
}

/**
 * `YYYY-MM-DD` → UTC 毫秒（闭区间语义：`from` 取当日 00:00，`to` 取当日 23:59:59.999）。
 * 返回 null 表示非法日期，由调用方转成模型可自我纠正的错误文本。
 */
function parseDateBoundary(value: string, endOfDay: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const roundTrips = new Date(at).toISOString().slice(0, 10);
  if (roundTrips !== `${year}-${month}-${day}`) return null;
  return endOfDay ? at + 86_399_999 : at;
}

function formatIsoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** 命中行渲染。score 不投影（搜索层只按 bm25 排序，不把分值传出），改报更新时间。 */
function formatSearchHit(hit: MemorySearchHit, index: number): string {
  return [
    `[${index}] [memory] id=#${hit.id} category=${hit.category} updated=${formatIsoDate(hit.updatedAt)}`,
    hit.content,
  ].join("\n");
}

function formatSearchOutput(
  query: string,
  hits: readonly MemorySearchHit[],
  suppressedVisibleIds: readonly number[],
): string {
  const suppressedNote =
    suppressedVisibleIds.length > 0
      ? [
          "",
          suppressedVisibleIds.length === 1
            ? `Memories: 1 additional match suppressed because it is already visible in your project-memory block (id #${suppressedVisibleIds[0]}).`
            : `Memories: ${suppressedVisibleIds.length} additional matches suppressed because they are already visible in your project-memory block (ids ${suppressedVisibleIds
                .map((id) => `#${id}`)
                .join(", ")}).`,
        ].join("\n")
      : "";
  if (hits.length === 0) {
    return [`No results found for "${query}" in this project's memory store.`, suppressedNote]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Found ${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}":`,
    "",
    ...hits.map((hit, index) => formatSearchHit(hit, index + 1)),
    suppressedNote,
  ]
    .filter(Boolean)
    .join("\n");
}

const ctxSearchHandler: ToolHandler = async (input, context) => {
  const parsed = CtxSearchInputSchema.parse(input) as CtxSearchInput;
  const query = parsed.query?.trim();
  if (!query) {
    return { text: "Error: 'query' is required." } satisfies CtxToolTextOutput;
  }

  let dateRange: { from: number; to: number } | null = null;
  if (parsed.from !== undefined || parsed.to !== undefined) {
    const from = parsed.from === undefined ? 0 : parseDateBoundary(parsed.from, false);
    const to =
      parsed.to === undefined ? Number.MAX_SAFE_INTEGER : parseDateBoundary(parsed.to, true);
    if (from === null || to === null) {
      return {
        text: `Error: Invalid date ${from === null ? `'${parsed.from}'` : `'${parsed.to}'`} — expected YYYY-MM-DD.`,
      } satisfies CtxToolTextOutput;
    }
    dateRange = { from, to };
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(parsed.limit ?? CTX_SEARCH_DEFAULT_LIMIT) || CTX_SEARCH_DEFAULT_LIMIT),
    CTX_SEARCH_MAX_LIMIT,
  );

  const magicContext = await loadMagicContext();
  if (!magicContext) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  const db = await openMagicContextDatabase(magicContext);
  if (!db) return { text: CTX_MAGIC_CONTEXT_UNAVAILABLE } satisfies CtxToolTextOutput;

  // 身份解析与记忆写入面（promotion / inject-compartments）用的是同一个非抛错
  // 入口：undefined = 这个目录当前不参与记忆特性（家目录未授权 / git 身份暂不可用），
  // 对检索就是「没有可检索的项目」。
  const projectIdentity = magicContext.resolveProjectIdentityForSession(context.workingDirectory);
  if (!projectIdentity) {
    return {
      text: `Error: Memory features are paused for ${context.workingDirectory} (no usable project identity).`,
    } satisfies CtxToolTextOutput;
  }

  // m0/m1 已渲染的记忆列：null = 本会话还没有渲染过记忆块，不过滤。
  // 读取失败同样按 null 处理（最坏是一次冗余命中，不是正确性问题）——与包内
  // getVisibleMemoryIds 的注释语义一致。
  const visibleIds = magicContext.getVisibleMemoryIds(db, context.sessionId);
  const suppressedVisibleIds: number[] = [];

  const isVisible = (id: number): boolean => {
    if (visibleIds?.has(id)) {
      suppressedVisibleIds.push(id);
      return true;
    }
    return false;
  };

  // ── id 形状短路 ────────────────────────────────────────────────────────────
  const idShape = parseIdShapedQuery(query);
  if (idShape !== null) {
    const uniqueIds = [...new Set(idShape)].slice(0, limit);
    const rows = magicContext.getMemoriesByIds(db, uniqueIds);
    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
      if (dateRange && (row.createdAt < dateRange.from || row.createdAt > dateRange.to)) continue;
      if (row.status !== "active" && row.status !== "permanent" && row.status !== "archived") {
        continue;
      }
      if (!magicContext.storedPathBelongsToIdentity(row.projectPath, projectIdentity)) continue;
      if (isVisible(row.id)) continue;
      hits.push({
        id: row.id,
        category: row.category,
        content: row.content,
        status: row.status,
        updatedAt: row.updatedAt,
      });
    }
    if (hits.length > 0) {
      return {
        text: formatSearchOutput(query, hits, suppressedVisibleIds),
      } satisfies CtxToolTextOutput;
    }
    // id 解析不到任何行时**落回 FTS**（上游同语义：数字 query 也可能是要搜的词）。
    suppressedVisibleIds.length = 0;
  }

  // ── FTS5 关键词检索（含消毒与放宽，全部在包侧逐字层） ──────────────────────
  const rows = magicContext.searchMemoriesFTS(db, projectIdentity, query, limit, dateRange);
  const hits: MemorySearchHit[] = [];
  for (const row of rows) {
    if (isVisible(row.id)) continue;
    hits.push({
      id: row.id,
      category: row.category,
      content: row.content,
      status: row.status,
      updatedAt: row.updatedAt,
    });
  }

  return {
    text: formatSearchOutput(query, hits, suppressedVisibleIds),
  } satisfies CtxToolTextOutput;
};

/**
 * `ctx_search`：在本项目的记忆库里找「以前就知道、现在不在桌上」的事实。
 *
 * permission 归类：仓库既有的**低风险只读类**——`readOnly: true` +
 * `sideEffectScope: "none"` + `riskLevel: "low"` + `needsApproval: false`，与
 * `ctx_expand` / `ListSavedWorkflows` 同款。它只读 magic-context.db 的记忆表，
 * 不写任何一侧。
 */
export const ctxSearchToolEntry: ToolEntry = {
  capability: "Search this project's durable memory store for facts no longer in context",
  metadata: {
    name: CTX_SEARCH_TOOL_NAME,
    description: [
      `Search this project's durable memory store — every fact the project has kept across sessions, not just the lines currently in your <project-memory> block.`,
      ``,
      `Write the query as a natural-language question that still carries the exact terms you expect in the answer (a config key, a path, a convention name); matching is keyword-based over the full memory text, so a bare keyword stack finds less. A query that is only memory ids (\`#7234\`, \`12, 34\`) resolves those ids directly.`,
      ``,
      `Memories already visible in your current context are filtered out of the results, so anything that comes back is something you cannot currently see. Use from/to (YYYY-MM-DD, inclusive) to restrict to a date range, and limit to cap the number of hits.`,
      ``,
      `Reach for it when you are about to re-derive something the project probably already knows — a convention, a constraint, a decision and its reason, a config value — and especially before re-reading files to recover it.`,
      `Use it proactively: the question "have we settled this before?" is exactly what this tool answers, and you do not have to wait to be asked.`,
    ].join("\n"),
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CTX_TOOL_TIMEOUT_MS,
    maxOutputBytes: CTX_SEARCH_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: ctxSearchHandler,
  formatModelContent: formatCtxToolTextModelContent,
  inputSchema: CtxSearchInputJsonSchema,
  outputSchema: CtxToolTextOutputJsonSchema,
  runtimeInputSchema: CtxSearchInputSchema,
  runtimeOutputSchema: CtxToolTextOutputSchema,
  permission: {
    permission: "magicContext.search",
    reason: "ctx_search only reads Magic Context's own project memory store",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // 纯读，且参数里没有任何路径主体（identity 由 workingDirectory 解析），
    // 所以只按工具名匹配。
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: CTX_SEARCH_MODEL_BYTES,
    maxModelBytes: CTX_SEARCH_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CTX_SEARCH_MODEL_BYTES,
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
    userVisibleMessage: "ctx_search was cancelled before the search ran",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    // 输出是记忆原文（可能含项目敏感事实），按 summary 记而不是 full。
    recordOutput: "summary",
  },
};

/** 与 ctx-context.ts 同一形状的模型面投影；本文件不 import 那个文件，避免把
 *  ctx_reduce/ctx_expand 的整棵依赖拖进 ctx_search 的加载路径（flag off 时两者
 *  都不该被 import，分开文件让加载边界保持清晰）。 */
function formatCtxToolTextModelContent(output: unknown): ModelMessageContent {
  const parsed = CtxToolTextOutputSchema.safeParse(output);
  if (!parsed.success) return "ctx tool returned an invalid result.";
  return parsed.data.text;
}
