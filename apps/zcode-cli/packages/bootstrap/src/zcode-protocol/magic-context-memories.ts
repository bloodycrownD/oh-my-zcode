/**
 * FORK（magic-context-memory-management / 变更点 7 · Step 6）：设置页「记忆」分区的
 * 管理面板数据面——`workspace/listMagicContextMemories` 与
 * `workspace/archiveMagicContextMemories` 两个 workspace RPC 的 CLI 侧 handler。
 *
 * ============================================================================
 * 数据流位置（spec 总体方案）
 * ============================================================================
 *
 *   设置页 MemoryManagementSection（packages/ui）
 *     └─ services.zcodeAgentService.list/archiveMagicContextMemories（Step 5，只转发 wire）
 *         └─ 本文件（Step 6：effective 门 → 开库 → 身份解析 → 包侧 barrel 调用）
 *             └─ @zcode/magic-context 的 host/memory-admin.ts 组合函数（Step 1）
 *
 * 四处手工对齐的坐标 ③（spec 变更点 5）：本文件 + server.ts 两处 case；另两处是
 * shared 的 schema/方法名（Step 4）与 services 方法（Step 5）。
 *
 * ============================================================================
 * effective 门（关着不建库）
 * ============================================================================
 *
 * 沿用 ctx-status 的「关掉不建库」纪律（spec D6）：`magicContext.enabled === false`
 * 时两方法都不触碰数据库——list 回 `available:false, reason:"disabled"` 的零值信封
 * （面板走占位态），archive 抛可读错误（其结果信封没有 available 位，空 outcomes
 * 会被 UI 读成「什么都没发生」，是更糟的谎）。
 *
 * 「effective 域」的读取次序照 config lane 的先例（readMagicContextConfig /
 * readPromptLanguage 同款三段）：**ConfigPort 优先、文件兜底**——有 resident
 * session 时它才是运行时真正在用的那一份（D-12 的 update 会热推 ConfigPort），
 * 没有活动 session 时读 `~/.omz/cli/config.json` 得到的就是下次建 App 会读到的
 * 同一份值。两次读取都过同一个 `MagicContextConfigSchema`：坏域按 schema 缺省
 * （`enabled` 默认 true）处理，与 config bridge / transform 的降级方向一致——
 * 「文件暂时坏」不是「用户把功能关了」，不该伪造成 disabled 占位。
 *
 * 刻意**不**读 `app.isMagicContextEnabled?.()`：那是 create-app 冷启动时冻结的
 * 一次求值（run-ctx-command.ts:123-131 的注释），运行中经设置页改 `enabled` 不会
 * 更新它——而本 handler 服务的正是设置页本身，必须与用户刚提交的那份配置同频。
 *
 * ============================================================================
 * list：口径与映射
 * ============================================================================
 *
 * - 列表 = `listProjectMemoriesForAdmin`（三 status 全回、expiryCutoff=0 的管理
 *   视图；merged 行 status 也是 archived、靠 supersededByMemoryId 区分展示）。
 * - `category` 过滤在 CLI 侧施加（协议层不复刻词表，权威在包侧 memory/types.ts
 *   的 12 值 accept-both 域：v2 五类 + legacy 九类，重叠 CONSTRAINTS/NAMING 去重后
 *   唯一值 12），按 string 全等。
 * - `offset`/`limit` 分页在过滤后的集合上切片；`truncated` = 本页之后还有未返回
 *   的条目（offset + 本页长度 < 过滤后总数），与 shared 侧字段注释一致。
 * - entries 是 `memories` 行管理视图投影的直通：`expiresAt`/`supersededByMemoryId`
 *   在存储读边界（isMemoryRow）保证为 number|null，NULL 原样过线；`archiveReason`
 *   从 `metadata_json.archive_reason` 提出（D5：reason 存 metadata），缺席即不带该键。
 * - counts 是 `getMemoryCountsByStatus` 口径的**汇总参考**（merged 归 merged 桶、
 *   无过期过滤），与列表存在登记在案的差（spec 兼容性节），面板以列表为准。
 *
 * ============================================================================
 * archive：逐 id outcome 直通
 * ============================================================================
 *
 * - 调组合函数 `archiveProjectMemories`（唯一能保证 archiveMemory + mutation 行
 *   同事务成对写的入口），outcomes 按四值枚举直通（archived / already-archived /
 *   missing / rejected），**rejectionReason 不进 wire**：拒绝子因（ownership /
 *   superseded）只在工具面用于选文案，wire 上 message 已是可直显文本（ownership
 *   的 message 在组合函数里就是不透明的「was not found」，防泄漏纪律）。
 * - 组合函数可能抛 `ModuleMemoryAuthorityError`（module authority 托管的项目）：
 *   捕获转可读的 ProtocolRequestError（fail-visible，不是降级）。判据用 `code` /
 *   `name` 字段（见 {@link isModuleMemoryAuthorityError}）——该错误来自动态 import 的
 *   另一个模块实例，两份包副本时 `instanceof` 会静默失效（ZL-6）。
 * - 开库抛错（如 `SQLITE_BUSY` / `database is locked`）在 archive 侧**原文透传**：
 *   services 的可重试转译靠 message 匹配（Step 5 的 isSqliteBusyError），这里重新
 *   包一层会把可重试信号吃掉；null（确定性打不开）给可读的 -32010。list 侧：开库段
 *   与身份解析段失败收敛为 unavailable 信封（与 ctx-status 的 openStore 同款）；
 *   读段错误冒泡 -32603，由 services 层转译为可重试文案。
 * - 身份解析不出（家目录未授权 / git 身份暂不可用）与工具面同款措辞；这是正常
 *   状态不是故障，但用户点的是「本项目记忆」，回空列表是误导，故 fail-visible。
 *
 * 只读面（list）无副作用；archive 是幂等软删（重复调用第二条走 already-archived）。
 */

