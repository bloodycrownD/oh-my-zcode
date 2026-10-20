// T（impl-s4 收尾 / cr-func P2-1）：init-local schema 的 uiLocale 契约锁定。
//
// hostMessagePortGuard 以 zod strip 未知键——`uiLocale` 若漏登记
// hostInitLocalMessageSchema（hostIncomingMessageSchema 复用它），会被宿主侧
// 静默丢弃（A 章语言通道唯一断点）。此处钉死：字段保留、旧载荷兼容、
// 常量字面值不漂移。
//
// 放 test/ 而不是 src/：src 会被 tsc emit 进 dist，测试是纯消费方不进产物
// （先例见 packages/shared/test/apply.test.ts）。只用相对路径导入，`npx tsx --test` 可直接跑。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hostIncomingMessageSchema,
  hostInitLocalMessageSchema,
} from "../src/validation";
import { ZCODE_UI_LOCALE_ENV_KEY } from "../src/runtimeEnv";

/** 最小可解析 init-local 载荷（schema 必填仅 type 与内置 provider 配置路径）。 */
function makeInitLocalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "init-local",
    zcodeBuiltinProviderConfigFilePath: "file:///D:/tmp/builtin-providers.json",
    ...overrides,
  };
}

test("init-local schema 解析携带 uiLocale 的载荷并保留字段", () => {
  const parsed = hostInitLocalMessageSchema.safeParse(makeInitLocalPayload({ uiLocale: "zh-CN" }));
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.uiLocale, "zh-CN");
  }
});

test("init-local schema 不含 uiLocale 的旧载荷照常通过（向后兼容）", () => {
  const parsed = hostInitLocalMessageSchema.safeParse(makeInitLocalPayload());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.uiLocale, undefined);
  }
});

test("hostIncomingMessageSchema（port guard 判别联合）不 strip uiLocale", () => {
  const parsed = hostIncomingMessageSchema.safeParse(makeInitLocalPayload({ uiLocale: "en-US" }));
  assert.equal(parsed.success, true);
  if (parsed.success && parsed.data.type === "init-local") {
    assert.equal(parsed.data.uiLocale, "en-US");
  }
});

test("ZCODE_UI_LOCALE_ENV_KEY 常量契约", () => {
  assert.equal(ZCODE_UI_LOCALE_ENV_KEY, "ZCODE_UI_LOCALE");
});
