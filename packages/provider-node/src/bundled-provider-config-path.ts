import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ResolveBundledZCodeBuiltinProviderConfigPathInput {
  /**
   * 当前进程真实入口所在目录（CLI 为 dist；桌面打包态 agent 为 resources/glm；
   * 桌面开发态为 app 包根）。
   */
  readonly entryDirectory: string;
}

/**
 * FORK（cr-fix-v1.0.1 DF-A-1）：随包基线路径解析的单一事实来源，CLI 与桌面 Main 共用。
 *
 * 桌面打包态 agent 入口是 `<app>/resources/glm/zcode.cjs`，基线在
 * `<app>/resources/config/provider/zcode-builtin.json`（electron-builder extraResources
 * `to: "config/provider/zcode-builtin.json"`）。此前 CLI 侧候选清单缺这一布局：打包桌面
 * 携带 stale 显式覆盖时解析不出真实基线，app-server 会以「无法定位 CLI ZCode Built-in
 * Provider Config」整进程退出（read-only 控制面启动即退）。
 *
 * SEA 形态（CLI 从内嵌资产物化）不走本函数：物化需要异步写盘，由 CLI 侧包装处理。
 */
export function resolveBundledZCodeBuiltinProviderConfigPath(
  input: ResolveBundledZCodeBuiltinProviderConfigPathInput,
): string {
  const entryDirectory = input.entryDirectory.trim();
  if (!entryDirectory) {
    throw new Error("无法定位 ZCode Built-in Provider Config 随包基线：缺少入口目录");
  }
  const candidates = [
    // CLI 打包布局：入口同级的 provider/zcode-builtin.json。
    join(entryDirectory, "provider", "zcode-builtin.json"),
    // 桌面打包布局：resources/glm → resources/config/provider/zcode-builtin.json。
    resolve(entryDirectory, "../config/provider/zcode-builtin.json"),
    // 桌面开发布局：packages/desktop → <repo>/config/provider/zcode-builtin.json。
    resolve(entryDirectory, "../../config/provider/zcode-builtin.json"),
    // CLI 开发布局：apps/zcode-cli/packages/cli/dist → <repo>/config/provider/zcode-builtin.json。
    resolve(entryDirectory, "../../../../../config/provider/zcode-builtin.json"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (candidate) return candidate;
  throw new Error(`无法定位 ZCode Built-in Provider Config 随包基线：${candidates.join(", ")}`);
}
