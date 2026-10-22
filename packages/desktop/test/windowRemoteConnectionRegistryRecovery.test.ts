// T-RM2 / T-RC（upstream-v316-fullsync §phase-remote-core Step 17）：registry 恢复状态机纯逻辑。
//
// 覆盖（上游 vitest 形态改写为 node:test；fake 时钟以注入短延时数组 + 显式事件驱动替代）：
// 1) closePhase 三态流转：recoverable close → recovering；recovering 中终态 → terminal；
//    terminal 后新物理连接到达 → 重挂 recovering 新屏障。
// 2) recovery promise 屏障：recovering 期间 connect 等待 recoveryReady；failRecovery 后拒绝。
// 3) 换代与回滚：replaceDisconnectedSessions 换代 commit；onSessionReconnected 抛错时
//    provisional session 回收、previous 恢复 disconnected（rollbackRecoveryReplacements）。
// 4) commit 不可逆边界：commit 后旁路异常不得把已发布 generation 塞回回滚路径。
// 5) B5 竞态回归：connect 的 await 窗口内断连（terminal close 推进 epoch）后，
//    不再无条件 online，completion 被状态机裁决拒绝。
// 6) cancelConnect 迟到 completion 防护（docker）：取消后摘复用表，迟到成功不得删除或
//    复活同 key 新连接。
//
// 运行形态：worktree 根 `node --import tsx --test packages/desktop/test/windowRemoteConnectionRegistryRecovery.test.ts`

import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTarget } from "@zcode/shared";
import {
  createWindowRemoteConnectionRegistry,
  WindowRemoteConnectionUnavailableError,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "../src/host/windowRemoteConnectionRegistry.js";

interface FakeHandleServices {
  marker: string;
}

type FakeCapabilities = {
  sourceServerId?: string;
  persistentSourceConnection?: boolean;
};

interface FakeHandle extends WindowRemoteConnectionHandle<FakeHandleServices, FakeCapabilities> {
  emitClose(event: WindowRemoteConnectionCloseEvent): void;
  emitReconnect(): void;
}

const sshTarget: RemoteTarget = { kind: "ssh", host: "h1", username: "u1" };
const dockerTarget: RemoteTarget = { kind: "docker", container: "c1" };

function createHarness(options: {
  target?: RemoteTarget;
  capabilities?: FakeCapabilities;
  connectGate?: {
    resolve(handle: FakeHandle): void;
  };
  onSessionReconnected?: (event: {
    previous: { remoteSessionId: string; state: string };
    current: { remoteSessionId: string; state: string };
    services: FakeHandleServices;
    isCurrent(): boolean;
    commit(): boolean;
  }) => void | Promise<void>;
  prepareWorkspaceIdentity?: () => Promise<void>;
}) {
  const handles: FakeHandle[] = [];
  const registry = createWindowRemoteConnectionRegistry<FakeHandleServices, FakeCapabilities>({
    connect: async () => {
      const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
      const reconnectListeners = new Set<() => void>();
      const handle: FakeHandle = {
        services: { marker: `svc-${handles.length + 1}` },
        ...(options.capabilities ? { capabilities: { ...options.capabilities } } : {}),
        dispose() {},
        onDidClose(listener) {
          closeListeners.add(listener);
          return { dispose: () => closeListeners.delete(listener) };
        },
        onDidReconnect(listener) {
          reconnectListeners.add(listener);
          return { dispose: () => reconnectListeners.delete(listener) };
        },
        emitClose(event) {
          for (const listener of closeListeners) listener(event);
        },
        emitReconnect() {
          for (const listener of reconnectListeners) listener();
        },
      };
      handles.push(handle);
      // connectGate 只拦第一个 handle（迟到 completion 场景）；后续 connect 直接返回。
      if (options.connectGate && handles.length === 1) {
        return await new Promise<FakeHandle>((resolve) => {
          options.connectGate.resolve = resolve;
        });
      }
      return handle;
    },
    createId: (() => {
      let sequence = 0;
      return () => `session-${++sequence}`;
    })(),
    resolveSourceServerId: (handle) => handle.capabilities?.sourceServerId,
    shouldKeepConnectionAlive: (handle) => handle.capabilities?.persistentSourceConnection === true,
    onSessionReconnected: options.onSessionReconnected,
    prepareWorkspaceIdentity: options.prepareWorkspaceIdentity,
    logicalReplacementRetryDelaysMs: [5, 5, 5],
    wslIdleTtlMs: 5,
  });
  return { registry, handles };
}

function connectSession(
  registry: ReturnType<
    typeof createWindowRemoteConnectionRegistry<FakeHandleServices, FakeCapabilities>
  >,
  target: RemoteTarget,
) {
  return registry.connect({
    requestId: `req-${Math.random()}`,
    target,
    remoteAssets: {},
    workspacePath: "/ws",
    workspaceIdentity: "ident-1",
  });
}

test("T-RM2 closePhase 三态：recoverable → recovering，终态 → terminal，新连接重挂 recovering", async () => {
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
  });
  await connectSession(registry, sshTarget);
  const handle = handles[0]!;
  handle.emitClose({ exitCode: null, signal: null, recoverable: true, recoveryAttempt: 1 });
  const [online] = registry.listConnections();
  assert.equal(online?.state, "disconnected");

  // recovering 中终态 close：epoch 推进 + 屏障拒绝，closePhase 落 terminal。
  handle.emitClose({
    exitCode: null,
    signal: null,
    recoverable: false,
    error: "budget exhausted",
    reasonCode: "remote-recovery-budget-exhausted",
  });

  // 新物理连接到达（onDidReconnect）：terminal 不得污染新线路，重挂 recovering 新屏障。
  handle.emitReconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [afterReconnect] = registry.listConnections();
  assert.equal(afterReconnect?.state, "online");
});

