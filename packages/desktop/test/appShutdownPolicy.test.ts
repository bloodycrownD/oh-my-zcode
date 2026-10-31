import { describe, expect, it } from "vitest";
import { resolveAppShutdownPolicy } from "../src/main/appShutdownPolicy.js";

// FORK: 自动更新链路（autoUpdater / update-install 退出类型）已在 fork 删除，
// 退出策略退化为按平台二选一；上游的 selectAppShutdownPolicy(kind) 选择器不再回归。
describe("app shutdown policy", () => {
  it("shortens frequent normal Windows shutdowns", () => {
    expect(resolveAppShutdownPolicy("win32")).toEqual({
      forceKillDelayMs: 4_000,
      waitTimeoutMs: 4_500,
    });
  });

  it("keeps the strict non-Windows shutdown budget", () => {
    expect(resolveAppShutdownPolicy("darwin")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
    expect(resolveAppShutdownPolicy("linux")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
  });
});
