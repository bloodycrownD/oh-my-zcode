// T-RP1 + T-RP6（backlog-sweep Step 1/2，phase-sidebar-p3 blocking）：
// T-RP1 — remote-projects CRUD：hosts/entries 增删改查、membership 换代守卫、
//         refreshEntry CAS 与旧单根入口判重、initial_position 投影、controller-only 与 host 上限。
// T-RP6 — 空 hosts 库首连全链：saveHost→afterChange 广播→bindHost→readDirectory
//         出现稳定 `remote:server:<id>` host（admission 端口 commit 主路径）。
// T-RP3 — createProjectService.resolveHost 路由两态（host 在→所属 Host 服务；不在→project.host-offline）。
// T-RP4 — resolveServerProjectService 两分支（virtualProjects 转发 / legacy 单 root 只读投影）。
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/remoteProjectsService.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  ZCODE_COMPATIBILITY_MANIFEST,
  type RemoteTarget,
} from "@zcode/shared";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "../src/project-storage/contract.js";
import { addProjectSchema } from "../src/project-storage/schema.js";
import type { ProjectRepositoryContract } from "../src/project-storage/contract.js";
import type { IServiceAccessor } from "../src/accessor.js";
import { createProjectService } from "../src/project/index.js";
import type { IProjectService } from "../src/project/contract.js";
import {
  createRemoteProjectService,
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
} from "../src/remote-projects/index.js";
// resolveServerProjectService 的实现在 desktop Host 装配层（remoteWorkspaceServiceCollection.ts），
// 本批未登记 desktop 测试入口，因此从 services 测试直接驱动同一实现，避免形状断言。
import { resolveServerProjectService } from "../../desktop/src/host/remoteWorkspaceServiceCollection.js";
// 换代发布的实现在 desktop 连接管理器：adapter/connectServer/directory 都是构造参数，
// 可用测试 double 直接驱动真实发布链，替代源码形状断言。
import { SourceServerConnectionManager } from "../../desktop/src/host/sourceServerConnectionManager.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const SSH_TARGET: RemoteTarget = { kind: "ssh", host: "devbox", username: "omz", port: 22 };
const PROJECT = {
  projectId: "project-a",
  name: "app",
  roots: [{ rootPath: "/srv/app", position: 0, isPrimary: true }],
};

