// phase1(s10) 临时门禁：desktop main/preload/renderer/scheduler 四套 tsconfig 的「无新增错误」回归网。
// 这四套工程历史上不在任何 typecheck 门禁内（由 vite/electron 构建驱动），上游基线本身有
// 216 个既有错误（见 desktop-typecheck-baseline.txt 快照）；因此门禁判定不是全绿，而是：
// 不允许出现快照之外的新错误——遥测删除只应让错误集缩小。
// 重新生成快照：node scripts/typecheck-desktop-full.mjs --snapshot
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = [
  "packages/desktop/tsconfig.main.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/desktop/tsconfig.renderer.json",
  "packages/desktop/tsconfig.scheduler.json",
];
const snapshotPath = resolve(root, "scripts/desktop-typecheck-baseline.txt");

let out = "";
try {
  // Windows 下 execFileSync 不解析 .CMD shim，直接用 node 跑 tsc 入口。
  out = execFileSync(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-b", "--continue", ...projects],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (error) {
  out = String(error.stdout ?? "") + String(error.stderr ?? "");
}
const errors = [...new Set(out.split(/\r?\n/).filter((line) => / error TS\d+/.test(line)))].sort();

if (process.argv.includes("--snapshot")) {
  writeFileSync(snapshotPath, errors.join("\n") + "\n");
  console.log(`snapshot written: ${errors.length} errors -> ${snapshotPath}`);
  process.exit(0);
}

const baseline = new Set(
  readFileSync(snapshotPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean),
);
const fresh = errors.filter((line) => !baseline.has(line));
const removed = [...baseline].filter((line) => !errors.includes(line)).length;
console.log(`desktop-full: ${errors.length} errors (baseline ${baseline.size}, removed ${removed})`);
if (fresh.length > 0) {
  console.log("NEW ERRORS:");
  for (const line of fresh) console.log(`  ${line}`);
  process.exit(1);
}
console.log("gate OK: no new errors");
