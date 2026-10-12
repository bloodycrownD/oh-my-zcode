#!/usr/bin/env node
/**
 * 附件 text/plain 预览链（upstream-v3.15.1-backport / issue #25 前半）。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * 长粘贴落盘的文本附件（mime=text/plain，UI 侧 sourceKind="clipboard-text"）在 fork 里
 * 完全不可预览，根因有三段，缺任何一段都断链：
 *   1. UI 生产端（attachmentUpload / useComposerAttachments）不把 sourceKind 写进 AttachmentRef；
 *   2. 协议字段链（shared attachmentRefSchema / rows / CLI 归一化与再 admission）逐字段枚举时丢字段；
 *   3. CLI v4-gateway 两道闸（授权闸 isReadablePreviewAttachment、结果闸
 *      isReadablePreviewResultMediaType）只认媒体类型，text/plain 被 previewNotMedia 拒。
 *
 * 断言口径（fix-spec「UI 生产端+字段链+两闸」七步的验收）：
 *   ① 真实链路：UI 序列化 → 命令 payload（真实信封/协议校验）→ 投影行（真实 buildUserInputRow
 *      + conversationRowSchema）仍带 sourceKind；覆盖 serialize+upload 两分支与
 *      hook 的零拷贝预置 / 远端 staged 两路径；判定矩阵（clipboard-text+text/plain 命中、
 *      无标记 text/plain=false、image/png=true）
 *   ② 结果闸对等豁免两态（都是 text/plain 放行；请求 image/* 拿到文本仍拒）
 *   ③ transport 负例（attachmentRead 响应 schema 非 text/plain 仍拒）+ 零拷贝预置 ref 传播
 *   ⑤ transcript 冷路径（persisted conversationInputIntent → attachmentRefs）投影行带 sourceKind
 *
 * 运行（从 apps/zcode-cli/packages/bootstrap 执行；UI 序列化模块的 `@/lib/*` 别名只在
 * packages/ui/tsconfig.json 声明，裸 node/tsx 会 ERR_MODULE_NOT_FOUND，必须显式带该 tsconfig）：
 *   npx tsx --tsconfig ../../../../packages/ui/tsconfig.json --test scripts/test-attachment-preview-text-plain.mjs
 * 等价的 judge 口径（cwd=packages/ui）：
 *   npx tsx --tsconfig ../ui/tsconfig.json --test ../../apps/zcode-cli/packages/bootstrap/scripts/test-attachment-preview-text-plain.mjs
 *
 * 待 wave-4 登记（本节点不接 package.json / knip）：本脚本 import react / react-dom，而
 * @zcode/bootstrap 未声明这两个依赖，knip 会报 unlisted（react, react-dom）；与既有
 * packages/desktop/scripts/test-*.mjs 同法在 knip.json 的 ignore 清单登记，或加
 * package.json test 脚本使其成为入口。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// useComposerAttachments 渲染期写 E2E scope key 会直接访问 window（无 typeof 守卫）；
// node 侧给一个最小 shim，只提供 setTimeout/clearTimeout，不模拟任何 DOM 行为。
globalThis.window = globalThis;

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const uiSrc = (rel) => pathToFileURL(join(REPO_ROOT, "packages", "ui", "src", rel)).href;

const React = await import("react");
const { renderToString } = await import("react-dom/server");

// ── UI 生产端（真实模块） ──
const { createCommandEnvelope } = await import(uiSrc("v4/commandFactory.ts"));
const { createClipboardTextPathComposerAttachment, serializeChatComposerAttachment } = await import(
  uiSrc("lib/chatAttachments.ts")
);
const { uploadComposerAttachment } = await import(uiSrc("v4/composer/attachmentUpload.ts"));
const { useComposerAttachments } = await import(uiSrc("v4/composer/useComposerAttachments.ts"));
const { readComposerAttachmentScope } = await import(
  uiSrc("store/composerAttachmentUploadStore.ts")
);
const { ZCodeIntlProvider } = await import(uiSrc("i18n/IntlProvider.tsx"));
const { PlatformProvider } = await import(uiSrc("hooks/usePlatform.tsx"));
const { ServiceProvider } = await import(uiSrc("hooks/useServices.tsx"));

// ── CLI 投影 + 两闸（真实模块） ──
const { isReadablePreviewAttachment, isReadablePreviewResultMediaType } =
  await import("../src/zcode-protocol-v4/v4-gateway.ts");
const { buildUserInputRow } = await import("../src/zcode-protocol-v4/projection-rows.ts");

// ── 协议（真实 schema） ──
const {
  PROTOCOL_V4_LIMITS,
  conversationInputIntentSchema,
  conversationRowSchema,
  parseCommandEnvelope,
  v4AttachmentReadResultSchema,
} = await import("@zcode/shared/zcode-protocol-v4");

const PASTE_TEXT = "x".repeat(16_000); // 超过 15KiB 长粘贴阈值
/** 手工构造 fixture 用的文件名（hook 路径的真实文件名由平台 mock 捕获，见 lastTempTextAttachment）。 */
const PASTE_FILENAME = "pasted-text-20261012-101010.txt";
const WORKSPACE_PATH = "/tmp/zcode-attachment-chain";
const REMOTE_IDENTITY = "remote:ssh://devbox/ws";
/** 平台落盘时给出的真实文件名（hook 用它做 ref，测试不能自己猜时间戳）。 */
let lastTempTextAttachment = null;

