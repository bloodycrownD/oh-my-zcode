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

test("ProjectCreation：设备面走 directory.hosts 映射，onAddDevice disable（拍板 A）", () => {
  const source = readUi("project-sidebar", "ProjectCreation.tsx");
  assert.match(
    source,
    /const devices: ProjectDevice\[\] \| undefined = directory\s*\? directory\.hosts\.map/,
  );
  assert.match(source, /label: remoteHostLabel\(host\)/);
  assert.match(source, /status: host\.connectionStatus \?\? "offline"/);
  assert.match(source, /onConnectDevice=\{remoteService \? connectDevice : undefined\}/);
  assert.match(source, /onPrepareExisting=\{\s*remoteService/);
  assert.doesNotMatch(source, /onAddDevice=\{/, "拍板 A：本轮不得接向导壳的设备新增入口");
  assert.match(source, /拍板 A/, "disable 决定必须登记在实现处");
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
