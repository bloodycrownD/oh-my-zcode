/**
 * `/ctx-*` 本地命令（S22）——magic-context 上下文控制面。
 *
 * ============================================================================
 * 替代 Effect 204 sentinel
 * ============================================================================
 *
 * 上游的做法（`.reference/.../hooks/magic-context/command-handler.ts:198-227`）：
 * 命令执行完后 `throwSentinel(command)`——抛一个普通 `Error`，但这个 error 上挂了
 * 一组**以纯字符串为键**的 Effect TypeId（`~effect/http/HttpServerResponse` 等），
 * 于是 OpenCode 的 HTTP 错误边界认得它，把它写成一个真正的 204，从而既不让命令被
 * 转发给 LLM、也不在 TUI/日志里漏一条错误。那套技巧依赖 OpenCode 编译产物里的
 * effect 4.x，外部插件的模块解析根本够不到它——源注释自己写明「这是鸭子类型 shim，
 * 真正的修复是官方的 `command.execute.before` handled/noReply 契约」。
 *
 * fork 不需要它：**命令在 command-center 里就被消费掉了**，返回值直接进
 * `TuiSubmitPromptResult.response`，永远不会走到 `app.submitPrompt`。因此不存在
 * 「被转发给 LLM」这条路径，也就不需要任何哨兵来阻断它。本文件就是那个替代物：
 * 同步算完，同步把文本还给 TUI。
 *
 * ============================================================================
 * 四个命令的语义
 * ============================================================================
 *
 *   - `/ctx-status`  只读快照（预算 / compartments / dropped 统计），经包 API 读
 *                     `magic-context.db`。不搬源的 status-view 栈（约 2137 行，
 *                     深度耦合 OpenCode RPC/TUI）。
 *   - `/ctx-reduce`  触发 `ctx_reduce` 工具同一条路径：解析 `drop` → 包内排队 →
 *                     回确认文本。命令侧**不自己**写 `pending_ops`，否则同一件事会有
 *                     两条实现、两套幂等。
 *   - `/ctx-expand`  同样触发 `ctx_expand` 工具路径；参数按工具同款解析
 *                     （`tag=N` / `message=N` / `start-end` / `verbose`）。
 *   - `/ctx-recomp`  **简化语义**：触发一次 compartment 重算。真 runner 由装配层
 *                     （S24）经 `setMagicContextRecompRunner` 装上；没装时如实回报
 *                     「runner 未接线、什么都没重建」，并给出重建前的状态。帮助
 *                     文案注明这是简化首版。
 *
 * 包是**动态 import** 的：`features.magicContext` 关闭时（D-11 默认态）不应因为一
 * 条 `/ctx-status` 就把整棵 magic-context 模块图拉进内存——而这条命令完全可能在
 * 那个状态下被敲出来。
 */

import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps } from "../types.js";

/** 四个命令的机器可读名。`slash-commands.ts` 的解析结果直接带这个名。 */
export type CtxCommandName = "ctx-status" | "ctx-reduce" | "ctx-expand" | "ctx-recomp";

const USAGE: Record<CtxCommandName, string> = {
  "ctx-expand": "Usage: /ctx-expand [tag=N | message=N | <start>-<end>] [verbose]",
  "ctx-recomp": "Usage: /ctx-recomp [full | <start>-<end>]",
  "ctx-reduce": "Usage: /ctx-reduce <tag-ids>   e.g. /ctx-reduce 3-5, 8, 12-15",
  "ctx-status": "Usage: /ctx-status",
};

const MAGIC_CONTEXT_UNAVAILABLE =
  "Magic Context is not available in this session; enable features.magicContext to use /ctx-* commands.";

/** 包不可用 / 加载失败。命令**不抛**：一条诊断命令失败不该打断会话。 */
export async function handleCtxCommand(
  name: CtxCommandName,
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const trimmed = args.trim();

  if (name === "ctx-reduce" && trimmed.length === 0) {
    return respond(USAGE["ctx-reduce"], deps);
  }

  const magicContext = await loadMagicContext();
  if (!magicContext) {
    return respond(MAGIC_CONTEXT_UNAVAILABLE, deps);
  }

  try {
    if (name === "ctx-status") {
      return respond(await readStatus(magicContext, deps), deps);
    }
    if (name === "ctx-reduce") {
      return respond(await reduce(magicContext, deps, trimmed), deps);
    }
    if (name === "ctx-expand") {
      return respond(await expand(magicContext, deps, trimmed), deps);
    }
    return respond(await recomp(magicContext, deps, trimmed), deps);
  } catch (error) {
    return respond(describeFailure(error), deps);
  }
}

