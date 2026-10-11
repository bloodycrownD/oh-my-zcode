import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const merged = read("D:/Dev/Js/oh-my-zcode/docs/iterations/desktop-long-session-perf/baseline-merged-main.json");
const after = read("D:/Dev/Js/oh-my-zcode/docs/iterations/desktop-long-session-perf/baseline-after.json");

const collect = (seg) => {
  const entries = Array.isArray(seg.probe) ? seg.probe : Object.values(seg.probe ?? {});
  const longtasks = entries.flatMap((e) => e.longtasks ?? []);
  const memories = entries.filter((e) => e.memory);
  const firstHeap = memories[0]?.memory?.heap?.usedBytes ?? memories[0]?.memory?.heapUsedBytes;
  const lastHeap = memories.at(-1)?.memory?.heap?.usedBytes ?? memories.at(-1)?.memory?.heapUsedBytes;
  const rowsValues = memories.map((e) => e.memory.counters?.["projection.rows"]);
  return {
    longtaskCount: longtasks.length,
    longtaskTotalMs: Math.round(longtasks.reduce((t, x) => t + x.duration, 0)),
    longtaskMaxMs: longtasks.reduce((m, x) => Math.max(m, x.duration), 0),
    heapFirst: firstHeap,
    heapLast: lastHeap,
    rows: rowsValues.join("→"),
  };
};

for (const report of [["merged", merged], ["after ", after]]) {
  const [tag, r] = report;
  for (const seg of r.segments) {
    console.log(`${tag} [${seg.name}] ` + JSON.stringify(collect(seg)));
  }
}

// 滚动行程归一（merged 只有 7 步是隐藏窗口节流所致，仅作参考）。
const mergedScroll = merged.segments.find((s) => s.name.includes("scroll"));
const afterScroll = after.segments.find((s) => s.name.includes("scroll"));
console.log("merged scroll steps:", mergedScroll?.driverInfo?.steps, " finalTop:", Math.round(mergedScroll?.driverInfo?.finalScrollTop ?? 0));
console.log("after  scroll steps:", afterScroll?.driverInfo?.steps, " finalTop:", Math.round(afterScroll?.driverInfo?.finalScrollTop ?? 0));
