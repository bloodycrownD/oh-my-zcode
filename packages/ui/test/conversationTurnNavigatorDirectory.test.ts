/**
 * turnNavigator 目录合并层的单测（T-TD4 / Step 18）。
 *
 * 覆盖两件事：
 * 1. `mergeTurnNavigatorItems` 的合并语义：按 queryRowId 去重（已加载侧优先）、
 *    输出升序且顺序稳定、目录未加载时与旧实现逐项等价；
 * 2. `resolveTurnNavigatorActiveItemIndex` 的 active 定位降级三态：
 *    已加载区间沿用主循环、未加载区取第一个未加载目录项、混合态以已加载侧优先。
 *
 * 可测性前置：本模块零导入（不依赖 `@/`、也不依赖 `@zcode/shared`），测试只走
 * 相对路径导入即可被 `npx tsx --test` 加载。**不要在本文件引入 `@/`。**
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTurnNavigatorDirectoryFallbackItem,
  classifyTurnNavigatorActiveScope,
  mergeTurnNavigatorItems,
  resolveTurnNavigatorActiveItemIndex,
  type ConversationTurnNavigatorDirectoryEntry,
  type ConversationTurnNavigatorItem,
} from "../src/v4/conversationTurnNavigatorDirectory.js";

function makeEntry(
  queryRowId: number,
  overrides: Partial<ConversationTurnNavigatorDirectoryEntry> = {},
): ConversationTurnNavigatorDirectoryEntry {
  return {
    turnId: `turn-${queryRowId}`,
    queryRowId,
    queryPreview: `q${queryRowId}`,
    assistantPreview: `a${queryRowId}`,
    assistantPreviewKind: "text",
    ...overrides,
  };
}

function makeLoadedItem(
  rowId: number,
  overrides: Partial<ConversationTurnNavigatorItem> = {},
): ConversationTurnNavigatorItem {
  return {
    key: `unit-key:query:${rowId}`,
    turnId: `turn-${rowId}`,
    unitIndex: rowId,
    rowId,
    userPreview: `loaded-q${rowId}`,
    assistantPreview: `loaded-a${rowId}`,
    assistantPreviewKind: "text",
    isRunning: false,
    ...overrides,
  };
}

const I18N = { assistantEmptyPreview: "空", assistantRunningPreview: "进行中" };

test("合并：目录 + 已加载按 queryRowId 去重（已加载侧优先）", () => {
  const entries = [makeEntry(10), makeEntry(20), makeEntry(30), makeEntry(40)];
  // 20 与 30 在窗口内且都已加载（取已加载侧的实时文案）；50 已加载但目录尚未收录。
  const loaded = [makeLoadedItem(20), makeLoadedItem(30), makeLoadedItem(50)];

  const merged = mergeTurnNavigatorItems(entries, loaded, 30, I18N);

  assert.deepEqual(
    merged.map((item) => item.rowId),
    [10, 20, 30, 50],
    "输出必须是 queryRowId 升序的无重复并集（40 落在窗口内却未加载 → 丢弃）",
  );
  const byRowId = new Map(merged.map((item) => [item.rowId, item]));
  // 同一条 query 两侧都有 → 取已加载侧的实时 item（含 isRunning 与 i18n 文案）。
  const overlapped = byRowId.get(20);
  assert.equal(overlapped?.userPreview, "loaded-q20");
  assert.equal(overlapped?.isDirectoryFallback, false);
  // 目录独有且在窗口之上的 → 降级 item。
  const fallback = byRowId.get(10);
  assert.equal(fallback?.isDirectoryFallback, true);
  assert.equal(fallback?.userPreview, "q10");
  // 目录里没有、但窗口已加载的条目不能丢。
  assert.equal(byRowId.get(50)?.userPreview, "loaded-q50");
  assert.equal(byRowId.get(50)?.isDirectoryFallback, false);
});

test("合并：输出顺序稳定（目录未加载时与旧 items 逐项等价）", () => {
  const loaded = [makeLoadedItem(10), makeLoadedItem(20), makeLoadedItem(30)];

  const withoutDirectory = mergeTurnNavigatorItems([], loaded, 10, I18N);
  assert.deepEqual(withoutDirectory, loaded.map((item) => ({ ...item, isDirectoryFallback: false })));

  // 目录已取但条目全部落在窗口内且都已被加载覆盖 → 与纯已加载结果同序。
  const covered = mergeTurnNavigatorItems(
    [makeEntry(10), makeEntry(20), makeEntry(30)],
    loaded,
    10,
    I18N,
  );
  assert.deepEqual(
    covered.map((item) => item.rowId),
    [10, 20, 30],
  );
  // 同一条目重复入参不会让结果抖动。
  const duplicated = mergeTurnNavigatorItems([makeEntry(10), makeEntry(10)], [], undefined, I18N);
  assert.equal(duplicated.length, 1);
});

test("合并：窗口范围内的未命中目录项被丢弃（窗口是那一段的权威源）", () => {
  // 30 不在已加载 items 里，但它落在窗口首行 rowId=20 之后 —— 只能是投影规则排除，
  // 补一个降级 item 会画出并不存在的跳转目标。
  const merged = mergeTurnNavigatorItems([makeEntry(10), makeEntry(30)], [], 20, I18N);
  assert.deepEqual(
    merged.map((item) => item.rowId),
    [10],
  );
  // 窗口为空（windowFirstRowId 缺省）时，全部目录项都算未加载区。
  const noWindow = mergeTurnNavigatorItems([makeEntry(10), makeEntry(30)], [], undefined, I18N);
  assert.deepEqual(
    noWindow.map((item) => item.rowId),
    [10, 30],
  );
});

test("降级 item：key/摘要三态/unitIndex 目录序口径", () => {
  const merged = mergeTurnNavigatorItems(
    [
      makeEntry(10),
      makeEntry(20, { assistantPreviewKind: "running", assistantPreview: "" }),
      makeEntry(30, { assistantPreviewKind: "empty", assistantPreview: "" }),
    ],
    [],
    40,
    I18N,
  );
  assert.deepEqual(
    merged.map((item) => item.key),
    ["turn-10:query:10", "turn-20:query:20", "turn-30:query:30"],
    "降级 item 的 key 走目录口径",
  );
  assert.deepEqual(
    merged.map((item) => item.unitIndex),
    [0, 1, 2],
    "降级 item 的 unitIndex 取目录序",
  );
  // text 态直传服务端摘要；running / empty 态文案由客户端 i18n 填。
  assert.equal(merged[0].assistantPreview, "a10");
  assert.equal(merged[1].assistantPreview, "进行中");
  assert.equal(merged[1].isRunning, true);
  assert.equal(merged[2].assistantPreview, "空");
  assert.equal(merged[2].isRunning, false);
  assert.deepEqual(
    merged.map((item) => item.assistantPreviewKind),
    ["text", "running", "empty"],
    "assistantPreviewKind 直传服务端三态",
  );

  // 单独构造：i18n 兜底缺省时不产出 undefined 文案。
  const bare = buildTurnNavigatorDirectoryFallbackItem(
    makeEntry(99, { assistantPreviewKind: "empty" }),
    0,
  );
  assert.equal(bare.assistantPreview, "");
});

test("active 降级三态：已加载 / 未加载 / 混合（跨边界）", () => {
  // 窗口首行 rowId=30：10 与 20 是未加载目录项，30/40 是已加载项。
  const merged = mergeTurnNavigatorItems(
    [makeEntry(10), makeEntry(20), makeEntry(30), makeEntry(40)],
    [makeLoadedItem(30), makeLoadedItem(40)],
    30,
    I18N,
  );
  assert.deepEqual(
    merged.map((item) => item.rowId),
    [10, 20, 30, 40],
  );

  // 1. 已加载侧命中 → 直接用主循环结果（混合态亦如此：已加载优先）。
  const mixed = resolveTurnNavigatorActiveItemIndex({
    items: merged,
    loadedActiveItemIndex: 3,
    windowFirstRowId: 30,
  });
  assert.equal(mixed, 3, "混合态以已加载侧为准，未加载目录项不夺走高亮");
  assert.equal(classifyTurnNavigatorActiveScope({ items: merged, loadedActiveItemIndex: 3, windowFirstRowId: 30 }), "mixed");

  // 2. 视口落到窗口之上的未加载区 → 取第一个未加载目录项。
  const unloaded = resolveTurnNavigatorActiveItemIndex({
    items: merged,
    loadedActiveItemIndex: undefined,
    windowFirstRowId: 30,
  });
  assert.equal(unloaded, 0, "未加载区高亮第一个未加载目录项（升序最早的那条）");
  assert.equal(
    classifyTurnNavigatorActiveScope({ items: merged, loadedActiveItemIndex: undefined, windowFirstRowId: 30 }),
    "unloaded",
  );

  // 3. 纯已加载区间（目录未取过）→ 只有主循环能判定，且不产生降级项。
  const loadedOnly = mergeTurnNavigatorItems([], [makeLoadedItem(30), makeLoadedItem(40)], 30, I18N);
  assert.equal(
    resolveTurnNavigatorActiveItemIndex({
      items: loadedOnly,
      loadedActiveItemIndex: 1,
      windowFirstRowId: 30,
    }),
    1,
  );
  assert.equal(
    resolveTurnNavigatorActiveItemIndex({
      items: loadedOnly,
      loadedActiveItemIndex: undefined,
      windowFirstRowId: 30,
    }),
    undefined,
    "既无已加载命中也无未加载目录项时交回调用方兜底",
  );
  assert.equal(
    classifyTurnNavigatorActiveScope({
      items: loadedOnly,
      loadedActiveItemIndex: 1,
      windowFirstRowId: 30,
    }),
    "loaded",
  );
});

test("active 降级：未加载项与窗口首行同行/在窗口之下时不参与高亮", () => {
  // 30 与窗口首行 rowId=30 相同，40 在窗口之下 —— 都不是「窗口之上的未加载区」。
  const merged = mergeTurnNavigatorItems([], [], 30, I18N);
  const injected = merged.concat([
    { ...buildTurnNavigatorDirectoryFallbackItem(makeEntry(30), 0), isDirectoryFallback: true },
    { ...buildTurnNavigatorDirectoryFallbackItem(makeEntry(40), 1), isDirectoryFallback: true },
  ]);
  assert.equal(
    resolveTurnNavigatorActiveItemIndex({
      items: injected,
      loadedActiveItemIndex: undefined,
      windowFirstRowId: 30,
    }),
    undefined,
  );
  // 窗口为空（未取过正文行）时，未加载目录项是唯一候选。
  assert.equal(
    resolveTurnNavigatorActiveItemIndex({
      items: injected,
      loadedActiveItemIndex: undefined,
      windowFirstRowId: undefined,
    }),
    0,
  );
});