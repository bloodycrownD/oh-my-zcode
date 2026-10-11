import { readFileSync } from "node:fs";

const raw = readFileSync("docs/iterations/bugfix-batch-20261011/cache/gate-lint-full.txt", "utf8");
const batch = new Set(
  JSON.parse(readFileSync("docs/iterations/bugfix-batch-20261011/cache/batch-files.json", "utf8"))
    .map((f) => f.replace(/\\/g, "/")),
);

const lines = raw.split(/\r?\n/);
let currentFile = "";
const diagnostics = [];
for (const line of lines) {
  const loc = line.match(/,-\[(.+?):\d+:\d+\]/);
  if (loc) currentFile = loc[1].replace(/\\/g, "/");
  if (/^\s*x /.test(line) || /^\s*! /.test(line)) {
    diagnostics.push({ severity: /^\s*x /.test(line) ? "error" : "warning", file: currentFile, rule: line.trim() });
  }
}
const errs = diagnostics.filter((d) => d.severity === "error");
console.log(`errors-total: ${errs.length}`);
for (const e of errs) console.log(`ERR ${e.file} :: ${e.rule.slice(0, 90)}`);
const batchHits = diagnostics.filter((d) => batch.has(d.file));
console.log(`\nbatch-file diagnostics: ${batchHits.length}`);
for (const d of batchHits) console.log(`${d.severity.toUpperCase()} ${d.file} :: ${d.rule.slice(0, 90)}`);
