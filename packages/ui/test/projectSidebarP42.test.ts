/**
 * T-VU4（upstream-v316-fullsync P4.2 壳层批）：UI 提交链流转 / tabStore 键统一 /
 * 未读信号链纯逻辑与接线守卫。
 *
 * 形态与 T-VU1~T-VU3 一致：无 jsdom，纯逻辑 + 源码形状守卫，可直接
 * tsx --tsconfig packages/ui/tsconfig.json --test 运行。
 * ①store 草稿归属意图（draftProjectId/draftTaskGroupId 写入/失效版本/清除/导航提交事件）；
 * ②tabStore 键统一（展开键=identity||path、读旧写新兼容、lastClosedWorkspaceEvent、
 *   previousWorkspaceIdentity rekey 匹配、显式关闭 lifecycle 裁决）；
 * ③windowControllerTaskListRegistry 目录/Source 修订号与 readActivities 快路径；
 * ④UI 提交链与未读信号/lineage walk 源码形状守卫。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { createTabStore, type WorkspaceTabState } from "../src/store/tabStore.js";
import { isSameWorkspaceTab } from "../src/store/tabWorkspaceIdentity.js";
import { collectClosedRemoteWorkspaceKeys } from "../src/root/useRemoteWorkspaceTabLifecycle.js";
import { createWorkspaceSlice } from "../src/store/zcodeSessionStoreWorkspaceSlice.js";
import { getWorkspaceState } from "../src/store/zcodeSessionStoreSelectors.js";
import type { ZCodeSessionStoreState } from "../src/store/zcodeSessionStoreTypes.js";
import {
  onTaskNavigationCommitted,
  notifyTaskNavigationCommitted,
} from "../src/store/zcodeSessionStoreNavigation.js";
import type { TaskNavEntry } from "../src/lib/taskNavigationHistory.js";
import { getWindowControllerTaskListRegistry } from "../src/v4/windowControllerTaskListRegistry.js";
import type { IWindowControllerService } from "@zcode/services";
import type { WindowHostControllerFrame } from "@zcode/services";
import type {
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
} from "@zcode/shared/zcode-protocol-v4";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const desktopSrc = path.join(root, "packages", "desktop", "src");
const servicesSrc = path.join(root, "packages", "services", "src");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");

// ---------- ①store 草稿归属意图（UI 提交链源头） ----------

function makeSliceHarness() {
  // harness 只挂 store 的数据桶（workspaces/taskNavHistory）；actions 面由
  // createWorkspaceSlice 自身提供，按 Pick 断言补全类型，不为 50 个无关 action 造 stub。
  let state = {
    workspaces: {},
    taskNavHistory: { entries: [], cursor: -1 },
  } as Pick<ZCodeSessionStoreState, "workspaces" | "taskNavHistory">;
  const slice = createWorkspaceSlice((partial) => {
    const next = typeof partial === "function" ? partial(state as ZCodeSessionStoreState) : partial;
    state = { ...state, ...next };
  });
  return {
    slice,
    stateOf: (workspacePath: string, workspaceIdentity?: string) =>
      getWorkspaceState(state as ZCodeSessionStoreState, workspacePath, workspaceIdentity),
  };
}

test("T-VU4: startDraft 写入 draftProjectId/draftTaskGroupId，换项目递增预热失效版本", () => {
  const { slice, stateOf } = makeSliceHarness();
  slice.startDraft("W:/proj", undefined, undefined, {
    projectId: "p1",
    taskGroupId: "g1",
  });
  const draft = stateOf("W:/proj");
  assert.equal(draft.draftProjectId, "p1");
  assert.equal(draft.draftTaskGroupId, "g1");
  const bumped = draft.draftRuntimeInvalidationVersion;
  // 同项目重复进入草稿：不复用预热，但失效版本不再递增。
  slice.startDraft("W:/proj", undefined, undefined, { projectId: "p1" });
  assert.equal(stateOf("W:/proj").draftRuntimeInvalidationVersion, bumped);
  // 同 cwd 可属于多个项目；换项目必须重建预热 runtime 目录范围。
  slice.startDraft("W:/proj", undefined, undefined, { projectId: "p2" });
  assert.equal(stateOf("W:/proj").draftProjectId, "p2");
  assert.equal(stateOf("W:/proj").draftRuntimeInvalidationVersion, bumped + 1);
});

test("T-VU4: clearDraftTaskGroup 只撤销分组意图，不动项目归属", () => {
  const { slice, stateOf } = makeSliceHarness();
  slice.startDraft("W:/proj", undefined, undefined, {
    projectId: "p1",
    taskGroupId: "g1",
  });
  slice.clearDraftTaskGroup("W:/proj");
  const draft = stateOf("W:/proj");
  assert.equal(draft.draftTaskGroupId, undefined);
  assert.equal(draft.draftProjectId, "p1");
});

test("T-VU4: setActiveTaskId 发布导航提交事实（onTaskNavigationCommitted）", () => {
  const { slice } = makeSliceHarness();
  const received: TaskNavEntry[] = [];
  const subscription = onTaskNavigationCommitted((entry) => received.push(entry));
  const dispose = () =>
    typeof subscription === "function" ? (subscription as () => void)() : subscription.dispose();
  try {
    slice.setActiveTaskId("W:/proj", "task-1", "identity-1");
    slice.setActiveTaskId("W:/proj", null, "identity-1");
    assert.equal(received.length, 1);
    assert.equal(received[0]!.kind, "task");
    assert.equal(received[0]!.taskId, "task-1");
    assert.equal(received[0]!.workspaceIdentity, "identity-1");
    // 模块级发射器：notify 直接驱动同一事件面（草稿外的导航方共用）。
    notifyTaskNavigationCommitted({ workspacePath: "W:/other", taskId: "task-2" });
    assert.equal(received.length, 2);
    assert.equal(received[1]!.workspaceIdentity, undefined);
  } finally {
    dispose();
  }
});

// ---------- ②tabStore 键统一族 ----------

test("T-VU4: 展开键统一为 resolveWorkspaceKey（identity||path），identity workspace 不再共享 path 键", () => {
  const store = createTabStore(null);
  const state = () => store.getState();
  state().addTab("W:/remote", { workspaceIdentity: "ssh:host1:/w" });
  assert.ok(store.getState().expandedWorkspacePaths.has("ssh:host1:/w"));
  assert.ok(!store.getState().expandedWorkspacePaths.has("W:/remote"));
  // 无 identity 的本机 workspace：键与旧格式逐字节相同（读旧直接命中）。
  state().addTab("W:/local");
  assert.ok(store.getState().expandedWorkspacePaths.has("W:/local"));
  // identity 收起态独立，不影响同 path 其它键。
  state().toggleWorkspaceExpanded("ssh:host1:/w");
  assert.ok(!store.getState().expandedWorkspacePaths.has("ssh:host1:/w"));
  assert.ok(store.getState().expandedWorkspacePaths.has("W:/local"));
});

test("T-VU4: 持久化读旧写新——旧 path 键对本机 workspace 仍生效，identity workspace 写新键", () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
  };
  // 预置旧格式：裸 path 键。
  storage.setItem("zcode-workspace-expansion", JSON.stringify({ "W:/legacy": false }));
  const store = createTabStore(storage);
  const state = () => store.getState();
  state().restoreTabs(["W:/legacy"], 0);
  // 读旧：本机 path tab 的展开键与旧数据一致，收起态被保留。
  assert.ok(!store.getState().expandedWorkspacePaths.has("W:/legacy"));
  // 写新：带 identity 的 tab 以 identity 键落盘，旧 path 键不被删除（无害孤儿）。
  state().addTab("W:/remote2", { workspaceIdentity: "ssh:host2:/w" });
  const persisted = JSON.parse(backing.get("zcode-workspace-expansion")!);
  assert.equal(persisted["ssh:host2:/w"], true);
  assert.equal(persisted["W:/legacy"], false);
});

test("T-VU4: lastClosedWorkspaceEvent 只对 identity/远端 workspace 发射，sequence 单调", () => {
  const store = createTabStore(null);
  const state = () => store.getState();
  const localId = state().addTab("W:/local");
  state().closeTab(localId);
  // 纯本地 path tab 无归属语义，不发事件。
  assert.equal(store.getState().lastClosedWorkspaceEvent, null);
  const remoteId = state().addTab("W:/remote", {
    remoteSessionId: "rs-1",
    workspaceIdentity: "ssh:h:/w",
  });
  state().closeTab(remoteId);
  const first = store.getState().lastClosedWorkspaceEvent;
  assert.ok(first);
  assert.equal(first.workspaceKey, "ssh:h:/w");
  assert.equal(first.origin, "user-close");
  const identityId = state().addTab("W:/remote2", { workspaceIdentity: "ssh:h2:/w" });
  state().closeTab(identityId, "rekey");
  const second = store.getState().lastClosedWorkspaceEvent;
  assert.equal(second!.sequence, first!.sequence + 1);
  assert.equal(second!.workspaceKey, "ssh:h2:/w");
  assert.equal(second!.origin, "rekey");
});

test("T-VU4: isSameWorkspaceTab 接受 previousWorkspaceIdentity 命中；lifecycle rekey 不算关闭", () => {
  const tab = {
    workspacePath: "W:/remote",
    workspaceIdentity: "ssh:host-new:/w",
    remoteSessionId: "rs-2",
  };
  assert.ok(
    isSameWorkspaceTab(tab, "W:/remote", {
      workspaceIdentity: "ssh:host-new:/w",
      previousWorkspaceIdentity: "ssh:host-old:/w",
    }),
  );
  assert.ok(
    // 旧 identity 命中同一 tab：ensureWorkspaceTab rekey 复用行。
    isSameWorkspaceTab(tab, "W:/remote", { workspaceIdentity: "ssh:host-old:/w" }) === false,
  );
  // mock 只构造 lifecycle 判定消费的字段（workspaceIdentity/remoteSessionId/previousWorkspaceIdentity）；
  // kind/id/label 属 tabStore 壳层，不在本断言面，按断言收窄补齐类型。
  const previous = [
    { workspacePath: "W:/remote", workspaceIdentity: "ssh:host-old:/w", remoteSessionId: "rs-1" },
  ] as unknown as WorkspaceTabState[];
  const next = [
    {
      workspacePath: "W:/remote",
      workspaceIdentity: "ssh:host-new:/w",
      remoteSessionId: "rs-2",
      previousWorkspaceIdentity: "ssh:host-old:/w",
    },
  ] as unknown as WorkspaceTabState[];
  // Host stable identity 换代：previousWorkspaceIdentity 命中 → 不产生关闭事实。
  assert.deepEqual(collectClosedRemoteWorkspaceKeys(previous, next), []);
  // 无 rekey 证据的真实关闭仍照常产生事实。
  assert.deepEqual(collectClosedRemoteWorkspaceKeys(previous, []), ["ssh:host-old:/w"]);
});

test("T-VU4: mergeWorkspaceTabOptions 等值元数据保持原引用（避免侧栏整树重渲染）", () => {
  const store = createTabStore(null);
  const state = () => store.getState();
  const id = state().addTab("W:/a", { workspaceIdentity: "ssh:h:/w" });
  const before = store.getState().tabs.find((tab) => tab.id === id);
  const returned = state().addTab("W:/a", { workspaceIdentity: "ssh:h:/w" });
  const after = store.getState().tabs.find((tab) => tab.id === id);
  assert.equal(returned, id);
  assert.equal(after, before);
});

// ---------- ③windowControllerTaskListRegistry 快路径 ----------

// ZCodeTaskMeta 必填面（traceId/title/mode/createdAt）按最小 mock 值补齐。
function row(
  taskId: string,
  overrides: Partial<WindowHostControllerTaskRow> = {},
): WindowHostControllerTaskRow {
  return {
    address: { workspacePath: "W:/proj", taskId },
    meta: {
      taskId,
      traceId: `trace-${taskId}`,
      title: taskId,
      workspacePath: "W:/proj",
      mode: "yolo",
      status: "running",
      updatedAt: 1,
      createdAt: 1,
    },
    membership: { pinned: false, archived: false, active: true },
    sourceAvailability: "online",
    liveStatus: "running",
    ...overrides,
  };
}

type FakeWindowController = IWindowControllerService & {
  /** 测试辅助：直驱 onDynamicControllerFrame 的回调（registry 消费面之外的驱动口）。 */
  fire(frame: WindowHostControllerFrame): void;
};

