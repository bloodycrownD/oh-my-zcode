/**
 * i18n 键级合并配置：白名单桶 / 保护桶 / 死键桶 / 品牌规则 / 路径。
 * 被 scripts/i18n-key-merge.mjs 及其子模块共享。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 白名单前缀桶：上游独有键仅当命中才采纳（spec §phase-i18n + exp-3 §2.3 分桶）。 */
const WHITELIST_PREFIXES = [
  "chat.toolCall.",
  "chat.permission.",
  "settings.memory.",
  "settings.modelProvider.",
  "settings.plugins.",
  "settings.dynamicWorkflow.",
  "settings.toolSearch.",
  "sidePane.",
  "browser.",
  "project.",
  "archives.",
  "taskGroup.",
  "workspaceSidebar.",
  "preview.",
  "fileManager.",
  "ssh.",
  "docker.",
];

/** 保 omz 桶：值冲突时保留 omz 文案（轨迹面板 omz 专属语义，一条不能丢）。 */
const KEEP_OMZ_PREFIXES = ["modelTrajectory."];

/** omz 死键：顺手清除（rg 全仓核实零代码引用，见仲裁表附录 B）。 */
const DROP_OMZ_PREFIXES = ["conversationShare."];

/** 品牌残留匹配（大小写不敏感）。 */
export const BRAND_RE = /zcode/i;

/** 品牌改写：产品名统一改写为 omz。 */
export function rewriteBrand(value) {
  return value.replaceAll("ZCode", "omz").replaceAll("zcode", "omz");
}

export function inWhitelist(key) {
  return WHITELIST_PREFIXES.some((p) => key.startsWith(p));
}

export function isKeepOmz(key) {
  return KEEP_OMZ_PREFIXES.some((p) => key.startsWith(p));
}

export function isDroppedOmz(key) {
  return DROP_OMZ_PREFIXES.some((p) => key.startsWith(p));
}

export const LOCALES = [
  { id: "zh-CN", constName: "zhCN" },
  { id: "en-US", constName: "enUS" },
];

export const paths = {
  repoRoot,
  upstreamDir: join(
    repoRoot,
    "docs",
    "iterations",
    "upstream-v316-fullsync",
    "cache",
    "upstream-locales",
  ),
  omzDir: join(repoRoot, "packages", "ui", "src", "i18n", "locales"),
  arbitrationPath: join(
    repoRoot,
    "docs",
    "iterations",
    "upstream-v316-fullsync",
    "i18n-arbitration.md",
  ),
  mergeReportPath: join(
    repoRoot,
    "docs",
    "iterations",
    "upstream-v316-fullsync",
    "cache",
    "i18n-merge-report.md",
  ),
};
