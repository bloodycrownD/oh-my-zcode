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
  /**
   * 断开长任务观察者并清空缓冲。调用后本实例不再记账（幂等）。
   *
   * 存在的理由：`PerformanceObserver` 的句柄此前挂在模块级变量上，Vite HMR 重求值后
   * 句柄随旧模块一起丢失，新探针再挂一个 → 同一条长任务被两个观察者各记一次，
   * dump 条目数翻倍、基线与终验采样失真。句柄收进实例闭包后才能被可靠摘掉。
   */
  stop(): void;
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
  /** 观察者句柄随实例走（不再挂模块级）：HMR 重求值后旧模块的句柄已无法被摘除。 */
  let observer: PerformanceObserver | undefined;
  let stopped = false;

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

  function pushLongTask(entry: PerfProbeLongTask): void {
    if (stopped) return;
    current.longtasks.push(entry);
    if (current.longtasks.length > maxLongTasks) {
      current.longtasks.splice(0, current.longtasks.length - maxLongTasks);
    }
  }

  // longtask 是 Chromium 专有类型；不支持的环境（如 Node、部分 WebKit）降级为
  // 只做内存分段采样，探针其余部分照常可用。Node 下 PerformanceObserver 接受该
  // type 但从不派发，因此单测可以安全地让每个探针都挂观察器。
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          pushLongTask({ start: entry.startTime, duration: entry.duration });
        }
      });
      // buffered: true 补上探针启动前已经产生的长任务，避免开局窗口漏采。
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      observer?.disconnect();
      observer = undefined;
    }
  }

  return {
    recordLongTask(entry) {
      pushLongTask(entry);
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
    stop() {
      observer?.disconnect();
      observer = undefined;
      stopped = true;
      // 缓冲一并清空：stop 后 dump() 必须是空数组，否则上一实例的残留样本
      // 会和新实例的样本混在一起，采样口径失真。
      segments.length = 0;
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

/** window 上的探针调试面类型：CDP 侧与 App.tsx 的 cleanup 都要按它取实例。 */
export type PerfProbeDebugWindow = Window & {
  __zcodePerfProbe?: PerfProbe;
};

/**
 * 启动探针并挂上 window 调试面（范式同 `v4/commandAckObservability.ts`）。
 * 生产 build / 非浏览器环境下返回 undefined。
 *
 * 每次调用都先摘掉 window 上可能残留的旧探针再新建：Vite HMR 会重求值本模块，
 * 模块级变量随之丢失但 window 上的旧实例仍带着自己的观察者——不摘就会新旧两个
 * 观察者同时记账，同一条长任务在 dump 里出现两次，采样条目翻倍、基线失真。
 */
export function startPerfProbe(): PerfProbe | undefined {
  if (!isPerfProbeEnabled()) {
    return undefined;
  }
  const debugWindow = window as PerfProbeDebugWindow;
  debugWindow.__zcodePerfProbe?.stop();
  const probe = createPerfProbe();
  debugWindow.__zcodePerfProbe = probe;
  return probe;
}

/** 断开旧实例的观察者并摘掉 window 调试面（热更新与单测清理用）。 */
export function stopPerfProbe(): void {
  if (typeof window === "undefined") return;
  const debugWindow = window as PerfProbeDebugWindow;
  debugWindow.__zcodePerfProbe?.stop();
  delete debugWindow.__zcodePerfProbe;
}