/**
 * 包加载。**永不抛**——`import()` 失败等价于「这个会话没有 magic-context」。
 */
async function loadMagicContext(): Promise<typeof import("@zcode/magic-context") | null> {
  try {
    return await import("@zcode/magic-context");
  } catch {
    return null;
  }
}

/** 会话身份：命令只作用于**当前会话**，模型无权指定别的 sessionId。 */
async function resolveSessionId(deps: CommandCenterDeps): Promise<string | null> {
  try {
    const app = await deps.getApp();
    return app.sessionId;
  } catch {
    return null;
  }
}

async function openStore(
  magicContext: typeof import("@zcode/magic-context"),
): Promise<Awaited<ReturnType<typeof magicContext.openDatabase>>> {
  try {
    return magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
  } catch {
    return null;
  }
}

/** `/ctx-status`：纯读快照。 */
async function readStatus(
  magicContext: typeof import("@zcode/magic-context"),
  deps: CommandCenterDeps,
): Promise<string> {
  const sessionId = await resolveSessionId(deps);
  if (!sessionId) return MAGIC_CONTEXT_UNAVAILABLE;
  // 不传 db：包自己按 host 的存储解析打开（`getMagicContextDatabasePath()`），
  // 于是「哪一条 db」只有一个答案，与 transform 那条路径同源。
  const snapshot = await magicContext.readMagicContextStatusSnapshot({ sessionId });
  return magicContext.formatMagicContextStatusSnapshot(snapshot);
}

/** `/ctx-reduce <tag-ids>`：走 `ctx_reduce` 工具同一条路径。 */
async function reduce(
  magicContext: typeof import("@zcode/magic-context"),
  deps: CommandCenterDeps,
  drop: string,
): Promise<string> {
  const sessionId = await resolveSessionId(deps);
  if (!sessionId) return MAGIC_CONTEXT_UNAVAILABLE;
  const db = await openStore(magicContext);
  if (!db) return MAGIC_CONTEXT_UNAVAILABLE;

  const tools = magicContext.createCtxReduceTools({ db });
  // commandId 用 `slash:<name>:<args>`：同一条命令文本重复敲两次得到同一个 id，
  // 于是第二次由幂等账本回放上一次的确认文本，而不是再排一遍队。
  return tools.ctx_reduce.execute(
    { drop },
    { callID: `slash:${drop}`, directory: undefined, sessionID: sessionId },
  );
}

/**
 * `/ctx-expand [tag=N | message=N | <start>-<end>] [verbose]`。
 *
 * 参数解析刻意与 `ctx_expand` 工具**同款**（`tag=` 前缀、`start-end` 连字号、
 * 尾随的 `verbose` 布尔），这样一条命令与一次工具调用对同一段历史给出同一个答案；
 * 解析出来的对象直接喂给工具，mode 判定仍由包内那份逐字移植的
 * `resolveCtxExpandMode` 做。
 */
async function expand(
  magicContext: typeof import("@zcode/magic-context"),
  deps: CommandCenterDeps,
  raw: string,
): Promise<string> {
  const sessionId = await resolveSessionId(deps);
  if (!sessionId) return MAGIC_CONTEXT_UNAVAILABLE;
  const parsed = parseExpandArgs(raw);
  if ("error" in parsed) return parsed.error;

  const db = await openStore(magicContext);
  if (!db) return MAGIC_CONTEXT_UNAVAILABLE;

  const tools = magicContext.createCtxExpandTools({ db });
  return tools.ctx_expand.execute(
    { ...parsed.args, reduced: false },
    { callID: `slash:${raw}`, directory: undefined, sessionID: sessionId },
  );
}

/**
 * `/ctx-recomp [full | <start>-<end>]`——**简化语义**。
 *
 * 走包侧的 `requestMagicContextRecompute`：真 runner 由装配层（S24）经
 * `setMagicContextRecompRunner` 装上时它跑真的重建；没装时它回报
 * `runner: "unavailable"`，本函数据此把边界说清楚（给出重建前的状态，并说明
 * 同步重建的接线还没接上）——**不**谎称已经重建。上游那条同步全量重建走的是
 * `recomp-orchestrator`（SPEC「明确不搬」），依赖 C 组 historian executor 接线。
 * 简化的是执行，不是表述；帮助文案里也注明了这一点。
 */
