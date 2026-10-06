/**
 * turnNavigator helpers 的单测（Step 7 滚动 O(N) 消除）。
 *
 * 覆盖三件事：
 * 1. `resolveConversationTurnNavigatorActiveUnitIndex` 传入预计算的
 *    `itemByUnitIndex` 与不传（函数内自建）结果完全一致——保证优化不改变语义；
 * 2. 滚动触发量化（`Math.floor(scrollOffsetPx / DEFAULT_ROW_HEIGHT_ESTIMATE_PX)`）
 *    的边界：同一量化桶内 active 结果稳定，跨桶才可能变；
 * 3. 目录门控（Step 17 接线修复）：未取过目录时窄面必须把权威总数留成
 *    undefined，否则宽屏 rail 首查被 `total < 2` 挡死形成闭环自锁。
 *
 * 可测性前置：本文件只走相对路径导入，`conversationTurnNavigatorHelpers.ts` 的
 * `@/v4/conversationTurnRenderUnits.js` 是 type-only 导入（编译期剥离），
 * 因此传递依赖链零 `@/`。**不要在本文件引入 `@/`。**
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  pickOwnedRowElements,
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
  shouldHideConversationTurnNavigatorRail,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorDirectoryView,
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

test("ActiveQueryRowId：视口定位口径 + 空表返回 undefined", () => {
  const positions: ConversationTurnNavigatorQueryPosition[] = [
    { rowId: 30, start: 200, end: 260 },
    { rowId: 10, start: 0, end: 80 },
    { rowId: 20, start: 90, end: 150 },
    // 边界：start 为负数需夹取为 0（并按夹取后的 start 参与升序）。
    { rowId: 40, start: -50, end: 10 },
  ];

  // 视口覆盖全部位置 → 取 start 最靠近视口顶的那条（夹取后 row10/row40 的 start 同为 0，
  // 按 rowId 升序取先到的 row10）。
  assert.equal(
    resolveConversationTurnNavigatorActiveQueryRowId({
      positions,
      scrollOffsetPx: 0,
      viewportHeightPx: 600,
    }),
    10,
  );
  // 视口压在 rowId=20 的区间上 → 取该区间内 start 距视口顶最近的一条。
  assert.equal(
    resolveConversationTurnNavigatorActiveQueryRowId({
      positions,
      scrollOffsetPx: 95,
      viewportHeightPx: 60,
    }),
    20,
  );
  // 视口在所有位置之下 → 取最后一个 start <= 视口顶的（rowId=30，start=200）。
  assert.equal(
    resolveConversationTurnNavigatorActiveQueryRowId({
      positions,
      scrollOffsetPx: 5_000,
      viewportHeightPx: 200,
    }),
    30,
  );
  // 空位置表没有可判定项。
  assert.equal(
    resolveConversationTurnNavigatorActiveQueryRowId({
      positions: [],
      scrollOffsetPx: 0,
      viewportHeightPx: 200,
    }),
    undefined,
  );
});

/** 宽屏（>= 864px rail 门槛）判定用的固定容器宽度。 */
const WIDE_CONTAINER_PX = 1_200;

/** store `ConversationTurnDirectoryState` 里与裁决相关的四个字段。 */
interface StoreDirectoryFacts {
  loaded: boolean;
  entryCount: number;
  realUserQueryTotal: number;
  hasMore: boolean;
}

/**
 * SessionPane 构造窄面那段门控的单测镜像。
 *
 * 组件无法在 Node 下加载，所以这里复刻「`loaded === false` → total/hasMore 留
 * undefined」这一条接线，锁的是**门控 + 判定**的组合语义：未取过目录时把 store 空态
 * 默认的 0 当权威值下发，首查会被 `total < 2` 挡死，而 store 的失效重查又要求
 * `loaded === true`，形成闭环自锁。
 */
function buildDirectoryView(facts: StoreDirectoryFacts): ConversationTurnNavigatorDirectoryView {
  return {
    loaded: facts.loaded,
    entryCount: facts.entryCount,
    realUserQueryTotal: facts.loaded ? facts.realUserQueryTotal : undefined,
    hasMore: facts.loaded ? facts.hasMore : undefined,
  };
}

/** 组件侧喂给判定函数的入参（ConversationTimeline.tsx 的展开形状）。 */
function hydrate(directory: ConversationTurnNavigatorDirectoryView, canLoadOlder: boolean) {
  return shouldHydrateConversationTurnNavigatorDirectory({
    canLoadOlder,
    containerWidthPx: WIDE_CONTAINER_PX,
    hasLoadHandler: true,
    loadingDirectory: false,
    ...(directory
      ? {
          realUserQueryTotal: directory.realUserQueryTotal,
          directoryHasMore: directory.hasMore,
        }
      : {}),
  });
}

