/**
 * T-R3（magic-context-memory-management Step 5）：services 出口的降级契约常驻回归。
 *
 * `packages/services/src/zcode-agent/zcodeAgentService.ts` 的两个记忆管理包装：
 *
 *   - list：旧 CLI（-32601）→ 不抛错，回 `supported:false` 的零值信封
 *     （`available:false`、`reason:"unsupported"`、entries 空、counts 全零、
 *     `truncated:false`），且与线上信封同形（无 schema 外键），UI 据此渲染占位态；
 *   - archive：旧 CLI（-32601）→ 抛可读错误（提示升级 CLI），而不是把原始
 *     -32601 结构化错误漏给 UI toast；记忆库忙（SQLITE_BUSY）→ 两个方法都转译成
 *     可重试提示，不直显英文驱动原文。
 *
 * 依据（spec D6 降级语义 + 变更点 6）：list 走 readPromptLanguage 口径（supported:false
 * 静默降级），archive 走 readMagicContextConfig 口径（可读错误进 toast）；SQLITE_BUSY
 * 是面板与 CLI 写通道竞争的短暂冲突（archive 幂等，重试即恢复）。
 *
 * 用假 app-server 进程（node 直接跑，一行一条 JSON-RPC 帧）走真实协议客户端：
 * 两个独立脚本分别模拟「旧 CLI 全方法 -32601」与「记忆库写锁竞争（原生
 * SQLITE_BUSY 文案）」，保证断言的正是线上降级链路而不是对内部函数的影子测试。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

/** 旧 CLI：对每个请求回 -32601（不认识 workspace/{list,archive}MagicContextMemories）。 */
const LEGACY_APP_SERVER_SOURCE = `
"use strict";
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message && message.id !== undefined && message.method !== undefined) {
    process.stdout.write(
      JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not found" } }) + "\\n",
    );
  }
});
rl.on("close", () => process.exit(0));
`;

/** 记忆库写锁竞争：CLI 侧原始形态——message 带 SQLITE_BUSY，code 无判别意义。 */
const SQLITE_BUSY_APP_SERVER_SOURCE = `
"use strict";
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message && message.id !== undefined && message.method !== undefined) {
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        error: { code: -32603, message: "SQLITE_BUSY: database is locked" },
      }) + "\\n",
    );
  }
});
rl.on("close", () => process.exit(0));
`;

const WORKSPACE = { workspacePath: "" };

let fixture;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-mc-memories-degradation-"));
  const workspacePath = join(dir, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const legacyScript = join(dir, "fake-app-server-legacy.cjs");
  const busyScript = join(dir, "fake-app-server-busy.cjs");
  await writeFile(legacyScript, LEGACY_APP_SERVER_SOURCE, "utf-8");
  await writeFile(busyScript, SQLITE_BUSY_APP_SERVER_SOURCE, "utf-8");
  // data dir 隔离，避免 service 构造期任何库路径解析落到真实用户目录。
  setDataBaseDir(dir);
  const createService = (script: string) =>
    createZCodeAgentService({
      commandResolver: async () => ({ command: process.execPath, args: [script] }),
      requestTimeoutMs: 15_000,
    });
  WORKSPACE.workspacePath = workspacePath;
  fixture = {
    dir,
    legacyService: createService(legacyScript),
    busyService: createService(busyScript),
    async dispose() {
      await fixture.legacyService.disposeAllAndWait();
      await fixture.busyService.disposeAllAndWait();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
});

after(async () => {
  await fixture?.dispose();
});

test("listMagicContextMemories degrades to a supported:false zero envelope on -32601", async () => {
  const result = await fixture.legacyService.listMagicContextMemories({ ...WORKSPACE });

  assert.equal(result.supported, false);
  assert.equal(result.available, false);
  // 降级信封必须与线上信封同形（schema 外键一个都不多），UI 才能共用同一套取值。
  assert.deepEqual(
    Object.keys(result).sort(),
    ["available", "counts", "entries", "reason", "supported", "total", "truncated", "workspace"],
  );
  assert.equal(result.reason, "unsupported");
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.counts, { total: 0, active: 0, permanent: 0, archived: 0, merged: 0 });
  // total（P1 真分页 additive 字段）：降级信封同样补零，缺键会被 strict parse 拒。
  assert.equal(result.total, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.workspace.workspacePath, WORKSPACE.workspacePath);
  assert.equal(result.workspace.workspaceKey, WORKSPACE.workspacePath);
});

test("archiveMagicContextMemories throws a readable error instead of the raw -32601 on -32601", async () => {
  await assert.rejects(
    () =>
      fixture.legacyService.archiveMagicContextMemories({
        ...WORKSPACE,
        memoryIds: [1, 2],
        reason: "过期",
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /当前 CLI 版本不支持废弃项目记忆，升级 CLI 后重试/);
      assert.notEqual((error as { code?: unknown }).code, -32601, "原始结构化 -32601 不能漏给 UI");
      return true;
    },
  );
});

test("listMagicContextMemories translates SQLITE_BUSY into a retryable message", async () => {
  const error = await fixture.busyService
    .listMagicContextMemories({ ...WORKSPACE })
    .then(() => null, (reason: unknown) => reason);

  assert.ok(error instanceof Error);
  assert.match(error.message, /读取记忆列表失败：记忆库正忙/);
  assert.match(error.message, /稍后重试/);
  assert.doesNotMatch(error.message, /SQLITE_BUSY/, "驱动原文不直显给 UI");
});

test("archiveMagicContextMemories translates SQLITE_BUSY into a retryable message", async () => {
  const error = await fixture.busyService
    .archiveMagicContextMemories({ ...WORKSPACE, memoryIds: [7] })
    .then(() => null, (reason: unknown) => reason);

  assert.ok(error instanceof Error);
  assert.match(error.message, /废弃项目记忆失败：记忆库正忙/);
  assert.match(error.message, /稍后重试/);
  assert.doesNotMatch(error.message, /SQLITE_BUSY/, "驱动原文不直显给 UI");
});
