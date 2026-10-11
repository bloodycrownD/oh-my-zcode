import { readFileSync } from "node:fs";

const raw = readFileSync("docs/iterations/bugfix-batch-20261011/cache/gate-knip.json", "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.log("parse-fail:", raw.slice(0, 300));
  process.exit(0);
}
const hits = [];
function collect(kind, node) {
  if (Array.isArray(node)) {
    for (const item of node) collect(kind, item);
    return;
  }
  if (node && typeof node === "object") {
    if (typeof node.file === "string") hits.push(`${kind}: ${node.file}${node.name ? ` #${node.name}` : ""}`);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") collect(kind, value);
    }
  }
}
for (const [kind, payload] of Object.entries(parsed)) collect(kind, payload);
const real = hits.filter((h) => !h.includes("/.reference/") && !h.startsWith("issues: .reference"));
const batch = new Set(
  JSON.parse(readFileSync("docs/iterations/bugfix-batch-20261011/cache/batch-files.json", "utf8")).map((f) =>
    f.replace(/\\/g, "/"),
  ),
);
const batchHits = real.filter((h) => {
  const m = h.match(/: (.+?)(?: #|$)/);
  return m && batch.has(m[1]);
});
const pkgMc = real.filter((h) => h.includes("apps/zcode-cli/packages/magic-context"));
console.log(`total-findings(all): ${hits.length}`);
console.log(`real-findings(excl .reference): ${real.length}`);
console.log(`magic-context-package-hits: ${pkgMc.length}`);
for (const h of pkgMc) console.log("MC", h);
console.log(`batch-file-hits: ${batchHits.length}`);
for (const h of batchHits) console.log("BATCH", h);