async function withRemoteProjects(
  run: (context: {
    dir: string;
    db: ReturnType<typeof createDatabase>;
    changes: () => number;
    service: ReturnType<typeof createRemoteProjectService>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omz-remote-projects-"));
  const db = createDatabase(join(dir, "tasks-index.sqlite"));
  let count = 0;
  try {
    const service = createRemoteProjectService({
      database: async () => db,
      afterChange: () => {
        count += 1;
      },
    });
    await run({ dir, db, changes: () => count, service });
  } finally {
    db.close();
    // Windows 下 sqlite 连接刚关闭时文件锁可能滞后释放；清理是 best-effort，不影响断言。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  addProjectSchema(db);
  // 0007 迁移补的混排位置列；本固定装置的读写面只依赖 schema 形状。
  db.exec("ALTER TABLE remote_project_entries ADD COLUMN initial_position INTEGER");
  return db;
}

test("T-RP1: hosts/entries CRUD + membership 守卫 + CAS 版本 + initial_position", async () => {
  await withRemoteProjects(async ({ db, changes, service }) => {
    const hostId = remoteProjectHostIdForTarget(SSH_TARGET);
    assert.match(hostId, /^remote:ssh:devbox:22:omz$/);
    const host = await service.saveHost({ id: hostId, target: SSH_TARGET });
    assert.equal(host.id, hostId);
    assert.equal(host.kind, "ssh");
    assert.equal(host.target?.kind, "ssh");
    // 重复保存不得换代 membership：addEntry 的 expectedMembershipId 陈旧守卫依赖它。
    const again = await service.saveHost({ id: hostId, target: SSH_TARGET });
    assert.equal(again.membershipId, host.membershipId);
    assert.equal(changes(), 2, "每次成功保存都必须广播 state:projects");
    const directory = await service.readDirectory();
    assert.equal(directory.hosts.length, 1);
    assert.deepEqual(directory.entries, []);

    const entry = await service.addEntry({
      hostId,
      expectedMembershipId: host.membershipId,
      project: PROJECT,
    });
    assert.equal(entry.hostId, hostId);
    assert.equal(entry.projectId, "project-a");
    assert.equal(entry.name, "app");
    assert.ok(entry.lastSyncedAt !== null);
    // 同一 projectId 再次登记复用 entry ID，只推进同步版本。
    const repeated = await service.addEntry({ hostId, project: PROJECT });
    assert.equal(repeated.id, entry.id);
    assert.ok((repeated.lastSyncedAt ?? 0) > (entry.lastSyncedAt ?? 0));
    await assert.rejects(
      () =>
        service.addEntry({ hostId, expectedMembershipId: "stale-membership", project: PROJECT }),
      /remote-project\.host-removed/,
    );

    // refreshEntry 用读取前版本做 CAS：迟到/旧版本返回 false，不覆盖新缓存。
    assert.equal(
      await service.refreshEntry({
        entryId: entry.id,
        expectedLastSyncedAt: 1,
        project: { ...PROJECT, name: "stale" },
      }),
      false,
    );
    const current = (await service.readDirectory()).entries.find((item) => item.id === entry.id)!;
    assert.equal(
      await service.refreshEntry({
        entryId: entry.id,
        expectedLastSyncedAt: current.lastSyncedAt,
        project: { ...PROJECT, name: "app-v2" },
      }),
      true,
    );
    const refreshed = (await service.readDirectory()).entries.find((item) => item.id === entry.id)!;
    assert.equal(refreshed.name, "app-v2");

    // initial_position 来自 3.15 混排种子列，只读投影给控制端排序初值。
    db.prepare("UPDATE remote_project_entries SET initial_position=? WHERE entry_id=?").run(
      7,
      entry.id,
    );
    const positioned = (await service.readDirectory()).entries.find(
      (item) => item.id === entry.id,
    )!;
    assert.equal(positioned.initialPosition, 7);

    // 幂等删除入口；host 保留。
    await service.removeEntry(entry.id);
    await service.removeEntry(entry.id);
    assert.deepEqual((await service.readDirectory()).entries, []);
    assert.equal((await service.readDirectory()).hosts.length, 1);

    // 本机 local 与 controller-only 两条拒绝边界。
    await assert.rejects(
      () => service.saveHost({ id: "local", target: SSH_TARGET }),
      /remote-project\.local-host/,
    );
    const replica = createRemoteProjectService({
      database: async () => db,
      controller: false,
    });
    assert.deepEqual(await replica.readDirectory(), { hosts: [], entries: [] });
    await assert.rejects(
      () => replica.saveHost({ id: hostId, target: SSH_TARGET }),
      /remote-project\.controller-only/,
    );

    await service.removeHost(hostId);
    assert.deepEqual((await service.readDirectory()).hosts, []);
  });
});

test("T-RP1: 旧单根入口 refreshEntry 判重保留已解析 entry", async () => {
  await withRemoteProjects(async ({ service }) => {
    const hostId = remoteProjectHostIdForTarget(SSH_TARGET);
    await service.saveHost({ id: hostId, target: SSH_TARGET });
    const legacyA = await service.addEntry({
      hostId,
      project: {
        projectId: `${LEGACY_SINGLE_ROOT_PROJECT_PREFIX}aaaa`,
        name: "legacy-a",
        roots: [{ rootPath: "/srv/a", position: 0, isPrimary: true }],
      },
    });
    const legacyB = await service.addEntry({
      hostId,
      project: {
        projectId: `${LEGACY_SINGLE_ROOT_PROJECT_PREFIX}bbbb`,
        name: "legacy-b",
        roots: [{ rootPath: "/srv/b", position: 0, isPrimary: true }],
      },
    });
    // 第二个旧入口先解析到真实项目（此时没有其它同项目入口，就地升级）。
    assert.equal(
      await service.refreshEntry({
        entryId: legacyB.id,
        expectedLastSyncedAt: legacyB.lastSyncedAt,
        project: PROJECT,
      }),
      true,
    );
    // 第一个旧入口再解析到同一项目：保留已解析的 entry B，删除当前 CAS 通过的旧入口 A。
    assert.equal(
      await service.refreshEntry({
        entryId: legacyA.id,
        expectedLastSyncedAt: legacyA.lastSyncedAt,
        project: PROJECT,
      }),
      true,
    );
    const entries = (await service.readDirectory()).entries;
    assert.deepEqual(
      entries.map((item) => item.id),
      [legacyB.id],
    );
    assert.equal(entries[0]?.projectId, "project-a");
  });
});

test("T-RP1: remote host 上限 20 条", async () => {
  await withRemoteProjects(async ({ service }) => {
    for (let index = 0; index < 20; index += 1)
      await service.saveHost({
        id: remoteProjectHostIdForTarget({
          kind: "ssh",
          host: `devbox-${index}`,
          username: "omz",
        }),
        target: { kind: "ssh", host: `devbox-${index}`, username: "omz" },
      });
    await assert.rejects(
      () =>
        service.saveHost({
          id: remoteProjectHostIdForTarget({
            kind: "ssh",
            host: "devbox-overflow",
            username: "omz",
          }),
          target: { kind: "ssh", host: "devbox-overflow", username: "omz" },
        }),
      /remote-project\.host-limit/,
    );
  });
});

/** G-1：捕获 admission 入参 intent——直调面证明调用方传值，manager 面证明默认值。 */
function captureAdmissionIntents(
  admission: ReturnType<typeof createRemoteProjectConnectionAdmission>,
) {
  const intents: Array<"add" | "retain"> = [];
  const wrapped: typeof admission = async (input) => {
    intents.push(input.intent);
    return admission(input);
  };
  return { admission: wrapped, intents };
}

test("T-RP6: 空 hosts 库首连全链（saveHost→广播→bindHost→稳定 server host）", async () => {
  await withRemoteProjects(async ({ changes, service }) => {
    assert.deepEqual((await service.readDirectory()).hosts, []);
    // 首连：profile 尚未握手，host 身份按连接地址派生。
    const { admission, intents } = captureAdmissionIntents(
      createRemoteProjectConnectionAdmission(service),
    );
    const commit = await admission({
      profile: {
        profileId: "22222222-2222-4222-8222-222222222222",
        transport: "ssh",
        target: { kind: "ssh", host: "devbox", username: "omz", port: 22 },
        createdAt: 1,
        lifecycleState: "active",
      },
      intent: "add",
      confirmIdentityChange: false,
    });
    assert.deepEqual(intents, ["add"], "首连必须显式走 add 意图");
    const admissionId = remoteProjectHostIdForTarget(SSH_TARGET);
    const pending = (await service.readDirectory()).hosts;
    assert.deepEqual(
      pending.map((host) => host.id),
      [admissionId],
    );
    assert.equal(changes(), 1, "saveHost 必须完成 state:projects 广播");
    // 握手回执 commit：地址派生行收敛为稳定 remote:server:<id> host。
    await commit(SERVER_ID);
    const hosts = (await service.readDirectory()).hosts;
    assert.equal(hosts.length, 1, "同一设备只保留稳定身份一行");
    assert.equal(hosts[0]?.id, remoteProjectHostIdForTarget(SSH_TARGET, SERVER_ID));
    assert.match(hosts[0]!.id, /^remote:server:11111111-1111-4111-8111-111111111111$/);
    assert.equal(hosts[0]?.target?.kind, "ssh");
    assert.equal(changes(), 2, "身份收敛同样必须广播 state:projects");
  });
});

test("T-RP6: retain 意图对已移除成员显式拒绝（不重建入口）", async () => {
  await withRemoteProjects(async ({ service }) => {
    const { admission, intents } = captureAdmissionIntents(
      createRemoteProjectConnectionAdmission(service),
    );
    await assert.rejects(
      () =>
        admission({
          profile: {
            profileId: "33333333-3333-4333-8333-333333333333",
            transport: "ssh",
            target: { kind: "ssh", host: "devbox", username: "omz" },
            createdAt: 1,
            lifecycleState: "active",
          },
          intent: "retain",
          confirmIdentityChange: false,
        }),
      /remote-project\.host-removed/,
    );
    assert.deepEqual(intents, ["retain"], "被动重连必须显式走 retain 意图");
    assert.deepEqual((await service.readDirectory()).hosts, []);
    assert.equal(
      remoteProjectHostIdForProfile({
        profileId: "33333333-3333-4333-8333-333333333333",
        transport: "ssh",
        target: { kind: "ssh", host: "devbox", username: "omz" },
        createdAt: 1,
        lifecycleState: "active",
      }),
      remoteProjectHostIdForTarget({ kind: "ssh", host: "devbox", username: "omz" }),
    );
  });
});

/** T-RP3 的投影仓库 double：只统计「本机仓库是否被误读」，不提供真实存储语义。 */
function readOnlyRepository(countLocalRead: () => void): ProjectRepositoryContract {
  return {
    readTree: () => {
      countLocalRead();
      return { projects: [], tasks: [] };
    },
  } as unknown as ProjectRepositoryContract;
}

test("T-RP3: resolveHost 在/不在两态（缺失时 project.host-offline，不回落本机）", async () => {
  const remoteHostId = "remote:ssh:devbox:22:omz";
  const delegated: string[] = [];
  let localReads = 0;
  const remoteProjects = [{ id: "p1", hostId: remoteHostId, roots: [] }] as unknown as Awaited<
    ReturnType<IProjectService["readProjects"]>
  >;
  const remoteService = {
    async readProjects() {
      delegated.push("readProjects");
      return remoteProjects;
    },
    async deleteProject(id: string) {
      delegated.push(`deleteProject:${id}`);
    },
  } as unknown as IProjectService;

  const routed = createProjectService({
    repository: async () => readOnlyRepository(() => (localReads += 1)),
    workspaceDirectory: join(tmpdir(), "omz-project-routing"),
    ownerHostId: "local",
    resolveHost: async (hostId) => {
      delegated.push(`resolveHost:${hostId}`);
      return remoteService;
    },
  });
  // host 在：跨 Host 请求经 resolveHost 转发到所属 Host 服务。
  assert.deepEqual(await routed.readProjects({ hostId: remoteHostId }), remoteProjects);
  await routed.deleteProject("p1", remoteHostId);
  assert.deepEqual(delegated, [
    `resolveHost:${remoteHostId}`,
    "readProjects",
    `resolveHost:${remoteHostId}`,
    "deleteProject:p1",
  ]);
  assert.equal(localReads, 0, "跨 Host 路由不得读取本机仓库");

  // ownerHostId 命中的 hostId 仍属本机，不经过 resolveHost。
  assert.deepEqual(await routed.readProjects({ hostId: "local" }), []);
  assert.equal(localReads, 1);

  // host 不在：未注入 resolveHost 时显式拒绝，不能静默回落到本机仓库。
  const offline = createProjectService({
    repository: async () => readOnlyRepository(() => (localReads += 1)),
    workspaceDirectory: join(tmpdir(), "omz-project-routing"),
  });
  await assert.rejects(
    () => offline.readProjects({ hostId: remoteHostId }),
    /project\.host-offline/,
  );
  await assert.rejects(() => offline.deleteProject("p1", remoteHostId), /project\.host-offline/);
  assert.equal(localReads, 1, "拒绝路径同样不得读取本机仓库");
});

/** T-RP4 的 IServiceAccessor double：只实现 legacy 投影实际读取的四个通道。 */
function connectionServicesDouble(projectService?: IProjectService): {
  accessor: IServiceAccessor;
  readdirPaths: string[];
} {
  const readdirPaths: string[] = [];
  const accessor = {
    projectService,
    fileService: {
      async readdir(input: { path: string }) {
        readdirPaths.push(input.path);
        return [];
      },
    },
    systemService: {
      async info() {
        return { platform: "linux", homedir: "/home/omz" };
      },
    },
    settingService: {
      async get() {
        return {
          lastWorkspaceSession: [
            { kind: "local", workspacePath: "/srv/app" },
            { kind: "local", workspacePath: "/srv/talk", workspacePurpose: "conversation" },
          ],
          recentProjects: ["/srv/other"],
        };
      },
    },
    zcodeTaskService: {
      async listTasks() {
        return [];
      },
      async listPinnedTasks() {
        return [];
      },
      async listArchivedTasks() {
        return [];
      },
    },
  } as unknown as IServiceAccessor;
  return { accessor, readdirPaths };
}

test("T-RP4: resolveServerProjectService 两分支（virtual 转发 / legacy 只读）", async () => {
  const serverId = "9f7c1b2a-0000-4000-8000-000000000001";
  const projectionHostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: "/" }),
  )!;
  const virtualProjectService = {
    async readProjects() {
      return [{ id: "virtual", hostId: projectionHostId, roots: [] }];
    },
  } as unknown as IProjectService;
  const { accessor, readdirPaths } = connectionServicesDouble(virtualProjectService);

  // virtual 分支：握手声明 virtualProjects 时直接转发远端权威项目通道（同一实例）。
  assert.equal(
    resolveServerProjectService({ connectionServices: accessor, serverId, virtualProjects: true }),
    virtualProjectService,
  );
  // 声明了能力但通道缺席：装配期显式拒绝，不静默退回 legacy。
  assert.throws(
    () =>
      resolveServerProjectService({
        connectionServices: connectionServicesDouble().accessor,
        serverId,
        virtualProjects: true,
      }),
    /Remote virtual-project RPC registration incomplete/,
  );

  // legacy 分支：false 与缺省同形态，返回单 root 只读投影。
  for (const virtualProjects of [false, undefined]) {
    const legacy = resolveServerProjectService({
      connectionServices: accessor,
      serverId,
      ...(virtualProjects === undefined ? {} : { virtualProjects }),
    });
    assert.notEqual(legacy, virtualProjectService, "legacy 分支不得复用远端权威项目通道");
    const projects = await legacy.readProjects();
    // catalog 来自远端 settings 投影：本地 session 的 conversation 目录排除，recentProjects 参与合成。
    assert.deepEqual(
      projects.map((project) => project.roots[0]?.rootPath),
      ["/srv/app", "/srv/other"],
    );
    assert.ok(projects.every((project) => project.hostId === projectionHostId));
    assert.ok(projects.every((project) => project.legacySingleRoot === true));
    assert.ok(
      projects.every((project) => project.id.startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX)),
    );
    // host 归属校验：非本投影 hostId 直接拒绝。
    await assert.rejects(
      () => legacy.readProjects({ hostId: "remote:ssh:devbox:22:omz" }),
      /project\.cross-host-move/,
    );
    // 目录读取走远端文件服务，路径按远端平台规则归一，不触碰本机文件系统。
    const directory = await legacy.readDirectory({ path: "/srv/./app" });
    assert.equal(directory.path, "/srv/app");
    assert.deepEqual(readdirPaths.at(-1), "/srv/app");
    // 未给路径时以远端 homedir 为起点，而不是本机主目录。
    assert.equal((await legacy.readDirectory()).path, "/home/omz");
    // 写面全部 project.legacy-read-only。
    const writes: Array<() => Promise<unknown>> = [
      () => legacy.saveProject({ name: "legacy-write" }),
      () => legacy.deleteProject("project-a"),
      () =>
        legacy.moveTask({
          task: { taskId: "task-a", workspacePath: "/srv/app" },
          projectId: "project-a",
        }),
      () => legacy.reorderProjects([]),
    ];
    for (const write of writes) await assert.rejects(write, /project\.legacy-read-only/);
  }
});

