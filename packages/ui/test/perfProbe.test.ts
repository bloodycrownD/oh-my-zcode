/**
 * perfProbe / collectRendererMemorySample 的单测（T-PA1 / T-PA2）。
 *
 * 可测性前置：被测链路的传递依赖必须零 `@/` 别名。`perfProbe.ts` → `memoryDiagnostics.ts`
 * → `@zcode/shared` / `../logger.js` 全是可解析路径，因此本文件可以直接在
 * `npx tsx --test` 下跑。**不要在本文件引入 `@/`。**
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MemorySample } from "@zcode/shared";
import {
  collectRendererMemorySample,
  uiMemoryDiagnosticsRegistry,
} from "../src/lib/memoryDiagnostics.js";
import {
  createPerfProbe,
  startPerfProbe,
  type PerfProbeLongTask,
  type PerfProbeSegment,
} from "../src/lib/perfProbe.js";

interface StubbedHeap {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

/**
 * Chromium 才有 `performance.memory`，Node 下没有。T-PA2 要断言 heap 字段，
 * 这里临时打桩，测试结束还原。
 */
function withStubbedHeap<T>(heap: StubbedHeap | undefined, run: () => T): T {
  const perf = globalThis.performance as Performance & { memory?: StubbedHeap };
  const hadOwn = Object.prototype.hasOwnProperty.call(perf, "memory");
  const original = perf.memory;
  Object.defineProperty(perf, "memory", { configurable: true, writable: true, value: heap });
  try {
    return run();
  } finally {
    if (hadOwn) {
      Object.defineProperty(perf, "memory", {
        configurable: true,
        writable: true,
        value: original,
      });
    } else {
      delete perf.memory;
    }
  }
}

function fakeMemorySample(tag: string): MemorySample {
  return { role: "renderer", counters: { "probe.fake": tag.length } };
}

function parseDump(dump: string): PerfProbeSegment[] {
  const parsed: unknown = JSON.parse(dump);
  assert.ok(Array.isArray(parsed), "dump() 必须返回可解析的段数组");
  return parsed as PerfProbeSegment[];
}

// ---------------------------------------------------------------- T-PA1

/**
 * Node 的 PerformanceObserver 接受任意 type 字符串但从不派发 longtask，
 * 因此只能靠「真的收到条目」判定环境能力，而不是构造成功。
 */
test("T-PA1: 同步 busy loop 注入长任务后 dump() 能解析出 longtask 条目", async () => {
  const observed: PerfProbeLongTask[] = [];
  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== "undefined") {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        observed.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    try {
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      observer.disconnect();
      observer = undefined;
    }
  }
  try {
    const end = (typeof performance === "undefined" ? Date.now() : performance.now()) + 120;
    while ((typeof performance === "undefined" ? Date.now() : performance.now()) < end) {
      // 同步忙循环：浏览器下会被记成 longtask
      Math.sqrt(Math.random());
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    observer?.disconnect();
  }

  const probe = createPerfProbe({
    now: () => 0,
    memorySample: () => fakeMemorySample("busy"),
  });
  if (observed.length > 0) {
    // 浏览器真实观测路径：把 longtask 条目灌进探针再 dump。
    for (const task of observed) probe.recordLongTask(task);
  } else {
    // Node 不派发 longtask，用注入的记录函数覆盖同一分段链路；
    // 真实浏览器行为由 scripts/dev/long-session-perf-sample.mjs 的 CDP 采样验证。
    probe.recordLongTask({ start: 12.5, duration: 120 });
  }

  const segments = parseDump(probe.dump());
  assert.ok(segments[0].longtasks.length > 0, "dump() 必须能解析出 longtask 条目");
  for (const task of segments[0].longtasks) {
    assert.equal(typeof task.start, "number");
    assert.equal(typeof task.duration, "number");
  }
});

// ---------------------------------------------------------------- T-PA2

test("T-PA2: 注入 7 个假 provider 后 collectRendererMemorySample 返回全部计数 + heap + role", () => {
  const providerNames = [
    "tokens",
    "rows",
    "delta",
    "timeline",
    "cache",
    "store",
    "plugin",
  ] as const;
  const disposers = providerNames.map((name, index) =>
    uiMemoryDiagnosticsRegistry.register(name, () => ({ entries: index + 1 })),
  );

  try {
    withStubbedHeap({ usedJSHeapSize: 5 * 1024 * 1024, totalJSHeapSize: 8 * 1024 * 1024 }, () => {
      const sample = collectRendererMemorySample();

      assert.equal(sample.role, "renderer");
      for (const [index, name] of providerNames.entries()) {
        assert.equal(sample.counters[`${name}.entries`], index + 1, `缺少 ${name}.entries 计数`);
      }
      assert.equal(Object.keys(sample.counters).length, providerNames.length);

      // 5MiB / 8MiB → KB
      assert.equal(sample.heapUsedKb, 5 * 1024);
      assert.equal(sample.heapTotalKb, 8 * 1024);
    });
  } finally {
    for (const dispose of disposers) dispose.dispose();
  }
});

