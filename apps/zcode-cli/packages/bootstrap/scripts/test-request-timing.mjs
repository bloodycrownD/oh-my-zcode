#!/usr/bin/env node
/**
 * fix-c19 —— **请求三段耗时打点**（`zcode_protocol.request.timing`）。
 *
 * ============================================================================
 * 为什么这条要有测试
 * ============================================================================
 *
 *   真机冷开账单里有一段 800~1150ms 落在 CLI handler **开始之前**，但过去无法判断它属于
 *   「renderer → host → stdio」、「stdio 到达 → handler 出队」还是「handler 内部」。
 *   `ZCodeProtocolNdjsonConnection` 是唯一同时拿得到这三个时刻的地方：
 *
 *     receivedAt   这一行读进来的墙钟（onData → dispatchLine）
 *     dispatchedAt 这一行真正进入 handler 的墙钟（串行队列 processing 之后）
 *     respondedAt  response 交给 stdout 的墙钟
 *
 *   三个都是 epoch 毫秒，因此能和 renderer 侧的 click / ACK 直接相减。**打点本身是判断
 *   依据**（after3 的 cli_pre_gap 全靠它），所以它的语义必须被钉住：
 *
 *     ① `queueWaitMs === dispatchedAt − receivedAt`：串行队列挡住请求的那一段；
 *     ② `handlerMs === respondedAt − dispatchedAt`：handler 本体（含帧编码 + outbox take）；
 *     ③ 只有**请求**打点（response / notification 不打，否则每次 RPC 会多两行噪音）；
 *     ④ 等待超过阈值额外升一条 warn（可检索信号），没超过就只有 debug 一行。
 *
 * 运行：`npx tsx --test scripts/test-request-timing.mjs`
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

const { ZCodeProtocolNdjsonConnection } = await import(
  new URL("../src/zcode-protocol/transport.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — fix-c19 protocol request timing (queue wait / handler / epoch fields)"
      : `TEST FAIL — fix-c19 protocol request timing (exit code ${code})`,
  );
});

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 最小 connection 夹具：PassThrough 当 stdio，logger 只记结构化字段。 */
function connectionFixture() {
  const records = [];
  const logger = {
    debug: (message, context) => records.push({ level: "debug", message, ...context }),
    info: () => {},
    warn: (message, context) => records.push({ level: "warn", message, ...context }),
    error: () => {},
    child() {
      return logger;
    },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim().length > 0) lines.push(JSON.parse(line));
    }
  });
  return { input, lines, logger, output, records };
}

function closeConnection(fixture) {
  fixture.input.end();
}