import { ConfigKey } from "@zcode/contracts";
import { getDefaultConfigPath, loadFileConfig } from "@zcode/adapters/config";
// 只有**类型**留在顶层：`Memory` 是 `import type`，编译后被完全擦除，不产生解析边。
import type { Memory } from "@zcode/magic-context";
import {
  zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema,
  zcodeWorkspaceArchiveMagicContextMemoriesResultSchema,
  zcodeWorkspaceListMagicContextMemoriesParamsSchema,
  zcodeWorkspaceListMagicContextMemoriesResultSchema,
  type ZCodeWorkspaceArchiveMagicContextMemoriesResult,
  type ZCodeWorkspaceListMagicContextMemoriesParams,
  type ZCodeWorkspaceListMagicContextMemoriesResult,
} from "@zcode/shared";
import { resolveMagicContextEffectiveEnabled } from "../app/magic-context/effective-enabled.js";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * FORK（magic-context-decoupling / phase-zero-load / Step 6）：本模块**不再**在顶层
 * 从包 barrel 静态值导入 10 个符号（`DEFAULT_MAGIC_CONTEXT_CONFIG` /
 * `MagicContextConfigSchema` / `ModuleMemoryAuthorityError` / `archiveProjectMemories` /
 * `getMagicContextDatabasePath` / `getProjectMemoryCountsForAdmin` /
 * `initializeMagicContextHost` / `listProjectMemoriesForAdmin` / `openDatabase` /
 * `resolveProjectIdentityForSession`）。
 *
 * 原因：本文件经 `server.ts` 静态常驻，顶层 barrel 值导入会让**进程一启动**就解析整棵
 * MC 图（实测 231 个包内文件），`features.magicContext` 还没被读到就已经付过这份钱
 * （spec W2 / IM1）。
 *
 * 两种导入必须**分列**（混着写会白改）：
 *   - **判 flag 只需 schema** → 窄子路径 `@zcode/magic-context/host/config/schema`
 *     （闭包实测 3 文件 + zod，即 M0）。effective 门只用它的 `safeParse`。
 *   - **业务符号**（存储 / 管理视图 / 组合函数 / authority 错误类）→ 开门之后才
 *     `await import("@zcode/magic-context")`。业务符号只在确实要读库时才需要。
 *
 * 信封语义不可破（spec T-MC5）：list 侧把「schema 取不到」「业务符号取不到」都收敛成
 * `unavailable` 信封（`supported:true`），绝不抛 `-32603`；archive 侧的结果信封没有
 * `available` 位，只能抛可读 `-32010`（与开库失败同一处置，见文件头）。
 *
 * 「业务符号取不到」这一态生产上不可构造（包在 manifest 里），所以经
 * `MagicContextMemoriesDependencies.loadRuntime` 留了单测注入缝（ZL-4）——否则它只是
 * 一页没有测试的代码，回归时会静默变成 `-32603`。
 *
 * 登记处：`UPSTREAM-SYNC.md` 第 3 节「插件化偏离点（rebase 登记）」。
 */
