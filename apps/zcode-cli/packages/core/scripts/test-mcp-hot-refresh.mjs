#!/usr/bin/env node
/**
 * FORK（mcp-hot-refresh）core 单测：refreshMcpServers 的工具面 diff 语义。
 *
 * 覆盖：新增 server 的工具注册并 invalidateToolCache / 消失 server 的工具反注册 /
 * config.mcp.servers 权威替换 / mcp 未启用时 no-op。
 * 协议层（mcp/refreshSessions 遍历 resident sessions）与 UI 触发链由门禁型
 * typecheck 覆盖，此处只钉 core diff 契约。
 *
 * 运行方式：`npx tsx --test scripts/test-mcp-hot-refresh.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { refreshMcpServers } from "../src/runtime/methods/mcp.ts";
import { registerMcpTools } from "../src/mcp/index.ts";

function makeToolDescriptor(serverName, toolName) {
  return {
    serverName,
    toolName,
    inputSchema: { type: "object", properties: {} },
  };
}

/** 最小 McpPort：connectConfiguredServers 返回按当前配置合成的 snapshot。 */
function makeMcpPort(snapshotsByCall = []) {
  let call = 0;
  return {
    connectConfiguredServers: async (_servers) => {
      const snap = snapshotsByCall[Math.min(call, snapshotsByCall.length - 1)] ?? {
        statuses: {},
        tools: [],
      };
      call += 1;
      return snap;
    },
    callCount: () => call,
  };
}

function makeRuntime(port, initialRegistered = new Set()) {
  const state = {
    mcpPort: port,
    config: {
      mcp: {
        enabled: true,
        servers: {},
        trustedOfficialCuaServerNames: [],
      },
    },
    registry: makeFakeRegistry(),
    workingDirectory: "/tmp",
    mcpToolsRegistered: false,
    mcpRegisteredToolNames: initialRegistered,
    invalidateToolCacheCalls: 0,
    invalidateToolCache() {
      state.invalidateToolCacheCalls += 1;
    },
    // cr-fix-spec mcp/B-2 harness stub：refreshMcpServers 修复后会先等待
    // initializeMcp（门闩）。真实 initializeMcp 幂等（已注册直接 return）。
    // stub 对空初始配置（makeRuntime 的 servers={}）返回空快照、零注册，
    // 刻意不消耗 port 的 snapshotsByCall 序列——既有用例的快照对位不变。
    async initializeMcp() {
      if (state.mcpToolsRegistered) return;
      registerMcpTools(state.registry, port, [], {});
      state.mcpToolsRegistered = true;
    },
  };
  return state;
}

function makeFakeRegistry() {
  const tools = new Map();
  return {
    register: (entry) => tools.set(entry.metadata.name, entry),
    unregister: (name) => tools.delete(name),
    has: (name) => tools.has(name),
    names: () => [...tools.keys()],
  };
}

const trace = { traceId: "t-mcp-refresh" };

test("新增 server：工具注册 + config 替换 + invalidateToolCache", async () => {
  const port = makeMcpPort([
    { statuses: {}, tools: [makeToolDescriptor("weather", "get_forecast")] },
  ]);
  const runtime = makeRuntime(port);
  const servers = {
    weather: { type: "http", url: "https://mcp.example/weather" },
  };
  const result = await refreshMcpServers.call(runtime, servers, trace);
  assert.equal(result.serverCount, 1);
  assert.equal(result.registeredToolCount, 1);
  assert.equal(result.removedToolCount, 0);
  assert.equal(runtime.config.mcp.servers.weather.type, "http");
  assert.equal(runtime.invalidateToolCacheCalls, 1);
  const names = runtime.registry.names();
  assert.equal(names.length, 1);
  assert.match(names[0], /weather/);
  assert.equal(runtime.mcpRegisteredToolNames.size, 1);
});

test("移除 server：旧工具反注册，工具面收敛", async () => {
  const port = makeMcpPort([
    { statuses: {}, tools: [makeToolDescriptor("weather", "get_forecast")] },
    { statuses: {}, tools: [makeToolDescriptor("search", "query")] },
  ]);
  const runtime = makeRuntime(port);
  await refreshMcpServers.call(
    runtime,
    { weather: { type: "http", url: "https://mcp.example/weather" } },
    trace,
  );
  const weatherTool = runtime.mcpRegisteredToolNames.values().next().value;
  assert.equal(runtime.registry.has(weatherTool), true);

  const second = await refreshMcpServers.call(
    runtime,
    { search: { type: "http", url: "https://mcp.example/search" } },
    trace,
  );
  assert.equal(second.registeredToolCount, 1);
  assert.equal(second.removedToolCount, 1, "weather 的工具被反注册");
  assert.equal(runtime.registry.has(weatherTool), false);
  assert.equal(runtime.invalidateToolCacheCalls, 2);
});

