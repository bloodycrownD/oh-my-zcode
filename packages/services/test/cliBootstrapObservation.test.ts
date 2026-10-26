/**
 * `openTiming.cliBootstrapMs` 的观测判据回归（session-open-latency phase-0 C3）。
 *
 * 钉两件事：
 *   1. `resolveCliBootstrapObservation` 的判定矩阵——「spawned」只代表**本次 acquire
 *      触发或等待了 spawn**，client 对象是否存在不再参与判定；
 *   2. `ZCodeAgentProcessManager.getRuntimeSpawnSnapshot` 真的读进程事实（startedAt /
 *      generation / pid / 在途），而不是读 client 引用。
 *
 * 为什么必须有这层测试：旧实现 `getExistingClient() !== undefined → reused` 让冷开与热开
 * 观测同值，`uiViewReadyMs - cliBootstrapMs` 在冷开上根本算不出来；这类「观测面说谎」
 * 不会让任何行为测试变红，只能在判据层钉住。
 *
 * 运行形态：node_modules/.bin/tsx --test packages/services/test/cliBootstrapObservation.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCliBootstrapObservation,
  type ZCodeAgentRuntimeSpawnSnapshot,
} from "../src/zcode-agent/cliBootstrapObservation.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";

const quietStart = (startedAt: number, generation: number): ZCodeAgentRuntimeSpawnSnapshot => ({
  startedAt,
  generation,
  pid: 1000 + generation,
  startInFlight: false,
});

test("调用前没有任何 runtime → spawned（本次 subscribe 触发了 spawn）", () => {
  const observed = resolveCliBootstrapObservation(undefined, quietStart(2_000, 1));
  assert.equal(observed.cliProcessState, "spawned");
  assert.equal(observed.reason, "no-runtime-before");
  assert.equal(observed.spawnObserved, true);
});

test("调用前有在途 spawn → spawned（本次 subscribe 等了别人的 spawn，成本仍在自己延迟里）", () => {
  const observed = resolveCliBootstrapObservation({ startInFlight: true }, quietStart(2_000, 1));
  assert.equal(observed.cliProcessState, "spawned");
  assert.equal(observed.reason, "waited-in-flight-spawn");
  assert.equal(observed.spawnObserved, true);
});

test("调用前后同一个 runtime（时间戳/代次/pid 全同）→ reused，无 cliBootstrapMs", () => {
  const observed = resolveCliBootstrapObservation(quietStart(2_000, 1), quietStart(2_000, 1));
  assert.equal(observed.cliProcessState, "reused");
  assert.equal(observed.reason, "same-runtime");
  assert.equal(observed.spawnObserved, false);
});

test("调用期间换了新进程（代次/时间戳变了）→ spawned（旧 client 预建不能掩盖 spawn）", () => {
  const observed = resolveCliBootstrapObservation(quietStart(2_000, 1), quietStart(9_000, 2));
  assert.equal(observed.cliProcessState, "spawned");
  assert.equal(observed.reason, "runtime-replaced");
  assert.equal(observed.spawnObserved, true);
});

test("acquire 之后 runtime 被回收（after 缺失）→ reused（这次 acquire 没付 spawn 等待）", () => {
  const observed = resolveCliBootstrapObservation(quietStart(2_000, 1), undefined);
  assert.equal(observed.cliProcessState, "reused");
  assert.equal(observed.reason, "runtime-vanished-after-acquire");
  assert.equal(observed.spawnObserved, false);
});

/** 拿 private maps 的白盒句柄：本测试钉的就是「读进程事实」这一读法。 */
type ProcessManagerInternals = {
  processesByWorkspaceKey: Map<string, unknown>;
  startingByWorkspaceKey: Map<string, unknown>;
};

test("getRuntimeSpawnSnapshot：空的 manager 返回 undefined（区别于「有 runtime 无时间戳」）", () => {
  const manager = new ZCodeAgentProcessManager({});
  assert.equal(manager.getRuntimeSpawnSnapshot({ workspacePath: "/tmp/workspace-a" }), undefined);
});

test("getRuntimeSpawnSnapshot：有在途启动时只报 startInFlight", () => {
  const manager = new ZCodeAgentProcessManager({});
  const internals = manager as unknown as ProcessManagerInternals;
  internals.startingByWorkspaceKey.set("/tmp/workspace-b", Promise.resolve({}));
  assert.deepEqual(manager.getRuntimeSpawnSnapshot({ workspacePath: "/tmp/workspace-b" }), {
    startInFlight: true,
  });
});

test("getRuntimeSpawnSnapshot：已登记 runtime 时回传 startedAt/generation/pid（不看 client）", () => {
  const manager = new ZCodeAgentProcessManager({});
  const internals = manager as unknown as ProcessManagerInternals;
  const workspaceKey = "/tmp/workspace-c";
  // client 对象故意给空壳：判据必须只读进程事实，读到 client 才算过就等于把旧 bug 又写回来。
  internals.processesByWorkspaceKey.set(workspaceKey, {
    client: {},
    child: { pid: 4321, killed: false },
    runtimeIdentity: { generation: 7, identity: `${workspaceKey}:7:4321`, workspaceKey },
    startedAt: 1234,
    exited: false,
  });
  assert.deepEqual(manager.getRuntimeSpawnSnapshot({ workspacePath: "/tmp/workspace-c" }), {
    startedAt: 1234,
    generation: 7,
    pid: 4321,
    startInFlight: false,
  });
});