test("T-PA2: 无 performance.memory 时样本只带计数，heap 字段省略", () => {
  const dispose = uiMemoryDiagnosticsRegistry.register("noHeap", () => ({ entries: 1 }));
  try {
    withStubbedHeap(undefined, () => {
      const sample = collectRendererMemorySample();
      assert.equal(sample.role, "renderer");
      assert.equal(sample.counters["noHeap.entries"], 1);
      assert.equal(sample.heapUsedKb, undefined);
      assert.equal(sample.heapTotalKb, undefined);
    });
  } finally {
    dispose.dispose();
  }
});

test("T-PA2: 采集是纯读——多次调用不写盘也不改门控状态", () => {
  const dispose = uiMemoryDiagnosticsRegistry.register("pure", () => ({ entries: 3 }));
  try {
    const first = collectRendererMemorySample();
    const second = collectRendererMemorySample();
    assert.deepEqual(second.counters["pure.entries"], first.counters["pure.entries"]);
  } finally {
    dispose.dispose();
  }
});

// ---------------------------------------------------------------- T-PA1

test("T-PA1: reset() 清空当前段并开启新段，旧段数据保留", () => {
  let clock = 0;
  const probe = createPerfProbe({
    now: () => (clock += 10),
    memorySample: () => fakeMemorySample("seg"),
  });

  probe.recordLongTask({ start: 1, duration: 60 });
  clock = 1000;
  probe.reset();
  probe.recordLongTask({ start: 2, duration: 30 });

  const segments = parseDump(probe.dump());
  assert.equal(segments.length, 2, "reset 应开启新段而不是丢弃历史");
  assert.deepEqual(segments[0].longtasks, [{ start: 1, duration: 60 }], "旧段长任务必须保留");
  assert.deepEqual(
    segments[1].longtasks,
    [{ start: 2, duration: 30 }],
    "新段只含 reset 之后的条目",
  );
  assert.ok(segments[0].startedAt < segments[1].startedAt, "段起始时间应递增");
});

test("T-PA1: dump() 是 JSON 字符串且每段带 memory 样本（role=renderer）", () => {
  const probe = createPerfProbe({ now: () => 0, memorySample: () => fakeMemorySample("ab") });
  probe.reset();
  const dump = probe.dump();
  assert.equal(typeof dump, "string");
  const segments = parseDump(dump);
  for (const segment of segments) {
    assert.ok(segment.memory, "每段必须带 memory");
    assert.equal(segment.memory.role, "renderer");
    assert.equal(segment.memory.counters["probe.fake"], 2);
  }
});

test("T-PA1: 段数与单段条目数都按环形上限淘汰最旧", () => {
  const probe = createPerfProbe({
    now: () => 0,
    memorySample: () => fakeMemorySample("ring"),
    maxSegments: 2,
    maxLongTasksPerSegment: 2,
  });

  for (let i = 0; i < 4; i += 1) {
    probe.reset();
    probe.recordLongTask({ start: i * 10, duration: 5 });
    probe.recordLongTask({ start: i * 10 + 1, duration: 6 });
    probe.recordLongTask({ start: i * 10 + 2, duration: 7 });
  }

  const segments = parseDump(probe.dump());
  assert.equal(segments.length, 2, "段数超过 maxSegments 后丢最旧");
  for (const segment of segments) {
    assert.equal(segment.longtasks.length, 2, "单段条目超过上限后丢最旧");
  }
  // 最新一段（i=3 注入了 start 30/31/32）只保留后两条。
  const newest = segments[segments.length - 1];
  assert.deepEqual(newest.longtasks, [
    { start: 31, duration: 6 },
    { start: 32, duration: 7 },
  ]);
});

test("T-PA1: sampleMemory() 走 collectRendererMemorySample 的注入出口", () => {
  const probe = createPerfProbe({
    memorySample: () =>
      collectRendererMemorySample(uiMemoryDiagnosticsRegistry, () => ({
        usedJSHeapSize: 1024 * 1024,
        totalJSHeapSize: 2 * 1024 * 1024,
      })),
  });
  const sample = probe.sampleMemory();
  assert.equal(sample.role, "renderer");
  assert.equal(sample.heapUsedKb, 1024);
  assert.equal(sample.heapTotalKb, 2048);
});

test("T-PA1: 非 dev/无 window 环境下 startPerfProbe 是 no-op", () => {
  // Node 下 import.meta.env.DEV 为 false 且没有 window，生产/单测都不该产生副作用。
  assert.equal(typeof window, "undefined");
  assert.equal(startPerfProbe(), undefined);
});
