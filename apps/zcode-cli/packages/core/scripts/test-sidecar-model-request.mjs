#!/usr/bin/env node
/**
 * Step 25 单测（node:test，零新依赖）——旁路原语 `runSidecarModelRequest` 的
 * `compact_stream_boundary` 分支。
 *
 * 本步是一次**纯机械更名**（`compact-summary-model-request.ts` →
 * `sidecar-model-request.ts`），语义一行未动。所以这个文件存在的理由不是「测更名」，
 * 而是把更名之前一直只靠注释担保的那条链路钉死：
 *
 *   `SidecarModelCallOptions.preserveProviderStreamBoundaries: true`（包内字面量硬约束）
 *     → bootstrap `magic-context-historian.ts` 原样透传
 *       → core 原语把它放进 model invocation context
 *         → provider 适配层因此发出 `compact_stream_boundary` 事件
 *           → **本文件**在这里消费这些事件，决定 content block 到底提交了没有
 *
 * 最后一环此前没有任何直接断言：event 停了不会抛错、不会让任何测试变红，只会让
 * tool-call 的提交判定静默退化成「SDK 归一化的块结束位置 suggests 它提交了」——
 * 一个 provider 明明已经提交的工具调用会被当成没提交而重发。因此下面第 1/4 项
 * 专门让 `compact_stream_boundary` 的 case 分支**必须真的执行**，且执行结果必须
 * 改变返回与抛错。
 *
 * 事件形状对照 `packages/contracts/src/model/index.ts` 的 `ModelStreamEvent`
 * （`compact_stream_boundary` 的五个成员 + text/finish 成员）。fake Model 直接
 * yield 事件序列，不碰真实 provider。
 *
 * 与 `packages/bootstrap/scripts/test-magic-context-historian.mjs` 共用同一个
 * resolve 钩子：`@zcode/shared` / `@zcode/model-option-map` 的包入口发布的是原始
 * TypeScript，裸 `node` 无法处理。钩子把它们改指到同布局的编译产物。
 *
 * 依赖已构建的 `dist/`：`pnpm --filter @zcode/contracts build`、
 * `pnpm --filter @zcode/core build`（以及它 transitively 需要的
 * `@zcode/shared` / `@zcode/model-option-map` dist）。
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

const { createRootTraceContext } = await import("@zcode/contracts");
const { runSidecarModelRequest } = await import(
  new URL("../dist/runtime/methods/sidecar-model-request.js", import.meta.url).href
);

const MESSAGES = [
  { role: "system", content: "you are a sidecar" },
  { role: "user", content: "summarise this" },
];

const USAGE = { inputTokens: 11, outputTokens: 5, totalTokens: 16 };

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

/** 收集 warn，供 fallback 那项断言「确实走过 non-stream 通道」使用。 */
function loggerWithWarnings() {
  const warnings = [];
  return {
    warnings,
    logger: {
      ...NOOP_LOGGER,
      warn(message, context) {
        warnings.push({ message, context });
      },
    },
  };
}

/**
 * 一个**真的能被原语消费**的假 Model：`streamText` 按脚本吐事件，`generateText`
 * 记录调用并回一个固定结果（只有 non-stream fallback 才会走到它）。
 */
function fakeModel(observed, { script = [], generateResult, streamError } = {}) {
  const model = {
    providerId: "zcode",
    modelId: "fake-model",
    bind() {
      return model;
    },
    async generateText(request) {
      observed.generateTextCalls.push(request);
      return (
        generateResult ?? {
          text: "NON_STREAM",
          finishReason: "stop",
          usage: USAGE,
        }
      );
    },
    async *streamText(request) {
      observed.streamTextCalls.push(request);
      let index = 0;
      for (const event of script) {
        if (streamError !== undefined && index === streamError.at) {
          throw streamError.error;
        }
        index += 1;
        yield event;
      }
      if (streamError !== undefined && index === streamError.at) {
        throw streamError.error;
      }
    },
  };
  return model;
}

function observe() {
  return { streamTextCalls: [], generateTextCalls: [] };
}

/**
 * 一条完整的 raw-message-block provenance：`provider_response_start` →
 * `provider_content_block_start` → `provider_content_block_delta`(text_delta) →
 * `provider_content_block_stop` → `provider_stop_reason`。
 */
function provenance({ stopReasonPresent = true, contentBlockStop = true } = {}) {
  const events = [
    { type: "compact_stream_boundary", boundary: "provider_response_start" },
    {
      type: "compact_stream_boundary",
      boundary: "provider_content_block_start",
      blockType: "text",
      index: 0,
    },
  ];
  events.push({
    type: "compact_stream_boundary",
    boundary: "provider_content_block_delta",
    deltaType: "text_delta",
    index: 0,
  });
  if (contentBlockStop) {
    events.push({
      type: "compact_stream_boundary",
      boundary: "provider_content_block_stop",
      index: 0,
    });
  }
  events.push({
    type: "compact_stream_boundary",
    boundary: "provider_stop_reason",
    present: stopReasonPresent,
  });
  return events;
}

function textEvents(text, id = "b0") {
  return [
    { type: "text_start", id },
    { type: "text_delta", id, text },
    { type: "text_end", id },
  ];
}

function finishEvent(overrides = {}) {
  return {
    type: "finish",
    finishReason: "stop",
    usage: USAGE,
    ...overrides,
  };
}