/**
 * P2-1（backlog-sweep fix-svc）：Directory 换代确认后旧 Profile 已退役，Manager 的在线发布
 * 必须挂到 handshake 回执的 effectiveProfile；回执缺席（测试 double）时回落入参 Profile。
 * manager 的 adapter/connectServer/directory/admission 都是构造参数，这里驱动真实发布链。
 * G-1：admission 入参必须被捕获——裸调 connect() 与显式 membershipIntent 的 intent 差异
 * 只有在断言入参时才具备区分力（把 connect() 的 `?? "add"` 改成 `?? "retain"` 必须转红）。
 */
const CONNECTED_SERVER_ID = "99999999-9999-4999-8999-999999999999";

function createConnectedManager(options: {
  recordHandshake?: (profileId: string) => Promise<unknown>;
  onCommit?: () => void;
  admitConnection?: ReturnType<typeof createRemoteProjectConnectionAdmission>;
}): {
  manager: SourceServerConnectionManager;
  states: Array<{ profileId: string; state: string }>;
  admissions: Array<{ profileId: string; intent: "add" | "retain" }>;
} {
  const admissions: Array<{ profileId: string; intent: "add" | "retain" }> = [];
  const injectedAdmission = options.admitConnection;
  const manager = new SourceServerConnectionManager({
    createAdapter: () =>
      ({
        async probe() {
          return {
            installed: true,
            installedVersion: ZCODE_COMPATIBILITY_MANIFEST.productVersion,
          };
        },
        async ensureDaemon() {
          return { ingressToken: "ingress-token" };
        },
        // 注入 connectServer 后不会走到 openChannel/installOrUpdate；命中即视为夹具失效。
        async openChannel() {
          throw new Error("unexpected openChannel");
        },
        async installOrUpdate() {
          throw new Error("unexpected installOrUpdate");
        },
      }) as never,
    connectServer: async () =>
      ({
        serverInfo: {
          serverId: CONNECTED_SERVER_ID,
          version: ZCODE_COMPATIBILITY_MANIFEST.productVersion,
          protocolVersion: 1,
          authRequired: false,
          workspaces: [],
          compatibility: ZCODE_COMPATIBILITY_MANIFEST,
          capabilities: { desktopContinuous: true, websocketRpc: true },
        },
        services: {},
        dispose() {},
      }) as never,
    ...(options.recordHandshake
      ? { directory: { recordHandshake: options.recordHandshake as never } }
      : {}),
    admitConnection: async (input) => {
      admissions.push({ profileId: input.profile.profileId, intent: input.intent });
      if (injectedAdmission) return injectedAdmission(input);
      return async () => {
        options.onCommit?.();
      };
    },
  });
  const states: Array<{ profileId: string; state: string }> = [];
  manager.onDidChangeState((state) =>
    states.push({ profileId: state.profileId, state: state.state }),
  );
  return { manager, states, admissions };
}

