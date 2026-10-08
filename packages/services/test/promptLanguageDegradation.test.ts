/**
 * PL-G-1（prompt-language-option）：旧 CLI（-32601）下的降级行为常驻回归。
 *
 * `packages/services/src/zcode-agent/zcodeAgentService.ts` 的 read/update 包装：
 *
 *   - read：`-32601`（method not found）→ 不抛错，回
 *     `{supported:false, promptLanguage:"auto"}` 且**不带 path**（host 不伪造成
 *     自己读过的路径），让设置页把该项渲染成「当前 CLI 不支持」而不是卡住 General 分区；
 *   - update：`-32601` → 抛可读错误「当前 CLI 版本不支持『模型语言』设置…」，
 *     而不是把原始 -32601 结构化错误漏给 UI（正常路径由 read 的 supported:false
 *     提前禁用，这里是竞态兜底）。
 *
 * 用假 app-server 进程（node 直接跑，一行一条 JSON-RPC 帧，全方法回 -32601）走真实
 * 协议客户端，保证断言的正是线上降级链路而不是对内部函数的影子测试。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";

const FAKE_APP_SERVER_SOURCE = `
"use strict";
// 最小假 app-server：逐行读 JSON-RPC 帧，对每个请求回 -32601（模拟旧 CLI 不认识
// workspace/read|updatePromptLanguage）。stdin EOF 即退出，配合 host 的正常回收。
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

const WORKSPACE = { workspacePath: "" };

let fixture;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-prompt-lang-degradation-"));
  const workspacePath = join(dir, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(dir, "fake-app-server.cjs"), FAKE_APP_SERVER_SOURCE, "utf-8");
  // data dir 隔离，避免 service 构造期任何库路径解析落到真实用户目录。
  setDataBaseDir(dir);
  const service = createZCodeAgentService({
    commandResolver: async () => ({
      command: process.execPath,
      args: [join(dir, "fake-app-server.cjs")],
    }),
    requestTimeoutMs: 15_000,
  });
  WORKSPACE.workspacePath = workspacePath;
  fixture = {
    dir,
    service,
    async dispose() {
      await service.disposeAllAndWait();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
});

after(async () => {
  await fixture?.dispose();
});

test("readPromptLanguage degrades to supported:false + auto without a path on -32601", async () => {
  const result = await fixture.service.readPromptLanguage({ ...WORKSPACE });

  assert.equal(result.supported, false);
  assert.equal(result.promptLanguage, "auto");
  assert.equal(
    "path" in result && result.path !== undefined,
    false,
    "host 不伪造一个没读过的路径（schema 的 path 是可选的）",
  );
  assert.equal(result.workspace.workspacePath, WORKSPACE.workspacePath);
  assert.equal(result.workspace.workspaceKey, WORKSPACE.workspacePath);
});

test("updatePromptLanguage throws a readable error instead of the raw -32601 on -32601", async () => {
  await assert.rejects(
    () =>
      fixture.service.updatePromptLanguage({
        ...WORKSPACE,
        promptLanguage: "zh-CN",
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /当前 CLI 版本不支持「模型语言」设置，升级 CLI 后重试/);
      assert.notEqual((error as { code?: unknown }).code, -32601, "原始结构化 -32601 不能漏给 UI");
      return true;
    },
  );
});
