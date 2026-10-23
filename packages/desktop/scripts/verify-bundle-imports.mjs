#!/usr/bin/env node
// 产物级说明符门禁（v1.0.21 启动即崩事故补位，cr-fix-spec CR-3）：
// tsup 默认 removeNodeProtocol 会把外部化的 node:* 剥成裸说明符；多数内建有裸别名幸存，
// 但 sqlite 是 prefix-only 内建（无裸别名）→ 打包产物出现 from"sqlite" → 启动即 ERR_MODULE_NOT_FOUND。
// 本脚本扫描 out/{main,host,scheduler,preload} 全部产物，断言每个非相对说明符都在合法集合内：
//   合法 = node: 前缀 ∪ desktopNodeRuntimeExternals（写死同步，八项）∪ node.builtinModules
//          ∪ desktop package.json dependencies 键名（内联 CJS 依赖的合法裸包名，如 ws/yazl）
//   非法 = 上述之外的一切——特别是裸 'sqlite'（事故形态）与 @zcode/* 裸包名
//          （tsup.config.ts 成文记载：裸 @zcode 引用 + electron-builder 排除 node_modules/@zcode = 启动即崩）。
// 挂 tsup 四 target 的 onSuccess（构建即失败）；package.json verify:bundle-imports 可显式调用。
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, "");

// 与 packages/desktop/tsup.config.ts 的 desktopNodeRuntimeExternals 保持同步（勿凭记忆增删）。
const TSUP_EXTERNALS = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "@larksuiteoapi/node-sdk",
  "yaml",
  "node-forge",
  "yauzl",
];

const SCAN_ROOTS = ["out/main", "out/host", "out/scheduler", "out/preload"];
// 支持按 target 限定扫描面（tsup onSuccess 传 main|host|scheduler|preload；无参=全量，供发版 checklist 显式调用）。
const argTargets = process.argv.slice(2);
const scanRoots = argTargets.length > 0 ? argTargets.map((t) => `out/${t}`) : SCAN_ROOTS;

// 说明符提取：词界 + 闭合引号，避免把压缩产物字符串字面量里的 from" 误当模块说明符。
// 说明符只允许 [A-Za-z0-9@/._-]，遇到其他字符（如 ) , ; 空格）即终止匹配。
const SPEC = String.raw`[A-Za-z0-9@/._-]+`;
const SPEC_PATTERNS = [
  new RegExp(String.raw`\bfrom\s*"(${SPEC})"`, "g"),
  new RegExp(String.raw`\bimport\s*"(${SPEC})"`, "g"),
  new RegExp(String.raw`\bimport\(\s*"(${SPEC})"\s*\)`, "g"),
  new RegExp(String.raw`\brequire\(\s*"(${SPEC})"\s*\)`, "g"),
];

const depsWhitelist = new Set(
  Object.keys(
    JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8")).dependencies || {},
  ),
);
const externals = new Set(TSUP_EXTERNALS);
const builtins = new Set(builtinModules);

function isLegal(spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) return true;
  // @zcode/* 反白名单：即使出现在 dependencies 里也必须判红（electron-builder 排除该前缀）。
  if (spec.startsWith("@zcode/")) return false;
  if (spec.startsWith("node:")) return true;
  if (externals.has(spec)) return true;
  if (builtins.has(spec)) return true; // node.builtinModules 不含 prefix-only 内建（sqlite 等），裸名必判假
  if (depsWhitelist.has(spec)) return true;
  return false;
}

async function collectFiles(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // 目录不存在（如该目标无 preload）不算失败
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, acc);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = [];
for (const root of scanRoots) await collectFiles(join(desktopDir, root), files);
if (files.length === 0) {
  console.error("[verify-bundle-imports] 未发现任何产物文件——先完成构建再跑本门禁");
  process.exit(1);
}
const violations = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const pattern of SPEC_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const spec = match[1];
      if (!isLegal(spec)) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${file}:${line} 非法说明符 ${JSON.stringify(spec)}`);
      }
    }
  }
}
if (violations.length > 0) {
  console.error(
    `[verify-bundle-imports] FAIL：${violations.length} 处非法说明符（裸内建名/@zcode 裸包名=启动即崩面）`,
  );
  for (const v of violations.slice(0, 30)) console.error("  " + v);
  if (violations.length > 30) console.error(`  ...共 ${violations.length} 处`);
  process.exit(1);
}
console.log(
  `[verify-bundle-imports] PASS：${files.length} 个产物文件，说明符全部合法（external ${TSUP_EXTERNALS.length}+deps ${depsWhitelist.size}+内建 ${builtins.size}；@zcode/* 反白名单生效）`,
);
