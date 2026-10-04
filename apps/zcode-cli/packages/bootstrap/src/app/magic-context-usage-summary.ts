/**
 * FORK（D-13 / Step 30）——magic-context 预算摘要的**宿主侧读入口**。
 *
 * ============================================================================
 * 为什么在宿主侧而不是包侧
 * ============================================================================
 *
 * `/ctx-status`（Step 21，`packages/magic-context/src/host/ctx-status.ts`）已经把
 * 预算 / compartments / dropped 三段读成了结构化快照
 * （`readMagicContextStatusSnapshot`）。本文件**直接复用它**——不多写一份 SQL，
 * 于是「面板上的数」与「用户敲 `/ctx-status` 看到的数」永远是同一个口径。
 *
 * 唯一多出来的一段是**缓存命中**：`cached_m0_bytes` / `cached_m1_bytes` 是 transform
 * 每轮写进 `session_meta` 的注入块字节，Step 21 的快照没有它，而包 `src/` 在本阶段
 * 是只读的（红线）。所以这一条 SELECT 落在宿主侧，并且刻意做成「读不到就报 null」
 * ——旧库缺列时缓存状态是**不知道**，不是「没命中」。
 *
 * ============================================================================
 * 缺席 vs 零
 * ============================================================================
 *
 * `readMagicContextUsageSummary` 返回 `null` 表示「这份会话现在没有可展示的读数」
 * （库打不开、`session_meta` 读不出来、字段全是未知）。投影层据此**删掉**
 * `usage.magicContext` 键，UI 整段不渲染。全零对象会被渲染成一段假的
 * 「预算 0 / compartments 0」——那比不显示更坏。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import {
  readMagicContextStatusSnapshot,
  type ContextDatabase,
} from "@zcode/magic-context";
import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";

/** 一次读取的结果：`usage` 为 `null` 即「没有可展示的读数」。 */
export interface MagicContextUsageSummary {
  usage: SessionMagicContextUsage | null;
}

/**
 * 读一份 magic-context 预算摘要。
 *
 * **只读**：走的是包侧那条纯读快照 + 一条 `SELECT`。它**不**修复
 * `readMagicContextStatusSnapshot` 里 `getOrCreateSessionMeta` 的建行副作用——那是 A
 * 组既有语义，`/ctx-status` 与本函数同一条路径，不在这里另立一套。
 *
 * 永不抛：这是纯展示面，诊断读失败不该打断一轮对话；失败即 `null`。
 */
export async function readMagicContextUsageSummary(
  db: ContextDatabase,
  sessionId: string,
): Promise<MagicContextUsageSummary> {
  // 显式的 nullish 守卫：包侧 `readMagicContextStatusSnapshot` 的 `options.db ?? …`
  // 在 db 为 null 时会**回退去打开默认存储**（也就是用户真实的
  // `~/.zcode/magic-context.db`），而这里要的恰恰是「没有库 ⇒ 没有读数」。
  // 生产路径上 `db` 必非空（`createMagicContextTurnTransform` 打不开库就直接
  // return undefined），所以这条守卫是给未来的调用方与本测试用的护栏。
  if (!db) return { usage: null };
  try {
    const snapshot = await readMagicContextStatusSnapshot({ db, sessionId });
    if (!snapshot) return { usage: null };
    return {
      usage: {
        budgetTokens: snapshot.protectedTokensFloor,
        usedTokens: nonNegative(snapshot.lastInputTokens),
        usedPercent: finite(snapshot.contextPercentage, 0),
        compartmentCount: nonNegative(snapshot.compartmentCount),
        droppedTagCount: nonNegative(snapshot.tags.dropped.count),
        droppedTagTokens: nonNegative(snapshot.tags.dropped.tokens),
        cache: readInjectedBlockCache(db, sessionId),
      },
    };
  } catch {
    return { usage: null };
  }
}

/**
 * `cached_m0_bytes` / `cached_m1_bytes` 是否存在。
 *
 * 有字节 = 这一轮的 m[0]/m[1] 注入块**直接来自上下文缓存**（没有重新物化）；
 * NULL 或零长 = 重新算过。两列都读不到（迁移前的库）时返回 `null` ——「不知道」
 * 与「都没命中」在 UI 上必须分得开。
 */
function readInjectedBlockCache(
  db: ContextDatabase,
  sessionId: string,
): SessionMagicContextUsage["cache"] {
  try {
    const row = db
      .prepare(
        "SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1 FROM session_meta WHERE session_id = ?",
      )
      .get(sessionId) as { m0?: unknown; m1?: unknown } | undefined;
    if (!row || row.m0 === undefined || row.m1 === undefined) return null;
    return { m0: isCachedBlock(row.m0), m1: isCachedBlock(row.m1) };
  } catch {
    return null;
  }
}

/** SQLite 的 BLOB 缺席是 `null`；空 BLOB（零长 Uint8Array）同样算「没缓存住」。 */
function isCachedBlock(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Uint8Array) return value.byteLength > 0;
  if (typeof value === "number") return value > 0;
  return false;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}