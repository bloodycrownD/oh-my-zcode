#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-NET 族——非标准状态码不再打死 agent 进程。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P1 #1 / #3 / #4）
 * ============================================================================
 *
 * 修复前两处 adapter 都在 `http.request` 的回调里直接 `new Response(stream, { status })`：
 * WHATWG `Response` 只收 200–599，204/205/304 还不许挂正文。LinkedIn 对爬虫回 999，
 * 构造函数在回调里抛 RangeError——回调里的抛出没人接得住，`agent` 进程以 uncaughtException
 * 退出，同一工作区的会话和 run 一起断掉。
 *
 * 三条独立断言面（互相不可替代，见 spec §4 的 r3/r4 修正）：
 *   T-NET-1  proxy-fetch：状态码表示不了 → 这次请求**失败**（reject + UnsupportedHttpStatusError），
 *            进程不崩。999 走 `readIncomingResponse`/`toWebResponse` 这一支。
 *   T-NET-1b http adapter（`createNodeHttpClientAdapter`）：999 原样带回 → `request()`
 *            **resolve 且 status=999**。它不经过 proxy-fetch，post-fix 两者无调用关系；
 *            必须走 https + `caCertFile` 才会离开全局 fetch 捷径（:167-176）进 transport 回调分支。
 *   T-NET-2  `readIncomingResponse` + `readResponseBody`：204/304 无正文状态不构造 body 流、
 *            不走 arrayBuffer + 超限误判，正文就是空的；超限判定对带正文的响应仍然生效。
 *
 * 运行：`node --test scripts/test-network-status-crash.mjs`
 * （与同目录既有脚本同法：被测代码是编译产物 `dist/`，workspace 里发布原始 TS 的包由下面的
 *  resolve 钩子改指到同布局 `dist/`——先 `pnpm --filter @zcode/adapters build`。）
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const { createNetworkProxyFetch } = await import("../dist/network/proxy-fetch.js");
const { readIncomingResponse } = await import("../dist/network/incoming-response.js");
const { readResponseBody } = await import("../dist/http/response-body.js");
const { createNodeHttpClientAdapter } = await import("../dist/http/index.js");

/**
 * 进程级兜底：本族三条断言的前提都是「回调里的抛出不再打死进程」。
 * 一旦有 uncaughtException / unhandledRejection，在这里记下来（装了监听器就由我们裁决，
 * node:test 不会把进程整个掀翻），测试结束时断言为零。
 */
const processFailures = [];
process.on("uncaughtException", (error) => processFailures.push(error));
process.on("unhandledRejection", (reason) => processFailures.push(reason));

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — unsupported/non-standard HTTP status no longer kills the agent process (T-NET-1 / T-NET-1b / T-NET-2)"
      : `TEST FAIL — HTTP status crash coverage (exit code ${code})`,
  );
});

