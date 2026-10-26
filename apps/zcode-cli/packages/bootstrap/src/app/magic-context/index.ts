/**
 * magic-context 装配的**唯一出口**（spec phase-facade / Step 3，spec `:126`）。
 *
 * ============================================================================
 * 为什么要有这一层，以及它与同目录外那个门面的分工
 * ============================================================================
 *
 * 本目录外还留着 `../magic-context-turn-transform.ts`——那是**历史兼容面**：
 * 11 个脚本硬编码它的 dist 路径，`test-magic-context-absent-event.mjs` 的
 * `FACTORY_MODULE_MARKERS` 也指向它。它逐条 re-export 15 个符号（10 个值 + 5 个类型），
 * 一个都不能少、一个都不能多，见该文件头。
 *
 * 本文件是**未来唯一入口**：`create-app.ts`（Step 4）只从这里拿插件。两层不重复实现
 * ——旧门面 re-export 实现文件，本文件只做「把实现文件装配成一个插件」。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 *
 * ① **本文件只允许被动态 import**。它静态引入 `@zcode/magic-context`（经
 *    `./assembly.js` / `./ports.js` / `./usage.js`），任何静态边都会让关闭态把整棵
 *    MC 模块图拉进启动路径（IM1）。装配门在 `create-app.ts`，生效口径的静态半边在
 *    `./effective-enabled.ts`（那一层零 MC 依赖，所以它可以被静态 import）。
 *    **不要把 `effective-enabled.ts` 从这里 re-export**——那会把「判 flag」的静态
 *    消费者拖进 MC 模块图。
 *
 * ② **开关判定不在这里重复**。`!options.enabled` 的第一句在
 *    `createMagicContextTurnTransform`（assembly.ts），它同时负责发射
 *    `magic_context.transform_absent(reason=disabled)`。本文件若自己先 return，
 *    那条生产可达的 disabled 事件就没了（mc/A-1 的整条修复），所以这里**必须**
 *    无条件调用工厂、由工厂做门。
 *
 * ③ **usage recorder 归插件所有**。它由本文件构造并返回，调用方不再注入
 *    （入参类型 `Omit<…, "usageRecorder">`）。构造顺序是硬要求：recorder 必须先于
 *    transform，因为工厂会拿它 `prime(db)` 回上一轮落库的读数（`assembly.ts:166`），
 *    而 CLI 是「一进程一轮」——prime 缺席等于每轮从 0% 开始，scheduler 恒 defer。
 */

import type { MagicContextTurnTransform } from "@zcode/core";
import { createMagicContextTurnTransform } from "./assembly.js";
import {
  createMagicContextPromptSectionResolver,
  createMagicContextToolDescriptionResolver,
} from "./ports.js";
import type {
  MagicContextCompartmentInvalidator,
  MagicContextStorageHandle,
  MagicContextTurnTransformOptions,
} from "./types.js";
import { createMagicContextUsageRecorder, type MagicContextUsageRecorder } from "./usage.js";

/**
 * 插件入参 = 工厂入参 **减去 `usageRecorder`** + 窗口兜底解析。
 *
 * 减掉 `usageRecorder`：它是插件的**自有状态**，不是调用方的能力。调用方仍按老办法
 * 从事件扇出喂 `record()`，但那已经通过返回的 `usageRecorder` 完成，不再需要把对象
 * 递进来（旧 `MagicContextTurnTransformOptions` 类型保持不动：工厂仍接受它，11 个
 * 脚本与既有单测的直构路径逐字不变）。
 *
 * 加 `resolveFallbackContextWindow`：上下文窗口三源的第二层（env / e2e / R-2 之外
 * 的「会话生效模型的 registry 查询」）。它此前是 `createMagicContextUsageRecorder`
 * 的第三参、由 `create-app.ts` 传闭包；漏进契约就会让这一层静默消失、退回 128k 默认，
 * 改变 scheduler 决策——违反「零行为」，所以它是**必填**。
 */
export type MagicContextPluginOptions = Omit<MagicContextTurnTransformOptions, "usageRecorder"> & {
  resolveFallbackContextWindow: () => number | undefined;
};

