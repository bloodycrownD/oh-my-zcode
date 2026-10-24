// Source Server release resolver 单测（backlog-sweep：management.updateSource 的制品入口）。
// 运行形态：worktree 根 `node --import tsx --test packages/services/test/sourceServerReleaseResolver.test.ts`
// 覆盖：本地 descriptor 校验、metadataOnly 不下载 archive、remote-download URL 组装、
// 上游不可达时 fail-closed 为「未知」（不返回伪造版本）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_VERSION } from "@zcode/shared";
import {
  createSourceServerReleaseResolver,
  SourceServerReleaseUnavailableError,
  SOURCE_SERVER_RELEASE_UNAVAILABLE_ERROR_CODE,
} from "../src/source-server-management/sourceServerReleaseResolver.js";

const target = { kind: "ssh", host: "example.com", username: "alice" } as const;
const probe = { platform: "linux", arch: "x64", installed: false } as const;
const fileName = "zcode-server-linux-x64.tar.gz";
const descriptorFileName = "omz-server-release.json";

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function descriptor(contents: string) {
  return {
    schemaVersion: 1,
    version: ZCODE_VERSION,
    archives: [
      {
        target: "linux-x64",
        version: ZCODE_VERSION,
        fileName,
        sha256: sha256(contents),
        sizeBytes: Buffer.byteLength(contents),
        urls: [fileName],
      },
    ],
  };
}

async function createTempRoot(label: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `omz-source-release-${label}-`));
}

test("resolver 使用 omz 本地 descriptor 并校验 archive，不访问网络", async (t) => {
  const root = await createTempRoot("local");
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDir = join(root, "releases", ZCODE_VERSION);
  const contents = "local-source-server";
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, fileName), contents);
  await writeFile(join(releaseDir, descriptorFileName), JSON.stringify(descriptor(contents)));

  let fetchCalls = 0;
  const resolver = createSourceServerReleaseResolver({
    resolveAssetDirs: () => ({ mockCdnDir: root }),
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("local resolution must not access the network");
    },
  });

  const release = await resolver(probe, target);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(release, {
    localArchivePath: join(releaseDir, fileName),
    target: "linux-x64",
    version: ZCODE_VERSION,
    sha256: sha256(contents),
    sizeBytes: Buffer.byteLength(contents),
    urls: [fileName],
  });
});

test("metadataOnly 只取 descriptor 元数据，不下载 archive", async (t) => {
  const root = await createTempRoot("metadata");
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = "preview-package";
  const fetched: string[] = [];
  const resolver = createSourceServerReleaseResolver({
    resolveAssetDirs: () => ({
      remoteCdnBaseUrls: ["https://release.test/releases"],
      remoteCacheDir: join(root, "cache"),
    }),
    fetch: async (input) => {
      fetched.push(String(input));
      if (String(input).endsWith(`/${descriptorFileName}`)) {
        return new Response(JSON.stringify(descriptor(contents)), { status: 200 });
      }
      throw new Error("metadataOnly must not fetch archives");
    },
  });

  const release = await resolver(probe, target, { metadataOnly: true });
  assert.equal(release.localArchivePath, undefined);
  assert.equal(release.target, "linux-x64");
  assert.equal(release.version, ZCODE_VERSION);
  assert.equal(release.sha256, sha256(contents));
  assert.equal(release.sizeBytes, Buffer.byteLength(contents));
  assert.ok(fetched.length > 0);
  assert.ok(fetched.every((url) => url.endsWith(`/${descriptorFileName}`)));
});

test("remote-download 返回绝对 URL 且不落地本地 archive", async (t) => {
  const root = await createTempRoot("remote");
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = "remote-source-server";
  const resolver = createSourceServerReleaseResolver({
    resolveAssetDirs: () => ({
      remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      remoteCacheDir: join(root, "cache"),
    }),
    fetch: async (input) => {
      if (String(input).endsWith(`/${descriptorFileName}`)) {
        return new Response(JSON.stringify(descriptor(contents)), { status: 200 });
      }
      return new Response(null, { status: 404 });
    },
  });

  const release = await resolver(probe, { ...target, assetInstallMode: "remote-download" });
  assert.equal(release.localArchivePath, undefined);
  assert.deepEqual(release.urls, [
    `https://cdn.example.test/releases/${ZCODE_VERSION}/${fileName}`,
    `https://cdn.example.test/releases/${fileName}`,
  ]);
  assert.equal(release.sha256, sha256(contents));
});

test("无网络/上游不可达时 fail-closed 为未知，不伪造可用更新", async (t) => {
  const root = await createTempRoot("offline");
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const resolver = createSourceServerReleaseResolver({
    resolveAssetDirs: () => ({
      remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      remoteCacheDir: join(root, "cache"),
    }),
    fetch: async () => {
      throw new Error("offline");
    },
    logWarn: (message) => warnings.push(message),
  });

  await assert.rejects(
    resolver(probe, target),
    (error: unknown) => {
      assert.ok(error instanceof SourceServerReleaseUnavailableError);
      assert.equal(error.code, SOURCE_SERVER_RELEASE_UNAVAILABLE_ERROR_CODE);
      assert.equal(error.retryable, true);
      assert.match(error.message, /unknown/u);
      return true;
    },
  );
  assert.deepEqual(warnings, ["[source-server] release resolution failed"]);
});

test("本地 archive 与 descriptor 不匹配时同样按未知失败", async (t) => {
  const root = await createTempRoot("corrupt");
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDir = join(root, "releases", ZCODE_VERSION);
  const descriptorContents = "expected-source-server";
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, fileName), "tampered-source-server");
  await writeFile(
    join(releaseDir, descriptorFileName),
    JSON.stringify(descriptor(descriptorContents)),
  );

  const resolver = createSourceServerReleaseResolver({
    resolveAssetDirs: () => ({ mockCdnDir: root }),
  });

  await assert.rejects(
    resolver(probe, target),
    (error: unknown) =>
      error instanceof SourceServerReleaseUnavailableError &&
      error.code === SOURCE_SERVER_RELEASE_UNAVAILABLE_ERROR_CODE,
  );
});