test("T-RM2 recovery 屏障：等待者被 failRecovery 拒绝，错误携带 reasonCode", async () => {
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
  });
  await connectSession(registry, sshTarget);
  const handle = handles[0]!;
  handle.emitClose({ exitCode: null, signal: null, recoverable: true, recoveryAttempt: 1 });

  // 手动 join 挂在 recovering entry 的 recoveryReady 屏障上。
  const waiter = connectSession(registry, sshTarget).then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  handle.emitClose({
    exitCode: null,
    signal: null,
    recoverable: false,
    error: "terminal failure",
    reasonCode: "source-server-upgrade-required",
    retryable: false,
  });
  const outcome = await waiter;
  assert.notEqual(outcome, "resolved");
  assert.equal((outcome as { code?: string }).code, "source-server-upgrade-required");
});

test("T-RM2 换代：reconnect 后 provisional replacement commit，旧 session 移除", async () => {
  const reconnectEvents: Array<{ previous: string; current: string }> = [];
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
    onSessionReconnected: (event) => {
      reconnectEvents.push({
        previous: event.previous.remoteSessionId,
        current: event.current.remoteSessionId,
      });
      event.commit();
    },
  });
  const descriptor = await connectSession(registry, sshTarget);
  const handle = handles[0]!;
  handle.emitClose({ exitCode: null, signal: null, recoverable: true, recoveryAttempt: 1 });
  assert.ok(
    registry
      .listSessions()
      .some((s) => s.remoteSessionId === descriptor.remoteSessionId && s.state === "disconnected"),
  );

  handle.emitReconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(reconnectEvents.length, 1);
  const sessions = registry.listSessions();
  assert.equal(sessions.length, 1);
  assert.notEqual(sessions[0]!.remoteSessionId, descriptor.remoteSessionId);
  assert.equal(sessions[0]!.state, "online");
  assert.equal(sessions[0]!.generation, descriptor.generation + 1);
});

test("T-RM2 换代回滚：commit 前 epoch 违例（终态 close），previous 恢复 disconnected", async () => {
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
    onSessionReconnected: (event) => {
      // 换代窗口内物理线路再次终态：epoch 推进并回滚 provisional replacement。
      handles[0]!.emitClose({ exitCode: null, signal: null, recoverable: false });
      assert.equal(event.commit(), false);
      throw new Error("stale replacement");
    },
  });
  const descriptor = await connectSession(registry, sshTarget);
  const handle = handles[0]!;
  handle.emitClose({ exitCode: null, signal: null, recoverable: true, recoveryAttempt: 1 });
  handle.emitReconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const sessions = registry.listSessions();
  assert.equal(sessions.length, 1);
  // 回滚后上一代 logical session 恢复 disconnected，provisional id 不残留。
  assert.equal(sessions[0]!.remoteSessionId, descriptor.remoteSessionId);
  assert.equal(sessions[0]!.state, "disconnected");
});

