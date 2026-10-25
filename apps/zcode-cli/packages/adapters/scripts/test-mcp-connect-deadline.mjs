#!/usr/bin/env node
/**
 * T-MCP-DEADLINE（fix/v1020-patch）——单个 MCP server 的连接必须有界，死链不得拖住整条 startup。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * `connectConfiguredServers` 用 `Promise.all` 等全部 server 连上；不可达的 http/sse server
 * 要走完整 TCP/HTTP 超时（实测每台 5-6s），`npx` 形态的 stdio server 首次还要拉包（实测
 * 9.4s）。整条 MCP startup 因此被拖到 9s 以上，会话首帧快照排在 runtime 就绪之后，用户看到
 * 的就是「点开会话卡住」。修复给每个 server 的连接套 4s 上限：到点按 `failed` 记账（工具
 * 不注册，可在设置页手动重连），后台连接不取消。
 *
 * 本脚本用「永不 resolve」的假 adapter 断言两件事：
 * 1) 该 server 在 ~4s 内被记成 failed（带超时错误信息），而不是永远挂着；
 * 2) 它不阻塞同一批里的其它 server（connectConfiguredServers 整体仍在 4s 量级返回）。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/adapters run test:mcp-connect-deadline`
 * （脚本登记用 `node --import tsx --test`：apps/zcode-cli 是嵌套工作区，包内没有 tsx 的
 *  .bin，`tsx` 裸命令在这里解析不到；Node 的 --import 会向上走到根 node_modules/tsx。
 *  直接跑 TS 源，无需先 build。）
 */

import assert from "node:assert/strict";
import test from "node:test";

const { createMcpConnectionPool } = await import("../src/mcp/pool.js");

const HUNG_SERVER = "hung-http";
const FAST_SERVER = "fast-stdio";

const CONFIGS = {
  [HUNG_SERVER]: { type: "http", url: "http://127.0.0.1:9/mcp" },
  [FAST_SERVER]: { type: "stdio", command: "node", args: ["--version"] },
};

/** 记录 warn 事件，用来确认超时走的是「有日志的失败」而不是静默丢包。 */
function createRecordingLogger() {
  const warnings = [];
  const logger = {
    child() {
      return logger;
    },
    debug() {},
    info() {},
    warn(message, context) {
      warnings.push({ context, message });
    },
    error() {},
  };
  return { logger, warnings };
}

function serverStatus(serverName, config, status) {
  return {
    status,
    transport: config.type,
    toolCount: status === "connected" ? 1 : 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 假 adapter：
 * - hung server：connectServer 永远不 resolve（模拟不可达 http / 拉包中的 npx）；
 * - fast server：立刻连上并暴露一个工具。
 */
function createAdapter({ config, serverName }) {
  if (serverName === HUNG_SERVER) {
    return {
      async connectConfiguredServers() {
        return { statuses: {}, tools: [] };
      },
      connectServer() {
        return new Promise(() => {});
      },
      async disconnectServer() {
        return undefined;
      },
      async status() {
        return { [serverName]: serverStatus(serverName, config, "connecting") };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [] };
      },
      async close() {},
    };
  }
  return {
    async connectConfiguredServers() {
      return {
        statuses: { [serverName]: serverStatus(serverName, config, "connected") },
        tools: [],
      };
    },
    async connectServer() {
      return serverStatus(serverName, config, "connected");
    },
    async disconnectServer() {
      return undefined;
    },
    async status() {
      return { [serverName]: serverStatus(serverName, config, "connected") };
    },
    async listTools() {
      return [
        {
          inputSchema: { type: "object" },
          serverName,
          toolName: "fast_tool",
        },
      ];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {},
  };
}

function createPool(createAdapterImpl, logger) {
  return createMcpConnectionPool({
    createAdapter: createAdapterImpl,
    idleGraceMs: 0,
    ...(logger ? { logger } : {}),
  });
}

/**
 * pool 的截止定时器是 unref 的（生产上不该用它把进程吊住），而「永不 resolve 的假连接」
 * 本身不持有事件循环。测试里必须自己拿一个 ref 的句柄，否则 node --test 会认为事件循环
 * 已空、直接把等待中的用例判成 cancelledByParent。
 */
function keepEventLoopAlive() {
  const timer = setInterval(() => {}, 1_000);
  return () => clearInterval(timer);
}

test("T-MCP-DEADLINE 单个死链 server 在 ~4s 内记为 failed", async () => {
  const { logger, warnings } = createRecordingLogger();
  const pool = createPool(createAdapter, logger);
  const lease = pool.acquireLease({ leaseId: "deadline-single" });
  const stopKeepAlive = keepEventLoopAlive();
  try {
    const startedAt = Date.now();
    const status = await lease.connectServer(HUNG_SERVER, CONFIGS[HUNG_SERVER]);
    const elapsed = Date.now() - startedAt;

    assert.equal(status.status, "failed", "到点必须记成 failed，不能停在 connecting");
    assert.match(status.error ?? "", /timed out after 4000ms/);
    assert.equal(status.toolCount, 0);
    // setTimeout 不会提前触发；上限放宽到 6s 只为吸收 CI 的调度抖动。
    assert.ok(elapsed >= 3_900 && elapsed < 6_000, `连接应在 4s 量级返回，实际 ${elapsed}ms`);
    assert.ok(
      warnings.some((entry) => entry.context?.event === "mcp.server.connect_timeout"),
      "超时必须留一条 warn 事件（mcp.server.connect_timeout）",
    );
  } finally {
    stopKeepAlive();
    await pool.close();
  }
});

test("T-MCP-DEADLINE 死链 server 不阻塞同批其它 server", async () => {
  const pool = createPool(createAdapter);
  const lease = pool.acquireLease({ leaseId: "deadline-batch" });
  const stopKeepAlive = keepEventLoopAlive();
  try {
    const startedAt = Date.now();
    const snapshot = await lease.connectConfiguredServers(CONFIGS);
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed >= 3_900 && elapsed < 6_000,
      `整批应在 4s 量级返回（不再等 5-9s 的完整超时），实际 ${elapsed}ms`,
    );
    assert.equal(snapshot.statuses[FAST_SERVER]?.status, "connected", "健康 server 照常连上");
    assert.ok(
      snapshot.tools.some((tool) => tool.serverName === FAST_SERVER),
      "健康 server 的工具必须已注册",
    );

    // 同一 entry 之后再次查询直接复用已收敛的 failed 结果，不会无限等待。
    const hungAgain = await lease.connectServer(HUNG_SERVER, CONFIGS[HUNG_SERVER]);
    assert.equal(hungAgain.status, "failed");
  } finally {
    stopKeepAlive();
    await pool.close();
  }
});
