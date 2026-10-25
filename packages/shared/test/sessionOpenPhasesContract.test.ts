// IS8 的 additive 契约（M6）：`openPhases` 是 ACK 顶层新键，既不能破坏旧消费者，
// 也不能被放松成「什么键都收」。
//
// 三条断言对应三条真实风险：
//   1. 旧 `subscribeAckSchema`（非 strict）必须**剥掉**新键而不是整帧失败；
//   2. `.strict()` 的 `openTiming` 必须继续对未知键报错——否则「新分段不能进 openTiming」
//      这条决策就没人守了；
//   3. `conversationOpenPhasesSchema` 里不得出现 `runtimeReadyMs`——view-only 的激活发生在
//      ACK 之后，该键永远拿不到值，出现即意味着「永远是 undefined 却被当成 0」。
//
// 放 test/ 而不是 src/：先例见 apply.test.ts（src 会被 tsc emit 进 dist）。
// 只用相对路径导入（不用 `@/` 别名），`npx tsx --test` 可直接跑。
import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationOpenPhasesSchema,
  conversationOpenTimingSchema,
  subscribeAckSchema,
  v4ConversationSubscribeResultSchema,
} from "../src/zcode-protocol-v4/transport.js";

test("旧 subscribeAckSchema 对 openPhases 未知键剥键而不整帧失败", () => {
  const rawAck = {
    subscriptionId: "sub-is8",
    mode: "snapshot",
    logEpoch: "epoch-1",
    // 新客户端 + 新 CLI 会带这一坨；旧客户端只认识上面三个键。
    openPhases: { version: 1, viewReadyMs: 123 },
  };
  const parsed = subscribeAckSchema.parse(rawAck);
  assert.equal(parsed.subscriptionId, "sub-is8");
  assert.equal(parsed.mode, "snapshot");
  assert.equal(parsed.logEpoch, "epoch-1");
  // additive 的形态就是「旧侧看不见」，不是「旧侧报错」。
  assert.equal("openPhases" in parsed, false);

  // 同一条 ack 在新消费者路径上必须原样可见（否则这个键就没接上）。
  const current = v4ConversationSubscribeResultSchema.parse({ ack: rawAck });
  assert.deepEqual(current.ack.openPhases, { version: 1, viewReadyMs: 123 });
});

test("conversationOpenTimingSchema 仍对未知键报错（.strict() 没被放松）", () => {
  assert.throws(() =>
    conversationOpenTimingSchema.parse({
      version: 1,
      hostPrepareMs: 12,
      // IS8 的决策是「新分段不进 openTiming」，一旦这里能过，旧客户端就会整帧解析失败。
      runtimeReadyMs: 34,
    }),
  );
  // 收紧的另一面：已知键照旧通过（不能为了过测试把 schema 削空）。
  const valid = conversationOpenTimingSchema.parse({ version: 1, hostPrepareMs: 12 });
  assert.equal(valid.hostPrepareMs, 12);
});

test("conversationOpenPhasesSchema 没有 runtimeReadyMs 键", () => {
  assert.equal("runtimeReadyMs" in conversationOpenPhasesSchema.shape, false);
  // 观测面刻意非 strict：未知键被剥掉（缺席 ≠ 0），而不是失败。
  const parsed = conversationOpenPhasesSchema.parse({
    version: 1,
    viewReadyMs: 500,
    runtimeReadyMs: 900,
  });
  assert.equal(parsed.viewReadyMs, 500);
  assert.equal("runtimeReadyMs" in parsed, false);
});
