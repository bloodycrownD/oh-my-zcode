/**
 * Step 22 — `/ctx-recomp` 的包侧入口（本地命令语义）。
 *
 * ============================================================================
 * 简化语义，以及它为什么长这样
 * ============================================================================
 *
 * 上游的 `/ctx-recomp` 由 `hooks/magic-context/recomp-orchestrator.ts` 实现，SPEC
 * 把它连同 status-view 栈一起列进「明确不搬」（约 2137 行，深度耦合 OpenCode 的
 * RPC/TUI 事件通道）。它做的事是：丢掉本会话已压缩的 compartments，让 historian
 * 重跑一遍——**同步**完成。
 *
 * fork 首版不搬那条路，因为同步全量重建需要 C 组的 historian executor 接线（宿主
 * hidden-completion 通道），那是 S24 的活。所以这里给的是一个**接端口**：
 *
 *   - 装配层（S24）可以通过 {@link setMagicContextRecompRunner} 装一个真 runner；
 *     装了就跑真的重算，并把结果如实报回去。
 *   - 没装（当前形态）时 {@link requestMagicContextRecompute} **不假装做过任何事**：
 *     它返回 `runner: "unavailable"`，命令据此把边界说清楚（「排重算的接线还没接上，
 *     现在给出的是重建前的状态」），而不是回一句「已重建」然后什么都不做。
 *
 * 这就是 SPEC 说的「首版可只做触发一次 compartment 重算的简化语义并在帮助文案
 * 注明」的落点：简化的是**执行**，不是**表述**。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import { getCompartments } from "../core/features/magic-context/compartment-storage.js";
import type { ContextDatabase } from "../core/features/magic-context/storage-db.js";

/** `/ctx-recomp` 的范围参数：`full` 或一段 message ordinal 区间。 */
export type MagicContextRecompScope =
  | { kind: "full" }
  | { kind: "partial"; end: number; start: number };

/** 一次重算请求的结果。`runner: "unavailable"` 时**没有发生任何重建**。 */
export interface MagicContextRecompOutcome {
  /** 重算前已有的 compartment 条数（重建前的事实，不因是否接线而变）。 */
  compartmentsBefore: number;
  /** runner 报告的重建条数；`unavailable` 时为 0。 */
  recompacted: number;
  /** 实际跑重建的那一层：`host` = 装配层装的 runner；`unavailable` = 还没接线。 */
  runner: "host" | "unavailable";
  scope: MagicContextRecompScope;
}

/** 装配层提供的真 runner。返回重建后的 compartment 条数。 */
export type MagicContextRecompRunner = (input: {
  db: ContextDatabase;
  range?: { end: number; start: number };
  sessionId: string;
}) => Promise<number> | number;

let hostRunner: MagicContextRecompRunner | null = null;

/**
 * 装 / 卸装配层的重算 runner。幂等、可重复调用；传 `undefined` 恢复「未接线」。
 *
 * **必须**在任何 `/ctx-recomp` 之前调用（进程启动期，由 bootstrap 装配）。运行中
 * 换 runner 会让同一会话前后两次重算走两条不同的实现。
 */
export function setMagicContextRecompRunner(runner?: MagicContextRecompRunner | null): void {
  hostRunner = runner ?? null;
}

/** 当前 runner 是否已接线。诊断面（`/ctx-status` 与测试都用它断言边界）。 */
export function isMagicContextRecompRunnerRegistered(): boolean {
  return hostRunner !== null;
}

export interface RequestMagicContextRecomputeOptions {
  db: ContextDatabase;
  scope?: MagicContextRecompScope;
  sessionId: string;
}

/**
 * 触发一次 compartment 重算。
 *
 * **绝不抛**：这是一条诊断/控制命令，重算失败要以 outcome 的形式回到命令输出里，
 * 而不是变成一个 CLI 层的未捕获 rejection。
 */
export async function requestMagicContextRecompute(
  options: RequestMagicContextRecomputeOptions,
): Promise<MagicContextRecompOutcome> {
  const scope: MagicContextRecompScope = options.scope ?? { kind: "full" };
  const compartmentsBefore = countCompartments(options.db, options.sessionId);
  if (!hostRunner) {
    return { compartmentsBefore, recompacted: 0, runner: "unavailable", scope };
  }
  try {
    const recompacted = await hostRunner({
      db: options.db,
      ...(scope.kind === "partial" ? { range: { end: scope.end, start: scope.start } } : {}),
      sessionId: options.sessionId,
    });
    return {
      compartmentsBefore,
      recompacted:
        typeof recompacted === "number" && Number.isFinite(recompacted) ? recompacted : 0,
      runner: "host",
      scope,
    };
  } catch (error) {
    // runner 抛错也是一条 outcome：命令会把它渲染成用户可见的失败，而不是崩掉 TUI。
    return { compartmentsBefore, recompacted: 0, runner: "unavailable", scope };
  }
}

function countCompartments(db: ContextDatabase, sessionId: string): number {
  try {
    return getCompartments(db, sessionId).length;
  } catch {
    return 0;
  }
}
