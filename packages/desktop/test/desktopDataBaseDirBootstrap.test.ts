import { describe, expect, it } from "vitest";
import {
  extractBootstrapDataBaseDir,
  resolveBootstrapSettingsFile,
} from "../src/main/desktopDataBaseDirBootstrap.js";

describe("desktopDataBaseDirBootstrap", () => {
  it("应从 bootstrap setting 中提取并裁剪 dataBaseDir", () => {
    expect(
      extractBootstrapDataBaseDir({
        dataBaseDir: "  /tmp/zcode-data  ",
      }),
    ).toBe("/tmp/zcode-data");
  });

  it("应忽略无效的 bootstrap 配置", () => {
    expect(extractBootstrapDataBaseDir(null)).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: "" })).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: 123 })).toBeNull();
  });

  it("应拼出默认 bootstrap setting 路径", () => {
    const result = resolveBootstrapSettingsFile("/Users/tester");
    // Windows 下 path.join 使用反斜杠，统一为正斜杠后再比较
    // FORK(upgrade-316)：fork 数据根目录是 ~/.omz（见 desktopDataBaseDirBootstrap.ts 的
    // resolveBootstrapSettingsFile），上游断言的 .zcode 路径在 fork 语义下不成立。
    expect(result.replace(/\\/g, "/")).toBe(
      "/Users/tester/.omz/v2/setting.json",
    );
  });
});
