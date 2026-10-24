/**
 * magic-context 的 prompt-surface 端口（自 `../magic-context-turn-transform.ts` 逐字搬出，
 * 纯搬迁、零语义改动）：`## Magic Context` 段 resolver 与 preset 分档工具描述求值器。
 *
 * 与 `./ports.ts`（turn transform 端口）分开只为守住单文件行数门禁（max-lines 400）；
 * 两者同属拆分前「端口工厂」这一职责面，均无模块级副作用。
 */

import {
  isChinesePromptLanguage,
  type Logger,
  type MagicContextPromptSectionResolver,
} from "@zcode/core";
import { ConfigKey, type ConfigPort } from "@zcode/contracts";
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  buildMagicContextSection,
  createPromptSurfaceRuntime,
  MagicContextConfigSchema,
  type MagicContextConfig,
} from "@zcode/magic-context";
import { buildMagicContextSectionZhCn } from "../magic-context-prompt-section-zh-cn.js";

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
