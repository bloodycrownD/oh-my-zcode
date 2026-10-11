import { execFileSync } from "node:child_process";

const out = execFileSync(
  process.execPath,
  [
    "node_modules/oxlint/bin/oxlint",
    "--ignore-pattern=.reference",
    "--ignore-pattern=.tools",
    "--ignore-pattern=.iteration",
    "--ignore-pattern=docs",
    ".",
  ],
  { encoding: "utf8", cwd: process.cwd() },
);
const lines = out.split(/\r?\n/);
let current = "";
const errors = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (/\.(ts|tsx|mjs|cjs|js|json|svelte)$/.test(trimmed) && !trimmed.includes(" ")) {
    current = trimmed;
  }
  if (trimmed.startsWith("x ") || trimmed.includes("eslint(")) {
    if (trimmed.startsWith("x ")) errors.push({ file: current, rule: trimmed });
  }
}
for (const e of errors) console.log(`${e.file} :: ${e.rule}`);
console.log(`total-errors-listed: ${errors.length}`);
