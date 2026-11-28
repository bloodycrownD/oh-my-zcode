#!/usr/bin/env node
/**
 * magic-context-tool-media-roundtrip / Step 5：工具结果里的媒体块经 magic-context
 * transform 一来一回之后必须活着回到模型输入层（T-H1 ~ T-H5）。
 *
 *   T-H1 — 原样往返：Read 图片条目经未改写它的 transform 后仍是原对象、逐字节等值。
 *   T-H2 — 重建路径：原条目找不到（等价 LKG 重放的全量重建）与 output 被打标两种情形。
 *   T-H3 — 丢弃：output 换成 `[dropped §N§]`、attachments 清空 ⇒ 只剩文本，不带媒体。
 *   T-H4 — video / PDF / 无 source 的 image 同样往返等值；纯文本结果零回归。
 *   T-H5 — error 结果不承载媒体；output / error 回退链不抛错。
 *
 * 隔离：MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 显式指 OS 临时目录
 * （mkdtempSync(tmpdir())），绝不写真实 ~/.omz / ~/.zcode。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/magic-context build`、
 * `pnpm --filter @zcode/core build`、`pnpm --filter @zcode/bootstrap build`。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离：必须先于任何被测模块的 import ────────────────────────────────────────
const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-tool-media-roundtrip-"));
process.env.MAGIC_CONTEXT_DB_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEST_HOME, "magic-context.log");
process.on("exit", () => {
  // 尽力而为：清理失败不是用例失败；残留由 OS 临时目录策略回收。
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* 见上 */
  }
});

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);
const PACKAGE_DIST_ENTRY = {
  "@zcode/contracts": `${REPO_ROOT}apps/zcode-cli/packages/contracts/dist/index.js`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = PACKAGE_DIST_ENTRY[specifier];
    if (entry !== undefined) {
      return { url: pathToFileURL(entry).href, shortCircuit: true };
    }
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
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

const { createZCodeMagicContextTurnTransformPort } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

const SESSION_ID = "ses_test_tool_media_roundtrip";
const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP4_DATA_URL = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28y";
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjcK";

/** Read 图片的原始块：键序 `type, mediaType, dataUrl, source`（core read.ts formatReadImageOutput）。 */
function readImageBlock(dataUrl = PNG_DATA_URL) {
  return {
    type: "image",
    mediaType: "image/png",
    dataUrl,
    source: { id: "read-image", placeholder: "Read image" },
  };
}

/** 条目在 entries 里的下标：tool 结果排在 system / user / assistant(toolCall) 之后。 */
const TOOL_ENTRY_INDEX = 3;

/** 一条真实形状的请求：system → user → assistant(toolCall) → tool(被测内容)。 */
function entriesWithToolResult(content, extra = {}) {
  return [
    { kind: "message", message: { role: "system", content: "you are zcode" } },
    {
      kind: "message",
      message: { role: "user", content: "first question" },
      metadata: { source: "real_user" },
    },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "let me read it",
        toolCalls: [{ id: "call_1", name: "read", input: { path: "a.png" } }],
      },
    },
    {
      kind: "message",
      message: {
        role: "tool",
        content,
        toolCallId: "call_1",
        toolName: "read",
        ...extra,
      },
      metadata: { source: "tool_result" },
    },
  ];
}

/**
 * 跑一轮端口：桩 transform 拿到投影后的 messages，对「唯一的 tool part」执行 mutate。
 * 返回反投影后的 tool 条目。
 */
async function roundTrip(content, mutate = () => {}, extra = {}) {
  const entries = entriesWithToolResult(content, extra);
  const seen = {};
  const stub = (_input, output) => {
    for (const message of output.messages) {
      const part = message.parts.find(
        (candidate) => candidate.type === "tool" && candidate.callID === "call_1",
      );
      if (part === undefined) continue;
      seen.message = message;
      seen.part = part;
      mutate(part, message);
    }
  };
  const port = createZCodeMagicContextTurnTransformPort(stub, {
    getConfig: () => ({}),
    options: { sessionId: SESSION_ID, logger: NOOP_LOGGER },
  });
  const result = await port({
    entries,
    model: { providerId: "zcode", modelId: "glm-4.6" },
    sessionId: SESSION_ID,
    workingDirectory: "D:/tmp/project",
  });
  assert.ok(seen.part, "桩 transform 必须看到 call_1 的 tool part");
  const restored = result.entries[TOOL_ENTRY_INDEX];
  assert.equal(restored?.message?.role, "tool", "反投影后 tool 条目仍在原下标");
  return { restored, original: entries[TOOL_ENTRY_INDEX], seen, result };
}

const json = (value) => JSON.stringify(value);

