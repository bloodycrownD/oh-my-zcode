// T-RP1 + T-RP6（backlog-sweep Step 1/2，phase-sidebar-p3 blocking）：
// T-RP1 — remote-projects CRUD：hosts/entries 增删改查、membership 换代守卫、
//         refreshEntry CAS 与旧单根入口判重、initial_position 投影、controller-only 与 host 上限。
// T-RP6 — 空 hosts 库首连全链：saveHost→afterChange 广播→bindHost→readDirectory
//         出现稳定 `remote:server:<id>` host（admission 端口 commit 主路径）。
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
import type { RemoteTarget } from "@zcode/shared";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "../src/project-storage/contract.js";
import { addProjectSchema } from "../src/project-storage/schema.js";
import {
  createRemoteProjectService,
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
} from "../src/remote-projects/index.js";

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

test("T-RP6: 空 hosts 库首连全链（saveHost→广播→bindHost→稳定 server host）", async () => {
  await withRemoteProjects(async ({ changes, service }) => {
    assert.deepEqual((await service.readDirectory()).hosts, []);
    // 首连：profile 尚未握手，host 身份按连接地址派生。
    const admission = createRemoteProjectConnectionAdmission(service);
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
    const admission = createRemoteProjectConnectionAdmission(service);
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
