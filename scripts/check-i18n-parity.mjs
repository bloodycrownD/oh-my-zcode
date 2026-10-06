#!/usr/bin/env node
/**
 * i18n key 对称性门禁（zh-CN ↔ en-US）。
 *
 * 用途：比较 packages/ui/src/i18n/locales/zh-CN.ts 与 en-US.ts 的 key 集合，
 * 双向输出差集（含 key 名与行号）。存在差异时以退出码 1 结束（门禁失败），
 * key 集合完全相等时输出两侧 key 总数并以退出码 0 结束。
 *
 * 用法：
 *   node scripts/check-i18n-parity.mjs
 *   # 静默模式（仅退出码，供 CI 使用）：
 *   node scripts/check-i18n-parity.mjs --quiet
 *
 * 提取方式：两份 locale 均为扁平结构（`const zhCN: Record<string, string> = {` 下的
 * `"a.b.c": "文案"` 扁平键），因此逐行匹配 `^\s*"key"\s*:` 的键字符串字面量即可；
 * 行首注释行（`//`）不会匹配该模式，值里的反引号/花括号不影响键提取。
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const localesDir = join(repoRoot, "packages", "ui", "src", "i18n", "locales");

const SIDES = [
  { label: "zh-CN", file: join(localesDir, "zh-CN.ts") },
  { label: "en-US", file: join(localesDir, "en-US.ts") },
];

const quiet = process.argv.includes("--quiet");

/** 扁平 key 提取：`"key": value`（允许任意缩进，允许值跨行——值在下一行时只取键）。 */
const KEY_LINE_RE = /^\s*"([^"]+)"\s*:/;

function extractKeys(file) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  /** @type {Map<string, number>} key -> 首次出现的行号（1-based） */
  const keys = new Map();
  for (const [index, line] of lines.entries()) {
    const match = KEY_LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!keys.has(key)) keys.set(key, index + 1);
  }
  return { keys, lineCount: lines.length, source };
}

const zh = extractKeys(SIDES[0].file);
const en = extractKeys(SIDES[1].file);

const zhKeys = new Set(zh.keys.keys());
const enKeys = new Set(en.keys.keys());
const totalZh = zhKeys.size;
const totalEn = enKeys.size;

const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key)).sort();

function report(side, keys) {
  console.log(`\n仅 ${side} 拥有（${keys.length}）：`);
  for (const key of keys) {
    console.log(
      `  ${key}  (${side} 第 ${key.startsWith("zh") ? zh.keys.get(key) : en.keys.get(key)} 行)`,
    );
  }
}

if (totalZh === 0 || totalEn === 0) {
  console.error("门禁失败：未能从 locale 文件中提取到任何 key，文件结构可能已变化。");
  console.error(`  zh-CN: ${relative(repoRoot, SIDES[0].file)}（${totalZh} 键）`);
  console.error(`  en-US: ${relative(repoRoot, SIDES[1].file)}（${totalEn} 键）`);
  process.exit(1);
}

if (onlyZh.length > 0 || onlyEn.length > 0) {
  console.error("i18n parity 门禁失败：zh-CN 与 en-US 的 key 集合不一致。");
  console.error(`  zh-CN key 总数: ${totalZh}`);
  console.error(`  en-US key 总数: ${totalEn}`);
  report("zh-CN", onlyZh);
  report("en-US", onlyEn);
  console.error(
    `\n合计不对称 key：${onlyZh.length + onlyEn.length} 个（zh 多 ${onlyZh.length}，en 多 ${onlyEn.length}）。`,
  );
  process.exit(1);
}

if (!quiet) {
  console.log(`i18n parity 通过：zh-CN 与 en-US key 集合一致（各 ${totalZh} 键）。`);
}
process.exit(0);
