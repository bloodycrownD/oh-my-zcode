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
  // TypeScript 6.0.2 的 build 模式已无 --continue 旗标；--force 绕过增量缓存保证错误全量重报。
  out = execFileSync(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-b", "--force", ...projects],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (error) {
  out = String(error.stdout ?? "") + String(error.stderr ?? "");
}
const errors = [
  ...new Set(out.split(/\r?\n/).filter((line) => /(?:^|\s)error TS\d+/.test(line))),
].sort();

// 差分键去掉 `file(line,col)` 里的行列号，只保留「文件 + 错误码 + 消息」。
// 快照是基线差分网，任何一次删行/插行都会让同一批既有错误的行号整体平移，
// 按整行比对会把它们全部误报成「新增」，使门禁在正常删除场景下彻底失效。
const diffKey = (line) => line.replace(/^([^(]+)\(\d+,\d+\)/, "$1");
const diffKeySet = (lines) => new Set(lines.map(diffKey));

const baselineLines = readFileSync(snapshotPath, "utf8").split(/\r?\n/).filter(Boolean);
const baseline = diffKeySet(baselineLines);
const current = diffKeySet(errors);
const fresh = [...current].filter((key) => !baseline.has(key));
const removed = [...baseline].filter((key) => !current.has(key)).length;

if (process.argv.includes("--snapshot")) {
  console.log(
    `desktop-full snapshot: ${current.size} error kinds (baseline ${baseline.size}, added ${fresh.length}, removed ${removed})`,
  );
  for (const line of fresh) console.log(`  + ${line}`);
  // 快照是「当前已知态」的差分网，静默重生成会把新增错误一并吸收成基线。
  // 要接受新增错误必须显式加 --accept-new，编排层才不会在无人察觉时放宽门禁。
  if (fresh.length > 0 && !process.argv.includes("--accept-new")) {
    console.log(
      "refusing to write snapshot: new error kinds present; re-run with --snapshot --accept-new to accept them",
    );
    process.exit(1);
  }
  writeFileSync(snapshotPath, errors.join("\n") + "\n");
  console.log(`snapshot written: ${errors.length} errors -> ${snapshotPath}`);
  process.exit(0);
}

console.log(
  `desktop-full: ${current.size} error kinds (baseline ${baseline.size}, removed ${removed})`,
);
// tsc -b 会在 desktop/src 内再生 checked-in 编译产物（schedulerProtocol.*），
// 门禁本身不自动还原（避免误回退编辑中的文件）——编排层在每轮门禁后须执行还原/清理。
try {
  const dirty = execFileSync("git", ["status", "--porcelain", "packages/desktop/src"], {
    cwd: root,
    encoding: "utf8",
  });
  const lines = dirty.split(/\r?\n/).filter(Boolean);
  if (lines.length > 0) {
    console.log("gate side-effect (regenerated artifacts, restore manually):");
    for (const line of lines) console.log(`  ${line}`);
  }
} catch {
  // git 不可用时静默跳过
}
if (fresh.length > 0) {
  console.log("NEW ERRORS:");
  for (const line of fresh) console.log(`  ${line}`);
  process.exit(1);
}
console.log("gate OK: no new errors");
