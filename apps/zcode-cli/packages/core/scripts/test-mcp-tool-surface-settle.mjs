#!/usr/bin/env node
/**
 * 1.0.x 回归 —— MCP 工具面在「启动快照不完整」时必须还能补注册。
 *
 * 缺陷（线上表现：会话里看不到 MCP 工具）：
 *   会话启动只等 15s（`MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS`），authorization_code 类
 *   server 在这段时间里一直停在 `connecting`，于是 `connectConfiguredServers` 带着
 *   `tools: []` 返回。`initializeMcp` 按这份空快照注册 0 个工具后把一次性门闩
 *   `mcpToolsRegistered` 置 true —— 此后每回合的 `initializeMcp` 都在第一行 return，
 *   server 后来连上了也没有任何路径把工具塞进 registry。1.0.x 没有 revision 刷新环
 *   （`refreshMcpToolsIfChanged` 是 1.1.x 的机制），所以只能靠回合边界的补注册。
 *
 * 修复判据：
 *   ① 快照里还有 server 停在 connecting → `mcpToolSettlePending` 置位，**不能**当作终态；
 *   ② 下一回合 `initializeMcp` 重新读 status/listTools，把新出现的工具注册进来；
 *   ③ 补注册只增不减（半连接快照不能把已注册工具反注册掉）；
 *   ④ 长期 connecting 的 server 不会让每回合都去摸工具面（有上限）。
 *
 * 跑法：pnpm --dir apps/zcode-cli/packages/core test:mcp-tool-surface-settle
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { initializeMcp, refreshMcpServers, startMcpStartup } = await import(
  "../src/runtime/methods/mcp.js"
);

const TRACE = Object.freeze({ traceId: "trace-mcp-settle", spanId: "span-1" });

function descriptor(serverName, toolName) {
  return {
    description: `${toolName} on ${serverName}`,
    inputSchema: { properties: {}, type: "object" },
    name: toolName,
    serverName,
    toolName,
  };
}

function status(name, state) {
  return { name, status: state, tools: [] };
}

/**
 * 造一个只实现 initializeMcp/startMcpStartup 所需表面的 runtime。
 * `settleSnapshots` 按顺序被后续回合的 status()/listTools() 消费，最后一个会重复。
 */
function createHarness({ servers, settleSnapshots, startupSnapshot }) {
  const registered = new Map();
  const logs = [];
  const calls = { connect: 0, invalidate: 0, listTools: 0, status: 0 };
  let currentSnapshot = null;
  let connectSnapshot = startupSnapshot;
  let settleIndex = 0;
  let statusOverride = null;
  let toolsOverride = null;

  // status() 与 listTools() 属于同一轮快照：Promise.all 的数组字面量从左到右求值，
  // status() 先跑并推进索引，listTools() 复用同一份（测试专用简化，不是产品语义）。
  const advance = () => {
    currentSnapshot = settleSnapshots[Math.min(settleIndex, settleSnapshots.length - 1)];
    settleIndex += 1;
    return currentSnapshot;
  };

  const runtime = {
    config: { mcp: { servers } },
    invalidateToolCache() {
      calls.invalidate += 1;
    },
    initializeMcp,
    logger: {
      debug(message, context) {
        logs.push({ context, level: "debug", message });
      },
      info(message, context) {
        logs.push({ context, level: "info", message });
      },
      warn(message, context) {
        logs.push({ context, level: "warn", message });
      },
    },
    mcpInitialized: false,
    mcpPort: {
      async callTool() {
        throw new Error("callTool is out of scope for this test");
      },
      async close() {},
      async connectConfiguredServers() {
        calls.connect += 1;
        return connectSnapshot;
      },
      async connectServer() {
        throw new Error("connectServer is out of scope for this test");
      },
      async disconnectServer() {
        return undefined;
      },
      async listTools() {
        calls.listTools += 1;
        if (toolsOverride) return toolsOverride;
        const snapshot = currentSnapshot ?? advance();
        return snapshot.tools;
      },
      async status() {
        calls.status += 1;
        if (statusOverride) return statusOverride;
        const snapshot = currentSnapshot ?? advance();
        return snapshot.statuses;
      },
    },
    mcpRegisteredToolNames: new Set(),
    mcpStartupPromise: undefined,
    mcpToolsRegistered: false,
    registry: {
      get(name) {
        return registered.get(name);
      },
      has(name) {
        return registered.has(name);
      },
      register(entry) {
        // createMcpToolEntry 把模型可见名放在 metadata.name（顶层字段由 registry 消费）。
        registered.set(entry.metadata?.name ?? entry.name, entry);
      },
      unregister(name) {
        registered.delete(name);
      },
    },
    rootTraceContext: TRACE,
    startMcpStartup,
    trackResidencyBlockingWork(promise) {
      return promise;
    },
    workingDirectory: "/ws",
  };

  return {
    calls,
    logs,
    names: () => [...registered.keys()],
    runtime,
    setConnectSnapshot(snapshot) {
      connectSnapshot = snapshot;
    },
    setMcpState({ statuses, tools }) {
      if (statuses) statusOverride = statuses;
      if (tools) toolsOverride = tools;
    },
  };
}

