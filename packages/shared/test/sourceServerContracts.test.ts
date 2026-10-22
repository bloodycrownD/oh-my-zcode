// T-RD1（upstream-v316-fullsync §phase-remote-daemon Step 16）：source-server shared 契约往返。
//
// 锁死六件事：
// 1) 连接 Profile/更新授权 discriminatedUnion 往返（ssh 端口默认与 host 小写化）。
// 2) 连接状态快照/安装进度/操作日志 strict schema 拒收未知字段。
// 3) compatibility 版本比较与双端兼容判定（upgradeTarget 指向旧端）。
// 4) 发布描述：omz 品牌口径描述文件名 omz-server-release.json + 归档名 zcode-server-<target>.tar.gz
//    成套断言、跨 target 版本一致性与重复 target 拒绝。
// 5) errorCodes 守卫与 connectionLog 脱敏边界（token/UUID/路径/Header）。
// 6) connectionErrors 系统码/认证文本/阶段兜底归一，ECONNRESET 不再误报 preflight。
//
// 运行形态：worktree 根 `node --import tsx --test packages/shared/test/sourceServerContracts.test.ts`
import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  compareCompatibilityVersions,
  connectionProfileSchema,
  evaluateSourceServerCompatibility,
  getSourceServerUpdateTarget,
  isPublicZCodeErrorCode,
  isSameSourceServerUpdateTarget,
  normalizeRemoteConnectionError,
  publicZCodeErrorCodeSchema,
  remoteConnectionFailureLogLevel,
  sanitizeRemoteConnectionLog,
  sourceServerConnectionStateSnapshotSchema,
  sourceServerInstallProgressSchema,
  sourceServerOperationLogSchema,
  sourceServerReleaseDescriptorSchema,
} from "../src/source-server/index.js";
import { serverRemoteInfoOutputSchema } from "../src/server-remote.js";

test("T-RD1 连接 Profile：ssh/wsl/docker 三形态往返", () => {
  const ssh = connectionProfileSchema.parse({
    transport: "ssh",
    profileId: "9b2f5a1e-0000-4000-8000-000000000001",
    createdAt: 1,
    target: { kind: "ssh", host: "host.example.com", username: "root" },
  });
  assert.equal(ssh.transport, "ssh");
  assert.equal(ssh.lifecycleState, "active");

  const wsl = connectionProfileSchema.parse({
    transport: "wsl",
    profileId: "9b2f5a1e-0000-4000-8000-000000000002",
    createdAt: 1,
    target: { kind: "wsl" },
  });
  assert.equal(wsl.transport, "wsl");

  assert.throws(() =>
    connectionProfileSchema.parse({
      transport: "ssh",
      profileId: "9b2f5a1e-0000-4000-8000-000000000003",
      createdAt: 1,
      target: { kind: "ssh", host: "h", username: "u", unknownField: 1 },
    }),
  );
});

