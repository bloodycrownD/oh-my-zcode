import { app, Menu, nativeImage, Tray } from "electron";
import type { NativeImage } from "electron";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import {
  blendBadgeIntoBitmap,
  renderAntialiasedStatusDotPixels,
  resolveBadgeOverlayLabel,
} from "./unreadBadge.js";

let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;
let trayLogger: { warn: (...args: unknown[]) => void } | null = null;

// 托盘图在 Windows 通知区域实际显示约 16px。为避免把普通 32px 合成图交给 Shell
// 盲缩导致红点发糊，分别合成原生 1x(16px) 与 2x(32px) 表示；红点尺寸独立于任务栏。
const TRAY_LOGICAL_SIZE = 16;

let trayBaseImage: NativeImage | null = null;
// 单槽缓存：红点图形与 label（未读数）无关——托盘 tooltip 恒为静态品牌名，未读数在这里
// 只当「是否非零」的布尔闸，不进任何文案（无障碍描述在任务栏 overlay 侧生成）。
// 之前按 label 存 10 张视觉等价的 nativeImage，纯属重复渲染。
let trayBadgeImage: NativeImage | null = null;

function resolveDesktopTrayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

export function createWindowsDesktopTray(options: {
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (process.platform !== "win32") {
    return null;
  }

  if (desktopTray) {
    return desktopTray;
  }

  try {
    desktopTray = new Tray(resolveDesktopTrayIconPath());
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }
  trayLogger = options.logger;

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    void Promise.resolve(options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  const rebuildContextMenu = () => {
    desktopTray?.setToolTip(getLabel(desktopMenuMessageIds.trayTooltip));
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: getLabel(desktopMenuMessageIds.trayOpenZCode),
          click: showTrayWindow,
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          click: () => executeTrayCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          click: () => executeTrayCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.helpAbout),
          click: () => executeTrayCommand(DesktopCommandIds.ShowAbout),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => executeTrayCommand(DesktopCommandIds.ClearAllData),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.trayQuit),
          click: () => options.quitApp(),
        },
      ]),
    );
  };

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}

function loadTrayBaseImage(): NativeImage | null {
  if (trayBaseImage && !trayBaseImage.isEmpty()) {
    return trayBaseImage;
  }

  try {
    trayBaseImage = nativeImage.createFromPath(resolveDesktopTrayIconPath());
  } catch (error) {
    trayLogger?.warn("[desktop-tray] failed to load tray base image for badge", error);
    return null;
  }
  return trayBaseImage.isEmpty() ? null : trayBaseImage;
}

function composeTrayBadgeRepresentation(baseImage: NativeImage, scale: 1 | 2): Buffer | null {
  const size = TRAY_LOGICAL_SIZE * scale;
  const resized = baseImage.resize({ width: size, height: size });
  const bitmap = resized.toBitmap();
  if (bitmap.length !== size * size * 4) {
    trayLogger?.warn(
      `[desktop-tray] unexpected tray bitmap size ${bitmap.length}, skip badge compose`,
    );
    return null;
  }

  const canvas = new Uint8Array(bitmap);
  // 托盘保持约 8px 逻辑直径，右上角完整圆；4× 超采样后按原生尺寸合成。
  const dotSize = 5 * scale;
  const badge = renderAntialiasedStatusDotPixels({
    size: dotSize,
    centerX: 2.75 * scale,
    centerY: 2.25 * scale,
    radius: 1.875 * scale,
  });
  blendBadgeIntoBitmap({
    base: canvas,
    size,
    badge,
    badgeSize: dotSize,
    originX: size - dotSize,
    originY: 0,
  });
  return Buffer.from(canvas);
}

function composeTrayBadgeImage(baseImage: NativeImage): NativeImage | null {
  if (trayBadgeImage) return trayBadgeImage;

  const oneX = composeTrayBadgeRepresentation(baseImage, 1);
  const twoX = composeTrayBadgeRepresentation(baseImage, 2);
  if (!oneX || !twoX) return null;

  const image = nativeImage.createEmpty();
  image.addRepresentation({
    scaleFactor: 1,
    width: 16,
    height: 16,
    buffer: oneX,
  });
  image.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: twoX,
  });
  trayBadgeImage = image;
  return image;
}

// 未读计数变化时同步托盘角标：非零在图标右上角贴红点徽章，零恢复原图。
// macOS 无托盘（createWindowsDesktopTray 返回 null），由 Dock 角标承担，这里天然 no-op。
export function applyDesktopTrayUnreadBadge(totalUnreadCount: number): void {
  if (!desktopTray) {
    return;
  }

  const label = resolveBadgeOverlayLabel(totalUnreadCount);
  if (!label) {
    const base = loadTrayBaseImage();
    if (base) {
      desktopTray.setImage(base);
    }
    return;
  }

  const base = loadTrayBaseImage();
  if (!base) {
    return;
  }

  const image = composeTrayBadgeImage(base);
  if (image) {
    desktopTray.setImage(image);
  }
}
