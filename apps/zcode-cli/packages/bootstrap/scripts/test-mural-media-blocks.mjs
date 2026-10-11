#!/usr/bin/env node
/**
 * Step 15 / T-MU2（bugfix-batch-20261011，phase-mc-prompt-surface）：
 * mural PNG 的**承载通道** —— mediaBlocks 从包内注入到 provider 请求的最后一跃。
 *
 * 覆盖本步交付的三段桥：
 *
 *   T-MU2a — 反投影：包内 `prependM0M1Messages` 注入的壁画 part
 *            （`{type:"file", mime:"image/png", url:dataUrl, synthetic:true}`）经
 *            桩 transform 进端口，反投影必须把它提成 attachment 的
 *            `mediaBlocks: [{type:"image", mediaType:"image/png", dataUrl}]`，
 *            文本仍走 `content`——「渲染了但模型永远看不到」的缺口到此闭合。
 *            m[0]/m[1] 的落位规矩（system 前缀之后、位于最前）不破。
 *   T-MU2b — 无图片 part 时 attachment **不带** mediaBlocks 键：形状与改动前
 *            逐字节一致（可选字段缺席 ⇒ 既有比较/落盘路径零变化）。
 *   T-MU2c — core provider 投影：带 mediaBlocks 的 attachment 投影成
 *            `content: [text block, image block]` 的 user message；不带时仍是
 *            裸字符串 content（改动前形态）。图片走
 *            `ModelImageContentBlock`（contracts）这一 message 变体。
 *   T-MU2d — 正投影往返：宿主侧带 mediaBlocks 的附件经包侧 projectRuntimeEntries
 *            投影为「text part + image part」，且 projectMessageUnchanged 判定
 *            未改动（pass 间不得白白重建条目）。
 *   T-MU2e — vision probe 透传：`createMagicContextTurnTransform` 把宿主
 *            （create-app 经 provider Registry 解析 supportsImage）传入的
 *            `muralVisionProbe` 注册进包内 —— `modelKeyAcceptsImages` 随之拿到
 *            真值；不传时恒 false（fail-closed，运行期 mural 静默不触发）。
 *
 * 隔离：MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 显式指 OS 临时目录
 * （mkdtempSync(tmpdir())），绝不写真实 ~/.omz / ~/.zcode。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/magic-context build`、
 * `pnpm --filter @zcode/core build`、`pnpm --filter @zcode/bootstrap build`。
 * 与 `test-magic-context-turn-transform.mjs` / `test-settle-background.mjs` 同一
 * 范式：registerHooks 把发布原始 TS 的 workspace 包改指到同布局编译产物。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 隔离：必须先于任何被测模块的 import ────────────────────────────────────────
const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-mural-media-"));
process.env.MAGIC_CONTEXT_DB_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEST_HOME, "magic-context.log");
process.on("exit", () => {
  // 尽力而为：真工厂那条用例会开 SQLite 句柄，进程退出前不释放（Windows EPERM）。
  // 清理失败不是用例失败；残留由 OS 临时目录策略回收。
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

const {
  modelKeyAcceptsImages,
  projectMessageUnchanged,
  projectRuntimeEntries,
  setMuralVisionProbe,
} = await import("@zcode/magic-context");
const { createMagicContextTurnTransform, createZCodeMagicContextTurnTransformPort } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);
const { buildProviderRequestMessages } = await import(
  new URL("../../core/dist/runtime/helpers/provider-request-messages.js", import.meta.url).href
);

const SESSION_ID = "ses_test_mural_media";
const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

/** 一枚真 PNG data URL（1x1 透明像素）——形状即线格式，字节内容无关断言。 */
const MURAL_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function sampleEntries() {
  return [
    { kind: "message", message: { role: "system", content: "you are zcode" } },
    {
      kind: "message",
      message: { role: "user", content: "first question" },
      metadata: { source: "real_user" },
    },
  ];
}

function portWith(transform) {
  return createZCodeMagicContextTurnTransformPort(transform, {
    getConfig: () => ({}),
    options: { sessionId: SESSION_ID, logger: NOOP_LOGGER },
  });
}

async function runPort(port, entries) {
  return await port({
    entries,
    model: { providerId: "zcode", modelId: "glm-4.6" },
    sessionId: SESSION_ID,
    workingDirectory: "D:/tmp/project",
  });
}

/** 复刻 `inject-compartments.ts:prependM0M1Messages` 的注入形状（含壁画 part）。 */
const injectM0WithMural = async (_input, output) => {
  output.messages.unshift(
    {
      info: { role: "user", sessionID: SESSION_ID, syntheticHead: true },
      parts: [
        {
          type: "text",
          text: "<project-memory>…</project-memory>\n<memory-mural>…",
          synthetic: true,
        },
        { type: "file", mime: "image/png", url: MURAL_DATA_URL, synthetic: true },
      ],
    },
    {
      info: { role: "user", sessionID: SESSION_ID, syntheticHead: true },
      parts: [{ type: "text", text: "<session-history>…</session-history>", synthetic: true }],
    },
  );
};

