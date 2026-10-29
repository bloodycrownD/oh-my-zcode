#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）C1 / spec §2.1 P4 #26——订阅 buffer 字节钳位到帧界。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * topic publisher 给每个订阅者累积"待补投 delta"，上限原先是一个固定的 1 MiB 下限：wire snapshot
 * 上界（`wireSnapshotBytesUpperBound`）比它大时，一条合法的 >1MiB 单帧 delta 会被判溢出、订阅者被
 * 降级成 resync——正常的大快照推送于是走成"反复 resync"。修复把上限钳到
 * `logicalFrameAssemblyMaxBytes - 64KiB` 与 snapshot 上界之间，并且**两个调用点统一**：
 *   - `appendDeltas`（普通 delta 扇出：按 seq 记账 + 扇出）；
 *   - `publishMagicContextUsage`（magic-context 用量推送——红线②共用同一条 delta 扇出）。
 *
 * 断言口径（cr-func-2 探针 6 条的转正版）：
 *   场景 A  ingest 抬升 bound 后，>1MiB 单条 delta 被缓冲（旧 1MiB 硬限会溢出）
 *   场景 B  snapshot 上界 3MiB 时同一条 delta 被缓冲，bufferBytes 突破旧下限
 *   场景 C  上限按 16MiB-64KiB 封顶：逼近 cap 仍缓冲、越过 cap 即溢出（真 cap 断言，非无界缓冲）
 *   场景 D  publishMagicContextUsage 经同一 appendDeltas，推送路径未被钳位改动破坏
 *   场景 E  积压超过当前 bound 时仍溢出降级（上限真实执行，不是无界缓冲）
 *
 * 运行：`npx tsx --test scripts/test-publisher-buffer-clamp.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { ConversationTopicPublisher } =
  await import("../src/zcode-protocol-v4/conversation-topic-publisher.ts");

const SESSION_ID = "ses_clamp_probe";
const EPOCH = "epoch-clamp";
const MiB = 1024 * 1024;

let seq = 0;
function event(type, payload, turnId) {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: SESSION_ID,
    ...(turnId === undefined ? {} : { turnId }),
    type,
    timestamp: new Date(1_700_000_000_000 + seq),
    traceId: `trace-${seq}`,
    sequenceNumber: seq,
    payload,
  };
}

function makePublisher() {
  return new ConversationTopicPublisher(SESSION_ID, EPOCH, { now: () => 1_000 });
}

function subscribe(publisher, connectionId) {
  publisher.subscribe({ connectionId, deliveryProfile: "continuous" });
  const subscriptions = [...publisher.subscriptions.values()];
  assert.equal(subscriptions.length, 1, "期望一个订阅实例");
  return subscriptions[0];
}

/** 往同一轮继续追加一条模型正文 delta。 */
function appendTextDelta(publisher, bytes) {
  publisher.ingest(
    event(
      "model_streaming",
      {
        kind: "text_delta",
        delta: "y".repeat(bytes),
        assistantMessageId: "msg-a-1",
        partId: "part-1",
        done: false,
      },
      "turn-1",
    ),
  );
}

/** 灌一条 >1MiB 的模型正文 delta（先抬升 wire snapshot 上界的正常形态）。 */
function ingestLargeTextDelta(publisher) {
  publisher.ingest(
    event("turn_started", { turnNumber: 1, input: "probe", messageId: "msg-user-1" }, "turn-1"),
  );
  publisher.ingest(
    event(
      "model_streaming",
      {
        kind: "text_start",
        assistantMessageId: "msg-a-1",
        partId: "part-1",
        delta: "",
        done: false,
      },
      "turn-1",
    ),
  );
  publisher.ingest(
    event(
      "model_streaming",
      {
        kind: "text_delta",
        delta: "x".repeat(Math.floor(1.5 * MiB)),
        assistantMessageId: "msg-a-1",
        partId: "part-1",
        done: false,
      },
      "turn-1",
    ),
  );
}

test("场景 A：ingest 先抬升 bound，>1MiB 单条 delta 被缓冲（旧 1MiB 硬限会溢出降级）", () => {
  const publisher = makePublisher();
  const subscription = subscribe(publisher, "conn-a");
  publisher.wireSnapshotBytesUpperBound = 0; // 白盒：起点为缺省 0
  ingestLargeTextDelta(publisher);
  assert.equal(
    subscription.resyncRequired,
    false,
    `resyncRequired=${String(subscription.resyncRequired)} bufferBytes=${subscription.bufferBytes}`,
  );
  assert.equal(
    publisher.wireSnapshotBytesUpperBound >= subscription.bufferBytes,
    true,
    `bound=${publisher.wireSnapshotBytesUpperBound} bufferBytes=${subscription.bufferBytes}`,
  );
});

test("场景 B：snapshot 上界 3MiB——同一条 delta 被缓冲，bufferBytes 突破旧 1MiB 下限", () => {
  const publisher = makePublisher();
  const subscription = subscribe(publisher, "conn-b");
  publisher.wireSnapshotBytesUpperBound = 3 * MiB;
  ingestLargeTextDelta(publisher);
  assert.equal(subscription.resyncRequired, false);
  assert.equal(
    subscription.bufferBytes > publisher.subscriberBufferMaxBytes,
    true,
    `bufferBytes=${subscription.bufferBytes} maxBytes=${publisher.subscriberBufferMaxBytes}`,
  );
});

test("场景 C：上界超大时按 16MiB-64KiB 封顶——cap 真实执行（不是无界缓冲）", () => {
  const capBytes = 16 * MiB - 64 * 1024;
  const publisher = makePublisher();
  const subscription = subscribe(publisher, "conn-c");
  // 白盒：病态大上界。这里必须直连扇出管线（appendDeltas），不能换 ingest 灌 delta——ingest
  // 会用精确测量的 wire snapshot 回写 wireSnapshotBytesUpperBound，白盒设的 64MiB 会被覆盖，
  // 钳位上限随即退化成 1MiB 下限，真 cap 这一步就永远测不到。
  publisher.wireSnapshotBytesUpperBound = 64 * MiB;

  // 1) 累计 delta 逼近 cap：未到 cap 前必须仍然缓冲（旧 1MiB 硬限会在这里就降级 resync）。
  publisher.appendDeltas(publisher.currentSeq, [
    { op: "row.delta", rowId: 1, path: "text", append: "y".repeat(capBytes - 2 * 1024) },
  ]);
  assert.equal(
    subscription.resyncRequired,
    false,
    `bufferBytes=${subscription.bufferBytes} cap=${capBytes}`,
  );
  assert.equal(
    subscription.bufferBytes > 15 * MiB,
    true,
    `bufferBytes=${subscription.bufferBytes}`,
  );

  // 2) 越过 cap 即溢出降级：外层 min(…, 16MiB-64KiB) 钳位若缺失（上限变成 64MiB），
  // 这一步会继续缓冲、resyncRequired 保持 false。
  publisher.appendDeltas(publisher.currentSeq, [
    { op: "row.delta", rowId: 2, path: "text", append: "z".repeat(4 * 1024) },
  ]);
  assert.equal(
    subscription.resyncRequired,
    true,
    `bufferBytes=${subscription.bufferBytes} cap=${capBytes}`,
  );
});

test("场景 D：publishMagicContextUsage 经同一 appendDeltas——钳位路径生效且不抛错", () => {
  const publisher = makePublisher();
  const subscription = subscribe(publisher, "conn-d");
  publisher.wireSnapshotBytesUpperBound = 3 * MiB;
  publisher.publishMagicContextUsage({
    usedTokens: 12_345,
    contextWindow: 200_000,
    percentage: 6.2,
  });
  // 红线②：magic-context 推送与普通 delta 共用同一条扇出，钳位改动不得把它打掉——
  // 断言真的进了订阅者 buffer（不是「没抛错也算过」）。
  assert.equal(subscription.bufferBytes > 0, true, `bufferBytes=${subscription.bufferBytes}`);
});

test("场景 E：积压超过当前 bound——上限真实执行（溢出降级，不是无界缓冲）", () => {
  const publisher = makePublisher();
  const subscription = subscribe(publisher, "conn-e");
  ingestLargeTextDelta(publisher);
  publisher.wireSnapshotBytesUpperBound = 0; // 白盒：模拟 bound 远小于已有积压
  appendTextDelta(publisher, Math.floor(1.2 * MiB));
  assert.equal(
    subscription.resyncRequired,
    true,
    `resyncRequired=${String(subscription.resyncRequired)} bufferBytes=${subscription.bufferBytes} bound=${publisher.wireSnapshotBytesUpperBound}`,
  );
});
