import assert from "node:assert/strict";
import test from "node:test";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";

// FORK (upstream-v3.15.1-backport) T-PROC-3：spec §2.1 P1 #6——`reportError:false` 的 cleanup
// 路径必须在 **promise 创建点**无条件挂 catch，rejection 不得判为 unhandledRejection。
//
// 失效形态：dispose 与重试编排竞态时，cleanup 的 rejection 可能先于调用方 await 挂靠被判
// unhandledRejection（生产等价于未处理拒绝）。修复后 reportError:false 静默、其余照旧写 error
// 日志；统一上报仍由 cleanupManagedProcessWithRetry 的 await/catch 完成（告警语义不变）。
//
// 这里走的是**生产代码本体**：拿 prototype 上的 cleanupManagedProcess（TS 的 private 只是编译期）
// 配一个手工 managed 替身。不用真 spawn 是因为"让进程树回收失败"没有确定性构造法，而本用例要
// 钉的判据（创建点 catch）与进程树无关。

type CleanupSeam = {
  cleanupManagedProcess(
    managed: unknown,
    reason: string,
    options?: { reportError?: boolean },
  ): Promise<void>;
};

/** managed 替身：cleanupManagedProcess 会读到的字段（其余字段在 reportError:false 路径上不可达）。 */
function createManagedStub(error: Error) {
  const disposeCalls: string[] = [];
  return {
    managed: {
      client: {
        disposeAndWait() {
          disposeCalls.push("disposeAndWait");
          return Promise.reject(error);
        },
      },
      child: { pid: 4242 },
      runtimeIdentity: {
        workspaceKey: "/tmp/t-proc-3",
        identity: "/tmp/t-proc-3:1:4242",
      },
      workspace: { workspacePath: "/tmp/t-proc-3" },
      exited: false,
      readyReported: false,
      spawned: true,
      startedAt: Date.now(),
      runtimeInstanceId: "agent-t-proc-3",
    },
    disposeCalls,
  };
}

/** 让已落定的 rejection 走完 unhandled 判定（微任务清空后的下一个 tick 才发生）。 */
function settleUnhandledRejectionVerdict() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function recordUnhandledRejections() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => process.off("unhandledRejection", onUnhandled) };
}

test("T-PROC-3 reportError:false 的 cleanup rejection 不产生 unhandledRejection", async () => {
  const unhandled = recordUnhandledRejections();
  try {
    const manager = new ZCodeAgentProcessManager({});
    const seam = ZCodeAgentProcessManager.prototype as unknown as CleanupSeam;
    const { managed, disposeCalls } = createManagedStub(new Error("process tree cleanup failed"));

    // 故意不 await、也不挂 handler：修复前这里就是 unhandledRejection 的窗口。
    const cleanup = seam.cleanupManagedProcess.call(manager, managed, "protocol-close", {
      reportError: false,
    });
    assert.equal(disposeCalls.length, 1);

    await settleUnhandledRejectionVerdict();
    assert.deepEqual(unhandled.seen, []);

    // 静默只针对 unhandled 判定：await 的调用方照样拿到 rejection（重试编排据此重试/上报）。
    await assert.rejects(cleanup, /process tree cleanup failed/);
  } finally {
    unhandled.stop();
  }
});

test("T-PROC-3 同一次 cleanup 复用同一个 promise（幂等回收）", async () => {
  const manager = new ZCodeAgentProcessManager({});
  const seam = ZCodeAgentProcessManager.prototype as unknown as CleanupSeam;
  const { managed, disposeCalls } = createManagedStub(new Error("cleanup failed"));

  const first = seam.cleanupManagedProcess.call(manager, managed, "protocol-close", {
    reportError: false,
  });
  const second = seam.cleanupManagedProcess.call(manager, managed, "protocol-close-retry", {
    reportError: false,
  });
  assert.equal(first, second, "同一 managed 的 cleanup 必须复用同一个 promise");
  assert.equal(disposeCalls.length, 1);
  await assert.rejects(first, /cleanup failed/);
});

test("T-PROC-3 reportError 非 false 时不向上抛（告警语义不变）", async () => {
  const manager = new ZCodeAgentProcessManager({});
  const seam = ZCodeAgentProcessManager.prototype as unknown as CleanupSeam;
  const { managed } = createManagedStub(new Error("cleanup failed"));

  const cleanup = seam.cleanupManagedProcess.call(manager, managed, "protocol-close", {});
  // 默认路径只写 error 日志；返回的 promise 仍会 reject（由调用方 await 决定如何上报）。
  await assert.rejects(cleanup, /cleanup failed/);
});
