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
    connectConfiguredServers: async (servers) => {
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

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — MCP 热刷新（diff 注册/反注册/替换/no-op/连接失败降级）"
      : `TEST FAIL — MCP 热刷新 (exit code ${code})`,
  );
});
