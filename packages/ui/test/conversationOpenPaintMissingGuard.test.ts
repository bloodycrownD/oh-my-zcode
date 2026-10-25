/**
 * 首绘采样「缺席必须有原因」的源码形状守卫（session-open-latency phase-0 C3）。
 *
 * packages/ui 没有 jsdom，rAF 行为测不到；这里只钉**形状**：`scheduleOpenPaintSample`
 * 的两个丢弃分支必须调 `reportOpenPaintMissing(...)`，而它必须落到
 * `recordConversationOpenPaintMissing`，观测面必须持有 `paintMissing` 且 `reset()` 清它。
 *
 * 失效形态（phase-0 实测）：两个分支直接 `return;`，`renderer.paintAfterApplyMs` 在快路径
 * regime 上无声缺席 5/9 次，报告无法区分「rAF 还没跑」与「样本已作废」。
 *
 * 运行形态：node_modules/.bin/tsx --test packages/ui/test/conversationOpenPaintMissingGuard.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const storeSource = readFileSync(
  join(here, "..", "src", "v4", "conversationProjectionStore.ts"),
  "utf8",
);
const observabilitySource = readFileSync(
  join(here, "..", "src", "v4", "conversationOpenObservability.ts"),
  "utf8",
);

test("首绘丢弃分支写缺席原因（closed / generation_changed 各自可达）", () => {
  assert.match(
    storeSource,
    /this\.reportOpenPaintMissing\(this\.closed \? "closed" : "generation_changed"\);/,
    "丢弃分支必须调 reportOpenPaintMissing 并区分 closed / generation_changed",
  );
  // 早退本身可以保留，但它必须发生在打点之后——只有 return 没有打点就是旧的静默丢弃。
  const discardBlock = storeSource.slice(
    storeSource.indexOf("this.reportOpenPaintMissing(this.closed"),
    storeSource.indexOf("this.reportOpenPaintMissing(this.closed") + 200,
  );
  assert.match(discardBlock, /\breturn;/, "打点后仍应早退，不得把上一代的首绘写进新 timing");
});

test("reportOpenPaintMissing 落到观测面（不自己吞掉）", () => {
  assert.match(
    storeSource,
    /private reportOpenPaintMissing\(reason: "closed" \| "generation_changed"\): void \{[\s\S]*?recordConversationOpenPaintMissing\(this\.topic, reason\);/,
    "reportOpenPaintMissing 必须把 topic + reason 交给 recordConversationOpenPaintMissing",
  );
});

test("观测面暴露 paintMissing 并在 reset() 里清空", () => {
  assert.match(
    observabilitySource,
    /paintMissing: Record<string, ConversationOpenPaintMissingSample>;/,
    "probe 必须持有按 topic 的 paintMissing",
  );
  assert.match(
    observabilitySource,
    /reset\(\) \{[\s\S]*?delete probe\.paintMissing\[topic\];[\s\S]*?\}/,
    "reset() 必须一并清掉 paintMissing（否则跨样本串味）",
  );
  assert.match(
    observabilitySource,
    /delete probe\.paintMissing\[sample\.topic\];/,
    "新 ACK 覆盖该 topic 时必须清掉上一代的缺席标记",
  );
});