test("T-MU2a 壁画 part 反投影成 attachment.mediaBlocks（PNG 上路）", async () => {
  const result = await runPort(portWith(injectM0WithMural), sampleEntries());
  const heads = result.entries.filter(
    (entry) => entry.kind === "attachment" && entry.metadata.source === "magic_context",
  );
  assert.equal(heads.length, 2, "m[0]/m[1] 两条 synthetic head");
  const m0 = heads[0];
  assert.ok(m0.content.includes("<memory-mural>"), "文本仍走 content");
  // 关键断言：PNG 以 ModelImageContentBlock 进 mediaBlocks。
  assert.deepEqual(m0.mediaBlocks, [
    { type: "image", mediaType: "image/png", dataUrl: MURAL_DATA_URL },
  ]);
  const m1 = heads[1];
  assert.equal("mediaBlocks" in m1 && m1.mediaBlocks !== undefined, false, "m[1] 无图片");
  // 落位规矩不破：system 段之后、位于最前。
  const positions = result.syntheticHeadPositions;
  assert.deepEqual(positions, [1, 2], "heads 落在 system 前缀之后");
});

test("T-MU2b 无图片 part ⇒ attachment 不带 mediaBlocks 键（形状不变）", async () => {
  const injectTextOnly = async (_input, output) => {
    output.messages.unshift({
      info: { role: "user", sessionID: SESSION_ID, syntheticHead: true },
      parts: [{ type: "text", text: "<project-memory>…</project-memory>", synthetic: true }],
    });
  };
  const result = await runPort(portWith(injectTextOnly), sampleEntries());
  const head = result.entries.find(
    (entry) => entry.kind === "attachment" && entry.metadata.source === "magic_context",
  );
  assert.ok(head);
  assert.equal("mediaBlocks" in head, false, "可选字段必须缺席，而不是空数组");
});

test("T-MU2c core provider 投影：mediaBlocks ⇒ user message content [text, image]", () => {
  const withMedia = buildProviderRequestMessages({
    entries: [
      {
        kind: "attachment",
        content: "<project-memory>…</project-memory>",
        mediaBlocks: [{ type: "image", mediaType: "image/png", dataUrl: MURAL_DATA_URL }],
        metadata: { source: "magic_context" },
      },
    ],
  });
  assert.equal(withMedia.messages.length, 1);
  const content = withMedia.messages[0].content;
  assert.ok(Array.isArray(content), "带 mediaBlocks 时 content 必须是块数组");
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text.includes("<system-reminder>"), "文本仍走 system-reminder 包装");
  assert.deepEqual(content[1], {
    type: "image",
    mediaType: "image/png",
    dataUrl: MURAL_DATA_URL,
  });

  const withoutMedia = buildProviderRequestMessages({
    entries: [
      {
        kind: "attachment",
        content: "<project-memory>…</project-memory>",
        metadata: { source: "magic_context" },
      },
    ],
  });
  assert.equal(
    typeof withoutMedia.messages[0].content,
    "string",
    "无 mediaBlocks 时保持裸字符串 content（改动前形态）",
  );
});

test("T-MU2d 正投影往返：mediaBlocks 随附件投影为 part，且判定未改动", () => {
  const entries = [
    {
      kind: "attachment",
      content: "<project-memory>…</project-memory>",
      mediaBlocks: [{ type: "image", mediaType: "image/png", dataUrl: MURAL_DATA_URL }],
      metadata: { source: "magic_context" },
    },
    {
      kind: "attachment",
      content: "<session-history>…</session-history>",
      metadata: { source: "magic_context" },
    },
  ];
  const projected = projectRuntimeEntries(entries, { idPrefix: "mc" });
  assert.equal(projected[0].parts.length, 2, "text part + image part");
  assert.equal(projected[0].parts[1].type, "image");
  assert.equal(projected[0].parts[1].dataUrl, MURAL_DATA_URL);
  assert.equal(projected[1].parts.length, 1, "无图片附件仍是一个 text part");
  assert.equal(projectMessageUnchanged(projected[0], entries[0]), true);
  assert.equal(projectMessageUnchanged(projected[1], entries[1]), true);
  // transform 往附件里追加文本 ⇒ 必须判定为已改动（条目重建）。
  const tampered = {
    ...projected[0],
    parts: [...projected[0].parts, { type: "text", text: "injected" }],
  };
  assert.equal(projectMessageUnchanged(tampered, entries[0]), false);
});

test("T-MU2e vision probe 透传：宿主选项 ⇒ 包内 modelKeyAcceptsImages", async () => {
  // 真工厂 + 真临时库：probe 在工厂内注册（`setMuralVisionProbe`）。
  const sessionId = "ses_mural_probe";
  const seen = [];
  const port = await createMagicContextTurnTransform({
    enabled: true,
    configDomain: {},
    sessionId,
    workingDirectory: TEST_HOME,
    logger: NOOP_LOGGER,
    muralVisionProbe: (modelKey) => {
      seen.push(modelKey);
      return modelKey === "anthropic/claude-sonnet-4-5";
    },
    registerClose: async () => {},
  });
  assert.ok(port, "flag on 且库开得出来时必须拿到端口");

  assert.equal(modelKeyAcceptsImages("anthropic/claude-sonnet-4-5"), true);
  assert.equal(modelKeyAcceptsImages("anthropic/claude-3-haiku"), false);
  assert.equal(modelKeyAcceptsImages(undefined), false);
  assert.ok(seen.includes("anthropic/claude-sonnet-4-5"));

  // 第二个工厂不传 probe ⇒ 进程级注入被清空（不得残留上一个会话的判定源）。
  const portWithout = await createMagicContextTurnTransform({
    enabled: true,
    configDomain: {},
    sessionId: "ses_mural_probe_off",
    workingDirectory: TEST_HOME,
    logger: NOOP_LOGGER,
    registerClose: async () => {},
  });
  assert.ok(portWithout);
  assert.equal(modelKeyAcceptsImages("anthropic/claude-sonnet-4-5"), false);

  // 收口：不把 probe 泄漏给同一进程里的后续用例。
  setMuralVisionProbe(undefined);
});
