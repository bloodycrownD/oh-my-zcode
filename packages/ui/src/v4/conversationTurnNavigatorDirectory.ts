/**
 * turnNavigator 的「目录 + 已加载」items 合并层（Step 18）。
 *
 * 目录（`v4/conversation/turnDirectory` 的窄投影）与正文窗口是两条解耦的数据源：
 * 目录给全量 realUser query 的概要（按 queryRowId 升序），正文窗口只装已加载的行。
 * rail 要同时呈现「上方还没加载到的历史 query」与「窗口内的实时运行态」，因此
 * items 的数据源必须是两者的合并结果：
 *
 *   - **已加载区间**：用 `buildConversationTurnNavigatorItems` 的现有 items（含
 *     `isRunning` 等实时态、i18n 后的 assistant 摘要）；
 *   - **未加载区间**：用目录项映射的降级 item（key 走目录口径，`assistantPreviewKind`
 *     直传服务端三态；`running` / `empty` 态的文案由客户端 i18n 填，服务端不下发）。
 *
 * 去重键是 queryRowId（等于 item.rowId）：同一条 query 在两侧都会出现，保留已加载侧
 * 的实时 item，目录项只补窗口没有的部分。
 *
 * active 定位降级（`resolveTurnNavigatorActiveItemIndex`）有三条支路：
 * 已加载区间沿用主循环（`resolveConversationTurnNavigatorActiveUnitIndex`），
 * 未加载区间退化为「取第一个未加载目录项」（即窗口之上最早的那条 query，
 * 对应用户滚到已加载窗口上方的极位），混合态（视口跨加载边界）以已加载侧优先。
 *
 * 可测性：本模块**零导入**——不依赖 `@/`、也不依赖 `@zcode/shared`，只吃结构类型，
 * 因此可直接被 `npx tsx --test` 加载（T-TD4）。
 */

export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

/** rail 单条 item 的既有形状（与 helpers 的构建器产物同型，故本模块就地定义权威源）。 */
export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

/**
 * 目录条目的结构视图（与 `@zcode/shared` 的 `TurnDirectoryEntry` 同形）。
 * 这里不 import 协议类型：新模块要保持零导入以便 Node 侧直接加载测试。
 */
export interface ConversationTurnNavigatorDirectoryEntry {
  turnId: string;
  queryRowId: number;
  queryPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
}

/** 合并后的 item：额外标记数据来源，供 active 降级与 QA 观测区分。 */
export interface ConversationTurnNavigatorMergedItem extends ConversationTurnNavigatorItem {
  /** true = 由目录项映射的降级 item（未加载区间，无实时态）。 */
  isDirectoryFallback: boolean;
}

export interface MergeTurnNavigatorItemsOptions {
  /** 目录项落在 `running` 态时的 assistant 摘要（服务端不下发文案，客户端 i18n 填）。 */
  assistantRunningPreview?: string;
  /** 目录项落在 `empty` 态时的 assistant 摘要（同上）。 */
  assistantEmptyPreview?: string;
  /**
   * 目录项 `queryPreview` 为空串时的用户输入摘要兜底文案——与已加载侧
   * `buildConversationTurnNavigatorItems` 的 userFallback 同口径，避免同一条
   * 空白 query 在已加载/未加载两侧显示不一致（cr-fix-spec full/B-4）。
   */
  userFallbackPreview?: string;
}

/**
 * 单条目录项 → 降级 item。
 *
 * `unitIndex` 取**目录序**（调用方传合并后的下标）：未加载区间在虚拟列表里根本没有
 * 对应 unit，这个值只是 rail 上的顺序占位，真正的跳转锚点是 `rowId`（由 Step 19 的
 * 拉取闭环负责）。`key` 用目录口径，避免与已加载侧 `${unit.key}:query:...` 混淆。
 */
export function buildTurnNavigatorDirectoryFallbackItem(
  entry: ConversationTurnNavigatorDirectoryEntry,
  unitIndex: number,
  options: MergeTurnNavigatorItemsOptions = {},
): ConversationTurnNavigatorMergedItem {
  const kind = entry.assistantPreviewKind;
  const assistantPreview =
    kind === "text"
      ? entry.assistantPreview
      : kind === "running"
        ? (options.assistantRunningPreview ?? "")
        : (options.assistantEmptyPreview ?? "");
  return {
    key: `${entry.turnId}:query:${entry.queryRowId}`,
    turnId: entry.turnId,
    unitIndex,
    rowId: entry.queryRowId,
    // 空白 query（服务端下发空串）套与已加载侧同源的 fallback 文案，两侧观感一致。
    userPreview: entry.queryPreview || (options.userFallbackPreview ?? ""),
    assistantPreview,
    assistantPreviewKind: kind,
    // 未加载区间没有 turnHeader 可读；running 态由服务端三态直传，
    // 这样 rail 的运行强调与 hover 卡文案仍然一致。
    isRunning: kind === "running",
    isDirectoryFallback: true,
  };
}

