/**
 * 接缝层：三个 resolver + turn-transform 端口工厂 + 失败分级（B 组三档）。
 *
 * 从 `../magic-context-turn-transform.ts` 拆出（Step 3 / phase-facade，零行为）。
 * 为什么这三件事在同一个文件：它们都是「core / 装配层 ↔ 本装配」的接缝——
 * promptSection / toolDescription 两个 resolver 是 core 的注入口，端口工厂是 turn-loop
 * 的插入点，失败分级是端口在 transform 抛错时的处置策略。端口是 settle 判据的**唯一**
 * 求值点，`settlesInForeground` 在这里一次求值、全程复用。
 */

import {
  isChinesePromptLanguage,
  type Logger,
  type MagicContextPromptSectionResolver,
  type MagicContextTurnTransform,
  type MagicContextTurnTransformInput,
  type MagicContextTurnTransformResult,
  type RuntimeMessageEntry,
} from "@zcode/core";
import { ConfigKey, type ConfigPort } from "@zcode/contracts";
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  DegradedPassRefusalError,
  EmergencyFailClosedError,
  MagicContextConfigSchema,
  StorageBusyRefusalError,
  UnmanagedOverWindowError,
  UnresolvedHistoryBoundaryError,
  buildMagicContextSection,
  createPromptSurfaceRuntime,
  createRawMessageProvider,
  isFailClosedBlockingError,
  isTransientSqliteError,
  noteEntry,
  projectRuntimeEntries,
  replayLkg,
  resolveLkgModelKeys,
  setRawMessageProvider,
  snapshotRuntimeEntries,
  type MagicContextConfig,
  type MessageLike,
  type ZCodeRuntimeEntry,
} from "@zcode/magic-context";
import { buildMagicContextSectionZhCn } from "../magic-context-prompt-section-zh-cn.js";
import { projectMagicContextEntries } from "./projection.js";
import { settleInFlightHistorian, settleInFlightHistorianInBackground } from "./settle.js";
import { pageFromRows, toStoredRows, withOrdinal, type StoredRow } from "./storage.js";
import type { MagicContextTurnTransformOptions, ZCodeMagicContextTransform } from "./types.js";

/**
 * FORK（bugfix-batch-20261011 / Step 13，D1 的宿主侧装配层）：
 * `## Magic Context` 段的 resolver。
 *
 * 这个模块是 bootstrap 里**唯一** import magic-context 包的地方（`features.magicContext`
 * 关时它整棵都不被动态 import），所以 11 参装配只能落在这里——core 的 context builder
 * 是同步的且不许 import 包，端口形状见 core
 * `runtime/helpers/magic-context-prompt-section.ts`。
 *
 * 三个装配决定，逐条给出依据：
 *
 * ① **每次调用现读配置**（而不是闭包缓存一份）。调用点是 core 的
 *    `createContextBuilderFromSnapshot`，它在每次 context 前缀重算时重建，因此参数对象
 *    不可能过期；缓存配置域反而会让设置页改 preset/memory 开关后要等一个额外的失效点。
 *
 * ② **dreamer / temporal / caveman 三臂恒 false**，各自有裁定出处：dreamer=N3（ZCode
 *    agent 进程无 cron 宿主）；temporal 与 caveman 在 fork 里没有任何 `deps.
 *    experimentalTemporalAwareness` / `deps.cavemanTextCompression` 供给（transform 的
 *    这两个字段 bootstrap 从不填，恒 undefined），开着就是在提示词里描述不存在的管道。
 *    三个都是 `buildMagicContextSection` 的默认值，这里显式传 false 是为了让「不传」与
 *    「传 false」在代码里不可区分地成立——注释即裁定。
 *
 * ③ **guidance/preset 每次现解**，不做 epoch 缓存：端口签名没有 sessionId（core 不该
 *    为了一个缓存键把会话身份递给 prompt 装配），而 context 前缀重算本来就不是热路径。
 *    上游的 epoch 缓存服务的是「system hook 与 Rust adapter 在同一 epoch 内看到同一份
 *    字节」——fork 没有 Rust adapter，这条理由不存在；guidance 文件的用户编辑因此直接热读
 *    （重复告警由 prompt-surface runtime 自己的去重集合收口，不会刷日志）。
 */
