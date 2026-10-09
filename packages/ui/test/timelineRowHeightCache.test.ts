// T-U1（Step 14 / 缺陷②「切会话跳顶」）：初始落点 guard + 行高缓存分区。
// a) 无 measured 高度时落点不执行、首个 measured 后执行且仅一次；
// b) 缓存按 sessionKey 分区：切走再切回命中、不同 sessionKey 不串、LRU 上限不放大。
// 硬约束：本文件与被测模块零 `@/` 导入，只用相对路径或 node: 内置。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  MAX_ROW_HEIGHT_CACHE_ENTRIES,
  TimelineRowHeightCache,
  canPlaceSessionInitialAnchor,
  createSessionInitialAnchorGuard,
} from "../src/v4/timelineRowHeightCache.js";

/** 滚动记忆的最小形状（守卫只用 wasPinnedToBottom 判定分支）。 */
function scrollMemory(wasPinnedToBottom: boolean, scrollTop = 640) {
  return { wasPinnedToBottom, scrollTop };
}

/** 组件释放 effect 注入的只读快照：窗口行 key + 已测 key 集合。 */
function measurementSnapshot(
  unitKeys: readonly (string | number)[],
  measuredKeys: readonly (string | number)[] = [],
) {
  return {
    unitKeys,
    measuredKeys: new Set<string | number>(measuredKeys),
  };
}

test("guard：无滚动记忆时计划贴底", () => {
  const guard = createSessionInitialAnchorGuard();
  const plan = guard.arm(null, "session-a");
  assert.equal(plan.action, "stickToBottom");
  assert.equal(plan.restoredState, null);
  assert.equal(plan.sessionKey, "session-a");
});

test("guard：吸底记忆同样计划贴底", () => {
  const guard = createSessionInitialAnchorGuard();
  const plan = guard.arm(scrollMemory(true), "session-a");
  assert.equal(plan.action, "stickToBottom");
  assert.equal(plan.restoredState, null);
});

test("guard：离底记忆计划恢复记忆位置且原样携带", () => {
  const guard = createSessionInitialAnchorGuard();
  const memory = scrollMemory(false);
  const plan = guard.arm(memory, "session-a");
  assert.equal(plan.action, "restore");
  // 必须原引用携带：恢复逻辑依赖记忆快照本身，拷贝会在并发恢复时读到旧值。
  assert.equal(plan.restoredState, memory);
});

test("guard：无 measured 高度时反复尝试也不释放（落点不执行）", () => {
  const guard = createSessionInitialAnchorGuard();
  guard.arm(scrollMemory(false), "session-a");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(
      guard.tryRelease({
        currentSessionKey: "session-a",
        ...measurementSnapshot(["turn-a-1", "turn-a-2"]),
      }),
      null,
      `第 ${attempt + 1} 次尝试仍无 measured 高度，不得落点`,
    );
  }
  assert.equal(guard.isArmedFor("session-a"), true);
});

test("guard：rows 未到达（无虚拟行 key）时不释放", () => {
  const guard = createSessionInitialAnchorGuard();
  guard.arm(scrollMemory(false), "session-a");
  assert.equal(
    guard.tryRelease({
      currentSessionKey: "session-a",
      ...measurementSnapshot([]),
    }),
    null,
  );
  assert.equal(guard.isArmedFor("session-a"), true);
});

test("guard：measurementsCache 出现本会话首项才释放", () => {
  const guard = createSessionInitialAnchorGuard();
  guard.arm(scrollMemory(false), "session-a");
  // 非首项已测但首项未测：严格等首项——提前释放仍会被钳到估计高度。
  assert.equal(
    guard.tryRelease({
      currentSessionKey: "session-a",
      ...measurementSnapshot(["turn-a-1", "turn-a-2"], ["turn-a-2"]),
    }),
    null,
  );
  const plan = guard.tryRelease({
    currentSessionKey: "session-a",
    ...measurementSnapshot(["turn-a-1", "turn-a-2"], ["turn-a-1", "turn-a-2"]),
  });
  assert.ok(plan);
  assert.equal(plan.action, "restore");
  assert.equal(plan.sessionKey, "session-a");
});

test("guard：释放后再次尝试返回 null（首次落点仅执行一次）", () => {
  const guard = createSessionInitialAnchorGuard();
  guard.arm(scrollMemory(true), "session-a");
  const plan = guard.tryRelease({
    currentSessionKey: "session-a",
    ...measurementSnapshot(["turn-a-1"], ["turn-a-1"]),
  });
  assert.ok(plan);
  assert.equal(plan.action, "stickToBottom");
  // 防重入：同会话后续 content change / restore 信号都不得再产出落点计划。
  assert.equal(
    guard.tryRelease({
      currentSessionKey: "session-a",
      ...measurementSnapshot(["turn-a-1"], ["turn-a-1"]),
    }),
    null,
  );
  assert.equal(guard.isArmedFor("session-a"), false);
});

