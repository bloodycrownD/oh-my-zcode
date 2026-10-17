/**
 * 记忆管理组合函数（fork 适配层）—— 迭代 magic-context-memory-management / Step 1。
 *
 * ============================================================================
 * 为什么这层在 host/，而不是 core/ 或两个调用方各自实现
 * ============================================================================
 *
 * 两条写路径——设置页的 workspace RPC（bootstrap 的
 * `zcode-protocol/magic-context-memories.ts`）与对话内 agent 工具
 * （core 的 `tool/handlers/ctx-memory.ts` archive 分支）——都必须保证
 * 「`archiveMemory` 与 `queueMemoryMutation` 同事务成对写」：注入面的废弃收敛
 * （m1 corrections 的 `<removed/>` 渲染）读的是 mutation 行；只写 archive 不写
 * mutation，归档在注入面上不可见。把这对写收进一个组合函数、两条路径共用，是
 * **物理保证**而不是纪律约定（spec 总体方案）。
 *
 * 为什么不落 `core/**`：core 是逐字移植区（spec 明确边界，storage/inject/
 * mutations 零改动）——上游没有这个组合函数（上游 plugin 在 tools.ts 的 action
 * 分支内联做同样的事）。fork 的组合语义放 host/ 适配层，storage 原语原样复用。
 *
 * ============================================================================
 * outcome 四值枚举（单一事实源）
 * ============================================================================
 *
 * workspace RPC 契约（`shared/src/zcode-protocol` 的 archive 结果）与 agent
 * 工具文案（`core/tool/handlers/ctx-memory.ts`）都**直通/映射这张表**，不得在
 * 别处重新分类：
 *
 *   - `archived`         预验证通过，本次事务内成对写（archiveMemory + mutation 行）
 *   - `already-archived` status=archived 且未 superseded 且 ownership 符——跳过，
 *                        不二次写 mutation 行
 *   - `rejected`         ownership 不符（子因 `ownership`）或已被后继记忆取代
 *                        （子因 `superseded`）
 *   - `missing`          id 不存在
 *
 * rejected 的两个子因在返回结构里**机器可判**（`rejectionReason`），因为两条
 * 消费面需要不同文案：superseded → 上游 inactiveMemoryError 风格；ownership
 * 不符 → 不透明「was not found」（防泄漏纪律：不暴露外部项目记忆 id 的存在性，
 * 沿上游 plugin tools.ts:957 与本仓 storage-memory.ts:979-986 的同款处理）。
 *
 * ============================================================================
 * 判据与事务边界
 * ============================================================================
 *
 * - ownership：`normalizeStoredProjectPath(row.projectPath) ===
 *   normalizeStoredProjectPath(projectPath)`——stored 行可能是 legacy 裸文件
 *   系统路径，两边归一后再比，保证归档与写入/检索落在同一身份空间。
 * - 可归档判据（上游 `isPrimaryMutableMemory`，上游 plugin
 *   `tools/ctx-memory/tools.ts:342-347` 的内部符号、非本仓导出，此处内联等价
 *   实现）：status ∈ {active, permanent} 且 `supersededByMemoryId === null`。
 *   注意 **superseded 判据必须先于 already-archived**：superseded 写路径会把
 *   status 同时置 'archived'（storage-memory.ts:514、:1186-1189），先判 status
 *   会把「被取代」误报成「已归档」。
 * - 预验证（`getMemoriesByIds` 一次批量读）在**事务外**完成（纯读）；事务只包
 *   成对写循环（同文件先例：storage-memory.ts:1232-1235 的 deleteMemory）。
 *   预验证后事务内是纯 UPDATE/INSERT，无既有失败注入点（spec T-B1 明确不设
 *   测试专用注入缝）。
 * - 事务内 `archiveMemory` 可能抛 `ModuleMemoryAuthorityError`（module authority
 *   管理的项目）：整个事务回滚、函数向上抛——fail-visible，由 RPC handler /
 *   工具 handler 各自捕获转可读消息。
 * - mutation 行的 `projectPath` 用传入的解析身份：m1 渲染侧按同一身份集读
 *   mutation（inject-compartments.ts:2811-2822 的 getMemoryMutationsForRender*）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { normalizeStoredProjectPath } from "../core/features/magic-context/memory/project-identity.js";
import {
  archiveMemory,
  getMemoriesByIds,
  getMemoriesByProject,
  getMemoryCountsByStatus,
  type MemoryCountsByStatus,
} from "../core/features/magic-context/memory/storage-memory.js";
import type { Memory, MemoryStatus } from "../core/features/magic-context/memory/types.js";
import { queueMemoryMutation } from "../core/features/magic-context/storage-memory-mutation-log.js";
import type { Database } from "../core/shared/sqlite.js";

/** 单个 id 的废弃结果（四值枚举，单一事实源；RPC 与工具面均映射这张表）。 */
export type MemoryArchiveOutcome = "archived" | "already-archived" | "rejected" | "missing";

/** `rejected` 的子因：`ownership` = 不属于当前项目；`superseded` = 已被后继记忆取代。 */
export type MemoryArchiveRejectionReason = "ownership" | "superseded";

/** 逐 id 废弃结果。 */
export interface MemoryArchiveOutcomeEntry {
  id: number;
  outcome: MemoryArchiveOutcome;
  /** 可读描述（英文，与上游工具文案同风格）。 */
  message: string;
  /**
   * 仅 `outcome === "rejected"` 时存在；消费面据此选文案
   * （superseded → inactive 风格；ownership → 不透明「was not found」）。
   */
  rejectionReason?: MemoryArchiveRejectionReason;
}

