/**
 * T-RU3（upstream-v316-fullsync §phase-remote-ux Step 19a）：远端投影/意图控制器/
 * 连接展示分类纯逻辑。
 *
 * 形态与 T-VU 系一致：无 jsdom，纯逻辑用例可直接
 * tsx --tsconfig packages/ui/tsconfig.json --test 运行；亦挂 test:v4-perf 链。
 * ①controller：显式 intent 分发到对应 owner；open-conversation 拒绝（项目必需）；
 *   非 user-close 关闭来源拒绝。
 * ②projection：设备状态×项目历史×attachment 三方联接；同路径不同 identity 隔离；
 *   本地 tab 只进 executionContexts；无 attachment fact 不冒充 ready。
 * ③presentation：错误码→展示分类/主行动矩阵（daemon 分支安装/升级/身份确认/迁移冲突族）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import { createRemoteWorkspaceController } from "../src/remote/remoteWorkspaceController.js";
import { buildRemoteWorkspaceProjection } from "../src/remote/remoteWorkspaceProjection.js";
import { classifyRemoteConnectionError } from "../src/lib/remoteConnectionPresentationErrors.js";
import { resolveRemoteConnectionPresentation } from "../src/lib/remoteConnectionPresentation.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

function createSnapshot(): SourceServerManagementSnapshot {
  return {
    generation: 3,
    servers: [
      {
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        displayName: "Dev Linux",
        osUser: "dev",
        installState: "installed",
        declaredWorkspaces: [],
      },
    ],
    profiles: [
      {
        profileId: "22222222-2222-4222-8222-222222222222",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        transport: "ssh",
        target: { kind: "ssh", host: "linux-amd64-dev", username: "dev" },
        createdAt: 1,
        lifecycleState: "active",
      },
    ],
    states: [
      {
        profileId: "22222222-2222-4222-8222-222222222222",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        state: "online",
        updatedAt: 3,
      },
    ],
    workspaceHistory: [
      {
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        profileId: "22222222-2222-4222-8222-222222222222",
        workspacePath: "/workspace/project",
        workspaceIdentity: "remote:server:11111111-1111-4111-8111-111111111111:/workspace/project",
        lastOpenedAt: 2,
      },
    ],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

function tab(
  partial: Partial<WorkspaceTabState> & Pick<WorkspaceTabState, "id">,
): WorkspaceTabState {
  return {
    kind: "workspace",
    workspacePath: "/workspace/project",
    workspacePurpose: "project",
    label: "project",
    ...partial,
  } as WorkspaceTabState;
}

test("T-RU3: controller 把显式 intent 分发给对应 owner，open-conversation 一律拒绝", async () => {
  const calls: string[] = [];
  const controller = createRemoteWorkspaceController({
    connectDevice: async (profileId, effect) => {
      calls.push(`connect-device:${profileId}:${effect}`);
    },
    disconnectDevice: async (sourceServerId) => {
      calls.push(`disconnect-device:${sourceServerId}`);
    },
    openConversation: async () => {
      calls.push("open-conversation");
    },
    openProject: async () => {
      calls.push("open-project");
    },
    reconnectWorkspace: async (workspaceKey) => {
      calls.push(`reconnect-workspace:${workspaceKey}`);
    },
    closeWorkspace: async (workspaceKey) => {
      calls.push(`close-workspace:${workspaceKey}`);
    },
  });
  await controller.dispatch({
    type: "connect-device",
    profileId: "profile-1",
    effect: "select-project",
  });
  await controller.dispatch({ type: "disconnect-device", sourceServerId: "server-1" });
  await assert.rejects(
    controller.dispatch({
      type: "open-conversation",
      sourceServerId: "server-1",
      remoteSessionId: "s1",
    }),
    /project\.remote-project-required/,
    "旧回调不能绕过项目创建（拒绝前不产生连接或目录副作用）",
  );
  await controller.dispatch({
    type: "open-project",
    sourceServerId: "server-1",
    path: "/workspace/project",
  });
  await controller.dispatch({
    type: "reconnect-workspace",
    workspaceKey: "remote:server:server-1:/w",
  });
  await controller.dispatch({
    type: "close-workspace",
    workspaceKey: "remote:server:server-1:/w",
    origin: "user-close",
  });
  assert.deepEqual(calls, [
    "connect-device:profile-1:select-project",
    "disconnect-device:server-1",
    "open-project",
    "reconnect-workspace:remote:server:server-1:/w",
    "close-workspace:remote:server:server-1:/w",
  ]);
  await assert.rejects(
    controller.dispatch({
      type: "close-workspace",
      workspaceKey: "k",
      origin: "restore" as never,
    }),
    /user-close/,
  );
});

test("T-RU3: projection 联接设备状态/历史/attachment；在线不冒充 ready；本地 tab 不进 openWorkspaces", () => {
  const projection = buildRemoteWorkspaceProjection({
    managementSnapshot: createSnapshot(),
    tabs: [
      tab({
        id: "conversation",
        workspacePath: "/workspace/conversation",
        workspaceIdentity:
          "remote:server:11111111-1111-4111-8111-111111111111:/workspace/conversation",
        workspacePurpose: "conversation",
        remoteSessionId: "session-conversation",
      }),
      tab({
        id: "project",
        workspacePath: "/workspace/project",
        workspaceIdentity: "remote:server:11111111-1111-4111-8111-111111111111:/workspace/project",
      }),
    ],
    attachments: [
      {
        remoteSessionId: "session-conversation",
        workspaceKey: "remote:server:11111111-1111-4111-8111-111111111111:/workspace/conversation",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        state: "ready",
      },
    ],
  });
  assert.equal(projection.devices.length, 1);
  assert.equal(projection.devices[0]?.aggregatedStatus, "online");
  assert.deepEqual(
    projection.openWorkspaces.map((item) => [item.workspacePath, item.attachmentState]),
    [
      ["/workspace/conversation", "ready"],
      ["/workspace/project", "disconnected"],
    ],
  );
  assert.deepEqual(
    projection.projectHistory.map((entry) => entry.workspacePath),
    ["/workspace/project"],
  );
});

test("T-RU3: projection 同路径不同 identity 互相隔离；本地 tab 只留在 executionContexts", () => {
  const snapshot = createSnapshot();
  snapshot.workspaceHistory = [
    ...snapshot.workspaceHistory,
    {
      sourceServerId: "11111111-1111-4111-8111-111111111111",
      profileId: "22222222-2222-4222-8222-222222222222",
      workspacePath: "/workspace/shared",
      workspaceIdentity: "remote:server:other:/workspace/shared",
      lastOpenedAt: 4,
    },
  ];
  const projection = buildRemoteWorkspaceProjection({
    managementSnapshot: snapshot,
    tabs: [
      tab({
        id: "remote-a",
        workspacePath: "/workspace/shared",
        workspaceIdentity: "remote:server:source-a:/workspace/shared",
      }),
      tab({
        id: "remote-b",
        workspacePath: "/workspace/shared",
        workspaceIdentity: "remote:server:source-b:/workspace/shared",
        workspacePurpose: "conversation",
      }),
    ],
  });
  assert.equal(projection.openWorkspaces.length, 2);
  assert.deepEqual(
    new Set(projection.openWorkspaces.map((item) => item.workspaceKey)),
    new Set([
      "remote:server:source-a:/workspace/shared",
      "remote:server:source-b:/workspace/shared",
    ]),
  );
  const localOnly = buildRemoteWorkspaceProjection({
    tabs: [
      tab({ id: "local", workspacePath: "/local/project" }),
      tab({
        id: "remote",
        workspacePath: "/remote/project",
        workspaceIdentity: "remote:server:11111111-1111-4111-8111-111111111111:/remote/project",
      }),
    ],
  });
  assert.deepEqual(
    localOnly.openWorkspaces.map((item) => item.workspacePath),
    ["/remote/project"],
  );
  assert.deepEqual(
    localOnly.executionContexts.map((item) => [item.kind, item.workspacePath]),
    [
      ["local", "/local/project"],
      ["remote", "/remote/project"],
    ],
  );
  assert.equal(localOnly.executionContexts[0]?.attachmentState, undefined);
});

test("T-RU3: presentation 错误分类矩阵——daemon 安装/升级/身份/迁移冲突映射主行动", () => {
  assert.equal(
    classifyRemoteConnectionError({ errorCode: "source-server-install-required" }).primaryAction,
    "install",
  );
  assert.equal(
    classifyRemoteConnectionError({
      errorCode: "source-server-upgrade-required",
      upgradeTarget: "controller",
    }).primaryAction,
    "update-desktop",
  );
  assert.equal(
    classifyRemoteConnectionError({
      errorCode: "source-server-upgrade-required",
      upgradeTarget: "server",
    }).primaryAction,
    "update-server",
  );
  assert.equal(
    classifyRemoteConnectionError({ errorCode: "source-server-identity-change-pending" })
      .primaryAction,
    "confirm-identity",
  );
  assert.equal(
    classifyRemoteConnectionError({
      errorCode: "workspace-task-identity-conflict",
    }).titleId,
    "remote.error.workspaceTaskIdentityConflict",
  );
  const auth = classifyRemoteConnectionError({ errorCode: "remote-authentication-failed" });
  assert.equal(auth.primaryAction, "edit-auth");
  assert.equal(auth.titleId, "remote.error.authentication");
  assert.equal(
    classifyRemoteConnectionError({ errorCode: "credentials-required" }).primaryAction,
    "credentials",
  );
  // 无码但消息命中认证失败语义 → 认证分类（旧传输层兼容面）。
  assert.equal(
    classifyRemoteConnectionError({ error: "all configured authentication methods failed" })
      .primaryAction,
    "edit-auth",
  );
});

test("T-RU3: presentation 状态机——用户主动断开不被残留错误染成失败", () => {
  const userDisconnected = resolveRemoteConnectionPresentation({
    state: "failed",
    errorCode: "remote-connection-unknown",
    disconnectOrigin: "user",
  });
  assert.equal(userDisconnected.status, "offline");
  assert.equal(userDisconnected.primaryAction, "connect");
  const recovering = resolveRemoteConnectionPresentation({
    state: "retrying",
    recoveryAttempt: 2,
    recoveryLimit: 3,
  });
  assert.equal(recovering.status, "connecting");
  assert.deepEqual(recovering.recovery?.values, { attempt: 2, limit: 3 });
  const needsInstall = resolveRemoteConnectionPresentation({ installState: "uninstalled" });
  assert.equal(needsInstall.status, "pending");
  assert.equal(needsInstall.primaryAction, "install");
  const online = resolveRemoteConnectionPresentation({ state: "online", attached: true });
  assert.equal(online.status, "online");
  assert.equal(online.primaryAction, "disconnect");
});
