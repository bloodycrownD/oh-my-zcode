#!/usr/bin/env node
/**
 * E2E：真子进程 + 真 MCP 协议 + 真 adapter，验证「MCP 工具面自愈」的三条链路。
 *
 * 与 `test-mcp-tool-surface-settle.mjs` 的分工：那个用假 port 钉 core 的补注册逻辑
 * （快、纯逻辑）；这里**不假** transport / client，起一个真正跑 MCP stdio 协议的子进程，
 * 把 adapter 侧那两条（failed 退避重连、transport 断流翻转）也覆盖掉。
 *
 * 用例：
 *   E1 启动快照不完整 → 下一回合补注册（用户报的「会话里看不到 MCP 工具」）
 *      server 延迟 18s 才响应 initialize，会话启动只等 15s，快照带着 0 工具返回；
 *      旧行为：门闩一次封死，之后永远没有 mcp__ 工具。
 *   E2 failed 之后仍能重连（回移 3ef91590 的 A）
 *      子进程首次启动直接退出 → 连接落 failed；旧行为该 server 在该会话永久死亡。
 *      E2 直接走 adapter.callTool，验证 failed 会被重连、且重连后调用成功。
 *
 * 跑法：pnpm --dir apps/zcode-cli/packages/bootstrap test:mcp-live-recovery
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { initializeMcp, startMcpStartup } = await import(
  "../../core/src/runtime/methods/mcp.js"
);
const { createMcpAdapter } = await import("../../adapters/src/mcp/index.js");

const FIXTURE = new URL("./fixtures/mcp-e2e-stdio-server.mjs", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const TRACE = Object.freeze({ spanId: "span-e2e", traceId: "trace-e2e" });
const SERVER_NAME = "e2e";
const EXPECTED_TOOL = `mcp__${SERVER_NAME}__lookup`;

function stdioConfig(extraEnv) {
  return {
    args: [FIXTURE],
    command: process.execPath,
    env: { ...extraEnv },
    type: "stdio",
  };
}

function createLogger(sink) {
  const record = (level) => (message, context) => sink.push({ context, level, message });
  return { debug: record("debug"), info: record("info"), warn: record("warn") };
}

/** 只提供 initializeMcp/startMcpStartup 需要的表面；mcpPort 是**真的 adapter**。 */
function createRuntime(mcpPort, servers, logs) {
  const registered = new Map();
  return {
    config: { mcp: { servers } },
    invalidateToolCache() {},
    initializeMcp,
    logger: createLogger(logs),
    mcpInitialized: false,
    mcpPort,
    mcpRegisteredToolNames: new Set(),
    mcpStartupPromise: undefined,
    mcpToolsRegistered: false,
    registered,
    registry: {
      get: (name) => registered.get(name),
      has: (name) => registered.has(name),
      register: (entry) => registered.set(entry.metadata?.name ?? entry.name, entry),
      unregister: (name) => registered.delete(name),
    },
    rootTraceContext: TRACE,
    startMcpStartup,
    trackResidencyBlockingWork: (promise) => promise,
    workingDirectory: process.cwd(),
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
}

test("E1 启动快照不完整（server 仍 connecting）→ 下一回合把工具补注册进来", { timeout: 90_000 }, async () => {
  const logs = [];
  const mcpPort = createMcpAdapter({ clientName: "zcode-e2e" });
  // 18s > 会话启动的 15s 预算：快照一定是在 server 还没连上时返回的。
  const servers = { [SERVER_NAME]: stdioConfig({ E2E_MCP_DELAY_MS: "18000" }) };
  const runtime = createRuntime(mcpPort, servers, logs);

  try {
    await initializeMcp.call(runtime, TRACE);
    assert.equal(runtime.registered.size, 0, "启动快照返回时不该有任何工具（复现前提）");
    assert.equal(runtime.mcpToolSettlePending, true, "快照不完整时必须标记待补注册");

    const registeredLog = logs.find((entry) => entry.context?.event === "mcp.tools.registered");
    assert.equal(registeredLog?.context?.stillConnecting, true, "启动日志要如实记下未完成");

    // 等子进程真正连上（延迟 18s），再看下一回合能不能补回来。
    await waitFor(
      async () => {
        const statuses = await mcpPort.status();
        return statuses[SERVER_NAME]?.status === "connected";
      },
      40_000,
      "server connected",
    );

    await initializeMcp.call(runtime, TRACE);

    assert.ok(
      runtime.registered.has(EXPECTED_TOOL),
      `下一回合必须补注册出 ${EXPECTED_TOOL}（实际：${[...runtime.registered.keys()].join(",") || "空"}）`,
    );
    const settledLog = logs.find((entry) => entry.context?.event === "mcp.tools.settled");
    assert.ok(settledLog, "应当记录 mcp.tools.settled");
    assert.ok((settledLog.context.registeredToolCount ?? 0) >= 1);
  } finally {
    await mcpPort.close();
  }
});

test("E2 连接落到 failed 后仍能重连并调用成功（回移 3ef91590 的 A）", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-mcp-e2e-"));
  const marker = join(root, "poison.marker");
  const mcpPort = createMcpAdapter({ clientName: "zcode-e2e" });

  try {
    const servers = { [SERVER_NAME]: stdioConfig({ E2E_MCP_FAIL_IF_EXISTS: marker }) };
    const first = await mcpPort.connectConfiguredServers(servers);
    assert.equal(
      first.statuses[SERVER_NAME]?.status,
      "connected",
      "先正常连上（复现前提）",
    );

    // 模拟进程意外死亡：关掉连接（等价于 onclose / transport.onerror 把状态翻成 disconnected）。
    await mcpPort.disconnectServer(SERVER_NAME);

    // 让接下来这次重连必然失败：子进程启动即退出 → 连接落到 failed。
    writeFileSync(marker, "poison");
    await assert.rejects(
      mcpPort.callTool({ arguments: {}, serverName: SERVER_NAME, toolName: "lookup" }),
      () => true,
      "server 不可用时这次调用应当失败",
    );
    assert.equal(
      (await mcpPort.status())[SERVER_NAME]?.status,
      "failed",
      "重连失败后状态必须落到 failed（旧行为在这里永久死亡）",
    );

    // server 恢复可用；旧行为：failed 不在重连白名单 → 该会话此后再也调不动。
    rmSync(marker, { force: true });
    const result = await mcpPort.callTool({
      arguments: {},
      serverName: SERVER_NAME,
      toolName: "lookup",
    });
    assert.ok(
      JSON.stringify(result).includes("ok-from-e2e"),
      `failed 之后必须能重连并调用成功，实际返回：${JSON.stringify(result).slice(0, 200)}`,
    );
    assert.equal(
      (await mcpPort.status())[SERVER_NAME]?.status,
      "connected",
      "重连成功后状态要回到 connected",
    );
  } finally {
    await mcpPort.close().catch(() => {});
    rmSync(root, { force: true, recursive: true });
  }
});
