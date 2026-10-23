/**
 * desktop/B-2（CR fix-spec）：ToolCallBody 读成功但 `dataBase64` 为空时不得永久 Loading。
 *
 * 形态：纯逻辑测试（node --test + node:assert）。`inlineImageResult.ts` 不 import React，
 * 可跨包直接加载；`ToolCallBody.tsx` 只做源码形状守卫（本仓 ui 无 jsdom，组件不能渲染）。
 *
 * 锁死的失效形态：`FileMediaPreview.dataBase64` 必填 `string`，0 字节图片解析出 `""`；
 * 旧实现 `setResult({ src: mediaPreview?.dataBase64 })` 让 `src` 为空串，
 * 渲染侧 `!current.src` 走 loading、`failed` 未置位 → 永远停在 `chat.toolCall.loading`。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveInlineImageResult } from "../../ui/src/ToolCallBlocks/inlineImageResult.js";

const uiSrc = (relative: string) =>
  fileURLToPath(new URL(`../../ui/src/${relative}`, import.meta.url));

test("B-2 空 base64：0 字节图片必须判失败，不能停在 loading", () => {
  assert.deepEqual(resolveInlineImageResult({ dataBase64: "" }), { src: undefined, failed: true });
  assert.equal(resolveInlineImageResult({ dataBase64: "" }).failed, true);

  // 读取失败/无返回（readMediaPreview 返回 null）同样必须失败收口。
  assert.deepEqual(resolveInlineImageResult(null), { src: undefined, failed: true });
  assert.deepEqual(resolveInlineImageResult(undefined), { src: undefined, failed: true });
  assert.deepEqual(resolveInlineImageResult({}), { src: undefined, failed: true });
  assert.deepEqual(resolveInlineImageResult({ dataBase64: null }), {
    src: undefined,
    failed: true,
  });

  // 反证：有内容时必须拿到图源且失败位为 false，否则这条用例没有区分力。
  const ok = resolveInlineImageResult({ dataBase64: "iVBORw0KGgo=" });
  assert.equal(ok.src, "iVBORw0KGgo=");
  assert.equal(ok.failed, false);
});

test("B-2 接线形状：ToolCallBody 用归一化结果，loading 只由 failed 决定终态", async () => {
  const body = await readFile(uiSrc("ToolCallBlocks/ToolCallBody.tsx"), "utf8");

  assert.ok(
    body.includes("...resolveInlineImageResult(mediaPreview)"),
    "读取成功路径必须交给 resolveInlineImageResult 判定 src/failed",
  );
  assert.equal(
    body.includes("src: mediaPreview?.dataBase64"),
    false,
    "不得再把可能为空的 dataBase64 直接当作图源",
  );
  assert.ok(
    body.includes('id: current?.failed ? "chat.toolCall.previewFailed" : "chat.toolCall.loading"'),
    "渲染侧必须用 failed 分流失败态，空图源才不会永久 Loading",
  );
});