test("T-RD1 更新授权：端口默认 22、host 小写化、wsl 缺 distro 判不等", () => {
  const target = getSourceServerUpdateTarget({
    kind: "ssh",
    host: "Host.Example.COM",
    username: "root",
  });
  assert.equal(target.kind, "ssh");
  if (target.kind === "ssh") {
    assert.equal(target.port, 22);
    assert.equal(target.host, "host.example.com");
  }
  assert.equal(
    isSameSourceServerUpdateTarget(
      { kind: "ssh", host: "host.example.com", username: "root" },
      { kind: "ssh", host: "HOST.EXAMPLE.COM", username: "root" },
    ),
    true,
  );
  assert.equal(
    isSameSourceServerUpdateTarget(
      { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      { kind: "wsl", user: "me" },
    ),
    false,
  );
});

test("T-RD1 状态快照 strict：接受公共错误码，拒绝未知字段", () => {
  const snapshot = sourceServerConnectionStateSnapshotSchema.parse({
    profileId: "9b2f5a1e-0000-4000-8000-000000000004",
    state: "needs-install",
    errorCode: "remote-host-unreachable",
    installPreview: { version: "1.0.0", sizeBytes: 1024 },
    runningTasks: [{ sessionId: "s1", workspacePath: "/w" }],
    updatedAt: 5,
  });
  assert.equal(snapshot.updateAvailability, undefined);
  assert.throws(() =>
    sourceServerConnectionStateSnapshotSchema.parse({
      profileId: "9b2f5a1e-0000-4000-8000-000000000005",
      state: "online",
      updatedAt: 5,
      futureField: true,
    }),
  );
});

test("T-RD1 安装进度与操作日志 schema 往返", () => {
  assert.equal(
    sourceServerInstallProgressSchema.parse({ type: "source-server-install-progress", phase: "extract" })
      .phase,
    "extract",
  );
  assert.throws(() =>
    sourceServerInstallProgressSchema.parse({ type: "source-server-install-progress", phase: "nope" }),
  );
  const log = sourceServerOperationLogSchema.parse({
    profileId: "9b2f5a1e-0000-4000-8000-000000000006",
    operation: "connect",
    phase: "probe",
    level: "info",
    message: "ok",
    timestamp: 9,
  });
  assert.equal(log.progress, undefined);
});

test("T-RD1 compatibility：prerelease 比较与 upgradeTarget 指向旧端", () => {
  assert.ok(compareCompatibilityVersions("1.2.3", "1.2.3") === 0);
  assert.ok(compareCompatibilityVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareCompatibilityVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
  assert.ok(compareCompatibilityVersions("1.0.0", "1.0.0-beta.1") > 0);

  const controllerNewer = evaluateSourceServerCompatibility(
    { schemaVersion: 1, productVersion: "2.0.0", minCompatibleVersion: "1.5.0" },
    { schemaVersion: 1, productVersion: "1.0.0", minCompatibleVersion: "1.0.0" },
  );
  assert.equal(controllerNewer.updateAvailable, true);
  assert.equal(controllerNewer.upgradeTarget, "server");
  assert.equal(controllerNewer.requiredMinimumVersion, "1.5.0");
  const equal = evaluateSourceServerCompatibility(
    { schemaVersion: 1, productVersion: "2.0.0", minCompatibleVersion: "1.5.0" },
    { schemaVersion: 1, productVersion: "2.0.0", minCompatibleVersion: "1.5.0" },
  );
  assert.equal(equal.compatible, true);
  assert.equal(equal.upgradeTarget, undefined);
});

test("T-RD1 发布描述：omz 描述文件名 + zcode-server 归档名成套，校验失败路径", () => {
  assert.equal(SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME, "omz-server-release.json");
  const archive = {
    target: "linux-x64",
    version: "1.2.3",
    fileName: "zcode-server-linux-x64.tar.gz",
    sha256: "a".repeat(64),
    sizeBytes: 1024,
    urls: ["zcode-server-linux-x64.tar.gz"],
  };
  const descriptor = sourceServerReleaseDescriptorSchema.parse({
    schemaVersion: 1,
    version: "1.2.3",
    archives: [archive],
  });
  assert.equal(descriptor.archives.length, 1);
  // 归档文件名与约定不符 → 拒绝
  assert.throws(() =>
    sourceServerReleaseDescriptorSchema.parse({
      schemaVersion: 1,
      version: "1.2.3",
      archives: [{ ...archive, fileName: "omz-server-linux-x64.tar.gz" }],
    }),
  );
  // 版本不一致 → 拒绝
  assert.throws(() =>
    sourceServerReleaseDescriptorSchema.parse({
      schemaVersion: 1,
      version: "1.2.3",
      archives: [{ ...archive, version: "1.2.4" }],
    }),
  );
  // 重复 target → 拒绝
  assert.throws(() =>
    sourceServerReleaseDescriptorSchema.parse({
      schemaVersion: 1,
      version: "1.2.3",
      archives: [archive, { ...archive, urls: ["mirror"] }],
    }),
  );
  // 描述符 URL 拒绝绝对本地路径与 ..
  assert.throws(() =>
    sourceServerReleaseDescriptorSchema.parse({
      schemaVersion: 1,
      version: "1.2.3",
      archives: [{ ...archive, urls: ["../escape.tar.gz"] }],
    }),
  );
});

test("T-RD1 errorCodes：守卫函数与 schema 枚举一致", () => {
  assert.equal(isPublicZCodeErrorCode("source-server-install-required"), true);
  assert.equal(isPublicZCodeErrorCode("source-server-upgrade-required"), true);
  assert.equal(isPublicZCodeErrorCode("remote-connection-unknown"), true);
  assert.equal(isPublicZCodeErrorCode("totally-unknown-code"), false);
  assert.equal(publicZCodeErrorCodeSchema.safeParse("not-in-list").success, false);
});

test("T-RD1 connectionLog：Bearer/UUID/token 字段/路径 脱敏", () => {
  const sanitized = sanitizeRemoteConnectionLog(
    "Bearer abcsecret123 via https://user:pass@host/path id=3fa85f64-5717-4562-b3fc-2c963f66afa6 token=[one]",
  );
  assert.ok(!sanitized.includes("abcsecret123"));
  assert.ok(!sanitized.includes("3fa85f64"));
  assert.ok(!sanitized.includes("host/path"));
  assert.ok(!sanitized.includes("[one]"));
  assert.ok(sanitizeRemoteConnectionLog("-----BEGIN RSA PRIVATE KEY-----x-----END RSA PRIVATE KEY-----").includes("[redacted]"));
  assert.equal(remoteConnectionFailureLogLevel("remote-connection-canceled"), "info");
  assert.equal(remoteConnectionFailureLogLevel("remote-host-unreachable"), "error");
});

test("T-RD1 connectionErrors：系统码归一与阶段兜底", () => {
  assert.equal(normalizeRemoteConnectionError({ code: "ECONNRESET" }).code, "remote-host-unreachable");
  assert.equal(normalizeRemoteConnectionError({ code: "EACCES" }).code, "remote-permission-denied");
  assert.equal(
    normalizeRemoteConnectionError(new Error("all configured authentication methods failed")).code,
    "remote-authentication-failed",
  );
  // 无码无文本命中时借阶段兜底
  assert.equal(normalizeRemoteConnectionError(new Error("boom"), "extract").code, "remote-install-failed");
  assert.equal(
    normalizeRemoteConnectionError(new AggregateError([])).code,
    "remote-connection-unknown",
  );
});

test("T-RD1 serverRemoteInfoOutputSchema：strict 出参拒未知字段，匿名 schema 走 compatibility", () => {
  const info = serverRemoteInfoOutputSchema.parse({
    serverId: "omz-server",
    version: "1.0.0",
    protocolVersion: 1,
    authRequired: true,
    workspaces: [{ path: "/w" }],
    compatibility: { schemaVersion: 1, productVersion: "1.0.0", minCompatibleVersion: "1.0.0" },
    identity: { osUser: "root", hostname: "h" },
    capabilities: { desktopContinuous: true, websocketRpc: true, processResourceTelemetry: true },
  });
  assert.equal(info.capabilities.processResourceTelemetry, true);
  assert.throws(() =>
    serverRemoteInfoOutputSchema.parse({
      serverId: "omz-server",
      version: "1.0.0",
      protocolVersion: 1,
      authRequired: true,
      workspaces: [],
      capabilities: { desktopContinuous: true, websocketRpc: true },
      leak: 1,
    }),
  );
});
