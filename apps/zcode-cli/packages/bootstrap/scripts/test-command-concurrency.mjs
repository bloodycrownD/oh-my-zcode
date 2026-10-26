#!/usr/bin/env node
/**
 * fix-c20 —— **命令级读写锁**（只读并发 / 变更独占 / 保序）与**分类表门禁**。
 *
 * ============================================================================
 * 为什么这条要有测试
 * ============================================================================
 *
 *   after3 把冷开剩下的 918ms 定位到 CLI 的串行请求队列：`subscribe` 到达后要等
 *   同一次打开里更早到达的 `v4/conversation/workflowRuns`（首次 handler 1s）跑完。
 *   改成「只读共享、变更独占」之后，**并发正确性不能靠「跑一遍没坏」证明**——
 *   它要覆盖的恰恰是「两条命令同时进来」这种时序，靠真实时序碰运气等于没测。
 *
 *   因此本文件把闸门当**确定性对象**测：每条用例用一个 deferred 手动卡住 handler，
 *   断言「谁在什么时候进了 handler」。不 sleep、不依赖机器速度。
 *
 * 覆盖（编号与任务单一致）：
 *
 *   ① G1/I1 两条只读**确实重叠**（不是假并发：第二条在第一条还卡着时就已经进 handler）
 *   ② G2/I2 变更独占：变更在飞时新只读被挡住；只读在飞时变更也要等它们排空
 *   ③ G3    变更之间保序，且**变更之后到达的只读不许插队**（写优先 FIFO）
 *   ④ G4    只读抛错不毒化锁（reject 与同步 throw 两条路都要放回槽位）
 *   ⑤ K5    分类漏登记即红（按 `server.ts` 的 `dispatchRequest` 逐 case 复核）
 *
 * 另有约束验证：旁路（session/stop）仍然越过一条正在飞的变更（I3）；
 * 同一 requestId 在飞时退化成独占（I4，见 transport 的 `inFlightRequestIds`）。
 *
 * 运行：`npx tsx --test scripts/test-command-concurrency.mjs`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

const { RequestConcurrencyGate } = await import(
  new URL("../src/zcode-protocol/request-concurrency-gate.ts", import.meta.url).href
);
const { COMMAND_CONCURRENCY, commandConcurrencyOf, readonlyCommandNames } = await import(
  new URL("../src/zcode-protocol/command-concurrency.ts", import.meta.url).href
);
const { zcodeProtocolMethods } = await import("@zcode/shared");
const { V4_METHODS } = await import("@zcode/shared/zcode-protocol-v4");
const { ZCodeProtocolNdjsonConnection } = await import(
  new URL("../src/zcode-protocol/transport.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — fix-c20 command concurrency (readonly overlap / writer exclusivity / FIFO / error isolation / classification gate)"
      : `TEST FAIL — fix-c20 command concurrency (exit code ${code})`,
  );
});

/** 让已排队的微任务跑完（闸门的释放发生在 `.then` 里）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/** 记录「谁进了 handler」的顺序表。 */
function waitOrderFrame() {
  const order = [];
  const started = new Map();
  const frame = (label) => ({
    enter() {
      order.push(label);
      const gate = deferred();
      started.set(label, gate);
      return gate.promise;
    },
    release() {
      const gate = started.get(label);
      assert.ok(gate, `未进入 handler 就不能释放：${label}`);
      gate.resolve();
      return tick();
    },
    fail(error = new Error(`boom:${label}`)) {
      const gate = started.get(label);
      assert.ok(gate, `未进入 handler 就不能失败：${label}`);
      gate.reject(error);
      return tick();
    },
  });
  return { frame, order };
}

// ───────────────────────────── 闸门单测（G1-G5） ─────────────────────────────