/** 本地 target：零拷贝预置（不走上传/暂存）。 */
function localHookOptions(scopeId) {
  return {
    workspacePath: WORKSPACE_PATH,
    scopeId,
    attachmentSessionId: "ses_local_chain",
    attachmentPut: async () => {
      throw new Error("本地零拷贝路径不应触发 put 上传");
    },
  };
}

/** 远端 target：localPath 附件必须经 transferService.stage 物化。 */
function remoteHookOptions(scopeId) {
  return {
    workspacePath: WORKSPACE_PATH,
    workspaceIdentity: REMOTE_IDENTITY,
    remoteSessionId: "rses_chain",
    scopeId,
    attachmentSessionId: "ses_remote_chain",
    attachmentPut: async () => {
      throw new Error("远端 staged 路径不应触发 put 上传");
    },
  };
}

function makePlatform() {
  return {
    getPathForFile: () => undefined,
    canSelectFilePath: false,
    selectFile: async () => null,
    selectFiles: async () => [],
    // 长粘贴 → UI 落盘临时文本文件（真实桌面平台的等价物）。
    createTempTextAttachment: async ({ text, filename }) => {
      const result = {
        filename,
        localPath: `${WORKSPACE_PATH}/${filename}`,
        mimeType: "text/plain",
        sizeBytes: text.length,
      };
      lastTempTextAttachment = result;
      return result;
    },
  };
}

/**
 * 无 DOM 渲染 hook 并取回 API：hook 的关键状态（targetsRef / pumpQueueRef）在渲染期写入，
 * 因此 renderToString 一次即可拿到可驱动的 API，无需 jsdom。
 */
function renderComposerHook(hookOptions, transferService) {
  let api = null;
  function Probe() {
    api = useComposerAttachments(hookOptions);
    return React.createElement("div", null, "probe");
  }
  renderToString(
    React.createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      React.createElement(
        PlatformProvider,
        { platform: makePlatform() },
        React.createElement(
          ServiceProvider,
          { services: { promptAttachmentTransferService: transferService } },
          React.createElement(Probe, null),
        ),
      ),
    ),
  );
  assert.ok(api, "hook 渲染后应返回 API");
  return api;
}

function pasteLongText(api) {
  api.handlePaste({
    clipboardData: {
      files: [],
      types: [],
      getData: (type) => (type === "text/plain" ? PASTE_TEXT : ""),
    },
    preventDefault() {},
    stopPropagation() {},
  });
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  throw new Error(`等待超时：${label}`);
}

function scopeKeyOf(scopeId, identity) {
  // 与 useComposerAttachments.buildScopeKey 同口径：identity 优先于 path。
  return `${identity?.trim() || WORKSPACE_PATH}\u0000${scopeId}`;
}

