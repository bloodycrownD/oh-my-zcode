/**
 * turnNavigator helpers 的单测（Step 7 滚动 O(N) 消除）。
 *
 * 覆盖两件事：
 * 1. `resolveConversationTurnNavigatorActiveUnitIndex` 传入预计算的
 *    `itemByUnitIndex` 与不传（函数内自建）结果完全一致——保证优化不改变语义；
 * 2. 滚动触发量化（`Math.floor(scrollOffsetPx / DEFAULT_ROW_HEIGHT_ESTIMATE_PX)`）
 *    的边界：同一量化桶内 active 结果稳定，跨桶才可能变。
 *
 * 可测性前置：本文件只走相对路径导入，`conversationTurnNavigatorHelpers.ts` 的
 * `@/v4/conversationTurnRenderUnits.js` 是 type-only 导入（编译期剥离），
 * 因此传递依赖链零 `@/`。**不要在本文件引入 `@/`。**
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConversationTurnNavigatorQueryPositions,
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
  type ConversationTurnNavigatorItem,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "../src/v4/conversationTurnNavigatorHelpers.js";
import { DEFAULT_ROW_HEIGHT_ESTIMATE_PX } from "../src/v4/timelineRowHeightCache.js";

function makeItem(unitIndex: number, queryIndex = 0): ConversationTurnNavigatorItem {
  return {
    key: `unit-${unitIndex}:query-${queryIndex}`,
    turnId: `turn-${unitIndex}`,
    unitIndex,
    rowId: unitIndex * 10 + queryIndex,
    userPreview: `u${unitIndex}`,
    assistantPreview: `a${unitIndex}`,
    assistantPreviewKind: "text",
    isRunning: false,
  };
}

/** 同一 turn 可能有多个 query（目录按 query 拆项），unitIndex 会重复。 */
function makeItems(): ConversationTurnNavigatorItem[] {
  return [makeItem(0, 0), makeItem(0, 1), makeItem(1, 0), makeItem(2, 0), makeItem(3, 0)];
}

function makeVirtualItems(rowHeight = 100): ConversationTurnNavigatorVirtualItem[] {
  return [0, 1, 2, 3].map((index) => ({
    index,
    start: index * rowHeight,
    size: rowHeight,
  }));
}

test("传 itemByUnitIndex 与不传结果一致（已加载区间主循环）", () => {
  const items = makeItems();
  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  const virtualItems = makeVirtualItems();

  for (const scrollOffsetPx of [0, 50, 100, 199, 200, 250, 305, 400]) {
    for (const viewportHeightPx of [1, 200, 600]) {
      const withIndex = resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        itemByUnitIndex,
        virtualItems,
        scrollOffsetPx,
        viewportHeightPx,
      });
      const withoutIndex = resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        virtualItems,
        scrollOffsetPx,
        viewportHeightPx,
      });
      assert.equal(withIndex, withoutIndex, `offset=${scrollOffsetPx} height=${viewportHeightPx}`);
    }
  }
});

test("传 itemByUnitIndex 与不传结果一致（topVirtualIndex 兜底链）", () => {
  const items = makeItems();
  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  // unit 2 未挂载（虚拟行缺失），走 items.find/findLast 兜底分支。
  const virtualItems = makeVirtualItems().filter((item) => item.index !== 2);
  // 视口完全落在所有已挂载行之外，走 `items[0]` 兜底。
  const farAwayVirtualItems = makeVirtualItems().map((item) => ({
    index: item.index,
    start: item.start + 10_000,
    size: item.size,
  }));

  for (const list of [virtualItems, farAwayVirtualItems]) {
    for (const scrollOffsetPx of [0, 150, 250, 10_100]) {
      assert.equal(
        resolveConversationTurnNavigatorActiveUnitIndex({
          items,
          itemByUnitIndex,
          virtualItems: list,
          scrollOffsetPx,
          viewportHeightPx: 120,
        }),
        resolveConversationTurnNavigatorActiveUnitIndex({
          items,
          virtualItems: list,
          scrollOffsetPx,
          viewportHeightPx: 120,
        }),
      );
    }
  }
});

test("空 items 时返回 undefined（传/不传一致）", () => {
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items: [],
      virtualItems: makeVirtualItems(),
      scrollOffsetPx: 0,
      viewportHeightPx: 200,
    }),
    undefined,
  );
  assert.equal(
    resolveConversationTurnNavigatorActiveUnitIndex({
      items: [],
      itemByUnitIndex: new Map(),
      virtualItems: makeVirtualItems(),
      scrollOffsetPx: 0,
      viewportHeightPx: 200,
    }),
    undefined,
  );
});

