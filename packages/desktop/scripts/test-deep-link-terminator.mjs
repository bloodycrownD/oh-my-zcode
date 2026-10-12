#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）d/G-2——深链协议注册 `--` 终止符 + win32 fuses 配置钉子。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 #30）
 * ============================================================================
 *
 * 失效形态：Windows 注册 `zcode://` URL scheme 时若不追加 `--` 终止符，系统把外部 URL 拼进
 * 应用命令行后，URL 里带引号的片段会被 Electron/Chromium 当成启动开关执行（`--inspect-brk`、
 * `--user-data-dir=...`）。原生 Inspector 早于应用 JS 与单实例锁启动，后续 `handleDeepLink`
 * 的 URL 校验拦不住它。
 * 修复的裁决：①注册时 win32 一律让 args 以 `--` 收尾（开发态 `[entry, "--"]`，打包态 `["--"]`）；
 * ②打包配置在 win32 分支关闭 `enableNodeCliInspectArguments`，兜住旧注册表里已写入的
 * `--inspect-brk`，覆盖升级后首次启动。
 *
 * 测试法：desktop main 侧模块直接 import electron（本仓没有 desktop 测试基建，也没有 electron
 * 运行时），沿用 test-window-close-tray.mjs 的 `node:module` resolve 钩子替身范式，由替身捕获
 * `app.setAsDefaultProtocolClient` 的全部实参。`registerDeepLinkProtocol` 直读
 * `process.platform` / `process.defaultApp` / `process.argv`（无注入 seam），因此用可恢复的
 * `Object.defineProperty` 覆写驱动，每个用例结束在 finally 里还原原值。
 *
 * 运行：`pnpm exec tsx --test packages/desktop/scripts/test-deep-link-terminator.mjs`
 * （与 test-window-close-tray.mjs 同法：脚本按构建产物 import 口径用 `.js` 说明符指向 TS 源码，
 * 依赖 tsx 的 `.js`→`.ts` 解析；根 test:v4-perf 聚合同样以 `tsx --test` 运行）
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

/** 替身状态放在 globalThis，data: URL 替身模块与用例共享同一份。 */
const STUB_STATE_KEY = "__zcodeDeepLinkElectronStubState";

// 替身模块在求值期就把该对象引用存进闭包，因此重置只能原地清空字段，
// 不能替换对象（否则替身仍往旧对象里写，用例读到空记录）。
const stubState = { protocolClientCalls: [], registrationSucceeds: true };
globalThis[STUB_STATE_KEY] = stubState;

function resetStubState({ registrationSucceeds = true } = {}) {
  stubState.protocolClientCalls.length = 0;
  stubState.registrationSucceeds = registrationSucceeds;
  return stubState;
}

// electron 替身：只提供被测模块 import 图里出现的具名导出；setAsDefaultProtocolClient 记录实参。
const ELECTRON_STUB = `
const noop = () => {};
const state = globalThis.${STUB_STATE_KEY};
export const app = {
  on: noop,
  once: noop,
  whenReady: () => Promise.resolve(),
  getPath: () => "",
  commandLine: { appendSwitch: noop },
  isPackaged: false,
  setAsDefaultProtocolClient: (...args) => {
    state.protocolClientCalls.push(args);
    return state.registrationSucceeds;
  },
};
export const BrowserWindow = class {};
export const dialog = {
  showMessageBox: async () => ({ response: 0 }),
  showMessageBoxSync: () => 0,
};
export const shell = { openExternal: async () => {} };
export default { app };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return {
        url: `data:text/javascript,${encodeURIComponent(ELECTRON_STUB)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

resetStubState();

const { registerDeepLinkProtocol } = await import("../src/main/desktopDeepLinkRouter.js");

function createLogger() {
  const events = [];
  return {
    events,
    info: (...args) => events.push(["info", ...args]),
    warn: (...args) => events.push(["warn", ...args]),
  };
}

// process.platform 在 Node 下是 { writable: false, configurable: true }：只能 defineProperty 覆写，
// 还原时必须写回原始描述符而不是直接赋值。process.defaultApp 只有 Electron 会注入（Node 下不存在），
// 还原成 delete。process.argv 可写，直接换回原数组。
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalDefaultAppDescriptor = Object.getOwnPropertyDescriptor(process, "defaultApp");
const originalArgv = process.argv;

/** 按传入的 process 状态执行被测函数，结束后无条件还原，避免污染同进程其它用例。 */
function withProcessState({ platform, defaultApp, argv }, run) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    enumerable: true,
  });
  if (defaultApp === undefined) {
    delete process.defaultApp;
  } else {
    process.defaultApp = defaultApp;
  }
  if (argv) {
    process.argv = argv;
  }

  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
    if (originalDefaultAppDescriptor) {
      Object.defineProperty(process, "defaultApp", originalDefaultAppDescriptor);
    } else {
      delete process.defaultApp;
    }
    process.argv = originalArgv;
  }
}