test("guard：切会话后旧会话的 measured 信号不再释放", () => {
  const guard = createSessionInitialAnchorGuard();
  guard.arm(scrollMemory(false), "session-a");
  // 切到 session-b：arm 覆盖后，a 的首项测量结果属于旧会话，不得触发释放。
  guard.arm(scrollMemory(true), "session-b");
  assert.equal(
    guard.tryRelease({
      currentSessionKey: "session-b",
      ...measurementSnapshot(["turn-b-1", "turn-b-2"], ["turn-b-1"]),
    })?.sessionKey ?? null,
    "session-b",
  );
  // 旧会话的 measuredKeys 混入也不得让 b 二次释放。
  assert.equal(
    guard.tryRelease({
      currentSessionKey: "session-b",
      ...measurementSnapshot(["turn-b-1", "turn-b-2"], ["turn-a-1", "turn-b-1"]),
    }),
    null,
  );
});

test("guard：tracksSession 在 arm 与释放后都成立（二次 restore effect 让位判据）", () => {
  const guard = createSessionInitialAnchorGuard();
  assert.equal(guard.tracksSession("session-a"), false);
  guard.arm(scrollMemory(false), "session-a");
  assert.equal(guard.tracksSession("session-a"), true);
  assert.equal(guard.isArmedFor("session-a"), true);
  guard.tryRelease({
    currentSessionKey: "session-a",
    ...measurementSnapshot(["turn-a-1"], ["turn-a-1"]),
  });
  // 已执行过首次落点：armed 撤回，但 tracksSession 保持 true——本会话后续的
  // 恢复落点仍归 pending restore effect/锚定 effect 统一口径，guard 不再插手。
  assert.equal(guard.isArmedFor("session-a"), false);
  assert.equal(guard.tracksSession("session-a"), true);
  assert.equal(guard.tracksSession("session-b"), false);
});

test("纯函数：pendingSessionKey 与当前会话不一致时一律不释放", () => {
  assert.equal(
    canPlaceSessionInitialAnchor({
      pendingSessionKey: "session-a",
      currentSessionKey: "session-b",
      unitKeys: ["turn-a-1"],
      measuredKeys: new Set(["turn-a-1"]),
    }),
    false,
  );
  assert.equal(
    canPlaceSessionInitialAnchor({
      pendingSessionKey: null,
      currentSessionKey: "session-b",
      unitKeys: ["turn-b-1"],
      measuredKeys: new Set(["turn-b-1"]),
    }),
    false,
  );
});

test("缓存分区：同会话 set/get/estimate 命中", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("session-a", "turn-a-1", 320);
  assert.equal(cache.get("session-a", "turn-a-1"), 320);
  assert.equal(cache.estimate("session-a", "turn-a-1"), 320);
  assert.equal(cache.size, 1);
});

test("缓存分区：非正/非有限高度被忽略", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("session-a", "turn-a-1", 0);
  cache.set("session-a", "turn-a-2", -5);
  cache.set("session-a", "turn-a-3", Number.NaN);
  cache.set("session-a", "turn-a-4", Number.POSITIVE_INFINITY);
  assert.equal(cache.size, 0);
  assert.equal(cache.get("session-a", "turn-a-1"), undefined);
  assert.equal(cache.estimate("session-a", "turn-a-4"), DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
  assert.equal(cache.estimate("session-a", undefined), DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
});

test("缓存分区：不同 sessionKey 不串号", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("session-a", "turn-1", 180);
  cache.set("session-b", "turn-1", 540);
  assert.equal(cache.get("session-a", "turn-1"), 180);
  assert.equal(cache.get("session-b", "turn-1"), 540);
  // 未写入的 session 回落估计值，不偷拿别家高度。
  assert.equal(cache.get("session-c", "turn-1"), undefined);
  assert.equal(cache.estimate("session-c", "turn-1"), DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
});

test("缓存分区：键中含分隔符的 session 与行键不产生拼接歧义", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("a:b", "c", 111);
  cache.set("a", "b:c", 222);
  assert.equal(cache.get("a:b", "c"), 111);
  assert.equal(cache.get("a", "b:c"), 222);
  assert.equal(cache.get("a:b:c", "turn-x"), undefined);
  assert.equal(cache.get("a", "b:c"), 222);
});

