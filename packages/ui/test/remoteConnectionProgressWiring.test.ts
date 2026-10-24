/**
 * T-RCP（knip-wire-progress）：后台连接进度接线的纯逻辑 + 源码形状守卫。
 *
 * 本仓无 jsdom，形态与 sourceServerPanelShape 一致：
 * ①scope 回填（发布侧只有 target 时，面板如何定位设备卡/未绑定连接行）；
 * ②向导阶段轨 SSR 形状（真实日志流 → 阶段/百分比，不引入 mock 事件）；
 * ③接线形状（向导壳调用发布 hook、Provider 挂载点在日后由整合补丁落地）。
 *
 * 运行形态（依赖 @/ 路径别名）：
 *   node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs \
 *     --test packages/ui/test/remoteConnectionProgressWiring.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionProfile, SourceServerManagementSnapshot } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { RemoteConnectionPhaseRail } from "../src/remote-connection-flow/ui/RemoteConnectionPhaseRail.js";
import {
  getRemoteConnectionActivePhase,
  getRemoteConnectionPhasePercent,
  resolveRemoteConnectionPhases,
} from "../src/remote-connection-flow/ui/remoteConnectionPhases.js";
import { normalizeRemoteConnectionPhaseLogMessage } from "../src/remote-connection-flow/ui/useRemoteConnectionPhaseLogs.js";
import { resolveRemoteConnectionProgressScope } from "../src/source-server-management/sourceServerManagementPresentation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const read = (...segments: string[]) => readFileSync(path.join(root, ...segments), "utf8");

const createdAt = 1;

function sshProfile(profileId: string, sourceServerId: string | undefined, host: string) {
  return {
    profileId,
    ...(sourceServerId ? { sourceServerId } : {}),
    transport: "ssh",
    target: { kind: "ssh", host, username: "me" },
    lifecycleState: "active",
    createdAt,
  } satisfies ConnectionProfile;
}

function profileSnapshot(profiles: ConnectionProfile[]) {
  return { profiles } satisfies Pick<SourceServerManagementSnapshot, "profiles">;
}

test("T-RCP1 已带 sourceServerId/profileId 的发布直接透传", () => {
  const scope = resolveRemoteConnectionProgressScope(
    { sourceServerId: "s-1", profileId: "p-1" },
    profileSnapshot([]),
  );
  assert.deepEqual(scope, { sourceServerId: "s-1", profileId: "p-1" });
});

test("T-RCP2 只有 target 时按快照回填 scope（SSH 默认端口/别名参与匹配）", () => {
  const snapshot = profileSnapshot([
    sshProfile("p-ssh", "s-ssh", "dev.example"),
    sshProfile("p-wsl", "s-wsl", "other.example"),
  ]);
  assert.deepEqual(
    resolveRemoteConnectionProgressScope(
      { target: { kind: "ssh", host: "dev.example", username: "me" } },
      snapshot,
    ),
    { sourceServerId: "s-ssh", profileId: "p-ssh" },
  );
  assert.deepEqual(
    resolveRemoteConnectionProgressScope(
      { target: { kind: "ssh", host: "dev.example", username: "me", port: 2222 } },
      snapshot,
    ),
    { sourceServerId: undefined, profileId: undefined },
    "端口不同是另一条连接，不能误配到默认端口 Profile",
  );
});

test("T-RCP3 未绑定 Profile / 目标无匹配 / 空进度", () => {
  const snapshot = profileSnapshot([sshProfile("p-unbound", undefined, "dev.example")]);
  assert.deepEqual(
    resolveRemoteConnectionProgressScope(
      { target: { kind: "ssh", host: "dev.example", username: "me" } },
      snapshot,
    ),
    { sourceServerId: undefined, profileId: "p-unbound" },
    "未绑定设备仍要定位到连接行",
  );
  assert.deepEqual(
    resolveRemoteConnectionProgressScope(
      { target: { kind: "docker", container: "missing" } },
      snapshot,
    ),
    { sourceServerId: undefined, profileId: undefined },
  );
  assert.deepEqual(resolveRemoteConnectionProgressScope(null, snapshot), {});
});

test("T-RCP4 阶段轨：真实日志流投影与 SSR 形状", () => {
  const logs = [
    { level: "info" as const, message: "[source-server:probe] connecting" },
    { level: "info" as const, message: "[source-server:upload] 10%" },
  ];
  const phases = resolveRemoteConnectionPhases(logs);
  assert.deepEqual(
    phases.map((phase) => phase.status),
    ["complete", "complete", "active", "pending"],
  );
  assert.equal(getRemoteConnectionPhasePercent(phases), 50);
  assert.equal(getRemoteConnectionActivePhase(phases).titleId, "remote.phase.deploy");

  const html = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(RemoteConnectionPhaseRail, { logs }),
    }),
  );
  assert.match(html, /data-testid="remote-connection-phase-rail"/);
  assert.match(html, /data-testid="remote-connection-phase-percent"[^>]*>50%/);
  assert.match(html, /data-progress-phase="channel" data-progress-status="complete"/);
  assert.match(html, /data-progress-phase="deploy" data-progress-status="active"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /安装 ZCode Server/);

  const ready = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(RemoteConnectionPhaseRail, {
        logs: [{ level: "info", message: "[source-server:publish-online] ok" }],
      }),
    }),
  );
  assert.match(ready, /data-testid="remote-connection-phase-percent"[^>]*>100%/);
});

test("T-RCP5 阶段日志必须保留 phase 标记（展示日志的 normalizer 会剥掉它）", () => {
  assert.equal(
    normalizeRemoteConnectionPhaseLogMessage("[source-server:probe] connecting"),
    "[source-server:probe] connecting",
    "原始 phase 前缀必须保留，否则阶段轨永远停在第一步",
  );
  assert.equal(
    normalizeRemoteConnectionPhaseLogMessage(
      "[2026-10-24 12:00:00.000] [pid:42] [source-server:upload] 10%",
    ),
    "[source-server:upload] 10%",
    "时间戳/pid 噪音要清掉，但 phase 标记不能动",
  );
});

test("T-RCP6 接线形状：向导壳发布 hook + 面板 scope 回填 + 向导阶段轨", () => {
  const publisher = read(
    "packages",
    "ui",
    "src",
    "remote-connection-flow",
    "ui",
    "useRemoteConnectionProgressPublisher.ts",
  );
  assert.match(publisher, /usePublishRemoteConnectionProgress\(progress\)/);
  assert.match(publisher, /minimized/, "只有收起后台才发布");
  assert.match(publisher, /onResumeRef/, "回调经 ref 转发，避免发布回环");
  assert.match(publisher, /target: displayTarget/, "发布前必须裁剪成展示字段（凭据不能带出向导）");

  const progress = read(
    "packages",
    "ui",
    "src",
    "remote-connection-flow",
    "ui",
    "RemoteConnectionProgress.tsx",
  );
  assert.match(progress, /remote-connection-flow\/ui\/remoteConnectionPhases\.js/);
  assert.doesNotMatch(
    progress,
    /from "@\/remote-connection\/RemoteConnectionConnectingStep\.js"/,
    "阶段投影下沉 flow 层，避免 ConnectingStep ↔ progress 循环 import",
  );

  const connectingStep = read(
    "packages",
    "ui",
    "src",
    "remote-connection",
    "RemoteConnectionConnectingStep.tsx",
  );
  assert.match(connectingStep, /<RemoteConnectionPhaseRail logs=\{phaseLogs\} \/>/);
  assert.match(connectingStep, /useRemoteConnectionPhaseLogs\(requestId\)/);
  assert.match(
    connectingStep,
    /export \{\s*resolveRemoteConnectionPhases,/,
    "旧导入面（测试/后台进度）必须保持可用",
  );

  const panel = read(
    "packages",
    "ui",
    "src",
    "source-server-management",
    "SourceServerManagementPanel.tsx",
  );
  assert.match(panel, /resolveRemoteConnectionProgressScope\(background, snapshot\)/);
  assert.match(panel, /backgroundScope\.sourceServerId === server\.sourceServerId/);
  assert.match(panel, /`source:\$\{backgroundScope\.sourceServerId\}`/);
});
