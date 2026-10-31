import { describe, expect, it } from "vitest";

// FORK: OAuth / payment / share import 深链面已随官方登录、计费与会话分享删除，
// 本文件只保留 workspace open、argv 提取与 Windows 右键菜单（omz 品牌）。
describe("desktop deep link url helpers", () => {
  it("recognizes workspace open urls and extracts the encoded folder path", async () => {
    const { extractWorkspaceOpenPath, isWorkspaceOpenUrl } =
      await import("../src/main/desktopDeepLinkUrl.js");

    const workspaceUrl = new URL("zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%20A%26B");
    expect(isWorkspaceOpenUrl(workspaceUrl)).toBe(true);
    expect(extractWorkspaceOpenPath(workspaceUrl)).toBe("/Users/demo/Project A&B");
    expect(isWorkspaceOpenUrl(new URL("zcode://workspace/other?path=%2Ftmp"))).toBe(false);
    expect(extractWorkspaceOpenPath(new URL("zcode://workspace/open"))).toBeNull();
  });

  it("extracts protocol urls from desktop argv variants", async () => {
    const { extractDeepLinkUrlFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "zcode://oauth/callback?code=1&state=s"]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "--open-url=zcode://oauth/callback?code=1&state=s",
      ]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode%3A%2F%2Foauth%2Fcallback%3Fcode%3D1%26state%3Ds",
      ]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode%253A%252F%252Foauth%252Fcallback%253Fcode%253D1%2526state%253Ds",
      ]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    // FORK: 深链完整性判定不再理解 OAuth 的 state 参数（官方登录面已删），
    // 相邻 argv 的 "&state=s" 不再强制拼回，首个完整 URL 直接返回。
    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "zcode://oauth/callback?code=1", "&state=s"]),
    ).toBe("zcode://oauth/callback?code=1");
    // workspace URL 的完整性仍要求 path 参数，因此会继续尝试拼接相邻 argv。
    expect(
      extractDeepLinkUrlFromArgs([
        "/Applications/ZCode.app/Contents/MacOS/ZCode",
        "zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A",
      ]),
    ).toBe("zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A");
  });

  it("returns null when argv does not contain a deep link", async () => {
    const { extractDeepLinkUrlFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "--no-sandbox"])).toBeNull();
  });

  it("extracts Windows open workspace argv without URL decoding", async () => {
    const { extractOpenWorkspacePathFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(
      extractOpenWorkspacePathFromArgs([
        "C:\\Program Files\\ZCode\\ZCode.exe",
        "--open-workspace",
        "C:\\Users\\demo\\Project A&B#1",
      ]),
    ).toBe("C:\\Users\\demo\\Project A&B#1");
    expect(
      extractOpenWorkspacePathFromArgs([
        "C:\\Program Files\\ZCode\\ZCode.exe",
        "--open-workspace=C:\\Users\\demo\\Project%20A",
      ]),
    ).toBe("C:\\Users\\demo\\Project%20A");
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace", 'C:"'])).toBe("C:\\");
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace", 'C:\\repo"'])).toBe(
      "C:\\repo\\",
    );
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace"])).toBeNull();
  });

  it("passes parsed deep links through single instance additionalData", async () => {
    const {
      createDeepLinkSingleInstanceData,
      extractDeepLinkUrlFromSingleInstanceData,
      extractOpenWorkspacePathFromSingleInstanceData,
    } = await import("../src/main/desktopDeepLinkUrl.js");

    const additionalData = createDeepLinkSingleInstanceData([
      "/opt/ZCode/zcode",
      "zcode%253A%252F%252Foauth%252Fcallback%253Fcode%253D1%2526state%253Ds",
      "--open-workspace=C:\\Users\\demo\\Project A",
    ]);

    expect(extractDeepLinkUrlFromSingleInstanceData(additionalData)).toBe(
      "zcode://oauth/callback?code=1&state=s",
    );
    expect(extractOpenWorkspacePathFromSingleInstanceData(additionalData)).toBe(
      "C:\\Users\\demo\\Project A",
    );
    expect(extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: "https://example.com" })).toBe(
      null,
    );
  });

  it("builds Windows Explorer registry operations for folder context menu", async () => {
    const { buildWindowsOpenFolderCommand, buildWindowsOpenFolderRegistryOperations } =
      await import("../src/main/desktopWindowsOpenFolderContextMenu.js");

    expect(buildWindowsOpenFolderCommand("C:\\Program Files\\ZCode\\ZCode.exe")).toBe(
      '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
    );
    expect(
      buildWindowsOpenFolderCommand("C:\\Electron\\electron.exe", ["C:\\repo\\desktop\\main.js"]),
    ).toBe('"C:\\Electron\\electron.exe" "C:\\repo\\desktop\\main.js" --open-workspace "%1"');

    // FORK: 右键菜单注册键与文案均为 omz 品牌；旧 ZCode 键仅在安装时清理，不进操作清单。
    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
      locale: "en-US",
    });

    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\omz.OpenInOmz\\command",
        "/ve",
        "/d",
        '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
        "/f",
      ],
    });
    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Drive\\shell\\omz.OpenInOmz\\command",
        "/ve",
        "/d",
        '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
        "/f",
      ],
    });
  });

  it("builds localized Windows Explorer registry menu labels", async () => {
    const { buildWindowsOpenFolderRegistryOperations, getWindowsOpenFolderMenuName } =
      await import("../src/main/desktopWindowsOpenFolderContextMenu.js");

    expect(getWindowsOpenFolderMenuName("zh-CN")).toBe("在 omz 中打开");
    expect(getWindowsOpenFolderMenuName("en-US")).toBe("Open in omz");

    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
      locale: "zh-CN",
    });

    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\omz.OpenInOmz",
        "/ve",
        "/d",
        "在 omz 中打开",
        "/f",
      ],
    });
    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\omz.OpenInOmz",
        "/v",
        "MUIVerb",
        "/t",
        "REG_SZ",
        "/d",
        "在 omz 中打开",
        "/f",
      ],
    });
  });
});
