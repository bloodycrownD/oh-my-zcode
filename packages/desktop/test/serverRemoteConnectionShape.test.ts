// T-RD3（upstream-v316-fullsync §phase-remote-daemon Step 16；Step 17 更新裁量语义）：
// desktop daemon 隧道握手面。
//
// 锁死三件事：
// 1) 终局守卫：serverRemoteConnection.ts 恒为 duplex-only——上游 WS 形态（connectServerRemote
//    及 fetchServerInfo/fetchHostCapability/authenticatedUrl/ServerConnectOptions 面）的
//    唯一消费方是 target.kind === "server" 直连分支，omz 无该 target（deployServer 旧链承载），
//    二期 ConnectionManager 落地后裁决不回填，终局缺席断言防回归。
// 2) resolveServerRemoteEndpoints 四端点推导与协议翻转。
// 3) 握手三请求复用同一条 Duplex（T-RM1 的纯逻辑面）：reusable agent 第二次建连即抛；
//    requestJsonOverDuplex 在人造 Duplex 上完成一次 HTTP 往返并解析 JSON。
//
// 运行形态：worktree 根 `node --import tsx --test packages/desktop/test/serverRemoteConnectionShape.test.ts`
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createReusableDuplexHttpAgent,
  requestJsonOverDuplex,
} from "../src/host/serverRemoteDuplexTransport.js";
import { resolveServerRemoteEndpoints } from "../src/host/serverRemoteConnection.js";

test("T-RD3 终局守卫：仅 duplex 形态在位，WS 形态终局缺席", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/host/serverRemoteConnection.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    source.includes("export async function connectServerRemoteOverDuplex"),
    "duplex 形态必须在位",
  );
  assert.ok(
    !/export async function connectServerRemote\(/.test(source),
    "WS 形态 connectServerRemote 不得落地",
  );
  for (const wsOnlySymbol of [
    "function fetchServerInfo",
    "function fetchHostCapability",
    "function connectNodeWebSocket",
    "ServerConnectOptions",
    "function authenticatedUrl",
  ]) {
    // 断言函数定义形态而非裸符号：顶部裁量注释允许提及缺席缘由。
    assert.ok(!source.includes(wsOnlySymbol), `WS 形态专属符号 ${wsOnlySymbol} 不得落地`);
  }
  assert.ok(source.includes("二期终局裁量"), "duplex-only 定案必须留终局裁量注释");
});

test("T-RD3 端点推导：http(s)→ws(s) 翻转与路径归一", () => {
  const endpoints = resolveServerRemoteEndpoints("https://relay.example.com/base/");
  assert.equal(endpoints.infoUrl, "https://relay.example.com/base/api/server-info");
  assert.equal(endpoints.wsUrl, "wss://relay.example.com/base/ws");
  assert.equal(
    endpoints.hostCapabilityUrl,
    "https://relay.example.com/base/api/rpc-host-capability",
  );
  assert.equal(endpoints.hostWsUrl, "wss://relay.example.com/base/ws/host");

  const wsInput = resolveServerRemoteEndpoints("ws://host:9/base/ws/host");
  assert.equal(wsInput.infoUrl, "http://host:9/base/api/server-info");
  assert.equal(wsInput.hostWsUrl, "ws://host:9/base/ws/host");

  assert.throws(() => resolveServerRemoteEndpoints("  "));
  assert.throws(() => resolveServerRemoteEndpoints("ftp://host"));
});

/** 人造 HTTP-over-Duplex：收到请求头结束符后回一段固定 JSON 响应。 */
function createFakeHttpDuplex(responseBody: unknown): Duplex {
  const fake = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      const text = String(chunk);
      if (text.includes("\r\n\r\n")) {
        const body = JSON.stringify(responseBody);
        fake.push(
          Buffer.from(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
            "utf8",
          ),
        );
        fake.push(null);
      }
      callback();
    },
  });
  return fake;
}

test("T-RD3 reusable agent：首次建连返回隧道，第二次立即抛错（单 Duplex 承载三请求的合同）", async () => {
  let created = 0;
  const agent = await createReusableDuplexHttpAgent(() => {
    created += 1;
    return createFakeHttpDuplex({ ok: true });
  });
  assert.equal(created, 1);
  const createConnection = agent.createConnection as (
    options: unknown,
    callback: () => void,
  ) => unknown;
  assert.ok(
    createConnection({}, () => undefined),
    "首次调用必须交出已建立的隧道",
  );
  assert.throws(
    () => createConnection({}, () => undefined),
    /attempted to create a second connection/,
  );
  agent.destroy();
});

test("T-RD3 requestJsonOverDuplex：无 agent 时单次连接完成 HTTP 往返", async () => {
  let created = 0;
  const result = await requestJsonOverDuplex<{ ok: boolean }>({
    url: "http://source-server.invalid/api/server-info",
    headers: { authorization: "Bearer token" },
    createConnection: () => {
      created += 1;
      return createFakeHttpDuplex({ ok: true });
    },
  });
  assert.equal(created, 1);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});