test("P2-1: 换代确认后在线发布改挂 effectiveProfile（旧 Profile 收敛 offline）", async () => {
  const OLD_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
  const NEW_PROFILE_ID = "22222222-2222-4222-8222-222222222222";
  let commits = 0;
  const { manager, states, admissions } = createConnectedManager({
    recordHandshake: async () => ({
      identityChanged: true,
      migrationFailures: [],
      effectiveProfileId: NEW_PROFILE_ID,
      effectiveProfile: { profileId: NEW_PROFILE_ID },
    }),
    onCommit: () => (commits += 1),
  });
  const managed = await manager.connect({
    profile: {
      profileId: OLD_PROFILE_ID,
      transport: "ssh",
      sourceServerId: "source-before-reinstall",
    },
    target: SSH_TARGET,
    // 用户已确认「重装后的 Source 是新设备」，Directory 才会提交换代。
    confirmIdentityChange: true,
  });
  assert.equal(managed.profileId, NEW_PROFILE_ID, "在线发布必须挂新 Profile");
  assert.equal(commits, 1, "身份收敛后仍需完成成员 commit");
  assert.deepEqual(
    admissions.map((entry) => entry.intent),
    ["add"],
    "裸调 connect() 必须补默认 intent add（上游 :348），否则空库首连被 retain 判 host-removed",
  );
  assert.equal(manager.getStateByProfile(NEW_PROFILE_ID).state, "online");
  assert.equal(
    manager.getStateByProfile(OLD_PROFILE_ID).state,
    "offline",
    "退役 Profile 不得留在在线态",
  );
  assert.ok(
    !states.some((event) => event.profileId === OLD_PROFILE_ID && event.state === "online"),
    "旧 Profile 不得收到 online 事件（设备卡按 profileId 派生 Source 身份）",
  );
});

