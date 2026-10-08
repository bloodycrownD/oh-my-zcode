import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createZCodeBuiltinBundledEnv,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

// FORK（cr-fix DF-C-orch-1）验收锁：agent spawn env 的 BUNDLED 必须是「真实随包基线」
// ——桌面 Main 解析出 fallback 时优先下发 fallback；显式值仅在无 fallback 时兜底；
// 两者皆缺省时键值为 undefined（与修复前的 `fallback ?? explicit` 表达式语义一致）。
test("createZCodeBuiltinBundledEnv 优先下发随包基线 fallback", () => {
  const env = createZCodeBuiltinBundledEnv({
    zcodeBuiltinProviderConfigFallbackFilePath: "<packed-baseline>",
    zcodeBuiltinProviderConfigFilePath: "<stale-explicit>",
  });
  assert.equal(env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], "<packed-baseline>");
});

test("createZCodeBuiltinBundledEnv 无 fallback 时退回显式值", () => {
  const env = createZCodeBuiltinBundledEnv({
    zcodeBuiltinProviderConfigFilePath: "<explicit>",
  });
  assert.equal(env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], "<explicit>");
});

test("createZCodeBuiltinBundledEnv 双缺省时不注入该键", () => {
  const env = createZCodeBuiltinBundledEnv({});
  assert.equal(
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
    "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
  );
  assert.equal(ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV in env, false);
  assert.equal(env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV], undefined);
});
