import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { after, before, describe, it } from "node:test";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, isInsideDirectory, isPathDriveQualified } from "../src/http.js";

// T-UF3（Step 16 / U9）：静态文件路由的路径穿越加固。
//
// 背景：Windows 上 path.resolve(root, "Z:/x") 会直接切到 Z 盘（含 subst 虚拟盘与映射的
// 网络盘）；而跨盘时 path.relative(root, "Z:\\x") 返回的是目标绝对路径，既不是 "" 也不以
// ".." 开头，旧的「根内前缀校验」于是把越界目标误判为安全。通配静态路由不在 token 中间件
// 保护范围内，因此静态根所在盘之外的任意文件都可能被未授权读取（含 %3A 编码形式、UNC
// "\\\\host\\share" 与 Windows 根路径 "\\x"）。
//
// 用例固化三道防线：①盘符路径在 resolve 之前拒绝；②绝对路径在 resolve 之前拒绝；
// ③"根内"判定把 relative 结果为绝对路径（跨盘）视为越界，并保留原有 ".." 语义。
// 断言一律对着真实启动的 HTTP 服务做（行为断言），不使用源码字符串匹配。

type RunningServer = ReturnType<typeof createHttpServer>;

const servers: RunningServer[] = [];
const tempDirs: string[] = [];

function serverPort(server: RunningServer): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试服务器没有可用的 TCP 端口");
  }
  return address.port;
}

async function startStaticServer(staticRoot: string, spaFallback: boolean): Promise<string> {
  const server = createHttpServer(new ServiceCollection(), 0, { staticRoot, spaFallback });
  servers.push(server);
  if (!server.listening) {
    // listen() 是异步的，createHttpServer 返回时端口可能尚未绑定。
    await new Promise<void>((resolveListen, reject) => {
      server.once("listening", () => resolveListen());
      server.once("error", reject);
    });
  }
  return `http://127.0.0.1:${serverPort(server)}`;
}

async function closeServer(server: RunningServer): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
    // fetch/undici 默认 keep-alive，不主动断开会让 close 回调久等。
    // ServerType 是 http.Server | Http2Server 联合类型，Http2Server 的声明里没有该方法。
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
  });
}

async function get(baseUrl: string, pathname: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, text: await response.text() };
}

const OUTSIDE_MARKER = "TOP-SECRET-OUTSIDE-ROOT";

let staticRoot = "";
let outsideSecretPath = "";
let baseUrl = "";
let spaFallbackBaseUrl = "";

before(async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-static-containment-"));
  tempDirs.push(baseDir);
  staticRoot = join(baseDir, "root");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "<html>home</html>");
  await writeFile(join(staticRoot, "app.js"), "console.log('app');");
  // 静态根的同级文件：任何形如 "../secret.txt" 的逃逸一旦被放行就会把它读出来。
  outsideSecretPath = join(baseDir, "secret.txt");
  await writeFile(outsideSecretPath, OUTSIDE_MARKER);
  baseUrl = await startStaticServer(staticRoot, false);
  spaFallbackBaseUrl = await startStaticServer(staticRoot, true);
});

