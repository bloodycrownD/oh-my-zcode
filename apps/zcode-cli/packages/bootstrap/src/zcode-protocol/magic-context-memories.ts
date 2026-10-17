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
 *   捕获转可读的 ProtocolRequestError（fail-visible，不是降级）。
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
import {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  MagicContextConfigSchema,
  ModuleMemoryAuthorityError,
  archiveProjectMemories,
  getMagicContextDatabasePath,
  getProjectMemoryCountsForAdmin,
  initializeMagicContextHost,
  listProjectMemoriesForAdmin,
  openDatabase,
  resolveProjectIdentityForSession,
  type Memory,
} from "@zcode/magic-context";
import {
  zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema,
  zcodeWorkspaceArchiveMagicContextMemoriesResultSchema,
  zcodeWorkspaceListMagicContextMemoriesParamsSchema,
  zcodeWorkspaceListMagicContextMemoriesResultSchema,
  type ZCodeWorkspaceArchiveMagicContextMemoriesResult,
  type ZCodeWorkspaceListMagicContextMemoriesParams,
  type ZCodeWorkspaceListMagicContextMemoriesResult,
} from "@zcode/shared";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/** 供单测注入的窄缝；生产路径固定为用户级 `~/.omz/cli/config.json`。 */
export interface MagicContextMemoriesDependencies {
  configPath?: string;
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
 */
function isMagicContextDisabled(
  context: ZCodeProtocolAgentServerContext,
  configPath: string,
): boolean {
  for (const record of context.sessions.values()) {
    const configPort = record.app?.getConfigPort?.();
    if (!configPort) continue;
    // ConfigPort 的 MagicContext 域恒有值（注册时把 schema 的 .default() 解析结果
    // 钉进去了），safeParse 是纵深防御而非正常路径。
    return readMagicContextEnabled(configPort.get(ConfigKey.MagicContext)) === false;
  }
  const loaded = loadFileConfig(configPath);
  return readMagicContextEnabled(loaded.config.magicContext) === false;
}

function readMagicContextEnabled(raw: unknown): boolean {
  const parsed = MagicContextConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data.enabled : DEFAULT_MAGIC_CONTEXT_CONFIG.enabled;
}

/**
 * 装载数据库句柄。`initializeMagicContextHost()` 必须在任何 DB 写之前（幂等；
 * 生产路径 create-app 装配层已调过，这里是直构/测试形态的第二保险，与 /ctx-*
 * 命令面的 ensureHostIdentity 同一理由）。
 *
 * 返回 null = 确定性打不开（schema fence / 迁移未完成 / pending 竞争）；
 * throw = busy/瞬时类失败（openDatabase 以 `{ cause }` 保留底层错误，message
 * 逐字可用）。
 */
function initializeAndOpenDatabase(): ReturnType<typeof openDatabase> {
  initializeMagicContextHost();
  return openDatabase(getMagicContextDatabasePath());
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
  if (isMagicContextDisabled(context, configPath)) {
    return unavailableListResult(params.workspace, "disabled");
  }

  // ② 开库。抛（busy/瞬时）与 null（fence/pending）都收敛成 unavailable——列表
  // 有信封承载「打不开」，不需要把瞬时故障冒泡成 RPC 错误。
  let db: ReturnType<typeof openDatabase>;
  try {
    db = initializeAndOpenDatabase();
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
  const projectIdentity = resolveProjectIdentityForSession(params.workspace.workspacePath);
  if (!projectIdentity) {
    context.logger?.warn("magicContext memories list: project identity unresolved", {
      module: "bootstrap.zcode_protocol",
      event: "zcode_protocol.magic_context.memories_unavailable",
      reason: "unavailable",
      detail: "resolveProjectIdentityForSession returned undefined (home project / git identity paused)",
      workspaceKey: params.workspace.workspaceKey,
    });
    return unavailableListResult(params.workspace, "unavailable");
  }

  // ④ 管理视图列表 + 汇总计数（两函数各自口径；面板以列表为准）。
  const memories = listProjectMemoriesForAdmin(db, projectIdentity);
  const counts = getProjectMemoryCountsForAdmin(db, projectIdentity);

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
  if (isMagicContextDisabled(context, configPath)) {
    throw new ProtocolRequestError(
      -32010,
      "Magic Context is disabled (magicContext.enabled=false); enable it in Settings before archiving memories.",
    );
  }

  // ② 开库。throw 原文透传（services 的 BUSY 可重试转译按 message 匹配）；
  // null 是确定性打不开，给可读错误。
  let db: ReturnType<typeof openDatabase>;
  try {
    db = initializeAndOpenDatabase();
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
  const projectIdentity = resolveProjectIdentityForSession(params.workspace.workspacePath);
  if (!projectIdentity) {
    throw new ProtocolRequestError(
      -32010,
      `Memory features are paused for ${params.workspace.workspacePath} (no usable project identity); memories cannot be archived.`,
    );
  }

  // ④ 组合函数（单事务成对写）；authority 拒绝转可读消息，其余错误原文透传。
  try {
    const outcomes = archiveProjectMemories(db, projectIdentity, params.memoryIds, params.reason);
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
    if (error instanceof ModuleMemoryAuthorityError) {
      throw new ProtocolRequestError(
        -32010,
        `Memory archives for this project are managed by the memory module (${error.code}); refusing the TypeScript-side archive.`,
      );
    }
    throw error;
  }
}
