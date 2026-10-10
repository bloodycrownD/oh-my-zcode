// T-U1（Step 14 / 缺陷②「切会话跳顶」）：初始落点 guard + 行高缓存分区。
// a) 无 measured 高度时落点不执行、首个 measured 后执行且仅一次；
// b) 缓存按 sessionKey 分区：切走再切回命中、不同 sessionKey 不串、LRU 上限不放大。
// uix/A-1：释放信号改组件自有 measuredKeys tracker（per-arm 代际契约）；
// uix/G-3c：LRU 跨分区竞争（A 分区灌满容量上限挤掉 B 分区键）。
// 硬约束：本文件与被测模块零 `@/` 导入，只用相对路径或 node: 内置。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  MAX_ROW_HEIGHT_CACHE_ENTRIES,
  SessionMeasuredKeysTracker,
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

/** 测试用 guard 类型（避免导入泛型接口，解除与组件 T 参数的耦合）。 */
type TestGuard = ReturnType<typeof createSessionInitialAnchorGuard>;

/** 组件侧 arm：guard 与 tracker 同步换代（ConversationTimeline sessionKey effect）。 */
function armWithTracker(
  guard: TestGuard,
  tracker: SessionMeasuredKeysTracker,
  restoredState: { wasPinnedToBottom: boolean; scrollTop: number } | null,
  sessionKey: string,
) {
  guard.arm(restoredState, sessionKey);
  tracker.arm();
}

/**
 * 组件释放 effect 的等价驱动（uix/A-1 后）：isArmedFor(sessionKey) 且 tracker
 * 本 arm 已写入首个 unit key 才喂 tryRelease——与 ConversationTimeline.tsx
 * 释放 effect 的判据逐条对齐（不再读 virtualizer.measurementsCache）。
 */
function trackerRelease(
  guard: TestGuard,
  tracker: SessionMeasuredKeysTracker,
  sessionKey: string,
  unitKeys: readonly (string | number)[],
) {
  if (!guard.isArmedFor(sessionKey)) return null;
  if (!tracker.has(sessionKey, unitKeys[0])) return null;
  return guard.tryRelease({
    currentSessionKey: sessionKey,
    unitKeys,
    measuredKeys: tracker.snapshot(sessionKey),
  });
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

test("tracker：空 tracker + armed → 不释放（uix/A-1 a：旧 measurementsCache 陈旧键不得参与）", () => {
  const guard = createSessionInitialAnchorGuard();
  const tracker = new SessionMeasuredKeysTracker();
  armWithTracker(guard, tracker, scrollMemory(false), "session-a");
  // 本 arm 周期内两写点零写入：即便 rows 已在窗口内，也不得释放。
  assert.equal(trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]), null);
  assert.equal(guard.isArmedFor("session-a"), true);
  // tracker 直判同样为空（非首项写点写入前不含首项）。
  assert.equal(tracker.has("session-a", "turn-a-1"), false);
  assert.equal(tracker.has("session-a", "turn-a-2"), false);
});

test("tracker：首个 key 写入后恰好释放一次（uix/A-1 b）", () => {
  const guard = createSessionInitialAnchorGuard();
  const tracker = new SessionMeasuredKeysTracker();
  armWithTracker(guard, tracker, scrollMemory(false), "session-a");
  // 非首项先写入仍不算：严格等首项（提前释放仍会被钳到估计高度）。
  tracker.record("session-a", "turn-a-2");
  assert.equal(trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]), null);
  // 首项写入：恰好释放一次。
  tracker.record("session-a", "turn-a-1");
  const plan = trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]);
  assert.ok(plan);
  assert.equal(plan.action, "restore");
  assert.equal(plan.sessionKey, "session-a");
  // 防重入：即便后续还有新写入，同会话不得二次产出落点计划。
  tracker.record("session-a", "turn-a-1");
  assert.equal(trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]), null);
  assert.equal(guard.isArmedFor("session-a"), false);
});