function call(model, request = {}, logger = NOOP_LOGGER) {
  return runSidecarModelRequest({
    logger,
    model,
    request: {
      messages: MESSAGES,
      traceContext: createRootTraceContext(),
      // 与 historian 的接线面一致：唯一能让 adapter 发出 `compact_stream_boundary`
      // 的那一位。historian 侧的传递链由 test-magic-context-historian.mjs 断言。
      preserveProviderStreamBoundaries: true,
      ...request,
    },
  });
}

test("raw provenance + provider_content_block_stop：boundary 分支驱动提交判定，正文正常返回", async () => {
  const observed = observe();
  const model = fakeModel(observed, {
    script: [{ type: "start" }, ...provenance(), ...textEvents("HELLO SIDECAR"), finishEvent()],
  });

  const result = await call(model);

  assert.equal(result.text, "HELLO SIDECAR");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.totalTokens, 16);
  assert.equal(result.toolCalls, undefined);
  assert.equal(
    observed.generateTextCalls.length,
    0,
    "提交证明已经成立，绝不能退回 non-stream（重发会重复计费/重复执行工具调用）",
  );
});

test("观察到 providerMessageProtocol 却没有 content_block_stop：normalized end 不再充当提交证明", async () => {
  const observed = observe();
  const { warnings, logger } = loggerWithWarnings();
  // text_start/text_delta/text_end 一个不缺，`finish` 也在——只有 raw provenance
  // 缺一半。这条流在「normalized end 即提交证明」的旧语义下会被接受；现在必须被判
  // 为不完整流，整段丢弃并改走 non-stream。
  const model = fakeModel(observed, {
    script: [
      { type: "start" },
      ...provenance({ stopReasonPresent: false, contentBlockStop: false }),
      ...textEvents("ALMOST"),
      finishEvent(),
    ],
    generateResult: {
      text: "NON-STREAM AFTER INCOMPLETE STREAM",
      finishReason: "stop",
      usage: USAGE,
    },
  });

  const result = await call(model, {}, logger);

  assert.equal(
    result.text,
    "NON-STREAM AFTER INCOMPLETE STREAM",
    "不完整流被丢弃：`text_end` 不再能充当提交证明",
  );
  assert.equal(observed.generateTextCalls.length, 1, "不完整流必须重放一次");
  assert.ok(
    warnings.some((entry) => entry.context?.event === "sidecar.stream_to_non_stream_fallback"),
    `expected the fallback diagnostic, got ${JSON.stringify(warnings)}`,
  );
});

test("对照：完全没有 raw provenance 的 provider 仍走 normalized end 推断（不回归）", async () => {
  const observed = observe();
  const model = fakeModel(observed, {
    script: [{ type: "start" }, ...textEvents("NO PROVENANCE"), finishEvent()],
  });

  const result = await call(model);
  assert.equal(result.text, "NO PROVENANCE");
});

test("boundary 分支确实被执行：orphan content_block_stop 让整条流作废并重放", async () => {
  const observed = observe();
  // 这条断言是「compact_stream_boundary 的 case 被命中」的直接证据：没有先跑过
  // `applySidecarProviderBoundary`，orphan stop 就不可能被识别成 orphan——`ORPHAN`
  // 这段正文会被原样返回，generateText 一次都不会被调用。
  const model = fakeModel(observed, {
    script: [
      { type: "start" },
      {
        type: "compact_stream_boundary",
        boundary: "provider_content_block_start",
        blockType: "text",
        index: 0,
      },
      // 没有 provider_response_start：这是 orphan stop。
      { type: "compact_stream_boundary", boundary: "provider_content_block_stop", index: 0 },
      ...textEvents("ORPHAN"),
      finishEvent(),
    ],
    generateResult: { text: "NON-STREAM AFTER ORPHAN STOP", finishReason: "stop", usage: USAGE },
  });

  const result = await call(model);

  assert.equal(
    result.text,
    "NON-STREAM AFTER ORPHAN STOP",
    "orphan content_block_stop 必须在 boundary case 里被识别出来",
  );
  assert.equal(observed.generateTextCalls.length, 1);
});

test("流中段抛错且尚未提交：退回 non-stream，generateText 真的被调用", async () => {
  const observed = observe();
  const { warnings, logger } = loggerWithWarnings();
  const model = fakeModel(observed, {
    script: [{ type: "start" }, ...textEvents("HALF")],
    streamError: { at: 2, error: new Error("provider socket died") },
    generateResult: { text: "FALLBACK TEXT", finishReason: "stop", usage: USAGE },
  });

  const result = await call(model, {}, logger);

  assert.equal(result.text, "FALLBACK TEXT");
  assert.equal(observed.generateTextCalls.length, 1);
  assert.equal(observed.streamTextCalls.length, 1);
  assert.deepEqual(
    observed.generateTextCalls[0].messages.map((message) => message.role),
    ["system", "user"],
    "重放必须带同一份 messages",
  );
  assert.ok(
    warnings.some((entry) => entry.context?.event === "sidecar.stream_to_non_stream_fallback"),
    `expected the fallback diagnostic, got ${JSON.stringify(warnings)}`,
  );
});

test("已经提交之后再抛错：不退回 non-stream（避免重发已提交的工具调用）", async () => {
  const observed = observe();
  const { logger } = loggerWithWarnings();
  const model = fakeModel(observed, {
    script: [{ type: "start" }, ...provenance(), ...textEvents("COMMITTED")],
    // 索引落在 provenance 之后、finish 之前：commit 已经成立。
    streamError: { at: 8, error: new Error("tail error after commit") },
  });

  await assert.rejects(() => call(model, {}, logger), /tail error after commit/);
  assert.equal(observed.generateTextCalls.length, 0, "已提交的内容块绝不能被第二种 transport 重放");
});