/**
 * 目录 + 已加载 items 合并（去重 + 稳定升序）。
 *
 * - 去重键 `queryRowId`：已加载侧优先（保留实时态与 i18n 文案）；
 * - 落在已加载窗口范围之内（`queryRowId >= windowFirstRowId`）却没有对应 item 的目录项
 *   **直接丢弃**：窗口是那一段的权威数据源，目录条目缺失只说明该 query 被投影规则
 *   排除（如 timelineOnly 分支），补一个降级 item 反而会画出不存在的跳转目标；
 * - `windowFirstRowId` 缺省（正文窗口为空）时，全部目录项都算未加载区间；
 * - 输出按 `rowId` 升序（目录与已加载 items 本身都是这个序），排序稳定：
 *   目录未加载时结果与传入的已加载 items 逐项等价。
 */
export function mergeTurnNavigatorItems(
  directoryEntries: readonly ConversationTurnNavigatorDirectoryEntry[],
  loadedItems: readonly ConversationTurnNavigatorItem[],
  windowFirstRowId: number | undefined,
  options: MergeTurnNavigatorItemsOptions = {},
): ConversationTurnNavigatorMergedItem[] {
  const loadedByRowId = new Map<number, ConversationTurnNavigatorItem>();
  for (const item of loadedItems) {
    loadedByRowId.set(item.rowId, item);
  }

  const merged: ConversationTurnNavigatorMergedItem[] = [];
  const seenRowIds = new Set<number>();

  for (const entry of directoryEntries) {
    // 服务端理论上不会给重复 queryRowId；真给了也只认第一条，避免 rail 出现重键。
    if (seenRowIds.has(entry.queryRowId)) continue;
    seenRowIds.add(entry.queryRowId);
    const loaded = loadedByRowId.get(entry.queryRowId);
    if (loaded !== undefined) {
      merged.push({ ...loaded, isDirectoryFallback: false });
      continue;
    }
    if (windowFirstRowId !== undefined && entry.queryRowId >= windowFirstRowId) continue;
    merged.push(buildTurnNavigatorDirectoryFallbackItem(entry, merged.length, options));
  }

  // 已加载侧可能有目录尚未收录的条目（目录有游标 limit，且尚未取过），
  // 这些不能因为「目录里没有」就丢掉。
  for (const item of loadedItems) {
    if (seenRowIds.has(item.rowId)) continue;
    seenRowIds.add(item.rowId);
    merged.push({ ...item, isDirectoryFallback: false });
  }

  if (merged.length === 0) return merged;
  const sorted = merged.slice().sort((left, right) => left.rowId - right.rowId);
  // 降级项的 unitIndex 在 push 时赋的是插入序，排序后不再等于最终下标；
  // 统一重编号为最终下标（已加载侧 unitIndex 不动）。
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i];
    if (item !== undefined && item.isDirectoryFallback) {
      sorted[i] = { ...item, unitIndex: i };
    }
  }
  return sorted;
}

export interface ResolveTurnNavigatorActiveItemIndexParams {
  /** 合并后的 items（`mergeTurnNavigatorItems` 的产物）。 */
  items: readonly ConversationTurnNavigatorMergedItem[];
  /**
   * 已加载侧主循环给出的活动项在 `items` 中的下标；`undefined` = 视口没落在
   * 任何已加载区间（滚到了窗口之上的未加载区，或正文窗口为空）。
   */
  loadedActiveItemIndex: number | undefined;
  /** 当前窗口首行 rowId（`rows.window[0].rowId`）；`undefined` = 正文窗口为空。 */
  windowFirstRowId: number | undefined;
}

/**
 * active 定位降级三态的统一出口。
 *
 * 1. **已加载区间**（`loadedActiveItemIndex` 有值且无未加载目录项）：直接用主循环结果；
 * 2. **未加载区间**（目录项存在、unit 不存在）：取第一个未加载目录项高亮——items 升序，
 *    「第一个」即窗口之上最早的那条 query，与「滚到最顶」的内容一致；
 * 3. **混合态**（视口跨加载边界）：以已加载侧优先，未加载目录项不夺走高亮。
 *
 * 目录与已加载侧都没有可判定项时返回 `undefined`，由调用方保留既有兜底（index = -1）。
 */
export function resolveTurnNavigatorActiveItemIndex(
  params: ResolveTurnNavigatorActiveItemIndexParams,
): number | undefined {
  // 1/3：已加载侧优先（含混合态跨边界）。
  if (params.loadedActiveItemIndex !== undefined) return params.loadedActiveItemIndex;
  // 2：未加载区——取第一个未加载目录项。
  const firstRowId = params.windowFirstRowId;
  for (let index = 0; index < params.items.length; index += 1) {
    const item = params.items[index];
    if (!item?.isDirectoryFallback) continue;
    if (firstRowId !== undefined && item.rowId >= firstRowId) continue;
    return index;
  }
  return undefined;
}