const SERVERS = {
  s1: { args: [], command: "s1", type: "stdio" },
  s2: { args: [], command: "s2", type: "stdio" },
};

test("startup 快照全 connecting 时不落定，下一回合把新工具补注册进来", async () => {
  const harness = createHarness({
    servers: SERVERS,
    settleSnapshots: [
      {
        statuses: { s1: status("s1", "connected"), s2: status("s2", "connected") },
        tools: [descriptor("s1", "lookup")],
      },
    ],
    startupSnapshot: {
      statuses: { s1: status("s1", "connecting"), s2: status("s2", "connecting") },
      tools: [],
    },
  });

  await initializeMcp.call(harness.runtime, TRACE);
  assert.deepEqual(harness.names(), [], "空启动快照下先注册 0 个工具");
  assert.equal(
    harness.runtime.mcpToolSettlePending,
    true,
    "快照里还有 connecting 时不能当作终态",
  );

  // 下一回合边界：turn-loop 每回合都会 await initializeMcp
  await initializeMcp.call(harness.runtime, TRACE);
  assert.equal(harness.names().length, 1, "补注册应当把连上之后的工具注册进来");
  assert.match(
    harness.names()[0],
    /(^|__)lookup$/,
    `补注册出来的必须是那个后到的工具（实际：${harness.names().join(",")}）`,
  );
  assert.equal(harness.runtime.mcpToolSettlePending, false, "所有 server 就绪后落定");
  assert.equal(harness.calls.connect, 1, "补注册不重新连接，只重新读工具面");

  const settled = harness.logs.find((entry) => entry.context?.event === "mcp.tools.settled");
  assert.ok(settled, "应当留下 mcp.tools.settled 日志");
  assert.equal(settled.context.registeredToolCount, 1);
});

test("startup 快照完整时不再进入补注册（不额外摸工具面）", async () => {
  const harness = createHarness({
    servers: SERVERS,
    settleSnapshots: [
      {
        statuses: { s1: status("s1", "connected"), s2: status("s2", "connected") },
        tools: [descriptor("s1", "lookup")],
      },
    ],
    startupSnapshot: {
      statuses: { s1: status("s1", "connected"), s2: status("s2", "connected") },
      tools: [descriptor("s1", "lookup")],
    },
  });

  await initializeMcp.call(harness.runtime, TRACE);
  assert.equal(harness.names().length, 1);
  assert.equal(harness.runtime.mcpToolSettlePending, false);

  const listToolsAfterStartup = harness.calls.listTools;
  await initializeMcp.call(harness.runtime, TRACE);
  assert.equal(harness.calls.listTools, listToolsAfterStartup, "已落定时不应再读工具面");
});

test("补注册只增不减：半连接快照不能反注册已经注册的工具", async () => {
  const harness = createHarness({
    servers: SERVERS,
    settleSnapshots: [
      // 第二回合：s1 已连上
      {
        statuses: { s1: status("s1", "connected"), s2: status("s2", "connecting") },
        tools: [descriptor("s1", "lookup")],
      },
      // 第三回合：s1 的连接抖动了一下（状态没回 connecting，但工具暂时读不到）
      {
        statuses: { s1: status("s1", "connected"), s2: status("s2", "connecting") },
        tools: [],
      },
    ],
    startupSnapshot: {
      statuses: { s1: status("s1", "connecting"), s2: status("s2", "connecting") },
      tools: [],
    },
  });

  await initializeMcp.call(harness.runtime, TRACE);
  await initializeMcp.call(harness.runtime, TRACE);
  assert.equal(harness.names().length, 1);

  await initializeMcp.call(harness.runtime, TRACE);
  assert.equal(harness.names().length, 1, "补注册的快照是半连接状态，不能当作权威集合");
});

