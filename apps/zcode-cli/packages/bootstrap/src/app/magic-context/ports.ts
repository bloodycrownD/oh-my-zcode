/**
 * magic-context 的 turn transform 端口（自 `../magic-context-turn-transform.ts` 逐字搬出，
 * 纯搬迁、零语义改动）：端口工厂、失败分级、settle 助手与持久历史快照助手。
 *
 * prompt-surface 的两个 resolver 在 `./prompt-surface.ts`（拆分只为守住单文件行数门禁），
 * 两者同属拆分前「端口工厂」这一职责面。模块内连线出口（`HISTORIAN_SETTLE_TIMEOUT_MS`）
 * 只供同目录 assembly 使用，**不**由门面再导出；其余助手保持私有，与拆分前一致。
 */

import type {
  MagicContextTurnTransform,
  MagicContextTurnTransformInput,
  MagicContextTurnTransformResult,
  RuntimeMessageEntry,
} from "@zcode/core";
import {
  DegradedPassRefusalError,
  EmergencyFailClosedError,
  StorageBusyRefusalError,
  UnmanagedOverWindowError,
  UnresolvedHistoryBoundaryError,
  createRawMessageProvider,
  getActiveCompartmentRun,
  isFailClosedBlockingError,
  isTransientSqliteError,
  noteEntry,
  projectRuntimeEntries,
  projectStoredMessage,
  replayLkg,
  resolveLkgModelKeys,
  setRawMessageProvider,
  snapshotRuntimeEntries,
  type MagicContextConfig,
  type MessageLike,
  type RawMessage,
  type ZCodeRuntimeEntry,
} from "@zcode/magic-context";
import { projectMagicContextEntries } from "./projection.js";
import type { MagicContextTurnTransformOptions, ZCodeMagicContextTransform } from "./types.js";

/**
 * FORK（S24-fix2 + bugfix-batch-20261011 / Step 2）：让本 pass 起的 historian 跑完
 * 再交还控制权——**只用于短驻形态**（`processExitsAfterTurn !== false`，即 CLI `-p`
 * 一次性进程与所有未声明形态）。长驻形态（app-server / TUI）由
 * {@link settleInFlightHistorianInBackground} 记账后放行，不阻塞前台。
 *
 * 上游（OpenCode）是长驻进程：compartment agent 是 fire-and-forget 的，但**进程
 * 不会退出**，所以它跑完的 publish 与 drain 预留一定落地。
 *
 * ZCode 的短驻形态是「一进程 = 一轮 prompt」：transform 一返回，这一轮就结束了，
 * historian 还在飞的那几秒会随进程一起消失——drain 预留泄漏（下一轮报
 * `historian skip: internal drain budget spent`）、compartment 不落库。
 *
 * 所以短驻形态这里有界地等这一轮 historian 落定（失败/拒绝都被吞掉——它本来就不该
 * 影响这一轮请求）。代价是这一轮的请求会晚发出几秒；这是「进程会退出」这件事在本
 * fork 里必须付的钱。长驻形态不付这笔钱（进程不会退出），支付方式见后台变体。
 *
 * provider 的注册范围问题见下面 `ensureProviderRegistered` 的注释。
 */
export const HISTORIAN_SETTLE_TIMEOUT_MS = 60_000;

