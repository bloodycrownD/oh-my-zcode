#!/usr/bin/env node
/**
 * T-T1（agent-lang-trace-usage-batch / Step 5 B1）——model-io tail 记录携带 messagesHead。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * 轨迹面板「系统消息加载不出来」的根因在写入侧：`MAX_ROLLOUT_BASELINE_MESSAGES=64`
 * （开发态 256）的 tail 窗口把 offset 之前的历史裁掉，而系统段与首轮注入（session-history /
 * skills / project-memory）恰好全在头部——磁盘上根本没有这些消息，读取侧再怎么拼也还原不出来。
 *
 * 写入侧修复（`attachMessagesHeadForTail`）在 **canonical `request.messages` 的 tail 组装点**
 * 附加专用键：
 *   - `messagesHead`：前 K=12 条消息（整条消息为单位，不砍消息内文本）；
 *   - 字节预算 64KB（按 head 数组的真实序列化字节计），**首条豁免**（首条超限允许突破）；
 *   - `headMessageCount`：实际保留条数（与读取映射字段同名）；
 *   - `messagesHeadTruncated`：**字节预算**是否把 head 截短（12 条上限是设计常量，不计入）；
 *   - sdkMessages / body.messages 不写 head；`messageCount` 仍为压缩前全量长度。
 *
 * 用 `recordStreamTextDebug` 的 `debugDir` 注入缝把记录写到临时目录，再读回 JSONL 断言——
 * 这条链路正好覆盖 `prepareModelIORecordForWrite` + `compactModelIORequest` + 序列化。
 *
 * 运行：`node --test scripts/test-runner-debug-head.mjs`
 * （先 `pnpm --filter @zcode/adapters build`；workspace 里发布原始 TS 的包由下面的 resolve
 *  钩子改指到同布局 `dist/`。）
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const { recordStreamTextDebug } = await import("../dist/model/runner-debug.js");

const HEAD_MAX_COUNT = 12;
const HEAD_MAX_BYTES = 64 * 1024;
// 开发态 baseline 是 256 条；超过才会落 tail 记录（生产态是 64，但生产记录会删 sdkMessages/body）。
const DEV_BASELINE_MESSAGES = 256;

function headLengthOf(message) {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

// 首 12 条用 headTextLength 构造（控制字节预算），其余消息用小文本，保证 tail 只由条数触发。
function buildMessages(count, { headTextLength = 48, bodyTextLength = 12 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    role: index === 0 ? "system" : index % 2 === 1 ? "user" : "assistant",
    content:
      index < HEAD_MAX_COUNT
        ? `m${index}:` + "h".repeat(headTextLength)
        : `m${index}:` + "t".repeat(bodyTextLength),
  }));
}

async function writeAndReadRecord({ messages, sessionId }) {
  const debugDir = mkdtempSync(join(tmpdir(), "omz-model-io-head-"));
  try {
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      isDev: true,
      modelIoFullRetentionEnabled: false,
      normalizedToolCalls: [],
      // sdkMessages 集合与 canonical 同源（options.messages），验证只有 canonical 挂 head。
      options: { messages },
      recordModelIO: true,
      request: {
        messages,
        metadata: { querySource: "main_turn", sessionId, turnId: "turn-tt1" },
      },
      requestId: "req-tt1",
      // request.body 由 resolved.rawRequestBodyCapture 提供（AI SDK 真实请求体快照），
      // 与 request.messages / options.messages 同源，验证只有 canonical 集合挂 head。
      resolved: {
        modelId: "test-model",
        properties: {},
        providerId: "test-provider",
        rawRequestBodyCapture: { body: { messages } },
      },
      startedAt: Date.now(),
    });

    const filePath = join(debugDir, `model-io-${sessionId}.jsonl`);
    assert.equal(existsSync(filePath), true, `model-io 文件未落盘: ${filePath}`);
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0]);
  } finally {
    rmSync(debugDir, { force: true, recursive: true });
  }
}

test("T-T1 tail 记录携带前 12 条 messagesHead（未触发字节预算）", async () => {
  const messages = buildMessages(DEV_BASELINE_MESSAGES + 44);
  const record = await writeAndReadRecord({ messages, sessionId: "tt1-head-ok" });
  const request = record.request;

  // canonical 集合落 tail：条数契约仍是压缩前全量，窗口是最近 256 条。
  assert.equal(request.messagesKind, "tail");
  assert.equal(request.messageCount, messages.length);
  assert.equal(request.messageOffset, 44);
  assert.equal(request.messages.length, DEV_BASELINE_MESSAGES);
  assert.deepEqual(request.messages, messages.slice(44));

  // head = 前 12 条，首条是 system 段——这正是过去磁盘上缺失、面板加载不出来的内容。
  assert.equal(Array.isArray(request.messagesHead), true);
  assert.equal(request.messagesHead.length, HEAD_MAX_COUNT);
  assert.equal(request.headMessageCount, HEAD_MAX_COUNT);
  assert.equal(request.messagesHeadTruncated, false);
  assert.deepEqual(request.messagesHead, messages.slice(0, HEAD_MAX_COUNT));
  assert.equal(request.messagesHead[0].role, "system");

  // 序列化 head ≤64KB。
  const headBytes = Buffer.byteLength(JSON.stringify(request.messagesHead), "utf8");
  assert.ok(headBytes <= HEAD_MAX_BYTES, `head 序列化 ${headBytes} 字节超过 64KB 预算`);

  // sdkMessages / body.messages 同为 tail，但不写 head（只挂 canonical 专用键）。
  assert.equal(request.sdkMessagesKind, "tail");
  assert.deepEqual(request.sdkMessages, messages.slice(44));
  assert.equal(request.bodyMessagesKind, "tail");
  assert.deepEqual(request.body.messages, messages.slice(44));
  assert.equal("messagesHead" in request.sdkMessages, false);
  assert.equal("messagesHead" in request.body, false);
  assert.equal("sdkMessagesHead" in request, false);
  assert.equal("headMessageCount" in request.body, false);
});

test("T-T1 head 字节预算按整条消息截断，messagesHeadTruncated 置位", async () => {
  // 首 13 条各约 8KB：12 条 ≈96KB，必然在 12 条上限之前先撞 64KB 预算。
  const messages = buildMessages(DEV_BASELINE_MESSAGES + 44, { headTextLength: 8 * 1024 });
  const record = await writeAndReadRecord({ messages, sessionId: "tt1-head-trunc" });
  const request = record.request;

  assert.equal(request.messagesKind, "tail");
  assert.equal(request.messageCount, messages.length);
  assert.equal(request.messagesHeadTruncated, true);
  assert.ok(request.headMessageCount > 0, "首条必须保留");
  assert.ok(
    request.headMessageCount < HEAD_MAX_COUNT,
    `字节预算未生效：headMessageCount=${request.headMessageCount}`,
  );
  assert.equal(request.messagesHead.length, request.headMessageCount);
  // 截断单位是整条消息：head 必须是原消息序列的前缀，不能是半截文本。
  assert.deepEqual(request.messagesHead, messages.slice(0, request.headMessageCount));

  const headBytes = Buffer.byteLength(JSON.stringify(request.messagesHead), "utf8");
  assert.ok(headBytes <= HEAD_MAX_BYTES, `head 序列化 ${headBytes} 字节超过 64KB 预算`);
  // 被挡在外面的是第一条超预算消息：head 条数外的下一条将突破预算。
  const nextMessageBytes = headLengthOf(messages[request.headMessageCount]);
  assert.ok(
    headBytes + 2 + nextMessageBytes > HEAD_MAX_BYTES,
    "预算还有余量却提前截断",
  );
});

test("T-T1 首条超预算时豁免（允许突破 64KB）", async () => {
  const messages = buildMessages(DEV_BASELINE_MESSAGES + 44);
  messages[0] = {
    role: "system",
    content: "s:" + "x".repeat(HEAD_MAX_BYTES + 4096),
  };
  const record = await writeAndReadRecord({ messages, sessionId: "tt1-head-first-exempt" });
  const request = record.request;

  assert.equal(request.headMessageCount, 1);
  assert.equal(request.messagesHeadTruncated, true);
  assert.deepEqual(request.messagesHead, [messages[0]]);
  const headBytes = Buffer.byteLength(JSON.stringify(request.messagesHead), "utf8");
  assert.ok(
    headBytes > HEAD_MAX_BYTES,
    "首条超限必须原样保留（首条豁免），否则 head 失去保留系统段的意义",
  );
});

test("T-T1 full 记录不写 head，messageCount 等于可见条数", async () => {
  const messages = buildMessages(DEV_BASELINE_MESSAGES - 6);
  const record = await writeAndReadRecord({ messages, sessionId: "tt1-full" });
  const request = record.request;

  assert.equal(request.messagesKind, "full");
  assert.equal(request.messageOffset, 0);
  assert.equal(request.messageCount, messages.length);
  assert.equal(request.messages.length, messages.length);
  assert.equal(request.bodyMessagesKind, "full");
  assert.equal("messagesHead" in request, false);
  assert.equal("headMessageCount" in request, false);
  assert.equal("messagesHeadTruncated" in request, false);
});
