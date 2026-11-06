#!/usr/bin/env node
/**
 * E2E 夹具：一个真正跑在子进程里的最小 MCP stdio server（手写 JSON-RPC，不引 SDK）。
 *
 * 环境变量：
 *   E2E_MCP_DELAY_MS   连上前的延迟。用来复现「会话启动只等 15s、快照返回时 server 仍
 *                      connecting」——把它设到 15s 以上，快照就会带着空工具面返回。
 *   E2E_MCP_FAIL_IF_EXISTS  marker 文件路径。文件存在时启动即退出（模拟 server 不可用），
 *                      用来复现「重连失败落到 failed 后永不重试」。
 *
 * 只实现 initialize / tools/list / tools/call 三个必需方法 + notifications。
 */
import { existsSync } from "node:fs";

const DELAY_MS = Number(process.env.E2E_MCP_DELAY_MS ?? "0");
const FAIL_IF_EXISTS = process.env.E2E_MCP_FAIL_IF_EXISTS;

if (FAIL_IF_EXISTS && existsSync(FAIL_IF_EXISTS)) {
  // 启动即退出：连接必然失败（status → failed）。
  process.exit(1);
}

if (DELAY_MS > 0) {
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

const TOOL_NAME = "lookup";
const TOOL_REPLY = "ok-from-e2e";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  const { id, method } = message;
  if (method === "notifications/initialized" || id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        serverInfo: { name: "e2e-stdio", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({
      id,
      jsonrpc: "2.0",
      result: {
        tools: [
          {
            description: "E2E lookup",
            inputSchema: { properties: {}, type: "object" },
            name: TOOL_NAME,
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    send({
      id,
      jsonrpc: "2.0",
      result: { content: [{ text: TOOL_REPLY, type: "text" }] },
    });
    return;
  }
  send({ id, jsonrpc: "2.0", result: {} });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // 坏行忽略：夹具只服务于已知请求序列。
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