test("T-H1 Read 图片条目原样往返：复用原对象、content 逐字节等值", async () => {
  const content = [readImageBlock()];
  const before = json(content);
  const { restored, original, seen } = await roundTrip(content);
  assert.equal(seen.part.state.output, "", "纯图片结果的文本部分为空串");
  assert.deepEqual(
    seen.part.state.attachments,
    [{ mime: "image/png", url: PNG_DATA_URL }],
    "图片进 attachments",
  );
  assert.equal(
    json(seen.part.state.mediaLayout?.[0]),
    `{"attachment":0,"block":{"type":"image","mediaType":"image/png","dataUrl":null,"source":{"id":"read-image","placeholder":"Read image"}}}`,
  );
  assert.equal(restored, original, "transform 未改动 ⇒ 必须复用原对象（不得每 pass 重建）");
  assert.equal(json(restored.message.content), before);
  assert.equal(json(content), before, "投影不得突变宿主数据");
});

test("T-H2 重建路径：原条目找不到与 output 被打标时都还原出文本 + 图片", async () => {
  const content = [{ type: "text", text: "here is the picture" }, readImageBlock()];
  const before = json(content);

  const rebuilt = await roundTrip(content, (_part, message) => {
    message.info.id = "mc_rewritten";
  });
  assert.notEqual(
    rebuilt.restored,
    rebuilt.original,
    "info.id 被改写 ⇒ originals 里找不到原条目，走重建",
  );
  assert.equal(json(rebuilt.restored.message.content), before, "重建出的两块顺序与键序不变");

  const tagged = await roundTrip(content, (part) => {
    part.state.output = `§3§ ${part.state.output}`;
  });
  assert.equal(tagged.restored.message.toolCallId, "call_1");
  assert.equal(
    json(tagged.restored.message.content),
    `[{"type":"text","text":"§3§ here is the picture"},${json(readImageBlock())}]`,
  );
});

test("T-H3 丢弃：output 换成 [dropped §N§] 且 attachments 清空 ⇒ 只剩文本", async () => {
  const content = [readImageBlock()];
  const { restored } = await roundTrip(content, (part) => {
    part.state.output = "[dropped §3§]";
    part.state.attachments = [];
  });
  const restoredContent = restored.message.content;
  const equivalent =
    restoredContent === "[dropped §3§]" ||
    (Array.isArray(restoredContent) &&
      restoredContent.length === 1 &&
      restoredContent[0].type === "text" &&
      restoredContent[0].text === "[dropped §3§]");
  assert.ok(equivalent, `还原为 dropped 文本，实际：${json(restoredContent)}`);
  assert.equal(json(restoredContent).includes('"image"'), false, "不含任何 image 块");
});

test("T-H4 video / PDF / 无 source 的 image 往返等值；纯文本结果零回归", async () => {
  const videoBlock = { type: "video", mediaType: "video/mp4", dataUrl: MP4_DATA_URL };
  const pdfBlock = { type: "file", mediaType: "application/pdf", dataUrl: PDF_DATA_URL };
  const mcpImageBlock = {
    type: "image",
    mediaType: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,/9j/4AAQ",
  };

  for (const [label, content, attachments] of [
    ["video", [videoBlock], [{ mime: "video/mp4", url: MP4_DATA_URL }]],
    [
      "Read PDF",
      [{ type: "text", text: "the pdf" }, pdfBlock],
      [{ mime: "application/pdf", url: PDF_DATA_URL }],
    ],
    ["无 source 的 image", [mcpImageBlock], [{ mime: "image/jpeg", url: mcpImageBlock.dataUrl }]],
  ]) {
    const before = json(content);
    const { restored, original, seen } = await roundTrip(content);
    assert.deepEqual(seen.part.state.attachments, attachments, `${label}：attachments`);
    assert.equal(restored, original, `${label}：复用原对象`);
    assert.equal(json(restored.message.content), before, `${label}：content 逐字节等值`);
  }

  const { restored, original, seen } = await roundTrip("file body");
  assert.equal("attachments" in seen.part.state, false, "纯文本结果不带 attachments 键");
  assert.equal("mediaLayout" in seen.part.state, false, "纯文本结果不带 mediaLayout 键");
  assert.equal(restored, original, "纯文本结果仍是原对象");
  assert.equal(json(restored), json(original), "纯文本条目形状与改前一致");
});

test("T-H5 error 结果不承载媒体；output / error 回退链不抛错", async () => {
  const { restored, seen } = await roundTrip(
    [readImageBlock(), { type: "text", text: "read failed" }],
    () => {},
    {
      isError: true,
    },
  );
  assert.equal(seen.part.state.status, "error");
  assert.equal("attachments" in seen.part.state, false, "error 结果不带 attachments 键");
  assert.equal("mediaLayout" in seen.part.state, false, "error 结果不带 mediaLayout 键");
  assert.equal(restored.message.isError, true);
  assert.equal(restored.message.content, "read failed", "error 结果还原为 error 文本");

  const viaError = await roundTrip("file body", (part) => {
    delete part.state.output;
    part.state.error = "boom";
  });
  assert.equal(viaError.restored.message.content, "boom");

  const empty = await roundTrip("file body", (part) => {
    part.state.output = undefined;
    part.state.error = undefined;
  });
  assert.equal(empty.restored.message.content, "");
});
