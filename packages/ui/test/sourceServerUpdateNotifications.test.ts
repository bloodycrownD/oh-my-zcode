/**
 * T-MG4（backlog-sweep Step 10 / P9-4）：设置导航 remoteDevices 段 + Source 更新提示控制器。
 *
 * 形态与 projectSidebarP42 一致：本仓 ui 无 jsdom，用「纯逻辑 + 源码形状守卫」，
 * 只对 `window` 做最小 stub（sessionStorage/localStorage/事件派发），不做任何 DOM 断言。
 * 运行：node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test
 *   packages/ui/test/sourceServerUpdateNotifications.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ToastOptions } from "../src/components/ui/toast.js";

// settingsNavigation 的存储分支在函数内判 `typeof window`，因此静态 import 后再装 stub 即可。
interface StorageStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createStorage(): StorageStub {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const dispatched: CustomEvent<unknown>[] = [];
(globalThis as { window?: unknown }).window = {
  localStorage: createStorage(),
  sessionStorage: createStorage(),
  dispatchEvent: (event: CustomEvent<unknown>) => {
    dispatched.push(event);
    return true;
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const {
  consumeInitialSettingsSection,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsSourceServerId,
  isSettingsSectionEnabled,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
} = await import("../src/lib/settingsNavigation.js");
const { createSourceServerUpdatePreferences, sourceServerUpdateKey } =
  await import("../src/lib/sourceServerUpdatePreferences.js");
const { createSourceServerUpdateNotificationController, showSourceServerUpdateNotification } =
  await import("../src/root/sourceServerUpdateNotifications.js");
const { findSourceServerUpgradeProfileId, profileMatchesRemoteTarget } =
  await import("../src/lib/remoteConnectionWizard.js");
const { getSourceServerForceUpdateDescription, runSourceServerUpdate } =
  await import("../src/lib/sourceServerUpdateAction.js");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const readUi = (...parts: string[]) => readFileSync(path.join(uiSrc, ...parts), "utf8");

const profileId = "profile-a";
const sourceServerId = "server-a";

type Snapshot = {
  generation: number;
  profiles: Record<string, unknown>[];
  servers: Record<string, unknown>[];
  workspaceHistory: unknown[];
  states: Record<string, unknown>[];
  failedPathCount: number;
  abandonedPathCount: number;
  migrationCounts: unknown[];
};

function createSnapshot(
  overrides: Record<string, unknown> = {},
  profileOverrides: Record<string, unknown> = {},
): Snapshot {
  return {
    generation: 1,
    profiles: [
      {
        profileId,
        sourceServerId,
        transport: "ssh",
        displayName: "Build",
        target: { kind: "ssh", host: "example.com", username: "alice" },
        createdAt: 1,
        lifecycleState: "active",
        ...profileOverrides,
      },
    ],
    servers: [{ sourceServerId, displayName: "Build Server", installState: "installed" }],
    workspaceHistory: [],
    states: [
      {
        profileId,
        sourceServerId,
        state: "needs-upgrade",
        updateAvailability: "required",
        currentVersion: "3.12.1",
        availableVersion: "3.12.2",
        minimumVersion: "3.12.1",
        upgradeTarget: "server",
        updatedAt: 1,
        ...overrides,
      },
    ],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

const asSnapshot = (snapshot: Snapshot) => snapshot as never;

interface ToastCall {
  id: number;
  message: string;
  options?: ToastOptions;
}

function createHarness(initial: Snapshot = createSnapshot(), extra: Record<string, unknown> = {}) {
  const stateListeners = new Set<(delta: unknown) => void>();
  const directoryListeners = new Set<() => void>();
  const toasts: ToastCall[] = [];
  const dismissed: unknown[] = [];
  const updateInputs: Record<string, unknown>[] = [];
  let nextId = 0;
  let snapshot = initial;
  let getSnapshotCalls = 0;
  let updateError: unknown = null;

  const management = {
    getSnapshot: async () => {
      getSnapshotCalls++;
      return asSnapshot(snapshot);
    },
    updateSource: async (input: Record<string, unknown>) => {
      updateInputs.push(input);
      if (updateError) throw updateError;
      return asSnapshot(snapshot);
    },
    onDidChangeState: (listener: (delta: unknown) => void) => {
      stateListeners.add(listener);
      return { dispose: () => stateListeners.delete(listener) };
    },
    onDidChangeDirectory: (listener: () => void) => {
      directoryListeners.add(listener);
      return { dispose: () => directoryListeners.delete(listener) };
    },
  };

  const controller = createSourceServerUpdateNotificationController({
    preferences: createSourceServerUpdatePreferences(null),
    management: management as never,
    formatMessage: (id, values) =>
      values
        ? `${id}|${values.source ?? ""}|${values.current ?? ""}|${values.available ?? ""}`
        : id,
    showToast: (message: string, options) => {
      const id = ++nextId;
      toasts.push({ id, message, options });
      return id;
    },
    dismissToast: (id) => void dismissed.push(id),
    ...extra,
  });

  return {
    controller,
    management,
    toasts,
    dismissed,
    updateInputs,
    stateListeners,
    directoryListeners,
    setSnapshot(next: Snapshot) {
      snapshot = next;
    },
    publish(next: Snapshot) {
      snapshot = next;
      for (const listener of stateListeners)
        listener({ generation: next.generation, state: next.states[0] });
    },
    failUpdateWith(error: unknown) {
      updateError = error;
    },
    readUpdateErrors: () => updateInputs,
    get calls() {
      return { getSnapshot: getSnapshotCalls };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** toast 的动作按钮（提示未带按钮时该用例本就该失败，所以这里直接断言存在再取用）。 */
