import { z } from "zod";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";

/**
 * FORK：magic-context 的协议契约单独成文件。
 *
 * 为什么不留在 `zcode-protocol/index.ts`：那个文件是上游 ZCode 的协议契约，
 * 跟随上游升级时整段被改写的概率很高。magic-context 的四个 workspace RPC
 * （update/read config、list/archive memories）是本 fork 自有的管理面，上游
 * 完全没有对应物——把它们夹在上游 schema 中间，等于在每次升级时都制造一块
 * 只能人工逐段解的冲突。搬到本文件后，`index.ts` 里只剩一行 re-export。
 *
 * 依赖纪律：本文件只依赖 `../zcode-protocol-legacy-types.js` 的
 * `zcodeWorkspaceRefSchema`（信封的统一 workspace 引用形状）与 zod，不反向依赖
 * `index.ts`，避免循环。
 */

/** 与 `zcode-protocol/index.ts` 同形的本地非空字符串（该 helper 未导出）。 */
const nonEmptyString = z.string().trim().min(1);

/**
 * FORK（S23 / D-12）：`magicContext` 参数域的整域覆盖请求。
 *
 * 协议层**不声明**这个域的结构——它的权威 schema 是
 * `@zcode/magic-context` 的 `MagicContextConfigSchema`，而 `@zcode/shared` 是包的
 * 下游（包依赖 shared），在这里复制字段表就是第二份真相。信封只保证「是个 JSON
 * 值」，字段级校验放在 CLI 侧 handler（`magic-context-config.ts`），失败以
 * `-32602 Invalid params` 结构化返回。
 *
 * 传整域而非 partial：schema 的 `.default()` 保证一次 parse 就产出完整域，写盘与
 * `configPort.set` 因此都是整域替换，不会出现「这次保存只改了阈值，下次读却把
 * 上次的 historian 抹掉」的部分覆盖。
 *
 * `config` 的两种「空」由**两层**分别拦住（zod 4.6.5 实测结论）：
 *
 *   1. **键缺席** —— `z.unknown()` 在 zod 4 里是 nonoptional 的（不是 zod 3 的
 *      「可缺席」语义），所以 `{ workspace }` 直接被 object 层判 `invalid_type`
 *      拒绝，根本进不到下面的 refine。
 *   2. **值为空**（`config: null` / `config: undefined`）—— 键存在、值为空，
 *      在 JSON-RPC 线上完全合法，会一路穿过 `.strict()`。这才是静默重置整域的
 *      真实入口：handler 若 `?? {}` 兜底，就把空值当成「保存一份全默认域」写盘 +
 *      fan-out + 回 `applied:true`，用户一次调用丢掉整份配置却毫无提示。因此
 *      在信封层用 refine 硬拒，且**不用 `.default()` / `.catch()`** —— 那两个
 *      恰恰会把空值重新变回合法入参。
 */
export const zcodeWorkspaceUpdateMagicContextConfigParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    config: z.unknown(),
  })
  .strict()
  .refine((params) => params.config !== undefined && params.config !== null, {
    message: "config is required and must not be null: 整域替换，缺席或空值等于重置",
    path: ["config"],
  });
export type ZCodeWorkspaceUpdateMagicContextConfigParams = z.infer<
  typeof zcodeWorkspaceUpdateMagicContextConfigParamsSchema
>;

export const zcodeWorkspaceUpdateMagicContextConfigResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 写盘目标（用户级 config.json）；CLI 单进程多 workspace 时用于 UI 展示。 */
    path: nonEmptyString,
    /** 内容是否真的变了（幂等重写为 false）。 */
    changed: z.boolean(),
    /**
     * ConfigPort 已接受的域版本（digest 语义由 CLI 侧定义）。UI 用它确认
     * 「写盘 → 内存」两段都走完了，而不是只看到 RPC 成功就当生效。
     */
    applied: z.literal(true),
    /**
     * FORK（Step 29 / D-12）：**写盘并推入内存后的 effective 域**——即
     * `MagicContextConfigSchema` 规范化（补齐 `.default()`、剥掉 `compaction`
     * 等未移植键）之后、写进 config.json 的那一个对象，UI 表单据此回填，不必
     * 自己再猜一遍 schema 行为。与 params 一样只声明「是个 JSON 值」：字段表
     * 仍然只有包里那一份。
     *
     * 为什么必须是 effective 而不是回显 params：S23 的语义是**整域覆盖**，
     * 调用方漏传一个可选字段就等于把它重置成默认值。回显 params 会让 UI 在
     * 一次成功保存后展示与内存不一致的表单状态。
     */
    config: z.unknown(),
  })
  .strict();