test("mcp 未启用：no-op 零连接", async () => {
  const port = makeMcpPort([]);
  const runtime = makeRuntime(port);
  runtime.config.mcp.enabled = false;
  const result = await refreshMcpServers.call(
    runtime,
    { weather: { type: "http", url: "https://x" } },
    trace,
  );
  assert.deepEqual(result, {
    serverCount: 0,
    registeredToolCount: 0,
    removedToolCount: 0,
  });
  assert.equal(port.callCount(), 0);
});

test("连接失败：不抛错，工具面清空为空集", async () => {
  const port = {
    connectConfiguredServers: async () => {
      throw new Error("boom");
    },
  };
  const runtime = makeRuntime(port, new Set(["mcp__weather__get_forecast"]));
  const result = await refreshMcpServers.call(
    runtime,
    { weather: { type: "http", url: "https://x" } },
    trace,
  );
  assert.equal(result.registeredToolCount, 0);
  assert.equal(result.removedToolCount, 1);
  assert.equal(runtime.registry.names().length, 0);
});

// cr-fix-spec mcp/B-2：session 刚创建（initializeMcp 未完成）时触发 refresh，
// refresh 须先等待 initializeMcp 落定（门闩）再 diff——不抢先、不重入。
test("初始化竞态：refresh 先等待 initializeMcp 落定再 diff", async () => {
  let initializeEntered = false;
  let releaseInitialize;
  const initializeGate = new Promise((resolve) => {
    releaseInitialize = resolve;
  });
  const port = makeMcpPort([
    { statuses: {}, tools: [makeToolDescriptor("weather", "get_prediction")] },
  ]);
  const runtime = makeRuntime(port);
  const realInitialize = runtime.initializeMcp.bind(runtime);
  runtime.initializeMcp = async (...args) => {
    initializeEntered = true;
    // 模拟 initializeMcp 仍在 await startup：refresh 到来时必须先挂起等待
    await initializeGate;
    return realInitialize(...args);
  };
  const servers = { weather: { type: "http", url: "https://mcp.example/weather" } };
  const refreshPromise = refreshMcpServers.call(runtime, servers, trace);
  // 门闩未放行前 refresh 不得完成（等待初始化，不抢先 diff）
  let refreshSettled = false;
  void refreshPromise.then(() => {
    refreshSettled = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(initializeEntered, true, "refresh 触发了 initializeMcp 等待");
  assert.equal(refreshSettled, false, "initializeMcp 未落定前 refresh 不完成");
  releaseInitialize();
  const result = await refreshPromise;
  assert.ok(runtime.mcpToolsRegistered, "初始化已落定");
  assert.equal(result.registeredToolCount, 1);
  assert.ok(
    runtime.registry.names().some((n) => n.includes("get_prediction")),
    "以新配置快照注册",
  );
});

// cr-fix-spec mcp/B-4 用例 5：同名服务器改配置致工具名变化（diff 核心分支）。
test("同名 server 工具名变化：旧名反注册 + 新名注册", async () => {
  const port = makeMcpPort([
    { statuses: {}, tools: [makeToolDescriptor("weather", "get_forecast")] },
    { statuses: {}, tools: [makeToolDescriptor("weather", "get_prediction")] },
  ]);
  const runtime = makeRuntime(port);
  const first = await refreshMcpServers.call(
    runtime,
    { weather: { type: "http", url: "https://mcp.example/weather" } },
    trace,
  );
  assert.equal(first.registeredToolCount, 1);
  const oldTool = [...runtime.mcpRegisteredToolNames].find((n) =>
    n.includes("get_forecast"),
  );
  assert.ok(oldTool, "旧工具名已入基线");

  const second = await refreshMcpServers.call(
    runtime,
    { weather: { type: "http", url: "https://mcp.example/weather" } },
    trace,
  );
  assert.equal(second.registeredToolCount, 1, "新工具名注册");
  assert.equal(second.removedToolCount, 1, "旧工具名反注册");
  assert.equal(runtime.registry.has(oldTool), false);
  assert.ok(
    runtime.registry.names().some((n) => n.includes("get_prediction")),
    "新工具名在注册表",
  );
});

// cr-fix-spec mcp/B-4 用例 6：invalidate 幂等语义——每次 refresh 均失效缓存
// （含无变化连续刷新，refreshMcpServers 不读 activeTurn，:240 无条件调用）。
test("invalidate 幂等：连续两次同配置 refresh 均失效工具缓存", async () => {
  const port = makeMcpPort([
    { statuses: {}, tools: [makeToolDescriptor("weather", "get_forecast")] },
  ]);
  const runtime = makeRuntime(port);
  const servers = { weather: { type: "http", url: "https://mcp.example/weather" } };
  await refreshMcpServers.call(runtime, servers, trace);
  await refreshMcpServers.call(runtime, servers, trace);
  assert.equal(runtime.invalidateToolCacheCalls, 2, "每次 refresh 均失效一次");
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — MCP 热刷新（diff 注册/反注册/替换/no-op/连接失败降级）"
      : `TEST FAIL — MCP 热刷新 (exit code ${code})`,
  );
});