const actionOf = (toast: ToastCall): (() => void) => {
  assert.equal(typeof toast.options?.onAction, "function", `提示缺动作按钮：${toast.message}`);
  return toast.options?.onAction as () => void;
};

// ---------- ① settingsNavigation：remoteDevices 段 ----------

test("settingsNavigation：remoteDevices 是启用分区且被解析器识别", () => {
  assert.equal(isSettingsSectionEnabled("remoteDevices"), true);
  assert.equal(resolveSettingsSection("remoteDevices"), "remoteDevices");
  const source = readUi("lib", "settingsNavigation.ts");
  assert.match(source, /\| "remoteDevices"/, "分区 id 必须在 SettingsSectionId 联合里");
  assert.match(source, /value === "remoteDevices"/, "解析器必须认 remoteDevices");
  // 隐藏集合不得吞掉 remoteDevices（否则跳转被静默回退 general）。
  const hidden = source.slice(
    source.indexOf("HIDDEN_SETTINGS_SECTIONS"),
    source.indexOf("interface"),
  );
  assert.ok(!hidden.includes('"remoteDevices"'));
});

test("settingsNavigation：Source 意图键 round-trip + 分区闸门 + 事件 detail", () => {
  dispatched.length = 0;
  setPendingSettingsSectionIntent("remoteDevices", {
    sourceServerId: `  ${sourceServerId}  `,
    sourceServerDetails: true,
  });
  const detail = dispatched.at(-1)?.detail as Record<string, unknown>;
  assert.equal(detail.section, "remoteDevices");
  assert.equal(detail.sourceServerId, sourceServerId, "id 必须 trim");
  assert.equal(detail.sourceServerDetails, true);
  assert.equal(consumeInitialSettingsSection(), "remoteDevices", "分区意图必须先于上次停留分区");
  assert.equal(consumePendingSettingsSourceServerDetails(), true);
  assert.equal(consumePendingSettingsSourceServerId(), sourceServerId);
  // 消费即清空：第二次拿到 undefined/false。
  assert.equal(consumePendingSettingsSourceServerId(), undefined);
  assert.equal(consumePendingSettingsSourceServerDetails(), false);

  // 换分区必须清掉 Source 维度意图，避免下次进设备页误定位。
  setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
  setPendingSettingsSectionIntent("general");
  assert.equal(consumePendingSettingsSourceServerId(), undefined);
  const generalDetail = dispatched.at(-1)?.detail as Record<string, unknown>;
  assert.equal(generalDetail.section, "general");
  assert.equal("sourceServerId" in generalDetail, false, "非 remoteDevices 分区不得携带设备 id");

  // details 只在「分区 + id + 显式 true」三条件齐备时落盘。
  setPendingSettingsSectionIntent("remoteDevices", { sourceServerDetails: true });
  assert.equal(consumePendingSettingsSourceServerDetails(), false, "无 id 时 details 无效");
  setPendingSettingsSectionIntent("general", { sourceServerId, sourceServerDetails: true });
  assert.equal(consumePendingSettingsSourceServerDetails(), false, "跨分区时 details 无效");
});

