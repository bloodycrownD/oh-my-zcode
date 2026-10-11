import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const ATTEMPT = "258dbe8a";
const STARTUP = "9a4dc94f";
const roots = [
  join(tmpdir(), "omz-realdevice-e2e-zUCBr7"),
  join(homedir(), ".omz"),
];
const cutoff = Date.now() - 45 * 60 * 1000;
const recent = [];
const ledgerHits = [];

function walk(dir, depth) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 6 && !["node_modules", "Cache", "Code Cache", "GPUCache"].includes(e.name)) walk(p, depth + 1);
    } else {
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs > cutoff) recent.push(`${new Date(st.mtimeMs).toISOString().slice(11, 19)} ${st.size}B ${p}`);
      if (/startup|attempt|boot/i.test(e.name) && st.size < 200000) {
        try {
          const c = readFileSync(p, "utf8");
          if (c.includes(ATTEMPT) || c.includes(STARTUP)) ledgerHits.push(p);
        } catch {}
      }
    }
  }
}

for (const r of roots) walk(r, 0);
console.log("RECENT (last 45min), newest last:");
console.log(recent.sort().slice(-40).join("\n") || "(none)");
console.log("\nLEDGER containing failed attempt:", ledgerHits.join("\n") || "(not found in scanned roots)");