function stagedTransferService(onStage) {
  return {
    onDynamicProgress: () => () => ({ dispose() {} }),
    stage: async (params) => {
      onStage?.(params);
      return {
        staged: true,
        ref: `zcode-artifact://${encodeURIComponent(params.sessionId)}/${params.fileName}`,
        bytes: params.sizeBytes,
      };
    },
    adopt: async () => {},
    cleanup: async () => {},
  };
}

test("① UI 生产端：serialize+upload 两个 return 分支都带 sourceKind", async () => {
  const composerItem = createClipboardTextPathComposerAttachment(PASTE_TEXT, {
    filename: PASTE_FILENAME,
    localPath: `${WORKSPACE_PATH}/${PASTE_FILENAME}`,
    mimeType: "text/plain",
    sizeBytes: PASTE_TEXT.length,
  });
  const serialized = await serializeChatComposerAttachment(composerItem);
  assert.equal(serialized.kind, "file");
  assert.equal(serialized.mimeType, "text/plain");
  assert.equal(serialized.sourceKind, "clipboard-text", "序列化必须保留剪贴板文本标记");

  // localPath 分支：零上传，直接带路径引用。
  let putCalls = 0;
  const localRef = await uploadComposerAttachment(
    async () => {
      putCalls += 1;
      return { ref: "unused", bytes: 0 };
    },
    "ses_local_chain",
    serialized,
  );
  assert.equal(putCalls, 0, "localPath 分支不应触发 put");
  assert.equal(localRef.sourceKind, "clipboard-text");
  assert.equal(localRef.mime, "text/plain");
  assert.equal(localRef.ref, `${WORKSPACE_PATH}/${PASTE_FILENAME}`);

  // put 分支：无 localPath 的文本回退（web / 无路径环境）同样要带标记。
  const putRef = await uploadComposerAttachment(
    async (params) => {
      assert.equal(params.mime, "text/plain");
      assert.equal(params.fileName, "note.txt");
      return {
        ref: `zcode-artifact://${encodeURIComponent(params.sessionId)}/${params.fileName}`,
        bytes: 8,
      };
    },
    "ses_local_chain",
    {
      kind: "file",
      filename: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
      sourceKind: "clipboard-text",
      textContent: "material",
    },
  );
  assert.equal(putRef.sourceKind, "clipboard-text");
  assert.equal(putRef.bytes, 8);
});

test("①③ UI 生产端：零拷贝预置 ref 传播 sourceKind（本地 target 长粘贴）", async () => {
  const api = renderComposerHook(localHookOptions("local-scope"), stagedTransferService());
  pasteLongText(api);

  const items = await waitFor(
    () => readComposerAttachmentScope(scopeKeyOf("local-scope"))[0],
    "本地长粘贴附件入 store",
  );
  assert.ok(lastTempTextAttachment, "平台应已落盘临时文本附件");
  assert.equal(items.localZeroCopy, true);
  assert.equal(items.uploadStatus, "ready");
  assert.equal(items.staged, false);
  assert.equal(items.sourceKind, "clipboard-text");
  assert.equal(items.attachmentRef.sourceKind, "clipboard-text", "零拷贝预置 ref 必须带标记");
  assert.equal(items.attachmentRef.mime, "text/plain");
  assert.equal(items.attachmentRef.ref, lastTempTextAttachment.localPath);

  // 发送边界：prepareForSend 只搬运 ref，不能再丢字段。
  const readyRefs = await api.prepareForSend();
  assert.equal(readyRefs.length, 1);
  assert.equal(readyRefs[0].sourceKind, "clipboard-text");
});