// ---------- ② 更新提示控制器：纯逻辑状态机 ----------

test("controller：必更设备弹一次，并在重启后仍不重复（持久去重）", async () => {
  const storage = createStorage();
  const preferences = createSourceServerUpdatePreferences(storage);
  const first = createHarness(createSnapshot(), { preferences });
  await tick();
  assert.equal(first.toasts.length, 1);
  assert.match(first.toasts[0]!.message, /^sourceServer\.updateRequiredToast\|Build Server\|/);
  assert.equal(first.toasts[0]!.options?.actionLabel, "settings.source.updateNow");
  // omz 无 "source-server-update" 变体：提示统一走既有 "update"（见实现处注释）。
  assert.equal(first.toasts[0]!.options?.variant, "update");
  assert.equal(first.toasts[0]!.options?.position, "top-center");
  assert.equal(typeof first.toasts[0]!.options?.onAction, "function");
  assert.equal(preferences.hasSeen(sourceServerUpdateKey(sourceServerId, "3.12.2")), true);

  // 同进程再 refresh：内存去重。
  first.controller.refresh();
  await tick();
  assert.equal(first.toasts.length, 1);
  // 断开（states 清空）再回连：不撤销已提示记录，也不重复弹。
  first.publish(createSnapshot({}, { profileId }));
  await tick();
  assert.equal(first.toasts.length, 1);
  first.controller.dispose();

  // 重启（新 controller + 同一存储）：持久去重生效，不再提示同设备同版本。
  const restarted = createHarness(createSnapshot(), { preferences });
  await tick();
  assert.equal(restarted.toasts.length, 0, "重启后不得重复提示同设备同版本");
  // 版本变化是新事实，必须再提示。
  restarted.publish(createSnapshot({ availableVersion: "3.13.0", updatedAt: 2 }));
  await tick();
  assert.equal(restarted.toasts.length, 1);
  restarted.controller.dispose();
});

test("controller：可选更新 / controller 侧升级的提示分支", async () => {
  const optional = createHarness(
    createSnapshot({
      state: "online",
      updateAvailability: "available",
      upgradeTarget: "server",
    }),
  );
  await tick();
  assert.equal(optional.toasts.length, 0, "可选更新不得主动弹提示（持久去重只服务必更）");
  optional.controller.dispose();

  const controllerSide = createHarness(createSnapshot({ upgradeTarget: "controller" }));
  await tick();
  assert.equal(controllerSide.toasts.length, 1);
  assert.match(
    controllerSide.toasts[0]!.message,
    /^sourceServer\.controllerUpdateAvailableToast\|/,
  );
  assert.equal(
    controllerSide.toasts[0]!.options?.onAction,
    undefined,
    "controller 侧不能提供 Server 更新按钮",
  );
  controllerSide.controller.dispose();
});

test("controller：state 推进到 updating/online/移除时立即撤销旧提示", async () => {
  const updating = createHarness();
  await tick();
  assert.equal(updating.toasts.length, 1);
  updating.publish(createSnapshot({ state: "updating" }));
  await tick();
  assert.deepEqual(updating.dismissed, [1], "进入 updating 必须撤掉「立即更新」按钮");
  updating.controller.dispose();

  const online = createHarness();
  await tick();
  online.publish(createSnapshot({ state: "online", updateAvailability: "none" }));
  await tick();
  assert.deepEqual(online.dismissed, [1]);
  online.controller.dispose();

  const removed = createHarness();
  await tick();
  removed.publish({ ...createSnapshot(), states: [] });
  await tick();
  assert.deepEqual(removed.dismissed, [1]);
  removed.controller.dispose();
});

