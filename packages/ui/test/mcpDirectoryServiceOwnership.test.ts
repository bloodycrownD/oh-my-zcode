/**
 * MCP 目录服务槽位所有权（backlog-sweep 设备面修复）。
 *
 * 缺陷：设置页覆盖期间 workspace 壳层仍常驻（RootWorkspaceContent 只把设置页叠在上面），
 * App 的 useEnsureWorkspaceMcpLoaded 会随 rpcReady / 服务变化重跑。槽位若只是一个模块级
 * 变量、cleanup 无条件置 null，端口面板卸载 / 切换分区时就会把 App 的登记一起抹掉；而
 * App hook 依赖未变不会重跑，槽位此后恒为 null，远端 workspace 的 MCP 增删 / 启停经
 * mcpStore.resolveMcpDirectoryService 回落到本机 platform.saveMcpToUserDirectory。
 *
 * 锁住的行为（claim/release 所有权登记）：
 *   T-MCP-DIR1 — 端口面板卸载只释放自己的令牌，App 持有者仍然有效；
 *   T-MCP-DIR2 — App 先释放时端口保持权威，端口再释放后槽位归零；
 *   T-MCP-DIR3 — 端口先释放时回落到 App 最新登记，App 再释放后槽位归零；
 *   T-MCP-DIR4 — 同一 owner 重复 claim 只占一个名额，重复 release 幂等；
 *   T-MCP-DIR5 — 多个端口实例按最近 claim 接管，释放后回退到仍挂载的实例；
 *   T-MCP-DIR6 — 全部释放后远端写入回落到本机 platform 保存，重新 claim 后改走目录服务。
 *
 * 运行：npx tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/mcpDirectoryServiceOwnership.test.ts
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SaveCliMcpToUserDirectoryRequest } from "@zcode/shared";

const {
  claimMcpStoreDirectoryService,
  getMcpStoreDirectoryService,
  releaseMcpStoreDirectoryService,
  setMcpStorePlatform,
  useMcpStore,
} = (await import("../src/store/mcpStore.js")) as typeof import("../src/store/mcpStore.js");

type McpDirectoryService = Parameters<typeof claimMcpStoreDirectoryService>[1];
type McpDirectoryServiceOwnerKind = NonNullable<
  Parameters<typeof claimMcpStoreDirectoryService>[2]
>;

// 测试里保持 claim/release 对称的短名，便于逐条核对持有者生命周期。
const release = releaseMcpStoreDirectoryService;

const claimedOwners: object[] = [];

function claim(
  owner: object,
  directoryService: McpDirectoryService,
  kind: McpDirectoryServiceOwnerKind = "workspace",
): void {
  claimedOwners.push(owner);
  claimMcpStoreDirectoryService(owner, directoryService, kind);
}

const service = (tag: string) => ({ tag }) as unknown as McpDirectoryService;

afterEach(() => {
  for (const owner of claimedOwners.splice(0)) {
    releaseMcpStoreDirectoryService(owner);
  }
  setMcpStorePlatform(null);
  useMcpStore.setState({
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    nativeServers: [],
    servers: [],
  });
});

test("T-MCP-DIR1 端口面板卸载后 App 持有者仍有效", () => {
  const appOwner = {};
  const portOwner = {};
  const workspace = service("workspace");
  const port = service("port");

  claim(appOwner, workspace, "workspace");
  claim(portOwner, port, "source-port");
  assert.equal(getMcpStoreDirectoryService(), port, "端口持有期间必须是权威读写面");

  // App hook 因 rpcReady / 服务变化重跑：只换自己的令牌，不能抢走端口的权威面。
  const workspaceNext = service("workspace-next");
  release(appOwner);
  claim(appOwner, workspaceNext, "workspace");
  assert.equal(getMcpStoreDirectoryService(), port, "App 重跑 claim 不能覆盖端口持有者");

  // 端口面板卸载 / 切回 workspace scope：只释放端口令牌，App 的登记仍在。
  release(portOwner);
  assert.equal(
    getMcpStoreDirectoryService(),
    workspaceNext,
    "面板卸载后 App 当前持有者必须仍然有效",
  );

  release(appOwner);
  assert.equal(getMcpStoreDirectoryService(), null);
});

test("T-MCP-DIR2 App 先释放时端口保持权威，端口释放后归零", () => {
  const appOwner = {};
  const portOwner = {};
  const port = service("port");

  claim(appOwner, service("workspace"), "workspace");
  claim(portOwner, port, "source-port");

  release(appOwner);
  assert.equal(getMcpStoreDirectoryService(), port, "App 释放不得影响仍在挂载的端口面板");

  release(portOwner);
  assert.equal(getMcpStoreDirectoryService(), null, "全部持有者释放后槽位才归零");
});

test("T-MCP-DIR3 端口先释放时回落到 App 最新登记，App 再释放后归零", () => {
  const appOwner = {};
  const portOwner = {};
  const workspace = service("workspace");
  const port = service("port");

  claim(appOwner, workspace, "workspace");
  claim(portOwner, port, "source-port");

  release(portOwner);
  assert.equal(
    getMcpStoreDirectoryService(),
    workspace,
    "端口释放后必须回到 App 当前登记，而不是 null 或进入端口前的旧值",
  );

  // App 重跑续期：槽位跟着新登记走。
  const workspaceNext = service("workspace-next");
  release(appOwner);
  claim(appOwner, workspaceNext, "workspace");
  assert.equal(getMcpStoreDirectoryService(), workspaceNext);

  release(appOwner);
  assert.equal(getMcpStoreDirectoryService(), null);
});

test("T-MCP-DIR4 同一 owner 重复 claim 只占一个名额，重复 release 幂等", () => {
  const appOwner = {};
  const portOwner = {};
  const workspace = service("workspace");
  const port = service("port");

  claim(appOwner, service("workspace-old"), "workspace");
  claim(appOwner, workspace, "workspace");
  assert.equal(getMcpStoreDirectoryService(), workspace, "重复 claim 视为续期");

  claim(portOwner, port, "source-port");
  release(appOwner);
  release(appOwner);
  assert.equal(
    getMcpStoreDirectoryService(),
    port,
    "重复 release 不能把仍持有登记的端口一起清掉",
  );

  release(portOwner);
  assert.equal(getMcpStoreDirectoryService(), null);
});

test("T-MCP-DIR5 多个端口实例按最近 claim 接管，释放后回退到仍挂载的实例", () => {
  const ownerA = {};
  const ownerB = {};
  const portA = service("port-a");
  const portB = service("port-b");

  claim(ownerA, portA, "source-port");
  claim(ownerB, portB, "source-port");
  assert.equal(getMcpStoreDirectoryService(), portB, "后登记的端口实例接管槽位");

  release(ownerA);
  assert.equal(getMcpStoreDirectoryService(), portB, "释放旧实例不得影响仍挂载的实例");

  release(ownerB);
  assert.equal(getMcpStoreDirectoryService(), null);
});

test("T-MCP-DIR6 全部释放后回落本机 platform 保存，重新 claim 后走目录服务", async () => {
  const platformSaves: SaveCliMcpToUserDirectoryRequest[] = [];
  setMcpStorePlatform({
    loadMcpFromUserDirectory: async () => ({ servers: [] }),
    saveMcpToUserDirectory: async (payload) => {
      platformSaves.push(payload);
      return { success: true };
    },
    migrateLegacyCommonMcp: async () => ({
      servers: {},
      totalCount: 0,
      importedCount: 0,
      skippedCount: 0,
    }),
  });
  useMcpStore.setState({
    currentProjectPath: "",
    currentWorkspaceIdentity: "remote-device/workspace",
  });

  // 登记表归零后远端 identity 也拿不到目录服务，mcpStore 按既有语义回落到本机
  // platform 写入路径（这正是 bug 的落点；只有确实无人持有时才允许发生）。
  assert.equal(getMcpStoreDirectoryService(), null);
  await useMcpStore.getState().addScopedMcpServer("zcodeagentmcp", "local-fallback", {
    command: "echo",
  });
  assert.equal(platformSaves.length, 1, "无持有者时必须走本机 platform 保存");
  assert.equal(platformSaves[0]?.name, "local-fallback");

  const portSaves: SaveCliMcpToUserDirectoryRequest[] = [];
  const portOwner = {};
  claim(
    portOwner,
    {
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async (payload) => {
        portSaves.push(payload);
      },
    },
    "source-port",
  );
  await useMcpStore.getState().addScopedMcpServer("zcodeagentmcp", "port-routed", {
    command: "echo",
  });
  assert.equal(platformSaves.length, 1, "有端口持有者时不得再落到本机 platform");
  assert.equal(portSaves.length, 1, "有端口持有者时必须走端口目录服务");
  assert.equal(portSaves[0]?.name, "port-routed");
});