after(async () => {
  await Promise.all(servers.map((server) => closeServer(server)));
  servers.length = 0;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("静态路由 相对路径逃逸", () => {
  it("编码斜杠保留的 .. 逃逸返回 404，且读不到静态根外的文件", async () => {
    // %2F 不被 URL 归一化，pathname 保持 "/%2e%2e%2Fsecret.txt"，解码后得到 "../secret.txt"。
    const escaped = await get(baseUrl, "/%2e%2e%2Fsecret.txt");
    assert.equal(escaped.status, 404);
    assert.equal(escaped.text.includes(OUTSIDE_MARKER), false);

    // 反斜杠形式：Windows 上 "../secret.txt" 与 "..\\secret.txt" 等价，posix 上是普通文件名。
    const backslash = await get(baseUrl, "/%2e%2e%5Csecret.txt");
    assert.equal(backslash.status, 404);
    assert.equal(backslash.text.includes(OUTSIDE_MARKER), false);
  });

  it("裸 .. 由 WHATWG URL 归一化回根内，未命中即 404（不会越界）", async () => {
    const normalized = await get(baseUrl, "/%2e%2e/secret.txt");
    assert.equal(normalized.status, 404);
    assert.equal(normalized.text.includes(OUTSIDE_MARKER), false);
  });
});

describe("静态路由 盘符路径逃逸", () => {
  // 加固前（Windows）：resolve(root, "Z:/marker.txt") === "Z:\\marker.txt"，跨盘 relative 返回
  // 绝对路径被判为「根内」，stat 失败后进入 SPA fallback → 200 index.html（或在目标盘真实
  // 存在时直接读出内容）。加固后：resolve 之前就拒绝，一律 404。
  const driveForms = ["/Z%3A/marker.txt", "/Z%3A%5Cmarker.txt", "/Z:marker.txt"];

  it("盘符路径（明文与 %3A 编码）一律 404", async () => {
    for (const pathname of driveForms) {
      const response = await get(baseUrl, pathname);
      assert.equal(response.status, 404, `${pathname} 应为 404`);
      assert.equal(response.text.includes(OUTSIDE_MARKER), false);
    }
  });

  it("盘符路径不进入 SPA fallback（开启 fallback 时仍为 404，而非 index.html 200）", async () => {
    for (const pathname of driveForms) {
      const response = await get(spaFallbackBaseUrl, pathname);
      assert.equal(response.status, 404, `${pathname} 不得回落到 index.html`);
    }
  });
});

describe("静态路由 绝对路径逃逸", () => {
  it("UNC 与 Windows 根路径一律 404，且不进入 SPA fallback", async () => {
    const absoluteForms = [
      // \\server\share\marker.txt（UNC）
      "/%5C%5Cserver%5Cshare%5Cmarker.txt",
      // \Windows\System32\drivers\etc\hosts（驱动根路径）
      "/%5CWindows%5CSystem32%5Cdrivers%5Cetc%5Chosts",
    ];
    for (const pathname of absoluteForms) {
      const strict = await get(baseUrl, pathname);
      assert.equal(strict.status, 404, `${pathname} 应为 404`);
      const fallback = await get(spaFallbackBaseUrl, pathname);
      assert.equal(fallback.status, 404, `${pathname} 不得回落到 index.html`);
      assert.equal(fallback.text.includes(OUTSIDE_MARKER), false);
    }
  });

  it("静态根外文件的绝对路径形态（盘符/URI 形式）返回 404", async () => {
    const absolutePath = outsideSecretPath.replace(/\\/g, "/");
    const response = await get(baseUrl, `/${absolutePath}`);
    assert.equal(response.status, 404);
    assert.equal(response.text.includes(OUTSIDE_MARKER), false);
  });
});

describe("静态路由 正常资源不受影响", () => {
  it("根路径返回 index.html，普通资源文件照常读取", async () => {
    const index = await get(baseUrl, "/");
    assert.equal(index.status, 200);
    assert.equal(index.text, "<html>home</html>");

    const asset = await get(baseUrl, "/app.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.text, "console.log('app');");
  });
});

describe("isPathDriveQualified", () => {
  it("识别盘符绝对路径与盘符相对路径", () => {
    assert.equal(isPathDriveQualified("Z:/marker.txt"), true);
    assert.equal(isPathDriveQualified("z:\\marker.txt"), true);
    // 无分隔符的盘符相对路径在 win32 resolve 下同样会切盘
    assert.equal(isPathDriveQualified("Z:marker.txt"), true);
  });

  it("不误伤正常相对路径", () => {
    assert.equal(isPathDriveQualified("assets/app.js"), false);
    assert.equal(isPathDriveQualified("assets/Z-report.txt"), false);
    assert.equal(isPathDriveQualified("index.html"), false);
  });
});

describe("isInsideDirectory", () => {
  it("win32 跨盘：relative 返回绝对路径时必须判为越界", () => {
    // 加固前：path.win32.relative("C:\\zcode\\web", "Z:\\marker.txt") === "Z:\\marker.txt"，
    // 不以 ".." 开头，被旧实现误判为在目录内。
    assert.equal(isInsideDirectory("C:\\zcode\\web", "Z:\\marker.txt", win32), false);
    assert.equal(
      isInsideDirectory("C:\\zcode\\web", win32.resolve("C:\\zcode\\web", "index.html"), win32),
      true,
    );
    assert.equal(
      isInsideDirectory(
        "C:\\zcode\\web",
        win32.resolve("C:\\zcode\\web", "..", "secret.txt"),
        win32,
      ),
      false,
    );
  });

  it("posix 语义保持不变", () => {
    assert.equal(isInsideDirectory("/srv/web", "/srv/web/assets/app.js", posix), true);
    assert.equal(isInsideDirectory("/srv/web", "/srv/web", posix), true);
    assert.equal(isInsideDirectory("/srv/web", "/srv/etc/passwd", posix), false);
    assert.equal(isInsideDirectory("/srv/web", "/srv/web/../secret", posix), false);
  });
});
