/**
 * `createMagicContextTurnTransform` 工厂：bridge → DB → deps → transform → 端口 的装配链。
 *
 * 从 `../magic-context-turn-transform.ts` 拆出（Step 3 / phase-facade，零行为）。
 * 本文件持有 spec 五条零行为不变量里的三条，改动前先读它们：
 *   ① `if (!options.enabled)` 必须是**第一句**（关态零加载：不建 bridge、不开 DB）；
 *   ② deps 必须是**同一个活对象**，`applyConfigToDeps` 原地改写（热生效 + toolset 指纹）；
 *   ③ `registerClose` 的 drain → shutdown → dispose 顺序，且早于 `closeSessionResources`。
 */

import type { MagicContextTurnTransform, MagicContextTurnTransformInput } from "@zcode/core";
import { ConfigKey } from "@zcode/contracts";
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  createConfigBridge,
  createTagger,
  createTransform,
  drainHistorianSchedulerWithTimeout,
  getMagicContextDatabasePath,
  initializeMagicContextHost,
  openDatabase,
  preloadTokenizer,
  promptSurfaceConfigIdentity,
  resolveProjectIdentityForSession,
  setMuralVisionProbe,
  type ContextDatabase,
  type MagicContextConfig,
  type TransformDeps,
} from "@zcode/magic-context";
import { emitMagicContextTransformAbsent } from "../magic-context-absent-event.js";
import {
  createMagicContextHistorianHost,
  type MagicContextHistorianHost,
} from "../magic-context-historian.js";
import { readMagicContextUsageSummary } from "../magic-context-usage-summary.js";
import { createZCodeMagicContextTurnTransformPort } from "./ports.js";
import { createZCodeScheduler } from "./projection.js";
import { HISTORIAN_SETTLE_TIMEOUT_MS } from "./settle.js";
import {
  BOOT_OPEN_BUSY_TIMEOUT_MS,
  describeStorageUnavailability,
  invalidateMagicContextCompartmentsForRewind,
  openMagicContextStorageWithBusyRetry,
} from "./storage.js";
import type { MagicContextTurnTransformOptions } from "./types.js";
import { pushMagicContextUsageSummary } from "./usage.js";