test("目录门控：未取过目录（total 为 undefined）落回 canLoadOlder 放行首查", () => {
  const notLoaded = buildDirectoryView({
    loaded: false,
    entryCount: 0,
    // store 空态默认：语义是「还没取过」，不是「取到了 0 条」。
    realUserQueryTotal: 0,
    hasMore: false,
  });

  assert.equal(notLoaded.realUserQueryTotal, undefined, "未取过时权威总数必须留 undefined");
  assert.equal(notLoaded.hasMore, undefined, "未取过时 hasMore 必须留 undefined");
  assert.equal(hydrate(notLoaded, true), true, "宽屏 + 还有更早行 → 放行首查（不能被空态 0 挡死）");
  assert.equal(hydrate(notLoaded, false), false, "没有更早行 → 沿用 canLoadOlder 拦截");

  // 窄面整体缺省（拿不到 store 目录态）与 loaded=false 同义，同样放行。
  assert.equal(hydrate(undefined, true), true);
  assert.equal(
    shouldHideConversationTurnNavigatorRail(notLoaded),
    false,
    "未取过目录时不能按空判隐藏，否则首帧闪一下",
  );
});

test("目录门控：已取过且权威总数不足两条 → 不放行（rail 不会出现）", () => {
  for (const realUserQueryTotal of [0, 1]) {
    const loaded = buildDirectoryView({
      loaded: true,
      entryCount: realUserQueryTotal,
      realUserQueryTotal,
      hasMore: false,
    });
    assert.equal(hydrate(loaded, true), false, `total=${realUserQueryTotal} 应被 <2 闸门拦下`);
  }

  // 恰好两条 + 更早方向还有条目 → 放行，且不再看 canLoadOlder（目录自身的事实已够）。
  const enough = buildDirectoryView({
    loaded: true,
    entryCount: 2,
    realUserQueryTotal: 2,
    hasMore: true,
  });
  assert.equal(hydrate(enough, false), true);

  // 目录已取齐（hasMore === false）→ 没有可补的内容，不放行。
  const drained = buildDirectoryView({
    loaded: true,
    entryCount: 9,
    realUserQueryTotal: 9,
    hasMore: false,
  });
  assert.equal(hydrate(drained, true), false, "目录已取齐时不该再 hydrate");
});

test("目录门控：终态 not-enough-queries 不被重新放行（total 是权威结论）", () => {
  // store 结案时写入 loaded=true + 权威总数（<2），窄面照常下发：
  // 「不足两条」是已确认的终态，不是「还没取」。
  const terminal = buildDirectoryView({
    loaded: true,
    entryCount: 0,
    realUserQueryTotal: 0,
    hasMore: false,
  });

  assert.equal(terminal.realUserQueryTotal, 0, "终态必须照常下发权威总数");
  assert.equal(hydrate(terminal, true), false, "终态不得因 canLoadOlder 重新放行");
  assert.equal(hydrate(terminal, false), false);
  assert.equal(
    shouldHideConversationTurnNavigatorRail(terminal),
    true,
    "终态且一条都没有 → rail 隐藏（画出来是一根空条）",
  );
  // 终态条目非空（权威 0 但本地窗口有条目）不隐藏。
  assert.equal(shouldHideConversationTurnNavigatorRail({ ...terminal, entryCount: 1 }), false);
});

test("目录门控：宽度 / 缺 handler / 在途 三道前置闸门不受门控影响", () => {
  const base = {
    canLoadOlder: true,
    containerWidthPx: WIDE_CONTAINER_PX,
    hasLoadHandler: true,
    loadingDirectory: false,
  };

  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, containerWidthPx: 863 }),
    false,
    "窄屏（< 864px）不放行",
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, hasLoadHandler: false }),
    false,
    "没有目录查询 handler 不放行",
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, loadingDirectory: true }),
    false,
    "查询在途不放行（防重入）",
  );
});

test("pickOwnedRowElements：注册表条目不属于本容器时被跳过（full/B-1）", () => {
  // Node 侧无 DOM：元素用裸对象桩、容器用 contains 闭包桩，只测归属过滤纯逻辑。
  const ownedElement = {} as HTMLElement;
  const foreignElement = {} as HTMLElement;
  const registry = new Map<number, HTMLElement>([
    [10, ownedElement],
    [20, foreignElement],
    [30, ownedElement],
  ]);
  const ownedSet = new Set([ownedElement]);
  const container = { contains: (element: HTMLElement) => ownedSet.has(element) };

  const owned = pickOwnedRowElements(registry, container);

  assert.deepEqual([...owned.keys()].sort((a, b) => a - b), [10, 30]);
  assert.equal(owned.get(10), ownedElement);
  assert.equal(owned.has(20), false, "别家 pane 的活元素（contains 不命中）必须被过滤");
});

test("pickOwnedRowElements：全部不归属 / 空注册表 → 空 Map", () => {
  const container = { contains: () => false };
  assert.equal(pickOwnedRowElements(new Map([[1, {} as HTMLElement]]), container).size, 0);
  assert.equal(pickOwnedRowElements(new Map(), { contains: () => true }).size, 0);
});
