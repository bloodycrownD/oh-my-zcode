/**
 * T-RU9（upstream-v316-fullsync P7 末批）：host 侧 IRemoteProjectService 投影实现守卫。
 *
 * 覆盖（真单元 + fake Directory/Manager）：
 * 1) readDirectory 投影：servers→hosts（id 由统一 identity 工具构造、membershipId=serverId、
 *    在线态三态、upgradeTarget/lastOpenedAt 透传）；entries 恒空（P3 挂账拍板①）；
 * 2) connectHost：retain 意图连接 + 凭据链缺席拒绝 + host 消失拒绝；
 * 3) 写面挂账边界：saveHost/removeHost/addEntry 显式错误，refreshEntry 恒 false，
 *    removeEntry 幂等 no-op，bindHost 返回投影/迟到 null；
 * 4) 非法 hostId（local/异形）在读写边界显式拒绝。
 *
 * 运行形态：worktree 根 `node --import tsx --test packages/desktop/test/remoteProjectDirectoryService.test.ts`
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDirectoryRemoteProjectService,
  isRemoteProjectHostId,
  remoteProjectHostIdForSourceServer,
  sourceServerIdFromRemoteProjectHostId,
} from "../src/host/remoteProjectDirectoryService.js";
import type { SourceServerDirectory } from "../src/host/sourceServerDirectory.js";
import type { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";

const SERVER_ID = "3f6d5a3e-1c2b-4a5d-8e9f-0a1b2c3d4e5f";
const OTHER_SERVER_ID = "8e1f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";
const PROFILE_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

function fakeSnapshot() {
  return {
    profiles: [
      {
        profileId: PROFILE_ID,
        sourceServerId: SERVER_ID,
        transport: "ssh" as const,
        target: {
          kind: "ssh" as const,
          host: "example.test",
          username: "root",
          passwordCredentialKey: "k1",
        },
        createdAt: 1,
        lifecycleState: "active" as const,
        lastConnectedAt: 20,
      },
    ],
    servers: [
      {
        sourceServerId: SERVER_ID,
        displayName: "example",
        installState: "installed" as const,
        declaredWorkspaces: [],
        preferredProfileId: PROFILE_ID,
        lastOnlineAt: 42,
      },
      {
        sourceServerId: OTHER_SERVER_ID,
        displayName: "other",
        installState: "installed" as const,
        declaredWorkspaces: [],
      },
    ],
    workspaceHistory: [],
  };
}

function fakeManager(overrides: {
  online?: boolean;
  state?: "absent" | "bootstrapping" | "retrying" | "updating" | "online" | "failed";
  error?: string;
}) {
  const manager = {
    getOnlineConnection(sourceServerId: string) {
      return overrides.online && sourceServerId === SERVER_ID
        ? ({ sourceServerId } as never)
        : undefined;
    },
    getStateByProfile(profileId: string) {
      return {
        profileId,
        state: overrides.state ?? "absent",
        updatedAt: 0,
        ...(overrides.error ? { error: overrides.error } : {}),
      };
    },
    connect(input: { membershipIntent?: string; profile: { profileId: string } }) {
      connectCalls.push(input);
      return Promise.resolve({ sourceServerId: SERVER_ID } as never);
    },
  } as unknown as SourceServerConnectionManager;
  return manager;
}

const connectCalls: Array<{ membershipIntent?: string; profile: { profileId: string } }> = [];

function fakeService(managerOverrides: Parameters<typeof fakeManager>[0]) {
  connectCalls.length = 0;
  let snapshot = fakeSnapshot();
  const directory = {
    snapshot: async () => snapshot,
    resolveSilentConnectionTarget: async (profileId: string) =>
      profileId === PROFILE_ID ? { kind: "ssh", host: "example.test", username: "root" } : null,
  } as unknown as SourceServerDirectory;
  return {
    service: createDirectoryRemoteProjectService({
      // options.directory 为同步惰性取用（host/index.ts 注册处同形）。
      directory: () => directory,
      manager: () => fakeManager(managerOverrides),
    }),
    removeServer() {
      snapshot = {
        ...fakeSnapshot(),
        servers: fakeSnapshot().servers.filter((s) => s.sourceServerId !== SERVER_ID),
      };
    },
  };
}

test("readDirectory：servers→hosts 投影（identity/membership/在线态/upgradeTarget 透传）", async () => {
  const { service } = fakeService({ online: true, state: "online" });
  const directory = await service.readDirectory();
  // entries 恒空：远端权威项目入口缓存随 P3（拍板①），本批不得凭空出现侧栏远端行。
  assert.deepEqual(directory.entries, []);
  const primary = directory.hosts[0]!;
  assert.equal(primary.id, remoteProjectHostIdForSourceServer(SERVER_ID));
  assert.equal(primary.membershipId, SERVER_ID);
  assert.equal(primary.connectionStatus, "online");
  assert.equal(primary.kind, "ssh");
  assert.equal(primary.lastOpenedAt, 42);
  assert.ok(primary.target && primary.target.kind === "ssh");
  const offline = directory.hosts[1]!;
  assert.equal(offline.connectionStatus, "offline");
  assert.equal(offline.lastOpenedAt, undefined);
});

test("readDirectory：进行中态（bootstrapping）投影为 connecting，错误随 state 透传", async () => {
  const { service } = fakeService({ state: "bootstrapping", error: "boom" });
  const directory = await service.readDirectory();
  const host = directory.hosts[0]!;
  assert.equal(host.connectionStatus, "connecting");
  assert.equal(host.lastConnectionError, "boom");
  assert.equal(host.lastConnectionStatus, "bootstrapping");
});

test("hostId 往返：统一 identity 工具构造与解析一致；异形/local 拒绝", () => {
  const hostId = remoteProjectHostIdForSourceServer(SERVER_ID);
  assert.match(hostId, /^remote:server:/);
  assert.equal(sourceServerIdFromRemoteProjectHostId(hostId), SERVER_ID);
  assert.equal(isRemoteProjectHostId(hostId), true);
  assert.equal(isRemoteProjectHostId("local"), false);
  assert.equal(isRemoteProjectHostId("/home/user"), false);
});

test("connectHost：retain 意图连接 + 凭据链缺席拒绝 + host 消失拒绝", async () => {
  const hostId = remoteProjectHostIdForSourceServer(SERVER_ID);
  const { service } = fakeService({ state: "offline" });
  await service.connectHost(hostId);
  assert.equal(connectCalls.length, 1);
  assert.equal(connectCalls[0]!.membershipIntent, "retain");
  assert.equal(connectCalls[0]!.profile.profileId, PROFILE_ID);
  // 凭据链缺席：resolveSilentConnectionTarget 为 null 时不发起连接。
  const broken = createDirectoryRemoteProjectService({
    directory: () =>
      ({
        snapshot: fakeSnapshot,
        resolveSilentConnectionTarget: async () => null,
      }) as unknown as SourceServerDirectory,
    manager: () => fakeManager({ state: "offline" }),
  });
  await assert.rejects(broken.connectHost(hostId), /connector-unavailable/);
  assert.equal(connectCalls.length, 1, "凭据缺席不得发起 manager.connect");
  // 设备消失：requireRemoteHost 读不到投影时显式拒绝。
  const { service: gone, removeServer } = fakeService({ state: "offline" });
  removeServer();
  await assert.rejects(gone.connectHost(hostId), /host-not-found/);
});

test("写面挂账边界：saveHost/removeHost/addEntry 显式错误，refreshEntry false，removeEntry no-op", async () => {
  const hostId = remoteProjectHostIdForSourceServer(SERVER_ID);
  const { service } = fakeService({ state: "offline" });
  await assert.rejects(
    service.saveHost({ id: hostId, target: {} as never }),
    /save-host-unavailable/,
  );
  await assert.rejects(service.removeHost(hostId), /remove-host-unavailable/);
  await assert.rejects(
    service.addEntry({ hostId, project: { projectId: null as never, name: "", roots: [] } }),
    /entry-persistence-unavailable/,
  );
  assert.equal(
    await service.refreshEntry({
      entryId: "e1",
      expectedLastSyncedAt: null,
      project: { projectId: null as never, name: "", roots: [] },
    }),
    false,
  );
  await service.removeEntry("e1");
  // bindHost：存活设备返回投影；resolvedId 异形（迟到/已移除）返回 null。
  const bound = await service.bindHost({ id: hostId, membershipId: SERVER_ID, resolvedId: hostId });
  assert.equal(bound?.membershipId, SERVER_ID);
  assert.equal(
    await service.bindHost({ id: hostId, membershipId: SERVER_ID, resolvedId: "remote:ssh:x" }),
    null,
  );
});

test("读边界：local/异形 hostId 显式拒绝（不静默当作本机）", async () => {
  const { service } = fakeService({ state: "offline" });
  await assert.rejects(service.connectHost("local"), /local-host/);
  await assert.rejects(service.connectHost("/home/user"), /local-host/);
});