type MagicContextModule = typeof import("@zcode/magic-context");
/** `openDatabase` 的非空半边（端口里的 `db` 是不透明的 `unknown`，这里窄回来）。 */
type MagicContextDatabase = NonNullable<ReturnType<MagicContextModule["openDatabase"]>>;

/** 判 flag 只用 schema：窄子路径，闭包 3 文件 + zod。 */
async function loadMagicContextConfigSchema(): Promise<
  typeof import("@zcode/magic-context/host/config/schema")
> {
  return await import("@zcode/magic-context/host/config/schema");
}

/** 业务符号：barrel，只在 effective 门放行之后加载。 */
async function loadMagicContextRuntime(): Promise<MagicContextModule> {
  return await import("@zcode/magic-context");
}

/**
 * 取业务符号模块：注入缝优先（单测专用），否则走真 barrel 动态 import。
 *
 * 「怎么加载」可换，「失败怎么办」不可换：异常原样外抛，由调用方按各自信封语义处理。
 */
async function resolveMagicContextRuntime(
  dependencies: MagicContextMemoriesDependencies,
): Promise<MagicContextModule> {
  return await (dependencies.loadRuntime ?? loadMagicContextRuntime)();
}

/**
 * `ModuleMemoryAuthorityError` 的跨副本判据（ZL-6）。
 *
 * 生产路径上这个错误来自**动态 import 的另一个模块实例**：同一个进程里若存在两份
 * `@zcode/magic-context` 副本（pnpm 嵌套解析、打包/直构混用），`instanceof` 会静默
 * 失效（两份类的原型链不同），authority 拒绝就会被当普通错误原文透传，用户看到的是
 * 一句内部报错。该类自带 `code` 与 `name` 两个稳定标记（storage-memory.ts:624-633），
 * 用它们判据与副本无关；`instanceof` 仍留作第一判据（本地副本时零成本、且能挡住
 * 恰好同名的无关错误）。
 */
function isModuleMemoryAuthorityError(error: unknown): boolean {
  if (error instanceof Error && error.name === "ModuleMemoryAuthorityError") return true;
  if (error === null || typeof error !== "object") return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === "MEMORY_MODULE_AUTHORITY" || name === "ModuleMemoryAuthorityError";
}

