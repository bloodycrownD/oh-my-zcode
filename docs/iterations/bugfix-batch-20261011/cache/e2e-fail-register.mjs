import { readFileSync, writeFileSync } from "node:fs";

const p = "docs/.iteration-state.yaml";
let t = readFileSync(p, "utf8");
if (!t.includes("realdevice-e2e: { status: stopped")) {
  t =
    t.trimEnd() +
    "\n    realdevice-e2e: { status: stopped, verdict: 4场景全blocked未开测, cause: 播种bug——代理把活库(134MB含WAL)直接拷贝作种子→副本不一致→host storage worker 打开即退(preparing_session_storage/transport_closed, attemptId 258dbe8a 在 e2e app.log 命中 pid:964), 非产品缺陷(fail-visible 符合预期), 非用户生产应用故障(其 pid:14732 全天在跑日志零错误), evidence: cache/realdevice-e2e.md + cache/e2e-collision-probe.mjs, 待重跑: 一致性快照播种(VACUUM INTO/backup API)或空库UI建会话 }\n";
  writeFileSync(p, t);
}
console.log("registered:", t.includes("realdevice-e2e: { status: stopped"));