export type ZCodeWorkspaceUpdateMagicContextConfigResult = z.infer<
  typeof zcodeWorkspaceUpdateMagicContextConfigResultSchema
>;

/**
 * FORK（Step 29 / D-12）：读回 `magicContext` 参数域，供设置分区渲染表单初值。
 *
 * 与 update 成对存在的理由：update 是整域覆盖（见上），UI 必须在发请求**之前**
 * 读一次现值再合并，否则第一次保存就会把用户手写的其余字段清成默认值。
 *
 * 同样不在协议层声明字段结构——权威 schema 只有包里那一份。
 */
export const zcodeWorkspaceReadMagicContextConfigParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();
export type ZCodeWorkspaceReadMagicContextConfigParams = z.infer<
  typeof zcodeWorkspaceReadMagicContextConfigParamsSchema
>;

export const zcodeWorkspaceReadMagicContextConfigResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 读盘路径（用户级 config.json）；与 update result 的 `path` 同一语义。 */
    path: nonEmptyString,
    /**
     * effective 域：ConfigPort 里运行时真正在用的值（没有活动 session 时退回
     * 直接读文件 + schema parse）。与 update result 的 `config` 同构，UI 可以
     * 用同一个类型接住两边。
     */
    config: z.unknown(),
  })
  .strict();
export type ZCodeWorkspaceReadMagicContextConfigResult = z.infer<
  typeof zcodeWorkspaceReadMagicContextConfigResultSchema
>;

/**
 * FORK（magic-context-memory-management / 变更点 5 · Step 4）：设置页「记忆」分区
 * 管理面板的 workspace RPC——列取当前项目的 magic-context 跨会话项目记忆。
 *
 * 这是 fork 自有的管理面（上游没有对应 RPC）：数据源是 magic-context 的 SQLite
 * `memories` 表；原生文件式工作区记忆（`appSettings.memoryEnabled` 那条线）本轮
 * UI 退场、协议字段保留，与本对方法无关。
 *
 * 四处手工对齐（spec 变更点 5；本节点只落 ①②，③④ 是后续节点的交付物——改动任一处
 * 时必须同步检查全部四处）：
 *   ① schema 导出——本文件（本对 + 下方 archive 对）；
 *   ② 方法名表——`index.ts` 的 `zcodeProtocolMethods.workspaceListMagicContextMemories` /
 *      `workspaceArchiveMagicContextMemories`；
 *   ③ CLI switch case——Step 6：`bootstrap/src/zcode-protocol/server.ts` dispatch +
 *      新 handler `bootstrap/src/zcode-protocol/magic-context-memories.ts`；
 *   ④ services 方法——Step 5：`packages/services/src/zcode-agent/zcodeAgent.ts` /
 *      `zcodeAgentService.ts`。
 *
 * 降级语义（spec D6）：旧 CLI 回 -32601 时由 services 合成 `supported:false` 的
 * 零值结果；magicContext 关闭 / 库打不开时 CLI 回 `available:false` + `reason`
 * （不建库不落盘），面板走占位态。
 *
 * `category` 过滤由 CLI handler（Step 6）施加——host 层列表薄封装不接收该参数；
 * 协议层不复刻分类词表（权威在 magic-context 包 `memory/types.ts` 的
 * `MemoryCategory`，12 值 accept-both：v2 五类 + legacy 九类，重叠
 * CONSTRAINTS/NAMING 去重后唯一值 12）。
 */
export const zcodeWorkspaceListMagicContextMemoriesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    category: z.string().optional(),
    /** 单次拉取上限；CLI host（bootstrap handler）按同值截断，被截断时 result.truncated=true。 */
    limit: z.number().int().positive().max(200).default(200),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeWorkspaceListMagicContextMemoriesParams = z.infer<
  typeof zcodeWorkspaceListMagicContextMemoriesParamsSchema
>;

/**
 * 条目字段是 `memories` 行的管理视图投影（host 层 `toMemory` 产物）：
 *
 * - `category` / `status` 以字符串过线：存储读边界（`isMemoryRow`）已保证落在
 *   `MemoryCategory`（12 值，v2 五类 + legacy 九类去重）/ `MemoryStatus`（active|permanent|archived）域内；
 *   协议层不复刻词表，上游新增分类时不至于整表 parse 失败。
 * - `expiresAt` 可为 NULL（无 TTL 类目，promotion.ts:60-63 的写入侧只产 null 或
 *   now+ttl）——列表 SQL 的 `expires_at IS NULL` 行照常回，协议层必须接受 null。
 * - `archiveReason` 从 `metadata_json.archive_reason` 提出（spec D5：reason 存
 *   metadata，mutation 行只记 mutation_type）；缺席＝无 reason。
 * - `supersededByMemoryId` 非空＝被后继记忆合并取代（merged）行——写路径把它们的
 *   status 也置 'archived'，故 merged 行同样进列表，徽章展示用本字段区分。
 */