export async function createMagicContextTurnTransform(
  options: MagicContextTurnTransformOptions,
): Promise<MagicContextTurnTransform | undefined> {
  // T-M8（Step 19a/23）：门控是**装配层**的判断，且必须是第一句——关着时既不建
  // bridge、也不 import magic-context 模块图、更不开 DB。这一行之下的一切都与
  // Phase 1 基线无关，所以关着时行为逐行等价。
  //
  // ⑤-5a：关着也是一种「缺席」，必须留下可观测痕迹——桌面日志/事件面据此能回答
  // 「为什么没有压缩」，而不是像取证时那样 0 条 transform pass 且 0 条告警。
  // 语义照旧：发事件后 return undefined，不建 bridge、不开 DB。
  //
  // mc/A-1：**生产由 create-app 侧发射 disabled**（flag 关时本模块根本不加载，
  // 只有那边发得出事件）；本分支保留给直构/测试（如 test-boot-busy-retry T4
  // 绕开装配门直调工厂的场景）。
  if (!options.enabled) {
    emitMagicContextTransformAbsent(
      options.logger,
      "disabled",
      "features.magicContext / magicContext.enabled is false; no bridge, no database, no transform",
    );
    return undefined;
  }

  // S15 遗留 #6：`initializeMagicContextHost()` 必须在任何 DB 写之前。装配层把本
  // 工厂放在 flag 判定之后，是因为 flag off 时整条链路（含本文件的动态 import）
  // 都不该发生——那时不存在任何 magic-context DB 写，契约因此自动成立。
  initializeMagicContextHost();

  // FORK（bugfix-batch-20261011 / Step 15，D5）：mural vision 判定源注入。必须在
  // 任何 transform pass 之前——pass 内的 m0 物化会同步调 `resolveMuralWire`。
  // 每次调用工厂都整份设置（含 undefined 清空）：多会话/重入场景下 probe 的归属
  // 必须是「本次装配的宿主能力」，而不是第一个装配过的会话残留。
  setMuralVisionProbe(options.muralVisionProbe);

  const bridge = createConfigBridge(createConfigSource(options), {
    // 写入了一个通不过 schema 的域值时，bridge 保留 last-known-good 并把原因交给
    // 这里——降级方向是「这次改动没生效」，而不是「功能被关掉」。
    onReloadFailure: (failure) =>
      options.logger.warn("Magic context config reload rejected; keeping last known good", {
        module: "bootstrap",
        event: "magic_context.config_reload_failed",
        detail: failure.error,
      }),
  });
  const config = bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG;

  // FORK（MF-05）：bridge 一旦建立就持有 `ConfigPort` 的订阅，退订与否必须有
  // 主人。下面三条提前 return 都要走同一个 dispose。
  const disposeBridge = (): void => bridge.dispose();

  // ⑤-5a：busy/瞬时失败经 `openMagicContextStorageWithBusyRetry` 有界重试
  // （退避序列 = 包内 MIGRATION_LOCK_RETRY_DELAYS_MS 前 4 档），上界后仍失败照旧
  // 抛给下面的 fail-closed 契约；确定性失败（fence/guard 之外的 ABI、不可写等）
  // 不重试、原样上抛。fence / migration guard / pending 竞争是确定性 **null**，
  // 走下面的 db_null 分支，与重试无关。
  //
  // OQ-1R：open 显式传**重试档**单次尝试上界 1s——退避序列与内建 busy_timeout
  // 此前叠加成最坏 ~40s（4 次尝试 × 5s），远超 15s boot 预算；1s 档把最坏链长压到
  // ~15s。非重试路径的 open（/ctx-* 命令）不传该参，保持包内默认 5s。
  const db = await openMagicContextStorageWithBusyRetry(
    (busyTimeoutMs) =>
      openDatabase({
        dbPath: getMagicContextDatabasePath(),
        busyTimeoutMs,
      }),
    { logger: options.logger, openBusyTimeoutMs: BOOT_OPEN_BUSY_TIMEOUT_MS },
  );
  if (!db) {
    // 细分 fence / migration_guard / pending_or_unclassified：同一个「库没开出来」，
    // 运维动作完全不同，reason 必须是机器可判的。
    const unavailability = describeStorageUnavailability();
    // ⑤-5a：db_null 缺席**先发事件**再决定降级还是抛错——默认
    // fail_closed_blocking=true 时 :816-818 先 throw，事件不能因此缺席
    // （「带着原因响亮地失败」正是可观测性的落点）。
    emitMagicContextTransformAbsent(options.logger, unavailability.reason, unavailability.detail);
    if (config.fail_closed_blocking !== false) {
      throw new Error(`[magic_context] ${unavailability.detail} (fail_closed_blocking=true)`);
    }
    // 旧名 storage_unavailable → storage_unavailability，与 transform_absent
    // 成对（absent=为什么没有 transform，unavailability=库为什么开不出来）；
    // 已检索零消费者，改名不影响任何消费面。
    options.logger.warn("Magic context storage unavailable; transform stays inert", {
      module: "bootstrap",
      event: "magic_context.storage_unavailability",
      detail: unavailability.detail,
    });
    // DB 开不出来时没有 historian、没有调度器，但 bridge 的 ConfigPort 订阅已
    // 建立——不 dispose 就等于给一个永不会生效的订阅留个尾巴。
    disposeBridge();
    return undefined;
  }

  // deps 必须是**同一个活对象**：包内 transform 每个 pass 都重新读
  // `deps.cacheTtlConfig` / `deps.executeThresholdPercentage` 等字段，所以这里把
  // 配置字段挂在一个稳定引用上，热生效时原地改写即可；重建 deps 反而会让已经
  // 持有的 transform 继续看旧闭包。
  //
  // historian 装配（S24 / D-6）在这里发生一次：executor + `historianRunnable`
  // 一起进 deps。后台调度器与 `/ctx-recomp` runner 的注册也发生在同一个工厂里
  // ——它们必须在任何一条 `/ctx-*` 命令与任何一次 turn 之前就位。
  const historian = createMagicContextHistorianHost(config, {
    logger: options.logger,
    db,
    sessionId: options.sessionId,
    workingDirectory: options.workingDirectory,
    // S24-fix：后台 pass 的 protected-tail 边界改用真实读数（recorder 记的那一份，
    // 装配期 prime 时是上一轮落库的值）。没有 recorder 时保持 `undefined` → 边界解
    // 拿 `null`，与 S24 的 provisional-zero 行为逐字相同。
    ...(options.usageRecorder === undefined
      ? {}
      : { readLiveUsage: options.usageRecorder.readUsage }),
    ...(options.createSidecarModel === undefined
      ? {}
      : { createSidecarModel: options.createSidecarModel }),
    ...(options.traceContext === undefined ? {} : { traceContext: options.traceContext }),
  });

  // 装配期把上一次落库的读数读回内存。CLI 一轮 prompt 一个进程，所以这一行是
  // 「第二轮起 transform 才看得见压力」的全部原因（见 recorder 的文件注释）。
  options.usageRecorder?.prime(db);

  // FORK（D-13）：预算摘要的两个推送时机。这里**不做** await——UI 的用量面板必须
  // 永远不等一次 sqlite 读；推的是 side state，晚一帧只影响面板的新鲜度。
  //
  //   ① pass 成功：compartments / dropped / 上下文缓存命中都在这一轮落定。
  //   ② provider usage 落库：usedTokens / usedPercent 的新水位在这一刻才写进
  //      `session_meta`，pass 结束那一刻读到的还是上一轮的数。
  const publishUsageSummary = (): void => {
    const sink = options.onMagicContextUsage;
    if (!sink) return;
    pushMagicContextUsageSummary(
      async () => (await readMagicContextUsageSummary(db, options.sessionId)).usage,
      sink,
    );
  };
  options.usageRecorder?.onUsageRecorded(publishUsageSummary);

  const deps = buildTransformDeps(config, db, options, historian);
  // ③ 热生效（D-12 第三段）：bridge 订阅 ConfigPort，配置变更即 bump
  // generation/digest 并把新域原地写进 deps。下一个 turn 的第一次 pass 就读到新值
  // ——这就是 spec Step 16 的验收判据（不重启）。
  bridge.onChange((event) => {
    applyConfigToDeps(deps, event.snapshot.effective);
    options.logger.info("Magic context config reloaded", {
      module: "bootstrap",
      event: "magic_context.config_reloaded",
      generation: event.snapshot.generation,
      changedKeys: event.changedKeys,
    });
  });

  const transform = createTransform(deps);

  // FORK（用户裁定 2026-10-11「首发消息卡顿优化」）：首轮 pass 预热。
  //
  // 实测（diag-first-send-latency.mjs + t1 窗口 CPU profile，隔离临时库）：首轮 pass
  // ~1.4s、热路径 13-19ms。差值两块——
  //   ① 93%：ai-tokenizer 的 claude encoding（2.3MB CJS）首个非空 estimateTokens 时
  //      同步加载/编译（~850ms，read-session-formatting.ts 上游刻意懒加载）；memory/
  //      preset 配置二分不影响它，配置无关节。
  //   ② 余量：`resolveProjectIdentityForSession` 的同步 git 子进程（git-dir / verify
  //      HEAD / 根提交 rev-list）与冷文件探测，每目录每进程一次（无 git 目录的临时
  //      库上为 0，真实仓库上数百 ms）。
  // 两者原本都发生在「会话第一条消息」的 model step 前置段，直接计入首 token 延迟。
  //
  // 这里在工厂建完后异步预热：把成本搬进 app 启动窗口（desktop 长驻进程在用户
  // 建会话/输入前有充裕空闲）。用 setImmediate 而非 queueMicrotask：让已排队的
  // 宏任务（如恰在启动尾已提交的首条消息）先走，预热不插队。不 await——boot 15s
  // 预算不为预热加码；失败不抛（identity 本就是非抛出语义，preloadTokenizer 内部
  // 自带 fallback 告警），未预热成功时首轮 pass 按既有懒加载语义照旧，只是退回原行为。
  setImmediate(() => {
    try {
      resolveProjectIdentityForSession(options.workingDirectory);
    } catch {
      // 非抛出语义下的双保险：任何意外都不许影响启动路径。
    }
    void preloadTokenizer().catch(() => {
      // 载入失败已由包内 fallback 告警；这里吞掉是为了不打断事件循环链。
    });
  });

  /**
   * FORK（e2e/R-2）：把本轮实际执行模型绑给两个消费者——后台 protected-tail 边界
   * 的输入，以及 usage recorder 的百分比分母（缺了分母，占比就永远算不出来）。
   *
   * 绑定时机有两处，缺一不可：
   *   - **turn 开始**（`onTurnStart`，pass 之前）：这是 R-2 的核心。原实现只在
   *     pass 成功后绑定，形成鸡生蛋死结——pass 的 scheduler 决策要读 percentage，
   *     percentage 的分母又只在 pass 成功后才有；第一轮/失败轮永远算不出占比，
   *     scheduler 恒 defer（用户实证：未设置历史/默认模型时不压缩）。
   *   - **pass 成功后**（`notifyPassSucceeded`，保留）：turn 中途换模型的场景仍能
   *     在当轮末尾刷新。提前绑定只会让这两处更准，不会互相覆盖出错——同一个
   *     `input.model`，幂等。
   */
  const bindLiveModel = (model: MagicContextTurnTransformInput["model"]): void => {
    historian.noteLiveModel(model);
    // FORK（impl-historian-inherit）：inherit 模式下折叠模型 = 会话模型，而包内
    // transform 每个 pass 从 `deps.historianModel` 现读（包内 transform.ts:1771
    // `historianRun?.model ?? deps.historianModel`）。deps 是本工厂持有的活对象
    // （与 `applyConfigToDeps` 同一套原地改写纪律），所以 live 绑定刷新必须落到
    // 同一处，否则 transform 只会看到装配期的空值。输出上限同理：它按 live 模型
    // 声明的 maxOutputTokens 夹紧（historian host 的 getter 给活值）。
    if (historian.historianModelMode === "inherit") {
      const resolved = historian.getHistorianModel();
      if (resolved === undefined) {
        delete deps.historianModel;
      } else {
        deps.historianModel = resolved;
      }
      const maxOutputTokens = historian.historianMaxOutputTokens;
      if (maxOutputTokens === undefined) {
        delete deps.historianMaxOutputTokens;
      } else {
        deps.historianMaxOutputTokens = maxOutputTokens;
      }
    }
    options.usageRecorder?.noteLiveModel(model);
  };
  const notifyPassSucceeded = (model: MagicContextTurnTransformInput["model"]): void => {
    bindLiveModel(model);
    // fire-and-forget：本行绝不 await。调度器自己合并同会话的连续触发、自己 drain、
    // 自己 abort——让 UI 等一个可能跑几十秒的 historian 是错的。
    historian.historianScheduler?.notifyTurnSuccess({ sessionId: options.sessionId });
    // D-13 ①：这一 pass 刚改过 compartments / dropped / 缓存块。
    publishUsageSummary();
  };
  // FORK（spec phase-compartment-rewind / C1）：把「rewind 之后让旧 compartment
  // 失效」交给装配层。与 `registerClose` 同一范式（构造期回填），时序要求只有一条：
  // DB 已开（水位标记与缓存列都在它上面）。闭包捕获的是**本工厂持有的同一个**
  // `db` 句柄（进程级 openDatabase 单例），不另开连接、不做每轮重建。
  //
  // 为什么这个动作不放在 core 的 `rewind-message.ts`：core 只能 `import type`（IM4），
  // 而 rewind 级联本身属另一条工作线；host 的 `fork-edit-retry.ts` 是 v4 编辑重发/
  // 重试的唯一 rewind 调点，一行可选调用即可覆盖 C1 收窄后的范围。
  options.registerCompartmentInvalidator?.(async (input) => {
    await invalidateMagicContextCompartmentsForRewind(
      {
        db,
        sessionId: options.sessionId,
        ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
        logger: options.logger,
      },
      input,
    );
  });

  // FORK（MF-05）：会话/进程关闭时按 **drain → shutdown → dispose** 的顺序收口。
  //
  //   ① drain（有界）：在飞的那次后台 pass 先跑完，让它的 publish 与 drain 预留真正
  //      落库——「一进程 = 一轮」下这一步不做就等于把尾账留给下一个进程。
  //   ② shutdown：停调度 + abort 在飞的 sidecar 请求（MF-03 补上 signal 之后它才
  //      真的停得下来）。
  //   ③ dispose：退掉 bridge 对 `ConfigPort` 的订阅，订阅计数归零。
  //
  // 三步都必须在 `closeSessionResources` **之前**：historian 要写库，而那时 store /
  // execution port 还开着。
  options.registerClose?.(async () => {
    if (historian.historianScheduler !== undefined) {
      await drainHistorianSchedulerWithTimeout(
        historian.historianScheduler,
        HISTORIAN_SETTLE_TIMEOUT_MS,
      );
    }
    historian.shutdown();
    disposeBridge();
  });

  const port = createZCodeMagicContextTurnTransformPort(transform, {
    getConfig: () => bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG,
    options,
    // e2e/R-2：**turn 开始即绑定**实际执行模型（pass 之前）。门控与
    // `onPassSucceeded` 同源：两个消费者（historian 边界 + usage recorder）
    // 任一在场就挂。historian 的 `noteLiveModel` 只记一个数，runnable=false 时盲记
    // 无害；recorder 缺席时 `bindLiveModel` 内部自动跳过那一半。
    ...(historian.historianScheduler === undefined && options.usageRecorder === undefined
      ? {}
      : { onTurnStart: bindLiveModel }),
    // 两个消费者都不在时**不挂**回调：Step 19b 的单测走的就是这条路径，它必须与
    // S19b 逐行相同。
    ...(historian.historianScheduler === undefined && options.usageRecorder === undefined
      ? {}
      : { onPassSucceeded: notifyPassSucceeded }),
    // FORK（MF-04）：调度器那一次 pass 也需要有界 settle。`notifyTurnSuccess` 本身
    // 仍是 fire-and-forget（不该让 UI 等一次可能几十秒的 historian），但**进程会
    // 退出**——于是在这一轮交还控制权之前，替它等一个有界的窗口。
    //
    // FORK（bugfix-batch-20261011 / Step 2）：钩子**无条件装配**，「要不要等」由
    // 端口按 `processExitsAfterTurn` 决定（见 `settleScheduledPass` 的形参注释与
    // 端口入口）。之所以不在这里按形态「不装配」：判据两处各写一次就会在将来只改
    // 一处的午后静默分叉；端口是唯一的阻塞决策点，装配只负责把 drain 那个动作递
    // 过去。长驻形态下这个闭包不被调用，本身零成本。
    //
    // `notifyTurnSuccess` 的 `in_flight` no-fire 在长驻形态是**预期行为**而不是
    // 故障：端口不再前台等这一次 pass，于是下一轮 turn 成功时上一轮可能还在飞，
    // 包内调度器按 coalescing 语义记 `in_flight` 后丢弃同一个 raw head 的重复请求
    // （`historian-scheduler.ts` 的 `process()`）。`getLastNoFireCause` 会稳定显示
    // `in_flight`——运维据此判断「折叠在进行中」，不得当故障修；真的要等它在飞的
    // 那一次，走 close 钩子的 drain（MF-05）。
    ...(historian.historianScheduler === undefined
      ? {}
      : {
          settleScheduledPass: () =>
            drainHistorianSchedulerWithTimeout(
              historian.historianScheduler as NonNullable<typeof historian.historianScheduler>,
              HISTORIAN_SETTLE_TIMEOUT_MS,
            ),
        }),
  });
  // FORK（MF-01）：端口上的活值开关。core 每个 turn 现读它，于是设置页把
  // `magicContext.enabled` 关掉后**下一个 turn**就不再插桩，而不必重启进程。
  //
  // 数据源刻意是 bridge 自己的快照而不是 `runtimeConfig`：那份 config 是装配期的
  // 冻结副本，而这里的快照被 `ConfigPort` 订阅持续更新，正是「活值」的那一半。
  // `enabled` 缺席按 schema 缺省 true 处理。
  const isEnabled = (): boolean =>
    (bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG).enabled !== false;
  return Object.assign(port, { isEnabled });
}

