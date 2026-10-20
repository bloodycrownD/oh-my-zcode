/**
 * T-T2 / T-T6（agent-lang-trace-usage-batch / Step 5 B2）——轨迹读取侧 head 合并、缺口口径与
 * toolCalls 映射。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * 1) 写入侧 tail 记录把 offset 之前的历史裁掉（系统段、首轮注入全在头部），读取侧过去对 tail
 *    直接原样返回——面板「系统消息加载不出来」。现在 tail 记录带 `messagesHead`，读取时按
 *    `[...head.slice(0, min(headMessageCount, offset)), ...tail]` 接回：
 *      - head 截到 offset：防与 tail 窗口头部重复、防污染后续 delta 还原；
 *      - head 合并以 `metadataSource === target`（canonical 集合）为门：expandMessageCollection
 *        也被 body.messages / sdkMessages 复用，按 collectionKey 判定会误拼 head；
 *      - delta 记录不套 head（previous 已是展开后的前序窗口）；
 *      - 旧记录无 messagesHead / headMessageCount 时跳过（防 undefined → NaN 切片）。
 * 2) `croppedCount = messageCount − 展开后可见条数`（tail 与 delta 同口径；不用 offset − K——
 *    delta 展开保留前序窗口时该公式失真）。full-retention 全量直写分支无 messageCount，
 *    用 `messageCount ?? messages.length` 兜底。
 * 3) `mapTrajectoryMessages` 过去只映射 content，assistant 的工具调用挂在消息顶层 toolCalls
 *    （ModelInputMessage.toolCalls: ModelToolCall{id,name,input}），导致纯工具调用行在面板里
 *    是空消息（真实样本 554 条）。
 *
 * 载体是 B2 导出的纯函数（tsx --test 直吃 TS 源）。真实 rollout 样本受 MAX_ROLLOUT_FILES=3
 * 轮转不可依赖，仅手工复核。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expandMessageCollection,
  expandModelIODeltaRecords,
  mapTrajectoryMessages,
  mapTrajectoryRecord,
} from "../src/zcode-agent/modelTrajectory.js";

const MESSAGE_KEYS = {
  collectionKey: "messages",
  kindKey: "messagesKind",
  offsetKey: "messageOffset",
} as const;

function message(index: number) {
  return {
    role: index === 0 ? "system" : index % 2 === 1 ? "user" : "assistant",
    content: `m${index}`,
  };
}

function range(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => message(start + index));
}

function contents(messages: unknown[]): string[] {
  return messages.map((entry) => String((entry as { content: unknown }).content));
}

function requestOf(record: Record<string, unknown>): Record<string, unknown> {
  return record.request as Record<string, unknown>;
}

test("T-T2 offset ≥ headMessageCount：head 接回 tail，缺口按可见条数计", () => {
  const full = range(0, 144);
  const offset = 80;
  const [expanded] = expandModelIODeltaRecords([
    {
      request: {
        messages: full.slice(offset),
        messageCount: full.length,
        messagesHead: full.slice(0, 12),
        headMessageCount: 12,
        messageOffset: offset,
        messagesKind: "tail",
      },
    },
  ]);

  const expandedMessages = requestOf(expanded).messages as unknown[];
  assert.equal(expandedMessages.length, 12 + 64);
  // head 之后直接是 tail 窗口起点，中间没有重复。
  assert.deepEqual(contents(expandedMessages.slice(0, 12)), contents(full.slice(0, 12)));
  assert.deepEqual(contents(expandedMessages.slice(12)), contents(full.slice(offset)));
  assert.equal(contents(expandedMessages)[0], "m0");

  const mapped = mapTrajectoryRecord(expanded);
  assert.equal(mapped.request.messages.length, 76);
  // 五个新字段（messageCount/messageOffset/messagesKind/headMessageCount/croppedCount）全部就位。
  assert.equal(mapped.request.messageCount, 144);
  assert.equal(mapped.request.messageOffset, 80);
  assert.equal(mapped.request.messagesKind, "tail");
  assert.equal(mapped.request.headMessageCount, 12);
  // 中间仍缺 m12..m79 共 68 条。
  assert.equal(mapped.request.croppedCount, 144 - 76);
  assert.equal(mapped.request.croppedCount, 68);
});

test("T-T2 offset < headMessageCount：head 截到 offset，整体无重复", () => {
  const full = range(0, 40);
  const offset = 5;
  const [expanded] = expandModelIODeltaRecords([
    {
      request: {
        messages: full.slice(offset),
        messageCount: full.length,
        messagesHead: full.slice(0, 12),
        headMessageCount: 12,
        messageOffset: offset,
        messagesKind: "tail",
      },
    },
  ]);

  const expandedMessages = requestOf(expanded).messages as unknown[];
  // head 只保留前 5 条（= offset），与 tail 起点 m5 无缝衔接。
  assert.equal(expandedMessages.length, full.length);
  assert.deepEqual(contents(expandedMessages), contents(full));

  const mapped = mapTrajectoryRecord(expanded);
  assert.equal(mapped.request.croppedCount, 0);
  assert.equal(mapped.request.headMessageCount, 12);
});

test("T-T2 head 被字节预算截断、不足 offset：缺口并入 croppedCount", () => {
  const full = range(0, 100);
  const offset = 20;
  const headMessageCount = 8; // 写入侧 64KB 预算把 head 截到 8 条
  const [expanded] = expandModelIODeltaRecords([
    {
      request: {
        messages: full.slice(offset),
        messageCount: full.length,
        messagesHead: full.slice(0, headMessageCount),
        headMessageCount,
        messageOffset: offset,
        messagesKind: "tail",
      },
    },
  ]);

  const expandedMessages = requestOf(expanded).messages as unknown[];
  assert.equal(expandedMessages.length, headMessageCount + 80);
  assert.deepEqual(contents(expandedMessages.slice(headMessageCount, headMessageCount + 1)), [
    "m20",
  ]);

  const mapped = mapTrajectoryRecord(expanded);
  // m8..m19 共 12 条（offset − headMessageCount）同时落在 head 之外、tail 之前。
  assert.equal(mapped.request.croppedCount, 12);
  assert.equal(mapped.request.croppedCount, offset - headMessageCount);
});

test("T-T2 delta 不套 head：前序窗口用 previous 展开结果，后续 delta 不污染", () => {
  const full = range(0, 11);
  const tailRecord = {
    request: {
      messages: full.slice(5, 10),
      messageCount: 10,
      messagesHead: full.slice(0, 12),
      headMessageCount: 12,
      messageOffset: 5,
      messagesKind: "tail",
    },
  };
  const deltaRecord = {
    request: {
      // delta 记录本不该带 head；故意塞一份，验证读取侧不会误拼。
      messages: [full[10]],
      messageCount: 11,
      messagesHead: full.slice(0, 12),
      headMessageCount: 12,
      messageOffset: 10,
      messagesKind: "delta",
    },
  };

  const expanded = expandModelIODeltaRecords([tailRecord, deltaRecord]);
  assert.equal((requestOf(expanded[0]).messages as unknown[]).length, 10);
  // delta = previous.slice(0, 10) + [m10]，既不重复 head，也不丢前序上下文。
  assert.deepEqual(contents(requestOf(expanded[1]).messages as unknown[]), contents(full));

  const mapped = mapTrajectoryRecord(expanded[1]);
  assert.equal(mapped.request.messages.length, 11);
  assert.equal(mapped.request.croppedCount, 0);
});

test("T-T2 旧 tail 记录无 head / headMessageCount：跳过合并、不产生 NaN", () => {
  const full = range(0, 144);
  const legacy = {
    request: {
      messages: full.slice(80),
      messageCount: 144,
      messageOffset: 80,
      messagesKind: "tail",
    },
  };
  const [expanded] = expandModelIODeltaRecords([legacy]);
  assert.equal((requestOf(expanded).messages as unknown[]).length, 64);

  const mapped = mapTrajectoryRecord(expanded);
  assert.equal(mapped.request.messages.length, 64);
  assert.equal(mapped.request.croppedCount, 80);
  assert.equal(mapped.request.headMessageCount, undefined);

  // head 在但 headMessageCount 非法（字符串/NaN）同样跳过，避免 slice(0, NaN) 静默清空。
  const invalidCount = expandModelIODeltaRecords([
    {
      request: {
        messages: full.slice(80),
        messageCount: 144,
        messagesHead: full.slice(0, 12),
        headMessageCount: "12",
        messageOffset: 80,
        messagesKind: "tail",
      },
    },
  ])[0];
  assert.equal((requestOf(invalidCount).messages as unknown[]).length, 64);
  assert.equal(mapTrajectoryRecord(invalidCount).request.messages.length, 64);
});

test("T-T2 full-retention 记录（无 messageCount）：croppedCount = 0", () => {
  const full = range(0, 6);
  const mapped = mapTrajectoryRecord({
    request: {
      messages: full,
      toolNames: [],
    },
  });
  assert.equal(mapped.request.messageCount, 6);
  assert.equal(mapped.request.croppedCount, 0);
  assert.equal(mapped.request.messagesKind, undefined);

  // full kind 但带 messageCount（≤ baseline 未压缩）同样无缺口。
  const fullKind = mapTrajectoryRecord({
    request: { messages: full, messageCount: 6, messageOffset: 0, messagesKind: "full" },
  });
  assert.equal(fullKind.request.croppedCount, 0);
});

test("T-T2 head 合并以 metadataSource === target 为门：body.messages 与 sdkMessages 不拼 head", () => {
  const full = range(0, 100);
  const offset = 80;
  const head = full.slice(0, 12);
  const tail = full.slice(offset);

  // body 集合：metadataSource 是 request（≠ body），即便 request 上有 messagesHead 也不能拼。
  const bodyTarget: Record<string, unknown> = { messages: [...tail] };
  const requestMetadata: Record<string, unknown> = {
    messages: [...tail],
    messagesHead: [...head],
    headMessageCount: 12,
    messageOffset: offset,
    messagesKind: "tail",
    bodyMessagesKind: "tail",
    bodyMessageOffset: offset,
  };
  expandMessageCollection(
    bodyTarget,
    undefined,
    { collectionKey: "messages", kindKey: "bodyMessagesKind", offsetKey: "bodyMessageOffset" },
    requestMetadata,
  );
  assert.equal((bodyTarget.messages as unknown[]).length, tail.length);

  // sdkMessages：走默认 metadataSource（=== target），但集合键不同，同样不能拼 head。
  const canonical: Record<string, unknown> = {
    ...requestMetadata,
    messages: [...tail],
    sdkMessages: [...tail],
    sdkMessagesKind: "tail",
    sdkMessageOffset: offset,
  };
  expandMessageCollection(canonical, undefined, {
    collectionKey: "sdkMessages",
    kindKey: "sdkMessagesKind",
    offsetKey: "sdkMessageOffset",
  });
  assert.equal((canonical.sdkMessages as unknown[]).length, tail.length);

  // 对照：canonical messages 自身合并成功。
  expandMessageCollection(canonical, undefined, MESSAGE_KEYS);
  assert.equal((canonical.messages as unknown[]).length, 12 + tail.length);
});

test("T-T6 mapTrajectoryMessages 映射顶层 toolCalls：纯工具调用 assistant 行不再为空", () => {
  const mapped = mapTrajectoryMessages([
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "read_file", input: { path: "a.txt" } }],
    },
  ]);
  assert.equal(mapped.length, 1);
  assert.deepEqual(mapped[0].parts, [
    {
      kind: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: { path: "a.txt" },
    },
  ]);

  // content 文本与 toolCalls 并存时两类 part 都保留，顺序=content 在前、工具调用在后。
  const withText = mapTrajectoryMessages([
    {
      role: "assistant",
      content: [{ type: "text", text: "先读文件" }],
      toolCalls: [{ id: "call_2", name: "bash", input: { command: "ls" } }],
    },
  ]);
  assert.deepEqual(withText[0].parts, [
    { kind: "text", text: "先读文件" },
    { kind: "tool-call", toolCallId: "call_2", toolName: "bash", input: { command: "ls" } },
  ]);

  // tool 消息的顶层 toolCallId/toolName 语义不受影响。
  const toolMessage = mapTrajectoryMessages([
    { role: "tool", toolCallId: "call_1", toolName: "read_file", content: '{"ok":true}' },
  ]);
  assert.deepEqual(toolMessage[0].parts, [
    {
      kind: "tool-result",
      toolCallId: "call_1",
      toolName: "read_file",
      output: { ok: true },
    },
  ]);

  // 端到端：记录里纯工具调用的 assistant 行映射后有 part。
  const record = mapTrajectoryRecord({
    request: {
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "n", input: {} }] },
      ],
    },
  });
  assert.equal(record.request.messages[0].parts.length, 1);
});
