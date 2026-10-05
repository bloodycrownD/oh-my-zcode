#!/usr/bin/env node
/**
 * MF-02 acceptance — CDN 旧 id 别名容忍必须真的可达（S32/S33 的 alias 分支修复前不可达）。
 *
 * 修复前：官方 CDN（D-2 端点保留）仍以旧名 `zcode-plugins-official` 发布 manifest，而刷新路径
 *   1) `addMarketplace` 的保留字检查用 `isOfficialMarketplaceId(name) && name !== trustedId`：
 *      trustedId=canonical、name=旧名 → 先抛「reserved」，根本走不到 CDN 分片写入；
 *   2) 即便走到，`:375` 只在 name===canonical 时才 writeCdn。
 *   于是 `official-marketplace.ts` 里那段旧名别名容忍在真实环境永远走不到，官方插件市场刷新必败。
 *
 * 本脚本用本地 http server 冒充 CDN（避免外网依赖），覆盖三条回归：
 *   1. 旧名 manifest + trustedId=canonical → 刷新成功、CDN 分片落盘、merged 归一 canonical、
 *      known_marketplaces 仍是唯一 canonical 记录且无 lastRefreshFailure；
 *   2. 第三方源声明官方 id（canonical 或旧名）且无 trustedId → 仍抛 reserved（用户侧新增被拒）；
 *   3. 第三方源给非官方名 + trustedId=canonical → 仍抛「must provide official」（冒用被拒）。
 *
 * 另含 contracts 的扩集语义锚点：`isOfficialMarketplaceId` = canonical∪legacy，
 * `isCanonicalOfficialMarketplaceId` 只认 canonical——守卫判定必须用后者，否则第 1 条会自撞。
 *
 * Runs on `node:test`，importing the compiled `dist/` — run
 * `pnpm --filter @zcode/contracts build && pnpm --filter @zcode/adapters build` first.
 *
 * 与 test-feature-flag.mjs 同理：@zcode/shared / @zcode/model-option-map 以裸 TS 为入口，
 * plain node 加载不了，下面 registerHooks 把它们重定向到各自的 dist/。
 *
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        if (existsSync(candidate))
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const {
  isCanonicalOfficialMarketplaceId,
  isOfficialMarketplaceId,
  ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} = await import("@zcode/contracts");
const { addMarketplace, loadKnownMarketplacesSync, updateMarketplace } =
  await import("../dist/plugins/index.js");

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — MF-02 official marketplace legacy-id alias tolerance"
      : `TEST FAIL — MF-02 official marketplace legacy-id alias tolerance (exit code ${code})`,
  );
});

/** 冒充 CDN：返回指定 name 的 marketplace manifest（只走真实刷新路径上的 http 分支）。 */
async function startFakeCdn(manifest) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(manifest));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/marketplace.json` };
}

function makeStorageRoot() {
  return mkdtempSync(join(tmpdir(), "zcode-mf02-"));
}

function officialPartitionPath(storageRoot, fileName) {
  return join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function legacyPartitionPath(storageRoot, fileName) {
  return join(storageRoot, "marketplaces", ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 写出 known_marketplaces.json（updateMarketplace 的输入前提），source 指向本地冒充 CDN。 */
function seedOfficialKnownRecord(storageRoot, source) {
  writeFileSync(
    join(storageRoot, "known_marketplaces.json"),
    `${JSON.stringify(
      {
        version: 1,
        marketplaces: [
          {
            id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
            source: { source: "url", url: source },
            name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
            addedAt: "2026-01-01T00:00:00.000Z",
            pluginCount: 0,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("contracts: isOfficialMarketplaceId 是 canonical∪legacy，canonical 判定只认新名", () => {
  assert.equal(isOfficialMarketplaceId(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE), true);
  assert.equal(isOfficialMarketplaceId(ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE), true);
  assert.equal(isOfficialMarketplaceId("third-party-market"), false);
  assert.equal(isCanonicalOfficialMarketplaceId(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE), true);
  // 守卫的自撞防线：受信任刷新判定若用扩集，旧名 manifest 会把自己挡下。
  assert.equal(isCanonicalOfficialMarketplaceId(ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE), false);
});

test("MF-02: 旧名 manifest + trustedId=canonical → 刷新成功、分片落盘、merged 归一 canonical", async (t) => {
  const storageRoot = makeStorageRoot();
  const cdn = await startFakeCdn({
    name: ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE,
    description: "fake CDN",
    plugins: [{ name: "demo-plugin", description: "demo" }],
  });
  t.after(() => {
    cdn.server.close();
    rmSync(storageRoot, { force: true, recursive: true });
  });
  seedOfficialKnownRecord(storageRoot, cdn.url);

  const updated = await updateMarketplace({ storageRoot });

  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  assert.equal(updated[0].name, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);

  // CDN 分片按收到的旧名原样落盘（别名容忍的直接证据），merged 侧归一 canonical。
  assert.equal(
    readJson(officialPartitionPath(storageRoot, "cdn-marketplace.json")).name,
    ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE,
  );
  const merged = readJson(officialPartitionPath(storageRoot, "marketplace.json"));
  assert.equal(merged.name, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  assert.deepEqual(
    merged.plugins.map((plugin) => plugin.name),
    ["demo-plugin"],
  );
  // 旧名不得在磁盘上长出影子市场目录。
  assert.equal(existsSync(legacyPartitionPath(storageRoot, "marketplace.json")), false);

  const known = loadKnownMarketplacesSync(storageRoot);
  assert.deepEqual(
    known.map((record) => record.id),
    [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE],
  );
  assert.equal(known[0].lastRefreshFailure, undefined);
  assert.equal(known[0].pluginCount, 1);
});

test("MF-02: 第三方源声明官方 id 且无 trustedId → 仍抛 reserved（用户侧新增被拒）", async (t) => {
  const storageRoot = makeStorageRoot();
  for (const declaredName of [
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE,
  ]) {
    const cdn = await startFakeCdn({ name: declaredName, plugins: [] });
    try {
      await assert.rejects(
        addMarketplace({ source: { source: "url", url: cdn.url }, storageRoot }),
        /reserved for the official marketplace/,
      );
    } finally {
      cdn.server.close();
    }
  }
  t.after(() => rmSync(storageRoot, { force: true, recursive: true }));
});

test("MF-02: 官方记录刷回非官方 manifest 名 → 仍抛 must provide official（冒用被拒）", async (t) => {
  const storageRoot = makeStorageRoot();
  const cdn = await startFakeCdn({ name: "third-party-market", plugins: [] });
  t.after(() => {
    cdn.server.close();
    rmSync(storageRoot, { force: true, recursive: true });
  });
  seedOfficialKnownRecord(storageRoot, cdn.url);

  const updated = await updateMarketplace({ storageRoot });

  // updateMarketplace 把失败持久化成 lastRefreshFailure 而不是抛出，官方缓存不被替换。
  assert.deepEqual(updated, []);
  const known = loadKnownMarketplacesSync(storageRoot);
  assert.equal(known.length, 1);
  assert.equal(known[0].id, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  assert.match(known[0].lastRefreshFailure.message, /must provide/);
});
