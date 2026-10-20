/**
 * T-L2（agent-lang-trace-usage-batch / Step 3 A6）——Host 应用 UI 语言注入 Agent spawn env。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * 1) 正向：Host 探测到 `zh-CN` 时，Agent 子进程 env 必须出现 `ZCODE_UI_LOCALE=zh-CN`，
 *    否则 CLI 冷启动只能按 Node Intl 解析系统语言，回到「Desktop 界面中文、Agent 系统
 *    提示词英文」的原始缺口。
 * 2) 反向：`undefined`（老 Main / 远端 workspace / 未接线宿主）必须**不产键**。CLI 的
 *    `runtime-config` 以 `uiDetectedLocale !== undefined` 判定「宿主显式指定」，一旦这里
 *    写成 `undefined` 值或空串，缺省场景会被当成显式语言，压掉既有的 env → Intl 回落。
 * 3) 空串（及纯空白）与 undefined 同语义。
 *
 * 载体是 A6 抽出的纯函数：`resolveSpawnEnv` 是 createLocalServices 的内部闭包不可直测，
 * 纯函数正确 ≠ spawn env 真的调用了它，调用点由 Step 4 手工验收覆盖。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ZCODE_UI_LOCALE_ENV_KEY } from "@zcode/shared";
import { buildUiLocaleSpawnEnv } from "../src/node.js";

test("buildUiLocaleSpawnEnv 正向注入 Host UI 语言", () => {
  const env = buildUiLocaleSpawnEnv("zh-CN");
  // 常量即 wire 契约：CLI 侧按同一个键读取，改名会让正向断言静默失效。
  assert.equal(ZCODE_UI_LOCALE_ENV_KEY, "ZCODE_UI_LOCALE");
  assert.equal(env[ZCODE_UI_LOCALE_ENV_KEY], "zh-CN");
  assert.deepEqual(env, { ZCODE_UI_LOCALE: "zh-CN" });
});

test("buildUiLocaleSpawnEnv 正向注入其它语言值", () => {
  assert.deepEqual(buildUiLocaleSpawnEnv("en-US"), { ZCODE_UI_LOCALE: "en-US" });
});

test("buildUiLocaleSpawnEnv 缺省时不产键（防 undefined 值破坏 CLI env 回落）", () => {
  const env = buildUiLocaleSpawnEnv(undefined);
  assert.equal(ZCODE_UI_LOCALE_ENV_KEY in env, false);
  assert.equal(env[ZCODE_UI_LOCALE_ENV_KEY], undefined);
  assert.deepEqual(env, {});
});

test("buildUiLocaleSpawnEnv 空串与空白等同缺省", () => {
  assert.deepEqual(buildUiLocaleSpawnEnv(""), {});
  assert.equal(ZCODE_UI_LOCALE_ENV_KEY in buildUiLocaleSpawnEnv(""), false);
  assert.deepEqual(buildUiLocaleSpawnEnv("   "), {});
});
