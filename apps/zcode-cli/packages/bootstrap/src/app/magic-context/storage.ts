/**
 * magic-context 的存储可得性：开库有界重试、`db_null:<细分>` 归因、持久历史行读取。
 *
 * 从 `../magic-context-turn-transform.ts` 拆出（Step 3 / phase-facade，零行为）。
 * 为什么单独成文件：三块内容都属于「库这条线」，与投影/端口无关，且都是 fail-closed
 * 契约的输入——`openMagicContextStorageWithBusyRetry` 决定「抛还是退避」，
 * `describeStorageUnavailability` 把 null 变成机器可判的 reason，
 * `toStoredRows` / `pageFromRows` 把 SessionStorePort 快照变成 raw-message 分页。
 */

import type { Logger } from "@zcode/core";
import {
  getMigrationOnOpenRefusal,
  getSchemaFenceRejection,
  isTransientStorageOpenError,
  projectStoredMessage,
  type ContextDatabase,
  type MigrationOnOpenRefusal,
  type RawMessage,
} from "@zcode/magic-context";

// ─────────────────────────────────────────────────────────────────────────────
// RawMessageProvider 的持久历史半边
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredRow {
  raw: RawMessage;
  timeCreated: number;
  id: string;
  /** 1-based 的存储序（ordinal）。 */
  ordinal: number;
}

export function toStoredRows(
  messages: readonly {
    info: {
      id: string;
      role: string;
      time?: { created?: number; completed?: number };
      summary?: unknown;
      finish?: string;
    };
    parts: readonly unknown[];
  }[],
  sessionId: string,
): StoredRow[] {
  return messages.map((message, index) => {
    const created =
      typeof message.info.time?.created === "number" ? message.info.time.created : index;
    return {
      raw: projectStoredMessage({
        id: message.info.id,
        role: message.info.role,
        parts: message.parts,
        sessionId,
        createdAt: created,
        completedAt: message.info.time?.completed,
        summary: message.info.summary !== undefined,
        ...(message.info.finish === undefined ? {} : { finish: message.info.finish }),
      }) as unknown as RawMessage,
      timeCreated: created,
      id: message.info.id,
      ordinal: index + 1,
    };
  });
}

/**
 * 按 ordinal 切一页。ordinal 是 1-based 的存储序（ZCode 的
 * `sequence is null, sequence, time_created, rowid`），与 `SessionStorePort.messages()`
 * 的顺序一致，因此 ordinal 在两侧是同一个位置。
 */
export function pageFromRows(
  rows: readonly StoredRow[],
  afterOrdinal: number,
  limit: number,
  finalWatermark: number,
): RawMessage[] {
  const page = rows.filter((row) => row.ordinal > afterOrdinal && row.ordinal <= finalWatermark);
  return page.slice(0, Math.max(0, Math.floor(limit))).map(withOrdinal);
}