test("① UI 生产端：远端 staged 分支回写 sourceKind", async () => {
  let stageParams = null;
  const api = renderComposerHook(
    remoteHookOptions("remote-scope"),
    stagedTransferService((params) => {
      stageParams = params;
    }),
  );
  pasteLongText(api);

  const items = await waitFor(() => {
    const item = readComposerAttachmentScope(scopeKeyOf("remote-scope", REMOTE_IDENTITY))[0];
    return item?.uploadStatus === "ready" ? item : null;
  }, "远端附件 staged 完成");
  assert.ok(stageParams, "远端 localPath 附件必须经 stage 物化");
  assert.ok(lastTempTextAttachment, "平台应已落盘临时文本附件");
  assert.equal(stageParams.mime, "text/plain");
  assert.equal(stageParams.localPath, lastTempTextAttachment.localPath);
  assert.equal(items.staged, true, "远端路径必须标记 staged");
  assert.equal(items.attachmentRef.sourceKind, "clipboard-text", "staged ref 必须带标记");
  assert.match(items.attachmentRef.ref, /^zcode-artifact:\/\//);

  const readyRefs = await api.prepareForSend();
  assert.equal(readyRefs[0].sourceKind, "clipboard-text");
});

test("① 命令 payload → 投影：sendText 校验后仍带 sourceKind，投影行可预览", async () => {
  const api = renderComposerHook(localHookOptions("chain-scope"), stagedTransferService());
  pasteLongText(api);
  const item = await waitFor(
    () => readComposerAttachmentScope(scopeKeyOf("chain-scope"))[0],
    "链路附件入 store",
  );
  const readyRefs = await api.prepareForSend();

  // UI 侧真实信封工厂 + 协议侧真实校验（attachmentRefSchema 是 .strict()，
  // 若协议不登记 sourceKind，这里会直接判 payload 非法）。
  const envelope = createCommandEnvelope({
    type: "sendText",
    payload: { text: "看下这段材料", attachments: readyRefs },
    sessionId: "ses_chain",
  });
  const parsed = parseCommandEnvelope(envelope);
  assert.equal(parsed.ok, true, "sendText 信封必须通过协议校验");
  const wireRefs = parsed.envelope.payload.attachments;
  assert.equal(wireRefs[0].sourceKind, "clipboard-text");
  assert.equal(wireRefs[0].ref, item.attachmentRef.ref);

  // 投影：CLI 用 TurnStarted.intent.attachmentRefs 填 userInput row.attachments。
  const payload = {
    executionStartedAt: Date.now(),
    turnNumber: 1,
    input: "看下这段材料",
    messageId: "msg_chain",
    inputId: "input_chain",
    inputSource: "user",
    intent: {
      sourceCommandId: "cmd_chain",
      queueItemId: "q_chain",
      clientId: "client_chain",
      kind: "sendText",
      text: "看下这段材料",
      admissionSeq: 1,
      admittedAt: Date.now(),
      requestedDelivery: "startNow",
      admittedDelivery: "startNow",
      attachmentRefs: wireRefs,
    },
  };
  const row = buildUserInputRow(
    { rowId: 7, turnId: "turn-chain", createdAt: Date.now(), createdAtSeq: 7 },
    payload,
  );
  assert.equal(row.attachments[0].sourceKind, "clipboard-text", "投影行必须保留来源标记");

  // 行经协议 schema（transport 下发前的行校验）后仍保留，UI 才拿得到授权依据。
  const parsedRow = conversationRowSchema.parse(row);
  assert.equal(parsedRow.attachments[0].sourceKind, "clipboard-text");

  // 两闸对这条真实投影行都放行。
  assert.equal(isReadablePreviewAttachment(parsedRow.attachments[0]), true);
  assert.equal(
    isReadablePreviewResultMediaType(parsedRow.attachments[0].mime, "text/plain; charset=utf-8"),
    true,
  );
});

test("⑤ 冷路径：persisted conversationInputIntent → 投影行带 sourceKind", async () => {
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: "cmd_cold",
    queueItemId: "q_cold",
    clientId: "client_cold",
    kind: "sendText",
    text: "冷恢复材料",
    attachments: [
      {
        ref: `${WORKSPACE_PATH}/${PASTE_FILENAME}`,
        fileName: PASTE_FILENAME,
        mime: "text/plain",
        bytes: PASTE_TEXT.length,
        sourceKind: "clipboard-text",
      },
    ],
    delivery: { requested: "startNow", admitted: "startNow" },
    order: { admissionSeq: 2 },
    steer: { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: Date.now(),
  });
  // transcript hydration 走 conversationInputIntentSchema → attachmentRefs（:273-302 形态）。
  const row = buildUserInputRow(
    { rowId: 8, turnId: "turn-cold", createdAt: Date.now(), createdAtSeq: 8 },
    {
      executionStartedAt: Date.now(),
      turnNumber: 2,
      input: "冷恢复材料",
      messageId: "msg_cold",
      inputId: "input_cold",
      intent: { ...intent, attachmentRefs: intent.attachments },
    },
  );
  const parsedRow = conversationRowSchema.parse(row);
  assert.equal(parsedRow.attachments[0].sourceKind, "clipboard-text");
  assert.equal(isReadablePreviewAttachment(parsedRow.attachments[0]), true);
});