test("T-RM2 commit 不可逆边界：提交后旁路异常不上报回滚，generation 保持 online", async () => {
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
    onSessionReconnected: (event) => {
      assert.equal(event.commit(), true);
      throw new Error("post-commit notification failure");
    },
  });
  const descriptor = await connectSession(registry, sshTarget);
  const handle = handles[0]!;
  handle.emitClose({ exitCode: null, signal: null, recoverable: true, recoveryAttempt: 1 });
  handle.emitReconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const sessions = registry.listSessions();
  assert.equal(sessions.length, 1);
  assert.notEqual(sessions[0]!.remoteSessionId, descriptor.remoteSessionId);
  assert.equal(sessions[0]!.state, "online");
});

test("B5 竞态回归：await 窗口内终态断连，completion 不再无条件 online", async () => {
  let releaseIdentity: (() => void) | undefined;
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
    prepareWorkspaceIdentity: () =>
      new Promise<void>((resolve) => {
        releaseIdentity = resolve;
      }),
  });
  const pending = connectSession(registry, sshTarget);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const handle = handles[0]!;
  // entry.ready 已 resolve、prepareWorkspaceRuntime 尚在 await：close 在此窗口内推进 epoch。
  handle.emitClose({ exitCode: null, signal: null, recoverable: false, error: "link down" });
  releaseIdentity?.();

  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof WindowRemoteConnectionUnavailableError,
  );
  // session 不允许以 online 残留。
  assert.ok(registry.listSessions().every((session) => session.state !== "online"));
});

test("cancelConnect 迟到 completion 防护（docker）：取消摘复用表，迟到成功不删除或复活新连接", async () => {
  const connectGate: { resolve(handle: FakeHandle): void } = {} as never;
  const { registry, handles } = createHarness({ target: dockerTarget, connectGate });
  const requestId = "req-docker-cancel";
  const pending = registry.connect({
    requestId,
    target: dockerTarget,
    remoteAssets: {},
    workspacePath: "/ws",
    workspaceIdentity: "ident-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(handles.length === 1, "fake connect 应已创建 handle");
  // entry 仍在 connecting（fake connect 挂起）时取消：docker 分支按对象身份摘复用表。
  registry.cancelConnect(requestId);
  const cancelled = await pending.then(
    () => "resolved" as const,
    () => "cancelled" as const,
  );
  assert.equal(cancelled, "cancelled");

  // 同 key 新连接先建：迟到 completion 不得把它从复用表摘掉。
  const second = connectSession(registry, dockerTarget);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 被取消 entry 的 fake connect 迟到成功：无 waiter 的迟到结果必须立即释放，
  // 且不得删除同 key 的新 owner。
  connectGate.resolve(handles[0]!);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const descriptor = await second;
  assert.ok(registry.listSessions().some((s) => s.remoteSessionId === descriptor.remoteSessionId));
  // 迟到 entry 未发布任何 online session（无 waiter 即释放），同一 key 仅新连接在册。
  assert.equal(registry.getStats().connectionCount, 1);
});

test("Source 常驻连接：disconnected+recovering 期间复用表保留，shouldKeepConnectionAlive 生效", async () => {
  const { registry, handles } = createHarness({
    target: sshTarget,
    capabilities: { sourceServerId: "srv-1", persistentSourceConnection: true },
  });
  await connectSession(registry, sshTarget);
  const handle = handles[0]!;
  handle.emitClose({ exitCode: null, signal: null, recoverable: true, recoveryAttempt: 1 });
  // persistentSourceConnection=true 时 recovering entry 保留 owner，等待 Manager 重连。
  assert.equal(registry.getStats().connectionCount, 1);
  handle.emitReconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registry.listConnections()[0]?.state, "online");
});
