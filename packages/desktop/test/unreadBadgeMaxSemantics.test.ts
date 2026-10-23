/**
 * T-UF4（backlog-sweep Step 18）：未读角标 sum→max 语义 + Windows overlay/tray 红点接线。
 *
 * 形态沿用本仓 desktop 纯逻辑测试（node --test + node:assert，无 electron 运行时）：
 * `unreadBadge.ts` 不 import electron，可直接加载；electron 侧装配（窗口枚举 / nativeImage /
 * tray.setImage）由 `desktopWindowLifecycle.ts`、`desktopTray.ts` 承担，这里只做源码接线形状断言。
 *
 * 锁死的失效形态：多主窗口时所有窗口上报同一份「全局权威树计数」，若按下标求和，
 * 角标会随窗口数翻倍（2 窗口 × 3 未读 → 6）。修复=取 max。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyTaskbarOverlayToWindows,
  createWindowsTaskbarOverlayApplier,
  maxWindowUnreadCounts,
  parseWindowUnreadCount,
  renderAntialiasedStatusDotPixels,
  renderTaskbarBadgePixels,
  renderTaskbarStatusDotPixels,
  resolveBadgeOverlayLabel,
  supportsAppUnreadBadge,
  supportsWindowOverlayBadge,
  syncUnreadBadgeForPlatform,
  TASKBAR_BADGE_IMAGE_SIZE,
  type AntialiasedDotOptions,
  type BadgePixelOptions,
  type TaskbarOverlayLayout,
  type TaskbarOverlayWindow,
} from "../src/main/unreadBadge.js";
import { resolveMacOSMajorVersion } from "../src/main/desktopWindowChromeState.js";

const mainSrc = (name: string) => fileURLToPath(new URL(`../src/main/${name}`, import.meta.url));

const CIRCLE_RED_BGRA = [53, 57, 229, 255];

function pixelAt(pixels: Uint8Array, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

function createFakeWindow(options: { destroyed?: boolean } = {}): TaskbarOverlayWindow & {
  overlays: Array<{ image: unknown; description: string }>;
} {
  const overlays: Array<{ image: unknown; description: string }> = [];
  return {
    isDestroyed: () => Boolean(options.destroyed),
    setOverlayIcon: (image, description) => {
      overlays.push({ image, description });
    },
    overlays,
  };
}

test("T-UF4 核心：多窗口同值不翻倍（sum→max）", () => {
  const sameCount = new Map([
    [1, 3],
    [2, 3],
    [3, 0],
  ]);
  assert.equal(maxWindowUnreadCounts(sameCount), 3, "两窗口同报 3 未读只能是 3，不是 6");
  assert.equal(maxWindowUnreadCounts(new Map()), 0);
  assert.equal(maxWindowUnreadCounts(new Map([[7, 2]])), 2);
  // 窗口数放大时依然不叠加：五个窗口全报 9。
  assert.equal(maxWindowUnreadCounts(new Map([1, 2, 3, 4, 5].map((id) => [id, 9]))), 9);
});

test("T-UF4 上报解析只接受非负整数", () => {
  assert.equal(parseWindowUnreadCount(0), 0);
  assert.equal(parseWindowUnreadCount(3), 3);
  assert.equal(parseWindowUnreadCount(-1), null);
  assert.equal(parseWindowUnreadCount(1.5), null);
  assert.equal(parseWindowUnreadCount("2"), null);
  assert.equal(parseWindowUnreadCount(null), null);
});

test("T-UF4 overlay 文案：0 清除、1~9 原样、10 以上折叠为 9+", () => {
  assert.equal(resolveBadgeOverlayLabel(0), null);
  assert.equal(resolveBadgeOverlayLabel(7), "7");
  assert.equal(resolveBadgeOverlayLabel(9), "9");
  assert.equal(resolveBadgeOverlayLabel(10), "9+");
  assert.equal(resolveBadgeOverlayLabel(999), "9+");
  assert.equal(resolveBadgeOverlayLabel(-3), null);
});

test("T-UF4 平台分叉：macOS/Linux 写 app badge 不碰 overlay，Windows 反之", () => {
  assert.equal(supportsAppUnreadBadge("darwin"), true);
  assert.equal(supportsAppUnreadBadge("linux"), true);
  assert.equal(supportsAppUnreadBadge("win32"), false);

  const darwinBadge: number[] = [];
  let darwinOverlayCalls = 0;
  syncUnreadBadgeForPlatform({
    platform: "darwin",
    totalUnreadCount: 4,
    setBadgeCount: (count) => darwinBadge.push(count),
    applyOverlay: () => {
      darwinOverlayCalls += 1;
    },
  });
  assert.deepEqual(darwinBadge, [4]);
  assert.equal(darwinOverlayCalls, 0);

  const windowsBadgeCalls: number[] = [];
  const windowsOverlay: Array<string | null> = [];
  syncUnreadBadgeForPlatform({
    platform: "win32",
    totalUnreadCount: 3,
    setBadgeCount: (count) => windowsBadgeCalls.push(count),
    applyOverlay: (label) => windowsOverlay.push(label),
  });
  assert.deepEqual(windowsOverlay, ["3"]);
  assert.deepEqual(windowsBadgeCalls, [], "Windows 不得写 app badge（app.setBadgeCount 是 no-op）");

  windowsOverlay.length = 0;
  syncUnreadBadgeForPlatform({
    platform: "win32",
    totalUnreadCount: 0,
    setBadgeCount: () => {},
    applyOverlay: (label) => windowsOverlay.push(label),
  });
  assert.deepEqual(windowsOverlay, [null], "未读归零必须下发 null 移除 overlay");

  // 通道归属：Windows 走 overlay，macOS/Linux 走 app badge。
  assert.equal(supportsWindowOverlayBadge("win32"), true);
  assert.equal(supportsWindowOverlayBadge("darwin"), false);
  assert.equal(supportsWindowOverlayBadge("linux"), false);
});

test("T-UF4 Windows overlay：16px 抗锯齿红点，两代布局圆心不同", () => {
  const layouts: TaskbarOverlayLayout[] = ["windows-11", "windows-10"];
  assert.deepEqual(layouts, ["windows-11", "windows-10"]);

  const win11 = renderTaskbarStatusDotPixels(1, layouts[0]);
  assert.equal(win11.length, 16 * 16 * 4);
  assert.deepEqual(pixelAt(win11, 16, 8, 8), CIRCLE_RED_BGRA, "Win11 红点在画布内居中");
  assert.deepEqual(pixelAt(win11, 16, 0, 0), [0, 0, 0, 0]);

  const win10 = renderTaskbarStatusDotPixels(1, layouts[1]);
  assert.deepEqual(pixelAt(win10, 16, 11, 11), CIRCLE_RED_BGRA, "Win10 红点在画布内右下锚定");
  assert.notDeepEqual(pixelAt(win10, 16, 8, 8), CIRCLE_RED_BGRA, "Win10 与 Win11 必须是两套圆心");

  const highDpi = renderTaskbarStatusDotPixels(2, layouts[0]);
  assert.equal(highDpi.length, 32 * 32 * 4);
  assert.deepEqual(pixelAt(highDpi, 32, 16, 16), CIRCLE_RED_BGRA);

  // 托盘红点走同一渲染器但几何参数独立（小尺寸圆点 + 4× 超采样边缘半透明）。
  const dotOptions: BadgePixelOptions = { size: 16, padding: 4, dot: true, anchor: "bottom-right" };
  const dot = renderTaskbarBadgePixels("9+", dotOptions);
  assert.equal(dot.length, 16 * 16 * 4);
  assert.equal(
    dot.some((value, index) => index % 4 === 0 && value > 0),
    true,
    "红点必须有可见像素",
  );

  const antialiasOptions: AntialiasedDotOptions = { size: 8, centerX: 4, centerY: 4, radius: 4 };
  const antialiased = renderAntialiasedStatusDotPixels(antialiasOptions);
  assert.equal(antialiased.length, 8 * 8 * 4);
  assert.deepEqual(pixelAt(antialiased, 8, 4, 4), CIRCLE_RED_BGRA);
  assert.deepEqual(pixelAt(antialiased, 8, 0, 0), [0, 0, 0, 0]);
});

test("T-UF4 数字徽章像素：尺寸契约 + 圆外透明 + 笔画白色", () => {
  const pixels = renderTaskbarBadgePixels("1");
  assert.ok(pixels instanceof Uint8Array);
  assert.equal(pixels.length, TASKBAR_BADGE_IMAGE_SIZE * TASKBAR_BADGE_IMAGE_SIZE * 4);
  // 圆心落在数字 1 的笔画上是白色，圆外是全透明（预乘后全 0）。
  assert.deepEqual(pixelAt(pixels, TASKBAR_BADGE_IMAGE_SIZE, 16, 16), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(pixels, TASKBAR_BADGE_IMAGE_SIZE, 4, 16), CIRCLE_RED_BGRA);
  assert.deepEqual(pixelAt(pixels, TASKBAR_BADGE_IMAGE_SIZE, 0, 0), [0, 0, 0, 0]);
});

test("T-UF4 overlay 下发：跳过已销毁窗口 + 徽章图按 label 缓存", () => {
  const alive = createFakeWindow();
  const destroyed = createFakeWindow({ destroyed: true });
  const image = { badge: true };

  applyTaskbarOverlayToWindows({
    label: "3",
    windows: [destroyed, alive],
    badgeImageForLabel: () => image,
  });
  assert.equal(destroyed.overlays.length, 0, "已销毁窗口不得 setOverlayIcon");
  assert.deepEqual(alive.overlays, [{ image, description: "3 unread tasks" }]);

  const createBadgeImageCalls: string[] = [];
  const applier = createWindowsTaskbarOverlayApplier({
    getAllWindows: () => [alive],
    createBadgeImage: (label) => {
      createBadgeImageCalls.push(label);
      return { label };
    },
  });
  applier("2");
  applier("2");
  assert.deepEqual(createBadgeImageCalls, ["2"], "同一 label 只渲染一次徽章图");
});

test("T-UF4 接线形状：lifecycle 用 max + overlay + 托盘，tray/chromeState 导出在位", async () => {
  const lifecycle = await readFile(mainSrc("desktopWindowLifecycle.ts"), "utf8");
  assert.ok(
    lifecycle.includes("maxWindowUnreadCounts(windowUnreadCountMap)"),
    "lifecycle 必须用 max 聚合窗口未读",
  );
  assert.ok(!lifecycle.includes("sumWindowUnreadCounts"), "sum 形态必须零残留");
  assert.ok(lifecycle.includes("applyOverlay: applyWindowsTaskbarOverlay"));
  assert.ok(lifecycle.includes("applyDesktopTrayUnreadBadge(totalUnreadCount)"));
  assert.ok(lifecycle.includes("BrowserWindow.getAllWindows()"), "overlay 必须下发所有窗口");
  assert.ok(
    lifecycle.includes("supportsNativeWindowsRoundedCorners("),
    "overlay 圆心布局必须按 Win11 圆角能力分代",
  );

  const tray = await readFile(mainSrc("desktopTray.ts"), "utf8");
  assert.ok(tray.includes("export function applyDesktopTrayUnreadBadge"));
  assert.ok(tray.includes("blendBadgeIntoBitmap("), "托盘红点走预乘 alpha 合成");
  assert.ok(tray.includes("desktopTray.setImage("), "红点必须真正贴到托盘图");

  const chromeState = await readFile(mainSrc("desktopWindowChromeState.ts"), "utf8");
  assert.ok(chromeState.includes("export function supportsNativeWindowsRoundedCorners("));
  assert.ok(chromeState.includes("export function resolveMacOSMajorVersion("));
});

test("T-UF4 chromeState 常量：Tahoe 版本跳跃映射 + 非 darwin 返回 null", () => {
  // Darwin 24 = macOS 15；Darwin 25 起产品版本从 15 跳到 26，不能再套 -9。
  assert.equal(resolveMacOSMajorVersion("darwin", "24.6.0"), 15);
  assert.equal(resolveMacOSMajorVersion("darwin", "23.5.0"), 14);
  assert.equal(resolveMacOSMajorVersion("darwin", "25.0.0"), 26);
  assert.equal(resolveMacOSMajorVersion("win32", "10.0.26200"), null);
  assert.equal(resolveMacOSMajorVersion("darwin", "not-a-version"), null);
});