test("G1(①): 两条只读确实重叠——第二条在第一条还卡着时已进 handler", async () => {
  const gate = new RequestConcurrencyGate();
  const { frame, order } = waitOrderFrame();
  const a = frame("R1");
  const b = frame("R2");

  const p1 = gate.run("readonly", () => a.enter());
  const p2 = gate.run("readonly", () => b.enter());

  // 关键断言：两条都已在飞。假并发（串行）会在这里只剩一条。
  assert.deepEqual(order, ["R1", "R2"], "只读之间必须并发：第二条不得等第一条");
  assert.deepEqual(gate.inspect(), {
    activeReaders: 2,
    queued: 0,
    waitingWriters: 0,
    writer: false,
  });

  await a.release();
  await b.release();
  await p1;
  await p2;
  assert.equal(gate.isIdle(), true);
});

test("G2(②): 变更独占——只读在飞时变更等排空；变更在飞时新只读被挡住", async () => {
  const gate = new RequestConcurrencyGate();
  const { frame, order } = waitOrderFrame();
  const readers = [frame("R1"), frame("R2")];
  const writer = frame("W1");
  const late = frame("R3");

  const readerPromises = readers.map((reader) => gate.run("readonly", () => reader.enter()));
  assert.deepEqual(order, ["R1", "R2"]);

  const writerPromise = gate.run("mutating", () => writer.enter());
  assert.deepEqual(order, ["R1", "R2"], "只读还没排空，变更不得进入");

  // 只放开一条，仍然不能进（必须等**全部**只读排空）。
  await readers[0].release();
  assert.deepEqual(order, ["R1", "R2"], "只排空一条也不算排空");
  await readers[1].release();
  assert.deepEqual(order, ["R1", "R2", "W1"], "两条只读都结束后变更才能进");

  // 变更在飞时到达的只读必须等：这是独占的另一半（否则「先读后写」的次序会被读越过）。
  const latePromise = gate.run("readonly", () => late.enter());
  assert.deepEqual(order, ["R1", "R2", "W1"], "变更在飞时新只读不得进入");
  assert.deepEqual(gate.inspect(), {
    activeReaders: 0,
    queued: 1,
    waitingWriters: 0,
    writer: true,
  });

  await writer.release();
  assert.deepEqual(order, ["R1", "R2", "W1", "R3"], "变更结束后被挡住的只读才放行");

  await late.release();
  await Promise.all([...readerPromises, writerPromise, latePromise]);
  assert.equal(gate.isIdle(), true);
});

test("G3(③): 变更之间保序，且变更之后到达的只读不许插队（写优先 FIFO）", async () => {
  const gate = new RequestConcurrencyGate();
  const { frame, order } = waitOrderFrame();
  const w1 = frame("W1");
  const w2 = frame("W2");
  const r = frame("R-after-W");

  const p1 = gate.run("mutating", () => w1.enter());
  const p2 = gate.run("mutating", () => w2.enter());
  const p3 = gate.run("readonly", () => r.enter());
  assert.deepEqual(order, ["W1"], "变更之间严格串行");

  await w1.release();
  assert.deepEqual(order, ["W1", "W2"], "变更按到达顺序逐个进（W2 之后才轮到 R）");
  assert.deepEqual(order.includes("R-after-W"), false, "排在变更后面的只读不得越过它");

  await w2.release();
  assert.deepEqual(order, ["W1", "W2", "R-after-W"]);

  await r.release();
  await Promise.all([p1, p2, p3]);

  // 反向对照：只读**先**到达时，可以和别的只读一起先跑完再轮到变更。
  const { frame: frame2, order: order2 } = waitOrderFrame();
  const rA = frame2("R1");
  const rB = frame2("R2");
  const w = frame2("W");
  const q1 = gate.run("readonly", () => rA.enter());
  const q2 = gate.run("readonly", () => rB.enter());
  const q3 = gate.run("mutating", () => w.enter());
  assert.deepEqual(order2, ["R1", "R2"], "先到的只读可以并发，变更排在它们之后");
  await rA.release();
  await rB.release();
  assert.deepEqual(order2, ["R1", "R2", "W"]);
  await w.release();
  await Promise.all([q1, q2, q3]);
});

