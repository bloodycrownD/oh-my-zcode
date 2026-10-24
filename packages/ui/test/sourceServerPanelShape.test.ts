/**
 * T-MG3（backlog-sweep Step 9 / P9-3）：设备管理面板族形状守卫 + 例外组件行为。
 *
 * 本仓无 jsdom（ui 测试只有 renderToStaticMarkup 与纯逻辑），故形态为
 * 「纯逻辑行为 + 源码形状断言」，与 projectSidebarP42 同款：
 * ①面板段注册：settingsPageConfig 的 remoteDevices 分区（桌面可见 / Web 不可见）+ SettingsPage 接线；
 * ②设备卡渲染分支：设备卡骨架、迁移报告折叠、更新活动、编辑连接弹窗；
 * ③例外真实范围：RemoteConnectionProgress(134L) 三导出 + resolveRemoteConnectionPhases 行为 +
 *   RemoteLinkRail 两函数 + sourceServerStatusRegistry 数据源行为；
 * ④消费缝切换：useSourceServerStatuses / RemoteConnectionProgressSection 不再有恒空 stub。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ISourceServerManagementService } from "@zcode/services";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(root, ...segments), "utf8");

// ---------- ① 面板段注册 ----------

test("T-MG3-1 设置分区注册：remoteDevices 仅桌面可见 + SettingsPage 真接线", async () => {
  const { createSettingsPageConfig, SETTINGS_SECTIONS } =
    await import("../src/settings/settingsPageConfig.js");
  const desktop = createSettingsPageConfig({ isDesktop: true });
  const remoteDevices = desktop.settingsSections.find((section) => section.id === "remoteDevices");
  assert.ok(remoteDevices, "桌面端设置分区必须包含 remoteDevices");
  assert.equal(remoteDevices.titleId, "settings.remoteDevicesTitle");
  assert.equal(remoteDevices.contentTitleId, "settings.remoteDevicesTitle");
  assert.equal(remoteDevices.groupId, "basics", "远程设备与浏览器同属基础设置组");
  assert.ok(
    desktop.settingsSectionGroups.some((group) =>
      group.sections.some((section) => section.id === "remoteDevices"),
    ),
    "分区必须落在某个可见分组里（否则导航不渲染）",
  );
  assert.equal(
    createSettingsPageConfig({}).settingsSections.some((section) => section.id === "remoteDevices"),
    false,
    "Web/无桌面能力视图不展示设备管理",
  );
  assert.equal(
    SETTINGS_SECTIONS.some((section) => section.id === "remoteDevices"),
    false,
    "默认只读配置代表 Web 视图，不能含设备管理",
  );

  const settingsPage = read("packages", "ui", "src", "SettingsPage.tsx");
  assert.match(
    settingsPage,
    /import \{ SourceServerManagementPanel \} from "@\/source-server-management\/SourceServerManagementPanel\.js";/,
    "SettingsPage 必须导入设备管理面板",
  );
  assert.match(settingsPage, /activeSection === "remoteDevices" \?/, "必须存在分区渲染分支");
  assert.match(
    settingsPage,
    /management=\{localHostServices\.sourceServerManagementService\}/,
    "management 服务必须来自本机 Host accessor（不能注入远端 Host）",
  );
  assert.match(
    settingsPage,
    /consumePendingSettingsSourceServerId\(\)/,
    "首次挂载必须消费 Source 定位意图（侧栏设备跳转）",
  );
  assert.match(
    settingsPage,
    /const \[targetSourceServerId, setTargetSourceServerId\] = useState<string \| undefined>/,
    "设备卡定位必须是页面级状态",
  );
});

// ---------- ② 设备卡渲染分支 ----------

test("T-MG3-2 面板设备卡分支：卡片骨架/连接行/项目行/迁移报告/更新活动/编辑弹窗", () => {
  const panel = read(
    "packages",
    "ui",
    "src",
    "source-server-management",
    "SourceServerManagementPanel.tsx",
  );
  assert.match(panel, /data-source-server-card=\{server\.sourceServerId\}/, "设备卡锚点");
  assert.match(panel, /data-device-connection/, "当前连接行");
  assert.match(panel, /data-device-projects/, "最近项目区");
  assert.match(panel, /data-device-project\b/, "项目行");
  assert.match(panel, /data-device-card-footer/, "卡片页脚（其他线路 / 最近日志）");
  assert.match(panel, /data-unfinished-connections/, "未完成连接折叠区");
  assert.match(panel, /<EditConnectionProfileDialog/, "编辑连接弹窗必须挂载");
  assert.match(panel, /<SourceServerMigrationReportPanel/, "迁移报告面板必须挂载");
  assert.match(panel, /<SourceServerUpdateActivity/, "更新活动必须挂载");
  assert.match(
    panel,
    /migrationCount\?\.status === "available" &&\s*migrationCount\.failedPathCount \+ migrationCount\.abandonedPathCount > 0/,
    "迁移账本只在存在待处理问题时暴露（产品边界）",
  );
  assert.match(panel, /serverState\.state === "updating"/, "更新中分支");
  assert.match(panel, /useSourceServerOperationLogs\(\s*management,/, "操作日志接真实 management");
  assert.match(
    panel,
    /useSourceServerManagementSnapshot\(management,/,
    "面板快照来自 management 快照 hook",
  );
  // 降级登记：本仓无桌面自更新链路，controller 升级走提示而不是伪造成功。
  assert.match(panel, /settings\.source\.controllerUpdateUnavailable/, "控制端升级必须降级提示");
  assert.doesNotMatch(panel, /executeDesktopCommand/, "omz 无 CheckForUpdates 桌面命令，不得调用");
  // 拍板 A：向导壳未搬时连接族按钮必须 disabled（不能是静默死点）。
  assert.match(
    panel,
    /CONNECT_FAMILY_ACTIONS\.has\(presentation\.primaryAction\) &&\s*!onConnectProfile/,
    "连接族主操作在向导壳缺席时必须显式禁用",
  );
});

test("T-MG3-3 面板族文件面：迁移报告/更新活动/5 个 hooks-lib 与 i18n 映射", () => {
  const migration = read(
    "packages",
    "ui",
    "src",
    "source-server-management",
    "SourceServerMigrationReportPanel.tsx",
  );
  assert.match(migration, /getSourceMigrationStatusMessageId/);
  assert.match(migration, /isLatestForPath/, "只有同一路径最新一次迁移可操作");
  const activity = read(
    "packages",
    "ui",
    "src",
    "source-server-management",
    "SourceServerUpdateActivity.tsx",
  );
  assert.match(activity, /export function SourceServerLogList/);
  assert.match(activity, /role="progressbar"/);
  for (const file of [
    "useSourceServerManagementSnapshot.ts",
    "sourceServerManagementError.ts",
    "sourceServerManagementPresentation.ts",
    "sourceServerUpdateAction.ts",
    "sourceServerUpdatePreferences.ts",
  ]) {
    assert.ok(
      read("packages", "ui", "src", "source-server-management", file).length > 0,
      `${file} 必须存在（面板族依赖）`,
    );
  }
  const presentation = read(
    "packages",
    "ui",
    "src",
    "source-server-management",
    "sourceServerManagementPresentation.ts",
  );
  assert.match(presentation, /settings\.source\.migrationStatus\.abandonedDiverged/);
  assert.match(presentation, /settings\.source\.migrationPhase\.aliasPublished/);
});

// ---------- ③ 例外真实范围 ----------

test("T-MG3-4 RemoteConnectionProgress 形状 + contract 类型（拍板 A 组件级例外）", () => {
  const progress = read(
    "packages",
    "ui",
    "src",
    "remote-connection-flow",
    "ui",
    "RemoteConnectionProgress.tsx",
  );
  for (const symbol of [
    "RemoteConnectionProgressProvider",
    "useRemoteConnectionProgress",
    "usePublishRemoteConnectionProgress",
    "RemoteConnectionMinimizedProgress",
  ]) {
    assert.match(progress, new RegExp(`export function ${symbol}\\b`), `${symbol} 必须导出`);
  }
  assert.match(progress, /data-testid="remote-connection-minimized"/);
  assert.match(progress, /resolveRemoteConnectionPhases\(logs\)/, "最小化进度必须用共享阶段投影");

  const contract = read("packages", "ui", "src", "remote-connection-flow", "contract.ts");
  assert.match(contract, /export interface RemoteConnectionProgress \{/, "contract 类型新增");
  // 既有签名只增不改（Step 4 的 Picker 真链契约不能被本批改写）。
  assert.match(
    contract,
    /export type SelectRemoteProjectHandler = \(\s*sessionId: string,\s*path: string,\s*localWorkspacePath\?: string,\s*workspacePurpose\?: RemoteConnectionWorkspacePurpose,/,
    "既有四参签名必须原样保留",
  );
});

test("T-MG3-5 resolveRemoteConnectionPhases：日志流 → 四态阶段轨（行为）", async () => {
  const { resolveRemoteConnectionPhases } =
    await import("../src/remote-connection/RemoteConnectionConnectingStep.js");
  const log = (message: string, level: "info" | "error" = "info") => ({ message, level });

  const pending = resolveRemoteConnectionPhases([]);
  assert.deepEqual(
    pending.map((phase) => phase.status),
    ["pending", "pending", "pending", "pending"],
    "无日志时阶段全 pending",
  );
  assert.deepEqual(
    pending.map((phase) => phase.key),
    ["channel", "identify", "deploy", "handshake"],
    "阶段顺序与上游一致",
  );

  const probing = resolveRemoteConnectionPhases([log("[source-server:probe] connecting")]);
  assert.deepEqual(
    probing.map((phase) => phase.status),
    ["active", "pending", "pending", "pending"],
    "probe 归并到 channel",
  );

  const recorded = resolveRemoteConnectionPhases([
    log("[source-server:probe] ok"),
    log("[source-server:directory-record] ok"),
  ]);
  assert.deepEqual(
    recorded.map((phase) => phase.status),
    ["complete", "active", "pending", "pending"],
    "directory-record 归并到 identify，前序置 complete",
  );

  const deployUpload = resolveRemoteConnectionPhases([log("[source-server:upload] 10%")]);
  assert.deepEqual(
    deployUpload.map((phase) => phase.status),
    ["complete", "complete", "active", "pending"],
    "上传归并到 deploy，前序阶段置 complete",
  );

  const failed = resolveRemoteConnectionPhases([
    log("[source-server:upload] 10%"),
    log("[source-server:upload] failed", "error"),
  ]);
  assert.equal(failed[2]!.status, "failed", "错误级别日志把该阶段标 failed");

  const ready = resolveRemoteConnectionPhases([log("[source-server:publish-online] ok")]);
  assert.deepEqual(
    ready.map((phase) => phase.status),
    ["complete", "complete", "complete", "complete"],
    "publish-online 是权威终态，全部 complete",
  );

  // 错误阶段不被 ready 覆盖（失败必须是失败）。
  const readyWithError = resolveRemoteConnectionPhases(
    [log("[source-server:handshake] boom", "error")],
    { connectionReady: true },
  );
  assert.equal(readyWithError[3]!.status, "failed", "有失败阶段时 ready 不能伪装成功");
});

test("T-MG3-6 RemoteLinkRail：三种传输的目标/设备展示（omz 无 server 直连）", async () => {
  const { formatRemoteLinkRailDevice, formatRemoteLinkRailTarget } =
    await import("../src/remote-connection/RemoteLinkRail.js");
  assert.equal(
    formatRemoteLinkRailTarget({ kind: "ssh", host: "h", username: "u" }),
    "u@h:22",
    "SSH 默认端口 22",
  );
  assert.equal(
    formatRemoteLinkRailTarget({ kind: "ssh", host: "h", username: "u", port: 2222 }),
    "u@h:2222",
  );
  assert.equal(formatRemoteLinkRailTarget({ kind: "wsl" }), "WSL · default");
  assert.equal(formatRemoteLinkRailTarget({ kind: "docker", container: "box" }), "Docker · box");
  assert.equal(formatRemoteLinkRailDevice({ kind: "ssh", host: "h", username: "u" }), "h");
  assert.equal(formatRemoteLinkRailDevice({ kind: "docker", container: "box" }), "box");
});

test("T-MG3-7 sourceServerStatusRegistry：按服务缓存 + 事件驱动刷新 + 输入投影", async () => {
  const { getSourceServerStatusRegistry } =
    await import("../src/store/sourceServerStatusRegistry.js");
  const snapshot = {
    generation: 1,
    servers: [{ sourceServerId: "s1", displayName: "Dev box", installState: "installed" }],
    profiles: [
      {
        profileId: "p1",
        sourceServerId: "s1",
        transport: "ssh",
        target: { kind: "ssh", host: "h", username: "u" },
        lifecycleState: "active",
      },
    ],
    states: [{ profileId: "p1", sourceServerId: "s1", state: "online", updatedAt: 1 }],
    workspaceHistory: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
  let stateListener: (() => void) | undefined;
  let snapshotCalls = 0;
  // 只实现 registry 真正消费的三面（getSnapshot + 两事件）；其余 15 个方法本用例不触达。
  const management = {
    getSnapshot: async () => {
      snapshotCalls += 1;
      return snapshot;
    },
    onDidChangeState: (listener: () => void) => {
      stateListener = listener;
      return { dispose() {} };
    },
    onDidChangeDirectory: () => ({ dispose() {} }),
  } as unknown as ISourceServerManagementService;
  const registry = getSourceServerStatusRegistry(management);
  assert.equal(
    registry,
    getSourceServerStatusRegistry(management),
    "同一 management 实例必须复用同一 registry（WeakMap 缓存）",
  );

  const notifications: number[] = [];
  const unsubscribe = registry.subscribe(() => notifications.push(notifications.length));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(snapshotCalls, 1, "构造即读一次快照");
  assert.equal(registry.getSnapshot().get("s1"), "online", "聚合状态来自设备投影");
  assert.equal(registry.getInputs().get("s1")?.profileId, "p1", "输入投影带 profileId");
  assert.equal(notifications.length, 1, "首次读取后通知订阅者");

  stateListener?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(snapshotCalls, 2, "Host 状态事件必须触发重读");
  assert.equal(notifications.length, 2);
  unsubscribe();
  stateListener?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(notifications.length, 2, "退订后不再收到通知");
});

// ---------- ④ 消费缝切换 ----------

test("T-MG3-8 消费缝：恒空 stub 退役 + 操作日志接真实服务签名", () => {
  const statuses = read("packages", "ui", "src", "hooks", "useSourceServerStatuses.ts");
  assert.match(statuses, /getSourceServerStatusRegistry/);
  assert.match(statuses, /sourceServerManagementService/);
  assert.doesNotMatch(statuses, /registry 实体到位后仅此处切换数据源/, "旧挂账注释必须更新");

  const logs = read("packages", "ui", "src", "hooks", "useSourceServerOperationLogs.ts");
  assert.match(logs, /getRecentOperationLogs\(id\)/, "日志 hook 必须按真实契约传 profileId 字符串");
  assert.doesNotMatch(logs, /profile: \{ profileId: string \}/, "结构端口形态必须退役");

  const section = read(
    "packages",
    "ui",
    "src",
    "project-sidebar",
    "RemoteConnectionProgressSection.tsx",
  );
  assert.doesNotMatch(section, /managementEnabled = false/);
  assert.match(section, /const profileId = connecting \? device\?\.profileId : undefined;/);
  assert.match(section, /logsByProfileId\[profileId\] \?\? \[\]/);
});
