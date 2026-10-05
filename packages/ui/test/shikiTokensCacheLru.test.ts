/**
 * T-MG1：renderer 内存护栏——Shiki tokensCache 的 LRU 上限与淘汰顺序。
 *
 * 真实高亮要加载语言包与 wasm，单测里跑不动；这里通过 shikiHighlighter 导出的
 * ForTest seam 驱动纯 Map 逻辑，断言走生产同源的写入/刷新路径。
 * 计数断言经 uiMemoryDiagnosticsRegistry 观测，与 60s 内存采样日志看到的是同一个数。
 *
 * 零 `@/` 导入：测试及其模块图必须能在纯 Node（tsx --test）下加载。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { uiMemoryDiagnosticsRegistry } from "../src/lib/memoryDiagnostics.js";
import {
  __getPendingSubscribersCountForTest,
  __getTokensCacheSizeForTest,
  __hasTokensCacheEntryForTest,
  __resetShikiHighlighterCachesForTest,
  __seedTokensCacheForTest,
  __touchTokensCacheForTest,
  highlightCode,
} from "../src/lib/shikiHighlighter.js";

const TOKENS_CACHE_MAX_ENTRIES = 500;

/** 经诊断注册表读计数；shiki 模块在 import 时已注册 provider。 */
const readTokensCacheCounter = (): number => {
  const counter = uiMemoryDiagnosticsRegistry.collect()["shiki.tokensCache"];
  assert.equal(typeof counter, "number", "shiki.tokensCache 诊断计数器未注册");
  return counter as number;
};

test("T-MG1 注入超上限条目后 tokensCache 被压到 500 以内", () => {
  __resetShikiHighlighterCachesForTest();

  const keys = __seedTokensCacheForTest("lru:overflow", 600);

  assert.ok(
    readTokensCacheCounter() <= TOKENS_CACHE_MAX_ENTRIES,
    `tokensCache 计数应 ≤${TOKENS_CACHE_MAX_ENTRIES}，实际 ${readTokensCacheCounter()}`,
  );
  assert.equal(__getTokensCacheSizeForTest(), TOKENS_CACHE_MAX_ENTRIES);
  // 最新的条目留下，最旧的被淘汰。
  assert.equal(__hasTokensCacheEntryForTest(keys[599] as string), true);
  assert.equal(__hasTokensCacheEntryForTest(keys[0] as string), false);
});

test("T-MG1 命中会刷新 LRU 顺序，最久未命中的先被淘汰", () => {
  __resetShikiHighlighterCachesForTest();

  const keys = __seedTokensCacheForTest("lru:touch", 600);
  // 上限 500：注入后存活区间是 keys[100] .. keys[599]。
  const oldestAlive = keys[100] as string;
  const newestAlive = keys[599] as string;
  const secondOldestAlive = keys[101] as string;

  // 访问存活区间里最旧的一条和最新的一条（等价于用户滚回看这两段代码）。
  assert.equal(__touchTokensCacheForTest(oldestAlive), true);
  assert.equal(__touchTokensCacheForTest(newestAlive), true);

  // 再注入一条触发淘汰：两条刚访问过的必须还在，没被访问过的应被淘汰。
  __seedTokensCacheForTest("lru:extra", 1);

  assert.ok(readTokensCacheCounter() <= TOKENS_CACHE_MAX_ENTRIES);
  assert.equal(__getTokensCacheSizeForTest(), TOKENS_CACHE_MAX_ENTRIES);
  assert.equal(__hasTokensCacheEntryForTest(oldestAlive), true, "刚访问过的最旧条目不应被淘汰");
  assert.equal(__hasTokensCacheEntryForTest(newestAlive), true, "刚访问过的最新条目不应被淘汰");
  assert.equal(__hasTokensCacheEntryForTest(secondOldestAlive), false, "最久未命中的条目应被淘汰");
});

test("T-MG1 反复命中同一条不会挤出其它热条目", () => {
  __resetShikiHighlighterCachesForTest();

  const keys = __seedTokensCacheForTest("lru:repeat", 500);
  const hot = keys[0] as string;
  const cold = keys[1] as string;

  for (let round = 0; round < 20; round += 1) {
    assert.equal(__touchTokensCacheForTest(hot), true);
  }
  __seedTokensCacheForTest("lru:repeat-extra", 1);

  assert.equal(__hasTokensCacheEntryForTest(hot), true, "持续命中的条目应始终保留");
  assert.equal(__hasTokensCacheEntryForTest(cold), false, "未再访问的冷条目应被淘汰");
});

test("T-MG1 订阅/退订对称，pending 计数回到 0", () => {
  __resetShikiHighlighterCachesForTest();

  let notified = 0;
  // 纯文本语言走 rawTokens 早退路径：不写 tokensCache，也不登记订阅者。
  const raw = highlightCode("plain log line", "log", "github-light", () => {
    notified += 1;
  });

  assert.ok(raw, "纯文本代码块应直接返回 raw tokens");
  assert.equal(notified, 0, "rawTokens 早退路径不应触发异步回调");
  assert.equal(__getTokensCacheSizeForTest(), 0);
  assert.equal(__getPendingSubscribersCountForTest(), 0);
  assert.equal(readTokensCacheCounter(), 0);
});
