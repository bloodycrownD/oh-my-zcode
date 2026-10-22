// 分批 git checkout 还原 worktree 脏文件（防 D: 卷写入风暴）
const { execFileSync } = require("child_process");
const cwd = "D:\\worktree\\fullsync";
const out = execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8" });
const dirty = out.split(/\r?\n/).filter(Boolean)
  .filter(l => /^[MDARC]/.test(l) || /^ [MDARC]/.test(l)) // 只取 tracked 修改/删除（排除 ?? 与 !!）
  .map(l => l.slice(3).trim())
  .filter(p => p && !p.includes("->"));
console.log("dirty tracked remaining:", dirty.length);
if (dirty.length === 0) { console.log("nothing to restore"); process.exit(0); }
let done = 0;
for (let i = 0; i < dirty.length; i += 80) {
  const chunk = dirty.slice(i, i + 80);
  execFileSync("git", ["-C", cwd, "checkout", "--", ...chunk], { stdio: "pipe" });
  done += chunk.length;
  console.log("restored", done, "/", dirty.length);
}
const after = execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
console.log("remaining entries:", after.length);
console.log(after.slice(0, 20).join("\n"));