function makeFakeController(): FakeWindowController {
  let frameHandler: ((frame: WindowHostControllerFrame) => void) | null = null;
  const controller = {
    async subscribeControllerV4() {
      return { ack: { subscriptionId: "sub-1" } };
    },
    async unsubscribeControllerV4() {},
    async resyncControllerV4() {
      throw new Error("not used");
    },
    async listTaskList() {
      return { items: [], total: 0, hasMore: false };
    },
    onDynamicControllerFrame() {
      return (handler: (frame: WindowHostControllerFrame) => void) => {
        frameHandler = handler;
        return { dispose: () => (frameHandler = null) };
      };
    },
    fire(frame: WindowHostControllerFrame) {
      frameHandler?.(frame);
    },
  };
  // mock 只实现 registry 消费的 5 个方法；其余接口方法在断言路径中不会触达。
  return controller as unknown as FakeWindowController;
}

function snapshotFrame(
  tasks: WindowHostControllerTaskRow[],
  seq = { from: 0, to: 1 },
): WindowHostControllerTaskFrame {
  return {
    subscriptionId: "sub-1",
    logEpoch: "e1",
    fromSeq: seq.from,
    toSeq: seq.to,
    sentAt: 0,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
    payload: {
      kind: "snapshot",
      snapshot: { protocolVersion: 1, logEpoch: "e1", tasks },
    },
  };
}