/**
 * 装配结果。字段与 spec `:145-154` 的返回形状逐条对应。
 *
 * `turnTransform` 在 `disabled` / `db_null`（且 `fail_closed_blocking=false`）时是
 * `undefined`——core 的 turn-loop 插入点按「端口在场」判定是否插桩，所以这里不能
 * 用一个惰性 stub 代替（那会让关闭态仍产生 `transform_absent` 之外的行为）。
 *
 * `close` 与 `registerClose` 是**同一个函数对象**：工厂在构造期把关闭钩子回调给
 * `registerClose`，本文件同时捕获它并原样返回，不另造包装（包装会让「两者顺序
 * drain → shutdown → dispose」出现两份真相）。`close` 实现为 **getter**（永远读
 * 当前值），见下方 return 处的说明。
 */
export interface MagicContextPlugin {
  turnTransform: MagicContextTurnTransform | undefined;
  promptSection: ReturnType<typeof createMagicContextPromptSectionResolver>;
  toolDescription: ReturnType<typeof createMagicContextToolDescriptionResolver>;
  usageRecorder: MagicContextUsageRecorder;
  close: () => Promise<void>;
  /**
   * FORK（spec phase-compartment-rewind / C1）：rewind 之后让旧 compartment 失效。
   *
   * `undefined` = 本装配没有可用库（flag 关 / DB 开不出来）——那时 `create-app`
   * 不把 `invalidateMagicContextCompartments` 挂到 app 上，调用方按可选方法处理。
   * 与 `close` 一样是 **getter**：工厂在构造期回填，晚于返回也能补上，不会被对象
   * 字面量求值钉死成 undefined。
   */
  invalidateCompartments: MagicContextCompartmentInvalidator | undefined;
  /**
   * FORK（spec phase-zero-load / W2 / 变更点 #11）：本装配**已经开好**的 magic-context
   * 库句柄。`undefined` = 没装成（flag 关 / db_null / import 失败）。
   *
   * 装配层（`create-app`）把它投影成 `record.app.getMagicContextStorage()`：协议 handler
   * 据此决定「用这个句柄」还是「回 unavailable」，**不再自己开库**（旧行为会让一条
   * 只读 RPC 在装配缺席时创建并迁移 DB）。
   *
   * 与 `close` / `invalidateCompartments` 同样是 **getter**（工厂构造期回填，晚于返回
   * 也能补上）。
   */
  storage: MagicContextStorageHandle | undefined;
}

/** 没装成（关闭 / 库开不出来）时的关闭钩子：工厂没注册就不该有收口动作。 */
const noopClose = async (): Promise<void> => {};

/**
 * 把 MC 装配成一个插件：`turnTransform` / `promptSection` / `toolDescription` /
 * `usageRecorder` / `close` 一次给全。
 *
 * 零行为要点：这里做的三件事与 `create-app.ts` 现有手工装配**逐行等价**——
 *   1. 先 `createMagicContextUsageRecorder(sessionId, logger, {resolveFallbackContextWindow})`
 *      （create-app 的 `:851-880`）；
 *   2. 再 `createMagicContextTurnTransform({...options, usageRecorder, registerClose})`
 *      （`:885-960`），其中 `enabled` / `configPort` / `configDomain` / 进程形态 /
 *      mural probe / sidecar 工厂全部原样透传；
 *   3. 最后两个 resolver 用同一份 `configPort` / `configDomain` / `logger` 构造
 *      （`:1025-1042`）。
 * 没有新增缓存、没有改变构造顺序、没有吞掉任何返回值。
 */