test("G4(④): 只读抛错不毒化锁——reject 与同步 throw 都放回槽位", async () => {
  const gate = new RequestConcurrencyGate();

  // (a) 异步 reject
  const rejection = new Error("readonly rejected");
  await assert.rejects(
    gate.run("readonly", async () => {
      throw rejection;
    }),
    /readonly rejected/,
  );
  assert.deepEqual(
    gate.inspect(),
    { activeReaders: 0, queued: 0, waitingWriters: 0, writer: false },
    "reject 之后读槽位必须归零（否则下一次变更永远等不到排空）",
  );

  // (b) 同步 throw（handler 连 promise 都没返回）
  await assert.rejects(
    gate.run("readonly", () => {
      throw new Error("readonly threw synchronously");
    }),
    /threw synchronously/,
  );
  assert.equal(gate.inspect().activeReaders, 0, "同步抛错同样要归零");

  // (c) 失败之后排队的变更照样能进：这才是「不毒化」的可观测结论。
  const { frame, order } = waitOrderFrame();
  const blocked = frame("R-blocked");
  const after = frame("W-after-error");
  const failing = gate.run("readonly", async () => {
    throw new Error("still failing");
  });
  const blockedPromise = gate.run("readonly", () => blocked.enter());
  const writerPromise = gate.run("mutating", () => after.enter());
  await assert.rejects(failing, /still failing/);
  // 只读还卡着 → 变更不能进；放开之后必须进得去（说明失败没有留下悬挂读者）。
  assert.deepEqual(order, ["R-blocked"]);
  await blocked.release();
  assert.deepEqual(order, ["R-blocked", "W-after-error"]);
  await after.release();
  await Promise.all([blockedPromise, writerPromise]);
  assert.equal(gate.isIdle(), true);
});

test("G5: waitForIdle 覆盖排队与在飞两个阶段，空闸门立即完成", async () => {
  const empty = new RequestConcurrencyGate();
  await empty.waitForIdle();

  const gate = new RequestConcurrencyGate();
  const { frame } = waitOrderFrame();
  const slow = frame("slow");
  const promise = gate.run("readonly", () => slow.enter());
  let idle = false;
  const waiting = gate.waitForIdle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false, "还有请求在飞时不许声称排空");
  await slow.release();
  await waiting;
  await promise;
  assert.equal(idle, true);
});

// ─────────────────────── 分类表门禁（⑤ K5 + 保守侧） ───────────────────────

const SERVER_SOURCE = readFileSync(
  new URL("../src/zcode-protocol/server.ts", import.meta.url),
  "utf8",
);

/** `dispatchRequest` 的 switch 主体（从方法声明到下一个方法声明）。 */
function dispatchSwitchSource() {
  const start = SERVER_SOURCE.indexOf("private async dispatchRequest(");
  assert.ok(start >= 0, "server.ts 里必须还存在 dispatchRequest（门禁的扫描锚点）");
  const end = SERVER_SOURCE.indexOf("private requireV4Gateway(", start);
  assert.ok(end > start, "dispatchRequest 之后必须紧跟 requireV4Gateway（扫描范围锚点）");
  return SERVER_SOURCE.slice(start, end);
}