/** 供单测注入的窄缝；生产路径固定为用户级 `~/.omz/cli/config.json` 与真 barrel。 */
export interface MagicContextMemoriesDependencies {
  configPath?: string;
  /**
   * 业务符号加载器（ZL-4）：默认（不传）走 {@link loadMagicContextRuntime}。
   *
   * 唯一目的是让「包在、但业务符号加载失败」这一态**可测**（spec T-MC5 第三态）：
   * 生产路径上 `import("@zcode/magic-context")` 抛错是不可构造的（包已在
   * package.json 里），所以这条分支此前只有代码、没有测试。注入缝只换「怎么加载」，
   * **不换失败语义**——抛错仍由两个 handler 各自收敛（list → unavailable 信封，
   * archive → 可读 -32010），与 schema 加载失败同一处置。
   */
  loadRuntime?: () => Promise<MagicContextModule>;
  /**
   * FORK（magic-context-decoupling / cr-func 第 2 轮 P1-2）：**直构夹具**才允许自己
   * 开库的显式标记，默认 `false`。
   *
   * 为什么必须有这个标记：`absent`（没有任何 session 暴露存储端口）在过去被当成
   * 「直构/单测夹具形态」，于是保留自开库兜底。但它在**生产上可达**——两条记忆 RPC 是
   * **workspace 级**（handler 不接 `sessionId`），`context.sessions` 构造时为空
   * （`server.ts:256`）、`closeSession` 会 `delete`（`server-operations.ts:2581`），
   * 于是「冷启动 CLI」或「用户把会话全关掉后打开设置里的记忆面板」都会走到 `absent`
   * → 自开库 → **创建并迁移数据库**。那正是端口要根治的缺陷。
   *
   * 判据必须是**显式注入**而不是「端口方法在不在」：方法缺席只说明这个 App 没暴露
   * 端口（可以是老宿主、也可以是还没装配），推不出「现在可以替它把库造出来」。
   * `test-magic-context-memories-rpc.mjs` 的直构用例显式传 `allowDirectOpen: true`。
   */
  allowDirectOpen?: boolean;
}

/** 打不开/关着时列表信封的零值计数（字段集与 `getMemoryCountsByStatus` 的 wire 投影一致）。 */
const ZERO_MEMORY_COUNTS = {
  total: 0,
  active: 0,
  permanent: 0,
  archived: 0,
  merged: 0,
} as const;

/**
 * effective `magicContext.enabled` 的读取：ConfigPort 优先、文件兜底（config lane
 * 先例，见文件头）。坏域按 schema 缺省（`enabled` 默认 true），不把「文件暂时坏」
 * 伪造成「功能被关」。
 *
 * 惰性化（Step 6）：schema 走窄子路径动态 import。**取不到时向外抛**——调用方
 * （两个 handler）各自把它映射成自己的失败形态：list → `unavailable` 信封，
 * archive → 可读 -32010。这里不吞错，否则「包被摘除」会被误读成「功能被关」。
 */
async function isMagicContextDisabled(
  context: ZCodeProtocolAgentServerContext,
  configPath: string,
): Promise<boolean> {
  const { MagicContextConfigSchema, DEFAULT_MAGIC_CONTEXT_CONFIG } =
    await loadMagicContextConfigSchema();
  const readEnabled = (raw: unknown): boolean => {
    const parsed = MagicContextConfigSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data.enabled : DEFAULT_MAGIC_CONTEXT_CONFIG.enabled;
  };

  for (const record of context.sessions.values()) {
    const configPort = record.app?.getConfigPort?.();
    if (!configPort) continue;
    // ConfigPort 的 MagicContext 域恒有值（注册时把 schema 的 .default() 解析结果
    // 钉进去了），safeParse 是纵深防御而非正常路径。
    return !resolveMagicContextEffectiveEnabled({
      // feature kill switch 与装配层同源（契约 8）；端口值缺席按缺省 true。
      featureFlag: configPort.get(ConfigKey.FeatureMagicContext) !== false,
      domainEnabled: readEnabled(configPort.get(ConfigKey.MagicContext)),
    });
  }
  const loaded = loadFileConfig(configPath);
  return !resolveMagicContextEffectiveEnabled({
    // 文件里没写 features 段时按缺省 true（config lane 的默认值），不能把
    // 「没配」读成「关了」。
    featureFlag: loaded.config.features?.magicContext !== false,
    domainEnabled: readEnabled(loaded.config.magicContext),
  });
}

/**
 * 装载数据库句柄。`initializeMagicContextHost()` 必须在任何 DB 写之前（幂等）。
 *
 * **只有直构夹具会走到这里**（`dependencies.allowDirectOpen === true`，见该字段注释）：
 * 生产装配路径一律用装配层交付的句柄，`absent` 也不再自开库。
 *
 * 返回 null = 确定性打不开（schema fence / 迁移未完成 / pending 竞争）；
 * throw = busy/瞬时类失败（openDatabase 以 `{ cause }` 保留底层错误，message
 * 逐字可用）。
 */
