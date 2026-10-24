/**
 * T-SB4（backlog-sweep Step 4，Picker 真链）：契约四参 / purpose 分支 / Root selection 装配 /
 * Picker→Editor 透传 / stale-intent 守卫。
 *
 * 形态与 projectSidebarP42 一致：本仓 ui 无 jsdom，用「纯逻辑 + 源码形状守卫」。
 * 运行：node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test
 *   packages/ui/test/remoteProjectPickerChain.test.ts
 * ①contract.ts 四参签名与 purpose 归一化（纯逻辑）；
 * ②hostId 派生只走统一 identity 工具（纯逻辑）；
 * ③边界确认纯函数：只有显式确认才落版本（纯逻辑）；
 * ④SSHDialog→hook→Root→Picker→Editor 源码形状：purpose==="project" 在 bind 前 return、
 *   Root selection/stale-intent、Picker 透传 host/initialRoots、Editor 上游 props；
 * ⑤conversation 旧链零变化（ChatEmptyState 显式传值 + hook 仅 project 分支改道）；
 * ⑥边界确认依赖链（setting 键 + i18n 两侧 + hook 消费）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  normalizeRemoteConnectionWorkspacePurpose,
  type RemoteConnectionWorkspacePurpose,
} from "../src/remote-connection-flow/contract.js";
import { deriveRemoteProjectHostId } from "../src/root/useRemoteWorkspaceHistory.js";
import { ensureSourceServerBoundaryAcknowledged } from "../src/lib/sourceServerBoundaryOnboarding.js";
import { selectProjectDevices } from "../src/project-sidebar/ProjectCreation.js";
import type { RemoteProjectDirectory, RemoteProjectHost } from "../src/project-sidebar/contract.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");
const readUi = (...parts: string[]) => read(uiSrc, ...parts);

// ---------- ① 契约四参 + purpose 归一化 ----------

test("contract：onSelectProject 四参签名 + purpose 未传按 conversation 兜底", () => {
  const source = readUi("remote-connection-flow", "contract.ts");
  assert.match(
    source,
    /export type RemoteConnectionWorkspacePurpose = "project" \| "conversation";/,
  );
  assert.match(
    source,
    /sessionId: string,\s*path: string,\s*localWorkspacePath\?: string,\s*workspacePurpose\?: RemoteConnectionWorkspacePurpose,/,
    "契约必须是四参（第四个是 purpose）",
  );
  assert.equal(normalizeRemoteConnectionWorkspacePurpose("project"), "project");
  assert.equal(normalizeRemoteConnectionWorkspacePurpose("conversation"), "conversation");
  assert.equal(
    normalizeRemoteConnectionWorkspacePurpose(undefined),
    "conversation",
    "旧入口零变化",
  );
  // app-shell 既有调用面会把 preparedWorkspaceIdentity 透传到第四参；不能误当 purpose。
  assert.equal(
    normalizeRemoteConnectionWorkspacePurpose("remote:ssh:h:22:u:/w"),
    "conversation",
    "身份串不得被当作 purpose",
  );
  const typed: RemoteConnectionWorkspacePurpose = "conversation";
  assert.equal(typed, "conversation");
});

// ---------- ② hostId 派生 ----------

test("deriveRemoteProjectHostId：ssh/wsl/docker 只经统一 identity 工具派生", () => {
  assert.equal(
    deriveRemoteProjectHostId("/srv/app", {
      kind: "ssh",
      host: "Build-Host",
      port: 2222,
      username: "dev",
    }),
    "remote:ssh:build-host:2222:dev",
  );
  assert.equal(
    deriveRemoteProjectHostId("/w", { kind: "wsl", distro: "Ubuntu" }),
    "remote:wsl:Ubuntu",
    "默认用户的 WSL 身份不带 user 段",
  );
  assert.equal(
    deriveRemoteProjectHostId("/w", { kind: "wsl", distro: "Ubuntu", user: "root" }),
    "remote:wsl:Ubuntu:root",
  );
  assert.equal(
    deriveRemoteProjectHostId("/w", { kind: "docker", container: "box" }),
    "remote:docker:box",
  );
  // identity 的 path 段被裁掉：hostId 里不能残留 workspace 路径。
  assert.ok(
    !deriveRemoteProjectHostId("/srv/app", { kind: "docker", container: "box" })!.includes(
      "/srv/app",
    ),
  );
});

test("hook：hostId 派生复用 buildRemoteWorkspaceIdentity + remoteHostIdFromWorkspaceIdentity", () => {
  const source = readUi("root", "useRemoteWorkspaceHistory.ts");
  assert.match(
    source,
    /export function deriveRemoteProjectHostId\(\s*workspacePath: string,\s*target: RemoteTarget,/,
  );
  assert.match(
    source,
    /return remoteHostIdFromWorkspaceIdentity\(buildRemoteWorkspaceIdentity\(workspacePath, target\)\);/,
    "业务代码不得手写 authority",
  );
});

// ---------- ③ 边界确认纯函数 ----------

test("ensureSourceServerBoundaryAcknowledged：只有显式确认才落版本", async () => {
  const calls: string[] = [];
  const persisted: number[] = [];
  const run = (
    currentVersion: number | undefined,
    acknowledged: boolean,
    currentFlag?: () => boolean,
  ) =>
    ensureSourceServerBoundaryAcknowledged({
      currentVersion,
      targetVersion: 1 as const,
      isCurrent: currentFlag,
      requestAcknowledgement: async () => {
        calls.push("request");
        return acknowledged;
      },
      persistVersion: async (version) => {
        persisted.push(version);
      },
    });

  // 已读：不再打扰用户，也不重复落盘。
  assert.equal(await run(1, true), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(persisted, [] as number[]);

  // 取消确认：不落盘。
  assert.equal(await run(undefined, false), false);
  assert.deepEqual(persisted, [] as number[]);

  // 明确确认：落 target 版本并返回 true。
  assert.equal(await run(undefined, true), true);
  assert.deepEqual(persisted, [1]);

  // 组件卸载/流程失效后迟到的确认不能替已失效意图消费首次介绍。
  let alive = true;
  assert.equal(
    await ensureSourceServerBoundaryAcknowledged<number>({
      currentVersion: undefined,
      targetVersion: 1,
      isCurrent: () => alive,
      requestAcknowledgement: async () => {
        alive = false; // 确认框返回途中流程失效
        return true;
      },
      persistVersion: async (version) => {
        persisted.push(version);
      },
    }),
    false,
  );
  assert.deepEqual(persisted, [1], "失效后不得再写版本");

  // 一开始就失效：连确认框都不该弹。
  assert.equal(await run(undefined, true, () => false), false);
});

// ---------- ④ 源码形状：SSHDialog → hook → Root → Picker ----------

test("SSHDialog：workspacePurpose prop 显式传值 + 四参透传", () => {
  const source = readUi("SSHDialog.tsx");
  assert.match(source, /workspacePurpose\?: RemoteConnectionWorkspacePurpose;/);
  assert.match(
    source,
    /const workspacePurpose = normalizeRemoteConnectionWorkspacePurpose\(workspacePurposeProp\);/,
  );
  assert.match(
    source,
    /await onSelectProject\(connectedSessionId, path, localWorkspacePath, workspacePurpose\);/,
    "选目录必须把第四参交给 owner 分支",
  );
  assert.match(
    source,
    /onSelectProject: SelectRemoteProjectHandler;/,
    "props 用契约类型，不重写签名",
  );
});

test('hook：purpose==="project" 在 bind 之前 return，conversation 旧链不动', () => {
  const source = readUi("root", "useRemoteWorkspaceHistory.ts");
  const earlyReturn = source.indexOf('if (workspacePurpose === "project")');
  const bindCall = source.indexOf("await bindRemoteWorkspaceSessionContext({");
  const branchEnd = source.indexOf("const existingWorkspaceTab", earlyReturn);
  assert.ok(earlyReturn > -1, 'purpose==="project" 分支必须存在');
  assert.ok(bindCall > -1, "旧链 bind 调用必须仍在");
  assert.ok(branchEnd > earlyReturn, "project 分支必须在既有 tab 复用之前结束");
  assert.ok(
    branchEnd < bindCall,
    "project 分支必须在 bind 之前 return（不建 tab、不落会话 mutation）",
  );
  const branch = source.slice(earlyReturn, branchEnd);
  assert.match(
    branch,
    /await onRemoteProjectIntent\(\{ sessionId, path: canonicalPath, hostId \}\);/,
  );
  assert.match(branch, /return;/);
  assert.doesNotMatch(branch, /addTab\(/, "project 分支不得 addTab");
  assert.doesNotMatch(branch, /activateTabByPath\(/, "project 分支不得激活 tab");
  assert.doesNotMatch(
    branch,
    /commitRemoteWorkspaceSessionMutation\(/,
    "project 分支不得提交会话 mutation",
  );
  // 旧链仍然完整：bind/commit/addTab 都在 project 分支之后。
  const afterBranch = source.slice(bindCall);
  assert.match(afterBranch, /await commitRemoteWorkspaceSessionMutation\(/);
  assert.match(afterBranch, /addTab\(canonicalPath, \{/);
  // 无 Root 回调时 fail-closed，不能悄悄退回旧链。
  assert.match(
    source,
    /if \(!onRemoteProjectIntent\) \{[\s\S]*?throw new Error\("project\.connection-unavailable"\)/,
  );
});

test("Root：Picker 挂载 + selection 装配 + stale-intent 守卫 + 关闭释放 attachment", () => {
  const source = readUi("Root.tsx");
  assert.match(
    source,
    /import \{ RemoteProjectPicker \} from "@\/project-sidebar\/RemoteProjectPicker\.js";/,
  );
  assert.match(source, /const remoteProjectIntentEpoch = useRef\(0\);/);
  assert.match(source, /const \[remoteProjectSelection, setRemoteProjectSelection\] = useState</);
  // selection 装配：读目录 → epoch 比对 → 按 hostId 找 host。
  assert.match(source, /const directory = await remoteService\.readDirectory\(\);/);
  assert.match(
    source,
    /if \(epoch !== remoteProjectIntentEpoch\.current\) throw new Error\("project\.creation-cancelled"\);/,
  );
  assert.match(source, /directory\.hosts\.find\(\(item\) => item\.id === hostId\)/);
  // stale-intent：关闭向导即作废未落地意图。
  assert.match(
    source,
    /if \(!open\) remoteProjectIntentEpoch\.current\+\+;/,
    "onClose/onOpenChange(false) 必须让旧 intent 失效",
  );
  // Picker 挂载：host/initialRoots/service/remoteService 四件齐 + membershipId 换代重挂。
  assert.match(
    source,
    /<RemoteProjectPicker[\s\S]*key=\{remoteProjectSelection\.host\.membershipId\}/,
  );
  assert.match(source, /host=\{remoteProjectSelection\.host\}/);
  assert.match(source, /initialRoots=\{\[remoteProjectSelection\.path\]\}/);
  assert.match(source, /service=\{services\.projectService\}/);
  assert.match(source, /remoteService=\{services\.remoteProjectService\}/);
  // onClose 释放 attachment。
  assert.match(source, /void handleCancelRemoteProject\(sessionId\)/);
  // 项目面出现时向导隐藏；Root 入口显式声明 purpose。
  assert.match(source, /open=\{remoteConnectionDialogOpen && !remoteProjectSelection\}/);
  assert.match(source, /workspacePurpose="project"/);
  // 向导换代：项目流程关闭后不能回到已释放的目录步。
  assert.match(source, /key=\{remoteConnectionDialogEpoch\}/);
});

test("RemoteProjectPicker：renderCreate 补传 host/initialRoots（否则不进创建态、保存不带 hostId）", () => {
  const source = readUi("project-sidebar", "RemoteProjectPicker.tsx");
  assert.match(source, /host=\{props\.host\}/);
  assert.match(source, /initialRoots=\{props\.initialRoots\}/);
  assert.match(source, /onClose=\{close\}/);
  assert.match(source, /onSaved=\{add\}/);
});

test("ProjectEditor：上游八个远端 props + 边界确认 + onLegacyCapability 转交", () => {
  const source = readUi("project-sidebar", "ProjectEditor.tsx");
  for (const prop of [
    "host?: RemoteProjectHost;",
    "devices?: ProjectDevice[];",
    "defaultDeviceId?: string;",
    "remoteService?: IRemoteProjectService;",
    "onConnectDevice?(device: ProjectDevice): Promise<boolean>;",
    "onAddDevice?(selectDevice: (id: string) => Promise<void>): void;",
    "onBrowseExisting?(device: ProjectDevice): Promise<boolean>;",
    "onPrepareExisting?(hostId: string, isCurrent: () => boolean): Promise<RemoteProjectHost>;",
  ]) {
    assert.ok(source.includes(prop), `缺 prop: ${prop}`);
  }
  // hostId 来源：既有项目 → 固定目录 → picker 指定的 host → 设备选择。
  assert.match(
    source,
    /const hostId =\s*project\?\.hostId \?\? fixedFolder\?\.hostId \?\? host\?\.id \?\? \(devices \? selectedDeviceId : undefined\);/,
  );
  // 边界确认链：浏览远端目录前必须过首次介绍。
  assert.match(source, /const acknowledgeBoundary = useRemoteBoundaryAcknowledgement\(\);/);
  assert.match(
    source,
    /if \(!\(await acknowledgeBoundary\(\(\) => current\(request\) && !suspendedRef\.current\)\)\) return;/,
  );
  // onLegacyCapability 转交 RemoteProjectList（Step 6 的闸门依赖它）。
  assert.match(
    source,
    /onLegacyCapability=\{\(legacy\) => setLegacyDeviceId\(legacy \? selectedDevice\.id : null\)\}/,
  );
  // 设备连接态分支：未在线先连接再浏览。
  assert.match(source, /if \(remote && devices && selectedDevice\?\.status !== "online"\)/);
  // 已有项目浏览分支（embedded RemoteProjectList）。
  assert.match(source, /\{existing && selectedDevice && remoteService && onPrepareExisting \? \(/);
});

test("RemoteProjectList：onLegacyCapability 能力回传（Step 6 落可见闸门）", () => {
  const source = readUi("project-sidebar", "RemoteProjectList.tsx");
  assert.match(source, /onLegacyCapability\?\(legacy: boolean\): void;/);
  assert.match(source, /capabilityCallback\.current\?\.\(Boolean\(tree\.legacySingleRoot\)\)/);
});

test("ProjectCreation：设备面按统一 identity 投影，空目录 + 无设备管理即纯本机（无下拉）", () => {
  const source = readUi("project-sidebar", "ProjectCreation.tsx");
  // 设备行投影：host 身份经统一工具反解 Source 归属，不上手拼 authority。
  assert.match(source, /function projectDevice\(host: RemoteProjectHost\): ProjectDevice \{/);
  assert.match(
    source,
    /parseRemoteWorkspaceIdentity\(\s*buildRemoteHostWorkspaceIdentity\(host\.id, "\/"\),\s*\)\?\.sourceServerId;/,
    "server 形态 host 必须反解出 sourceServerId",
  );
  assert.match(source, /\.\.\.\(sourceServerId \? \{ sourceServerId \} : \{\}\),/);
  assert.match(source, /label: remoteHostLabel\(host\)/);
  assert.match(source, /status: host\.connectionStatus \?\? "offline"/);
  // 空目录不得把纯本机形态变成设备下拉：长度判定 + 显式能力双门。
  assert.match(
    source,
    /const hosts = directory\?\.hosts \?\? \[\];\s*if \(!directory \|\| \(hosts\.length === 0 && !allowDeviceManagement\)\) return undefined;/,
    "空投影且不允许设备管理时必须返回 undefined（ProjectEditor 的 devices 闸门）",
  );
  assert.match(source, /const devices = selectProjectDevices\(directory, allowDeviceManagement\);/);
  assert.match(source, /onPrepareExisting=\{\s*remoteService/);
  // 消费者：ProjectEditor 的渲染闸门就是 devices 真值，devices=undefined 即不渲染下拉。
  const editor = readUi("project-sidebar", "ProjectEditor.tsx");
  assert.match(editor, /\{devices \? \(/);
  // 设备管理能力默认仍关闭；只有显式传 allowDeviceManagement 的挂载点接管向导。
  assert.match(source, /allowDeviceManagement = false/, "默认值必须保持关闭");
  assert.match(
    source,
    /const openDeviceWizard = allowDeviceManagement \? onOpenRemoteWorkspace : undefined;/,
  );
  assert.match(
    source,
    /onConnectDevice=\{remoteService \|\| openDeviceWizard \? connectDevice : undefined\}/,
  );
});

test("ProjectCreation：向导回传必须仍是同一 Source，不一致明确失败（不再静默放行）", () => {
  const source = readUi("project-sidebar", "ProjectCreation.tsx");
  // 打开向导时把设备 Source 作为 preferredSourceServerId 下发。
  assert.match(source, /preferredSourceServerId: device\.sourceServerId,/);
  // 回传校验：不同 Source 直接 reject（由 ProjectEditor 错误行展示），不放行到原目录流程。
  assert.match(
    source,
    /if \(\s*device\.sourceServerId !== undefined &&\s*result\.sourceServerId !== device\.sourceServerId\s*\) \{/,
    "同 Source 校验必须真的比较两侧身份",
  );
  assert.match(source, /reject\(new Error\("project\.connection-unavailable"\)\);/);
  assert.doesNotMatch(
    source,
    /device\.sourceServerId === undefined \|\|\s*result\.sourceServerId === device\.sourceServerId/,
    "旧的恒真放行式校验必须已拆除",
  );
});

test("selectProjectDevices：运行时投影（纯本机不下拉 / server host 带 Source / legacy 无 Source）", () => {
  const host = (
    id: string,
    connectionStatus?: RemoteProjectHost["connectionStatus"],
  ): RemoteProjectHost => ({
    id,
    membershipId: "m1",
    kind: "ssh",
    target: null,
    position: 0,
    ...(connectionStatus ? { connectionStatus } : {}),
  });
  const directory = (...hosts: RemoteProjectHost[]): RemoteProjectDirectory => ({
    hosts,
    entries: [],
  });
  assert.equal(selectProjectDevices(undefined, true), undefined, "无目录投影不启用设备面");
  // 缺陷4：useProjectTree 初始投影 `{hosts:[],entries:[]}`，旧代码使 devices 从 undefined 变 []
  // （truthy），纯本机形态也会渲染设备下拉。
  assert.equal(
    selectProjectDevices(directory(), false),
    undefined,
    "空目录 + 不允许设备管理 = 纯本机，必须不渲染下拉",
  );
  assert.deepEqual(
    selectProjectDevices(directory(), true),
    [],
    "显式允许设备管理时保留「添加远程设备」入口",
  );
  // 缺陷2：server 形态 host 必须带 Source 身份，向导回传才能做同 Source 校验。
  const [serverDevice] = selectProjectDevices(
    directory(host("remote:server:dev-1", "online")),
    false,
  )!;
  assert.equal(serverDevice?.sourceServerId, "dev-1");
  assert.equal(serverDevice?.status, "online");
  const [legacyDevice] = selectProjectDevices(directory(host("remote:ssh:build:22:dev")), false)!;
  assert.equal(legacyDevice?.sourceServerId, undefined, "legacy ssh 设备没有 Source 归属");
});

test("设备管理往返：两处挂载点都真接向导壳（替换旧的「不得传」断言）", () => {
  const sidebar = readUi("project-sidebar", "index.tsx");
  const composer = readUi("project-sidebar", "ProjectComposerMenu.tsx");
  const creation = readUi("project-sidebar", "ProjectCreation.tsx");
  // 挂载点①侧栏：能力与回调同源，缺一个就退化不可达。
  assert.match(
    sidebar,
    /<ProjectCreation[\s\S]*?allowDeviceManagement=\{Boolean\(props\.onOpenRemoteWorkspace\)\}[\s\S]*?onOpenRemoteWorkspace=\{props\.onOpenRemoteWorkspace\}/,
    "侧栏挂载点必须同时下发能力与 Shell 回调",
  );
  // 挂载点②chip：能力经 ProjectComposerMenu 透传到同一个新建表单。
  assert.match(
    sidebar,
    /<ProjectComposerMenu[\s\S]*?onOpenRemoteWorkspace=\{props\.onOpenRemoteWorkspace\}/,
    "chip 入口必须拿到 Shell 下发的向导回调",
  );
  assert.match(
    composer,
    /allowDeviceManagement=\{Boolean\(onOpenRemoteWorkspace\)\}[\s\S]*?onOpenRemoteWorkspace=\{onOpenRemoteWorkspace\}/,
    "composer 挂载点必须把能力与回调一起交给 ProjectCreation",
  );
  assert.match(
    composer,
    /onOpenRemoteWorkspace\?: ProjectSidebarProps\["onOpenRemoteWorkspace"\];/,
  );
  // 真接线：点「添加设备」/「连接」都能带着 completion + returnTarget 打开同一向导并回传。
  assert.match(creation, /onAddDevice=\{\s*openDeviceWizard\s*\?/);
  assert.match(creation, /completion: "device-management"/);
  assert.match(creation, /kind: "connect-device"/);
  assert.match(creation, /kind: "add-device"/);
});

// ---------- ④b 设备往返一次性消费 ----------

test("Root：deviceAdditionReturn 一次性消费（成功/失败/取消后清空，「查看项目」不再被跳过）", () => {
  const source = readUi("Root.tsx");
  const start = source.indexOf("const finishDeviceAddition = useCallback(");
  const end = source.indexOf("const resolveDeviceAdditionSourceServerId", start);
  assert.ok(start > -1 && end > start, "finishDeviceAddition 必须存在");
  const body = source.slice(start, end);
  // 缺陷3：成功回传后旧实现不清引用，之后设备面板走向导成功时
  // `if (deviceAdditionReturn.current)` 直接 return，pendingDeviceIntentRef 永不结算。
  assert.match(
    body,
    /const release = \(\) => \{\s*if \(deviceAdditionReturn\.current === pending\) deviceAdditionReturn\.current = null;\s*\};/,
    "释放点必须按 owner 身份比对，迟到结果不能清新入口",
  );
  assert.match(
    body,
    /finally \{\s*if \(!retryable\) release\(\);\s*\}/,
    "成功/失败/取消三条终态必须都走到统一释放点",
  );
  assert.match(body, /let retryable = false;/, "只有可重试的读失败保留 owner");
  assert.match(body, /retryable = true;/, "读失败分支必须标记为可重试");
  assert.doesNotMatch(
    body,
    /result\.kind === "cancelled" && deviceAdditionReturn\.current === pending/,
    "旧实现只清 cancelled，必须已拆除",
  );
  // 面板「连接/查看项目」的结算链仍在设备往返分支之后：owner 被清空后才轮到这里。
  const connect = source.indexOf("const handleRemoteConnectionDialogConnect = useCallback(");
  const connectEnd = source.indexOf("const remoteConnectionDialog =", connect);
  assert.ok(connect > -1 && connectEnd > connect, "handleRemoteConnectionDialogConnect 必须存在");
  const connectBody = source.slice(connect, connectEnd);
  const deviceBranch = connectBody.indexOf("if (deviceAdditionReturn.current) {");
  const intentBranch = connectBody.indexOf("const pending = pendingDeviceIntentRef.current;");
  assert.ok(deviceBranch > -1, "设备往返分支必须存在");
  assert.ok(
    intentBranch > deviceBranch,
    "面板意图分支必须仍在设备往返分支之后（残留 owner 会把它整段跳过）",
  );
  assert.match(
    connectBody.slice(intentBranch),
    /pending\.resolve\(snapshot\)/,
    "面板 promise 必须在成功路径结算",
  );
});

// ---------- ⑤ conversation 旧链 ----------

test('ChatEmptyState：显式 workspacePurpose="conversation"（行为零变化）', () => {
  const source = readUi("ChatEmptyState.tsx");
  assert.match(source, /<SSHDialog[\s\S]{0,200}workspacePurpose="conversation"/);
  assert.match(
    source,
    /onSelectRemoteProject: \(\s*sessionId: string,\s*path: string,\s*localWorkspacePath\?: string,\s*\) => Promise<void>;/,
    "空态入口的 props 仍是三参旧签名",
  );
});

// ---------- ⑥ 边界确认依赖链 ----------

test("边界确认：hook 在 RemoteConnectionDialogContent，setting 键两处 schema 在册", () => {
  const content = readUi("RemoteConnectionDialogContent.tsx");
  assert.match(content, /export function useRemoteBoundaryAcknowledgement\(\)/);
  assert.match(content, /ensureSourceServerBoundaryAcknowledged\(\{/);
  assert.match(content, /currentVersion: settings\.remoteBoundaryIntroAcknowledgedVersion/);
  assert.match(content, /await settingService\.update\(patch\);/);

  const protocol = read(root, "packages", "shared", "src", "protocol.ts");
  assert.match(protocol, /remoteBoundaryIntroAcknowledgedVersion\?: 1;/);
  const validation = read(root, "packages", "shared", "src", "validationAppSettings.ts");
  assert.equal(
    validation.split("remoteBoundaryIntroAcknowledgedVersion: z.literal(1).optional(),").length - 1,
    2,
    "全量 schema 与 patch schema 都必须认这个键",
  );
});

test("边界确认：i18n 两侧成对（title/description/gotIt）", () => {
  for (const locale of ["zh-CN.ts", "en-US.ts"]) {
    const source = read(uiSrc, "i18n", "locales", locale);
    for (const key of [
      "common.gotIt",
      "remote.sourceServerBoundaryTitle",
      "remote.sourceServerBoundaryDescription",
    ]) {
      assert.ok(source.includes(`"${key}":`), `${locale} 缺键 ${key}`);
    }
  }
});

// ---------- ⑦ Step 6：legacySingleRoot 列表闸门 ----------

test("RemoteProjectList：legacySingleRoot 落 state 并闸住创建入口（Step 6）", () => {
  const source = readUi("project-sidebar", "RemoteProjectList.tsx");
  // 状态落地：读树结果同时驱动列表与能力回传，闸门不能只看父级 props。
  assert.match(source, /const \[legacySingleRoot, setLegacySingleRoot\] = useState\(false\);/);
  assert.match(source, /setLegacySingleRoot\(Boolean\(tree\.legacySingleRoot\)\);/);
  // 创建态门禁：单根退回设备不得进入 renderCreate（否则 ProjectEditor 保存才报错）。
  assert.match(
    source,
    /if \(host && !embedded && creating && !loading && !legacySingleRoot && !error && renderCreate\)/,
    "创建态必须排除 legacySingleRoot",
  );
  // 新建按钮禁用 + 升级提示文案（i18n 键两侧在册）。
  assert.match(
    source,
    /disabled=\{loading \|\| saving \|\| Boolean\(error\) \|\| legacySingleRoot\}/,
    "新建按钮必须按能力禁用",
  );
  assert.match(
    source,
    /\{legacySingleRoot \? \(\s*<p className="text-ui-sm text-foreground-subtle">\{msg\("legacyUpgradeRequired"\)\}<\/p>\s*\) : null\}/,
    "单根退回设备必须给出升级文案",
  );
  for (const locale of ["zh-CN.ts", "en-US.ts"]) {
    const localeSource = read(uiSrc, "i18n", "locales", locale);
    assert.ok(
      localeSource.includes('"project.legacyUpgradeRequired":'),
      `${locale} 缺键 project.legacyUpgradeRequired`,
    );
  }
});