test("P2-1: handshake 回执缺 effectiveProfile 时回落入参 Profile（测试 double 路径）", async () => {
  const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
  const { manager, admissions } = createConnectedManager({
    recordHandshake: async () => ({ identityChanged: false, migrationFailures: [] }),
  });
  const managed = await manager.connect({
    profile: { profileId: PROFILE_ID, transport: "ssh", sourceServerId: "source-before-reinstall" },
    target: SSH_TARGET,
    // 启动静默重连显式传 retain：admission 必须收到 retain 而非被默认值覆盖。
    membershipIntent: "retain",
    confirmIdentityChange: true,
  });
  assert.equal(managed.profileId, PROFILE_ID);
  assert.deepEqual(
    admissions.map((entry) => entry.intent),
    ["retain"],
    "显式 membershipIntent 必须原样到达 admission",
  );
  assert.equal(manager.getStateByProfile(PROFILE_ID).state, "online");
});

test("T-RP6: 裸调 connect() 默认 intent add，真实 admission 端到端收敛出 remote:server:<id>", async () => {
  await withRemoteProjects(async ({ service }) => {
    assert.deepEqual((await service.readDirectory()).hosts, []);
    const { admission, intents } = captureAdmissionIntents(
      createRemoteProjectConnectionAdmission(service),
    );
    const { manager, admissions } = createConnectedManager({ admitConnection: admission });
    const managed = await manager.connect({
      profile: {
        profileId: "44444444-4444-4444-8444-444444444444",
        transport: "ssh",
      },
      target: SSH_TARGET,
    });
    // connect() 不传 membershipIntent 时必须补 add：空 hosts 库上 retain 会直接抛 host-removed。
    assert.deepEqual(
      admissions.map((entry) => entry.intent),
      ["add"],
      "裸调 connect() 必须补默认 intent add（上游 :348）",
    );
    assert.deepEqual(intents, ["add"], "真实 admission 收到的 intent 也是 add");
    assert.equal(managed.sourceServerId, CONNECTED_SERVER_ID);
    const hosts = (await service.readDirectory()).hosts;
    assert.equal(hosts.length, 1, "同一设备只保留稳定身份一行");
    assert.equal(
      hosts[0]?.id,
      remoteProjectHostIdForTarget(SSH_TARGET, CONNECTED_SERVER_ID),
      "连接提交后 readDirectory 必须出现 remote:server:<id> 稳定行（端到端闭环）",
    );
    assert.match(hosts[0]!.id, /^remote:server:/);
  });
});
