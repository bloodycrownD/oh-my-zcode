import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

// FORK (upstream-v3.15.1-backport) T-SVC-3：spec §2.1 P4 #21——插件/agent 配置读取的 catch 收窄。
//
// 失效形态（原实现 catch 全吞）：配置**文件存在但读不动**（权限、路径类型不对、磁盘错误）时，
// 伪装成"没有这条配置"返回空覆盖——用户在设置页里刚禁用的 agent 会被重新启用、被 suppression
// 压制的内置插件会复活。修复只对 ENOENT / SyntaxError 沿用空配置语义，其余 IO 错误原样上抛。
//
// 隔离：全程 homeDir 指向临时目录，绝不触碰真实 ~/.omz（spec §5 测试隔离红线）。

const workspacePath = "/example/t-svc-3";

test("T-SVC-3 ENOENT 仍回退空配置（首次启动/文件不存在）", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-empty-"));
  try {
    const service = createSubagentsService({ homeDir });
    const listed = await service.list({ workspacePath });
    // 内置 agent 照常在场，且没有任何被禁用状态（空覆盖语义）。
    assert.equal(
      listed.agents.some((agent) => agent.name === "general-purpose"),
      true,
    );
    assert.deepEqual(listed.pluginAgents, []);
    assert.equal(
      listed.agents.every((agent) => agent.enabled),
      true,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T-SVC-3 agents-state.json 读不动时上抛 IO 错误，不伪装成空配置", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-eisdir-"));
  try {
    // 把状态文件路径做成**目录**：migrate 的 lstat 判定 isFile()=false 直接略过，
    // 随后的 readFile 抛出非 ENOENT 的 IO 错误（EISDIR）——正是修复要上抛的那一类。
    await mkdir(join(homeDir, ".omz", "v2", "agents-state.json"), { recursive: true });
    const service = createSubagentsService({ homeDir });
    const error = await service.list({ workspacePath }).then(
      () => undefined,
      (rejection) => rejection,
    );
    assert.ok(error, "IO 失败必须上抛，不能返回空覆盖（否则会复活已禁用 agent）");
    assert.equal(error.code, "EISDIR");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T-SVC-3 配置读不动时上抛 IO 错误，不伪装成空插件配置", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-plugin-"));
  try {
    // 同一收窄在 readPluginConfig：文件路径成目录 → 非 ENOENT 的 IO 错误必须上抛，
    // 否则被 suppression 压制的内置插件会因为"读不到配置"而复活。
    await mkdir(join(homeDir, ".omz", "cli", "config.json"), { recursive: true });
    const service = createSubagentsService({ homeDir });
    const error = await service.list({ workspacePath }).then(
      () => undefined,
      (rejection) => rejection,
    );
    assert.ok(error, "插件配置 IO 失败必须上抛");
    assert.equal(error.code, "EISDIR");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T-SVC-3 内容损坏（SyntaxError）仍沿用空配置，不回退为抛错", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-broken-"));
  try {
    await mkdir(join(homeDir, ".omz", "v2"), { recursive: true });
    await writeFile(join(homeDir, ".omz", "v2", "agents-state.json"), "{ not json", "utf-8");
    const service = createSubagentsService({ homeDir });
    const listed = await service.list({ workspacePath });
    assert.equal(
      listed.agents.some((agent) => agent.name === "general-purpose"),
      true,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
