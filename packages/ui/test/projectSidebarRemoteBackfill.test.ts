/**
 * T-RU10（upstream-v316-fullsync P7 末批）：Remote* 回填与占位拆除守卫。
 *
 * 形态：源码形状守卫 + 纯逻辑单测，npx tsx --tsconfig packages/ui/tsconfig.json --test 运行。
 * ①回填文件清单在位（7 组件 + useProjectRemoteSync + 依赖层）；
 * ②消费链接线：index（sync/diagnostics/remoteHost/deviceLabel/dialog）、
 *   ProjectSidebarNode（connect/onRemoveEntry）、ProjectNodeContent（slot→真组件）、
 *   useProjectTaskNavigation（attachRemoteProjectWorkspace 真链）；
 * ③host 注册链：Local Host services.register + client RemoteServiceAccess getter；
 * ④挂账面注释在位（P3 entries / P9 management / 拍板 A 向导壳）；
 * ⑤纯逻辑：getWorkspaceSourceServerId / resolveRemoteOperationProgress / remoteHostLabel；
 * ⑥i18n 新键 zh/en 成对 + styles.css remote token 四主题段。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");

// ---------- ① 回填清单 ----------

test("回填文件清单在位（Remote* 7 组件 + 同步链 + 依赖层）", () => {
  const files = [
    "packages/ui/src/project-sidebar/RemoteProjectList.tsx",
    "packages/ui/src/project-sidebar/RemoteProjectMenu.tsx",
    "packages/ui/src/project-sidebar/RemoteProjectPicker.tsx",
    "packages/ui/src/project-sidebar/RemoteHostSection.tsx",
    "packages/ui/src/project-sidebar/RemoteIdentityHoverCard.tsx",
    "packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx",
    "packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx",
    "packages/ui/src/project-sidebar/useProjectRemoteSync.tsx",
    "packages/ui/src/project-sidebar/useRemoteProjectConnectionPresentation.ts",
    "packages/ui/src/project-sidebar/OfflineRemoteProjectRows.tsx",
    "packages/ui/src/project-sidebar/remote-navigation.ts",
    "packages/ui/src/remote-connection/RemoteConnectionStateIcon.tsx",
    "packages/ui/src/remote-connection/RemoteConnectionTags.tsx",
    "packages/ui/src/remote-connection/remoteOperationProgress.ts",
    "packages/ui/src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx",
    "packages/ui/src/conversation-workspace-target/sourceIdentity.ts",
    "packages/ui/src/hooks/useSourceServerStatuses.ts",
    "packages/ui/src/hooks/RemoteProjectPresentationContext.tsx",
    "packages/ui/src/hooks/useSourceServerOperationLogs.ts",
  ];
  for (const file of files) assert.ok(read(root, file).length > 0, `${file} 必须在位`);
});

// ---------- ② 消费链接线 ----------

test("index：remoteSync/diagnostics/remoteHost/deviceLabel/dialog 接线，remoteActions 占位拆除", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "index.tsx");
  assert.match(source, /const remoteSync = useProjectRemoteSync\(directory\);/);
  assert.match(source, /const diagnostics = useProjectConnectionDiagnostics\(directory, props\);/);
  assert.match(source, /useProjectTaskNavigation\(props, tree, remoteService\)/);
  assert.match(source, /deviceNames\.get\(projectSourceServerId\(project\)/);
  assert.match(
    source,
    /remoteHost=\{directory\.hosts\.find\(\(host\) => host\.id === project\.hostId\)\}/,
  );
  assert.match(source, /remoteActions=\{remoteSync\.actions\}/);
  assert.match(source, /\{remoteSync\.dialog\}/);
  assert.doesNotMatch(source, /remoteActions=\{\(\) => \[\]\}/, "remoteActions 恒空占位必须已拆除");
});

test("ProjectSidebarNode：connect 动作与 onRemoveEntry 接真", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "ProjectSidebarNode.tsx");
  assert.match(source, /import \{ Plug \} from "lucide-react";/);
  assert.match(source, /remoteService!\.connectHost\(project\.hostId\)/);
  assert.match(source, /onReconnectRemoteWorkspace\(\s*buildRemoteHostWorkspaceIdentity\(/);
  assert.match(source, /await remoteService\.removeEntry\(entryId\);/);
  // backlog-sweep Step 10（p9-nav）已把「设备设置」挂账换成真动作：设置页 remoteDevices
  // 分区 + Source 定位意图；Step 9 的面板/跳转消费面在同一批落地，故此处断言真实接线。
  assert.match(
    source,
    /setPendingSettingsSectionIntent\("remoteDevices", \{ sourceServerId \}\)/,
    "设备设置入口必须直达 remoteDevices 分区并带 Source 定位",
  );
});

test("ProjectNodeContent：RemoteIdentityHoverCardSlot 拆除换真组件", () => {
  const source = read(root, "packages", "ui", "src", "project-sidebar", "ProjectNodeContent.tsx");
  assert.doesNotMatch(source, /RemoteIdentityHoverCardSlot/, "slot 占位必须已拆除");
  assert.match(source, /<RemoteIdentityHoverCard/);
  assert.match(source, /connectionError=\{diagnostics\?\.error\}/);
});

test("useProjectTaskNavigation：attachRemoteProjectWorkspace 真绑定链", () => {
  const source = read(
    root,
    "packages",
    "ui",
    "src",
    "project-sidebar",
    "useProjectTaskNavigation.ts",
  );
  assert.match(source, /import \{ attachRemoteProjectWorkspace \}/);
  assert.match(source, /remoteSessionId = await attachRemoteProjectWorkspace\(/);
  assert.doesNotMatch(source, /远端绑定链缺席/, "P4 缺席占位注释必须已拆除");
});

test("ProjectDirectoryProvider：deviceNames 改 directory.hosts 投影", () => {
  const source = read(
    root,
    "packages",
    "ui",
    "src",
    "project-sidebar",
    "ProjectDirectoryProvider.tsx",
  );
  assert.match(source, /remoteHostLabel\(host\)/);
  assert.doesNotMatch(source, /deviceNames: new Map<string, string>\(\)/, "恒空表必须退役");
});

// ---------- ③ host 注册链 ----------

test("host 注册链：Local Host services.register + client getter + accessor 缺席降级注释", () => {
  const host = read(root, "packages", "desktop", "src", "host", "index.ts");
  // backlog-sweep Step 2：入口持久化唯一写入者切到 SQLite createRemoteProjectService，
  // 由 createLocalServices 注册；desktop host 只注入连接器与跨 Host 路由，directory 投影服务已删除。
  assert.doesNotMatch(
    host,
    /createDirectoryRemoteProjectService/,
    "P7 末批的 directory 投影服务必须退役（数据所有者裁定 §1）",
  );
  assert.match(
    host,
    /remoteProjectConnection: \{\s*connectHost: connectRemoteProjectHost,\s*readConnectionStates: readRemoteProjectConnectionStates,/,
    "Local Host 必须注入 remote-projects 连接器（connectHost/readConnectionStates）",
  );
  assert.match(
    host,
    /resolveProjectHostService,\n/,
    "跨 Host 项目路由必须注入 createLocalServices",
  );
  const services = read(root, "packages", "services", "src", "node.ts");
  assert.match(
    services,
    /\.register\(IRemoteProjectService, remoteProjectService\)/,
    "SQLite 入口服务由 createLocalServices 注册（hosts/entries 唯一写入者）",
  );
  assert.match(
    services,
    /afterChange: publishProjectChange/,
    "缺 afterChange 则 state:projects 不广播",
  );
  const access = read(root, "packages", "client", "src", "remoteServiceAccess.ts");
  assert.match(access, /readonly remoteProjectService: IRemoteProjectService;/);
  assert.match(access, /channelClient\.getChannel\(IRemoteProjectService\.channelName\),/);
  const remoteProjects = read(root, "packages", "services", "src", "remote-projects", "index.ts");
  assert.match(remoteProjects, /omz 漂移/, "server 直连目标裁剪必须登记在实现处");
});

// ---------- ④ 挂账面 ----------

test("拍板 A/P9 挂账面注释在位（不静默裁剪）", () => {
  // backlog-sweep Step 9：management 消费缝已切换为真实数据源（恒空 stub 退役），
  // 这里改为断言「真实接线的形状」——registry 数据源 + 上游服务签名。
  const statuses = read(root, "packages", "ui", "src", "hooks", "useSourceServerStatuses.ts");
  assert.match(
    statuses,
    /getSourceServerStatusRegistry\(management\)/,
    "useSourceServerStatuses 必须接 management 数据源（registry）",
  );
  assert.match(
    statuses,
    /sourceServerManagementService/,
    "management 服务来自 useBaseWorkspaceServices().sourceServerManagementService",
  );
  assert.doesNotMatch(
    statuses,
    /subscribeToNothing, getEmptyStatuses, getEmptyStatuses/,
    "恒空 stub 不能继续作为返回面（management 在位时必须订阅 registry）",
  );
  const progressSection = read(
    root,
    "packages",
    "ui",
    "src",
    "project-sidebar",
    "RemoteConnectionProgressSection.tsx",
  );
  assert.doesNotMatch(
    progressSection,
    /managementEnabled = false/,
    "management 缝已在位（Step 7-9），不能再保留恒假闸门",
  );
  assert.match(
    progressSection,
    /logsByProfileId\[profileId\]/,
    "连接中阶段进度必须投影真实操作日志",
  );
  // backlog-sweep Step 4：Picker 挂账已清（真链落 Root），注释改为透传形状断言。
  assert.match(
    read(root, "packages", "ui", "src", "project-sidebar", "RemoteProjectPicker.tsx"),
    /initialRoots=\{props\.initialRoots\}/,
    "创建表单必须拿到 initialRoots（否则不进创建态）",
  );
  assert.match(
    read(root, "packages", "ui", "src", "project-sidebar", "useProjectRemoteSync.tsx"),
    /desktop-continuous/,
  );
});

// ---------- ⑤ 纯逻辑 ----------

test("getWorkspaceSourceServerId：server identity 精确解析 + legacy alias 唯一命中", async () => {
  const { getWorkspaceSourceServerId } =
    await import("@/conversation-workspace-target/sourceIdentity.js");
  assert.equal(
    getWorkspaceSourceServerId({ workspacePath: "/w", workspaceIdentity: "remote:server:abc:/w" }),
    "abc",
  );
  assert.equal(
    getWorkspaceSourceServerId({ workspacePath: "/w", workspaceIdentity: "remote:ssh:h:22:u:/w" }),
    null,
    "非 server identity 不得冒充 Source 设备",
  );
  assert.equal(getWorkspaceSourceServerId({ workspacePath: "/w" }), null);
  const history = [
    {
      workspacePath: "/w",
      legacyWorkspaceIdentity: "remote:ssh:h:22:u:/w",
      sourceServerId: "srv1",
      profileId: "p",
      lastOpenedAt: 1,
    },
    {
      workspacePath: "/w",
      legacyWorkspaceIdentity: "remote:ssh:h:22:u:/w",
      sourceServerId: "srv2",
      profileId: "p",
      lastOpenedAt: 2,
    },
  ];
  assert.equal(
    getWorkspaceSourceServerId(
      { workspacePath: "/w", workspaceIdentity: "remote:ssh:h:22:u:/w" },
      { workspaceHistory: history },
    ),
    null,
    "歧义换代历史保持待识别",
  );
});

test("resolveRemoteOperationProgress：阶段投影与终态清零", async () => {
  const { resolveRemoteOperationProgress } =
    await import("@/remote-connection/remoteOperationProgress.js");
  const progress = resolveRemoteOperationProgress([
    { phase: "probe", timestamp: 10, level: "info" },
    { phase: "upload", progress: 0.42, timestamp: 20, level: "info" },
  ]);
  assert.equal(progress.total, 4);
  assert.equal(progress.titleId, "remote.phase.deploy");
  assert.equal(progress.percent, 42);
  assert.equal(progress.startedAt, 10);
  // 终态（ready/error 尾巴）=上一次操作已结束，按尚无日志展示。
  const ended = resolveRemoteOperationProgress([
    { phase: "upload", timestamp: 10, level: "info" },
    { phase: "ready", timestamp: 20, level: "info" },
  ]);
  assert.equal(ended.index, 0);
  assert.equal(ended.percent, undefined);
});

test("remoteHostLabel：ssh/docker/wsl 三形态展示标签", async () => {
  const { remoteHostLabel } = await import("@/project-sidebar/RemoteHostSection.js");
  assert.equal(
    remoteHostLabel({
      id: "x",
      membershipId: "m",
      kind: "ssh",
      target: { kind: "ssh", host: "h", username: "u" },
      position: 0,
    }),
    "u@h",
  );
  assert.equal(
    remoteHostLabel({
      id: "x",
      membershipId: "m",
      kind: "docker",
      target: { kind: "docker", container: "c" },
      position: 0,
    }),
    "c",
  );
  assert.equal(
    remoteHostLabel({
      id: "x",
      membershipId: "m",
      kind: "wsl",
      target: { kind: "wsl" },
      position: 0,
    }),
    "WSL",
  );
});

// ---------- ⑥ i18n 与主题 token ----------

test("i18n 新键 zh/en 成对（remote.progress/conversation/phase + settings.source）", () => {
  const keys = [
    "remote.progress.step",
    "remote.progress.elapsedSeconds",
    "remote.progress.elapsedMinutesSeconds",
    "remote.progress.copied",
    "remote.progress.copyError",
    "remote.conversation.unavailable",
    "remote.conversation.tasksContinue",
    "remote.conversation.reconnect",
    "remote.conversation.placeholder",
    "remote.conversation.draft",
    "settings.source.editConnectionTitle",
    "settings.source.connectionAddress",
    "remote.phase.channel",
    "remote.phase.identify",
    "remote.phase.deploy",
    "remote.phase.handshake",
  ];
  for (const locale of ["zh-CN.ts", "en-US.ts"]) {
    const source = read(root, "packages", "ui", "src", "i18n", "locales", locale);
    for (const key of keys) {
      assert.ok(source.includes(`"${key}":`), `${locale} 缺键 ${key}`);
    }
  }
});

test("styles.css：remote/progress token 四主题段在位", () => {
  const styles = read(root, "packages", "ui", "src", "styles.css");
  for (const token of [
    "--color-progress-surface:",
    "--color-remote-foreground-muted:",
    "--color-remote-ssh-surface:",
    "--color-remote-wsl-surface:",
    "--color-remote-docker-surface:",
  ]) {
    assert.equal(styles.split(token).length - 1, 4, `${token} 必须在四个主题段各出现一次`);
  }
});
