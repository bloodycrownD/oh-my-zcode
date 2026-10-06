import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
} from "@zcode/shared";
// 相对路径而非 `@/logger.js`：注册表被 shikiHighlighter 的单测 import，
// `@/` 别名在纯 Node（tsx --test）下无法解析。
import { logMemoryDiagnostics } from "../logger.js";

/**
 * renderer 内存诊断计数器注册表。
 * 各缓存/store 模块在模块加载时注册纯读取 provider；`startMemoryDiagnosticsLogger` 每 60 秒
 * 采样一次，经门控后通过 `logger.logMemoryDiagnostics` 写桌面主日志。
 */
export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

interface RendererHeapSnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

/** Chromium 专有的 `performance.memory`；Web 端浏览器缺失时返回 undefined。 */
function readRendererHeapSnapshot(): RendererHeapSnapshot | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  const memory = (performance as Performance & { memory?: RendererHeapSnapshot }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") {
    return undefined;
  }
  return memory;
}

/**
 * renderer 内存样本的纯读出口：注册表计数 + `performance.memory`，
 * **不经过写盘门控、不落盘、无副作用**。
 *
 * 与 `sampleNow()` 的分工：后者是 60s 定时采样器，返回的只是「这次有没有写盘」的 boolean，
 * 拿不到数据本身；页面内探针（perfProbe）需要在任意时刻按需取一份完整样本，因此走这里。
 */
export function collectRendererMemorySample(
  registry: MemoryDiagnosticsRegistry = uiMemoryDiagnosticsRegistry,
  readHeap: () => RendererHeapSnapshot | undefined = readRendererHeapSnapshot,
): MemorySample {
  const sample: MemorySample = {
    role: "renderer",
    counters: registry.collect(),
  };
  const heap = readHeap();
  if (heap) {
    sample.heapUsedKb = Math.round(heap.usedJSHeapSize! / 1024);
    if (typeof heap.totalJSHeapSize === "number") {
      sample.heapTotalKb = Math.round(heap.totalJSHeapSize / 1024);
    }
  }
  return sample;
}

interface StartMemoryDiagnosticsLoggerOptions {
  intervalMs?: number;
  now?: () => number;
  readHeap?: () => RendererHeapSnapshot | undefined;
  write?: (line: string) => void;
  registry?: MemoryDiagnosticsRegistry;
}

interface MemoryDiagnosticsLoggerHandle {
  sampleNow(): boolean;
  stop(): void;
}

export function startMemoryDiagnosticsLogger(
  options: StartMemoryDiagnosticsLoggerOptions = {},
): MemoryDiagnosticsLoggerHandle {
  const now = options.now ?? (() => Date.now());
  const readHeap = options.readHeap ?? readRendererHeapSnapshot;
  const write = options.write ?? logMemoryDiagnostics;
  const registry = options.registry ?? uiMemoryDiagnosticsRegistry;
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    try {
      const sample = collectRendererMemorySample(registry, readHeap);
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      write(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // 诊断采样失败只丢当前样本，不能影响渲染。
      return false;
    }
  };

  let handle: ReturnType<typeof setInterval> | undefined = setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );

  return {
    sampleNow,
    stop() {
      if (handle === undefined) {
        return;
      }
      clearInterval(handle);
      handle = undefined;
    },
  };
}