test("T-VU4: registry readActivities 快路径与目录/Source 修订号语义", async () => {
  const controller = makeFakeController();
  const registry = getWindowControllerTaskListRegistry(controller);
  // subscribe 触发 Controller 观察建立（frame handler 接线）。
  const unsubscribe = registry.subscribe(() => {});
  // notifyOnce 走 queueMicrotask 合并；每帧后让微任务排空再断言。
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const revisionBefore = registry.getRevision();
  const base = row("t1", {
    activity: { phase: "running", lastActivityAt: 1, hasBackgroundWork: true },
  });
  controller.fire(snapshotFrame([base], { from: 0, to: 1 }));
  await settle();
  assert.ok(registry.getRevision() > revisionBefore);
  // readActivities 只回在线 + 有活动行（快路径替代逐 scope sessions-index 订阅）。
  assert.equal(registry.readActivities().length, 1);
  assert.equal(registry.readActivities()[0]!.address.taskId, "t1");
  const directoryBefore = registry.getDirectoryRevision();
  // snapshot = 全量重建，恒递增目录与 Source 修订号（活动噪声不豁免 snapshot 重建）。
  controller.fire(
    snapshotFrame([{ ...base, meta: { ...base.meta, status: "completed", updatedAt: 2 } }], {
      from: 1,
      to: 2,
    }),
  );
  await settle();
  assert.equal(registry.getDirectoryRevision(), directoryBefore + 1);
  // delta 面：活动状态噪声（activity 在场时 meta.status/updatedAt 变化）不递增目录修订号。
  controller.fire({
    subscriptionId: "sub-1",
    logEpoch: "e1",
    fromSeq: 2,
    toSeq: 3,
    sentAt: 0,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "task.upserted",
          task: { ...base, meta: { ...base.meta, status: "error", updatedAt: 3 } },
        },
      ],
    },
  });
  await settle();
  assert.equal(registry.getDirectoryRevision(), directoryBefore + 1);
  // delta 面：成员资格变化是目录事实：递增。
  controller.fire({
    subscriptionId: "sub-1",
    logEpoch: "e1",
    fromSeq: 3,
    toSeq: 4,
    sentAt: 0,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "task.upserted",
          task: { ...base, membership: { pinned: true, archived: false, active: true } },
        },
      ],
    },
  });
  await settle();
  assert.equal(registry.getDirectoryRevision(), directoryBefore + 2);
  // Source 换代（workspaces topic）同时递增 Source 与目录修订号。
  const sourceBefore = registry.getSourceRevision();
  controller.fire({
    subscriptionId: "sub-1",
    logEpoch: "e1",
    fromSeq: 4,
    toSeq: 5,
    sentAt: 0,
    topic: CONTROLLER_WORKSPACES_TOPIC,
    payload: {
      kind: "snapshot",
      snapshot: { protocolVersion: 1, logEpoch: "e1", workspaces: [] },
    },
  });
  await settle();
  assert.equal(registry.getSourceRevision(), sourceBefore + 1);
  assert.equal(registry.getDirectoryRevision(), directoryBefore + 3);
  unsubscribe();
});