function initializeAndOpenDatabase(
  magicContext: MagicContextModule,
): ReturnType<MagicContextModule["openDatabase"]> {
  magicContext.initializeMagicContextHost();
  return magicContext.openDatabase(magicContext.getMagicContextDatabasePath());
}

/**
 * 装配层交付的库句柄（spec phase-zero-load / W2 / 变更点 #11）。
 *
 * 三态与语义（cr-func 第 2 轮 P1-2 修正：`absent` 的生产可达性）：
 *   · `installed`   → 用装配层**已经开好**的句柄，不再 openDatabase；
 *   · `unavailable` → 有 App 暴露了端口，但没有任何一个给出句柄（装配抛错 / db_null /
 *     import 失败，或多个 App 都回 `null`）→ 调用方回 unavailable / `-32010`，
 *     **绝不自开库**；
 *   · `absent`      → 没有任何 session 暴露该端口。它**不是**「夹具形态」而是生产可达：
 *     两条 RPC 是 workspace 级、不接 `sessionId`，`context.sessions` 构造时为空、
 *     `closeSession` 会 delete——冷启动 CLI 或会话全关时打开记忆面板就是这一态。
 *     因此同样**不许自开库**，调用方按 unavailable 处理。直构夹具改走显式
 *     `dependencies.allowDirectOpen`。
 */
type InstalledStorage =
  | { state: "absent" }
  | { state: "unavailable" }
  | { state: "installed"; db: MagicContextDatabase };

/**
 * 逐 session 找**第一个给出句柄**的 App。
 *
 * 不能「第一个暴露端口的 App 决定全局」：`ProtocolRuntimeResources` 可能同时持有临时
 * workspace app 与已登记 app，第一个回 `null` 就整体判 unavailable 会让另一个真有句柄的
 * App 白等（cr-func 第 2 轮 P2-7）。判据因此是「任一 app 有句柄即用」，一个都没有才
 * 区分 `absent`（没人暴露端口）与 `unavailable`（暴露了但全回 null）。
 */
function readInstalledStorage(context: ZCodeProtocolAgentServerContext): InstalledStorage {
  let sawPort = false;
  for (const record of context.sessions.values()) {
    const getStorage = record.app?.getMagicContextStorage;
    if (typeof getStorage !== "function") continue;
    sawPort = true;
    const handle = getStorage();
    if (handle === null || handle === undefined) continue;
    // 端口形状是不透明的 `{ db: unknown }`（宿主保留文件不能 `import type` 被删的包）；
    // 包在场时这里窄回真实签名——这是刻意的边界转换，见 types.ts 的同名说明。
    return { state: "installed", db: handle.db as MagicContextDatabase };
  }
  return sawPort ? { state: "unavailable" } : { state: "absent" };
}

/**
 * 端口门：`absent` 只有显式 `allowDirectOpen` 才放行到自开库，其余一律 blocked。
 *
 * 返回 `{ db }` 表示「装配层已交付句柄，直接用」；`{ directOpen: true }` 表示
 * 「直构夹具显式要求自开库」；否则 blocked，并给出可落日志的原因。
 */
function classifyStorageGate(
  installed: InstalledStorage,
  dependencies: MagicContextMemoriesDependencies,
):
  | { state: "installed"; db: MagicContextDatabase }
  | { state: "direct-open" }
  | { state: "blocked"; reason: "storage-not-installed" | "no-app-port" } {
  if (installed.state === "installed") return { state: "installed", db: installed.db };
  if (installed.state === "unavailable") {
    return { state: "blocked", reason: "storage-not-installed" };
  }
  return dependencies.allowDirectOpen === true
    ? { state: "direct-open" }
    : { state: "blocked", reason: "no-app-port" };
}

