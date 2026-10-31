import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import {
  getLegacyTaskSessionSnapshotPath,
  getZCodeDataRootDir,
  setDataBaseDir,
} from "../src/paths.js";
import { createMemoryService } from "../src/memory/memoryService.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";

const meta = {
  taskId: "wrapper-example",
  traceId: "trace-example",
  title: "Imported example",
  workspacePath: "/example/workspace",
  createdAt: 1,
  updatedAt: 2,
  mode: "build" as const,
  provider: "glm" as const,
};

test("current Project Memory catalog and files remain readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-current-memory-"));
  setDataBaseDir(dir);
  try {
    const workspaceId = "example-0123456789abcdef";
    const memoryRoot = join(
      getZCodeDataRootDir(),
      "cli",
      "memories",
      "projects",
      workspaceId,
      "memory",
    );
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Project memory\n");
    await writeFile(join(memoryRoot, "workflow.md"), "Use the current project workflow.\n");
    const service = createMemoryService();
    const catalog = await service.listProjectMemories();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]?.id, workspaceId);
    assert.deepEqual(
      catalog[0]?.files.map((file) => file.name),
      ["MEMORY.md", "workflow.md"],
    );
    const file = await service.readProjectMemoryFile({ workspaceId, fileName: "workflow.md" });
    assert.equal(file.content, "Use the current project workflow.\n");
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("opening the task index migrates retired ACP wrapper IDs to real session IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-acp-index-"));
  const path = join(dir, "tasks.sqlite");
  // FORK(upgrade-316)：上游把构造签名扩成 (migrationSettings?, storageHostId?, startupDbPath?, busyTimeoutMs?)，
  // 旧的单参数 `new TaskIndexRepo(path)` 会把 path 错当 migrationSettings、startupDbPath 落空，
  // 于是 ensureReady 走 getTasksIndexDatabasePath() 指向**真实用户数据目录**。库路径必须走第三个参数。
  const repo = new TaskIndexRepo(undefined, undefined, path);
  try {
    // FORK(upgrade-316)：fork 旧的 syncTaskMeta 是「插入 task 行 + 分组登记」的入口，
    // 上游 v3.16 把它拆了：插入走 applyCliFacts（taskIndexRepo.ts:926，内部 writeRecord +
    // admitTaskGroup），分组登记由 TaskGroupRepository.admit 在更新路径与 UI 读路径各自完成。
    // 这里只需要一条 task 行做后续断言，故用当前真实的插入入口。
    await repo.applyCliFacts({ meta });
    repo.close();
    const database = new DatabaseSync(path);
    try {
      // 模拟 z-code-2 早期库：task_id 是 wrapper id，真实 ZCode session id 在旧列 acp_session_id。
      database.exec("ALTER TABLE tasks ADD COLUMN acp_session_id TEXT");
      database
        .prepare("UPDATE tasks SET acp_session_id = ? WHERE task_id = ?")
        .run("session-example", meta.taskId);
    } finally {
      database.close();
    }
    await repo.ensureReady();
    repo.close();
    const reopened = new DatabaseSync(path);
    try {
      // FORK(upgrade-316)：fork 旧断言是「打开时列原样保留」（旧 syncTaskMeta 时代没有迁移）。
      // 上游 v3.16 在初始化时跑 migrateLegacyAcpTaskIds（taskIndexRepo.ts:402-405 注释：
      // z-code-2 早期 task_id 是 wrapper id，真实 id 在 acp_session_id；初始化时把索引行迁到
      // 真实 session id，后续统一走新协议正常路径）。本用例改为钉住该迁移的正确结果：
      // 行还在、迁到真实 session id、旧列清空——用户数据不被丢弃，只是 id 归位。
      const row = reopened
        .prepare("SELECT task_id, acp_session_id, workspace_path FROM tasks")
        .get();
      assert.equal(row?.task_id, "session-example");
      assert.equal(row?.acp_session_id, null);
      assert.equal(row?.workspace_path, meta.workspacePath);
    } finally {
      reopened.close();
    }
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing sessions fall back to the read-only legacy ACP snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-acp-snapshot-"));
  setDataBaseDir(dir);
  const path = getLegacyTaskSessionSnapshotPath(meta.workspacePath, meta.taskId);
  const snapshot = parseLegacyTaskSessionFile({ meta, messages: [], toolCalls: [] });
  await mkdir(dirname(path), { recursive: true });
  const content = JSON.stringify(snapshot);
  await writeFile(path, content);
  const ownerError = new Error(`Session not found: ${meta.taskId}`);
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async resumeSession() {
        throw ownerError;
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      // FORK (upstream-v3.15.1-backport): #18 legacy ACP 只读恢复后，该场景由「抛 owner error」
      // 改为「按 legacy snapshot 恢复只读历史」（上游 v3.15.1 直接删除本用例，
      // fork 保留覆盖并改断言新行为）。
      const snapshot = await service.getTaskSnapshot({ ...meta, clientMode });
      assert.equal(snapshot?.meta.taskId, meta.taskId);
      assert.equal(snapshot?.meta.title, meta.title);
    }
    assert.equal(await readFile(path, "utf8"), content);
  } finally {
    service.disposeAll();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("current session recovery preserves Desktop and replayable projections", async () => {
  const snapshot = zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: meta.taskId,
      workspace: { workspacePath: meta.workspacePath, workspaceKey: meta.workspacePath },
      sessionKind: "interactive",
      title: meta.title,
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: meta.taskId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 4, stateRevision: 3, pendingRequestIds: [] },
    messages: [],
    slashCommands: [{ name: "compact", description: "Compact" }],
  });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const disposable = () => ({ dispose() {} });
  const resumed: unknown[] = [];
  const indexed: unknown[] = [];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async resumeSession(params: unknown) {
        resumed.push(params);
        return snapshot;
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      async syncTaskMeta(params: { meta: typeof meta }) {
        indexed.push(params.meta);
        return params.meta;
      },
      // FORK(upgrade-316)：上游 v3.16 的 syncer 侧改走 updateTaskPresentation 写展示缓存
      // （zcodeTaskRepo.ts 的 updateTaskPresentation），语义等价于 fork 旧的 syncTaskMeta 写入面。
      // 本用例断言 indexed.length === 3（两次 getTaskSnapshot + 一次 resumeTask 各写一次），
      // 所以计数点必须挂在这个新方法上。
      async updateTaskPresentation(params: typeof meta & { presentation?: unknown }) {
        indexed.push(params);
        return params;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter() {
        return { fire() {} };
      },
      ensureSessionSubscription() {},
      // FORK(upgrade-316)：上游 syncer 的写面在真实实现里会落到 taskIndexRepo.updateTaskPresentation；
      // 本桩直接替代 syncer，所以计数点必须挂在这里（否则 indexed 恒为 0）。
      async syncSnapshotAndBroadcast() {
        indexed.push(meta);
        return meta;
      },
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    const desktop = await service.getTaskSnapshot({ ...meta, clientMode: "desktop-continuous" });
    const mobile = await service.getTaskSnapshot({ ...meta, clientMode: "web-remote-replayable" });
    assert.equal(desktop?.meta.taskId, meta.taskId);
    assert.equal(desktop?.meta.provider, "glm");
    assert.deepEqual(desktop?.slashCommands, snapshot.slashCommands);
    assert.equal(desktop?.runtime?.pendingElicitations, undefined);
    assert.deepEqual(mobile?.runtime?.pendingElicitations, []);
    assert.equal((await service.resumeTask(meta)).taskId, meta.taskId);
    assert.equal(resumed.length, 3);
    assert.equal(indexed.length, 3);
  } finally {
    service.disposeAll();
  }
});

test("current Provider configuration starts without an old config migration callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-provider-current-"));
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    await runtime.start();
    const config = await runtime.configService.read();
    assert.ok(config.zcodeBuiltinRevision);
    assert.deepEqual(config.personalProviderOrder, []);
    assert.deepEqual(config.personalProviders.toJSON(), []);
  } finally {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
