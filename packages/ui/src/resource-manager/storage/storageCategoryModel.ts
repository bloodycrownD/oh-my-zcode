/**
 * 资源管理器「存储」tab 的类别合并与清理入口门控：纯 model，零 `@/` 依赖
 * （与 lib/subagentDirectoryCancel、conversationStatusPanelModel 同一可测性约定），
 * 因此 packages/ui/test 下的 node:test 可以直测——tsx 不解析 ui 包的 `@/*` 别名，
 * 带 `@/` 导入的 storageCategoryPresentation.ts 无法进单测。
 *
 * 背景（6c → uix/G-1 r3 收口）：`cli/exec` 是 Bash 合并输出的落盘位置，失控命令
 * 曾把单文件写到 5.13GiB。这段路径从 toolOutputs 整组里单列接进清理入口，但整组
 * 其余成员（artifacts/agents/sessions/缓存）不可删。收口后类别级 cleanability 回
 * 到按表取值（toolOutputs = "none"），「仅 cli/exec 可清理」改由 aggregate 下发的
 * cleanScope="paths" 表达；三处 UI 门控（类别行 / 详情页 / requestClean 守卫）
 * 统一走 isStorageCategoryCleanable，避免各处口径漂移。
 */
import type {
  StorageCategoryCleanScope,
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanability,
  StorageRootUsage,
} from "@zcode/shared";

export interface StorageCategoryTotal {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCategoryUsage["cleanability"];
  /**
   * per-path 覆盖类别（toolOutputs → cli/exec）为 "paths"；其余类别缺省。
   * 透传自 StorageCategoryUsage.cleanScope——漏传则三处门控恒 undefined、
   * cli/exec 的清理入口静默消失。
   */
  cleanScope?: StorageCategoryUsage["cleanScope"];
}

/** 把多个根的同类别占用合并，按 bytes 降序（同为 0 时保持目录顺序）。 */
export function sumCategoriesAcrossRoots(roots: StorageRootUsage[]): StorageCategoryTotal[] {
  const totals = new Map<StorageCategoryId, StorageCategoryTotal>();
  for (const root of roots) {
    for (const category of root.categories) {
      const current = totals.get(category.id);
      if (current) {
        current.bytes += category.bytes;
        current.fileCount += category.fileCount;
        // cleanScope 由 categoryId 派生（hasStorageCleanPathOverride），跨根确定性
        // 一致；这里「取任一非空」只为兼容明细快照缺该字段的旧版本快照。
        if (category.cleanScope) current.cleanScope = category.cleanScope;
      } else {
        totals.set(category.id, toTotal(category));
      }
    }
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes);
}

function toTotal(category: StorageCategoryUsage): StorageCategoryTotal {
  const total: StorageCategoryTotal = {
    id: category.id,
    bytes: category.bytes,
    fileCount: category.fileCount,
    cleanability: category.cleanability,
  };
  if (category.cleanScope) total.cleanScope = category.cleanScope;
  return total;
}

/**
 * 清理入口门控（三处 UI 门控的唯一口径）：
 * - `bytes > 0` 是既有路径的铁门（类别行 :37 与详情页 :72 原本就带；requestClean
 *   守卫原本没有，统一后零占用类别不再出现无意义入口——进去也只有「无可清理」）；
 * - 普通类别在铁门内沿用 cleanability !== "none"（safe/confirm）；
 * - per-path 覆盖类别（cleanScope="paths"，如 toolOutputs 只删 cli/exec）即使
 *   类别级 cleanability 为 none 也放行——这是 r3 收口后 cli/exec 段唯一的入口依据。
 */
export function isStorageCategoryCleanable(category: {
  cleanability: StorageCleanability;
  cleanScope?: StorageCategoryCleanScope;
  bytes: number;
}): boolean {
  return (
    category.bytes > 0 && (category.cleanability !== "none" || category.cleanScope === "paths")
  );
}