/** blocked 的可读说明（list 落 warn、archive 拼协议错误都用这一份措辞）。 */
function describeBlockedStorage(reason: "storage-not-installed" | "no-app-port"): string {
  return reason === "storage-not-installed"
    ? "no app exposes a magic-context storage handle (assembly absent / db_null / import failed)"
    : "no app exposes getMagicContextStorage (workspace-level RPC with zero live sessions: cold start or all sessions closed)";
}

/** 非正常可用态的列表信封（不改 DB、不落盘）。 */
function unavailableListResult(
  workspace: ZCodeWorkspaceListMagicContextMemoriesParams["workspace"],
  reason: "disabled" | "unavailable",
): ZCodeWorkspaceListMagicContextMemoriesResult {
  return zcodeWorkspaceListMagicContextMemoriesResultSchema.parse({
    workspace,
    supported: true,
    available: false,
    reason,
    entries: [],
    counts: { ...ZERO_MEMORY_COUNTS },
    truncated: false,
    total: 0,
  });
}

/**
 * 从 `metadata_json` 提 `archive_reason`（D5 的存储位置）。坏 JSON / 非字符串 /
 * 空串一律视为没有 reason——面板不展示半截元数据。
 */
function readArchiveReason(metadataJson: string | null): string | undefined {
  if (metadataJson === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const reason = (parsed as Record<string, unknown>).archive_reason;
    return typeof reason === "string" && reason.length > 0 ? reason : undefined;
  } catch {
    return undefined;
  }
}

/** `memories` 行的管理视图投影（wire entry；COLUMN_MAP 直通 + metadata 提 reason）。 */
function toWireEntry(memory: Memory) {
  const archiveReason = readArchiveReason(memory.metadataJson);
  return {
    id: memory.id,
    category: memory.category,
    content: memory.content,
    importance: memory.importance,
    status: memory.status,
    seenCount: memory.seenCount,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    expiresAt: memory.expiresAt,
    ...(archiveReason === undefined ? {} : { archiveReason }),
    supersededByMemoryId: memory.supersededByMemoryId,
  };
}

/**
 * `workspace/listMagicContextMemories`：列取当前项目的 magic-context 项目记忆。
 *
 * 失败形态收敛（spec D6）：effective 门关着 → `reason:"disabled"`；开库打不开或
 * 身份解析不出 → `reason:"unavailable"`。两者都不建库不落盘。
 */