/**
 * D-12 第二段与第三段之间的桥：`ConfigPort` → 包内 `MagicContextConfigSource`。
 *
 * 签名对齐的两处细节（实测 `adapters/src/config/index.ts`）：
 *   - `ConfigPort.observe()` 不接受 key，它返回 `ConfigObserver`，key 在
 *     `.subscribe(key, handler)` 上。因此这里每次 `read()` 取一次 observer 再订阅，
 *     而不是 `observe(key, cb)`。
 *   - `subscribe` 的 handler 是 `(value, prev) => void`，包的 source 只要
 *     `() => void`（它自己会重新 `read()`），所以用 `() => void` 包一层，
 *     **不**把回调参数透传过去——那会让 bridge 拿到上一次的快照当新值。
 *   - `ConfigPort.set` 传的是整域值，`get(key)` 原样返回（无校验），所以
 *     `read()` 不需要自己拼装 `{}`；域校验是 bridge 的活（失败即保留 last-known-good）。
 */
function createConfigSource(options: MagicContextTurnTransformOptions): {
  read: () => unknown;
  subscribe: (listener: () => void) => () => void;
} {
  const configPort = options.configPort;
  if (!configPort) {
    // S19b 遗留的静态源：没有配置口时读一次快照，永不推送。
    return {
      read: () => options.configDomain ?? {},
      subscribe: () => () => {},
    };
  }
  return {
    read: () => configPort.get(ConfigKey.MagicContext),
    subscribe: (listener) =>
      configPort.observe().subscribe(ConfigKey.MagicContext, () => listener()),
  };
}

