import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";
import type { ZCodeProtocolMessage } from "@zcode/shared";

// FORK (upstream-v3.15.1-backport) T-PROC-2：spec §2.1 P1 #7——stdout 分帧不再是 O(n²) 全缓冲拼接。
//
// 失效形态：旧实现 `stdoutBuffer += chunk` 后对整个缓冲 `indexOf("\n")`，每个 64KB chunk 都让
// V8 把 cons string 拍平并从头扫描。单行帧长度 n 时总开销 O(n²)：task index resync 的 session/read
// 会回一行约 15MB 的完整快照，实测 30s 内真实 stdout 95MB 却拍平分配 9.4GB、RSS 冲到 1.5–1.9GB。
// 修复只在新 chunk 内找 LF，未完成部分存分片数组、成帧时 join 一次（线性）。
//
// 本用例喂一行 15MB 的合法协议帧（64KB 分片，与真实 pipe 的切分同粒度），同时断言：
//   1) 帧完整成帧（功能面：分片数组没有丢字节）；
//   2) 峰值堆/RSS 有界（旧实现同口径会到 GB 级，这里的上界留了数量级余量）。

/** 最小 child 替身：只有 transport 真正用到的流与事件面。 */
function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  return child as unknown as Parameters<typeof ZCodeStdioTransport.prototype.constructor>[0];
}

const FRAME_TEXT_BYTES = 15 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** 上界：本机实测修复后峰值堆增长 ≈20MiB；旧实现同口径 ≈161MiB（拍平分配量 GB 级）。 */
const PEAK_HEAP_GROWTH_LIMIT_BYTES = 128 * 1024 * 1024;

test("T-PROC-2 15MB 单行帧线性成帧：帧完整且峰值内存有界", async () => {
  const child = createFakeChild();
  const transport = new ZCodeStdioTransport(child);
  const frames: ZCodeProtocolMessage[] = [];
  transport.onMessage((message) => frames.push(message));
  transport.onClose(() => {});

  const payload = "x".repeat(FRAME_TEXT_BYTES);
  const frame = Buffer.from(`${JSON.stringify({ id: 1, result: { blob: payload } })}\n`, "utf8");

  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  const sample = () => {
    const usage = process.memoryUsage();
    if (usage.heapUsed > peakHeap) peakHeap = usage.heapUsed;
    if (usage.rss > peakRss) peakRss = usage.rss;
  };

  for (let offset = 0; offset < frame.byteLength; offset += CHUNK_BYTES) {
    (child as unknown as { stdout: PassThrough }).stdout.push(
      frame.subarray(offset, Math.min(offset + CHUNK_BYTES, frame.byteLength)),
    );
    // 让分片走到 handleStdoutData（并触发旧实现里那一次"拍平"）后再采样。
    await new Promise((resolve) => setImmediate(resolve));
    sample();
  }
  sample();

  // ── 功能面：15MB 帧原样成帧（分片 join 不丢字节、LF 边界正确）──────────────
  assert.equal(frames.length, 1, `期望恰好一帧，实际 ${frames.length}`);
  const result = (frames[0] as { result: { blob: string } }).result;
  assert.equal(result.blob.length, FRAME_TEXT_BYTES);

  // ── 内存面：峰值增长有界 ─────────────────────────────────────────────────
  const heapGrowth = peakHeap - baseline.heapUsed;
  const rssGrowth = peakRss - baseline.rss;
  console.log(
    `  [T-PROC-2] frame=${(frame.byteLength / 1024 / 1024).toFixed(1)}MiB chunks=${Math.ceil(frame.byteLength / CHUNK_BYTES)} ` +
      `peakHeapGrowth=${(heapGrowth / 1024 / 1024).toFixed(1)}MiB peakRssGrowth=${(rssGrowth / 1024 / 1024).toFixed(1)}MiB`,
  );
  assert.equal(
    heapGrowth < PEAK_HEAP_GROWTH_LIMIT_BYTES,
    true,
    `峰值堆增长 ${(heapGrowth / 1024 / 1024).toFixed(1)}MiB 超出上界 ${PEAK_HEAP_GROWTH_LIMIT_BYTES / 1024 / 1024}MiB`,
  );

  // 收尾：让 transport 认为子进程已退出（exitCode 非 null），避免它去回收并不存在的进程树。
  (child as unknown as { exitCode: number | null }).exitCode = 0;
  transport.dispose();
});