export async function createMagicContextPlugin(
  options: MagicContextPluginOptions,
): Promise<MagicContextPlugin> {
  // 拆出 `resolveFallbackContextWindow`：它是 recorder 的入参，不是工厂的字段。
  const { resolveFallbackContextWindow, ...transformOptions } = options;

  // ① recorder 先于 transform（`prime` 在工厂内、DB 开出来之后立刻发生）。
  const usageRecorder = createMagicContextUsageRecorder(options.sessionId, options.logger, {
    resolveFallbackContextWindow,
  });

  // ② 工厂返回的 `close` 由 registerClose 回填；调用方自带的 registerClose 照旧转发
  // （Step 4 之前 create-app 就是靠它拿 close 的，不能因为插件接管而断链）。
  let registeredClose: (() => Promise<void>) | undefined;
  // FORK（spec phase-compartment-rewind / C1）：与 close 同一套回填手法——工厂在
  // DB 开出来之后立刻回填，本文件只捕获、不自己拼一个（水位换算要用工厂持有的
  // db + sessionStore，插件层没有这两样）。
  let registeredInvalidateCompartments: MagicContextCompartmentInvalidator | undefined;
  // FORK（spec phase-zero-load / W2 / 变更点 #11）：与 close 同一套回填手法。工厂在
  // `db` 开出来之后立刻交出句柄；本文件只捕获，不自己 openDatabase（那会多一条
  // 开库路径，也让「装配成没成」出现第二个判据）。
  let registeredStorage: MagicContextStorageHandle | undefined;
  const turnTransform = await createMagicContextTurnTransform({
    ...transformOptions,
    registerClose: (close) => {
      // FORK（cr-func 第 3 轮 P2-5）：close 完成后**清空库句柄**。
      //
      // 缺陷：`registeredStorage` 此前在 close 之后仍然指着已销毁的 db。今天没出事
      // 只是**调度**兜住的——`transport` 的请求串行 + 关闭路径先摘登记再 `await
      // close()`，所以「关闭之后还有 RPC 读这个句柄」这条时间线被排除了。这种安全性
      // 挂在两处调用顺序上，任何一处改动（并发 RPC、close 与 shutdown 交叉、宿主换
      // 传输层）都会静默退化成「拿已关闭的 db 干活」。
      //
      // 改成数据驱动：`storage` getter 读的就是 `registeredStorage`，close 一结束它
      // 立刻是 undefined → 装配层的 `getMagicContextStorage()` 回 null → handler 走
      // `unavailable` / 不自开库，不再需要「调度上不会发生」这个前提。
      //
      // 包装不改变语义边界：`plugin.close` 与 `registerClose` 回填的**仍是同一个函数
      // 对象**（本 getter 与本回调读同一个 `registeredClose`，见下方 getter 注释与
      // `test-magic-context-plugin.mjs` 的同一性断言）；包装只多做一件收尾的事，且
      // 用 `finally` 保证「close 抛错也清空」（否则最需要清空的那条路径恰好不清）。
      registeredClose = async () => {
        try {
          await close();
        } finally {
          registeredStorage = undefined;
        }
      };
      transformOptions.registerClose?.(registeredClose);
    },
    registerCompartmentInvalidator: (invalidate) => {
      registeredInvalidateCompartments = invalidate;
      transformOptions.registerCompartmentInvalidator?.(invalidate);
    },
    registerStorage: (storage) => {
      registeredStorage = storage;
      transformOptions.registerStorage?.(storage);
    },
    // 插件自己的 recorder 放在最后：即使调用方用 JS 绕过类型塞了同名键，也不生效。
    usageRecorder,
  });

  // ③ 两个 prompt-surface 注入口：配置源与 create-app 现在传的完全一致。
  const promptSection = createMagicContextPromptSectionResolver({
    configPort: options.configPort,
    configDomain: options.configDomain,
    logger: options.logger,
  });
  const toolDescription = createMagicContextToolDescriptionResolver({
    configPort: options.configPort,
    configDomain: options.configDomain,
    logger: options.logger,
  });

  return {
    turnTransform,
    promptSection,
    toolDescription,
    usageRecorder,
    // Step 5 P3-2：**getter，不是值快照**。
    //
    // 旧写法 `close: registeredClose ?? noopClose` 在对象字面量求值时就把值钉死了，
    // 它成立的前提是「工厂一定在 resolve（本函数 await 返回）之前同步调用过
    // registerClose」——该前提今天成立（`createMagicContextTurnTransform` 是 async，
    // 在内部同步段回填），但**没有任何守卫**：一旦工厂把 registerClose 挪到某个
    // 后台任务或延迟一拍，旧写法会静默退化成 noopClose，表现为「关闭钩子从不执行、
    // 也没有报错」（drain → shutdown → dispose 整条收口消失）。
    //
    // getter 永远读当前值：注册早于/晚于返回都拿得到真实 close，晚注册时还能补上。
    // 代价是每次读属性都重新求值一次 `??`（可忽略），且属性不再可写/可枚举快照——
    // `test-magic-context-plugin.mjs` 的「同一函数对象」断言在 getter 下仍成立。
    get close() {
      return registeredClose ?? noopClose;
    },
    // FORK（spec phase-compartment-rewind / C1）：同一个 getter 纪律——工厂没走到
    // DB 成功（flag 关 / db_null）时保持 undefined，装配层据此**不挂** app 端口。
    get invalidateCompartments() {
      return registeredInvalidateCompartments;
    },
    // FORK（spec phase-zero-load / W2 / 变更点 #11）：同一个 getter 纪律。undefined =
    // 没装成，装配层据此让 `getMagicContextStorage()` 回 null（handler → unavailable，
    // 不自开库）。
    get storage() {
      return registeredStorage;
    },
  };
}