test("① 授权闸判定矩阵：clipboard-text+text/plain 命中，无标记 text/plain 拒绝", () => {
  assert.equal(
    isReadablePreviewAttachment({ mime: "text/plain", sourceKind: "clipboard-text" }),
    true,
  );
  assert.equal(
    isReadablePreviewAttachment({
      mime: "text/plain; charset=utf-8",
      sourceKind: "clipboard-text",
    }),
    true,
  );
  assert.equal(isReadablePreviewAttachment({ mime: "text/plain" }), false);
  // FORK：本仓没有 topic-history 生产端，上游专属取值不授权。
  assert.equal(
    isReadablePreviewAttachment({ mime: "text/plain", sourceKind: "topic-history" }),
    false,
  );
  assert.equal(
    isReadablePreviewAttachment({ mime: "text/csv", sourceKind: "clipboard-text" }),
    false,
  );
  assert.equal(isReadablePreviewAttachment({ mime: "image/png" }), true);
  assert.equal(isReadablePreviewAttachment({ mime: "video/mp4" }), true);
  assert.equal(isReadablePreviewAttachment({ mime: "application/pdf" }), true);
});

test("② 结果闸：text/plain 对等豁免两态", () => {
  // 请求与结果都是 text/plain → 放行（旧实现只认媒体类型，这里被 previewNotMedia 拒）。
  assert.equal(isReadablePreviewResultMediaType("text/plain", "text/plain; charset=utf-8"), true);
  // 请求不是 text/plain（如 image/*）→ 结果即使是文本也拒，不允许靠结果类型升级授权。
  assert.equal(isReadablePreviewResultMediaType("image/png", "text/plain"), false);
  assert.equal(isReadablePreviewResultMediaType("application/octet-stream", "text/plain"), false);
  // 媒体类型保持原语义。
  assert.equal(isReadablePreviewResultMediaType("image/png", "image/png"), true);
  assert.equal(isReadablePreviewResultMediaType("application/pdf", "application/pdf"), true);
  assert.equal(isReadablePreviewResultMediaType("video/mp4", "video/mp4"), true);
  assert.equal(isReadablePreviewResultMediaType("text/plain", "image/png"), true);
});

test("③ transport：attachmentRead 响应 schema 放行 text/plain、仍拒非文本", () => {
  const base = {
    dataBase64: Buffer.from("材料文本").toString("base64"),
    totalBytes: 12,
    nextOffset: null,
  };
  assert.equal(
    v4AttachmentReadResultSchema.safeParse({ ...base, mediaType: "text/plain; charset=utf-8" })
      .success,
    true,
  );
  assert.equal(
    v4AttachmentReadResultSchema.safeParse({ ...base, mediaType: "image/png" }).success,
    true,
  );
  const rejected = v4AttachmentReadResultSchema.safeParse({
    ...base,
    mediaType: "application/octet-stream",
  });
  assert.equal(rejected.success, false, "非文本/媒体类型仍必须被拒");
  const oversized = v4AttachmentReadResultSchema.safeParse({
    dataBase64: base.dataBase64,
    mediaType: "text/plain",
    totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
    nextOffset: null,
  });
  assert.equal(oversized.success, false, "text/plain 仍受 attachmentMaxBytes 上限约束");
});
