/**
 * Step 21 — `/ctx-status` 文本快照（包侧）。
 *
 * ============================================================================
 * 为什么是「包侧新写」而不是移植
 * ============================================================================
 *
 * SPEC 的「明确不搬」段点名了 `/ctx-status` 与 `/ctx-recomp` 的源实现 5 文件
 * （`hooks/magic-context/execute-status.ts`、`shared/status-view.ts`、
 * `shared/status-view-check.ts`、`shared/format-threshold.ts`、
 * `hooks/magic-context/recomp-orchestrator.ts`，合计约 2137 行）：它们深度耦合
 * OpenCode 的 RPC / TUI 事件通道，在 ZCode 侧没有对应物。因此 `/ctx-status` 在
 * fork 里降级为**一个纯函数**：给定 `magic-context.db` 的读句柄与 sessionId，返回
 * 一份可断言的文本快照。
 *
 * 这份快照回答的是「现在这台机器上的 magic-context 处于什么状态」，三段内容：
 *
 *   1. **预算**（budget）：`session_meta` 里冻结的 protected floor、上一次 pass 的
 *      context 占用百分比与 input tokens。逐字取自 A 组已落地的 `session_meta` 行。
 *   2. **Compartments**：数量、最后一条覆盖到的 message ordinal（压缩历史与 live
 *      tail 的分界）、以及是否还有 pending materialization。
 *   3. **Dropped 统计**：按 `tags.status` 分桶（active / dropped / compacted）的行数
 *      与 token 合计，外加 pending_ops 队列深度。
 *
 * 每一段都从**只读** SQL / A 组读函数来，不写库、不碰 messageHistory、不触发任何
 * 重活（这是「status 不能有副作用」这条不变式在 fork 侧的落点）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import {
  getCompartments,
  getLastCompartmentEndMessage,
} from "../core/features/magic-context/compartment-storage.js";
import { getOrCreateSessionMeta } from "../core/features/magic-context/storage-meta.js";
import { getPendingOpsCount } from "../core/features/magic-context/storage-ops.js";
import { renderUserFacingFailure } from "../core/shared/user-facing-codes.js";
import type { ContextDatabase } from "../core/features/magic-context/storage-db.js";

/** 一个 tag 状态桶的行数与 token 合计。 */
export interface CtxStatusTagBucket {
  /** 该桶的行数。 */
  count: number;
  /** 该桶的 `token_count` 合计（COALESCE 0）。 */
  tokens: number;
}

/** `/ctx-status` 的结构化快照。字段全是「读出来的数」，不含任何解释性文案。 */
export interface MagicContextStatusSnapshot {
  sessionId: string;
  /** `session_meta.protected_tokens_effective`（epoch floor 快照）；null = 从未冻结。 */
  protectedTokensFloor: number | null;
  /** 上一次 pass 的 context 占用百分比（0–100）。 */
  contextPercentage: number;
  /** 上一次 pass 的 input tokens。 */
  lastInputTokens: number;
  /** 已压缩的 compartment 条数。 */
  compartmentCount: number;
  /** 最后一条 compartment 覆盖到的 message ordinal；-1 = 还没有任何 compartment。 */
  lastCompartmentEndMessage: number;
  /** pending_ops 队列深度；null = 读不到（诊断读，永不抛）。 */
  pendingOps: number | null;
  /** `tags.status` 的三桶统计。 */
  tags: {
    active: CtxStatusTagBucket;
    dropped: CtxStatusTagBucket;
    compacted: CtxStatusTagBucket;
  };
}

export interface ReadMagicContextStatusOptions {
  /** 目标会话 id。 */
  sessionId: string;
  /** 可选的 db 句柄；缺席时按 `openDatabase(getMagicContextDatabasePath())` 打开。 */
  db?: ContextDatabase | null;
}

/**
 * 读一份状态快照。**只读**：唯一的写风险是 A 组 `getOrCreateSessionMeta` 在
 * `session_meta` 行不存在时会建一行——这是 A 组既有语义，`/ctx-status` 沿用它，
 * 因为「为不存在的会话凭空造一行」比「报一个空快照」更接近上游 `/ctx-status`
 * 对「这条会话还没被 transform 过」的处理。
 *
 * db 打不开（schema fence / 迁移未完成 / 尚未启用）时返回 `null`，由调用方决定
 * 呈现什么——本函数不抛，因为 status 是诊断面，抛错会让 TUI 少一条有用的信息。
 */
