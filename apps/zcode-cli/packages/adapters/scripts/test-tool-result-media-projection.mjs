#!/usr/bin/env node
/**
 * T-A1（magic-context-tool-media-roundtrip Step 6）——tool result 媒体块的 provider 投影契约。
 *
 * ============================================================================
 * 这一步锁死的既有形态（adapters 源码不改，纯回归）
 * ============================================================================
 *
 *   - anthropic：image 块内嵌进 `tool-result` 的 `output.value`，类型 `image-data`；
 *   - openai-chat-completions：结构化结果整体 textify，媒体延后成一条后置 user 消息，
 *     以 "Tool result media from <tool>:" 开头；
 *   - inputFormat.supportsImage === false：图片换成 "Media omitted from provider request" 占位文本；
 *   - video：AI SDK tool result 没有 video 变体，anthropic 下同样强制 textify + 后置 user。
 *
 * 上游的 magic-context 往返投影改动后，带媒体的 tool 结果会活着到达这一层；
 * 这些断言保证到达之后的行为与今天逐字节一致。
 *
 * 运行：`node --test scripts/test-tool-result-media-projection.mjs`
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

// Read 图片的原块键序（core read.ts formatReadImageOutput）：type, mediaType, dataUrl, source。
const IMAGE_BLOCK = {
  type: "image",
  mediaType: "image/png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  source: { id: "read-image", placeholder: "Read image" },
};
const VIDEO_BLOCK = {
  type: "video",
  mediaType: "video/mp4",
  dataUrl: "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28y",
};

function imageToolMessage(content = [IMAGE_BLOCK]) {
  return { role: "tool", toolCallId: "call-1", toolName: "Read", content };
}

function toolResultBlock(message) {
  assert.equal(message.role, "tool");
  assert.equal(message.content.length, 1);
  return message.content[0];
}

test("T-A1 anthropic embeds tool-result images as image-data", () => {
  const transformed = toAiSdkMessages([imageToolMessage()], { providerKind: "anthropic" });

  assert.equal(transformed.length, 1);
  const block = toolResultBlock(transformed[0]);
  assert.equal(block.type, "tool-result");
  assert.equal(block.toolCallId, "call-1");
  assert.equal(block.toolName, "Read");
  assert.equal(block.output.type, "content");
  assert.equal(block.output.value.length, 1);
  assert.deepEqual(block.output.value[0], {
    type: "image-data",
    mediaType: "image/png",
    data: IMAGE_BLOCK.dataUrl.slice(IMAGE_BLOCK.dataUrl.indexOf(",") + 1),
  });
});

test("T-A1 anthropic keeps text and image blocks in their original order", () => {
  const transformed = toAiSdkMessages(
    [imageToolMessage([{ type: "text", text: "screenshot" }, IMAGE_BLOCK])],
    { providerKind: "anthropic" },
  );

  const value = toolResultBlock(transformed[0]).output.value;
  assert.deepEqual(
    value.map((part) => part.type),
    ["text", "image-data"],
  );
  assert.equal(value[0].text, "screenshot");
});

test("T-A1 openai-chat-completions moves tool-result media into a trailing user message", () => {
  const transformed = toAiSdkMessages(
    [imageToolMessage([{ type: "text", text: "shot" }, IMAGE_BLOCK])],
    {
      providerKind: "openai",
      apiFormat: "openai-chat-completions",
    },
  );

  assert.equal(transformed.length, 2);

  const block = toolResultBlock(transformed[0]);
  assert.equal(block.output.type, "text");
  // 文本留在 tool 结果里，图片不内嵌；图片只以 contracts 的占位文本形式出现在这里。
  assert.equal(block.output.value, "shot\n\n[Attached image/png: Read image]");

  const trailing = transformed[1];
  assert.equal(trailing.role, "user");
  const intro = trailing.content[0];
  assert.equal(intro.type, "text");
  assert.ok(
    intro.text.startsWith("Tool result media from Read:"),
    `expected trailing intro, got ${JSON.stringify(intro)}`,
  );
  assert.deepEqual(trailing.content[1], {
    type: "image",
    mediaType: "image/png",
    image: IMAGE_BLOCK.dataUrl.slice(IMAGE_BLOCK.dataUrl.indexOf(",") + 1),
  });
});

test("T-A1 supportsImage=false replaces the image with an omitted-media text", () => {
  const inputFormat = { supportsImage: false, supportsPdf: true, supportsVideo: true };
  const transformed = toAiSdkMessages([imageToolMessage()], {
    providerKind: "anthropic",
    inputFormat,
  });

  const block = toolResultBlock(transformed[0]);
  assert.equal(block.output.type, "content");
  assert.equal(block.output.value.length, 1);
  assert.equal(block.output.value[0].type, "text");
  assert.ok(
    block.output.value[0].text.includes("Media omitted from provider request"),
    `expected omitted-media placeholder, got ${JSON.stringify(block.output.value[0])}`,
  );
  // 不支持图片时没有可投递媒体，不得再追加后置 user 消息。
  assert.equal(transformed.length, 1);
});

test("T-A1 video tool results take the trailing user path under anthropic", () => {
  const transformed = toAiSdkMessages([imageToolMessage([VIDEO_BLOCK])], {
    providerKind: "anthropic",
  });

  assert.equal(transformed.length, 2);

  const block = toolResultBlock(transformed[0]);
  // tool-result 里不出现任何内嵌媒体，只有 textify 后的文本。
  assert.equal(block.output.type, "text");
  assert.equal(block.output.value.includes("data:video"), false);

  const trailing = transformed[1];
  assert.equal(trailing.role, "user");
  assert.ok(trailing.content[0].text.startsWith("Tool result media from Read:"));
  assert.deepEqual(trailing.content[1], {
    type: "file",
    mediaType: "video/mp4",
    data: VIDEO_BLOCK.dataUrl.slice(VIDEO_BLOCK.dataUrl.indexOf(",") + 1),
  });
});