/**
 * 把一份已校验的配置原地写进 TransformDeps 的配置派生字段。
 *
 * 只覆盖包内声明为「配置来源」的那些字段；`db` / `tagger` / `contextUsageMap` 等
 * 运行期状态不动。`scheduler` 是唯一例外——它在装配时按当时配置闭包捕获了阈值，
 * 所以换成每 pass 现读配置的版本（见 `createZCodeScheduler`）。
 *
 * historian 字段**故意不在这里**（含 `historianModel`）：executor 与模型三态是
 * 装配期一次性决定的（`createMagicContextHistorianHost`），改 `historian.model`
 * 的热更新要重建 executor，属于装配层而非 deps 层的事——与本次改动之前一致，
 * 下一个进程生效。inherit 模型的**每 turn live 刷新**走 `bindLiveModel`，与本
 * 函数的热更新是两条互不干扰的路。
 */
function applyConfigToDeps(deps: TransformDeps, config: MagicContextConfig): void {
  deps.cacheTtlConfig = config.cache_ttl;
  if (config.protected_tokens === undefined) {
    delete deps.protectedTokens;
  } else {
    deps.protectedTokens = config.protected_tokens;
  }
  deps.smartDrops = config.smart_drops;
  deps.historyBudgetPercentage = config.history_budget_percentage;
  deps.executeThresholdPercentage = config.execute_threshold_percentage;
  if (config.execute_threshold_tokens === undefined) {
    delete deps.executeThresholdTokens;
  } else {
    deps.executeThresholdTokens = config.execute_threshold_tokens;
  }
  deps.scheduler = createZCodeScheduler(config);
  // FORK（bugfix-batch-20261011 / Step 12）：prompt-surface 域进 deps。包内 transform 每
  // pass 现读 `deps.promptSurface`（与 cacheTtlConfig 同一套「活对象原地改写」纪律），
  // 所以设置页改 preset / models / tool_descriptions / guidance_override_path 都在下一
  // 个 pass 生效，不需要重建 transform。
  deps.promptSurface = config.prompt_surface;
  // FORK（bugfix-batch-20261011 / Step 13）：`memory.enabled` 的 transform 侧消费点。
  // 包内 transform 用它决定 `<project-memory>` 注不注入（`memoryEnabled: deps.memoryConfig?.enabled`，
  // 见包内 transform.ts 的 m0/m1 装配）以及 historian 分舱的 Issue #44 自动提升门。
  // 此前该字段从未被填过 → 恒 undefined → 记忆注入面在运行期是**关**的，这正是本批缺陷④
  // 「只接了压缩半边」的现场症状之一。另两个字段（injectionBudgetTokens / autoPromote）
  // 上游缺省 4000 / true，本 fork 的白名单不登记它们（Step 11 已裁定：只落有消费者的
  // 字段），因此按上游缺省直填并在此登记，不开新的配置入口。
  deps.memoryConfig = {
    enabled: config.memory.enabled,
    injectionBudgetTokens: MEMORY_INJECTION_BUDGET_TOKENS_DEFAULT,
    autoPromote: MEMORY_AUTO_PROMOTE_DEFAULT,
  };
  // FORK（bugfix-batch-20261011 / Step 15，D5）：`mural.enabled` 的 transform 侧
  // 消费点。包内 transform 把它带进 m0/m1 装配（`muralEnabled: deps.muralEnabled`，
  // 见包内 transform.ts 的 materializeM0  pack options）；inject-compartments 的
  // `resolveMuralForM0` 再以 `options.muralEnabled` 为门。Step 11 起
  // `config.mural.enabled` 已能写进 config.json，但本字段此前从未被填过 → 恒
  // undefined → 壁画在运行期是**关**的（OQ-CTX 登记的透传缺口，本步闭合）。
  // 渲染真触发还需 vision 判定为真（宿主注入的 supportsImage probe，见
  // `muralVisionProbe` 选项）；两者皆真的自然折叠上才会渲染 PNG。
  deps.muralEnabled = config.mural.enabled;
}

