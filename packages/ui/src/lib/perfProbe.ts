/**
 * 页面内性能探针（dev-only）。
 *
 * 度量基建的第一层：长会话性能优化需要一个能在**页面内**按需取数的出口，CDP 侧
 * （`scripts/dev/long-session-perf-sample.mjs`）只用 `Runtime.evaluate` 调
 * `window.__zcodePerfProbe` 的方法就能拿到数据，不必走 CDP Tracing domain
 * （trace JSON 体积大、解析复杂，而 longtask 已被浏览器聚合成条目）。
 *
 * 两个刻意的设计选择：
 *
 * 1. **自持环形缓冲，不写 `performance.mark/measure`**。dev 下
 *    `performanceTimelineCleanup` 每 10s 把 performance timeline 清空一遍
 *    （packages/desktop/src/renderer/src/performanceTimelineCleanup.ts），
 *    任何依赖 timeline 的取数都会丢样本；探针的缓冲必须自己拥有。
 * 2. **`dump()` 返回 JSON 字符串**。CDP 的返回值要能当字符串原样取回，
 *    直接返回对象会被远端序列化成结构化值，反而多一层不确定性。
 *
 * 时间基准统一用 `performance.now()`：`PerformanceEntry.startTime` 本身就是这个时基，
 * 段的 `startedAt` 与 longtask 的 `start` 放同一根轴上才可比。
 *
 * 本模块零 `@/` 别名导入，`packages/ui/test/perfProbe.test.ts` 可在纯 Node 下直接 import。
 */
import type { MemorySample } from "@zcode/shared";
import { collectRendererMemorySample } from "./memoryDiagnostics.js";

export interface PerfProbeLongTask {
  /** 相对 `performance.timeOrigin` 的毫秒偏移，与 PerformanceEntry 同基。 */
  start: number;
  duration: number;
}

/** 一个测量段：`reset()` 开窗，`dump()` 或下一次 `reset()` 收口。 */
export interface PerfProbeSegment {
  startedAt: number;
  longtasks: PerfProbeLongTask[];
  /** 该段收口时刻的内存样本；`reset()` 与 `dump()` 都会补齐。 */
  memory: MemorySample;
}

export interface PerfProbe {
  /** 长任务记录入口。抽成可注入函数是为了让 Node 单测能驱动分段语义（Node 无 longtask）。 */
  recordLongTask(entry: PerfProbeLongTask): void;
  sampleMemory(): MemorySample;
  /** 收口当前段（补内存样本）并开启新段。 */
  reset(): void;
  /** 返回 JSON 字符串（`PerfProbeSegment[]`），供 CDP 以字符串取回。 */
  dump(): string;
}

export interface CreatePerfProbeOptions {
  /** 段数上限，超出丢最旧的一段。 */
  maxSegments?: number;
  /** 单段内 longtask 条目上限，超出丢最旧的一条。 */
  maxLongTasksPerSegment?: number;
  memorySample?: () => MemorySample;
  now?: () => number;
}

export const PERF_PROBE_MAX_SEGMENTS = 20;
export const PERF_PROBE_MAX_LONGTASKS_PER_SEGMENT = 200;

type MutableSegment = {
  startedAt: number;
  longtasks: PerfProbeLongTask[];
  memory?: MemorySample;
};

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** 内存采样失败不能连带丢掉已经采到的 longtask。 */
function sampleSafely(sample: () => MemorySample): MemorySample | undefined {
  try {
    return sample();
  } catch {
    return undefined;
  }
}

export function createPerfProbe(options: CreatePerfProbeOptions = {}): PerfProbe {
  const maxSegments = Math.max(1, options.maxSegments ?? PERF_PROBE_MAX_SEGMENTS);
  const maxLongTasks = Math.max(
    1,
    options.maxLongTasksPerSegment ?? PERF_PROBE_MAX_LONGTASKS_PER_SEGMENT,
  );
  const memorySample = options.memorySample ?? collectRendererMemorySample;
  const now = options.now ?? defaultNow;

  const segments: MutableSegment[] = [];
  let current: MutableSegment = openSegment();

  function openSegment(): MutableSegment {
    const segment: MutableSegment = { startedAt: now(), longtasks: [] };
    segments.push(segment);
    if (segments.length > maxSegments) {
      // 只从头部淘汰，最新的段（也就是 current）永远留在缓冲里。
      segments.splice(0, segments.length - maxSegments);
    }
    return segment;
  }

  function stampMemory(): void {
    const sample = sampleSafely(memorySample);
    if (sample) {
      current.memory = sample;
    }
  }

  return {
    recordLongTask(entry) {
      current.longtasks.push(entry);
      if (current.longtasks.length > maxLongTasks) {
        current.longtasks.splice(0, current.longtasks.length - maxLongTasks);
      }
    },
    sampleMemory() {
      return memorySample();
    },
    reset() {
      stampMemory();
      current = openSegment();
    },
    dump() {
      stampMemory();
      // 长任务条目只投影 start/duration：环形缓冲内部若将来挂上 DOM 引用等重字段，
      // 不会漏进 CDP 取回的 JSON。
      const snapshot = segments.map((segment) => ({
        startedAt: segment.startedAt,
        longtasks: segment.longtasks.map((task) => ({
          start: task.start,
          duration: task.duration,
        })),
        memory: segment.memory,
      }));
      return JSON.stringify(snapshot);
    },
  };
}

function isPerfProbeEnabled(): boolean {
  // 与 performanceTimelineCleanup 同口径：只在 Vite 的 dev build 里启用。
  // Node 单测下 `import.meta.env` 为 undefined，这里退化成 false。
  const viteDev =
    ((import.meta as ImportMeta & { env?: { readonly DEV?: boolean } }).env ?? {}).DEV === true;
  return viteDev && typeof window !== "undefined";
}

type PerfProbeDebugWindow = Window & {
  __zcodePerfProbe?: PerfProbe;
};

let started: PerfProbe | undefined;
let observer: PerformanceObserver | undefined;

/**
 * 启动探针并挂上 window 调试面（范式同 `v4/commandAckObservability.ts`）。
 * 幂等：重复调用返回同一个探针实例。生产 build / 非浏览器环境下返回 undefined。
 */
export function startPerfProbe(): PerfProbe | undefined {
  if (!isPerfProbeEnabled()) {
    return undefined;
  }
  if (started) {
    return started;
  }
  const probe = createPerfProbe();
  started = probe;

  // longtask 是 Chromium 专有类型；不支持的环境（如 Node、部分 WebKit）降级为
  // 只做内存分段采样，探针其余部分照常可用。
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          probe.recordLongTask({ start: entry.startTime, duration: entry.duration });
        }
      });
      // buffered: true 补上探针启动前已经产生的长任务，避免开局窗口漏采。
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      observer = undefined;
    }
  }

  (window as PerfProbeDebugWindow).__zcodePerfProbe = probe;
  return probe;
}

/** 断开观察者并摘掉 window 调试面（热更新与单测清理用）。 */
export function stopPerfProbe(): void {
  observer?.disconnect();
  observer = undefined;
  started = undefined;
  if (typeof window !== "undefined") {
    delete (window as PerfProbeDebugWindow).__zcodePerfProbe;
  }
}
