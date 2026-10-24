// T-SM1 + T-MG2（backlog-sweep Step 7-8，phase-p9-management blocking）：
// T-SM1 — Source/Profile 管理服务：17 方法 + 3 事件（onDidChangeState / onDidChangeDirectory /
//         可选 onDidAppendOperationLog）注册、快照代际、migrationCounts 状态推进、
//         删前回调先于目录删除（detach 时序）、source-settings attachment detach 守卫。
// T-MG2 — validation scope：source-settings 两分支 + remote.sourceServerId 可选。
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/sourceServerManagement.test.ts`
// 本仓无 jsdom：只做纯逻辑/源码形状守卫，不写 DOM 测试。
import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import {
  windowHostAttachmentScopeSchema,
  type ConnectionProfile,
  type SourceServerConnectionStateSnapshot,
  type SourceServerManagementStateDelta,
  type SourceServerOperationLog,
  type SourceServerRecord,
} from "@zcode/shared";
import { ISourceServerManagementService } from "../src/source-server-management/sourceServerManagement.js";
import {
  createSourceServerManagementService,
  type CreateSourceServerManagementServiceOptions,
  type SourceServerManagementConnectionPort,
  type SourceServerManagementDirectoryPort,
  type SourceServerManagementDirectorySnapshot,
} from "../src/source-server-management/sourceServerManagementService.js";
import { createWindowHostAttachmentRegistry } from "../../desktop/src/host/windowHostAttachmentRegistry.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SERVER_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

const PROFILE: ConnectionProfile = {
  profileId: PROFILE_ID,
  sourceServerId: SERVER_ID,
  transport: "ssh",
  target: { kind: "ssh", host: "devbox", port: 22, username: "omz" },
  displayName: "devbox",
  createdAt: 1,
  lifecycleState: "active",
};

const SERVER: SourceServerRecord = {
  sourceServerId: SERVER_ID,
  displayName: "devbox",
  preferredProfileId: PROFILE_ID,
  installState: "installed",
  declaredWorkspaces: [],
};

interface TestHarness {
  options: CreateSourceServerManagementServiceOptions;
  directory: SourceServerManagementDirectoryPort & {
    calls: string[];
    snapshotData: SourceServerManagementDirectorySnapshot;
    emitDirectoryChange(): void;
  };
  manager: SourceServerManagementConnectionPort & {
    calls: string[];
    emitState(state: SourceServerConnectionStateSnapshot): void;
    emitOperationLog(entry: SourceServerOperationLog): void;
    online: Map<
      string,
      {
        services: {
          fileService: { ensureConversationWorkspace(): Promise<any> };
          sourceServerWorkspaceService?: any;
        };
      }
    >;
  };
}

function createHarness(
  overrides: Partial<CreateSourceServerManagementServiceOptions> = {},
): TestHarness {
  const directoryEmitter = new Emitter<void>();
  const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
  const logEmitter = new Emitter<SourceServerOperationLog>();
  const snapshotData: SourceServerManagementDirectorySnapshot = {
    profiles: [PROFILE],
    servers: [SERVER],
    workspaceHistory: [],
  };
  const directoryCalls: string[] = [];
  const managerCalls: string[] = [];
  const online: TestHarness["manager"]["online"] = new Map();

  const directory: TestHarness["directory"] = {
    calls: directoryCalls,
    snapshotData,
    onDidChange: directoryEmitter.event,
    async snapshot() {
      return {
        profiles: [...snapshotData.profiles],
        servers: [...snapshotData.servers],
        workspaceHistory: [...snapshotData.workspaceHistory],
      };
    },
    async resolveProfileTarget() {
      return { kind: "ssh", host: "devbox", port: 22, username: "omz" };
    },
    async renameSource(sourceServerId, displayName) {
      directoryCalls.push(`renameSource:${sourceServerId}:${displayName}`);
      snapshotData.servers = snapshotData.servers.map((server) =>
        server.sourceServerId === sourceServerId ? { ...server, displayName } : server,
      );
      directoryEmitter.fire();
    },
    async renameProfile(profileId, displayName) {
      directoryCalls.push(`renameProfile:${profileId}:${displayName}`);
    },
    async updateProfile(input) {
      directoryCalls.push(`updateProfile:${input.profileId}`);
    },
    async setPreferredProfile(sourceServerId, profileId) {
      directoryCalls.push(`setPreferredProfile:${sourceServerId}:${profileId}`);
    },
    async removeProfile(profileId) {
      directoryCalls.push(`removeProfile:${profileId}`);
    },
    async removeSourceServer(sourceServerId) {
      directoryCalls.push(`removeSourceServer:${sourceServerId}`);
    },
    async recordConversationWorkspace(sourceServerId, workspacePath) {
      directoryCalls.push(`recordConversationWorkspace:${sourceServerId}:${workspacePath}`);
    },
    emitDirectoryChange() {
      directoryEmitter.fire();
    },
  };

  const manager: TestHarness["manager"] = {
    calls: managerCalls,
    online,
    onDidChangeState: stateEmitter.event,
    onDidAppendOperationLog: logEmitter.event,
    async connect(input) {
      managerCalls.push(
        `connect:${input.profile.profileId}:${input.membershipIntent}:${String(input.allowInstall)}:${String(input.confirmIdentityChange === true)}`,
      );
      return {};
    },
    async updateServer(input) {
      managerCalls.push(`updateServer:${input.profile.profileId}:${String(input.force === true)}`);
      return {};
    },
    disconnect(sourceServerId) {
      managerCalls.push(`disconnect:${sourceServerId}`);
    },
    removeProfile(profileId) {
      managerCalls.push(`removeProfile:${profileId}`);
    },
    listStates() {
      return [];
    },
    getOnlineConnection(sourceServerId) {
      return online.get(sourceServerId);
    },
    getRecentOperationLogs(profile) {
      managerCalls.push(`logs:${profile.profileId}:${profile.sourceServerId ?? "-"}`);
      return [];
    },
    emitState(state) {
      stateEmitter.fire(state);
    },
    emitOperationLog(entry) {
      logEmitter.fire(entry);
    },
  };

  return {
    options: { directory, manager, ...overrides },
    directory,
    manager,
  };
}

function onlineState(state: SourceServerConnectionStateSnapshot["state"]) {
  return {
    profileId: PROFILE_ID,
    sourceServerId: SERVER_ID,
    state,
    updatedAt: 1,
  } satisfies SourceServerConnectionStateSnapshot;
}

test("T-SM1 契约面：descriptor 频道名 + 17 方法 + 3 事件注册", () => {
  assert.equal(ISourceServerManagementService.channelName, "source-server-management");
  const harness = createHarness();
  const service = createSourceServerManagementService(harness.options);
  const methods = [
    "getSnapshot",
    "getRecentOperationLogs",
    "connectProfile",
    "confirmIdentityChange",
    "disconnectSource",
    "ensureConversationWorkspace",
    "updateSource",
    "renameSource",
    "renameProfile",
    "updateProfile",
    "setPreferredProfile",
    "removeProfile",
    "removeSourceServer",
    "getMigrationReport",
    "exportMigrationReport",
    "abandonWorkspaceMigration",
    "retryWorkspaceMigration",
  ];
  assert.equal(methods.length, 17);
  for (const method of methods) {
    assert.equal(
      typeof (service as unknown as Record<string, unknown>)[method],
      "function",
      method,
    );
  }
  // onDidAppendOperationLog 是可选事件，但本实现必须注册（Step 9 操作日志面板靠它重读）。
  assert.equal(typeof service.onDidChangeState, "function");
  assert.equal(typeof service.onDidChangeDirectory, "function");
  assert.equal(typeof service.onDidAppendOperationLog, "function");
  service.dispose();
});

test("T-SM1 事件：state/directory 增量携带单调递增 generation，日志事件透传", async () => {
  const harness = createHarness();
  const service = createSourceServerManagementService(harness.options);
  const states: SourceServerManagementStateDelta[] = [];
  const directories: number[] = [];
  const logs: SourceServerOperationLog[] = [];
  const stateSub = service.onDidChangeState((delta) => states.push(delta));
  const directorySub = service.onDidChangeDirectory((delta) => directories.push(delta.generation));
  const logSub = service.onDidAppendOperationLog!((entry) => logs.push(entry));

  harness.manager.emitState(onlineState("online"));
  harness.directory.emitDirectoryChange();
  harness.manager.emitState(onlineState("offline"));
  harness.manager.emitOperationLog({
    profileId: PROFILE_ID,
    operation: "connect",
    phase: "probe",
    level: "info",
    message: "Checking the remote device",
    timestamp: 1,
  });

  assert.equal(states.length, 2);
  assert.equal(states[0]!.state.state, "online");
  assert.equal(states[1]!.state.state, "offline");
  // generation 是 state/directory 共用计数器：state(1) → directory(2) → state(3)。
  assert.equal(states[0]!.generation, 1);
  assert.equal(directories[0], 2);
  assert.equal(states[1]!.generation, 3);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.message, "Checking the remote device");

  stateSub.dispose();
  directorySub.dispose();
  logSub.dispose();
  service.dispose();
});

test("T-SM1 getSnapshot：目录三实体 + 连接态 + migrationCounts 状态推进", async () => {
  const harness = createHarness();
  const workspaceService = {
    async getFailedPathCount() {
      return 2;
    },
    async getAbandonedPathCount() {
      return 1;
    },
    async listMigrationReports() {
      return { rows: [] };
    },
    async abandonFailedWorkspace() {
      return { rows: [] };
    },
    async retryWorkspaceMigration() {
      return { rows: [] };
    },
  };
  const service = createSourceServerManagementService(harness.options);
  const first = await service.getSnapshot({ refreshMigrationCounts: true });
  assert.deepEqual(
    first.migrationCounts.map((count) => count.status),
    ["loading"],
    "首次读取立即回放 loading 并在后台读远端",
  );
  // 未连接：后台读取落 requires-connection，并通知一次目录变更。
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.getSnapshot();
  assert.deepEqual(second.migrationCounts, [
    { sourceServerId: SERVER_ID, status: "requires-connection" },
  ]);
  assert.equal(second.failedPathCount, 0);

  harness.manager.online.set(SERVER_ID, {
    services: {
      fileService: {
        async ensureConversationWorkspace() {
          return null;
        },
      },
      sourceServerWorkspaceService: workspaceService,
    },
  });
  const third = await service.getSnapshot({ refreshMigrationCounts: true });
  assert.equal(third.profiles.length, 1);
  assert.equal(third.servers.length, 1);
  assert.deepEqual(third.workspaceHistory, []);
  assert.deepEqual(third.states, []);
  await new Promise((resolve) => setImmediate(resolve));
  const fourth = await service.getSnapshot();
  assert.deepEqual(fourth.migrationCounts, [
    {
      sourceServerId: SERVER_ID,
      status: "available",
      failedPathCount: 2,
      abandonedPathCount: 1,
    },
  ]);
  assert.equal(fourth.failedPathCount, 2);
  assert.equal(fourth.abandonedPathCount, 1);
  service.dispose();
});

test("T-SM1 connectProfile/confirmIdentityChange：membership 意图与安装许可", async () => {
  const harness = createHarness();
  const service = createSourceServerManagementService(harness.options);
  await service.connectProfile(PROFILE_ID);
  await service.connectProfile(PROFILE_ID, { retainedOnly: true });
  await service.confirmIdentityChange(PROFILE_ID);
  assert.deepEqual(harness.manager.calls, [
    `connect:${PROFILE_ID}:add:true:false`,
    `connect:${PROFILE_ID}:retain:false:false`,
    `connect:${PROFILE_ID}:add:true:true`,
  ]);
  service.dispose();
});

test("T-SM1 日志读取：profileId 映射到设备 key；ensureConversationWorkspace 写 conversation 路径", async () => {
  const calls: string[] = [];
  const harness = createHarness();
  harness.manager.online.set(SERVER_ID, {
    services: {
      fileService: {
        async ensureConversationWorkspace() {
          calls.push("ensureConversationWorkspace");
          return {
            path: "/home/omz/.omz/conversations",
            created: true,
            workspacePurpose: "conversation" as const,
          };
        },
      },
      sourceServerWorkspaceService: {
        async getFailedPathCount() {
          return 0;
        },
        async getAbandonedPathCount() {
          return 0;
        },
      },
    },
  });
  const service = createSourceServerManagementService(harness.options);
  await service.getRecentOperationLogs(PROFILE_ID);
  assert.deepEqual(calls, []);
  assert.deepEqual(harness.manager.calls, [`logs:${PROFILE_ID}:${SERVER_ID}`]);

  const result = await service.ensureConversationWorkspace(SERVER_ID);
  assert.deepEqual(calls, ["ensureConversationWorkspace"]);
  assert.deepEqual(result, {
    path: "/home/omz/.omz/conversations",
    created: true,
    workspacePurpose: "conversation",
  });
  assert.ok(
    harness.directory.calls.includes(
      `recordConversationWorkspace:${SERVER_ID}:/home/omz/.omz/conversations`,
    ),
  );

  service.dispose();

  const offline = createSourceServerManagementService(createHarness().options);
  await assert.rejects(offline.ensureConversationWorkspace(SERVER_ID), /source-server\.not-online/);
  offline.dispose();
});

test("T-SM1 updateSource：expectedTarget 不符拒绝，匹配才进入 updateServer", async () => {
  const harness = createHarness();
  const service = createSourceServerManagementService(harness.options);
  await assert.rejects(
    service.updateSource({
      profileId: PROFILE_ID,
      expectedTarget: { kind: "ssh", host: "other", port: 22, username: "omz" },
    }),
    /source-server\.update-target-changed/,
  );
  assert.deepEqual(harness.manager.calls, []);
  await service.updateSource({
    profileId: PROFILE_ID,
    expectedTarget: { kind: "ssh", host: "devbox", port: 22, username: "omz" },
    force: true,
  });
  assert.deepEqual(harness.manager.calls, [`updateServer:${PROFILE_ID}:true`]);
  service.dispose();
});

test("T-SM1 removeSourceServer：删前回调先于目录删除；回调失败即中止（detach 时序）", async () => {
  const order: string[] = [];
  const harness = createHarness({
    onBeforeSourceServerRemoved: async (sourceServerId) => {
      order.push(`before:${sourceServerId}`);
    },
  });
  const service = createSourceServerManagementService(harness.options);
  await service.removeSourceServer(SERVER_ID);
  assert.deepEqual(order, [`before:${SERVER_ID}`]);
  assert.deepEqual(harness.manager.calls, [`disconnect:${SERVER_ID}`]);
  assert.deepEqual(harness.directory.calls, [`removeSourceServer:${SERVER_ID}`]);
  service.dispose();

  const failing = createHarness({
    onBeforeSourceServerRemoved: async () => {
      throw new Error("remote-project.invalid-host-identity");
    },
  });
  const blocked = createSourceServerManagementService(failing.options);
  await assert.rejects(blocked.removeSourceServer(SERVER_ID), /invalid-host-identity/);
  assert.deepEqual(failing.directory.calls, [], "删前回调失败时目录不得删除");
  assert.deepEqual(failing.manager.calls, [], "删前回调失败时不得先断连接");
  blocked.dispose();
});

test("T-SM1 removeProfile：先摘 Manager 再看目录；迁移报告三方法走在线 Source", async () => {
  const harness = createHarness();
  const report = {
    rows: [
      {
        migrationId: "m1",
        workspacePath: "/work/repo",
        canonicalKey: "k",
        variantKeys: [],
        status: "failed" as const,
        conflicts: [],
        updatedAt: 1,
      },
    ],
  };
  const workspaceService = {
    async getFailedPathCount() {
      return 1;
    },
    async getAbandonedPathCount() {
      return 0;
    },
    async listMigrationReports() {
      return report;
    },
    async abandonFailedWorkspace(input: { workspacePath: string; migrationId: string }) {
      harness.directory.calls.push(`abandon:${input.workspacePath}:${input.migrationId}`);
      return report;
    },
    async retryWorkspaceMigration(input: { workspacePath: string; migrationId: string }) {
      harness.directory.calls.push(`retry:${input.workspacePath}:${input.migrationId}`);
      return report;
    },
  };
  harness.manager.online.set(SERVER_ID, {
    services: {
      fileService: {
        async ensureConversationWorkspace() {
          return null;
        },
      },
      sourceServerWorkspaceService: workspaceService,
    },
  });
  const service = createSourceServerManagementService(harness.options);
  await service.removeProfile(PROFILE_ID);
  assert.deepEqual(harness.manager.calls, [`removeProfile:${PROFILE_ID}`]);
  assert.deepEqual(harness.directory.calls, [`removeProfile:${PROFILE_ID}`]);

  assert.deepEqual(await service.getMigrationReport(SERVER_ID), report);
  assert.equal(typeof (await service.exportMigrationReport(SERVER_ID)), "string");
  assert.deepEqual(await service.abandonWorkspaceMigration(SERVER_ID, "/work/repo", "m1"), report);
  assert.deepEqual(await service.retryWorkspaceMigration(SERVER_ID, "/work/repo", "m1"), report);
  assert.deepEqual(harness.directory.calls.slice(1), [
    "abandon:/work/repo:m1",
    "retry:/work/repo:m1",
  ]);
  service.dispose();
});

test("T-SM1 source-settings attachment：detach 只摘同设备 + replayable 守卫", () => {
  const registry = createWindowHostAttachmentRegistry<{ tag: string }, { once(): unknown }, never>({
    resolveScope: (scope) => ({
      services: { tag: scope.kind },
      generation: 1,
    }),
    expose: () => ({ dispose() {} }),
  });
  const port = { once() {} };
  registry.attach({
    requestId: "r1",
    attachmentId: "a1",
    clientMode: "desktop-continuous",
    scope: { kind: "source-settings", sourceServerId: SERVER_ID },
    port,
  });
  registry.attach({
    requestId: "r2",
    attachmentId: "a2",
    clientMode: "desktop-continuous",
    scope: { kind: "source-settings", sourceServerId: OTHER_SERVER_ID },
    port,
  });
  registry.attach({
    requestId: "r3",
    attachmentId: "a3",
    clientMode: "desktop-continuous",
    scope: { kind: "local" },
    port,
  });
  assert.equal(registry.size(), 3);
  registry.detachSourceSettingsAttachments(SERVER_ID);
  assert.deepEqual(
    registry.list().map((entry) => entry.attachmentId),
    ["a2", "a3"],
  );
  assert.throws(
    () =>
      registry.attach({
        requestId: "r4",
        attachmentId: "a4",
        clientMode: "web-remote-replayable",
        scope: { kind: "source-settings", sourceServerId: SERVER_ID },
        port,
      }),
    /Desktop-only/,
  );
  registry.dispose();
});

test("T-SM1 dispose：释放后不再推送目录增量", async () => {
  const harness = createHarness();
  const service = createSourceServerManagementService(harness.options);
  let directories = 0;
  service.onDidChangeDirectory(() => {
    directories += 1;
  });
  service.dispose();
  harness.directory.emitDirectoryChange();
  harness.manager.emitState(onlineState("online"));
  assert.equal(directories, 0);
});

test("T-MG2 validation scope：source-settings 两分支 + remote.sourceServerId", () => {
  // 分支一：source-settings 必须带 sourceServerId。
  const scoped = windowHostAttachmentScopeSchema.parse({
    kind: "source-settings",
    sourceServerId: SERVER_ID,
  });
  assert.deepEqual(scoped, { kind: "source-settings", sourceServerId: SERVER_ID });
  assert.equal(
    windowHostAttachmentScopeSchema.safeParse({ kind: "source-settings" }).success,
    false,
  );
  assert.equal(
    windowHostAttachmentScopeSchema.safeParse({ kind: "source-settings", sourceServerId: " " })
      .success,
    false,
  );
  // 分支二：未知 kind 与 source-settings 的多余字段都必须拒绝（strict）。
  assert.equal(
    windowHostAttachmentScopeSchema.safeParse({
      kind: "source-settings",
      sourceServerId: SERVER_ID,
      extra: 1,
    }).success,
    false,
  );

  // remote.sourceServerId 可选：旧调用方（不带设备 id）仍必须解析成功。
  const legacyRemote = windowHostAttachmentScopeSchema.parse({
    kind: "remote",
    remoteSessionId: "session-1",
    workspacePath: "/work/repo",
    workspaceIdentity: "remote:ssh:abc",
  });
  assert.equal("sourceServerId" in legacyRemote, false);
  const scopedRemote = windowHostAttachmentScopeSchema.parse({
    kind: "remote",
    sourceServerId: SERVER_ID,
    remoteSessionId: "session-1",
    workspacePath: "/work/repo",
    workspaceIdentity: "remote:server:abc",
  });
  assert.equal(scopedRemote.sourceServerId, SERVER_ID);
  assert.equal(
    windowHostAttachmentScopeSchema.safeParse({
      kind: "remote",
      sourceServerId: "",
      remoteSessionId: "session-1",
      workspacePath: "/work/repo",
      workspaceIdentity: "remote:server:abc",
    }).success,
    false,
  );
});
