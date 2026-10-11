#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-WIN-3——托盘创建失败时不得隐藏窗口（fail-closed 裁决）。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P5 #32）
 * ============================================================================
 *
 * 失效形态：窗口关闭时若把窗口隐藏进托盘，而**托盘其实没建起来**（图标缺失 / 会话未就绪抛错 /
 * 平台不支持），用户就再也没有任何可见入口——应用等于失联，只能杀进程。
 * 修复的裁决：`desktopTrayReady` 必须显式 true 才允许隐藏（fail-closed），否则落到「确认退出」
 * 那条路（用户至少知道应用真的退了）。
 *
 * 测试法：desktop 的 main 侧模块整体 import electron（本仓无 desktop 测试基建，也没有 electron
 * 运行时），所以用 `node:module` 的 resolve 钩子把 `electron` 换成**最小替身**，再直接调用
 * `handleDesktopWindowCloseRequest` 这个纯裁决函数。
 *
 * 运行：`node --test scripts/test-window-close-tray.mjs`
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// electron 替身：只提供被测模块 import 图里出现的具名导出（加载期不调用它们的行为）。
const ELECTRON_STUB = `
const noop = () => {};
export const app = { on: noop, once: noop, whenReady: () => Promise.resolve(), getPath: () => "", commandLine: { appendSwitch: noop } };
export const BrowserWindow = class {};
export const Menu = class {};
export const MessageChannelMain = class {};
export const Notification = class {};
export const Tray = class {};
export const UtilityProcess = class {};
export const dialog = { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
export const ipcMain = { on: noop, once: noop, handle: noop, removeHandler: noop };
export const nativeImage = { createFromPath: () => ({}), createEmpty: () => ({}) };
export const nativeTheme = { on: noop, shouldUseDarkColors: false };
export const powerSaveBlocker = { start: () => 1, stop: noop, isStarted: () => false };
export const screen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 1 }), on: noop };
export const session = { fromPartition: () => ({ webRequest: { onBeforeSendHeaders: noop } }) };
export const shell = { openExternal: async () => {} };
export const utilityProcess = { fork: () => ({ on: noop, postMessage: noop, kill: noop }) };
export const webContents = { getAllWebContents: () => [] };
export const webFrame = {};
export const webUtils = { getPathForFile: () => "" };
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

const { handleDesktopWindowCloseRequest } = await import("../src/main/desktopWindowLifecycle.js");

/** 记录裁决产生的动作。 */
function calls() {
  const seen = [];
  return {
    seen,
    base(overrides = {}) {
      return {
        platform: "win32",
        closeToTrayOnWindows: true,
        isLastWindow: true,
        label: "main",
        logger: { info: () => {} },
        shouldConfirmQuit: true,
        confirmQuit: () => true,
        hideWindow: () => seen.push("hide"),
        requestQuit: () => seen.push("quit"),
        ...overrides,
      };
    },
  };
}

test("T-WIN-3 托盘未就绪（创建失败）→ 不隐藏窗口，走确认退出", () => {
  const { seen, base } = calls();
  // 用户确认退出：请求退出、不隐藏。
  const handled = handleDesktopWindowCloseRequest(base({ desktopTrayReady: false }));
  assert.equal(handled, true);
  assert.deepEqual(seen, ["quit"]);
});

test("T-WIN-3 托盘未就绪且用户取消确认 → 什么都不做（窗口仍在）", () => {
  const { seen, base } = calls();
  handleDesktopWindowCloseRequest(base({ desktopTrayReady: false, confirmQuit: () => false }));
  assert.deepEqual(seen, []);
});

test("T-WIN-3 托盘就绪才允许隐藏（且必须显式 true）", () => {
  const ready = calls();
  handleDesktopWindowCloseRequest(ready.base({ desktopTrayReady: true }));
  assert.deepEqual(ready.seen, ["hide"]);

  // 缺省（未声明托盘状态）按 fail-closed 处理：不隐藏。
  const missing = calls();
  handleDesktopWindowCloseRequest(missing.base({}));
  assert.deepEqual(missing.seen, ["quit"]);
});

test("T-WIN-3 托盘就绪但已显式退出 / 强制退出时不隐藏", () => {
  const explicit = calls();
  handleDesktopWindowCloseRequest(
    explicit.base({ desktopTrayReady: true, explicitQuitRequested: true }),
  );
  assert.deepEqual(explicit.seen, ["quit"]);

  const forced = calls();
  handleDesktopWindowCloseRequest(forced.base({ desktopTrayReady: true, forceQuit: true }));
  assert.deepEqual(forced.seen, []);
});

test("T-WIN-3 非 Windows 与多窗口场景不走托盘裁决", () => {
  const darwin = calls();
  handleDesktopWindowCloseRequest(darwin.base({ platform: "darwin", desktopTrayReady: true }));
  assert.deepEqual(darwin.seen, []);

  const notLastWindow = calls();
  handleDesktopWindowCloseRequest(
    notLastWindow.base({ isLastWindow: false, desktopTrayReady: false }),
  );
  assert.deepEqual(notLastWindow.seen, []);
});
