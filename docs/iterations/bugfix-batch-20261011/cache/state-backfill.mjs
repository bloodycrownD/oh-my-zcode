import { readFileSync, writeFileSync } from "node:fs";

const p = "docs/.iteration-state.yaml";
let t = readFileSync(p, "utf8");

const backfill = [
  ["impl-prompt-surface", "bc7a20d7+09b52efe+e81dc870"],
  ["impl-mural", "6d40a729+a0dc4704"],
  ["impl-hook-closure", "a5618a3b+214823ce+145f8f2a"],
  ["verify-gates", "step19 ALL-GREEN 3d482b8f"],
];
for (const [key, commits] of backfill) {
  const re = new RegExp(`${key}:\\s*\\{\\s*status:\\s*pending`, "g");
  t = t.replace(re, `${key}: { status: done, commits: [${commits}]`);
}

if (!t.includes("review-full: { status: done")) {
  t =
    t.trimEnd() +
    "\n    review-full: { status: done, verdict: dev-ready, detail: 2P1 已闭合(9182a420: P1-1 ui测试挂载根链全绿, P1-2 六文件归一+typecheck 27/27+cli交叉0命中-原判定脚本相对路径失配已修), 7P2 文书全落(spec 提交数33/D9措辞/D13四import/Closure计数8/状态回填/FORK行数裁定不动逐字区), 三核对表全过(D1-D14达标+12+3条Closure全修对+集成面e2e双证) }\n";
}

writeFileSync(p, t);
console.log("pending-remaining:", (t.match(/\{ status: pending/g) || []).length);
console.log("review-full-registered:", t.includes("review-full: { status: done"));
console.log("hook-closure-done:", t.includes("impl-hook-closure: { status: done"));
