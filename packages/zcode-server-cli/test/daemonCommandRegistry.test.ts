// T-RD2（upstream-v316-fullsync §phase-remote-daemon Step 16）：daemon serve 命令链注册表与排除面守卫。
//
// 锁死四件事：
// 1) control 命令注册表：running-tasks/runtime-identity 新命令 + apply-update force 语义。
// 2) daemon 生命周期判定纯函数：shouldRegisterService/daemonStartupMode/isRegisteredServiceEntry。
// 3) 停止预算常量化：SERVER_STOP_WAIT_TIMEOUT_MS 覆盖宽限+强杀+socket 关闭+落盘余量。
// 4) 排除面守卫：cli.ts 不得消费 SourceServerWorkspaceAliasRepo / migrate retry（三期 Step 18 面），
//    且 serve/status/stop/restart/update/uninstall + proxy-stdio 子命令在位。
//
// 运行形态：worktree 根 `node --import tsx --test packages/zcode-server-cli/test/daemonCommandRegistry.test.ts`
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  SERVER_STOP_WAIT_TIMEOUT_MS,
  controlRequestSchema,
  coreMessageSchema,
  runtimeIdentitySchema,
} from "../src/contracts.js";
import {
  daemonStartupMode,
  isRegisteredServiceEntry,
  serviceRegistrationEnabled,
  shouldRegisterService,
} from "../src/cli.js";

test("T-RD2 control 命令注册表：新命令与变体字段在位", () => {
  assert.equal(controlRequestSchema.parse({ id: "cli", command: "running-tasks" }).command, "running-tasks");
  assert.equal(
    controlRequestSchema.parse({ id: "cli", command: "runtime-identity" }).command,
    "runtime-identity",
  );
  assert.equal(
    controlRequestSchema.parse({ id: "cli", command: "apply-update", force: true }).force,
    true,
  );
  assert.equal(
    controlRequestSchema.parse({ id: "cli", command: "confirm-uninstall", confirmation: "DELETE" })
      .confirmation,
    "DELETE",
  );
});

test("T-RD2 coreMessage：ready 可携带 releaseId，heartbeat/task-activity 可携带 runningTasks", () => {
  const ready = coreMessageSchema.parse({
    type: "ready",
    host: "127.0.0.1",
    port: 1234,
    version: "1.0.0",
    releaseId: "1.0.0-linux-x64-abc123",
    generation: 1,
  });
  assert.equal(ready.type, "ready");
  const heartbeat = coreMessageSchema.parse({
    type: "heartbeat",
    at: 1,
    runningTaskCount: 1,
    runningTasks: [{ sessionId: "s", workspacePath: "/w" }],
  });
  assert.equal(heartbeat.type, "heartbeat");
  assert.throws(() =>
    coreMessageSchema.parse({
      type: "heartbeat",
      at: 1,
      runningTaskCount: 1,
      runningTasks: [{ sessionId: "s", workspacePath: "/w", bogus: true }],
    }),
  );
});

test("T-RD2 runtimeIdentity schema：strict 往返", () => {
  const identity = runtimeIdentitySchema.parse({
    supervisorVersion: "1.0.0",
    supervisorReleaseId: "1.0.0-linux-x64-abc",
    activeReleaseVersion: "1.0.0",
    activeReleaseId: "1.0.0-linux-x64-abc",
    coreVersion: "1.0.0",
    coreReleaseId: "1.0.0-linux-x64-abc",
  });
  assert.equal(identity.supervisorVersion, "1.0.0");
  assert.throws(() => runtimeIdentitySchema.parse({ supervisorVersion: "1.0.0", bogus: 1 }));
});

test("T-RD2 daemon 生命周期纯函数：service/supervisor/fallback 三态", () => {
  assert.equal(shouldRegisterService(true, false), true);
  assert.equal(shouldRegisterService(true, true), false);
  assert.equal(shouldRegisterService(false, false), false);
  assert.equal(daemonStartupMode({ ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1" }), "fallback");
  assert.equal(daemonStartupMode({}), "service");
  assert.equal(serviceRegistrationEnabled({ ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1" }), false);
  assert.equal(isRegisteredServiceEntry(["serve", "--supervisor", "--service-entry"]), true);
  assert.equal(isRegisteredServiceEntry(["serve", "--supervisor"]), false);
});

test("T-RD2 停止预算常量化：三段预算来源唯一", () => {
  assert.equal(CORE_STOP_GRACE_TIMEOUT_MS, 5_000);
  assert.equal(CORE_KILL_TIMEOUT_MS, 10_000);
  assert.equal(CORE_READY_TIMEOUT_MS, 15_000);
  assert.equal(SERVER_STOP_WAIT_TIMEOUT_MS, 5_000 + 10_000 + 2_000 + 3_000);
});

test("T-RD2 排除面守卫（三期解禁后口径）：cli.ts migrate retry 经注入边界回接，serve 主链与 proxy-stdio 在位", async () => {
  const cliSource = await readFile(
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "utf8",
  );
  // P7（Step 18）起一期排除面解禁：migrate retry 经 SourceServerWorkspaceAliasRepo 回接，
  // 但必须保持「runtimeOptions.workspaceAliasRepo 注入口优先」的可测试边界（缺省才落新实例）。
  assert.ok(
    /import\s+\{[^}]*SourceServerWorkspaceAliasRepo[^}]*\} from "@zcode\/services\/node"/.test(
      cliSource,
    ),
    "cli.ts 缺少三期 aliasRepo import（解禁面）",
  );
  assert.ok(
    /runtimeOptions\.workspaceAliasRepo \?\? new SourceServerWorkspaceAliasRepo\(\)/.test(cliSource),
    "migrate retry 必须经 workspaceAliasRepo 注入口，不允许绕过测试边界直接实例化",
  );
  assert.ok(cliSource.includes("migrateRetryRequested"), "cli.ts 缺少 migrate retry 分支");
  assert.ok(
    cliSource.includes('"migrate"') && cliSource.includes('"retry"'),
    "cli.ts 缺少 migrate retry 命令识别",
  );
  for (const command of ["serve", "status", "running-tasks", "stop", "restart", "update", "uninstall"]) {
    assert.ok(cliSource.includes(`"${command}"`), `cli.ts 缺少 ${command} 命令分支`);
  }
  assert.ok(cliSource.includes("proxy-stdio"), "cli.ts 缺少 proxy-stdio 子命令");
  assert.ok(cliSource.includes("--from-archive"), "cli.ts 缺少 --from-archive 本地归档更新");
  // serve --daemon 命令链要素
  assert.ok(cliSource.includes("--daemon"));
  assert.ok(cliSource.includes("--supervisor"));
  assert.ok(cliSource.includes("isServiceManagerAvailable"));
});