/** `projectStoredMessage` 产出的 `MessageLike` 补上 ordinal 即成 `RawMessage`。 */
export function withOrdinal(row: StoredRow): RawMessage {
  return { ...row.raw, ordinal: row.ordinal } as RawMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⑤-5a 结构化事件面：transform **缺席**（不是「跑了但没做事」）时发一条
 * `magic_context.transform_absent`（logger.warn 级），带机器可判的 `reason`。
 *
 * 为什么需要它：⑤ 的本机取证显示桌面 app-server 进程开库成功、但 transform 从未
 * 创建/从未执行，且该缺席**完全静默**——0 条 transform pass、0 条失败日志、0 条
 * storage 事件，用户完全看不出「压缩已停机」。三条缺席路径全部发事件后，桌面
 * 日志/事件面第一次能回答「为什么没有压缩」（细分词表见 leaf 模块的文件头）。
 *
 * mc/A-1 / mc/C-orch-1：发射点收敛到零依赖 leaf
 * `magic-context-absent-event.ts`——本模块在 flag 关时**不被加载**（装配门的
 * 成本纪律），disabled 事件不可能由它发出，而 create-app 侧另写一条同形状的
 * logger.warn 会让事件名/reason 词表分裂成两处无类型约束的字面量。leaf 零依赖，
 * 装配层静态 import 它没有启动成本。工厂内只保留直构/测试路径的发射：
 *
 *   - `disabled`       ：**生产由 create-app 侧发射**（见那里的 enabled gate
 *                        else 分支）；本分支保留给直构/测试
 *   - `db_null:<细分>` ：本工厂的 openDatabase 返回 null 路径（细分见
 *                        `describeStorageUnavailability`）
 *   - `import_failed`  ：装配层（create-app.ts）动态 import 本模块失败（5b）
 *
 * 语义边界（fail-closed 契约不受影响，事件只是可观测性）：
 *   - import_failed：发事件后**照旧 throw**（保留 fail-closed 性状）；
 *   - disabled / db_null：发事件后照旧 return undefined 降级；db_null 且
 *     `fail_closed_blocking=true` 时同样**先发事件、再 throw**。
 */
// （发射实现见 ../magic-context-absent-event.ts 的 emitMagicContextTransformAbsent）

/**
 * 把 `openDatabase` 的 null 归到可行动的细分上（供 `db_null:<细分>` 的 reason）。
 *
 * 优先级与包内一致（migration_guard → schema_fence → storage_failure），守卫见
 * 包内 `storage-unavailable-reason.ts:24`：**migration 且确有阻塞进程（或不可读
 * 文件）** 才判 migration_guard——只有一条 migration 记录但零 blockers 时不误判
 * （unreadable+空 pids 两处结论必须相同，mc/C-1）。刻意**不在 bootstrap 侧 import
 * 那个 helper：它未出包公共面，为本文件一个 reason 字符串去扩公共面不划算；这里用
 * 已导出的 `getMigrationOnOpenRefusal` / `getSchemaFenceRejection` 两个 accessor
 * 现拼（模块级状态由最近一次 open 写入，每次 open 前都会被清空，因此拿到 null 时
 * 它们就是权威细分）。
 *
 * busy/瞬时类不在此列：那是 openDatabase 的 **throw** 路径（cause 链分类见
 * `isTransientStorageOpenError`），由上面的有界重试负责，不会以 null 形态到达
 * 本函数。
 *
 * `refusal` 参数是测试缝（仅测试缝，不扩运行时面）：缺省读模块级状态（与生产零参
 * 调用逐行等价），表驱动用例可直接注入夹具，免去为一条细分去伪造整个 open 场景。
 */
export function describeStorageUnavailability(
  refusal: MigrationOnOpenRefusal | null = getMigrationOnOpenRefusal(),
): {
  reason: "db_null:migration_guard" | "db_null:fence" | "db_null:pending_or_unclassified";
  detail: string;
} {
  // 与包内 storage-unavailable-reason.ts:24 同形守卫：migration 记录在场但毫无
  // 阻塞证据（serverPids/blockingProcesses 皆空且没有 unreadableFile）时不判
  // migration_guard——包内只在「挡着迁移的活进程确定存在」时给这个 kind。
  if (
    refusal &&
    ((refusal.blockingProcesses?.length ?? refusal.serverPids.length) > 0 || refusal.unreadableFile)
  ) {
    return {
      reason: "db_null:migration_guard",
      detail: `magic-context.db migration on open refused: database v${refusal.persistedVersion} blocked by ${refusal.serverPids.length} live server process(es) on an older build`,
    };
  }
  const fence = getSchemaFenceRejection();
  if (fence) {
    return {
      reason: "db_null:fence",
      detail: `magic-context.db schema fence rejected: database v${fence.persistedVersion} is newer than this build supports (v${fence.supportedVersion})`,
    };
  }
  return {
    reason: "db_null:pending_or_unclassified",
    detail:
      "magic-context.db could not be opened (pending async open competing for the same path, or an unclassified refusal)",
  };
}

/**
 * ⑤-5a：boot 开库的退避序列（毫秒）。
 *
 * 值与包内 `migrations.ts` 的 `MIGRATION_LOCK_RETRY_DELAYS_MS`
 * （[1s,2s,4s,8s,15s]）的**前 4 档**一致；那个常量是模块私有符号、未出包公共面，
 * 不为一次 import 去扩公共面，因此这里按同一序列复制前 4 档并在本注释登记出处
 * （若包内序列调整，两处需同步）。上界语义同样对齐包内
 * `runMigrationsWithRetry`：delays.length + 1 次尝试。
 */
const MAGIC_CONTEXT_BOOT_OPEN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/**
 * OQ-1R：**重试档** open 的单次尝试 `busy_timeout` 上界（ms）。
 *
 * 两档语义（与 spec r4 澄清一致）：
 *   - **重试档**（boot 装配，本文件唯一使用者）：每次尝试 1s 就让出，配合退避
 *     序列 [1s,2s,4s,8s]，最坏链长 ~15s（=4×1s + 4 档退避），收敛进 boot 预算。
 *     改前每尝试各叠包内默认 `BOOT_SQLITE_BUSY_TIMEOUT_MS=5s`，最坏 ~40s——
 *     远超 15s boot 预算，且 boot 装配期 `await` 工厂整段阻塞前台。
 *   - **非重试档**（`run-ctx-command.ts` / `ctx-context.ts` / `host/ctx-status.ts`
 *     的生产 open）：**不传该参**，天然保持包内默认 5s——用户主动敲 `/ctx-*`
 *     命令时容忍一次更长的等待。
 *
 * 1000 经包内 `resolveBootBusyTimeoutMs`（storage-db.ts:256-260）被
 * `BOOT_SQLITE_BUSY_TIMEOUT_MS=5000` 钳制时原样通过（< 上界），语义即「1s」。
 */
export const BOOT_OPEN_BUSY_TIMEOUT_MS = 1_000;

/**
 * ⑤-5a：boot 开库的**有界** busy 重试。
 *
 * 只对 busy/瞬时类失败重试：5e 之后 `openDatabase` 的 catch 以 `{ cause }` 保留了
 * 底层错误，`isTransientStorageOpenError` 在 cause 链上按类型与 code 判定
 * （`SqliteAcquisitionBusyError` / `MigrationLockBusyError` / `isTransientSqliteError`），
 * **不靠 message 文本猜**。schema fence、ABI 不匹配、路径不可写、迁移体失败等
 * 确定性失败立即重抛，由装配点按 `fail_closed_blocking` 契约处理——重试绝不把
 * fail-closed 偷换成静默降级。
 *
 * fence / migration guard / pending 竞争是 openDatabase 的**确定性 null**（不抛），
 * 天然不进本函数，装配点照旧走 `db_null` 降级路径。
 *
 * 工厂本身是 async，直接 `await` sleep，不冻宿主、也不必改走 `openDatabaseAsync`。
 *
 * `delaysMs` / `sleep` 是测试缝（与 `runMigrationsWithRetry` 的同名选项同一手法）：
 * 生产装配只传 logger，用上面的生产序列。
 *
 * OQ-1R：`open` thunk 收一个**单次尝试 busy_timeout**（ms）参数。helper 不自己调
 * `openDatabase`——thunk 由调用方提供，参数让「重试档 1s / 非重试档默认 5s」的
 * 两档语义留在调用点（工厂传 {@link BOOT_OPEN_BUSY_TIMEOUT_MS}，测试可注入任意值
 * 或直接断言收到的值）。`openBusyTimeoutMs` 缺省即重试档生产值 1s。
 */
export async function openMagicContextStorageWithBusyRetry(
  open: (busyTimeoutMs: number) => ContextDatabase | null,
  options: {
    logger: Logger;
    delaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    /** OQ-1R：递给 `open` 的单次尝试 busy_timeout（ms）；缺省 = 重试档 1s。 */
    openBusyTimeoutMs?: number;
  },
): Promise<ContextDatabase | null> {
  const delaysMs = options.delaysMs ?? MAGIC_CONTEXT_BOOT_OPEN_RETRY_DELAYS_MS;
  const openBusyTimeoutMs = options.openBusyTimeoutMs ?? BOOT_OPEN_BUSY_TIMEOUT_MS;
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise<void>((r) => setTimeout(r, delayMs)));
  const totalAttempts = delaysMs.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return open(openBusyTimeoutMs);
    } catch (error) {
      // 不是 busy/瞬时（fence 之外的确定性失败）⇒ 原样上抛，fail-closed 语义不变。
      if (!isTransientStorageOpenError(error)) throw error;
      const delayMs = delaysMs[attempt - 1];
      // 序列耗尽：上界到顶，维持「重试后仍失败就抛」的 fail-closed 终态。
      if (delayMs === undefined) throw error;
      options.logger.warn("Magic context storage open is busy; retrying with backoff", {
        module: "bootstrap",
        event: "magic_context.storage_open_retry",
        reason: "storage_busy_retry",
        attempt,
        totalAttempts,
        retryInMs: delayMs,
        detail: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }
  // 不可达：循环内每条路径都 return/throw。给 TypeScript 一个确定的收尾。
  throw new Error("[magic_context] storage open retry exhausted without a verdict");
}