test("controller：并发 refresh 合并为单次取数（节流），卸载后不再取数", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const management = {
    getSnapshot: async () => {
      calls++;
      await gate;
      return asSnapshot(createSnapshot());
    },
    updateSource: async () => asSnapshot(createSnapshot()),
    onDidChangeState: () => ({ dispose: () => {} }),
    onDidChangeDirectory: () => ({ dispose: () => {} }),
  };
  const controller = createSourceServerUpdateNotificationController({
    preferences: createSourceServerUpdatePreferences(null),
    management: management as never,
    formatMessage: (id) => id,
    showToast: () => 1,
  });
  controller.refresh();
  controller.refresh();
  controller.refresh();
  assert.equal(calls, 1, "in-flight 期间的 refresh 只排队一次");
  release!();
  await tick();
  await tick();
  assert.equal(calls, 2, "合并后只补跑一次，不是每次 refresh 都取数");

  controller.dispose();
  controller.refresh();
  await tick();
  assert.equal(calls, 2, "dispose 后 refresh 必须短路");
});

test("controller：点击复核快照，过期按钮不再发起更新；连点只提交一次", async () => {
  const stale = createHarness();
  await tick();
  const staleAction = stale.toasts[0]!.options?.onAction as () => void;
  stale.setSnapshot(createSnapshot({ state: "updating" }));
  staleAction();
  await tick();
  assert.deepEqual(stale.updateInputs, [], "状态已推进时过期按钮不得再提交更新");
  stale.controller.dispose();

  const twice = createHarness();
  await tick();
  const action = twice.toasts[0]!.options?.onAction as () => void;
  action();
  action();
  await tick();
  assert.equal(twice.updateInputs.length, 1, "同一提示只允许一次提交");
  assert.deepEqual(twice.updateInputs[0], { profileId, force: false });
  // 主动更新先定位设备卡，再发请求。
  twice.controller.dispose();
});

test("controller：向导接管目标时抑制提示，目标释放后恢复", async () => {
  let target: Record<string, unknown> | null = {
    kind: "ssh",
    host: "example.com",
    username: "alice",
  };
  const harness = createHarness(createSnapshot(), { getConnectionTarget: () => target });
  await tick();
  assert.equal(harness.toasts.length, 0, "向导正在连接该设备时不得叠加更新提示");

  target = null;
  harness.controller.refresh();
  await tick();
  assert.equal(harness.toasts.length, 1, "目标释放后必须恢复提示");

  // 目标指向另一台设备时不影响本设备提示。
  target = { kind: "ssh", host: "other.example.com", username: "alice" };
  harness.publish(createSnapshot({ availableVersion: "3.14.0", updatedAt: 3 }));
  await tick();
  assert.equal(harness.toasts.length, 2);
  harness.controller.dispose();
});

test("controller：onProgress / onDetails 分别定位进度与错误详情", async () => {
  const progress: string[] = [];
  const details: string[] = [];
  const harness = createHarness(createSnapshot(), {
    onProgress: (id: string) => void progress.push(id),
    onDetails: (id: string) => void details.push(id),
  });
  await tick();
  actionOf(harness.toasts[0]!)();
  await tick();
  assert.deepEqual(progress, [sourceServerId]);
  assert.deepEqual(details, [], "开始更新只定位进度");

  harness.failUpdateWith(new Error("update failed"));
  harness.publish(createSnapshot({ updatedAt: 2, availableVersion: "3.12.3" }));
  await tick();
  const required = harness.toasts.at(-1)!;
  assert.match(required.message, /^sourceServer\.updateRequiredToast/);
  actionOf(required)();
  await tick();
  await tick();
  const failed = harness.toasts.at(-1)!;
  assert.match(failed.message, /^sourceServer\.updateFailedToast/);
  assert.equal(failed.options?.variant, "warning");
  assert.equal(failed.options?.actionLabel, "remote.action.details");
  actionOf(failed)();
  assert.deepEqual(details, [sourceServerId]);
  harness.controller.dispose();
});

test("controller：展示工具直接调用时也遵守同一准入闸门", async () => {
  const shown: ToastCall[] = [];
  const options = {
    preferences: createSourceServerUpdatePreferences(null),
    management: { getSnapshot: async () => asSnapshot(createSnapshot()) } as never,
    formatMessage: (id: string) => id,
    showToast: (message: string, toastOptions?: ToastOptions) => {
      shown.push({ id: shown.length + 1, message, options: toastOptions });
      return shown.length;
    },
  };
  assert.equal(
    showSourceServerUpdateNotification({
      ...options,
      snapshot: asSnapshot(createSnapshot({ state: "online", updateAvailability: "none" })),
      state: { profileId, state: "online" } as never,
    }),
    null,
    "没有 needs-upgrade + required 时不得提示",
  );
  assert.equal(
    showSourceServerUpdateNotification({
      ...options,
      snapshot: asSnapshot(createSnapshot()),
      state: createSnapshot().states[0] as never,
    })?.id,
    1,
  );
});

