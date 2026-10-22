#!/usr/bin/env node
/**
 * phase-c2-assembly（upstream-v316-fullsync）T-AS1/T-AS2/T-AS3。
 *
 * ============================================================================
 * 这个脚本钉住什么
 * ============================================================================
 * Step 6/7 把用户消息装配收敛到 message-history 的 buildUserMessageEntries：
 *   - T-AS1 装配等价：统一函数输出与 omz 旧内联装配（conversation.ts :106-158）
 *     逐字段等价，附件四分类（粘贴图入正文/text 附件独立条目/读取失败丢弃/
 *     其余入正文）与谓词行为保持；browserAmbient 前置保留。
 *   - T-AS2 hydrator 恢复等价：real_user envelope 恢复规则前后一致；未漂移
 *     案例新旧装配逐字段相等；漂移案例（附件块位置向 live 收敛）显式登记。
 *   - T-AS3 注入时序等价：MC turn-transform 仍发生在「装配完成之后、发送
 *     之前」——transform 收到的 entries 已含全部装配字段，transform 注入结果
 *     进入发送 payload 的投影输入。
 *
 * 旧装配以「本地复刻函数」作为 oracle：oracle 与实现物理隔离，实现若漂移
 * （含未预期漂移）会在这里炸出来。
 *
 * 运行：`npx tsx --test scripts/test-session-hydrator-assembly.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const {
  buildUserMessageEntries,
  isFailedTextAttachmentPlaceholder,
  isPastedInlineImageAttachment,
  promptAttachmentInputForResolvedAttachment,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  legacySyntheticRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isKnownSystemReminderSource,
  createMessageHistory,
} = await import("../src/agent/message-history.ts");
const { hydrateMessageHistoryFromSession } =
  await import("../src/agent/session-history-hydrator.ts");
const { filePartToContentBlock } = await import("../src/agent/file-part-hydration.ts");
const { buildRuntimeUserEntriesFromTurn } = await import("../src/runtime/helpers/conversation.ts");
const { runMagicContextTurnTransform } =
  await import("../src/runtime/helpers/magic-context-turn-transform.ts");
const { buildRuntimeProviderRequestMessages } =
  await import("../src/runtime/helpers/runtime-provider-request-messages.ts");
const { buildPromptAttachmentReminderBodies } =
  await import("../src/system-reminder/prompt-attachment.ts");
const { getSystemReminderDescriptor, wrapSystemReminderForSource } =
  await import("../src/system-reminder/source.ts");
const { runtimeInputMetadata } = await import("../src/agent/runtime-input-presentation.ts");
const { modelMessageContentToText } = await import("@zcode/contracts");

// ============================================================================
// 夹具
// ============================================================================

const PNG_DATA_URL = "data:image/png;base64,AAAA";
const VIDEO_DATA_URL = "data:video/mp4;base64,BBBB";
const PDF_DATA_URL = "data:application/pdf;base64,CCCC";

let partSeq = 0;
function nextPartId() {
  partSeq += 1;
  return `part-as-${partSeq}`;
}

function textPart(text) {
  return { id: nextPartId(), type: "text", text, synthetic: false };
}

function agentPart(name) {
  return { id: nextPartId(), type: "agent", name };
}

function syntheticRewindPart(text = "Session was rewound") {
  return { id: nextPartId(), type: "text", text, synthetic: true, metadata: { source: "rewind" } };
}

// 粘贴图：无 source，恢复为 inline 块。
function pastedImagePart() {
  return { id: nextPartId(), type: "file", mime: "image/png", url: PNG_DATA_URL, metadata: {} };
}

function videoPart() {
  return { id: nextPartId(), type: "file", mime: "video/mp4", url: VIDEO_DATA_URL, metadata: {} };
}

function pdfPart(filename = "doc.pdf") {
  return {
    id: nextPartId(),
    type: "file",
    mime: "application/pdf",
    url: PDF_DATA_URL,
    filename,
    metadata: {},
  };
}

// 无 source 的 text 附件 → inline_text prompt attachment。
function inlineTextAttachmentPart(text = "FILE CONTENT", filename = "notes.txt") {
  return {
    id: nextPartId(),
    type: "file",
    mime: "text/plain",
    url: "",
    filename,
    metadata: { preview: { text } },
  };
}

// Read-like text 附件：source + inline storage + provider_ready + preview 命中。
function readLikePart(text = "READ CONTENT") {
  return {
    id: nextPartId(),
    type: "file",
    mime: "text/plain",
    url: "",
    filename: "read.txt",
    source: { type: "file", path: "C:/repo/read.txt", text: { value: "C:/repo/read.txt" } },
    metadata: { storageKind: "inline", recoverability: "provider_ready", preview: { text } },
  };
}

// 有 source 的普通 text 附件（不满足 read-like：storageKind 非 inline）。
function sourcedPlainPart(text) {
  return {
    id: nextPartId(),
    type: "file",
    mime: "text/plain",
    url: "",
    filename: "plain.txt",
    source: { type: "file", path: "C:/repo/plain.txt", text: { value: "C:/repo/plain.txt" } },
    metadata: { storageKind: "local_ref", ...(text === undefined ? {} : { preview: { text } }) },
  };
}

// 读取失败占位（有 source）→ live/统一路径丢弃。
function failedPlaceholderPart() {
  return {
    id: nextPartId(),
    type: "file",
    mime: "text/plain",
    url: "",
    filename: "gone.txt",
    source: { type: "file", path: "C:/repo/gone.txt", text: { value: "C:/repo/gone.txt" } },
    metadata: { errorCode: "attachment_read_failed" },
  };
}

// 读取失败占位（无 source）→ 两侧同样走 inline_text prompt attachment，不丢弃。
function failedPlaceholderNoSourcePart() {
  return {
    id: nextPartId(),
    type: "file",
    mime: "text/plain",
    url: "",
    filename: "gone2.txt",
    metadata: { errorCode: "attachment_read_failed", preview: { text: "STALE CONTENT" } },
  };
}

function userMessage(parts) {
  return {
    info: { id: `msg-as-${nextPartId()}`, sessionID: "ses-as", role: "user", time: { created: 0 } },
    parts,
  };
}

// ResolvedTurnAttachment 形状（live 路径入参），contentBlock 用真实恢复器算出，
// 保证 T-AS2 的 restore/live 收敛对照两侧块内容一致。
async function toResolvedAttachment(part) {
  return {
    contentBlock: await filePartToContentBlock(part, undefined),
    filename: part.filename,
    metadata: part.metadata ?? {},
    mime: part.mime,
    source: part.source,
    url: part.url,
  };
}

// ============================================================================
// oracle：omz 旧内联装配的逐行复刻（物理隔离，不 import 实现）
// ============================================================================

// —— 旧 conversation.ts（live 内联装配）——
function oldNormalizeRealUserContent(blocks) {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0].type === "text") {
    return blocks[0].text;
  }
  return blocks.map((block) => ({ ...block }));
}

function oldIsPastedInlineImageAttachment(attachment) {
  if (attachment.contentBlock.type === "image") {
    return attachment.contentBlock.source?.kind === "inline";
  }
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("image/") &&
    /^\[Attached image\/[^:]+: \[image #\d+\]\]$/u.test(attachment.contentBlock.text)
  );
}

function oldShouldAddReadLikePromptAttachmentReminder(attachment) {
  if (attachment.contentBlock.type !== "text") return false;
  if (!attachment.mime.startsWith("text/")) return false;
  if (!attachment.source) return false;
  if (attachment.metadata.storageKind !== "inline") return false;
  if (
    attachment.metadata.recoverability !== "provider_ready" &&
    attachment.metadata.recoverability !== "preview_only"
  ) {
    return false;
  }
  return attachment.metadata.preview?.text === attachment.contentBlock.text;
}

function oldPromptAttachmentInputForResolvedAttachment(attachment) {
  if (oldShouldAddReadLikePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "file",
      label: attachment.source.text.value ?? attachment.filename,
      preview: attachment.metadata.preview,
    };
  }
  if (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    !attachment.source
  ) {
    return {
      content: attachment.contentBlock.text,
      kind: "inline_text",
      label: attachment.filename,
      preview: attachment.metadata.preview,
    };
  }
  return undefined;
}

function oldIsFailedTextAttachmentPlaceholder(attachment) {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    attachment.metadata.errorCode === "attachment_read_failed"
  );
}

function oldFormatBrowserAmbientUserInput(input, context) {
  if (!context || !Number.isInteger(context.tabCount) || context.tabCount <= 0) return input;
  const tabLabel = context.tabCount === 1 ? "tab" : "tabs";
  const lines = [
    '<in-app-browser-context source="ambient-ui-state">',
    "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
    "# In app browser:",
    `- The user has the in-app browser open with ${context.tabCount} ${tabLabel}.`,
    ...(context.currentUrl ? [`- Current URL: ${context.currentUrl}`] : []),
    "</in-app-browser-context>",
    "",
    "## My request for ZCode:",
    input,
  ];
  return lines.join("\n");
}

function oldBuildRuntimeUserEntriesFromTurn(input, attachments, options = {}) {
  const realUserBlocks = [];
  const pastedImageBlocks = [];
  const promptAttachmentEntries = [];

  for (const attachment of attachments) {
    if (oldIsPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }
    const promptAttachmentInput = oldPromptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      const reminderBody = buildPromptAttachmentReminderBodies(promptAttachmentInput).join("\n");
      promptAttachmentEntries.push(
        systemReminderAttachmentEntry("prompt_attachment", reminderBody),
      );
      continue;
    }
    if (oldIsFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }
    realUserBlocks.push(attachment.contentBlock);
  }

  const blocks = [];
  if (input.length > 0) {
    blocks.push({
      type: "text",
      text: oldFormatBrowserAmbientUserInput(input, options.browserAmbientContext),
    });
  }
  blocks.push(...realUserBlocks, ...pastedImageBlocks);

  return [
    {
      message: { role: "user", content: oldNormalizeRealUserContent(blocks) },
      metadata: realUserRuntimeMetadata(),
    },
    ...promptAttachmentEntries,
  ];
}

// —— 旧 session-history-hydrator.ts（恢复侧内联装配）——
function oldContentFromUserBlocks(blocks, options = {}) {
  if (options.preserveBlocks) {
    return blocks.map((block) => ({ ...block }));
  }
  const textBlocks = blocks.filter((block) => block.type === "text");
  if (blocks.length === textBlocks.length) {
    return textBlocks
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n\n");
  }
  return blocks.map((block) => ({ ...block }));
}

function oldPromptAttachmentReminderInputForFilePart(part, block) {
  if (!part.mime.startsWith("text/")) return undefined;
  if (!part.source) {
    return {
      content: block.text,
      kind: "inline_text",
      label: part.filename,
      preview: part.metadata?.preview,
    };
  }
  if (part.metadata?.storageKind !== "inline") return undefined;
  if (
    part.metadata.recoverability !== "provider_ready" &&
    part.metadata.recoverability !== "preview_only"
  ) {
    return undefined;
  }
  if (part.metadata.preview?.text !== block.text) return undefined;
  return {
    content: block.text,
    kind: "file",
    label: part.source.text.value ?? part.filename,
    preview: part.metadata.preview,
  };
}

function oldIsProviderWrappedSystemReminderText(text) {
  return text.trimStart().startsWith("<system-reminder");
}

function oldRuntimeMessageMetadataFromPartMetadata(metadata) {
  const runtimeMessage = metadata?.runtimeMessage;
  if (!runtimeMessage || typeof runtimeMessage !== "object" || Array.isArray(runtimeMessage)) {
    return undefined;
  }
  const presentation = runtimeInputMetadata(runtimeMessage.inputPresentation);
  if (presentation) return presentation;
  const source = runtimeMessage.source;
  if (source === "real_user") return realUserRuntimeMetadata();
  if (source === "legacy_synthetic") return legacySyntheticRuntimeMetadata();
  if (source === "todo_reminder") return todoReminderRuntimeMetadata();
  if (isKnownSystemReminderSource(source)) return systemReminderRuntimeMetadata(source);
  return undefined;
}

function oldMetadataFromSyntheticTextPart(part) {
  const source = part.metadata?.source;
  if (source === "background_task" || source === "subagent_message") {
    return legacySyntheticRuntimeMetadata();
  }
  const persistedRuntimeMetadata = oldRuntimeMessageMetadataFromPartMetadata(part.metadata);
  if (persistedRuntimeMetadata) return persistedRuntimeMetadata;
  if (source === "subagent") return systemReminderRuntimeMetadata("queued_system_notification");
  if (source === "todo_reminder") return todoReminderRuntimeMetadata();
  if (source === "goal-continuation") return systemReminderRuntimeMetadata("target_continuation");
  if (source === "rewind" || source === "fork")
    return systemReminderRuntimeMetadata("rewind_notice");
  if (isKnownSystemReminderSource(source)) return systemReminderRuntimeMetadata(source);
  return legacySyntheticRuntimeMetadata();
}

function oldIsRestorableSystemReminderAttachmentSource(source) {
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "real_user" &&
    descriptor.channel !== "tool_result"
  );
}

function oldSyntheticSystemReminderAttachmentFromTextPart(part) {
  if (!part.synthetic) return undefined;
  if (part.text.trim().length === 0) return undefined;
  if (oldIsProviderWrappedSystemReminderText(part.text)) return undefined;
  const metadata = oldMetadataFromSyntheticTextPart(part);
  if (!oldIsRestorableSystemReminderAttachmentSource(metadata.source)) return undefined;
  return { source: metadata.source, content: part.text };
}

function oldTextPartToProviderText(part) {
  if (!part.synthetic) return part.text;
  if (oldIsProviderWrappedSystemReminderText(part.text)) return part.text;
  const runtimeMetadata = oldRuntimeMessageMetadataFromPartMetadata(part.metadata);
  if (runtimeMetadata?.source === "task_status" && part.metadata?.source !== "background_task") {
    return wrapSystemReminderForSource("task_status", part.text);
  }
  if (
    runtimeMetadata?.source === "queued_system_notification" ||
    part.metadata?.source === "subagent"
  ) {
    return wrapSystemReminderForSource("queued_system_notification", part.text);
  }
  return part.text;
}

function oldMetadataFromUserParts(parts) {
  const visibleTextParts = parts.filter((part) => part.type === "text" && !part.ignored);
  const hasRealUserText = visibleTextParts.some((part) => !part.synthetic);
  const hasStructuredUserPart = parts.some((part) => part.type === "file" || part.type === "agent");
  if (hasRealUserText || hasStructuredUserPart) return realUserRuntimeMetadata();
  const syntheticTextPart = visibleTextParts.find((part) => part.synthetic);
  if (!syntheticTextPart) return realUserRuntimeMetadata();
  return oldMetadataFromSyntheticTextPart(syntheticTextPart);
}

async function oldUserEntriesFromParts(parts, artifactStore) {
  const attachmentBlocks = [];
  const inlineMediaBlocks = [];
  const promptBlocks = [];
  const syntheticAttachmentEntries = [];
  const promptAttachmentEntries = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      const syntheticAttachment = oldSyntheticSystemReminderAttachmentFromTextPart(part);
      if (syntheticAttachment) {
        syntheticAttachmentEntries.push(
          systemReminderAttachmentEntry(syntheticAttachment.source, syntheticAttachment.content),
        );
        continue;
      }
      promptBlocks.push({ type: "text", text: oldTextPartToProviderText(part) });
      continue;
    }
    if (part.type === "file") {
      const block = await filePartToContentBlock(part, artifactStore);
      if (block.type === "text") {
        const promptAttachmentInput = oldPromptAttachmentReminderInputForFilePart(part, block);
        if (promptAttachmentInput) {
          const reminderBody =
            buildPromptAttachmentReminderBodies(promptAttachmentInput).join("\n");
          promptAttachmentEntries.push(
            systemReminderAttachmentEntry("prompt_attachment", reminderBody),
          );
          continue;
        }
      }
      if (block.type === "image" || block.type === "video") {
        inlineMediaBlocks.push(block);
      } else {
        attachmentBlocks.push(block);
      }
      continue;
    }
    if (part.type === "agent") {
      promptBlocks.push({ type: "text", text: `[Selected agent: ${part.name}]` });
    }
  }

  const content = oldContentFromUserBlocks(
    [...attachmentBlocks, ...promptBlocks, ...inlineMediaBlocks],
    {
      preserveBlocks: attachmentBlocks.length > 0 || inlineMediaBlocks.length > 0,
    },
  );
  const hasUserContent = modelMessageContentToText(content).trim().length > 0;
  const userMetadata = oldMetadataFromUserParts(parts);
  const shouldRestoreRealUserEnvelope =
    hasUserContent || (userMetadata.source === "real_user" && promptAttachmentEntries.length > 0);
  if (
    !shouldRestoreRealUserEnvelope &&
    syntheticAttachmentEntries.length === 0 &&
    promptAttachmentEntries.length === 0
  ) {
    return [];
  }
  return [
    ...(shouldRestoreRealUserEnvelope
      ? [{ message: { role: "user", content }, metadata: userMetadata }]
      : []),
    ...syntheticAttachmentEntries,
    ...promptAttachmentEntries,
  ];
}

// 走真实 hydrateMessageHistoryFromSession 拿新装配输出。
async function hydrateUserEntries(parts) {
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({ history, messages: [userMessage(parts)] });
  return history.toRuntimeEntries();
}

// clone 链会显式落 `cacheControl: undefined` 这类键（cloneRuntimeMessageEntry 既有行为，
// 语义上与缺键等价）；oracle 侧是纯构造没有这些键。等价断言统一按「剔除 undefined 值键」
// 归一后再比，避免把 clone 的键形态误判成装配漂移。
function dropUndefinedValues(value) {
  if (Array.isArray(value)) return value.map(dropUndefinedValues);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = dropUndefinedValues(item);
    }
    return out;
  }
  return value;
}

function assertSameAssembly(actual, expected, message) {
  assert.deepEqual(dropUndefinedValues(actual), dropUndefinedValues(expected), message);
}

// ============================================================================
// T-AS1：buildUserMessageEntries 四分类 + 与旧 live 内联装配逐字段等价
// ============================================================================

test("T-AS1: 纯文本——单 text 块折叠回字符串，metadata 为 real_user", () => {
  const entries = buildUserMessageEntries("hello", []);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries, [
    { message: { role: "user", content: "hello" }, metadata: { source: "real_user" } },
  ]);
});

test("T-AS1: 空文本无附件——空字符串 envelope", () => {
  assert.deepEqual(buildUserMessageEntries("", []), [
    { message: { role: "user", content: "" }, metadata: { source: "real_user" } },
  ]);
});

test("T-AS1: 块输入——空 text 块被过滤，多块保持块数组", async () => {
  const entries = buildUserMessageEntries(
    [
      { type: "text", text: "a" },
      { type: "text", text: "" },
      { type: "text", text: "b" },
    ],
    [],
  );
  assert.deepEqual(entries[0].message.content, [
    { type: "text", text: "a" },
    { type: "text", text: "b" },
  ]);
});

test("T-AS1: 四分类①粘贴图——inline image 入正文后置组", async () => {
  const pasted = await toResolvedAttachment(pastedImagePart());
  const entries = buildUserMessageEntries("look", [pasted]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].message.content, [
    { type: "text", text: "look" },
    pasted.contentBlock,
  ]);
});

test("T-AS1: 四分类②text 附件——独立 prompt_attachment 条目", async () => {
  const notes = await toResolvedAttachment(inlineTextAttachmentPart());
  const entries = buildUserMessageEntries("see file", [notes]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message.content, "see file");
  assert.equal(entries[1].kind, "attachment");
  assert.equal(entries[1].metadata.source, "prompt_attachment");
  assert.ok(entries[1].content.includes("FILE CONTENT"));
  assert.ok(entries[1].content.includes("Attached inline text"));
});

test("T-AS1: 四分类②read-like text 附件——kind=file，label 取 source.text.value", async () => {
  const read = await toResolvedAttachment(readLikePart());
  const entries = buildUserMessageEntries("ctx", [read]);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].metadata.source, "prompt_attachment");
  assert.ok(entries[1].content.includes("READ CONTENT"));
  const input = promptAttachmentInputForResolvedAttachment(read);
  assert.equal(input.kind, "file");
  assert.equal(input.label, "C:/repo/read.txt");
});

test("T-AS1: 四分类③读取失败占位（有 source）——丢弃", async () => {
  const failed = await toResolvedAttachment(failedPlaceholderPart());
  assert.equal(isFailedTextAttachmentPlaceholder(failed), true);
  const entries = buildUserMessageEntries("hi", [failed]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message.content, "hi");
});

test("T-AS1: 读取失败占位（无 source）——与旧两侧一致走 inline_text，不丢弃", async () => {
  const failed = await toResolvedAttachment(failedPlaceholderNoSourcePart());
  const entries = buildUserMessageEntries("hi", [failed]);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].metadata.source, "prompt_attachment");
});

test("T-AS1: 四分类④其余（PDF/file 块）入正文 realUser 中位组", async () => {
  const pdf = await toResolvedAttachment(pdfPart());
  const entries = buildUserMessageEntries("q", [pdf]);
  assert.deepEqual(entries[0].message.content, [{ type: "text", text: "q" }, pdf.contentBlock]);
});

test("T-AS1: video 附件走 realUser 中位组（live 装配本无 video 特判）", async () => {
  const video = await toResolvedAttachment(videoPart());
  const entries = buildUserMessageEntries("q", [video]);
  assert.deepEqual(entries[0].message.content, [{ type: "text", text: "q" }, video.contentBlock]);
});

test("T-AS1: 混合附件顺序 text → realUser → pasted，prompt_attachment 条目尾随", async () => {
  const pdf = await toResolvedAttachment(pdfPart());
  const pasted = await toResolvedAttachment(pastedImagePart());
  const notes = await toResolvedAttachment(inlineTextAttachmentPart());
  const entries = buildUserMessageEntries("q", [pdf, pasted, notes]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].message.content, [
    { type: "text", text: "q" },
    pdf.contentBlock,
    pasted.contentBlock,
  ]);
  assert.equal(entries[1].metadata.source, "prompt_attachment");
});

test("T-AS1: system-reminder 形态输入文本原样进 text 块（装配层不特判正文）", () => {
  const wrapped = "<system-reminder>note</system-reminder>";
  const entries = buildUserMessageEntries(wrapped, []);
  assert.equal(entries[0].message.content, wrapped);
  assert.equal(entries[0].metadata.source, "real_user");
});

test("T-AS1: 与旧 live 内联装配逐字段等价（代表性输入集 oracle 对照）", async () => {
  const sets = [
    { input: "hello", attachments: [] },
    { input: "", attachments: [] },
    { input: "look", attachments: [await toResolvedAttachment(pastedImagePart())] },
    { input: "q", attachments: [await toResolvedAttachment(pdfPart())] },
    { input: "q", attachments: [await toResolvedAttachment(videoPart())] },
    {
      input: "mix",
      attachments: [
        await toResolvedAttachment(pdfPart()),
        await toResolvedAttachment(pastedImagePart()),
        await toResolvedAttachment(inlineTextAttachmentPart()),
        await toResolvedAttachment(readLikePart()),
        await toResolvedAttachment(failedPlaceholderPart()),
      ],
    },
  ];
  for (const set of sets) {
    assert.deepEqual(
      buildUserMessageEntries(set.input, set.attachments),
      oldBuildRuntimeUserEntriesFromTurn(set.input, set.attachments),
      `oracle 漂移：input=${JSON.stringify(set.input)}`,
    );
  }
});

test("T-AS1: 薄包装保留 browserAmbient 前置与空输入直通", async () => {
  const pasted = await toResolvedAttachment(pastedImagePart());
  const context = { tabCount: 2, currentUrl: "https://example.com" };
  const actual = buildRuntimeUserEntriesFromTurn("search this", [pasted], {
    browserAmbientContext: context,
  });
  assert.deepEqual(
    actual,
    oldBuildRuntimeUserEntriesFromTurn("search this", [pasted], { browserAmbientContext: context }),
  );
  assert.ok(actual[0].message.content[0].text.includes("in-app-browser-context"));

  // 空输入：不产出 ambient 前缀（旧实现同样以 raw input.length 判空）。
  const empty = buildRuntimeUserEntriesFromTurn("", [pasted], { browserAmbientContext: context });
  assert.deepEqual(
    empty,
    oldBuildRuntimeUserEntriesFromTurn("", [pasted], { browserAmbientContext: context }),
  );
  assert.deepEqual(empty[0].message.content, [pasted.contentBlock]);
});

test("T-AS1: 谓词直测——粘贴图判定", async () => {
  const pasted = await toResolvedAttachment(pastedImagePart());
  assert.equal(isPastedInlineImageAttachment(pasted), true);

  // local_file kind 的 image 不是粘贴图（omz 保真：只看块 source.kind）。
  const localFileImage = {
    contentBlock: {
      type: "image",
      mediaType: "image/png",
      dataUrl: PNG_DATA_URL,
      source: { kind: "local_file", id: "x", uri: "file:///x.png" },
    },
    metadata: {},
    mime: "image/png",
    source: { type: "file", path: "C:/x.png", text: { value: "C:/x.png" } },
  };
  assert.equal(isPastedInlineImageAttachment(localFileImage), false);

  // image-mime 占位文本命中正则视作粘贴图。
  const placeholderImage = {
    contentBlock: { type: "text", text: "[Attached image/png: [image #1]]" },
    metadata: {},
    mime: "image/png",
  };
  assert.equal(isPastedInlineImageAttachment(placeholderImage), true);

  const plainText = {
    contentBlock: { type: "text", text: "[Attached text/plain: notes.txt]" },
    metadata: {},
    mime: "text/plain",
  };
  assert.equal(isPastedInlineImageAttachment(plainText), false);
});

test("T-AS1: 谓词直测——promptAttachmentInput 的 file/inline_text/undefined 三态", async () => {
  const read = await toResolvedAttachment(readLikePart());
  assert.deepEqual(promptAttachmentInputForResolvedAttachment(read), {
    content: "READ CONTENT",
    kind: "file",
    label: "C:/repo/read.txt",
    preview: { text: "READ CONTENT" },
  });

  const notes = await toResolvedAttachment(inlineTextAttachmentPart());
  assert.equal(promptAttachmentInputForResolvedAttachment(notes).kind, "inline_text");
  assert.equal(promptAttachmentInputForResolvedAttachment(notes).label, "notes.txt");

  const pdf = await toResolvedAttachment(pdfPart());
  assert.equal(promptAttachmentInputForResolvedAttachment(pdf), undefined);
});

// ============================================================================
// T-AS2：hydrator 恢复等价（real_user envelope 规则不变 + 漂移显式登记）
// ============================================================================

test("T-AS2: 纯文本与多段文本——恢复输出与旧装配逐字段相等", async () => {
  const single = [textPart("hello")];
  assertSameAssembly(
    await hydrateUserEntries(single),
    await oldUserEntriesFromParts(single, undefined),
  );

  const multi = [textPart("a"), textPart("b")];
  const entries = await hydrateUserEntries(multi);
  assert.deepEqual(entries, await oldUserEntriesFromParts(multi, undefined));
  assert.equal(entries[0].message.content, "a\n\nb");
  assert.equal(entries[0].metadata.source, "real_user");
});

test("T-AS2: 文本+粘贴图——media 后置组与旧装配一致", async () => {
  const parts = [textPart("look"), pastedImagePart()];
  const entries = await hydrateUserEntries(parts);
  assertSameAssembly(entries, await oldUserEntriesFromParts(parts, undefined));
  assert.equal(entries[0].message.content.length, 2);
  assert.equal(entries[0].message.content[1].type, "image");
});

test("T-AS2: text 附件（inline_text/read-like）——prompt_attachment 条目与旧装配一致", async () => {
  const inline = [textPart("see file"), inlineTextAttachmentPart()];
  assertSameAssembly(
    await hydrateUserEntries(inline),
    await oldUserEntriesFromParts(inline, undefined),
  );

  const read = [textPart("ctx"), readLikePart()];
  assertSameAssembly(
    await hydrateUserEntries(read),
    await oldUserEntriesFromParts(read, undefined),
  );
});

test("T-AS2: 读取失败占位（无 source）——两侧同为 prompt_attachment，不丢弃", async () => {
  const parts = [textPart("hi"), failedPlaceholderNoSourcePart()];
  assertSameAssembly(
    await hydrateUserEntries(parts),
    await oldUserEntriesFromParts(parts, undefined),
  );
});

test("T-AS2: agent part 拼进正文", async () => {
  const parts = [textPart("q"), agentPart("worker")];
  const entries = await hydrateUserEntries(parts);
  assertSameAssembly(entries, await oldUserEntriesFromParts(parts, undefined));
  assert.equal(entries[0].message.content, "q\n\n[Selected agent: worker]");
});

test("T-AS2: real_user envelope 恢复——空正文+text 附件仍产出 user envelope", async () => {
  const parts = [inlineTextAttachmentPart()];
  const entries = await hydrateUserEntries(parts);
  assertSameAssembly(entries, await oldUserEntriesFromParts(parts, undefined));
  // 收敛前修复的关键行为：envelope 不被 trim 判空丢弃。
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message.role, "user");
  assert.equal(entries[0].message.content, "");
  assert.equal(entries[0].metadata.source, "real_user");
  assert.equal(entries[1].metadata.source, "prompt_attachment");
});

test("T-AS2: real_user envelope 规则——bare-empty 与纯 synthetic 不产出空消息", async () => {
  // bare-empty：无任何附件、无正文。
  assert.deepEqual(await hydrateUserEntries([]), []);

  // 单一 synthetic rewind part 走消息级 synthetic attachment 拦截，不产生 envelope。
  const syntheticOnly = [syntheticRewindPart()];
  const entries = await hydrateUserEntries(syntheticOnly);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "attachment");
  assert.equal(entries[0].metadata.source, "rewind_notice");
});

test("T-AS2: synthetic 与正文混合——attachment 条目+envelope 顺序与旧装配一致", async () => {
  const parts = [textPart("real q"), syntheticRewindPart()];
  const entries = await hydrateUserEntries(parts);
  assertSameAssembly(entries, await oldUserEntriesFromParts(parts, undefined));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].metadata.source, "real_user");
  assert.equal(entries[1].metadata.source, "rewind_notice");
});

test("T-AS2: 漂移登记①非媒体附件块位置向 live 收敛（正文先行）", async () => {
  const parts = [textPart("q"), pdfPart(), pastedImagePart()];
  const entries = await hydrateUserEntries(parts);
  const newOrder = entries[0].message.content.map((block) => block.type);

  // 新装配收敛到 live 顺序：text → file → image。
  // live 对照复用同一批 part 实例（块 source.id 携带 part id，各自 new 会对不上）。
  const pdfAtt = await toResolvedAttachment(parts[1]);
  const pastedAtt = await toResolvedAttachment(parts[2]);
  const live = buildRuntimeUserEntriesFromTurn("q", [pdfAtt, pastedAtt]);
  assertSameAssembly(entries, live);

  // 显式登记与旧装配的差异（旧：附件块在正文之前）。
  const old = await oldUserEntriesFromParts(parts, undefined);
  assert.deepEqual(
    old[0].message.content.map((block) => block.type),
    ["file", "text", "image"],
  );
  assert.deepEqual(newOrder, ["text", "file", "image"]);
});

test("T-AS2: 漂移登记②有 source 的普通 text 附件位置向 live 收敛（正文先行）", async () => {
  const parts = [textPart("q"), sourcedPlainPart()];
  const entries = await hydrateUserEntries(parts);
  const sourced = await toResolvedAttachment(parts[1]);
  assertSameAssembly(entries, buildRuntimeUserEntriesFromTurn("q", [sourced]));
  assert.equal(entries[0].message.content[0].text, "q");

  const old = await oldUserEntriesFromParts(parts, undefined);
  assert.notDeepEqual(
    old[0].message.content.map((block) => block.text ?? block.type),
    entries[0].message.content.map((block) => block.text ?? block.type),
  );
});

test("T-AS2: 漂移登记③有 source 的读取失败占位按 live 语义丢弃", async () => {
  const parts = [textPart("q"), failedPlaceholderPart()];
  const entries = await hydrateUserEntries(parts);
  const failed = await toResolvedAttachment(parts[1]);
  assertSameAssembly(entries, buildRuntimeUserEntriesFromTurn("q", [failed]));
  assert.equal(entries.length, 1);
  assert.equal(JSON.stringify(entries).includes("gone.txt"), false);

  // 旧装配保留该占位块（漂移即修复点本身）。
  const old = await oldUserEntriesFromParts(parts, undefined);
  assert.equal(old.length, 1);
  assert.equal(old[0].message.content.length, 2);
});

// ============================================================================
// T-AS3：MC turn-transform 注入时序等价（装配之后、发送之前）
// ============================================================================

const MC_MARKER = "MC_MARKER_T_AS3";

async function assembledTurnEntries() {
  const pasted = await toResolvedAttachment(pastedImagePart());
  const notes = await toResolvedAttachment(inlineTextAttachmentPart());
  return buildRuntimeUserEntriesFromTurn("hi", [pasted, notes]);
}

function stubTransformRuntime() {
  const recorded = [];
  return {
    recorded,
    runtime: {
      config: {},
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      magicContextTurnTransform: async (input) => {
        recorded.push(input);
        return {
          entries: [
            systemReminderAttachmentEntry("prompt_attachment", MC_MARKER),
            ...input.entries,
          ],
        };
      },
    },
  };
}

test("T-AS3: transform 收到的 entries 已含全部装配字段", async () => {
  const { runtime, recorded } = stubTransformRuntime();
  const assembled = await assembledTurnEntries();
  const result = await runMagicContextTurnTransform(
    runtime,
    { entries: assembled, model: stubModel(), sessionId: "ses-as", workingDirectory: "C:/repo" },
    { traceId: "trace-as3" },
  );

  assert.equal(recorded.length, 1);
  // 装配面完整透传：real_user envelope + prompt_attachment 条目都在。
  assert.deepEqual(recorded[0].entries, assembled);
  assert.equal(recorded[0].entries[0].metadata.source, "real_user");
  assert.equal(recorded[0].entries[1].kind, "attachment");
  assert.equal(recorded[0].entries[1].metadata.source, "prompt_attachment");
  // 注入结果在队首，装配条目原序尾随。
  assert.equal(result[0].metadata.source, "prompt_attachment");
  assert.equal(result[0].content, MC_MARKER);
  assert.deepEqual(result.slice(1), assembled);
});

test("T-AS3: transform 输出即投影输入——注入结果进入发送 payload 面", async () => {
  const { runtime } = stubTransformRuntime();
  const assembled = await assembledTurnEntries();
  const transformed = await runMagicContextTurnTransform(runtime, {
    entries: assembled,
    model: stubModel(),
    sessionId: "ses-as",
    workingDirectory: "C:/repo",
  });
  const projection = buildRuntimeProviderRequestMessages(
    { config: {} },
    { entries: transformed, applyCacheControl: false, model: stubModel() },
  );
  assert.ok(
    JSON.stringify(projection.messages).includes(MC_MARKER),
    "发送 payload 的投影输入必须包含 transform 注入结果",
  );
});

test("T-AS3: 端口缺席/禁用时 transform 判空直通（同引用）", async () => {
  const assembled = await assembledTurnEntries();
  const absent = await runMagicContextTurnTransform(
    { config: {} },
    { entries: assembled, model: stubModel(), sessionId: "ses-as", workingDirectory: "C:/repo" },
  );
  assert.equal(absent, assembled);

  const disabledRuntime = {
    config: {},
    magicContextTurnTransform: async (input) => ({ entries: input.entries }),
  };
  disabledRuntime.magicContextTurnTransform.isEnabled = () => false;
  const disabled = await runMagicContextTurnTransform(disabledRuntime, {
    entries: assembled,
    model: stubModel(),
    sessionId: "ses-as",
    workingDirectory: "C:/repo",
  });
  assert.equal(disabled, assembled);
});

function stubModel() {
  return {
    providerId: "stub-provider",
    modelId: "stub-model",
    properties: { supportsMidConversationSystem: false },
  };
}