/**
 * 管理列表口径：三 status 全回（archived 含 merged/superseded 行——写路径把它们
 * 的 status 也置为 'archived'），并配 expiryCutoff=0。注意 `expires_at=0`（非
 * NULL）的死行仍被 SQL 过滤（`expires_at > 0` 不成立）——spec 兼容性节登记的
 * 「counts 与列表口径差」第 ① 条，面板以列表为准。
 */
const ADMIN_LIST_STATUSES: MemoryStatus[] = ["active", "permanent", "archived"];

/**
 * 批量废弃（软删）一个项目的记忆——单一事务成对写。
 *
 * **逐 id 语义**：不存在的 id 只回 `missing`，不阻断批次其余 id（fork 的四值枚
 * 举把不可归档的原因全部显式化）。预验证通过的所有 id 在同一事务内写；事务内
 * 任一条失败（如 authority 拒绝）则整批回滚，函数抛错。
 *
 * @param projectPath 当前会话解析出的项目身份（`resolveProjectIdentityForSession` 的产物）。
 * @param ids 目标记忆 id；内部按首见序去重（`ids:[42,42]` 只归档一次、只写一条 mutation 行）。
 * @param reason 可选废弃原因（上限由契约层约束；`archiveMemory` 会 trim 后存入
 *   `metadata_json.archive_reason`，空串等同不传）。
 */
export function archiveProjectMemories(
  db: Database,
  projectPath: string,
  ids: readonly number[],
  reason?: string,
): MemoryArchiveOutcomeEntry[] {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];

  // ── 预验证（事务外，纯读）：missing / ownership / superseded / already-archived ──
  const foundById = new Map(getMemoriesByIds(db, uniqueIds).map((memory) => [memory.id, memory]));
  const targetIdentity = normalizeStoredProjectPath(projectPath);
  // 每个 id 一个槽位（与 uniqueIds 同序）；可归档槽位先占 undefined，事务提交后回填。
  const outcomes: Array<MemoryArchiveOutcomeEntry | undefined> = [];
  const eligibleIndexes: number[] = [];

  for (let index = 0; index < uniqueIds.length; index += 1) {
    const id = uniqueIds[index];
    const memory = foundById.get(id);
    if (!memory) {
      outcomes.push({ id, outcome: "missing", message: `Memory [ID: ${id}] was not found.` });
      continue;
    }
    // ownership：两边归一后再比（stored 行可能是 legacy 裸路径）。
    if (normalizeStoredProjectPath(memory.projectPath) !== targetIdentity) {
      outcomes.push({
        id,
        outcome: "rejected",
        rejectionReason: "ownership",
        // 防泄漏：跨项目 id 一律以「was not found」回应。
        message: `Memory [ID: ${id}] was not found.`,
      });
      continue;
    }
    // superseded 先于 already-archived（superseded 写路径同时置 status='archived'，
    // 先判 status 会把「被取代」误报成「已归档」）。
    if (memory.supersededByMemoryId !== null) {
      outcomes.push({
        id,
        outcome: "rejected",
        rejectionReason: "superseded",
        message: `Memory with ID ${id} is archived or superseded; restore it before archiving.`,
      });
      continue;
    }
    if (memory.status === "archived") {
      outcomes.push({
        id,
        outcome: "already-archived",
        message: `Memory [ID: ${id}] is already archived.`,
      });
      continue;
    }
    eligibleIndexes.push(index);
    outcomes.push(undefined);
  }

  // ── 事务：只包成对写循环（预验证已在事务外完成）──
  if (eligibleIndexes.length > 0) {
    db.transaction(() => {
      for (const index of eligibleIndexes) {
        const id = uniqueIds[index];
        archiveMemory(db, id, reason);
        queueMemoryMutation(db, {
          projectPath,
          mutationType: "archive",
          targetMemoryId: id,
        });
      }
    }).immediate();

    for (const index of eligibleIndexes) {
      const id = uniqueIds[index];
      outcomes[index] = { id, outcome: "archived", message: `Archived memory [ID: ${id}].` };
    }
  }

  // eligible 槽位在事务成功提交后全部回填；filter 只用于把「已填充」收窄回显式类型。
  return outcomes.filter((entry): entry is MemoryArchiveOutcomeEntry => entry !== undefined);
}

/**
 * 管理面板的列表读取（薄封装）：三 status 全回、expiryCutoff=0。
 *
 * 这是管理视图不是注入视图：过期行、archived 行、merged/superseded 行都要看得
 * 到（merged 行的区分展示用 entry 的 `supersededByMemoryId` 字段）。
 */
export function listProjectMemoriesForAdmin(db: Database, projectPath: string): Memory[] {
  return getMemoriesByProject(db, projectPath, ADMIN_LIST_STATUSES, 0);
}

/**
 * 管理面板的计数读取（薄封装）。口径见 `getMemoryCountsByStatus` 自身注释：
 * superseded 归 merged 桶、无过期过滤；面板以列表为准、counts 仅作汇总参考。
 */
export function getProjectMemoryCountsForAdmin(
  db: Database,
  projectPath: string,
): MemoryCountsByStatus {
  return getMemoryCountsByStatus(db, projectPath);
}
