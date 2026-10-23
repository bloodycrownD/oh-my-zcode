/**
 * T-RU7（upstream-v316-fullsync P7 续批）：主链切换路由断言与 identity 绑定回执形状守卫。
 *
 * 形态：无 jsdom，源码形状守卫 + 契约断言，可直接 node --import tsx --test 运行。
 * ①Renderer ConnectRemoteWorkspace 主链 = daemon 分支（early-return 先于 deployServer 体）；
 * ②deployServer 旧链共存零删除：setupRemoteConnection 函数体在位 + 环境开关回滚预案；
 * ③identity 绑定回执链五层：capabilities.bindWorkspaceIdentity → prepareWorkspaceIdentity
 *   第三参 → resolveWorkspace 通道（accessor 可选）→ daemon serve 换装 → wire seam 包装；
 * ④Directory admission：Manager 注入 recordHandshake + membershipIntent 透传；
 * ⑤旧链兼容：legacy RPC 断言保持 19 通道，窗口集合条件注册（缺席不造坏 proxy）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hostDir = path.join(root, "packages", "desktop", "src", "host");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");

// ---------- ①② 主链切换路由 ----------

test("createWindowRemoteConnectionHandle：daemon 主链 early-return 先于 deployServer 体", () => {
  const source = read(hostDir, "index.ts");
  const fnStart = source.indexOf("async function createWindowRemoteConnectionHandle");
  assert.ok(fnStart > 0, "入口函数必须在位");
  const setupCall = source.indexOf("await setupRemoteConnection(", fnStart);
  const mainChain = source.indexOf("connectManagedSourceServerHandle", fnStart);
  assert.ok(mainChain > fnStart, "主链调用必须在入口函数体内");
  assert.ok(
    setupCall > mainChain,
    "deployServer 体必须位于主链 early-return 之后（不再被新调用点触达）",
  );
  assert.match(
    source.slice(fnStart, setupCall),
    /ZCODE_REMOTE_DEPLOY_SERVER_LEGACY/,
    "旧链回滚预案（环境开关）必须登记在主链切换处",
  );
});

test("deployServer 旧链共存零删除：setupRemoteConnection 函数体与调用点在位", () => {
  const source = read(hostDir, "index.ts");
  assert.match(source, /async function setupRemoteConnection\(/, "旧链物理连接函数必须保留");
  assert.equal(
    source.split("setupRemoteConnection(").length - 1,
    2,
    "setupRemoteConnection 只允许定义+唯一（旧链保留的）调用点，不得新增调用",
  );
});

test("connectManagedSourceServerHandle：Profile 经 Directory.ensureProfile 产出，existing 入口按快照拒绝", () => {
  const source = read(hostDir, "index.ts");
  assert.match(
    source,
    /await connectSourceServerTarget\(directory, manager,/,
    "主链必须经 connectSourceServerTarget（Profile 落 Directory）",
  );
  assert.doesNotMatch(
    source,
    /buildSourceServerProfileKey/,
    "薄层内存 profileId 键已被 Directory profileId 取代，不得残留",
  );
  assert.match(
    source,
    /throw new WindowRemoteConnectionUnavailableError\(params\.existingSourceServerId\)/,
    "existingSourceServerId 缺快照/离线必须拒绝",
  );
});

// ---------- ③ identity 绑定回执链 ----------

test("capabilities 携带 bindWorkspaceIdentity 与 recordWorkspaceOpen；绑定经 resolveWorkspace 通道", () => {
  const source = read(hostDir, "index.ts");
  assert.match(source, /bindWorkspaceIdentity: async \(input\)/);
  assert.match(
    source,
    /managed\.services\.sourceServerWorkspaceService\?\.resolveWorkspace\(/,
    "绑定必须打 Source 端 resolveWorkspace 通道（可选缺席=旧 Source 降级跳过）",
  );
  assert.match(source, /resolveLegacyWorkspaceIdentity\(/, "legacy route hint 解析必须在场");
  assert.match(source, /recordWorkspaceOpen: async \(input\)/);
});

test("registry.prepareWorkspaceIdentity 透传第三参 bindWorkspaceIdentity", () => {
  const source = read(hostDir, "index.ts");
  assert.match(
    source,
    /prepareRemoteWorkspaceIdentity\(\s*handle\.services\.get\(IFileService\),\s*input,\s*handle\.capabilities\?\.bindWorkspaceIdentity,?\s*\)/,
  );
});

test("daemon serve 换装 createServerHostServices 且 http 包 identity wire seam", () => {
  const core = read(root, "packages", "zcode-server-cli", "src", "server-core", "core.ts");
  assert.match(core, /createServerHostServices\(\{/, "daemon serve 必须换装");
  assert.match(core, /migrationFailedPathCount/, "迁移失败计数必须接真值");
  assert.doesNotMatch(core, /migrationFailedPathCount: 0/, "一期恒 0 占位必须已拆除");
  const http = read(root, "packages", "zcode-server-cli", "src", "server-core", "http.ts");
  assert.match(
    http,
    /new SourceServerWorkspaceIdentityChannelServer\(loggingServer, workspaceIdentityMapper\)/,
    "通道装配必须包 identity 映射 seam",
  );
});

test("createServerHostServices：aliasRepo+mapper+resolveWorkspace 服务装配（omz 裁量登记）", () => {
  const node = read(root, "packages", "services", "src", "node.ts");
  assert.match(node, /export async function createServerHostServices/);
  assert.match(node, /new SourceServerWorkspaceAliasRepo\(\)/);
  assert.match(node, /new SourceServerWorkspaceIdentityMapper\(\)/);
  assert.match(node, /createSourceServerWorkspaceService\(workspaceAliasRepo,/);
  assert.match(
    node,
    /buildServerRemoteWorkspaceIdentity\(\{ serverId: options\.sourceServerId, workspacePath \}\)/,
    "stable identity 构造必须用统一工具",
  );
});

// ---------- ④ Directory admission ----------

test("Manager 注入 directory.recordHandshake 窄接口并在 connectOnce 落盘", () => {
  const manager = read(hostDir, "sourceServerConnectionManager.ts");
  assert.match(manager, /recordHandshake: SourceServerDirectory\["recordHandshake"\]/);
  assert.match(manager, /options\.onDiagnosticPhase\?\.\("directory-record"\)/);
  assert.match(
    manager,
    /handshakeResult\.identityChanged && options\.confirmIdentityChange !== true/,
    "持久 identityChanged 判定必须回到 identity-change-pending",
  );
  const host = read(hostDir, "index.ts");
  assert.match(
    host,
    /recordHandshake: \(\.\.\.args\) => ensureSourceServerDirectory\(\)\.recordHandshake\(\.\.\.args\)/,
    "Manager 工厂必须注入 Directory 窄接口",
  );
  assert.match(
    host,
    /membershipIntent: params\.membershipIntent,/,
    "membershipIntent 必须随 connect 链透传",
  );
});

// ---------- ⑤ 旧链兼容 ----------

test("legacy RPC 断言保持 19 通道；窗口集合条件注册 sourceServerWorkspaceService", () => {
  const legacy = read(hostDir, "legacyRemoteWorkspaceRpcContract.ts");
  const channelList = legacy.slice(
    legacy.indexOf("LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS"),
    legacy.indexOf("satisfies"),
  );
  assert.equal(
    (channelList.match(/",/g) ?? []).length,
    19,
    "旧链共存期断言不得纳入 sourceServerWorkspaceService（旧 backend 无此通道）",
  );
  const collection = read(hostDir, "remoteWorkspaceServiceCollection.ts");
  assert.match(
    collection,
    /if \(sourceServerWorkspaceService\) \{\s*services\.register\(ISourceServerWorkspaceService/,
    "通道缺席时不得注册坏 proxy",
  );
});

test("services accessor：sourceServerWorkspaceService 为可选字段（缺席降级面）", () => {
  const accessor = read(root, "packages", "services", "src", "accessor.ts");
  assert.match(accessor, /readonly sourceServerWorkspaceService\?: ISourceServerWorkspaceService;/);
});
