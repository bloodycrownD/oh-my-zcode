// @/-free 下沉模块：conversation projection 的纯逻辑。
//
// 可测性硬约束：被测模块的传递依赖链必须零 `@/` 导入（Node/tsx 下无别名解析），
// 因此这里只允许相对路径与 `@zcode/*` 包导入，不允许 import UI 侧 logger / memoryDiagnostics
// 或任何 React/浏览器全局。后续 accumulator 应用包装与 renderUnits 增量构建器
// 同样写进本文件；conversationProjectionStore.ts 改为 import 并 re-export，
// 保持既有外部引用不破。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * rows/range 结果并入本地窗口（合并规范）：按 rowId 键控、只收
 * 窗口首行之前的行、去重后前插；顺序键 = rowId 升序（全序保证）。
 * 返回 null 表示无可并入行（窗口无变化，调用方不换引用）。
 */
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}