const zcodeMagicContextMemoryEntrySchema = z
  .object({
    id: z.number().int(),
    category: z.string(),
    content: z.string(),
    importance: z.number(),
    status: z.string(),
    seenCount: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    expiresAt: z.number().nullable(),
    archiveReason: z.string().optional(),
    supersededByMemoryId: z.number().int().nullable(),
  })
  .strict();

export const zcodeWorkspaceListMagicContextMemoriesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 旧 CLI 不支持该方法时为 false（services 侧按 -32601 合成的降级标记；缺省 true）。 */
    supported: z.boolean().default(true),
    /** magicContext 关闭 / 库打不开 → false（零值条目，不建库不落盘）。 */
    available: z.boolean(),
    /** available=false 的原因："disabled" | "unavailable"；旧 CLI 降级时 services 另用 "unsupported"（UI 以 supported:false 为主判据）。供 UI 占位文案。 */
    reason: z.string().optional(),
    entries: z.array(zcodeMagicContextMemoryEntrySchema),
    /**
     * 汇总计数（`getMemoryCountsByStatus` 口径）：merged 行归 merged 桶、不进
     * archived 桶，且无过期过滤——与列表口径存在登记在案的差（spec 兼容性节），
     * 面板以列表为准、counts 仅作汇总参考。
     */
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        permanent: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
        merged: z.number().int().nonnegative(),
      })
      .strict(),
    /** limit/offset 截断标记：本页之后该项目还有未返回的条目。 */
    truncated: z.boolean(),
    /**
     * 当前过滤条件（category）命中后的集合总数（session-memory-and-context P1 返工）：
     * 与 counts.total（全项目口径）刻意分开——页码计算以本字段为准；available=false
     * 的降级信封恒为 0。
     */
    total: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceListMagicContextMemoriesResult = z.infer<
  typeof zcodeWorkspaceListMagicContextMemoriesResultSchema
>;

/**
 * FORK（magic-context-memory-management / 变更点 5 · Step 4）：批量废弃（archive
 * 软删）当前项目的 magic-context 记忆。四处手工对齐坐标见上方 list 对注释。
 *
 * `reason` 上限 4096 与工具面契约（变更点 4 的 `CtxMemoryInputSchema.reason`）
 * 一致——UI 按钮与对话内 `ctx_memory action:"archive"` 是同一组合函数的两条入口，
 * 契约上限不允分叉。reason 由 `archiveMemory` trim 后存入
 * `metadata_json.archive_reason`，空串等同不传。
 */
export const zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 目标记忆 id（1..100；host 层按首见序去重后逐条处理）。 */
    memoryIds: z.array(z.number().int()).min(1).max(100),
    reason: z.string().max(4096).optional(),
  })
  .strict();
export type ZCodeWorkspaceArchiveMagicContextMemoriesParams = z.infer<
  typeof zcodeWorkspaceArchiveMagicContextMemoriesParamsSchema
>;

/**
 * 四值枚举 = 组合函数 outcome 单一事实源（`host/memory-admin.ts` 的
 * `archiveProjectMemories`）的直通，不得在别处重新分类：
 *   archived         预验证通过，本次事务内成对写（archiveMemory + mutation 行）
 *   already-archived status=archived 且未 superseded——跳过，不二次写 mutation 行
 *   rejected         ownership 不符或已被 superseded（拒绝子因不进 wire；message
 *                    已按两态给出可读文案：superseded→inactive 风格 / ownership→
 *                    不透明 was not found）
 *   missing          id 不存在
 */
const zcodeMagicContextMemoryArchiveOutcomeSchema = z.enum([
  "archived",
  "already-archived",
  "missing",
  "rejected",
]);

export const zcodeWorkspaceArchiveMagicContextMemoriesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 逐 id 一条（host 组合函数按首见序去重后产出）；message 供 toast 直显。 */
    outcomes: z.array(
      z
        .object({
          id: z.number().int(),
          outcome: zcodeMagicContextMemoryArchiveOutcomeSchema,
          message: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ZCodeWorkspaceArchiveMagicContextMemoriesResult = z.infer<
  typeof zcodeWorkspaceArchiveMagicContextMemoriesResultSchema
>;