/** 起一个本地 http/https server，固定返回给定状态码。返回 { url, close }。 */
async function startStatusServer({ tls = false, status, body = "", headers = {} } = {}) {
  const handler = (_request, response) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const server = tls
    ? https.createServer(
        { key: TLS_TEST_KEY, cert: TLS_TEST_CERT },
        handler,
      )
    : http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `${tls ? "https" : "http"}://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── T-NET-1：proxy-fetch 对 999 以普通 reject 失败，进程不崩 ──────────────────────

test("T-NET-1 proxy-fetch rejects an unsupported status instead of killing the process", async () => {
  // 本地 http server 直接充当转发代理：目标必须是 http://（https 会走 CONNECT），
  // 请求由 ProxyAgent 以绝对 URL 形式发给它。
  const proxy = await startStatusServer({ status: 999, body: "nope" });
  try {
    const proxyFetch = createNetworkProxyFetch({ httpProxy: proxy.url });
    const error = await proxyFetch("http://example.invalid/anything").then(
      () => undefined,
      (rejection) => rejection,
    );
    assert.ok(error, "999 必须让这次请求失败，而不是命令式抛错打死进程");
    assert.equal(error.code, "ZCODE_UNSUPPORTED_HTTP_STATUS");
    assert.equal(error.status, 999);
    // 形状跟随原生 fetch 的网络失败：调用方按错误码区分，不按文本。
    assert.equal(error instanceof TypeError, true);
  } finally {
    await proxy.close();
  }
});

// ── T-NET-1b：NodeHttpClientAdapter 经 transport 回调分支原样带回 999 ─────────────

test("T-NET-1b node http adapter resolves with status 999 through the transport callback", async () => {
  const server = await startStatusServer({ tls: true, status: 999, body: "nope" });
  const dir = await mkdtemp(join(tmpdir(), "zcode-net-999-"));
  const caCertFile = join(dir, "ca.pem");
  // caCertFile 只对 https 生效：这是把请求逼进 transport 回调分支（:167-176 之外）的唯一开关，
  // 也正是 999 让回调里的 `new Response(...)` 抛错的那条路。
  await writeFile(caCertFile, TLS_TEST_CERT, "utf-8");
  try {
    const client = createNodeHttpClientAdapter({ caCertFile });
    const response = await client.request({ url: `${server.url}/anything` });
    // post-fix 终态：原样带回非标准状态码、不 reject（reject 语义只属 proxy-fetch 路径）；
    // 正文也照常读出（999 不是无正文状态），说明回调分支没有把它当异常处理掉。
    assert.equal(response.status, 999);
    assert.equal(new TextDecoder().decode(response.body), "nope");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});

// ── T-NET-2：无正文状态不构造 body 流、不走 arrayBuffer + 超限误判 ────────────────

/** 造一个 http.IncomingMessage 的最小替身：本函数只读 statusCode/statusMessage/headers 并 resume。 */
function fakeIncomingMessage(status) {
  const resumed = { value: false };
  const message = {
    statusCode: status,
    statusMessage: "No Content",
    headers: {},
    resume() {
      resumed.value = true;
      return message;
    },
  };
  return { message, resumed };
}

test("T-NET-2 null-body statuses are read as empty without arrayBuffer or a size verdict", async () => {
  for (const status of [204, 304]) {
    const { message, resumed } = fakeIncomingMessage(status);
    const incoming = readIncomingResponse(message);
    assert.equal(incoming.status, status);
    assert.equal(incoming.body, null, `${status} 不该有正文流`);
    assert.equal(resumed.value, true, `${status} 必须 resume，socket 才能回到连接池`);

    // 无正文状态不得再走 arrayBuffer + 超限判定：这里给的替身只要被读 arrayBuffer 就抛。
    const guarded = {
      status,
      headers: new Headers(),
      body: null,
      arrayBuffer() {
        throw new Error("null-body statuses must not read arrayBuffer");
      },
    };
    // maxResponseBytes=0 也不许误判超限（正文为空，与上限无关）。
    const body = await readResponseBody(guarded, 0, new AbortController().signal, "https://example.invalid/");
    assert.equal(body.byteLength, 0);
  }
});

test("T-NET-2 the size limit still applies to responses that do carry a body", async () => {
  const response = new Response("0123456789", { status: 200 });
  await assert.rejects(
    readResponseBody(response, 4, new AbortController().signal, "https://example.invalid/"),
    (error) => error.code === "too_large",
  );
});

test("T-NET/NET-1b: no uncaughtException or unhandledRejection during the run", () => {
  assert.deepEqual(
    processFailures.map((error) => (error instanceof Error ? error.message : String(error))),
    [],
  );
});

// ── 自签名测试证书（仅 127.0.0.1/localhost，嵌入式自持，不依赖仓库外的 fixture）──
// 生成：openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1"
//        -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"

const TLS_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUDZUbom23Ja7WQVIfOwyufmVtKeMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAxMTE3NDg0NFoYDzIxMjYw
OTE3MTc0ODQ0WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC77iLeUMBcuU3LKHeUu353V1qbP92fnHgTyxpLjG/i
b2OkQhWv81GDVVmDGZqSPt1MGqkkHAIFS/Ys1L08rjS620bmQWcwEd1nCnsPANfp
LXwI/TVzEbDjUXLJc0b8z55N6Z/U9nhhs7DE6KlbMpkldgHlDrYtonVb8XknPcOR
0PCQm96pbSNNdMocQMjXPbCRf4hfsygHTP9xPLAm2TdRkcdJq7v4MyDUs2zi9bRO
wAw5Po1aLUhhxQrYxLPa+K1yGsjZ9Ih5k6RgCRKRKo9NsV5w+90G+6q+uZsg4qME
r1x2n4w6Yl8wcGf3RohVjCqo6pB134+Fjtkcfw+Fs3x1AgMBAAGjbzBtMB0GA1Ud
DgQWBBSnSiCvM8l04wf89G/iUvWGQHpIDzAfBgNVHSMEGDAWgBSnSiCvM8l04wf8
9G/iUvWGQHpIDzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAGhgZ169XWJnuG3iuD2mPw3+PfR/U
hIOeeQPOp3Zqo26v+QzGA9T0XBeiIdVcBSk88/tjao1Sg/iG8UnzE2g6lw9xfXp5
+wSgo1ZfziMSwCw1+KPv6p1Sahe1QBJU6f6sB4pRXM3bp2CJ1zJ2TPo/lSzzQHpD
Z02KWTU6DYrcp80Ydz+WSJAWaXsbDaBfrk8dqu+fz1KWKiWew/Wx3FAWiXYEgMsV
+Pm1/hW/ltgTw+ypVnrkRKRdC0Hey1yw782NxGG7h52G+tomekbGWT6H7itWfVw+
6ID7NTg1MhOoi7QnUNHyqYpqgpSHRzn7ezfoqBQIkYOjTFLfNLYoshl8jQ==
-----END CERTIFICATE-----`;

const TLS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC77iLeUMBcuU3L
KHeUu353V1qbP92fnHgTyxpLjG/ib2OkQhWv81GDVVmDGZqSPt1MGqkkHAIFS/Ys
1L08rjS620bmQWcwEd1nCnsPANfpLXwI/TVzEbDjUXLJc0b8z55N6Z/U9nhhs7DE
6KlbMpkldgHlDrYtonVb8XknPcOR0PCQm96pbSNNdMocQMjXPbCRf4hfsygHTP9x
PLAm2TdRkcdJq7v4MyDUs2zi9bROwAw5Po1aLUhhxQrYxLPa+K1yGsjZ9Ih5k6Rg
CRKRKo9NsV5w+90G+6q+uZsg4qMEr1x2n4w6Yl8wcGf3RohVjCqo6pB134+Fjtkc
fw+Fs3x1AgMBAAECggEACiEdtdlo5jviWU0DAFwzHBge17IzeMmsgDaeN3cS8G5x
aAuxfbnHSZAADTdZU+t5rpiGSDO5Q9NSahwFCisCnRVkxtQ8zVln014RgB9wbnlS
OkLO+Xbj5PtsIjcUMFwOy+NyhxOfgqFL6cUiRw/dCNOe6lt8Ds129r/MeFoVezu4
hs0PbPLQp8727KnLuw7puDvCbSUmLZPijbaUxjOnzsn/AbkGuCkILCc7L57dexII
UOBLwAv19vVpc8Q36iCVu8WdWOz1nAyB2ORPLmZLpk4/KE0vL/uPxogMqvqJWADP
EWD+9XnzICdx+aUy+sBJ16EbqsmN3wlN9aHWN8pr4QKBgQDsdx8eSdLbQzI02ilM
edXq8ktpfFmVKXG+0iUAjv/8ilT5UnHVx3jdi72FMRA4S20/NKTWQcjB0t/g5KtJ
nZu8CCWQVC2HhvNspakkHbXc3SDmyafwkyRsc9EiIiKZAyniu6kAy/UFE7BM7auW
0DBWIifHRah5/+RatxJWmUy/VQKBgQDLdJJizMOEKhpItO/xLPEOLGqEZDqr2+Od
BxqMqNFriyqtYs1HzVnMDkWFUDaJXtw1kipp7jFfNLUGZ8OCy2tpRKh4gY1A2uUf
IAwQfEZgx++3RjDqI7F6nlXrqUwdju7D/n1rijC/CiZ37XGEUNoJ7o/de2BZ6SH1
HYeMN6KIoQKBgELXJS+tlHGwG9f+tt/MLKCd3p0xrizQqztSMW1n/ooHHB/hoxXX
rZ2KK4cjqD8Raw8LtXBu5e2LywbJ/HTxnRzYfK3AbaI6jkJuzVHNKCQHSY6S/+qr
3Qbe8gWg+oCf+U4C17HG9Tp7J0GHiRI3RQKD4xSb5xSdNZJC32clLCGFAoGAcGMC
ggUuc5F2V3drm8QBnJy4ck2Tg1/CCfnklpKirE+B0alkUCeFVQ0FJjE7DwMRjZ4i
Q8XKDBdncBRdkaCgwtOkZHzb9Fl2e40OXQTpM4j+SDVDy/LPlTZlq/onC6TrC+VG
juMVLlKDEXheXoLzDs1zNxtyC/iWQ3p+Z9xLskECgYBrSaNwnoduDMLKF95JLk5s
6RnlUiRdcgXpHJmYu5HqNJdA3+5q0GvsFJWADjemdoolwumgOd5A0TyMs47hpsNp
L35Fj4x81Tgrdz6lnv7Cr4OLzEmn4DMRUO7cGeADp/PRDNgHIr++3iYRGLCHMe03
4A7Z129sp+LIZ2m28tiq8A==
-----END PRIVATE KEY-----`;