test("长期 connecting 的 server 有补注册上限，不会每回合都摸工具面", async () => {
  const harness = createHarness({
    servers: SERVERS,
    settleSnapshots: [
      {
        statuses: { s1: status("s1", "connecting"), s2: status("s2", "connecting") },
        tools: [],
      },
    ],
    startupSnapshot: {
      statuses: { s1: status("s1", "connecting"), s2: status("s2", "connecting") },
      tools: [],
    },
  });

  await initializeMcp.call(harness.runtime, TRACE);
  for (let turn = 0; turn < 10; turn += 1) {
    await initializeMcp.call(harness.runtime, TRACE);
  }

  assert.equal(harness.runtime.mcpToolSettlePending, false, "到上限后回到一次性语义");
  assert.ok(
    harness.calls.listTools <= 5,
    `补注册次数必须封顶，实际读了 ${harness.calls.listTools} 次工具面`,
  );
  assert.equal(harness.calls.connect, 1, "整个过程都不重新连接");
});

test("设置页热刷新仍是 replace 语义，并清掉补注册的残留状态", async () => {
  const harness = createHarness({
    servers: SERVERS,
    settleSnapshots: [{ statuses: { s1: status("s1", "connected") }, tools: [] }],
    startupSnapshot: {
      statuses: { s1: status("s1", "connected"), s2: status("s2", "connected") },
      tools: [descriptor("s1", "lookup")],
    },
  });

  await initializeMcp.call(harness.runtime, TRACE);
  assert.deepEqual(harness.names(), ["lookup"]);
  harness.runtime.mcpToolSettlePending = true;

  harness.setConnectSnapshot({
    statuses: { s1: status("s1", "connected"), s2: status("s2", "connected") },
    tools: [descriptor("s1", "fetch")],
  });
  const result = await refreshMcpServers.call(harness.runtime, SERVERS, TRACE);

  assert.deepEqual(harness.names(), ["fetch"], "热刷新以本次快照为准：消失的工具要反注册");
  assert.equal(result.registeredToolCount, 1);
  assert.equal(result.removedToolCount, 1);
  assert.equal(harness.runtime.mcpToolSettlePending, false, "权威快照落定后不再补注册");
});

test("掉线后重连成功，下一回合把重连回来的工具补注册（回移 3ef91590 的 core 侧）", async () => {
  const CONNECTED = {
    s1: status("s1", "connected"),
    s2: status("s2", "connected"),
  };
  const harness = createHarness({
    servers: SERVERS,
    settleSnapshots: [{ statuses: CONNECTED, tools: [descriptor("s1", "lookup")] }],
    startupSnapshot: { statuses: CONNECTED, tools: [descriptor("s1", "lookup")] },
  });

  await initializeMcp.call(harness.runtime, TRACE);
  assert.deepEqual(harness.names(), ["lookup"]);
  assert.equal(harness.runtime.mcpToolSettlePending, false, "启动快照完整 → 已落定");

  // 会话中途 server 掉线：adapter 把 record 翻成 failed（或 transport.onerror 直接翻转）
  harness.setMcpState({ statuses: { ...CONNECTED, s1: status("s1", "failed") } });
  await initializeMcp.call(harness.runtime, TRACE);
  assert.deepEqual(harness.names(), ["lookup"], "掉线瞬间不应凭空删掉已注册工具");

  // 懒重连成功：record 回到 connected，且工具集已刷新（多了一个 fetch）
  harness.setMcpState({
    statuses: CONNECTED,
    tools: [descriptor("s1", "lookup"), descriptor("s1", "fetch")],
  });
  await initializeMcp.call(harness.runtime, TRACE);

  assert.deepEqual(
    [...harness.names()].sort(),
    ["fetch", "lookup"],
    "重连后回来的工具必须在下一回合被重新注册（1.0.x 没有 revision，靠状态指纹发现）",
  );
  assert.equal(harness.runtime.mcpToolSettlePending, false, "重连补注册后重新落定");
});