test("d/G-2 深链注册 win32 开发态（defaultApp）：args 以 -- 收尾，URL 进不了启动开关位", () => {
  const state = resetStubState();
  const logger = createLogger();
  const entry = "C:/apps/zcode/main.js";

  withProcessState(
    { platform: "win32", defaultApp: true, argv: ["C:/apps/zcode/electron.exe", entry] },
    () => registerDeepLinkProtocol(logger),
  );

  assert.equal(state.protocolClientCalls.length, 1);
  const [scheme, execPath, args] = state.protocolClientCalls[0];
  assert.equal(scheme, "zcode");
  assert.equal(execPath, process.execPath);
  assert.equal(args.length, 2);
  assert.equal(args[0], resolve(entry));
  assert.equal(args.at(-1), "--");
  // 开发态注册成功路径不应产生告警。
  assert.deepEqual(
    logger.events.map((event) => event[0]),
    ["info"],
  );
});

test('d/G-2 深链注册 win32 打包态（非 defaultApp）：args 恰为 ["--"]', () => {
  const state = resetStubState();

  withProcessState({ platform: "win32", defaultApp: undefined }, () =>
    registerDeepLinkProtocol(createLogger()),
  );

  // 打包态只有两个实参分支：win32 追加终止符，其它平台保持 (scheme)。
  assert.deepEqual(state.protocolClientCalls, [["zcode", process.execPath, ["--"]]]);
});

test("d/G-2 深链注册非 win32（darwin/linux）：一律不追加 --", () => {
  const entry = "C:/apps/zcode/main.js";

  for (const platform of ["darwin", "linux"]) {
    for (const defaultApp of [undefined, true]) {
      const state = resetStubState();
      withProcessState({ platform, defaultApp, argv: ["/opt/zcode/electron", entry] }, () =>
        registerDeepLinkProtocol(createLogger()),
      );

      assert.equal(state.protocolClientCalls.length, 1, `${platform}/defaultApp=${defaultApp}`);
      const [, , args] = state.protocolClientCalls[0];
      // 非 win32 分支不传第三参；开发态分支传 [entry]（无终止符）。
      assert.equal(args?.includes("--") ?? false, false, `${platform}/defaultApp=${defaultApp}`);
      if (defaultApp === true) {
        assert.deepEqual(args, [resolve(entry)]);
      } else {
        assert.equal(args, undefined);
      }
    }
  }
});

test("d/G-2 注册失败只记警告、不抛出（返回契约不变）", () => {
  const state = resetStubState({ registrationSucceeds: false });
  const logger = createLogger();

  withProcessState({ platform: "win32", defaultApp: undefined }, () =>
    registerDeepLinkProtocol(logger),
  );

  assert.equal(state.protocolClientCalls.length, 1);
  assert.deepEqual(
    logger.events.map((event) => event[0]),
    ["warn"],
  );
});

test("d/G-2 electron-builder win32 分支关闭原生 Inspector 参数（fuses 配置断言）", async () => {
  const originalTargetOs = process.env.ZCODE_TARGET_OS;

  try {
    // 按目标平台分别取一份「新鲜」配置实例：配置文件在模块求值期读 ZCODE_TARGET_OS，
    // 用 query 后缀绕过模块缓存，才能在同一进程里断言两种分支。
    process.env.ZCODE_TARGET_OS = "win32";
    const winConfig = (await import("../electron-builder.config.js?d-g-2-win32")).default;
    assert.equal(winConfig.electronFuses?.enableNodeCliInspectArguments, false);

    process.env.ZCODE_TARGET_OS = "darwin";
    const macConfig = (await import("../electron-builder.config.js?d-g-2-darwin")).default;
    // 非 win32 分支不得整体打开 fuses 开关（避免把 win32 的裁决外溢成全平台行为变更）。
    assert.equal(macConfig.electronFuses, undefined);
  } finally {
    if (originalTargetOs === undefined) {
      delete process.env.ZCODE_TARGET_OS;
    } else {
      process.env.ZCODE_TARGET_OS = originalTargetOs;
    }
  }
});