export async function readMagicContextStatusSnapshot(
  options: ReadMagicContextStatusOptions,
): Promise<MagicContextStatusSnapshot | null> {
  const { sessionId } = options;
  const db = options.db ?? (await openDefaultDatabase());
  if (!db) return null;

  const meta = getOrCreateSessionMeta(db, sessionId);
  const compartments = getCompartments(db, sessionId);
  const lastCompartmentEndMessage = getLastCompartmentEndMessage(db, sessionId);

  return {
    compartmentCount: compartments.length,
    contextPercentage: meta.lastContextPercentage,
    lastCompartmentEndMessage,
    lastInputTokens: meta.lastInputTokens,
    pendingOps: getPendingOpsCount(db, sessionId),
    protectedTokensFloor: readProtectedTokensFloor(db, sessionId),
    sessionId,
    tags: {
      active: readTagBucket(db, sessionId, "active"),
      compacted: readTagBucket(db, sessionId, "compacted"),
      dropped: readTagBucket(db, sessionId, "dropped"),
    },
  };
}

/**
 * 快照 → 文本。三段固定顺序（预算 / compartments / dropped），每段一行或几行，
 * 纯 ASCII 标记 + 数字，便于 TUI 与 CLI 共用同一份渲染，也便于单测按段断言。
 *
 * 文案英文化：这份快照的读者是 `/ctx-status` 的使用者，而 `user-facing-codes.ts`
 * 里那些句子带的是上游产品名与上游命令名；这里不复用它们，只在**读不出来**时借
 * `status_unavailable`（MC-S01）那一句——那是同一件事的用户可见说法。
 */
export function formatMagicContextStatusSnapshot(
  snapshot: MagicContextStatusSnapshot | null,
): string {
  if (!snapshot) return renderUserFacingFailure("status_unavailable", "plain");

  const lines: string[] = [
    "Magic Context status",
    `session: ${snapshot.sessionId}`,
    "",
    "Budget",
    `  protected floor: ${formatNumber(snapshot.protectedTokensFloor)}`,
    `  last context usage: ${formatNumber(snapshot.contextPercentage)}%`,
    `  last input tokens: ${formatNumber(snapshot.lastInputTokens)}`,
    "",
    "Compartments",
    `  count: ${snapshot.compartmentCount}`,
    `  last compacted message: ${snapshot.lastCompartmentEndMessage}`,
    "",
    "Tags",
    `  active: ${snapshot.tags.active.count} (${formatNumber(snapshot.tags.active.tokens)} tokens)`,
    `  dropped: ${snapshot.tags.dropped.count} (${formatNumber(snapshot.tags.dropped.tokens)} tokens)`,
    `  compacted: ${snapshot.tags.compacted.count} (${formatNumber(snapshot.tags.compacted.tokens)} tokens)`,
    `  pending operations: ${formatNumber(snapshot.pendingOps)}`,
  ];
  return lines.join("\n");
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : "-";
}

/** `session_meta.protected_tokens_effective`；列不存在（迁移前）时返回 null。 */
function readProtectedTokensFloor(db: ContextDatabase, sessionId: string): number | null {
  try {
    const row = db
      .prepare("SELECT protected_tokens_effective FROM session_meta WHERE session_id = ?")
      .get(sessionId) as { protected_tokens_effective?: number | null } | undefined;
    const value = row?.protected_tokens_effective;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readTagBucket(
  db: ContextDatabase,
  sessionId: string,
  status: "active" | "dropped" | "compacted",
): CtxStatusTagBucket {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(token_count, 0)), 0) AS tokens FROM tags WHERE session_id = ? AND status = ?",
      )
      .get(sessionId, status) as { count?: number; tokens?: number } | undefined;
    return {
      count: typeof row?.count === "number" ? row.count : 0,
      tokens: typeof row?.tokens === "number" ? row.tokens : 0,
    };
  } catch {
    return { count: 0, tokens: 0 };
  }
}

/**
 * 默认 db 句柄。动态 import storage-dir / storage-db 是为了**不在模块求值期**拉进
 * sqlite chokepoint：`@zcode/magic-context` 的 barrel 被 CLI 加载时（flag off 的
 * 默认态）不该因为一个诊断面就打开数据库。
 */
async function openDefaultDatabase(): Promise<ContextDatabase | null> {
  const [{ getMagicContextDatabasePath }, { openDatabase }] = await Promise.all([
    import("./storage-dir.js"),
    import("../core/features/magic-context/storage-db.js"),
  ]);
  return openDatabase(getMagicContextDatabasePath());
}