// ---------- ③ updateSource 的 guard 分支 ----------

test("runSourceServerUpdate：guard 拒绝后必须先确认再 force，取消则不重试", async () => {
  const createGuardedManagement = () => {
    const inputs: Record<string, unknown>[] = [];
    let attempts = 0;
    return {
      inputs,
      management: {
        getSnapshot: async () => asSnapshot(createSnapshot()),
        updateSource: async (input: Record<string, unknown>) => {
          inputs.push(input);
          if (attempts++ === 0)
            throw Object.assign(new Error("busy"), {
              code: "source-server-update-running-tasks",
            });
          return asSnapshot(createSnapshot());
        },
      },
    };
  };

  const cancelledGuard = createGuardedManagement();
  const cancelled = await runSourceServerUpdate({
    management: cancelledGuard.management as never,
    profileId,
    confirmForce: async () => false,
  });
  assert.equal(cancelled, null);
  assert.deepEqual(cancelledGuard.inputs, [{ profileId, force: false }]);

  const forcedGuard = createGuardedManagement();
  const forced = await runSourceServerUpdate({
    management: forcedGuard.management as never,
    profileId,
    confirmForce: async () => true,
  });
  assert.ok(forced);
  assert.deepEqual(forcedGuard.inputs, [
    { profileId, force: false },
    { profileId, force: true },
  ]);

  // 其它错误原样抛出，不能被当成 guard 拒绝。
  await assert.rejects(
    runSourceServerUpdate({
      management: {
        getSnapshot: async () => asSnapshot(createSnapshot()),
        updateSource: async () => {
          throw new Error("network down");
        },
      } as never,
      profileId,
      confirmForce: async () => true,
    }),
    /network down/,
  );
});

test("getSourceServerForceUpdateDescription：无活动任务时给出清单不可用文案", async () => {
  assert.equal(
    await getSourceServerForceUpdateDescription(
      { getSnapshot: async () => asSnapshot(createSnapshot()) } as never,
      profileId,
      (id) => id,
    ),
    "settings.source.forceUpdateDescription\n\nremote.runningTasksUnavailable",
  );
  assert.equal(
    await getSourceServerForceUpdateDescription(
      {
        getSnapshot: async () =>
          asSnapshot(
            createSnapshot({
              runningTasks: [{ sessionId: "s1", workspacePath: "/w/one" }],
            }),
          ),
      } as never,
      profileId,
      (id) => id,
    ),
    "settings.source.forceUpdateDescription\n\ns1 — /w/one",
  );
});

// ---------- ④ findSourceServerUpgradeProfileId（Step 10 前置符号） ----------

test("findSourceServerUpgradeProfileId：按目标匹配、跳过 retired、取最新一条", () => {
  const sshTarget = { kind: "ssh" as const, host: "example.com", username: "alice" };
  const snapshot = createSnapshot();
  assert.equal(findSourceServerUpgradeProfileId(asSnapshot(snapshot), sshTarget), profileId);
  // 端口不匹配（默认 22 vs 2222）不算同一台设备。
  assert.equal(
    findSourceServerUpgradeProfileId(asSnapshot(snapshot), { ...sshTarget, port: 2222 }),
    null,
  );
  // retired profile 不参与。
  assert.equal(
    findSourceServerUpgradeProfileId(
      asSnapshot(createSnapshot({}, { lifecycleState: "retired" })),
      sshTarget,
    ),
    null,
  );
  // 不是 server 侧必更（controller 侧 / 可选）不参与。
  assert.equal(
    findSourceServerUpgradeProfileId(
      asSnapshot(createSnapshot({ upgradeTarget: "controller" })),
      sshTarget,
    ),
    null,
  );
  assert.equal(
    findSourceServerUpgradeProfileId(
      asSnapshot(createSnapshot({ updateAvailability: "available" })),
      sshTarget,
    ),
    null,
  );
  // 同目标多 Profile：取 updatedAt 最新的。
  const multiple = createSnapshot();
  multiple.profiles.push({
    ...multiple.profiles[0]!,
    profileId: "profile-b",
  });
  multiple.states.push({
    ...multiple.states[0]!,
    profileId: "profile-b",
    updatedAt: 9,
  });
  assert.equal(findSourceServerUpgradeProfileId(asSnapshot(multiple), sshTarget), "profile-b");
  // failedProfileId 只在该 profile 内匹配。
  assert.equal(
    findSourceServerUpgradeProfileId(asSnapshot(multiple), sshTarget, "profile-a"),
    "profile-a",
  );
  assert.equal(
    findSourceServerUpgradeProfileId(asSnapshot(multiple), sshTarget, "profile-missing"),
    null,
  );
});

