/**
 * ⑤-5a / mc/A-1：`magic_context.transform_absent` 事件的**唯一生产发射点**。
 *
 * ============================================================================
 * 为什么要有这个 leaf 模块
 * ============================================================================
 *
 * transform **缺席**（不是「跑了但没做事」）时必须留下一条机器可判的事件
 * （logger.warn 级），桌面日志/事件面据此能回答「为什么没有压缩」——⑤ 的本机取证
 * 显示 app-server 进程可以 0 条 transform pass、0 条告警地静默停机。缺席路径有四条：
 *
 *   - `disabled`                    ：装配门 features.magicContext / magicContext.enabled
 *                                    （`create-app.ts` 的 enabled gate）
 *   - `import_failed`               ：`create-app.ts` 动态 import 工厂模块失败
 *   - `db_null:migration_guard`     ：openDatabase 返回 null（迁移被其它活进程挡住）
 *   - `db_null:fence`               ：openDatabase 返回 null（库比本 build 新）
 *   - `db_null:pending_or_unclassified`：openDatabase 返回 null（pending 竞争或未分类）
 *
 * 发射点从工厂内部上收到这里（mc/C-orch-1 单点化）：工厂本模块在 flag 关时**根本不
 * 被加载**（装配门的成本纪律），disabled 事件不可能由它发出；若 create-app 侧另写
 * 一条同形状的 logger.warn，事件名/reason 词表就成了两处重复字面量、无类型约束。
 * 本模块零依赖（连类型都不 import），create-app 静态 import 它没有启动成本。
 *
 * 验收口径：生产发射点（logger event 字段赋值处）只有本文件一处；注释与测试消费侧
 * 的字符串不受此限。
 *
 * 语义边界（fail-closed 契约不受影响，事件只是可观测性）：
 *   - import_failed：发事件后**照旧 throw**（保留 fail-closed 性状）；
 *   - disabled / db_null：发事件后照旧 return undefined 降级；db_null 且
 *     `fail_closed_blocking=true` 时同样**先发事件、再 throw**。
 */

/** 事件名常量：消费面（桌面日志/测试）只看这一个名字。 */
export const MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT = "magic_context.transform_absent";

/**
 * `reason` 取值域。五值与真实发射值逐字一致（`db_null:` 前缀不可省——它是
 * `db_null:<细分>` 词表的一部分，缺了前缀下游就没法按前缀分流）。
 */
export type MagicContextTransformAbsentReason =
  | "disabled"
  | "import_failed"
  | "db_null:migration_guard"
  | "db_null:fence"
  | "db_null:pending_or_unclassified";

/**
 * 只依赖 `warn` 的最小 logger 结构。刻意不 import `@zcode/*` 的 `Logger` 类型：
 * 本模块的卖点就是「零依赖 leaf」，类型图也不该把它和 core 的 logger 契约缠在一起。
 * 方法语法保持参数双向可比，`@zcode/core` 的 `Logger` 可直接代入。
 */
export interface MagicContextTransformAbsentLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** 发射一条 `magic_context.transform_absent`。全仓生产侧唯一调用点在本模块。 */
export function emitMagicContextTransformAbsent(
  logger: MagicContextTransformAbsentLogger,
  reason: MagicContextTransformAbsentReason,
  detail: string,
): void {
  logger.warn("Magic context transform is absent", {
    module: "bootstrap",
    event: MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT,
    reason,
    detail,
  });
}