async function settleInFlightHistorian(sessionId: string): Promise<void> {
  const active = getActiveCompartmentRun(sessionId);
  if (!active) return;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, HISTORIAN_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      active.promise.then(
        () => undefined,
        () => undefined,
      ),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * FORK（bugfix-batch-20261011 / Step 2）：{@link settleInFlightHistorian} 的后台变体
 * ——长驻形态专用。
 *
 * 这一路**绝不 await**（调用点就用 `void` 丢出去）：app-server / TUI 的进程不会随
 * 一轮退出，让首 token 或排队消息的 idle-only 提升等一次最长 60s 的 historian 是
 * 错的（spec bugfix-batch-20261011 缺陷①）。收起工作交给两件既有的事：
 *   ① 调度器契约自陈 fire-and-forget 自行 publish（historian-scheduler.ts 文件头）；
 *   ② 优雅关闭（app.close() / disposeAllAndWait 的 graceful 段）由 `registerClose`
 *      的 drain 收口兜底（MF-05）。
 * 强杀（force-kill）下与 CLI 一进程一轮同损——既有风险，非本批新增。
 *
 * 保留 `settleInFlightHistorian` 内部的 60s 上界与 `timer.unref()`：后台 promise
 * 因此既不会无限期挂在进程里，也不会拖住进程退出（unref 计时器不保持事件循环）。
 * 本函数只做**记账**：有一条在飞的 run 时，落定后记一条 debug，异常路径记一条 warn
 * ——`settleInFlightHistorian` 自己吞掉了 run 的拒绝，这里的 warn 只可能来自它自身
 * 的编程错误，属于「可恢复异常」而不是崩溃。
 */
function settleInFlightHistorianInBackground(
  sessionId: string,
  logger: MagicContextTurnTransformOptions["logger"],
): void {
  // 本来就没有在飞的 run 时连日志都不多一条：settle 是每个 model step 前的常规路径，
  // 而「没有 historian 在飞」才是常态。
  if (getActiveCompartmentRun(sessionId) === undefined) return;
  void settleInFlightHistorian(sessionId).then(
    () => {
      logger.debug("Magic context historian settled in the background", {
        module: "bootstrap",
        event: "magic_context.settle_background_settled",
        sessionId,
      });
    },
    (error: unknown) => {
      logger.warn("Magic context historian background settle failed", {
        module: "bootstrap",
        event: "magic_context.settle_background_failed",
        sessionId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RawMessageProvider 的持久历史半边
// ─────────────────────────────────────────────────────────────────────────────

interface StoredRow {
  raw: RawMessage;
  timeCreated: number;
  id: string;
  /** 1-based 的存储序（ordinal）。 */
  ordinal: number;
}

function toStoredRows(
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
function pageFromRows(
  rows: readonly StoredRow[],
  afterOrdinal: number,
  limit: number,
  finalWatermark: number,
): RawMessage[] {
  const page = rows.filter((row) => row.ordinal > afterOrdinal && row.ordinal <= finalWatermark);
  return page.slice(0, Math.max(0, Math.floor(limit))).map(withOrdinal);
}

/** `projectStoredMessage` 产出的 `MessageLike` 补上 ordinal 即成 `RawMessage`。 */
function withOrdinal(row: StoredRow): RawMessage {
  return { ...row.raw, ordinal: row.ordinal } as RawMessage;
}

/**
 * 端口工厂。导出是因为 Step 19b 的单测要能用一个**桩 transform**驱动整条
 * 投影 → transform → 反投影链路（真实 `createTransform` 需要 magic-context.db 与
 * historian，属 S20/S24 的实跑范围）。
 *
 * FORK（S23 / D-12）：配置改为**每次失败分级时现读**（`getConfig`）而不是构造时
 * 冻结。`fail_closed_blocking` 正是用户在设置页最常改的开关：冻结副本会让用户
 * 刚点下的「不阻塞」在下一次失败里失效，而那次失败的处理方式恰恰由它决定。
 */
export function createZCodeMagicContextTurnTransformPort(
  transform: ZCodeMagicContextTransform,
  port: {
    getConfig: () => MagicContextConfig;
    /**
     * FORK（bugfix-batch-20261011 / Step 2）：端口拿到的装配层选项。
     *
     * `processExitsAfterTurn` 是本文件两处 settle（`settleInFlightHistorian` 与
     * `settleScheduledPass`）的唯一判据，必须在端口构造时拿得到；其余按需 Pick。
     */
    options: Pick<
      MagicContextTurnTransformOptions,
      "sessionId" | "sessionStore" | "logger" | "processExitsAfterTurn"
    >;
    /**
     * FORK（e2e/R-2）：**turn 开始**（pass 之前）的本轮模型绑定。
     *
     * 为什么需要第三个时机：`onPassSucceeded` 在 pass **成功后**才跑，而 pass 的
     * scheduler 决策要读 usage percentage，percentage 的分母（模型窗口）又是
     * `onPassSucceeded` 才绑的——第一轮/失败轮永远 defer（鸡生蛋死结，用户实证
     * 「未设置历史/默认模型 ⇒ 不压缩」）。本钩子由工厂在端口入口前调用，先于任何
     * pass 决策拿到分母。同样**刻意不在 core 的 turn-loop 上挂点**——那是本 fork
     * 的纪律禁区；端口入口就是「这一轮的插入点」，语义等价。
     *
     * 缺席（Step 19b 的单测走的就是这条）时端口行为与 R-2 之前逐行相同。
     */
    onTurnStart?: (model: MagicContextTurnTransformInput["model"]) => void;
    /**
     * FORK（S24 / D-6）：每 pass 成功后的 historian 后台驱动。**刻意不在 core 的
     * turn-loop 上挂点**——那要求改 turn-loop 语义（本 fork 的纪律禁区）。本端口
     * 是装配层自己的回调：一次 transform 成功就意味着这一轮请求已被接受，此时让
     * historian 去折叠后台历史正是它该做的。
     *
     * 缺席（Step 19b 的单测走的就是这条）时端口行为与 S19b 逐行相同。
     */
    onPassSucceeded?: (model: MagicContextTurnTransformInput["model"]) => void;
    /**
     * FORK（MF-04）：`onPassSucceeded` 之后**有界**地等调度器那一次后台 pass 落定。
     *
     * 缺席 = 只保留 S24-fix2 的 `settleInFlightHistorian`（它只护 transform **内部**
     * 那条触发路径）。有了本钩子，「一进程 = 一轮」下的调度器 pass 也不再随进程
     * 退出被截断——否则 drain 预留泄漏、compartment 不落库（`:970` 注释自陈的
     * 那条风险）。
     *
     * FORK（bugfix-batch-20261011 / Step 2）：本钩子按 `options.
     * processExitsAfterTurn` **条件化**——长驻形态（`false`）下装配层即使递了钩子
     * 过来，端口也不 await 它（`notifyTurnSuccess` 已 fire-and-forget，调度器自行
     * publish，优雅关闭走 `registerClose` 的 drain）。判据只在端口这一处生效：装配
     * 层保持单一形态，将来不会出现「装配说不等、端口还在等」的分叉。
     */
    settleScheduledPass?: () => Promise<void>;
  },
): MagicContextTurnTransform {
  const { options } = port;
  // FORK（bugfix-batch-20261011 / Step 2）：settle 形态判据，一次求值、全程只用这一份。
  // `true`（缺省 / `print`）= 进程会随本轮退出：两处 settle 都在这一轮交还控制权
  // 之前有界地等完（本批改动之前的逐行行为）。`false`（stdio 协议宿主 / TUI）=
  // 长驻进程：两处都不等，见下方调用点与 `settleInFlightHistorianInBackground`。
  const settlesInForeground = port.options.processExitsAfterTurn !== false;
  // 持久历史快照的缓存键：同一 turn 内 live entries 长度不变，因此整个 turn 只读
  // 一次 session store；跨 turn 长度增长时自然失效。
  let cachedRows: { liveLength: number; rows: StoredRow[] } | undefined;

  async function resolveStoredRows(liveLength: number): Promise<StoredRow[]> {
    if (cachedRows?.liveLength === liveLength) return cachedRows.rows;
    if (!options.sessionStore) {
      cachedRows = { liveLength, rows: [] };
      return cachedRows.rows;
    }
    try {
      const persisted = await options.sessionStore.messages({
        sessionID: options.sessionId as never,
      });
      cachedRows = { liveLength, rows: toStoredRows(persisted, options.sessionId) };
    } catch {
      // 读不到持久历史不是致命错误：provider 会回落到内存 borrow。
      cachedRows = { liveLength, rows: [] };
    }
    return cachedRows.rows;
  }

  // FORK（S24-fix2）：provider 的生命周期是**整个进程**，不是「一次 transform」。
  //
  // 上游（OpenCode）是长驻进程 + 每事件注册，所以「transform 作用域」≈「进程」；
  // 本 fork 是「一进程 = 一轮 prompt」，把注册绑在 transform 上就让**同一轮里的
  // 其它消费者**读不到原始历史：
  //
  //   - historian 的 publish 前边界校验（`hasRawSessionMessageById`）——于是模型已经
  //     产出的 compartment 被 `reason=dangling_boundary` 丢掉；
  //   - `/ctx-flush`、`/ctx-status` 这类命令；
  //   - **`ctx_expand` 按 tag 恢复原文**——`renderItemByTag` 走
  //     `readRawSessionMessageById(tag.toolOwnerMessageId)`，owner 是 `mc<N>`，
  //     没有 provider 就回落到 OpenCode 的库（ZCode 上不存在），于是每一个被 drop
  //     的 tag 都回答「original tool owner is no longer in stored history」（T-M3）。
  //
  // 于是这里注册一次、之后每轮只**换内容**：deps 闭包读下面这两个 holder，provider
  // 对象本身不变。进程退出即失效（CLI 一进程一轮），不留跨进程状态。
  let currentSnapshot: readonly ZCodeRuntimeEntry[] = [];
  let currentRows: StoredRow[] = [];
  let providerRegistered = false;

  function ensureProviderRegistered(sessionId: string): void {
    if (providerRegistered) return;
    setRawMessageProvider(
      sessionId,
      createRawMessageProvider({
        sessionId,
        borrowRuntimeEntries: () => currentSnapshot,
        readStoredMessagePage: ({ afterOrdinal, limit, finalWatermark }) => ({
          messages: pageFromRows(currentRows, afterOrdinal, limit, finalWatermark),
          storedCount: currentRows.length,
        }),
        getStoredMessageCount: () => currentRows.length,
        readStoredMessageById: (messageId) => {
          const row = currentRows.find((candidate) => candidate.id === messageId);
          return row ? withOrdinal(row) : null;
        },
        readStoredOrdinalPage: (after, limit) =>
          currentRows
            .filter(
              (row) =>
                after === null ||
                row.timeCreated > after.timeCreated ||
                (row.timeCreated === after.timeCreated && row.id > after.id),
            )
            .slice(0, Math.max(1, Math.floor(limit)))
            .map((row) => ({
              id: row.id,
              timeCreated: row.timeCreated,
              contributesOrdinal: true,
              hasValidInfo: true,
            })),
      }),
    );
    providerRegistered = true;
  }

  return async (
    input: MagicContextTurnTransformInput,
  ): Promise<MagicContextTurnTransformResult> => {
    // e2e/R-2：turn 开始即绑定本轮实际执行模型——先于投影与任何 pass 决策，
    // 让 usage recorder 的百分比分母在这一轮的第一pass 之前就位（破除「pass 成功
    // 才绑窗口」的鸡生蛋死结）。失败路径（fail-open / LKG replay）也不例外地已绑：
    // 它们同样会产生 model_complete，读数一样要落得下。
    if (port.onTurnStart !== undefined) port.onTurnStart(input.model);
    // 数组浅快照：`borrowReadOnlyRuntimeEntries` 的契约要求跨 await 前做数组快照，
    // 且 transform 只允许就地改这份投影。
    const snapshot = snapshotRuntimeEntries(input.entries as readonly ZCodeRuntimeEntry[]);
    const sessionId = input.sessionId;
    const projected = projectRuntimeEntries(snapshot, { sessionId, createdAt: Date.now() });
    const originals = new Map<string, RuntimeMessageEntry>();
    projected.forEach((message, index) => {
      const id = message.info.id;
      const original = input.entries[index];
      if (typeof id === "string" && original) originals.set(id, original);
    });

    currentSnapshot = snapshot;
    currentRows = await resolveStoredRows(input.entries.length);
    ensureProviderRegistered(sessionId);

    try {
      await transform({}, { messages: projected });
      // FORK（S24-fix2）：见 settleInFlightHistorian 的注释——historian 必须跑完，
      // 否则「一进程 = 一轮」会让它在 publish 之前随进程一起消失（drain 预留泄漏、
      // compartment 不落库）。
      //
      // FORK（bugfix-batch-20261011 / Step 2）：同一判据条件化。短驻形态照旧有界
      // 地等；长驻形态（app-server / TUI）不阻塞前台——historian 继续在后台跑，
      // 由 `settleInFlightHistorianInBackground` 记账、由 close 钩子 drain 收口。
      if (settlesInForeground) {
        await settleInFlightHistorian(sessionId);
      } else {
        settleInFlightHistorianInBackground(sessionId, options.logger);
      }
    } catch (error) {
      return handleTransformFailure(
        error,
        projected,
        originals,
        sessionId,
        port.getConfig(),
        options,
      );
    }

    const { entries, syntheticHeadPositions } = projectMagicContextEntries(projected, originals);
    const unchanged =
      entries.length === input.entries.length &&
      entries.every((entry, index) => entry === input.entries[index]);
    // historian 后台驱动：**只在 transform 成功时**触发。`fail_open` 那条路径
    // 意味着这一 pass 什么都没做（放行了未改写的请求），此时驱动 historian 是
    // 在替一次已经失败的折叠再调度一次——所以严格排除。
    if (port.onPassSucceeded !== undefined) port.onPassSucceeded(input.model);
    // FORK（MF-04）：调度器新起的那次 pass 也要有界 settle，理由同
    // `settleInFlightHistorian`——进程会退出。失败/拒绝由钩子自己吞掉：它本来就不该
    // 影响这一轮请求（上面那次 settle 也是同样的处置）。
    //
    // FORK（bugfix-batch-20261011 / Step 2）：同判据条件化——长驻形态不 await。
    // `notifyTurnSuccess`（上面的 `onPassSucceeded`）本身就是 fire-and-forget，包内
    // 调度器契约自陈自行 publish；这一轮之后它继续在后台跑，优雅关闭由
    // `registerClose` 的 drain 收口（MF-05），强杀与 CLI 一进程一轮同损（既有风险）。
    if (settlesInForeground && port.settleScheduledPass !== undefined) {
      // 失败/拒绝在这里被吞掉：settle 只是替这一轮多等一个窗口，它本身绝不该改变
      // 这一轮请求的成败（与上面 `settleInFlightHistorian` 同一处置）。
      await port.settleScheduledPass().catch(() => undefined);
    }
    return { entries, outcome: unchanged ? "unchanged" : "applied", syntheticHeadPositions };
  };
}

/**
 * B 组三档分级（上游 `plugin/messages-transform.ts` 的 TypeScript 车道）。
 * 只有第一档会把错误抛回 core；其余两档在这里就地消化成一次放行。
 */
function handleTransformFailure(
  error: unknown,
  projected: readonly MessageLike[],
  originals: ReadonlyMap<string, RuntimeMessageEntry>,
  sessionId: string,
  config: MagicContextConfig,
  options: Pick<MagicContextTurnTransformOptions, "logger">,
): MagicContextTurnTransformResult {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;

  // ① fail-closed：确定性不可用。blocking 配置默认 true = 重抛，让用户看到 loud 错误。
  if (error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error)) {
    if (config.fail_closed_blocking !== false) throw error;
    options.logger.warn("Magic context fail-closed is inert; passing the request through", {
      module: "bootstrap",
      event: "magic_context.fail_closed_inert",
      errorName: typeof name === "string" ? name : undefined,
    });
    return passthrough(projected, originals);
  }

  // ② LKG replay：先试上一次成功 pass 的字节。
  const replayed = tryReplayLkg(projected, sessionId, options);
  if (replayed) return replayed;

  // ③ 产不出可安全发送的请求 → 拒发，而不是把更大的裸历史交给 provider。
  if (
    error instanceof DegradedPassRefusalError ||
    error instanceof UnmanagedOverWindowError ||
    error instanceof UnresolvedHistoryBoundaryError
  ) {
    throw error;
  }

  // ④ transient sqlite：重试由包的 writer acquisition 负责，这里只做分类。
  if (isTransientSqliteError(error) && !(error instanceof StorageBusyRefusalError)) {
    throw new StorageBusyRefusalError(error, "zcode-turn-loop");
  }
  if (error instanceof StorageBusyRefusalError) throw error;

  // ⑤ 其余（schema 损坏、编程错误）：fail-open 放行输入，只记一条诊断。
  options.logger.warn("Magic context transform failed; serving the unmodified request", {
    module: "bootstrap",
    event: "magic_context.fail_open",
    errorName: typeof name === "string" ? name : undefined,
    errorCode: typeof code === "string" ? code : undefined,
  });
  return passthrough(projected, originals);
}

function passthrough(
  projected: readonly MessageLike[],
  originals: ReadonlyMap<string, RuntimeMessageEntry>,
): MagicContextTurnTransformResult {
  const { entries, syntheticHeadPositions } = projectMagicContextEntries(projected, originals);
  return { entries, outcome: "fail_open", syntheticHeadPositions };
}

function tryReplayLkg(
  projected: readonly MessageLike[],
  sessionId: string,
  options: Pick<MagicContextTurnTransformOptions, "logger">,
): MagicContextTurnTransformResult | undefined {
  try {
    const keys = resolveLkgModelKeys(projected as MessageLike[]);
    const entry = noteEntry(sessionId, projected as MessageLike[]);
    if (!entry) return undefined;
    const replay = replayLkg({
      sessionId,
      messages: projected as MessageLike[],
      modelKey: keys.modelKey,
      providerKey: keys.providerKey,
      entry,
    });
    if (!replay.ok) {
      options.logger.warn("Magic context LKG replay declined", {
        module: "bootstrap",
        event: "magic_context.lkg_replay_declined",
        reason: replay.reason,
      });
      return undefined;
    }
    // 重放出来的是模块输出（MessageLike），没有 ZCode entry 可复用，全部重建。
    const { entries, syntheticHeadPositions } = projectMagicContextEntries(
      replay.messages,
      new Map(),
    );
    return { entries, outcome: "lkg_replayed", syntheticHeadPositions };
  } catch (replayError) {
    options.logger.warn("Magic context LKG replay unavailable", {
      module: "bootstrap",
      event: "magic_context.lkg_replay_unavailable",
      detail: replayError instanceof Error ? replayError.message : String(replayError),
    });
    return undefined;
  }
}
