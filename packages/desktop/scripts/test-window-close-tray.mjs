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
 * 同文件另钉 spec §4 T-WIN-3 明文的「fake tray 抛错」口径：用同款替身加载
 * `../src/main/desktopTray.js`，令替身 `Tray` 构造函数抛错 → `createWindowsDesktopTray` 必须返回
 * null（`index.ts:1293` 的 `desktopTrayReady = createWindowsDesktopTray({...}) !== null` 由此拿到
 * false，fail-closed 才有输入）。该用例只覆盖返回值契约本身，不覆盖 :1293 的 `!== null` 映射行
 * （反写该映射行仍全绿；打包态由 T-WIN-2 手工验证承担，已在 fix-spec 登记）。
 *
 * 运行：`pnpm exec tsx --test packages/desktop/scripts/test-window-close-tray.mjs`
 * （脚本按构建产物 import 口径用 `.js` 说明符指向 TS 源码，需要 tsx 的 `.js`→`.ts` 解析；
 * 根 test:v4-perf 聚合同样以 `tsx --test` 运行。裸 `node --test` 解析不了该说明符。）
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// electron 替身：只提供被测模块 import 图里出现的具名导出（加载期不调用它们的行为）。
// Tray/Menu 额外记录实例与模板，供「托盘创建失败 → null」契约用例（T-WIN-3 fake tray 抛错）断言；
// 状态对象挂在 globalThis，替身模块在求值期捕获它的引用，因此重置只能原地清空字段。
const ELECTRON_STUB = `
const noop = () => {};
const trayStub = globalThis.__zcodeTrayStubState;
export const app = { on: noop, once: noop, whenReady: () => Promise.resolve(), getPath: () => "", commandLine: { appendSwitch: noop } };
export const BrowserWindow = class {};
export const Menu = class {
  static buildFromTemplate(template) {
    if (trayStub) trayStub.templates.push(template);
    return { template };
  }
};
export const MessageChannelMain = class {};
export const Notification = class {};
export const Tray = class {
  constructor(iconPath) {
    if (trayStub?.constructorThrows) throw new Error("tray-stub-constructor-throws");
    this.iconPath = iconPath;
    this.eventNames = [];
    this.toolTip = null;
    this.contextMenu = null;
    if (trayStub) trayStub.instances.push(this);
  }
  on(eventName, handler) {
    this.eventNames.push(eventName);
    return this;
  }
  setToolTip(value) {
    this.toolTip = value;
    if (trayStub) trayStub.toolTipSetCount += 1;
  }
  setContextMenu(menu) {
    this.contextMenu = menu;
    if (trayStub) trayStub.contextMenuSetCount += 1;
  }
};
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

/** 托盘替身状态：供 desktopTray.js 用例控制构造行为并观察绑定结果。 */
const trayStubState = {
  constructorThrows: false,
  instances: [],
  templates: [],
  toolTipSetCount: 0,
  contextMenuSetCount: 0,
};
globalThis.__zcodeTrayStubState = trayStubState;

function resetTrayStubState({ constructorThrows = false } = {}) {
  trayStubState.constructorThrows = constructorThrows;
  trayStubState.instances.length = 0;
  trayStubState.templates.length = 0;
  trayStubState.toolTipSetCount = 0;
  trayStubState.contextMenuSetCount = 0;
  return trayStubState;
}

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
const { createWindowsDesktopTray, updateWindowsDesktopTrayMenu } =
  await import("../src/main/desktopTray.js");

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

// process.platform 在 Node 下是 { writable: false, configurable: true }：desktopTray.ts:27 直读它
// 决定是否建托盘，这里用可恢复覆写注入 win32，让用例在非 Windows 机器上同样有效；finally 还原原描述符。
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function withWin32Platform(run) {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
    enumerable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

/** 建托盘所需的最小依赖替身；logger 收集 warn 供「创建失败要留痕」断言。 */
function trayOptions(warnings) {
  return {
    getLocale: () => "en-US",
    showCurrentWindow: () => {},
    executeDesktopCommand: async () => {},
    quitApp: () => {},
    logger: { warn: (...args) => warnings.push(args) },
  };
}

// 模块级缓存用例顺序说明（desktopTray.ts:11 初值、:31-33 早退守卫）：
// throw 态在 `desktopTray = new Tray(...)` 抛错时不会写缓存（赋值未发生），缓存仍为 null，
// 因此无需复制临时模块实例——先跑 throw 态、再跑正常态即可各自命中目标分支。
test("T-WIN-3 fake tray 抛错 → createWindowsDesktopTray 返回 null（desktopTrayReady=false 的来源）", () => {
  const state = resetTrayStubState({ constructorThrows: true });
  const warnings = [];

  const tray = withWin32Platform(() => createWindowsDesktopTray(trayOptions(warnings)));

  assert.equal(tray, null);
  assert.equal(state.instances.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /failed to create tray icon/u);
});

test("T-WIN-3 托盘正常创建 → 返回非 null，且上下文菜单/提示已绑定并命中缓存", () => {
  const state = resetTrayStubState();
  const warnings = [];

  const tray = withWin32Platform(() => createWindowsDesktopTray(trayOptions(warnings)));

  assert.notEqual(tray, null);
  assert.deepEqual(warnings, []);
  assert.equal(state.instances.length, 1);
  assert.equal(state.instances[0], tray);
  // 图标路径来自 app.isPackaged=false 的开发态分支，是字符串即可（不触发文件系统访问）。
  assert.equal(typeof tray.iconPath, "string");
  assert.deepEqual(tray.eventNames, ["click", "double-click"]);
  assert.equal(typeof tray.toolTip, "string");
  assert.ok(tray.toolTip.length > 0);
  assert.equal(state.toolTipSetCount, 1);
  assert.equal(state.contextMenuSetCount, 1);
  assert.equal(state.templates.length, 1);
  assert.ok(state.templates[0].some((item) => item.type === "separator"));

  // 语言切换时 index.ts 走 updateWindowsDesktopTrayMenu 重建菜单；同时验证 :31-33 缓存早退，
  // throw 态没有污染缓存，这里仍是同一个实例。
  updateWindowsDesktopTrayMenu();
  assert.equal(state.contextMenuSetCount, 2);
  assert.equal(state.instances.length, 1);
  withWin32Platform(() => {
    assert.equal(createWindowsDesktopTray(trayOptions([])), tray);
  });
  assert.equal(state.instances.length, 1);
});