export function createMagicContextPromptSectionResolver(options: {
  configPort?: ConfigPort;
  /** 无配置口时的静态域（S19b 遗留路径，生产路径恒有 configPort）。 */
  configDomain?: unknown;
  logger?: Logger;
}): MagicContextPromptSectionResolver {
  const logger = options.logger;
  const warn = (message: string): void => {
    logger?.warn("Magic context prompt surface warning", {
      module: "bootstrap",
      event: "magic_context.prompt_surface_warning",
      reason: message,
    });
  };
  const promptSurfaceRuntime = createPromptSurfaceRuntime({ warn });
  let lastConfigNotice: string | null = null;

  const readConfig = (): MagicContextConfig => {
    const raw = options.configPort
      ? options.configPort.get(ConfigKey.MagicContext)
      : options.configDomain;
    const parsed = MagicContextConfigSchema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    // 坏域按 schema 缺省走，并在**同一条坏因**上只记一次：context 前缀每次重算都会
    // 走到这里，逐次 warn 会把日志刷成噪声。
    const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
    if (lastConfigNotice !== reason) {
      lastConfigNotice = reason;
      logger?.warn("Magic context config rejected; prompt surface uses schema defaults", {
        module: "bootstrap",
        event: "magic_context.prompt_surface_config_defaulted",
        detail: reason,
      });
    }
    return DEFAULT_MAGIC_CONTEXT_CONFIG;
  };

  return (input) => {
    const config = readConfig();
    // guidance/preset 每次现解：guidance 覆盖文件按用户编辑热读（epoch 缓存的等价物是
    // prompt-surface runtime 自己的告警去重），context 前缀重算本来就不是热路径。
    const selection = promptSurfaceRuntime.resolveGuidance(config.prompt_surface, input.modelKey);

    // FORK（用户裁定 2026-10-11）：中文语言走 fork 侧 zh 孪生（结构与上游逐分支镜像，
    // 见 magic-context-prompt-section-zh-cn.ts 头注维护契约）；其余值/缺席走上游英文
    // 逐字实现，字节不变。preset/override 的解析两条路径共享（selection 不分语言）。
    const sectionBuilder = isChinesePromptLanguage(input.language)
      ? buildMagicContextSectionZhCn
      : buildMagicContextSection;

    return sectionBuilder(
      null,
      0,
      input.ctxReduceCallable,
      // ② 三臂恒 false（N3 + 无供给），见文件头。
      false,
      false,
      false,
      input.subagentMode,
      input.language,
      // `memory.enabled`（Step 11 白名单 / 上游默认 on）的**运行期消费点**：false 时段
      // 落 MEMORY_GUIDANCE 与 MEMORY_GUIDANCE_LIGHT。core 不持这一位，本行是它唯一的
      // 读者；`<project-memory>` 那半边由包内 transform 的 `deps.memoryConfig` 消费。
      config.memory.enabled,
      selection.preset,
      selection.primaryOverride,
    );
  };
}

/**
 * FORK（bugfix-batch-20261011 / Step 14）：prompt-surface 的 preset 分档描述求值器。
 *
 * `prompt_surface.default` / `prompt_surface.models` 在这之前**没有任何运行期消费者**：
 * 设置页写下去、schema 校验通过、ConfigPort 广播到位，然后什么都不会发生——模型看到的
 * 永远是 full 档工具描述。本函数把配置接到 core 的工具注册链（`registerBuiltInTools` 的
 * `magicContextToolDescription` 选项），light 档时四个 ctx_* 工具的描述换成紧凑文案。
 *
 * 为什么用求值器而不是把描述表传进去：light 文案的唯一权威是包侧
 * `tools/light-descriptions.ts`（宿主不得自抄），而「用户 `tool_descriptions` 覆盖 >
 * light 目录 > full 原文」这套优先级已经在包侧 `resolveRegistration().descriptionFor`
 * 里排好。本函数只做两件事：现读配置域、把 modelKey 递进去。
 *
 * 每次调用现读配置（与 prompt-section resolver 同一条理由）：调用点是工具注册（runtime
 * 构造与 embedded-search 分支刷新各一次），不是热路径；而预热缓存会让「刚改的 preset
 * 下一次注册才生效」这件事失去可解释性。
 */
export function createMagicContextToolDescriptionResolver(options: {
  configPort?: ConfigPort;
  /** 无配置口时的静态域（S19b 遗留路径，生产路径恒有 configPort）。 */
  configDomain?: unknown;
  logger?: Logger;
}): (input: { toolId: string; fullDescription: string; modelKey?: string }) => string {
  const logger = options.logger;
  const warn = (message: string): void => {
    logger?.warn("Magic context prompt surface warning", {
      module: "bootstrap",
      event: "magic_context.prompt_surface_warning",
      reason: message,
    });
  };
  const promptSurfaceRuntime = createPromptSurfaceRuntime({ warn });
  let lastConfigNotice: string | null = null;

  const readConfig = (): MagicContextConfig => {
    const raw = options.configPort
      ? options.configPort.get(ConfigKey.MagicContext)
      : options.configDomain;
    const parsed = MagicContextConfigSchema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
    if (lastConfigNotice !== reason) {
      lastConfigNotice = reason;
      logger?.warn("Magic context config rejected; prompt surface uses schema defaults", {
        module: "bootstrap",
        event: "magic_context.prompt_surface_config_defaulted",
        detail: reason,
      });
    }
    return DEFAULT_MAGIC_CONTEXT_CONFIG;
  };

  return (input) => {
    const config = readConfig();
    const registration = promptSurfaceRuntime.resolveRegistration(
      config.prompt_surface,
      input.modelKey,
    );
    return registration.descriptionFor(input.toolId, input.fullDescription);
  };
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