function buildTransformDeps(
  config: MagicContextConfig,
  db: ContextDatabase,
  options: MagicContextTurnTransformOptions,
  historian: MagicContextHistorianHost,
): TransformDeps {
  const liveModelBySession = new Map<string, { providerID: string; modelID: string }>();
  const liveModels = liveModelBySession;
  // FORK（impl-historian-inherit）：喂包侧的 historian 模型一律经过
  // `getHistorianModel()`（三态解析后的具体 key）。装配期只能看到显式配置值；
  // inherit 模式的 live 绑定要等 turn 开始，由 `bindLiveModel` 原地改写这一位
  // （deps 是本工厂持有的活对象，包内 transform 每个 pass 现读它）。
  const historianModel = historian.getHistorianModel();
  // MF-PS-1：显式标注 TransformDeps（`satisfies` 不改变推断类型，构造后赋值
  // getToolSetHash 需要字段在类型面上可选可见）。
  const deps: TransformDeps = {
    db,
    tagger: createTagger(),
    scheduler: createZCodeScheduler(config),
    // S19b 留的空表；S24 由宿主侧的 usage recorder 供给（见选项说明）。
    contextUsageMap: options.usageRecorder?.contextUsageMap ?? new Map(),
    // S24-fix：声明 ZCode CLI 的进程模型，让包内 transform 的「首 pass usage 重置」
    // 走累积语义而不是上游的清零语义。**这是 T-M2/T-M3/T-M6 三项能跑起来的前提**：
    // 不声明时每一轮 prompt 的首 pass 都会把上一轮落库的占用读数清成 0%，scheduler
    // 于是永远 defer，drop 与 historian 一次都不启动（现场见 MVP 报告 §3）。
    //
    // FORK（bugfix-batch-20261011 / Step 2）：这一位**保持硬编码
    // `"one-process-per-turn"` 不动**，本批只条件化 settle，不碰 usage 累积语义。
    // 两条理由登记在案（不是没想过，是各自都有不可接受的代价）：
    //   ① 改成 per-session 会让长驻进程 resume 新 session 时按 per-session 语义重置
    //      首 pass 读数，重引入 usage 全灭回归（T-M2/T-M3/T-M6 的共同根因，见上）；
    //   ② 新增第三个枚举值落在包内 transform.ts 的 S20 特权区——改包内逐字区是
    //      本 fork 的纪律禁区，宿主侧不越权。
    // 进程形态（长驻/短驻）与这一位正交：`processExitsAfterTurn` 在**端口层**决定
    // 「等不等 historian」，这里决定「首 pass 是否重置 usage 读数」，互不影响。
    hostProcessLifetime: "one-process-per-turn",
    clearReasoningAge: 50,
    historyRefreshSessions: new Set<string>(),
    pendingMaterializationSessions: new Set<string>(),
    lastHeuristicsTurnId: new Map<string, string>(),
    commitSeenLastPass: new Map<string, boolean>(),
    // C 组缝（S24 接）：sidecar executor 在场时 transform 的 compartment phase
    // 才可能 startCompartmentAgent；两者任一缺席都走「诚实关闭」那条分支
    // （清 `compartmentInProgress`、不起 agent），而不是每 pass 报错。
    ...(historian.hiddenCompletionExecutor === undefined
      ? {}
      : { hiddenCompletionExecutor: historian.hiddenCompletionExecutor }),
    historianRunnable: historian.historianRunnable,
    ...(historianModel === undefined ? {} : { historianModel }),
    ...(historian.fallbackModels.length === 0 ? {} : { fallbackModels: historian.fallbackModels }),
    historianTwoPass: historian.historianTwoPass,
    historianTimeoutMs: historian.historianTimeoutMs,
    getHistorianChunkTokens: historian.getHistorianChunkTokens,
    ...(historian.historianMaxOutputTokens === undefined
      ? {}
      : { historianMaxOutputTokens: historian.historianMaxOutputTokens }),
    cacheTtlConfig: config.cache_ttl,
    ...(config.protected_tokens === undefined ? {} : { protectedTokens: config.protected_tokens }),
    // FORK（bugfix-batch-20261011 / Step 13）：记忆半边运行期开关。`applyConfigToDeps`
    // 会在每次配置变更时原地改写这三个字段；这里给装配期的初值。三个字段的语义与缺省
    // 依据见 applyConfigToDeps 处的登记。
    memoryConfig: {
      enabled: config.memory.enabled,
      injectionBudgetTokens: MEMORY_INJECTION_BUDGET_TOKENS_DEFAULT,
      autoPromote: MEMORY_AUTO_PROMOTE_DEFAULT,
    },
    // FORK（bugfix-batch-20261011 / Step 15，D5）：mural 总开关（`mural.enabled`，
    // Step 11 白名单字段，默认 off）。与 memoryConfig 同一套「活对象原地改写」纪律：
    // `applyConfigToDeps` 在配置变更时刷新它，下一个 pass 即生效。
    muralEnabled: config.mural.enabled,
    smartDrops: config.smart_drops,
    historyBudgetPercentage: config.history_budget_percentage,
    executeThresholdPercentage: config.execute_threshold_percentage,
    executeThresholdTokens: config.execute_threshold_tokens,
    directory: options.workingDirectory,
    projectPath: options.workingDirectory,
    transformMode: "ts",
    liveModelBySession: liveModels,
    getModelKey: (sessionId: string) => {
      const live = liveModels.get(sessionId);
      return live ? `${live.providerID}/${live.modelID}` : undefined;
    },
    getNotificationParams: () => ({}),
    // FORK（bugfix-batch-20261011 / Step 12）：prompt-surface 配置身份进 telemetry 指纹。
    //
    // 包内语义（inject-compartments.ts 的 M0HardSignals 注）：toolSetHash 是
    // **attribution-only** 信号——「tool-set 变化永不触发 m[0] 折叠」（它的
    // process-global 作用域会在无关会话上制造假折叠），只在决策审计里留下 prev/new 两个
    // 操作数。因此这里折进配置身份是安全的，且必须折：
    // preset 从 full 翻到 light 时 ctx_* 四个工具的描述整段换掉，providers 侧的
    // `tools` 数组字节随之改变，m[0] 的 baseline 与它记录的指纹必须能在审计里对上；
    // 继续回空串等于「本条路径的 tool-set 恒不变」的谎言（Step 11 之前这还算诚实——
    // `deps.promptSurface` 是 undefined、包内也不读它；Step 12 起它真的进 deps 了）。
    //
    // FORK（bugfix-batch-20261011 / MF-PS-1，CR fix）：指纹闭包**现读
    // `deps.promptSurface`**，不捕获装配期的 `config`。`applyConfigToDeps` 每次
    // 配置刷新都换 `deps.promptSurface` 引用（config-bridge 每次 refresh 产新对象），
    // 而闭包捕获的是当初构造时那个 config 对象——长驻进程（桌面/app-server/TUI）在
    // 设置页翻转 preset 后，指纹会恒为装配期旧值，transform_decisions /
    // cached_m0_tool_set_hash 的 prev==new 恒等，「预设翻转必须留得下审计操作数」
    // 就此落空（CLI 一进程一轮无此问题，长驻才有）。字段在 TransformDeps 上是可选
    // 的，构造后赋值过类型检查；「活对象 + 构造后赋值」与同文件 historianModel 的
    // live 绑定同一范式。
    promptSurface: config.prompt_surface,
  } satisfies TransformDeps;
  // MF-PS-1：构造后赋值（字段可选，过类型检查）——见上方 getToolSetHash 注释块。
  deps.getToolSetHash = () => promptSurfaceConfigIdentity(deps.promptSurface);
  return deps;
}

/**
 * FORK（bugfix-batch-20261011 / Step 13）：`memory.injection_budget_tokens` 的缺省。
 *
 * 上游 `config/schema/magic-context.ts` 的 memory 子树上这个字段缺省 4000（min 500,
 * max 20000）；本 fork 的 E 组白名单不登记它（Step 11 裁定：只落有消费者的字段——本批
 * 没有任何配置入口要调它），因此按上游缺省直填。若将来要开放这个旋钮，改这里 +
 * `MemoryConfigSchema` 两处，且必须同步这里的注释说明「为什么是同一个数」。
 */
const MEMORY_INJECTION_BUDGET_TOKENS_DEFAULT = 4000;

/**
 * FORK（bugfix-batch-20261011 / Step 13）：`memory.auto_promote` 的缺省。
 *
 * 上游缺省 true（Issue #44：没有它 memories 表永远是空的）。Step 8 已恢复 fork 的
 * `promoteSessionFactsDurable` 写入链，因此这里必须是 true 而不是「先关着省事」。
 */
const MEMORY_AUTO_PROMOTE_DEFAULT = true;
