import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tsupConfig from "../tsup.config";

const DESKTOP_DIR = resolve(import.meta.dirname, "..");
const SETTINGS_AWARE_WORKER_SOURCE = "src/host/database-startup/tasksStorageWorker.ts";
const LEGACY_WORKER_SOURCE = "src/host/tasksStorageWorker.ts";

function getHostEntry(): Record<string, string> {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const host = configs.find((config) => config.name === "host");
  expect(host).toBeDefined();
  expect(typeof host?.entry).toBe("object");
  return host?.entry as Record<string, string>;
}

/**
 * 构建产物里的 import 会被 esbuild 拆到 chunk 中，且生产压缩会给本地绑定起别名；
 * 因此按相对 import 递归读取同目录 chunk，再断言接线的名字确实进了产物图。
 */
function readArtifactGraph(entryPath: string, visited = new Set<string>()): string {
  const normalized = resolve(entryPath);
  if (visited.has(normalized) || !existsSync(normalized)) return "";
  visited.add(normalized);
  const source = readFileSync(normalized, "utf-8");
  const imports = [...source.matchAll(/from\s*"(\.[^"]+\.js)"/gu)]
    .map((match) => join(dirname(normalized), match[1]))
    .map((path) => readArtifactGraph(path, visited))
    .join("\n");
  return `${source}\n${imports}`;
}

describe("desktop host tasks-index 存储 Worker entry", () => {
  it("host 构建必须指向带 settings 的 database-startup Worker", () => {
    // 升级 v3.16.2 时 entry 仍指向 legacy Worker，产物没有 createSettingService 接线：
    // Worker 以空 settings 跑 projectStorage.migrate，0005_projects 落账后 Host 无法重放，
    // 项目侧栏为空。这里锁死 entry，避免 merge 再次把 fork 旧文件接回去。
    const entry = getHostEntry();
    expect(entry["host/tasksStorageWorker"]).toBe(SETTINGS_AWARE_WORKER_SOURCE);
  });

  it("settings-aware Worker 必须在准备存储前读取设置并透传", () => {
    const source = readFileSync(join(DESKTOP_DIR, SETTINGS_AWARE_WORKER_SOURCE), "utf-8");
    expect(source).toContain("createSettingService");
    expect(source).toMatch(/prepareTasksIndexStorage\(\s*data\.path,[\s\S]*?\bsettings\b/u);
  });

  it("不再保留无 settings 的 legacy Worker 源文件", () => {
    expect(existsSync(join(DESKTOP_DIR, LEGACY_WORKER_SOURCE))).toBe(false);
  });

  it("已构建产物必须包含 settings 接线（未构建时跳过）", () => {
    const artifact = join(DESKTOP_DIR, "out/host/tasksStorageWorker.js");
    if (!existsSync(artifact)) {
      // 单测常在未构建的 checkout 上运行；构建门禁由 E2E/发布构建覆盖。
      return;
    }
    const graph = readArtifactGraph(artifact);
    expect(graph).toContain("createSettingService");
  });
});