test("profileMatchesRemoteTarget：三类 transport 的等价判定", () => {
  assert.equal(
    profileMatchesRemoteTarget(createSnapshot().profiles[0] as never, {
      kind: "ssh",
      host: "example.com",
      username: "alice",
      sshConfigAlias: "  ",
    }),
    true,
    "空别名与缺省别名等价",
  );
  assert.equal(
    profileMatchesRemoteTarget(createSnapshot().profiles[0] as never, {
      kind: "docker",
      container: "box",
    }),
    false,
  );
  const wsl = createSnapshot({}, { transport: "wsl", target: { kind: "wsl", distro: "Ubuntu" } });
  assert.equal(
    profileMatchesRemoteTarget(wsl.profiles[0] as never, {
      kind: "wsl",
      distro: "Ubuntu",
    }),
    true,
  );
  assert.equal(
    profileMatchesRemoteTarget(wsl.profiles[0] as never, {
      kind: "wsl",
      distro: "Ubuntu",
      user: "root",
    }),
    false,
  );
  const docker = createSnapshot(
    {},
    { transport: "docker", target: { kind: "docker", container: "box" } },
  );
  assert.equal(
    profileMatchesRemoteTarget(docker.profiles[0] as never, {
      kind: "docker",
      container: "box",
    }),
    true,
  );
});

// ---------- ⑤ 源码形状：Root 挂载 + 侧栏节点 action 注入 ----------

test("Root：更新提示控制器唯一挂载点只对桌面端启用", () => {
  const source = readUi("Root.tsx");
  assert.match(
    source,
    /const handleRemoteConnectionTargetChange = useSourceServerUpdateNotifications\(\{\s*enabled: isDesktop === true,\s*management: services\.sourceServerManagementService,\s*\}\);/,
  );
  assert.match(source, /useSourceServerUpdateNotifications\(/, "必须 import 并在 RootInner 调用");
  assert.match(
    source,
    /handleRemoteConnectionTargetChange\(remoteProjectSelection\?\.host\.target \?\? null\)/,
    "向导接管目标必须由项目创建流程的 host.target 投影",
  );
  // Step 4 的 Picker 真链不得被本步回退。
  assert.match(source, /const remoteProjectIntentEpoch = useRef\(0\);/);
  assert.match(
    source,
    /<RemoteProjectPicker[\s\S]*key=\{remoteProjectSelection\.host\.membershipId\}/,
  );
});

test("ProjectSidebarNode：设备设置 action 注入 remoteDevices 意图并打开设置", () => {
  const source = readUi("project-sidebar", "ProjectSidebarNode.tsx");
  assert.match(
    source,
    /import \{ projectSourceServerId \} from "@\/project-sidebar\/view\.js";/,
    "设备 id 必须走既有目录归属工具，不手写推导",
  );
  assert.match(
    source,
    /import \{ setPendingSettingsSectionIntent \} from "@\/lib\/settingsNavigation\.js";/,
  );
  assert.match(source, /const tabStore = useTabStoreApi\(\);/);
  assert.match(source, /const sourceServerId = projectSourceServerId\(project\);/);
  assert.match(
    source,
    /onOpenDeviceSettings=\{\s*isDesktop && sourceServerId\s*\?\s*\(\) => \{\s*setPendingSettingsSectionIntent\("remoteDevices", \{ sourceServerId \}\);\s*tabStore\.getState\(\)\.openSettingsTab\(\);\s*\}\s*:\s*undefined\s*\}/,
  );
  // 挂账注释必须随落地删除（否则后续读实现会被误导）。
  assert.ok(!source.includes("P9 挂账"));
});