// ---------- ④接线形状守卫 ----------

test("T-VU4: UI 提交链全链形状守卫（transport/SessionPane/入口/回放）", () => {
  const transport = read(uiSrc, "v4", "transport.ts");
  assert.match(
    transport,
    /sendCommand\(\s*envelope: CommandEnvelope,\s*context\?: \{ projectId\?: string \| null \},/,
  );
  const agentTransport = read(uiSrc, "v4", "agentConversationTransport.ts");
  assert.match(
    agentTransport,
    /sendConversationCommandV4\(\{ \.\.\.workspace, \.\.\.context, envelope \}\)/,
  );
  const replaceable = read(uiSrc, "v4", "replaceableConversationTransport.ts");
  assert.match(replaceable, /sendCommand\(\.\.\.params\)/);
  const pane = read(uiSrc, "v4", "SessionPane.tsx");
  // 发送边界冻结归属；重放沿用首发捕获值。
  assert.match(pane, /draftProjectIdAtSend/);
  assert.match(pane, /\{ projectId: draftProjectIdAtSend \}/);
  assert.match(pane, /replay\.clientContext\?\.projectId/);
  assert.match(pane, /taskGroupService\.admit/);
  assert.match(pane, /task-group:\${createdSessionId}/);
  const clientContext = read(uiSrc, "v4", "pendingCommandWorkspace.ts");
  assert.match(clientContext, /projectId\?: string \| null/);
  assert.match(clientContext, /taskGroupId\?: string \| null/);
  const actions = read(uiSrc, "root", "useRootWorkspaceActions.ts");
  // 入口忽略面清零：projectId/taskGroupId 不再被入口丢弃。
  assert.match(actions, /projectId: createProjectId/);
  assert.match(actions, /taskGroupId: createTaskGroupId/);
  const grouped = read(uiSrc, "project-sidebar", "TaskGroupedView.tsx");
  assert.match(grouped, /draftTaskGroupId/);
  assert.match(grouped, /clearDraftTaskGroup/);
  const menu = read(uiSrc, "project-sidebar", "ProjectComposerMenu.tsx");
  assert.match(menu, /draftProjectId/);
  const storeTypes = read(uiSrc, "store", "zcodeSessionStoreTypes.ts");
  assert.match(storeTypes, /draftProjectId\?: string \| null/);
  assert.match(storeTypes, /draftTaskGroupId\?: string \| null/);
});

test("T-VU4: 未读信号链与 lineage walk 形状守卫（hook/host/协议）", () => {
  const hook = read(uiSrc, "project-sidebar", "useProjectUnreadSignals.ts");
  assert.match(hook, /onDynamicTaskUnreadSignal\(\)\(receive\)/);
  assert.match(hook, /unreadSignal !== "background_terminal"/);
  assert.match(hook, /onTaskNavigationCommitted/);
  assert.match(hook, /expectedUnreadAt: entry\.marker/);
  const host = read(desktopSrc, "host", "windowHostControllerService.ts");
  assert.match(host, /taskUnreadSignalEmitter\.fire/);
  assert.match(host, /event\.unreadSignal === "background_terminal"/);
  const tree = read(uiSrc, "project-sidebar", "useProjectTree.ts");
  assert.match(tree, /useProjectUnreadSignals\(scopes, refresh, isDesktop\)/);
  assert.match(tree, /registry\.readActivities\(\)/);
  assert.match(tree, /getDirectoryRevision\(\)/);
  const agentService = read(servicesSrc, "zcode-agent", "zcodeAgentService.ts");
  assert.match(agentService, /project\.session-lineage-invalid/);
  assert.match(agentService, /isAuxiliarySessionKind\(session\.sessionKind\)/);
  const subscribeSchema = read(
    root,
    "packages",
    "shared",
    "src",
    "zcode-protocol-v4",
    "transport.ts",
  );
  assert.match(
    subscribeSchema,
    /additionalDirectories: z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\)\.max\(256\)\.optional\(\)/,
  );
});