test("缓存分区：切走再切回命中（命中率 > 0）", () => {
  const cache = new TimelineRowHeightCache();
  const sessionAKeys = Array.from({ length: 20 }, (_, index) => `turn-a-${index}`);
  for (const [index, key] of sessionAKeys.entries()) {
    cache.set("session-a", key, 300 + index);
  }
  // 切到 session-b：本会话行各自测高，不得影响 session-a 分区。
  for (let index = 0; index < 50; index += 1) {
    cache.set("session-b", `turn-b-${index}`, 90 + index);
  }
  // 再切回 session-a：未重测即可从缓存拿到上回合真实高度。
  const hits = sessionAKeys.filter((key) => cache.get("session-a", key) !== undefined).length;
  assert.equal(hits, sessionAKeys.length);
  assert.ok(hits / sessionAKeys.length > 0, "切回会话命中率必须 > 0");
  assert.equal(cache.get("session-a", "turn-a-3"), 303);
});

test("缓存分区：LRU 上限不放大且淘汰最久未写入", () => {
  const cache = new TimelineRowHeightCache();
  for (let index = 0; index < MAX_ROW_HEIGHT_CACHE_ENTRIES + 500; index += 1) {
    cache.set("session-a", `turn-${index}`, 100 + index);
  }
  assert.equal(cache.size, MAX_ROW_HEIGHT_CACHE_ENTRIES);
  // 最旧 500 条被淘汰，最新一条存活。
  assert.equal(cache.get("session-a", "turn-0"), undefined);
  assert.equal(
    cache.get("session-a", `turn-${MAX_ROW_HEIGHT_CACHE_ENTRIES + 499}`),
    100 + MAX_ROW_HEIGHT_CACHE_ENTRIES + 499,
  );
});

test("缓存分区：LRU 上限按自定义值生效", () => {
  const cache = new TimelineRowHeightCache(4);
  for (let index = 0; index < 10; index += 1) {
    cache.set("session-a", `turn-${index}`, 100 + index);
  }
  assert.equal(cache.size, 4);
  assert.equal(cache.get("session-a", "turn-9"), 109);
});

test("缓存分区：重复写入刷新淘汰顺序（活跃行不被淘汰）", () => {
  const cache = new TimelineRowHeightCache(3);
  cache.set("session-a", "turn-1", 100);
  cache.set("session-a", "turn-2", 200);
  cache.set("session-a", "turn-3", 300);
  // 回流写 turn-1（流式行反复测高）后，turn-2 变成最旧。
  cache.set("session-a", "turn-1", 150);
  cache.set("session-a", "turn-4", 400);
  assert.equal(cache.get("session-a", "turn-2"), undefined);
  assert.equal(cache.get("session-a", "turn-1"), 150);
});

test("缓存分区：clearSession 只删本会话分区", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("session-a", "turn-a-1", 180);
  cache.set("session-b", "turn-b-1", 540);
  cache.clearSession("session-a");
  assert.equal(cache.get("session-a", "turn-a-1"), undefined);
  // 另一个会话不受影响——切会话路径若误用全量 clear，这里会红。
  assert.equal(cache.get("session-b", "turn-b-1"), 540);
});

test("缓存分区：clear() 全量重置（卸载/极端兜底语义）", () => {
  const cache = new TimelineRowHeightCache();
  cache.set("session-a", "turn-a-1", 180);
  cache.set("session-b", "turn-b-1", 540);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("session-a", "turn-a-1"), undefined);
});

test("分区 + guard 组合：切会话不清缓存，切回即命中真实测高", () => {
  // 组件生命周期等价模拟：A 会话行测高进入 A 分区 → 切 B（不清缓存）→ 切回 A。
  const cache = new TimelineRowHeightCache();
  const guard = createSessionInitialAnchorGuard();
  guard.arm(scrollMemory(false), "session-a");
  cache.set("session-a", "turn-a-1", 420);
  guard.tryRelease({
    currentSessionKey: "session-a",
    ...measurementSnapshot(["turn-a-1"], ["turn-a-1"]),
  });

  guard.arm(scrollMemory(true), "session-b");
  // B 首帧无任何 measured：estimate 只能回落默认值——这正是 estimated 总高
  // 低于视口、必须 guard 推迟落点的场景。
  assert.equal(cache.estimate("session-b", "turn-b-1"), DEFAULT_ROW_HEIGHT_ESTIMATE_PX);
  assert.equal(
    guard.tryRelease({
      currentSessionKey: "session-b",
      ...measurementSnapshot(["turn-b-1"]),
    }),
    null,
    "B 无 measured 高度时不得释放落点",
  );

  guard.arm(scrollMemory(false), "session-a");
  // 切回 A：分区仍留有上回合真实高度，estimateSize 直接命中，不等重测。
  assert.equal(cache.estimate("session-a", "turn-a-1"), 420);
  const plan = guard.tryRelease({
    currentSessionKey: "session-a",
    ...measurementSnapshot(["turn-a-1"], ["turn-a-1"]),
  });
  assert.ok(plan);
  assert.equal(plan.action, "restore");
});