test("K5(⑤): 每条已注册命令都有并发分类——按 dispatchRequest 逐 case 复核", () => {
  const source = dispatchSwitchSource();

  // 裸字符串 case 无法被解析成协议方法：出现即红（分类表按 wire 方法名键控）。
  assert.equal(
    /case\s+["'`]/.test(source),
    false,
    "dispatchRequest 里不许出现裸字符串 case：分类表按 V4_METHODS / zcodeProtocolMethods 的 wire 名键控",
  );

  const expressions = [...source.matchAll(/case\s+([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*:/g)].map(
    (match) => match[1],
  );
  // 防空跑：扫描不到 case 等于门禁什么都没检查。两条判据——
  // ①原始 `case` 行数与解析出的表达式数**相等**（解析器漏一种写法就红，不会静默少算）；
  // ②绝对数量在一个合理下界之上（锚点漂到别的方法就红）。
  const rawCaseCount = [...source.matchAll(/^\s*case\s+/gm)].length;
  assert.equal(
    expressions.length,
    rawCaseCount,
    `有 ${rawCaseCount - expressions.length} 条 case 没能解析成「表.常量」——写法变了或出现了裸字符串`,
  );
  assert.ok(
    rawCaseCount >= 90,
    `dispatchRequest 的 case 数量异常（${rawCaseCount}）——扫描锚点或写法变了，门禁会空跑`,
  );

  const tables = {
    V4_METHODS,
    zcodeProtocolMethods,
  };
  const unclassified = [];
  const unknownTable = [];
  for (const expression of expressions) {
    const [tableName, propertyName] = expression.split(".");
    const table = tables[tableName];
    if (!table) {
      unknownTable.push(expression);
      continue;
    }
    const wireName = table[propertyName];
    if (typeof wireName !== "string") {
      unknownTable.push(expression);
      continue;
    }
    if (COMMAND_CONCURRENCY[wireName] === undefined)
      unclassified.push(`${expression} (${wireName})`);
  }
  assert.deepEqual(unknownTable, [], "case 只许引用这两张协议方法表里的常量");
  assert.deepEqual(unclassified, [], "漏登记的命令必须为红（这是本任务最容易变成事故的地方）");
});

test("K6: 分类表本身穷尽协议方法表，未知方法名一律按变更（保守侧）", () => {
  const protocolNames = [...Object.values(zcodeProtocolMethods), ...Object.values(V4_METHODS)];
  const tableNames = Object.keys(COMMAND_CONCURRENCY);
  assert.deepEqual(
    [...new Set(protocolNames)].filter((name) => !tableNames.includes(name)),
    [],
    "协议方法表里的每条都必须有分类",
  );
  assert.deepEqual(
    tableNames.filter((name) => !protocolNames.includes(name)),
    [],
    "分类表里不许多出协议方法表之外的键（拼错的方法名会让漏登记看起来是绿的）",
  );
  for (const name of tableNames) {
    assert.ok(
      COMMAND_CONCURRENCY[name] === "readonly" || COMMAND_CONCURRENCY[name] === "mutating",
      `${name} 的分类值非法`,
    );
  }
  // 未知 / 未登记的方法名：一律变更。这是「拿不准归变更」的落点。
  assert.equal(commandConcurrencyOf("some/unknown-method"), "mutating");
  assert.equal(commandConcurrencyOf(""), "mutating");
  // 只读集合是显式白名单，不许包含任何名字里带 send/stop/update/delete 的命令
  // （若将来确实要归只读，必须改这条断言并把理由写进分类表的行注释）。
  const suspicious = readonlyCommandNames().filter((name) =>
    /(^|\/)(send|sendText|stop|cancel\w*|update\w*|delete|set\w*|begin|commit|abort|reset\w*|install|uninstall|move|archive\w*|grant)$/.test(
      name,
    ),
  );
  assert.deepEqual(suspicious, [], "只读白名单里出现了写面命令");
  // 两条 legacy 写面**刻意**留在变更侧：形状像读（末段是 read / subscribe），但
  // `readSession` 写 `record.deliveryKind`、`subscribeSession` 还写 `legacyStreamSubscribed`
  // ——都是客户端可决定的服务端状态。上面那条名字正则抓不到它们，所以在这里单独钉死：
  // 被顺手挪进只读时这条立刻红。
  for (const legacyWrite of [
    zcodeProtocolMethods.sessionRead,
    zcodeProtocolMethods.sessionSubscribe,
  ]) {
    assert.equal(
      commandConcurrencyOf(legacyWrite),
      "mutating",
      `${legacyWrite} 会写 record 上的客户端可决定状态，不得归只读（理由见 command-concurrency.ts 的行注释）`,
    );
  }
  // 冷开路径上的三个决定性命令必须在只读侧（否则 918ms 那一段白改）。
  for (const critical of [
    V4_METHODS.conversationSubscribe,
    V4_METHODS.conversationWorkflowRuns,
    V4_METHODS.conversationRowsRange,
  ]) {
    assert.equal(commandConcurrencyOf(critical), "readonly", `${critical} 必须在只读侧`);
  }
  // 停止/取消旁路仍然只认这两条（分类不影响旁路，但名单本身不许悄悄扩大）。
  const bypassSource = readFileSync(
    new URL("../src/zcode-protocol/transport.ts", import.meta.url),
    "utf8",
  );
  const bypassBody = bypassSource.slice(
    bypassSource.indexOf("private shouldBypassProcessingQueue("),
    bypassSource.indexOf("private async handleMessage("),
  );
  assert.equal(
    (bypassBody.match(/zcodeProtocolMethods\./g) ?? []).length,
    2,
    "旁路名单必须仍然只有 session/stop 与 workspace/cancelGenerateText 两条",
  );
});

// ─────────────────────── 接线（真实 connection） ───────────────────────

function connectionFixture() {
  const records = [];
  const logger = {
    child() {
      return logger;
    },
    debug: (message, context) => records.push({ level: "debug", message, ...context }),
    error: () => {},
    info: () => {},
    warn: (message, context) => records.push({ level: "warn", message, ...context }),
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

function writeRequest(fixture, id, method) {
  fixture.input.write(`${JSON.stringify({ id, method, params: {} })}\n`);
}

test("I1(①接线): 两条只读命令在真实 transport 上并发进入 handler", async () => {
  const fixture = connectionFixture();
  const { frame, order } = waitOrderFrame();
  const first = frame("subscribe");
  const second = frame("workflowRuns");
  const gates = {
    [V4_METHODS.conversationSubscribe]: first,
    [V4_METHODS.conversationWorkflowRuns]: second,
  };
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      const gate = gates[message.method];
      if (gate) await gate.enter();
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    writeRequest(fixture, "s1", V4_METHODS.conversationWorkflowRuns);
    writeRequest(fixture, "s2", V4_METHODS.conversationSubscribe);
    assert.deepEqual(
      order,
      ["workflowRuns", "subscribe"],
      "两条只读必须同时进 handler（改造前 subscribe 会排在 workflowRuns 后面等）",
    );
    await first.release();
    await second.release();
    await tick();
    assert.equal(fixture.lines.filter((line) => line.result).length, 2, "两条都要有响应");
  } finally {
    fixture.input.end();
    await connection.waitForClose();
  }
});

test("I2(②接线): 变更在飞时只读被挡住；只读在飞时变更等排空", async () => {
  const fixture = connectionFixture();
  const { frame, order } = waitOrderFrame();
  const reader = frame("rowsRange");
  const writer = frame("command");
  const lateReader = frame("turnDirectory");
  const gates = {
    [V4_METHODS.command]: writer,
    [V4_METHODS.conversationRowsRange]: reader,
    [V4_METHODS.conversationTurnDirectory]: lateReader,
  };
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      const gate = gates[message.method];
      if (gate) await gate.enter();
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    writeRequest(fixture, "1", V4_METHODS.conversationRowsRange);
    writeRequest(fixture, "2", V4_METHODS.command);
    writeRequest(fixture, "3", V4_METHODS.conversationTurnDirectory);
    assert.deepEqual(order, ["rowsRange"], "只读在飞时变更必须等它排空，且后续只读也一起等");

    await reader.release();
    assert.deepEqual(order, ["rowsRange", "command"], "只读排空后变更进入");
    assert.deepEqual(order.includes("turnDirectory"), false, "变更在飞时新只读不得进入");

    await writer.release();
    assert.deepEqual(order, ["rowsRange", "command", "turnDirectory"]);
    await lateReader.release();
    await tick();
    assert.equal(fixture.lines.filter((line) => line.result).length, 3);
  } finally {
    fixture.input.end();
    await connection.waitForClose();
  }
});

test("I3: 停止命令仍然旁路——变更在飞时 stop 照样进 handler", async () => {
  const fixture = connectionFixture();
  const { frame, order } = waitOrderFrame();
  const writer = frame("command");
  const stop = frame("stop");

  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      if (message.method === V4_METHODS.command)
        return await writer.enter().then(() => ({ id: message.id, result: {} }));
      if (message.method === zcodeProtocolMethods.sessionStop) {
        return await stop.enter().then(() => ({ id: message.id, result: {} }));
      }
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    writeRequest(fixture, "1", V4_METHODS.command);
    assert.deepEqual(order, ["command"]);
    writeRequest(fixture, "2", zcodeProtocolMethods.sessionStop);
    await tick();
    assert.deepEqual(
      order,
      ["command", "stop"],
      "stop 必须能越过一条在飞的长变更（否则「停止」永远发不出去）",
    );
    await stop.release();
    await writer.release();
    await tick();
    assert.equal(fixture.lines.filter((line) => line.result).length, 2);
  } finally {
    fixture.input.end();
    await connection.waitForClose();
  }
});

test("I4: 同一 requestId 在飞时退化成独占（outbox 按 id 键控，并发会互相覆盖）", async () => {
  const fixture = connectionFixture();
  const { frame, order } = waitOrderFrame();
  const first = frame("first");
  const second = frame("second");
  let calls = 0;
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      calls += 1;
      const gate = calls === 1 ? first : second;
      await gate.enter();
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    // 同一条只读命令、同一个 requestId：客户端违约，必须被降级成独占而不是并发。
    writeRequest(fixture, "dup", V4_METHODS.conversationRowsRange);
    writeRequest(fixture, "dup", V4_METHODS.conversationRowsRange);
    assert.deepEqual(order, ["first"], "同 requestId 的第二条不得与第一条并发");
    await first.release();
    assert.deepEqual(order, ["first", "second"], "第一条结束后第二条才进");
    await second.release();
    await tick();
    const timing = fixture.records.filter(
      (record) => record.event === "zcode_protocol.request.timing",
    );
    assert.equal(timing.length, 2);
    assert.deepEqual(
      timing.map((record) => record.dispatchClass),
      ["readonly", "mutating"],
      "第二条被降级成 mutating（dispatchClass 是这件事的唯一可检索证据）",
    );
  } finally {
    fixture.input.end();
    await connection.waitForClose();
  }
});

test("I5: 未知方法名按变更串行——不可路由的字符串不会借并发偷跑", async () => {
  const fixture = connectionFixture();
  const { frame, order } = waitOrderFrame();
  const first = frame("first");
  const second = frame("second");
  const seen = [];
  const connection = new ZCodeProtocolNdjsonConnection({
    handleMessage: async (message) => {
      seen.push(message.method);
      const gate = seen.length === 1 ? first : second;
      await gate.enter();
      return { id: message.id, result: {} };
    },
    input: fixture.input,
    logger: fixture.logger,
    output: fixture.output,
  });
  connection.start();
  try {
    writeRequest(fixture, "1", "first/slow");
    writeRequest(fixture, "2", "second/fast");
    assert.deepEqual(order, ["first"], "未知方法名之间保持串行（保守侧）");
    await first.release();
    assert.deepEqual(order, ["first", "second"]);
    await second.release();
    await tick();
  } finally {
    fixture.input.end();
    await connection.waitForClose();
  }
});