test("R1: 串行队列挡住第二个请求——queueWaitMs 就是挡住的那一段，三段墙钟单调", async () => {
  const fixture = connectionFixture();
  let releaseFirst = () => {};
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const seen = [];
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      seen.push({ method: message.method, at: Date.now() });
      if (message.method === "first/slow") await firstGate;
      // handler 本体给一段可测的耗时：否则「queueWait 吞掉 handler」这种口径漂移会在
      // 毫秒取整里被抹平（R1 的等式断言就失去区分度）。
      if (message.method === "second/fast") {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    fixture.input.write(`${JSON.stringify({ id: "r1", method: "first/slow", params: {} })}\n`);
    await waitFor(() => seen.length === 1, "第一个请求必须先进 handler");
    // 第二个请求到了，但串行队列被第一个占着：receivedAt 已经写下，dispatchedAt 还没。
    const queuedAt = Date.now();
    fixture.input.write(`${JSON.stringify({ id: "r2", method: "second/fast", params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(seen.length, 1, "串行队列：第一个没返回之前第二个不得进 handler");
    releaseFirst();
    await waitFor(() => fixture.records.length >= 2, "两条请求各留一行打点");

    const second = fixture.records.find((record) => record.requestId === "r2");
    assert.ok(second, "第二个请求必须有打点行");
    assert.equal(second.event, "zcode_protocol.request.timing");
    assert.equal(second.method, "second/fast");
    assert.ok(
      second.queueWaitMs >= 100,
      `第二个请求的 queueWaitMs 必须包含被挡住的那 ~120ms，实际 ${second.queueWaitMs}`,
    );
    assert.ok(
      second.receivedAt <= queuedAt + 50,
      "receivedAt 必须是「读进来」的时刻（不是进 handler 的时刻）",
    );
    assert.equal(
      second.queueWaitMs,
      Math.max(0, second.dispatchedAt - second.receivedAt),
      "queueWaitMs === dispatchedAt − receivedAt（口径不许漂）",
    );
    assert.equal(
      second.handlerMs,
      Math.max(0, second.respondedAt - second.dispatchedAt),
      "handlerMs === respondedAt − dispatchedAt（口径不许漂）",
    );
    assert.ok(
      second.receivedAt <= second.dispatchedAt && second.dispatchedAt <= second.respondedAt,
      "三个 epoch 时刻必须单调不减（否则相减出来的分段没有意义）",
    );
    assert.ok(
      second.handlerMs < second.queueWaitMs,
      "handler 本体（含那 60ms 的人为耗时）必须明显小于队列等待——否则这条打点分不开两件事",
    );
    assert.ok(
      second.handlerMs >= 50,
      `handlerMs 必须包含 handler 本体的 60ms，实际 ${second.handlerMs}`,
    );
  } finally {
    releaseFirst();
    closeConnection(fixture);
  }
});

test("R2: 没被挡住的请求 queueWaitMs 接近 0；response / notification 不打点", async () => {
  const fixture = connectionFixture();
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      if (!("method" in message)) return undefined;
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    fixture.input.write(`${JSON.stringify({ id: "fast", method: "quick/ping", params: {} })}\n`);
    await waitFor(() => fixture.records.length >= 1, "请求必须留一行打点");
    const record = fixture.records[0];
    assert.ok(
      record.queueWaitMs <= 20,
      `没被挡住的请求 queueWaitMs 必须接近 0，实际 ${record.queueWaitMs}`,
    );
    assert.equal(record.level, "debug", "正常耗时不升 warn（否则噪音会盖掉真信号）");

    // 反向 response（Agent 发起的 request 的回包）不得打点。
    fixture.input.write(`${JSON.stringify({ id: "res-1", result: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      fixture.records.filter((entry) => entry.requestId === "res-1").length,
      0,
      "response 不是请求，不得打 request.timing",
    );
  } finally {
    closeConnection(fixture);
  }
});

test("R3: 慢队列额外升一条 warn（可检索信号），字段与 debug 行同一份", async () => {
  const fixture = connectionFixture();
  let releaseFirst = () => {};
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      if (message.method === "first/slow") await gate;
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    fixture.input.write(`${JSON.stringify({ id: "s1", method: "first/slow", params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    fixture.input.write(`${JSON.stringify({ id: "s2", method: "second/fast", params: {} })}\n`);
    // 越过 `PROTOCOL_SLOW_QUEUE_WAIT_MS`（200ms）才该升 warn。
    await new Promise((resolve) => setTimeout(resolve, 260));
    releaseFirst();
    await waitFor(
      () => fixture.records.some((entry) => entry.level === "warn"),
      "队列等待越过阈值必须留一条 warn",
    );
    const warn = fixture.records.find((entry) => entry.level === "warn");
    assert.equal(warn.requestId, "s2", "warn 打在真正等过的那个请求上");
    assert.ok(
      warn.queueWaitMs >= 200,
      `warn 的 queueWaitMs 必须越过阈值，实际 ${warn.queueWaitMs}`,
    );
    assert.ok(
      fixture.records.some((entry) => entry.level === "debug" && entry.requestId === "s2"),
      "warn 不替代 debug 行：两行同一份字段都要在",
    );
  } finally {
    releaseFirst();
    closeConnection(fixture);
  }
});
