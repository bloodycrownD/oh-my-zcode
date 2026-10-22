// 汇总 verify-c1 的 v4-perf 日志：各 suite 的 tests/fail + 任何失败用例名
const fs = require("fs");
const t = fs.readFileSync("docs/iterations/upstream-v316-fullsync/cache/verify-c1-v4perf.log", "utf8");
const lines = t.split(/\r?\n/);
const summaries = [];
let totalTests = 0, totalFail = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^# (tests|fail) (\d+)$/);
  if (!m) continue;
  if (m[1] === "tests") { summaries.push({ tests: +m[2], fail: 0, at: i }); totalTests += +m[2]; }
  if (m[1] === "fail") { const s = summaries[summaries.length - 1]; if (s) s.fail = +m[2]; }
}
for (const s of summaries) totalFail += s.fail;
console.log("suite 摘要数:", summaries.length, "| tests 总计:", totalTests, "| fail 总计:", totalFail);
const bad = summaries.filter(s => s.fail > 0);
console.log("含失败 suite:", bad.length);
// 失败用例行（not ok）
const notOk = lines.filter(l => /^not ok/.test(l));
console.log("not ok 行数:", notOk.length);
console.log(notOk.slice(0, 10).join("\n"));
