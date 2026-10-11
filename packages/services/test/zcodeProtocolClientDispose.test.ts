import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeProtocolTransport } from "../src/zcode-agent/zcodeProtocolTransport.js";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

// FORK (upstream-v3.15.1-backport) T-PROC-1：spec §2.1 P1 #5——dispose 批量拒绝不得判为
// unhandledRejection，且 TDZ 回归（executor 内引用未就绪的 resultPromise）不得复现。
//
// 失效形态：dispose 与在飞观测长轮询竞态时，批量拒绝发生在调用方 await 之外——拒绝先于
// 调用方任何处置就被判 unhandledRejection（生产等价于未处理拒绝崩溃）。修复在 promise 的
// **创建点**挂 no-op catch；真实 awaiter 仍照常收到 rejection。

/** 进程级拒绝记录：装了监听器就由测试裁决，不会被 node:test 升级成整个 run 的失败。 */
function recordUnhandledRejections() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => process.off("unhandledRejection", onUnhandled) };
}

/** 最小 transport 替身：只提供 onMessage/onClose 的订阅面与 send/dispose，监听器集合外露给测试。 */
function createTransportStub() {
  const sent: unknown[] = [];
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<(event: unknown) => void>();
  const transport = {
    kind: "memory" as const,
    onMessage(listener: (message: unknown) => void) {
      messageListeners.add(listener);
      return { dispose: () => messageListeners.delete(listener) };
    },
    onClose(listener: (event: unknown) => void) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    async send(message: unknown) {
      sent.push(message);
    },
    dispose() {},
  };
  return {
    transport: transport as unknown as ZCodeProtocolTransport,
    sent,
    fireClose: (event: unknown) => {
      // 快照一份：监听器可能在触发过程中自我 dispose，直接迭代原集合会跳项。
      const listeners = Array.from(closeListeners);
      for (const listener of listeners) listener(event);
    },
  };
}

/** 让已落定的 rejection 走完 unhandled 判定（该判定在微任务清空后的下一个 tick 发生）。 */
function settleUnhandledRejectionVerdict() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("T-PROC-1 dispose 批量拒绝不产生 unhandledRejection，且真实 awaiter 仍收到 rejection", async () => {
  const unhandled = recordUnhandledRejections();
  try {
    const { transport, sent } = createTransportStub();
    const client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 60_000 });

    // 两个在飞请求：一个普通业务请求 + 一个观测长轮询（dispose 竞态的高发形态）。
    // 故意**不挂任何 handler**——修复前这一步之后 dispose 即判 unhandledRejection。
    const business = client.request("plugins/list");
    const observation = client.request("v4/session/read", {}, undefined, {
      lifecycle: "observation",
    });
    assert.equal(client.pendingRequestCount, 2);
    assert.equal(sent.length, 2);
    // TDZ 回归面：request 必须正常返回 promise（修复前 executor 内引用未就绪的
    // resultPromise 会每次调用直接抛 ReferenceError）。
    assert.equal(typeof business.then, "function");

    client.dispose();
    assert.equal(client.isDisposed, true);
    assert.equal(client.pendingRequestCount, 0);

    await settleUnhandledRejectionVerdict();
    assert.deepEqual(unhandled.seen, []);

    // 「静默」只针对 unhandled 判定：真实 awaiter 照常拿到取消语义的 rejection。
    await assert.rejects(business, /ZCode Protocol client disposed/);
    await assert.rejects(observation, /ZCode Protocol client disposed/);
  } finally {
    unhandled.stop();
  }
});

test("T-PROC-1 transport close 的批量拒绝同样静默（观测不参与 pending 计数语义不回归）", async () => {
  const unhandled = recordUnhandledRejections();
  try {
    const { transport, fireClose } = createTransportStub();
    const client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 60_000 });
    const business = client.request("plugins/list");
    const observation = client.request("v4/session/read", {}, undefined, {
      lifecycle: "observation",
    });
    assert.equal(client.pendingOperationRequestCount, 1);

    fireClose({ reason: "stdout_closed" });

    await settleUnhandledRejectionVerdict();
    assert.deepEqual(unhandled.seen, []);
    await assert.rejects(business, /ZCode agent transport closed: stdout_closed/);
    await assert.rejects(observation, /ZCode agent transport closed: stdout_closed/);
    assert.equal(client.pendingRequestCount, 0);

    client.dispose();
  } finally {
    unhandled.stop();
  }
});
