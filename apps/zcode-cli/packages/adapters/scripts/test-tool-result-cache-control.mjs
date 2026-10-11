#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-XFRM-1——tool-result 的 cacheControl 落在**结果块级**。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P2 #13）
 * ============================================================================
 *
 * AI SDK 把连续 tool 消息合并进同一条 assistant 前的 wire 消息时，只保留**首条**的
 * `providerOptions`（消息级）。缓存断点原先挂在 tool 消息级，于是：
 *   - 批次末尾的断点被整批丢掉（缓存命中率下跌，只影响成本不影响正确性，因此长期无感）；
 *   - 更糟的是它会被**移到别的结果**上——首条结果拿了末尾的断点，缓存前缀判据错位。
 * 修复把标记下沉到 `tool-result` 结果块上：块不参与合并，跟着结果走。
 *
 * 运行：`node --test scripts/test-tool-result-cache-control.mjs`
 * （先 `pnpm --filter @zcode/adapters build`；workspace 里发布原始 TS 的包由下面的 resolve
 *  钩子改指到同布局 `dist/`。）
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const { toAiSdkMessages } = await import("../dist/model/transform.js");

const CACHE_CONTROL = { type: "ephemeral" };

function toolMessage(toolCallId, text, cacheControl) {
  return {
    role: "tool",
    toolCallId,
    toolName: "Read",
    content: text,
    ...(cacheControl === undefined ? {} : { cacheControl }),
  };
}

test("T-XFRM-1 cacheControl rides the tool-result block, not the tool message", () => {
  const transformed = toAiSdkMessages(
    [toolMessage("call-1", "first"), toolMessage("call-2", "second", CACHE_CONTROL)],
    { providerKind: "anthropic" },
  );

  // 消息级不再承载断点：SDK 合并连续 tool 消息时只保留首条的 providerOptions，
  // 挂在消息级就等于「谁在首条谁拿断点」，而不是「断点跟着哪条结果」。
  assert.equal("providerOptions" in transformed[1], false);

  const blocks = transformed.map((message) => message.content[0]);
  assert.equal(blocks[0].type, "tool-result");
  // 断点落在**具体结果块**上，跟随第二条结果，不随合并漂移。
  assert.deepEqual(blocks[1].providerOptions, { anthropic: { cacheControl: CACHE_CONTROL } });
  assert.equal("providerOptions" in blocks[0], false);
});

test("T-XFRM-1 a tool result without cacheControl stays free of providerOptions", () => {
  const transformed = toAiSdkMessages([toolMessage("call-1", "only")], {
    providerKind: "anthropic",
  });
  assert.equal("providerOptions" in transformed[0], false);
  assert.equal("providerOptions" in transformed[0].content[0], false);
});

test("T-XFRM-1 user/system/assistant message-level cacheControl is unchanged", () => {
  // 修复只动 tool-result 分支：其余三种 role 的断点仍在消息级（兼容面不动）。
  const transformed = toAiSdkMessages(
    [
      { role: "system", content: "sys", cacheControl: CACHE_CONTROL },
      { role: "user", content: "hi" },
    ],
    { providerKind: "anthropic" },
  );
  assert.deepEqual(transformed[0].providerOptions, { anthropic: { cacheControl: CACHE_CONTROL } });
  assert.equal(transformed[0].content[0].providerOptions, undefined);
});
