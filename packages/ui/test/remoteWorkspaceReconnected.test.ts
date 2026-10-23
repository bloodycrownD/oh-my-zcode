/**
 * T-RU4（upstream-v316-fullsync §phase-remote-ux Step 19a）：恢复换代通知链形状守卫。
 *
 * RemoteWorkspaceReconnected 链路横跨 shared 协议/host/main/preload/renderer 五层，
 * 断一环就会让 Renderer 持旧 sessionId 悬空（cr-func-r3b 三期承接核对①）。这里用源码
 * 形状断言锁死各层接线（与 T-VU3/T-VU4 同形态，无 jsdom）。
 *
 * 形态：worktree 根 `npx tsx --tsconfig packages/ui/tsconfig.json --test`；
 * 亦挂 test:v4-perf 链。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("T-RU4: 协议面——RemoteWorkspaceReconnected 三层声明齐备且入 schema union", () => {
  const channels = readRepoFile("packages/shared/src/channels.ts");
  assert.match(channels, /RemoteWorkspaceReconnected: "remote-workspace-reconnected"/);
  assert.match(channels, /RemoteSessionReconnected: "zcode:remote-session-reconnected"/);
  assert.match(
    channels,
    /\[PlatformChannels\.RemoteSessionReconnected\]: \{\s*request: RemoteSessionReconnectedEvent;/,
  );
  const platform = readRepoFile("packages/shared/src/platform.ts");
  assert.match(platform, /interface RemoteSessionReconnectedEvent \{/);
  assert.match(platform, /onRemoteSessionReconnected\?/);
  const validation = readRepoFile("packages/shared/src/validation.ts");
  assert.match(validation, /hostRemoteWorkspaceReconnectedResponseSchema = z/);
  assert.match(
    validation,
    /hostRemoteWorkspaceClosedResponseSchema,\s*\n\s*hostRemoteWorkspaceReconnectedResponseSchema,/,
  );
});

test("T-RU4: host——恢复换代 commit 后必发 RemoteWorkspaceReconnected", () => {
  const host = readRepoFile("packages/desktop/src/host/index.ts");
  const notifiedAt = host.indexOf("type: HostResponseTypes.RemoteWorkspaceReconnected");
  assert.ok(notifiedAt > 0, "host 必须发布换代通知");
  // 通知必须落在 commit() 之后：Controller 投影未换代前不得让 Renderer 换绑。
  const commitGuard = host.indexOf("Source 重连换代在 Controller 提交后失去 Registry owner");
  assert.ok(commitGuard > 0 && commitGuard < notifiedAt, "通知必须晚于 Registry commit");
  assert.match(host, /previousRemoteSessionId: previous\.remoteSessionId/);
});

test("T-RU4: main——换代后重挂路由并广播 Renderer；旧 route 缺席时回收新 session", () => {
  const main = readRepoFile("packages/desktop/src/main/desktopRemoteSessions.ts");
  assert.match(main, /function handleReconnected\(/);
  assert.match(
    main,
    /HostResponseTypes\.RemoteWorkspaceReconnected\)\s*\{\s*\n\s*handleReconnected\(/,
  );
  assert.match(main, /routesBySessionId\.delete\(previousRemoteSessionId\)/);
  assert.match(main, /routesBySessionId\.set\(descriptor\.remoteSessionId, route\)/);
  assert.match(main, /attachRendererPort\(win, route, "source-server-reconnected"\)/);
  assert.match(main, /PlatformChannels\.RemoteSessionReconnected,/);
  // Provider Provisioning lane 换代重登记（上游 Bug 修复语义）。
  assert.match(main, /\[provider-provisioning\] Environment resync after reconnect/);
  assert.match(
    main,
    /DisposeRemoteWorkspaceSession,\s*\n\s*requestId: randomUUID\(\),\s*\n\s*remoteSessionId: descriptor\.remoteSessionId/,
  );
});

test("T-RU4: renderer——preload/platform/UI 换绑链齐备；旧 sessionId 注册被清理", () => {
  const preload = readRepoFile("packages/desktop/src/preload/index.ts");
  assert.match(preload, /onRemoteSessionReconnected:/);
  assert.match(preload, /PlatformChannels\.RemoteSessionReconnected/);
  const desktopPlatform = readRepoFile("packages/desktop/src/renderer/src/desktopPlatform.ts");
  assert.match(desktopPlatform, /window\.zcode\.onRemoteSessionReconnected\?\.\(handler\)/);
  const history = readRepoFile("packages/ui/src/root/useRemoteWorkspaceHistory.ts");
  assert.match(history, /handleRemoteWorkspaceSessionReconnected/);
  assert.match(history, /unregisterRemoteWorkspaceSession\(event\.previousSessionId\)/);
  assert.match(
    history,
    /bindRemoteWorkspaceIdentity\(event\.workspaceIdentity, event\.sessionId\)/,
  );
  assert.match(history, /remoteSessionId: event\.sessionId/);
});
