import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const j = JSON.parse(readFileSync("docs/iterations/bugfix-batch-20261011/cache/gate-knip.json"));
const targets = new Set([
  "apps/zcode-cli/packages/core/src/agent/message-history.ts",
  "apps/zcode-cli/packages/core/src/runtime/types.ts",
  "apps/zcode-cli/packages/core/src/runtime/methods/context.ts",
  "packages/ui/test/magicContextPromptSurfaceOverrides.test.ts",
]);
const findings = [];
function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    if (typeof node.file === "string" && targets.has(node.file.replace(/\\/g, "/"))) findings.push(node);
    Object.values(node).forEach(walk);
  }
}
walk(j);
for (const f of findings) {
  for (const kind of ["exports", "files", "dependencies", "devDependencies", "duplicates"]) {
    for (const item of f[kind] ?? []) {
      const name = item.name ?? item.id ?? "?";
      console.log(`${kind} | ${f.file} | ${name}`);
      if (kind === "exports") {
        let now = 0;
        let base = 0;
        try {
          now = execFileSync("git", ["grep", "-c", name], { encoding: "utf8" }).trim().split("\n").length;
        } catch {
          now = 0;
        }
        try {
          base = execFileSync("git", ["grep", "-c", name, "d69ef5e4"], { encoding: "utf8" }).trim().split("\n").length;
        } catch {
          base = 0;
        }
        console.log(`    git-files-using: now=${now} base=${base}`);
      }
    }
  }
}