export async function listMagicContextMemories(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: MagicContextMemoriesDependencies = {},
): Promise<ZCodeWorkspaceListMagicContextMemoriesResult> {
  const params = parseParams(zcodeWorkspaceListMagicContextMemoriesParamsSchema, rawParams);
  const configPath = dependencies.configPath ?? getDefaultConfigPath();

  // ① effective 门：关着时连 openDatabase 都不发生（「关掉不建库」纪律）。
  // 惰性取 schema 失败（包缺失 / 子路径被改坏）也收敛成 unavailable 信封：
  // list 的结果信封承载得了「打不开」，绝不把这类失败冒泡成 -32603（T-MC5）。
  let disabled: boolean;
  try {
    disabled = await isMagicContextDisabled(context, configPath);
  } catch (error) {
    context.logger?.warn("magicContext memories list: config schema unavailable", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }
  if (disabled) {
    return unavailableListResult(params.workspace, "disabled");
  }

  // ①-b 装配层的库句柄（spec W2 / 变更点 #11）。**必须排在 barrel 加载之前**：端口
  // 缺席或全回 null 时连业务符号都不需要（直接回 unavailable 信封），也就不会有任何
  // openDatabase → 不会创建/迁移库。`absent` 同样拦在这里（cr-func P1-2）：它是生产
  // 可达的（workspace 级 RPC + 零 session），只有显式 `allowDirectOpen` 的直构夹具才
  // 放行到自开库。
  const gate = classifyStorageGate(readInstalledStorage(context), dependencies);
  if (gate.state === "blocked") {
    context.logger?.warn("magicContext memories list: storage not installed", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail: describeBlockedStorage(gate.reason),
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }

  // ①-c 业务符号（barrel）惰性加载。放在门之后：关着时连 barrel 都不碰。
  let magicContext: MagicContextModule;
  try {
    magicContext = await resolveMagicContextRuntime(dependencies);
  } catch (error) {
    context.logger?.warn("magicContext memories list: package unavailable", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }

  // ② 开库。抛（busy/瞬时）与 null（fence/pending）都收敛成 unavailable——列表
  // 有信封承载「打不开」，不需要把瞬时故障冒泡成 RPC 错误。
  //
  // 生产路径用装配层交付的句柄（同一个进程级单例，不开第二条连接、**不会创建库**）；
  // 只有显式 `allowDirectOpen` 的直构夹具才落到自开库（`gate.state === "direct-open"`）。
  let db: ReturnType<MagicContextModule["openDatabase"]>;
  try {
    db = gate.state === "installed" ? gate.db : initializeAndOpenDatabase(magicContext);
  } catch (error) {
    context.logger?.warn("magicContext memories list: storage open failed", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }
  if (!db) {
    context.logger?.warn("magicContext memories list: storage unavailable", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail: "openDatabase returned null (schema fence / pending migration)",
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }

  // ③ 项目身份：与写入/检索同一空间（git: 身份或缺省 dir: 身份），不做第二份推导。
  const projectIdentity = magicContext.resolveProjectIdentityForSession(
    params.workspace.workspacePath,
  );
  if (!projectIdentity) {
    context.logger?.warn("magicContext memories list: project identity unresolved", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail:
        "resolveProjectIdentityForSession returned undefined (home project / git identity paused)",
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }

  // ④ 管理视图列表 + 汇总计数（两函数各自口径；面板以列表为准）。
  const memories = magicContext.listProjectMemoriesForAdmin(db, projectIdentity);
  const counts = magicContext.getProjectMemoryCountsForAdmin(db, projectIdentity);

  // ⑤ category 过滤（CLI 侧，string 全等；未知分类 → 空列表而不是报错，词表
  // 增删只影响过滤，不影响整表读取）。
  const filtered =
    params.category === undefined
      ? memories
      : memories.filter((memory) => memory.category === params.category);

  // ⑥ offset/limit 分页；truncated = 本页之后还有未返回的条目。
  const offset = params.offset ?? 0;
  const page = filtered.slice(offset, offset + params.limit);
  const truncated = offset + page.length < filtered.length;

  const result = zcodeWorkspaceListMagicContextMemoriesResultSchema.parse({
    workspace: params.workspace,
    supported: true,
    available: true,
    entries: page.map(toWireEntry),
    counts: {
      total: counts.total,
      active: counts.active,
      permanent: counts.permanent,
      archived: counts.archived,
      merged: counts.merged,
    },
    truncated,
    total: filtered.length,
  });
  context.logger?.info("magicContext memories listed", {
    module: "bootstrap.zcode_protocol",
    event: "zcode_protocol.magic_context.memories_listed",
    workspaceKey: params.workspace.workspaceKey,
    entryCount: page.length,
    filteredCount: filtered.length,
    truncated,
  });
  return result;
}

/**
 * `workspace/archiveMagicContextMemories`：批量废弃（软删）当前项目的记忆。
 *
 * 逐 id outcome 直通组合函数四值枚举；`rejectionReason` 不进 wire（映射时丢弃）。
 */
export async function archiveMagicContextMemories(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: MagicContextMemoriesDependencies = {},
): Promise<ZCodeWorkspaceArchiveMagicContextMemoriesResult> {
  const params = parseParams(zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema, rawParams);
  const configPath = dependencies.configPath ?? getDefaultConfigPath();

  // ① effective 门：关着时反射式拒绝，不开库（信封无 available 位，静默零值
  // outcomes 会被 UI 读成「什么都没发生」）。
  // 惰性取 schema / 业务符号失败同样只能抛可读错误：本方法的信封没有 available 位，
  // 回空 outcomes 等于把「包不在」伪装成「没有可废弃的记忆」（T-MC5 的 archive 侧）。
  let disabled: boolean;
  try {
    disabled = await isMagicContextDisabled(context, configPath);
  } catch (error) {
    throw new ProtocolRequestError(
      -32010,
      `Magic Context configuration is unavailable (${error instanceof Error ? error.message : String(error)}); memories cannot be archived.`,
    );
  }
  if (disabled) {
    throw new ProtocolRequestError(
      -32010,
      "Magic Context is disabled (magicContext.enabled=false); enable it in Settings before archiving memories.",
    );
  }

  // ①-b 装配层的库句柄（spec W2 / 变更点 #11）：端口缺席或全回 null → 可读错误，
  // **不自开库**（归档是写路径，在装配缺席时更没有理由替它把库造出来）。`absent` 同样
  // 拦在这里（cr-func P1-2）：生产可达，不是夹具形态。
  const gate = classifyStorageGate(readInstalledStorage(context), dependencies);
  if (gate.state === "blocked") {
    throw new ProtocolRequestError(
      -32010,
      `Magic Context storage is not installed in this app (${describeBlockedStorage(gate.reason)}); memories cannot be archived.`,
    );
  }

  // ①-b 业务符号（barrel）惰性加载。
  let magicContext: MagicContextModule;
  try {
    magicContext = await resolveMagicContextRuntime(dependencies);
  } catch (error) {
    throw new ProtocolRequestError(
      -32010,
      `Magic Context is not installed in this build (${error instanceof Error ? error.message : String(error)}); memories cannot be archived.`,
    );
  }

  // ② 开库。throw 原文透传（services 的 BUSY 可重试转译按 message 匹配）；
  // null 是确定性打不开，给可读错误。生产路径走装配层句柄（不创建库）。
  let db: ReturnType<MagicContextModule["openDatabase"]>;
  try {
    db = gate.state === "installed" ? gate.db : initializeAndOpenDatabase(magicContext);
  } catch (error) {
    context.logger?.warn("magicContext memories archive: storage open failed", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_archive_failed",
      detail: error instanceof Error ? error.message : String(error),
      workspaceKey: params.workspace.workspaceKey,
    });
    throw error;
  }
  if (!db) {
    throw new ProtocolRequestError(
      -32010,
      "Magic Context storage is unavailable right now; memories cannot be archived.",
    );
  }

  // ③ 项目身份：解析不出时 fail-visible（回空 outcomes 会误导「废弃成功/不存在」）。
  const projectIdentity = magicContext.resolveProjectIdentityForSession(
    params.workspace.workspacePath,
  );
  if (!projectIdentity) {
    throw new ProtocolRequestError(
      -32010,
      `Memory features are paused for ${params.workspace.workspacePath} (no usable project identity); memories cannot be archived.`,
    );
  }

  // ④ 组合函数（单事务成对写）；authority 拒绝转可读消息，其余错误原文透传。
  try {
    const outcomes = magicContext.archiveProjectMemories(
      db,
      projectIdentity,
      params.memoryIds,
      params.reason,
    );
    context.logger?.info("magicContext memories archived", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_archived",
      workspaceKey: params.workspace.workspaceKey,
      requestedCount: params.memoryIds.length,
      archivedCount: outcomes.filter((entry) => entry.outcome === "archived").length,
      outcomeCount: outcomes.length,
    });
    return zcodeWorkspaceArchiveMagicContextMemoriesResultSchema.parse({
      workspace: params.workspace,
      // rejectionReason 是工具面选文案用的子因，不进 wire（spec 变更点 5 的枚举注释）。
      outcomes: outcomes.map((entry) => ({
        id: entry.id,
        outcome: entry.outcome,
        message: entry.message,
      })),
    });
  } catch (error) {
    if (isModuleMemoryAuthorityError(error)) {
      const authorityCode =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "MEMORY_MODULE_AUTHORITY";
      throw new ProtocolRequestError(
        -32010,
        `Memory archives for this project are managed by the memory module (${authorityCode}); refusing the TypeScript-side archive.`,
      );
    }
    throw error;
  }
}