test("量化边界：桶内稳定，跨桶才可能切换（量化单位 = 主时间线行高 72）", () => {
  assert.equal(DEFAULT_ROW_HEIGHT_ESTIMATE_PX, 72);
  const items = makeItems();
  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE_PX;
  const virtualItems = [0, 1, 2, 3].map((index) => ({
    index,
    start: index * rowHeight,
    size: rowHeight,
  }));

  const resolveQuantized = (scrollOffsetPx: number) => {
    const bucket = Math.floor(Math.max(0, scrollOffsetPx) / DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
    return {
      bucket,
      // 量化后的偏移入参：与 deps 口径一致，同桶内不抖动。
      activeUnitIndex: resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        itemByUnitIndex,
        virtualItems,
        scrollOffsetPx: bucket * DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
        viewportHeightPx: rowHeight,
      }),
    };
  };

  // 桶边界：0..71 → 桶 0，72..143 → 桶 1，144 → 桶 2。
  assert.equal(resolveQuantized(0).bucket, 0);
  assert.equal(resolveQuantized(71).bucket, 0);
  assert.equal(resolveQuantized(72).bucket, 1);
  assert.equal(resolveQuantized(143).bucket, 1);
  assert.equal(resolveQuantized(144).bucket, 2);

  // 核心性质：同一个量化桶内，任意像素偏移都得到同一 active —— 组件侧
  // useMemo 以量化值为依赖，因此滚动期间确实只在跨行时重算。
  const perBucket = new Map<number, number | undefined>();
  for (let offset = 0; offset <= 288; offset += 1) {
    const { bucket, activeUnitIndex } = resolveQuantized(offset);
    const seen = perBucket.get(bucket);
    if (seen === undefined && !perBucket.has(bucket)) {
      perBucket.set(bucket, activeUnitIndex);
    }
    assert.equal(activeUnitIndex, perBucket.get(bucket), `桶 ${bucket} 内 offset=${offset} 抖动`);
  }

  // 桶随滚动单调推进，active 不回退。
  let previous = -1;
  for (let bucket = 0; bucket <= 4; bucket += 1) {
    const active = perBucket.get(bucket);
    assert.ok(active !== undefined, `桶 ${bucket} 无结果`);
    assert.ok(active >= previous, `桶 ${bucket} active 回退：${active} < ${previous}`);
    previous = active;
  }
  // 视口推到末尾后仍能落到最后一个 unit（不被量化卡在中间）。
  assert.equal(perBucket.get(4), 3);
});

test("量化与原始 offset 的偏差不超过一行（且行高量级对齐时完全一致）", () => {
  const items = makeItems();
  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE_PX;
  const virtualItems = [0, 1, 2, 3].map((index) => ({
    index,
    start: index * rowHeight,
    size: rowHeight,
  }));

  const resolveRaw = (scrollOffsetPx: number) =>
    resolveConversationTurnNavigatorActiveUnitIndex({
      items,
      itemByUnitIndex,
      virtualItems,
      scrollOffsetPx,
      viewportHeightPx: rowHeight,
    });

  for (let scrollOffsetPx = 0; scrollOffsetPx <= 288; scrollOffsetPx += 1) {
    const bucket = Math.floor(scrollOffsetPx / DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
    const raw = resolveRaw(scrollOffsetPx);
    const quantized = resolveRaw(bucket * DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
    assert.ok(raw !== undefined && quantized !== undefined);
    // 量化把偏移对齐到桶起点，视觉上最多差一行，不改变 active 的量级与单调性。
    assert.ok(
      Math.abs(raw - quantized) <= 1,
      `offset=${scrollOffsetPx} 偏差过大：raw=${raw} quantized=${quantized}`,
    );
  }

  // 行高量级对齐时，桶起点与原始偏移结果完全一致。
  for (const scrollOffsetPx of [0, 72, 144, 216, 288]) {
    assert.equal(resolveRaw(scrollOffsetPx), resolveRaw(scrollOffsetPx - (scrollOffsetPx % 72)));
  }
});

test("ActiveQueryRowId：传 normalizedPositions 与不传结果一致", () => {
  const positions: ConversationTurnNavigatorQueryPosition[] = [
    { rowId: 30, start: 200, end: 260 },
    { rowId: 10, start: 0, end: 80 },
    { rowId: 20, start: 90, end: 150 },
    // 边界：非有限/负值需夹取，验证归一化口径一致。
    { rowId: 40, start: -50, end: 10 },
  ];
  const normalizedPositions = normalizeConversationTurnNavigatorQueryPositions(positions);

  for (const scrollOffsetPx of [0, 95, 210, 500]) {
    for (const viewportHeightPx of [1, 120, 600]) {
      assert.equal(
        resolveConversationTurnNavigatorActiveQueryRowId({
          positions,
          normalizedPositions,
          scrollOffsetPx,
          viewportHeightPx,
        }),
        resolveConversationTurnNavigatorActiveQueryRowId({
          positions,
          scrollOffsetPx,
          viewportHeightPx,
        }),
        `offset=${scrollOffsetPx} height=${viewportHeightPx}`,
      );
    }
  }
  assert.equal(
    resolveConversationTurnNavigatorActiveQueryRowId({
      positions: [],
      scrollOffsetPx: 0,
      viewportHeightPx: 200,
    }),
    undefined,
  );
});