async function recomp(
  magicContext: typeof import("@zcode/magic-context"),
  deps: CommandCenterDeps,
  raw: string,
): Promise<string> {
  const parsed = parseRecompArgs(raw);
  if ("error" in parsed) return parsed.error;

  const sessionId = await resolveSessionId(deps);
  if (!sessionId) return MAGIC_CONTEXT_UNAVAILABLE;
  const db = await openStore(magicContext);
  if (!db) return MAGIC_CONTEXT_UNAVAILABLE;

  const outcome = await magicContext.requestMagicContextRecompute({
    db,
    scope:
      parsed.kind === "partial"
        ? { end: parsed.end, kind: "partial", start: parsed.start }
        : { kind: "full" },
    sessionId,
  });

  const scope =
    outcome.scope.kind === "partial"
      ? `messages ${outcome.scope.start}-${outcome.scope.end}`
      : "the full compacted history";

  if (outcome.runner === "unavailable") {
    return [
      `Recompute for ${scope} was requested but the rebuild runner is not wired yet, so nothing was rebuilt.`,
      `Compartments now: ${outcome.compartmentsBefore}.`,
      "This is the simplified first version of /ctx-recomp: it reports the pre-rebuild state instead of rebuilding history synchronously. Memories are not changed either way.",
    ].join("\n");
  }

  return [
    `Recomputed ${outcome.recompacted} compartment(s) for ${scope}.`,
    `Compartments before: ${outcome.compartmentsBefore}.`,
    "Memories are not changed.",
  ].join("\n");
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

type ExpandParse =
  | {
      args: {
        end?: number;
        message?: number;
        start?: number;
        tag?: number | string;
        verbose?: boolean;
      };
    }
  | { error: string };

/**
 * `tag=N` / `message=N` / `<start>-<end>` / 尾随 `verbose`。
 * 也接受裸的 `N`：裸数字先按 ordinal（message）读，因为用户手里最常有的就是一个
 * `<session-history>` 标题里的序号；tag 必须显式写 `tag=`（与工具描述一致）。
 */
export function parseExpandArgs(raw: string): ExpandParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: USAGE["ctx-expand"] };

  const tokens = trimmed.split(/\s+/);
  const args: {
    end?: number;
    message?: number;
    start?: number;
    tag?: number | string;
    verbose?: boolean;
  } = {};
  const loose: number[] = [];

  for (const token of tokens) {
    if (token.toLowerCase() === "verbose") {
      args.verbose = true;
      continue;
    }
    const assigned = /^(tag|message|start|end)=(.+)$/i.exec(token);
    if (assigned) {
      const key = assigned[1]!.toLowerCase();
      const value = assigned[2]!;
      if (key === "tag") {
        args.tag = /^\d+$/.test(value) ? Number(value) : value;
        continue;
      }
      if (!/^\d+$/.test(value)) {
        return { error: `Error: ${key} must be an integer (got "${value}").` };
      }
      args[key as "end" | "message" | "start"] = Number(value);
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      args.start = Number(range[1]);
      args.end = Number(range[2]);
      continue;
    }
    if (/^\d+$/.test(token)) {
      loose.push(Number(token));
      continue;
    }
    return { error: `Error: cannot parse "${token}".\n\n${USAGE["ctx-expand"]}` };
  }

  if (
    args.start === undefined &&
    args.end === undefined &&
    args.message === undefined &&
    args.tag === undefined &&
    loose.length > 0
  ) {
    [args.message] = loose;
  }
  return { args };
}

type RecompParse =
  | { kind: "full" }
  | { kind: "partial"; end: number; start: number }
  | { error: string };

/** 参数文法与包内那份逐字移植的 `parseRecompArgs` 同款（`full` / `--upgrade` / 区间）。 */
export function parseRecompArgs(raw: string): RecompParse {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "full" || trimmed === "--upgrade") {
    return { kind: "full" };
  }
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (!match)
    return { error: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${USAGE["ctx-recomp"]}` };
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2]!, 10);
  if (start < 1) return { error: `Start must be >= 1 (got ${start}).` };
  if (end < start) return { error: `End must be >= start (got ${start}-${end}).` };
  return { end, kind: "partial", start };
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Magic Context command failed: ${message}`;
}

function respond(response: string, deps: CommandCenterDeps): TuiSubmitPromptResult {
  return { mode: deps.getMode?.(), response };
}