test("tracker：跨分区键不串（uix/A-1 c：A 分区的写入不得释放 B）", () => {
  const guard = createSessionInitialAnchorGuard();
  const tracker = new SessionMeasuredKeysTracker();
  armWithTracker(guard, tracker, scrollMemory(false), "session-a");
  tracker.record("session-a", "turn-a-1");
  assert.equal(tracker.has("session-a", "turn-a-1"), true);
  // 切到 B：arm 整体清零后，B 的写入只进 B 分区。
  armWithTracker(guard, tracker, scrollMemory(false), "session-b");
  tracker.record("session-b", "turn-b-1");
  assert.equal(tracker.has("session-b", "turn-a-1"), false);
  assert.equal(tracker.has("session-a", "turn-b-1"), false);
  // B 首项恰是 A 分区旧键 turn-a-1：B armed 不得因此释放。
  assert.equal(
    trackerRelease(guard, tracker, "session-b", ["turn-a-1", "turn-b-1"]),
    null,
    "A 分区旧键（含同 turnId 跨会话重复）不得参与 B 的释放判据",
  );
  assert.equal(guard.isArmedFor("session-b"), true);
  // B 本会话新写入后才释放。
  tracker.record("session-b", "turn-a-1");
  assert.ok(trackerRelease(guard, tracker, "session-b", ["turn-a-1", "turn-b-1"]));
});

test("tracker：A→B→A 重访——arm 后仅旧键在册不算数，本会话新写入才恰好释放一次（uix/A-1 d）", () => {
  const guard = createSessionInitialAnchorGuard();
  const tracker = new SessionMeasuredKeysTracker();
  // 第一轮 A：写入并释放。
  armWithTracker(guard, tracker, scrollMemory(false), "session-a");
  tracker.record("session-a", "turn-a-1");
  assert.ok(trackerRelease(guard, tracker, "session-a", ["turn-a-1"]));
  // B 周期独立完成。
  armWithTracker(guard, tracker, scrollMemory(true), "session-b");
  tracker.record("session-b", "turn-b-1");
  assert.ok(trackerRelease(guard, tracker, "session-b", ["turn-b-1"]));
  // 重访 A：heights 缓存仍留有 A 的旧高度（跨会话持久、切会话刻意不清），
  // tracker 不得同源持久——arm 清零后旧键不得让 A 在首个 commit 误释放。
  armWithTracker(guard, tracker, scrollMemory(false), "session-a");
  assert.equal(tracker.has("session-a", "turn-a-1"), false);
  assert.equal(
    trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]),
    null,
    "重访后首个 commit：旧键在册不算数，不得误释放（跳顶回归复活路径）",
  );
  assert.equal(guard.isArmedFor("session-a"), true);
  // 本会话新测高写入后，恰好释放一次。
  tracker.record("session-a", "turn-a-1");
  const plan = trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]);
  assert.ok(plan);
  assert.equal(plan.action, "restore");
  assert.equal(trackerRelease(guard, tracker, "session-a", ["turn-a-1", "turn-a-2"]), null);
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

test("缓存分区：LRU 跨分区竞争——A 分区灌满容量上限挤掉 B 分区键（uix/G-3c）", () => {
  // 单表跨分区全局 LRU：容量预算不按会话分摊。B 先写一条成为全局最旧，
  // A 灌满到 4000 上限时，B 的键被从最旧端挤出（分区只隔离键、不隔离预算）。
  const cache = new TimelineRowHeightCache();
  cache.set("session-b", "turn-b-1", 500);
  for (let index = 0; index < MAX_ROW_HEIGHT_CACHE_ENTRIES; index += 1) {
    cache.set("session-a", `turn-a-${index}`, 100);
  }
  assert.equal(cache.size, MAX_ROW_HEIGHT_CACHE_ENTRIES);
  assert.equal(cache.get("session-b", "turn-b-1"), undefined, "A 灌满上限后 B 键被挤掉");
  // 同容量口径下小注入复验（避免真机回归时被 4000 循环掩盖）：
  const injected = new TimelineRowHeightCache(4);
  injected.set("session-b", "turn-b-1", 500);
  for (let index = 0; index < 4; index += 1) {
    injected.set("session-a", `turn-a-${index}`, 100);
  }
  assert.equal(injected.size, 4);
  assert.equal(injected.get("session-b", "turn-b-1"), undefined);
  // A 自己的键在预算内全部存活（淘汰只来自最旧端）。
  assert.equal(cache.get("session-a", "turn-a-0"), 100);
  assert.equal(cache.get("session-a", `turn-a-${MAX_ROW_HEIGHT_CACHE_ENTRIES - 1}`), 100);
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
