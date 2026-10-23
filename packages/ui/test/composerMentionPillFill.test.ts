/**
 * T-PR2（Step 21 / phase-pill-restore，blocking）：装填路径形状守卫。
 *
 * 本仓 UI 测试基建是纯逻辑/源码形状测试（无 jsdom），因此这里钉源码形状：
 * 1) LexicalChatInput 暴露富装填 API，且 setTextWithPluginMentions 只是它的薄包装；
 * 2) spec 点名的 5 个 setText 点全部换成富 API，装填路径不再出现纯文本 setText；
 * 3) 队列行预览复用消息气泡渲染器（胶囊预览），预览容器带 data-v4-queue-item-preview；
 * 4) 队列撤回把 item.text 拆成「正文 + 上下文尾块」，尾块以草稿载体 promptContexts
 *    持久化并参与重发序列化（切 scope/刷新回来由草稿重建 chip）；
 * 5) 用真实 serializer/parser + 真实草稿 store 验证「撤回 → 切 scope → 切回 → 重发」
 *    四类上下文仍齐全且字节不变（T-PR2-5 / T-PR2-6 的自动面）。
 *
 * 运行形态：node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/composerMentionPillFill.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  mergeContextList,
  parseComposerPromptContexts,
  resolveQueuePreview,
  serializeComposerPromptContexts,
} from "../src/v4/composer/composerPromptContexts.js";
import {
  composerSubmitMachine,
  resolveComposerSubmitAvailability,
  resolveComposerSubmitContextKey,
  type ComposerSubmitContexts,
} from "../src/v4/composer/composerSubmitMachine.js";
import { applyScopedDraftContentUpdate } from "../src/v4/composer/scopedDraftContentUpdate.js";
import {
  conversationSelectionContextKey,
  parsePromptConversationSelections,
} from "../src/lib/conversationSelectionReference.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const LEXICAL_INPUT_SOURCE = readSource("../src/LexicalChatInput.tsx");
const CHAT_PROMPT_EDITOR_SOURCE = readSource("../src/prompt-editor/ChatPromptEditor.tsx");
const COMPOSER_SOURCE = readSource("../src/v4/ConversationComposer.tsx");
const ROW_VIEW_SOURCE = readSource("../src/v4/ConversationRowView.tsx");
const QUEUE_ROW_SOURCE = readSource("../src/v4/ConversationQueueRow.tsx");
const QUEUE_PANEL_SOURCE = readSource("../src/v4/ConversationQueuePanel.tsx");
const SESSION_PANE_SOURCE = readSource("../src/v4/SessionPane.tsx");
const SELECTION_CHIP_SOURCE = readSource(
  "../src/v4/composer/ConversationSelectionReferenceChip.tsx",
);
const DRAFT_CONTROL_SOURCE = readSource("../src/v4/composer/useDraftConfigControl.ts");
const MENTION_MARKDOWN_SOURCE = readSource("../src/mentions/mentionMarkdown.ts");

/** 四类上下文都为空的最小载体。 */
function emptyContexts(): ComposerSubmitContexts {
  return { codeComments: [], conversationSelections: [], webElements: [], pptxElements: [] };
}

// composerDraftStore 只用 window.localStorage 的读/写/删，测试侧给最小 stub。
function installStorageStub() {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => (backing.has(key) ? (backing.get(key) as string) : null),
    key: () => null,
    removeItem: (key) => void backing.delete(key),
    setItem: (key, value) => void backing.set(key, String(value)),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return backing;
}

const storageBacking = installStorageStub();

function countOccurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))]
    .length;
}

test("T-PR2-1: LexicalChatInput 富装填 API 在位，setTextWithPluginMentions 是薄包装", () => {
  // handle 声明面
  assert.match(
    LEXICAL_INPUT_SOURCE,
    /setTextWithMentions: \(text: string\) => void;/,
    "LexicalChatInputHandle 必须暴露 setTextWithMentions",
  );
  // 两个 handle 构造点（E2E bridge + EditorApiPlugin）都要接线。
  // S4：不再锁字面量次数（纯格式化即红），只保证至少一处真实接线 + 旧的插件专用实现已消失。
  assert.ok(
    countOccurrences(
      LEXICAL_INPUT_SOURCE,
      /setTextWithMentions: \(text: string\) => replaceEditorTextWithMentions\(editor, text\)/,
    ) >= 1,
    "E2E bridge / EditorApiPlugin 必须复用同一条富装填实现",
  );
  assert.match(
    LEXICAL_INPUT_SOURCE,
    /setTextWithPluginMentions: \(text: string\) => replaceEditorTextWithMentions\(editor, text\)/,
    "setTextWithPluginMentions 必须是富装填的薄包装",
  );
  assert.doesNotMatch(
    LEXICAL_INPUT_SOURCE,
    /replaceEditorTextWithPluginMentions/,
    "旧插件专用装填实现必须已被富装填吸收",
  );

  // 富装填实现：整篇解析 + 段落装配 + selectEnd 与 replaceEditorText 对齐
  const start = LEXICAL_INPUT_SOURCE.indexOf("function replaceEditorTextWithMentions");
  assert.ok(start > 0, "replaceEditorTextWithMentions 存在");
  const body = LEXICAL_INPUT_SOURCE.slice(
    start,
    LEXICAL_INPUT_SOURCE.indexOf("\nfunction ", start),
  );
  assert.match(
    body,
    /splitRichMentionParagraphs\(parseMentionMarkdownRich\(text\)\)/,
    "必须整篇先解析再按段装配（fence 状态跨段落保留，P2-1）",
  );
  assert.doesNotMatch(
    body,
    /parseMentionMarkdownRich\(line\)/,
    "不得先按 \\n\\n 切段再逐段解析：fence 状态会在段间丢失",
  );
  assert.match(
    MENTION_MARKDOWN_SOURCE,
    /export function splitRichMentionParagraphs\(/,
    "段落装配必须是可测的纯函数",
  );
  assert.match(body, /root\.getLastChild\(\)\?\.selectEnd\(\)/, "装填后光标必须落尾");
  assert.match(body, /markdown: segment\.markdown/, "chip 的 markdown 必须取原文 fullMatch");
});

test("T-PR2-2: 5 个装填点全部走富 API，装填路径不再出现纯文本 setText", () => {
  // ① ChatPromptEditor.tsx:207（编辑历史）
  assert.match(
    CHAT_PROMPT_EDITOR_SOURCE,
    /resolvedInputApiRef\.current\?\.setTextWithMentions\(initialValue\)/,
    "编辑历史首帧回填必须走富装填",
  );
  assert.doesNotMatch(
    CHAT_PROMPT_EDITOR_SOURCE,
    /\.setText\(/,
    "编辑壳不得再用纯文本 setText 装填",
  );

  // ②③④⑤ ConversationComposer 四处
  assert.match(
    COMPOSER_SOURCE,
    /inputApi\.setTextWithMentions\(draft\.text\)/,
    "草稿 editorState 回退必须走富装填",
  );
  assert.ok(
    countOccurrences(COMPOSER_SOURCE, /inputApi\.setTextWithMentions\(request\.text\)/) >= 1,
    "外部预填与队列撤回 request.text 装填必须走富装填（S4：不锁字面量次数）",
  );
  assert.match(
    COMPOSER_SOURCE,
    /inputApiRef\.current\?\.setTextWithMentions\(submittedDraft\.text\)/,
    "发送失败回滚正文必须走富装填",
  );
  assert.match(
    COMPOSER_SOURCE,
    /inputApi\.setTextWithPluginMentions\(request\.text\)/,
    "插件预填调用面保持不变（P2-7）",
  );
  // 装填路径不得再出现裸 setText（updateText 内部的 React setState 不算）
  assert.doesNotMatch(COMPOSER_SOURCE, /inputApi\.setText\(/);
  assert.doesNotMatch(COMPOSER_SOURCE, /inputApiRef\.current\?\.setText\(/);
});

test("T-PR2-3: 队列行胶囊预览复用消息气泡渲染器", () => {
  assert.match(
    QUEUE_ROW_SOURCE,
    /import \{ ConversationUserInputContent \} from "@\/v4\/ConversationUserInputContent\.js";/,
    "队列行必须复用气泡渲染器，保证预览与落库消息同口径",
  );
  assert.match(
    QUEUE_ROW_SOURCE,
    /<ConversationUserInputContent text=\{item\.text\} \/>/,
    "队列行必须把 item.text 交给富渲染器",
  );
  assert.doesNotMatch(
    QUEUE_ROW_SOURCE,
    />\s*\{item\.text\}\s*</,
    "队列行不得再把原始 markdown 直接当子节点渲染",
  );
  // 死断言面补齐：data-v4-queue-item-preview 必须真的包住富渲染器（证明胶囊预览渲染），
  // 而不是一个没人验证的孤立属性。
  assert.match(
    QUEUE_ROW_SOURCE,
    /<span className="truncate" data-v4-queue-item-preview="true">\s*<ConversationUserInputContent text=\{item\.text\} \/>\s*<\/span>/,
    "预览容器必须带 data-v4-queue-item-preview 并承载富渲染器",
  );
});

test("T-PR2-4: 队列撤回 chip 恢复链在位（正文进编辑器 + 尾块随草稿载体）", () => {
  assert.match(
    COMPOSER_SOURCE,
    /import \{[^}]*parseComposerPromptContexts[^}]*\} from "@\/v4\/composer\/composerPromptContexts\.js";/,
    "composer 必须复用 prompt 上下文解析器",
  );
  assert.match(
    COMPOSER_SOURCE,
    /function resolveRestoredComposerContent\(/,
    "撤回正文必须经统一的拆分函数",
  );
  assert.match(
    COMPOSER_SOURCE,
    /parseComposerPromptContexts\(text, workspace\)/,
    "拆分必须走 parseComposerPromptContexts（与编辑历史路径对称）",
  );
  // 撤回装载：正文进编辑器 + 四类上下文写进草稿载体（P1：恢复态随草稿持久化）
  assert.match(
    COMPOSER_SOURCE,
    /request: \{ \.\.\.composerRestoreRequest, text: restoredContent\.visibleContent \}/,
  );
  assert.match(COMPOSER_SOURCE, /persistRestoredContent/);
  assert.match(
    COMPOSER_SOURCE,
    /text: restoredContent\.visibleContent,[\s\S]{0,80}editorStateJson: undefined/,
  );
  assert.match(
    COMPOSER_SOURCE,
    /promptContexts:\s*\n?\s*countComposerPromptContexts\(restoredContent\.contexts\) > 0/,
    "撤回尾块必须以 promptContexts 载体写进草稿",
  );
  // 恢复态的唯一事实源是草稿：chip 从 composerDraft.promptContexts 派生（切 scope 回来重建）
  assert.match(
    COMPOSER_SOURCE,
    /composerDraft\.promptContexts \?\? EMPTY_RESTORED_PROMPT_CONTEXTS/,
    "chip 必须由草稿载体重建，不能只活在组件 state",
  );
  assert.doesNotMatch(
    COMPOSER_SOURCE,
    /setRestoredPromptContexts\(/,
    "撤回恢复态不得再有组件私有 setState 写路径",
  );
  // chip 行与发送序列化都必须读合并后的数组
  assert.match(COMPOSER_SOURCE, /comments=\{mergedCodeCommentContexts\}/);
  assert.match(COMPOSER_SOURCE, /contexts=\{mergedWebElementContexts\}/);
  assert.match(COMPOSER_SOURCE, /references=\{mergedPptxElementReferences\}/);
  assert.match(COMPOSER_SOURCE, /references=\{mergedConversationSelections\}/);
  assert.match(
    COMPOSER_SOURCE,
    /mergeContextList\(\s*restoredPromptContexts\.codeComments,\s*getCodeCommentContexts\(\),/,
  );
  // 发送成功清空载体（避免下一条消息/切回来重复携带）；失败按提交时的载体快照回滚
  assert.match(COMPOSER_SOURCE, /updateComposerContent\(\{ promptContexts: undefined \}\)/);
  assert.match(
    COMPOSER_SOURCE,
    /promptContexts: submittedCarrierContexts/,
    "失败回滚必须写回提交时的载体（四类 chip 全保留）",
  );
  // 草稿写入口径：只在正文写入时重算编辑器结构；纯载体内更新不能清掉 mention/editorState。
  // 该规则已随 composer/B-2 收进纯函数 applyScopedDraftContentUpdate，行为由 composer/B-2 用例覆盖，
  // 这里只锁宿主仍只经该函数写内容（不得回到内联展开）。
  assert.match(
    DRAFT_CONTROL_SOURCE,
    /applyScopedDraftContentUpdate\(\{[\s\S]{0,260}currentScopeKey: stateRef\.current\.scopeKey/,
    "updateComposerContent 必须在 scope guard 之后基于 store 最新草稿执行",
  );
  assert.doesNotMatch(
    DRAFT_CONTROL_SOURCE,
    /content\.text !== undefined/,
    "正文写入清编辑器结构的规则只能有一处实现（applyScopedDraftContentUpdate）",
  );
  assert.match(
    DRAFT_CONTROL_SOURCE,
    /delete promotedDraft\.promptContexts;/,
    "promote 到新 session 时不得把已提交消息的 chip 带成新草稿",
  );
});

test("T-PR2-5: 队列撤回后重发字节不变（serialize(parse(text)) === text）", () => {
  const workspacePath = "/workspace/demo";
  const visible =
    "请看 [a.ts](./src/a.ts) 这里的实现，再补一个 [$code-review](/skills/code-review)。";
  const codeComment = {
    id: "cc-1",
    workspacePath,
    sourcePath: "src/a.ts",
    sourceTitle: "a.ts",
    selectedText: "export const a = 1;",
    comment: "这里需要判空",
    startLine: 1,
    endLine: 1,
  };
  const original = serializeComposerPromptContexts(visible, {
    codeComments: [codeComment],
    conversationSelections: [],
    webElements: [],
    pptxElements: [],
  });
  assert.ok(original.includes("# Code comments:"), "fixture 必须真的带上下文尾块");

  // 撤回：拆正文 + 尾块
  const parsed = parseComposerPromptContexts(original, { workspacePath });
  assert.equal(parsed.visibleContent, visible, "可见正文不能夹带尾块");
  assert.equal(parsed.codeComments.length, 1, "尾块必须还原成 chip 事实");

  // 重发：正文（含 mention canonical 链接）原样序列化回去
  const resubmitted = serializeComposerPromptContexts(parsed.visibleContent, {
    codeComments: parsed.codeComments,
    conversationSelections: parsed.conversationSelections,
    webElements: parsed.webElements,
    pptxElements: parsed.pptxElements,
  });
  assert.equal(resubmitted, original, "撤回后重发必须与原始 prompt 逐字节相同");
});

/** 四类上下文全量 fixture（P1 用例要求四类都真的在，不能被 parser 静默丢弃）。 */
function buildFourContextFixture(workspacePath: string) {
  const codeComment = {
    id: "cc-1",
    workspacePath,
    sourcePath: "src/a.ts",
    sourceTitle: "a.ts",
    selectedText: "export const a = 1;",
    comment: "这里需要判空",
    startLine: 1,
    endLine: 1,
  };
  const conversationSelection = { path: "src/b.ts", text: "被引用的助手片段" };
  const webElement = {
    id: "web-1",
    workspacePath,
    pageUrl: "https://example.com/app",
    pageTitle: "示例页",
    tagName: "button",
    role: "button",
    accessibleName: "提交",
    text: "提交",
    capturedAt: 1_700_000_000_000,
  };
  const pptxElement = {
    id: "pptx-1",
    workspacePath,
    sourcePath: "deck.pptx",
    sourceTitle: "deck.pptx",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    slideIndex: 0,
    slidePart: "ppt/slides/slide1.xml",
    nodeId: "node-1",
    nodeName: "标题",
    nodeType: "shape" as const,
    text: "季度汇报",
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    zIndex: 1,
    capturedAt: 1_700_000_000_000,
  };
  return { codeComment, conversationSelection, webElement, pptxElement };
}

test("T-PR2-6: 撤回→切 scope→切回→重发，四类上下文仍齐全（载体随草稿持久化）", () => {
  storageBacking.clear();
  const workspacePath = "/workspace/demo";
  const visible =
    "请看 [a.ts](./src/a.ts) 这里的实现，再补一个 [$code-review](/skills/code-review)。";
  const fixture = buildFourContextFixture(workspacePath);
  const original = serializeComposerPromptContexts(visible, {
    codeComments: [fixture.codeComment],
    conversationSelections: [fixture.conversationSelection],
    webElements: [fixture.webElement],
    pptxElements: [fixture.pptxElement],
  });

  // 1. 撤回：拆成「可见正文 + 四类上下文」
  const parsed = parseComposerPromptContexts(original, { workspacePath });
  assert.equal(parsed.visibleContent, visible, "可见正文不能夹带尾块");
  assert.equal(parsed.codeComments.length, 1, "code comments 必须还原");
  assert.equal(parsed.conversationSelections.length, 1, "会话选区必须还原");
  assert.equal(parsed.webElements.length, 1, "web 元素必须还原");
  assert.equal(parsed.pptxElements.length, 1, "pptx 元素必须还原");

  // 2. 撤回恢复态落盘到 session-b 草稿（正文 + promptContexts 载体）
  persistV4ComposerDraft(workspacePath, undefined, "session-b", {
    text: parsed.visibleContent,
    promptContexts: {
      codeComments: parsed.codeComments,
      conversationSelections: parsed.conversationSelections,
      webElements: parsed.webElements,
      pptxElements: parsed.pptxElements,
    },
  });
  // 3. 切走到 session-a：只写自己的草稿，不碰 b
  persistV4ComposerDraft(workspacePath, undefined, "session-a", { text: "另一个会话的草稿" });
  assert.equal(
    readV4ComposerDraft(workspacePath, undefined, "session-a")?.promptContexts,
    undefined,
    "别的 session 不能看到 b 的 chip 载体",
  );

  // 4. 切回 session-b：草稿载体重建 chip（ConversationComposer 从 promptContexts 派生）
  const restored = readV4ComposerDraft(workspacePath, undefined, "session-b");
  assert.ok(restored, "切回来必须读得到 b 的草稿");
  assert.equal(restored.text, parsed.visibleContent, "正文与撤回时一致");
  assert.ok(restored.promptContexts, "四类上下文载体必须随草稿存活");
  assert.equal(restored.promptContexts?.codeComments.length, 1);
  assert.equal(restored.promptContexts?.conversationSelections.length, 1);
  assert.equal(restored.promptContexts?.webElements.length, 1);
  assert.equal(restored.promptContexts?.pptxElements.length, 1);

  // 5. 重发：正文 + 载体序列化必须与原始 prompt 逐字节相同（T-PR2-5 语义跨 scope 保持）
  const resubmitted = serializeComposerPromptContexts(restored.text, {
    codeComments: restored.promptContexts?.codeComments ?? [],
    conversationSelections: restored.promptContexts?.conversationSelections ?? [],
    webElements: restored.promptContexts?.webElements ?? [],
    pptxElements: restored.promptContexts?.pptxElements ?? [],
  });
  assert.equal(resubmitted, original, "切 scope 回来重发必须与原始 prompt 逐字节相同");

  // 6. 纯上下文撤回（无可见正文）同样不能被空白删除语义丢掉
  persistV4ComposerDraft(workspacePath, undefined, "session-c", {
    text: "",
    promptContexts: restored.promptContexts,
  });
  const contextOnly = readV4ComposerDraft(workspacePath, undefined, "session-c");
  assert.equal(contextOnly?.promptContexts?.codeComments.length, 1, "空正文 + chip 载体必须可恢复");
});

// ── composer/G-1：撤回→发送状态机行为用例（T-PR2-7/8/9）──────────────────────────

test("T-PR2-7: mergeContextList 参数顺序 restored 在前，同 key 由 live 覆盖", () => {
  const restored = [{ id: "a" }, { id: "b" }];
  const live = [
    { id: "b", mark: "live" },
    { id: "c", mark: "live-c" },
  ];
  const merged = mergeContextList<{ id: string; mark?: string }>(restored, live, (item) => item.id);
  assert.deepEqual(
    merged.map((item) => item.id),
    ["a", "b", "c"],
    "restored 在前、live 在后；同 key 只留一条",
  );
  assert.equal(merged[1]?.mark, "live", "同 key 必须由 live 覆盖 restored（live 是最新事实）");
  // 参数倒序会让 restored 反过来覆盖 live：契约钉死顺序，防静默反转
  assert.deepEqual(
    mergeContextList<{ id: string; mark?: string }>(live, restored, (item) => item.id).map(
      (item) => item.id,
    ),
    ["c", "a", "b"],
  );
  // 空侧短路（保留引用，避免无谓重渲染）
  assert.equal(
    mergeContextList([], live, (item) => item.id),
    live,
  );
  assert.equal(
    mergeContextList(restored, [], (item) => item.id),
    restored,
  );
});

test("T-PR2-8: fail 回滚后四类 chip 全保留", () => {
  const contexts: ComposerSubmitContexts = {
    codeComments: [{ id: "cc-1" }],
    conversationSelections: [{ path: "src/a.ts", text: "片段" }],
    webElements: [{ id: "web-1" }],
    pptxElements: [{ id: "pptx-1" }],
  };
  const claimed = composerSubmitMachine.reduce(
    { phase: "idle", frozenContexts: emptyContexts(), liveContexts: contexts },
    { type: "claim" },
  );
  assert.equal(claimed.phase, "claimed");
  assert.equal(claimed.frozenContexts.codeComments.length, 1);
  assert.equal(claimed.frozenContexts.conversationSelections.length, 1);
  // 等待期用户把四类全删光：失败回滚必须把冻结面全部补回
  const failed = composerSubmitMachine.reduce(
    { ...claimed, liveContexts: emptyContexts() },
    { type: "fail" },
  );
  assert.equal(failed.phase, "failed");
  assert.equal(failed.liveContexts.codeComments.length, 1);
  assert.equal(failed.liveContexts.conversationSelections.length, 1);
  assert.equal(failed.liveContexts.webElements.length, 1);
  assert.equal(failed.liveContexts.pptxElements.length, 1);
  // 冻结面本身不变（失败后可原样重试再 claim）
  assert.equal(failed.frozenContexts, claimed.frozenContexts);
});

test("T-PR2-9: claimed 期间新增 chip 不被 succeed 清除", () => {
  const claimed = composerSubmitMachine.reduce(
    {
      phase: "idle",
      frozenContexts: emptyContexts(),
      liveContexts: { ...emptyContexts(), codeComments: [{ id: "cc-submitted" }] },
    },
    { type: "claim" },
  );
  // 等待期间用户新加一枚（属于下一条消息）
  const grown = {
    ...claimed,
    liveContexts: {
      ...claimed.liveContexts,
      codeComments: [...claimed.liveContexts.codeComments, { id: "cc-new" }],
    },
  };
  const succeeded = composerSubmitMachine.reduce(grown, { type: "succeed" });
  assert.equal(succeeded.phase, "idle");
  assert.deepEqual(
    succeeded.liveContexts.codeComments.map((item) => item.id),
    ["cc-new"],
    "只清冻结面；等待期新增必须保留",
  );
  assert.equal(succeeded.liveContexts.webElements.length, 0);
});

test("T-PR2-10 / composer/B-1: 纯上下文（恢复态载体）输入可提交", () => {
  const contextOnly = resolveComposerSubmitAvailability({
    text: "",
    attachments: [],
    contexts: {
      codeComments: [{ id: "cc-restored" }],
      conversationSelections: [],
      webElements: [],
      pptxElements: [],
    },
  });
  assert.equal(contextOnly.canSubmit, true, "纯上下文必须可提交（发送键要亮）");
  assert.equal(contextOnly.allowSubmitWhenEmpty, true, "空正文必须允许 Enter");
  assert.equal(contextOnly.hasContent, true, "载体必须算草稿占用（队列编辑门禁）");
  assert.equal(contextOnly.contextCount, 1);

  // 红判据：contexts 只传 live 侧（纯上下文场景恒空）时三项全 false ——
  // 这正是修复前的行为，任何把入参改回 live-only 的回归都会在这里转红。
  const liveOnly = resolveComposerSubmitAvailability({
    text: "",
    attachments: [],
    contexts: emptyContexts(),
  });
  assert.equal(liveOnly.canSubmit, false);
  assert.equal(liveOnly.allowSubmitWhenEmpty, false);
  assert.equal(liveOnly.hasContent, false);

  // 纯空白正文：占用 composer 但不可提交
  const whitespace = resolveComposerSubmitAvailability({
    text: "  \n ",
    attachments: [],
    contexts: emptyContexts(),
  });
  assert.equal(whitespace.hasContent, true);
  assert.equal(whitespace.canSubmit, false);
  assert.equal(whitespace.allowSubmitWhenEmpty, false);

  // 附件路径保持原语义
  const withAttachment = resolveComposerSubmitAvailability({
    text: "",
    attachments: [{ id: "att-1" }],
    contexts: emptyContexts(),
  });
  assert.equal(withAttachment.canSubmit, true);
  assert.equal(withAttachment.allowSubmitWhenEmpty, true);
});

test("composer/B-1: 三处判定与 SessionPane 门禁同源消费 merged 载体", () => {
  assert.match(
    COMPOSER_SOURCE,
    /resolveComposerSubmitAvailability\(\{\s*text,\s*attachments: attachmentsApi\.attachments,\s*contexts: \{\s*codeComments: mergedCodeCommentContexts,\s*conversationSelections: mergedConversationSelections,\s*webElements: mergedWebElementContexts,\s*pptxElements: mergedPptxElementReferences,/,
    "三处判定的入参必须是 merged 四类（restored + live）",
  );
  assert.match(COMPOSER_SOURCE, /const hasDraftToSubmit = submitAvailability\.canSubmit;/);
  assert.match(COMPOSER_SOURCE, /const hasComposerDraftContent = submitAvailability\.hasContent;/);
  assert.match(
    COMPOSER_SOURCE,
    /allowSubmitWhenEmpty=\{[\s\S]{0,300}submitAvailability\.allowSubmitWhenEmpty\s*\}/,
    "Enter 空正文放行必须与发送键同源",
  );
  // 任一改回 live-only 即红
  assert.doesNotMatch(
    COMPOSER_SOURCE,
    /hasCodeCommentContexts|hasWebElementContexts|hasPptxElementReferences|hasConversationSelectionReferences/,
    "三处表达式不得再引用 live hook 的布尔别名",
  );
  // 撤回静默挂起是 B-1 难以察觉的根因：必须留 warn
  assert.match(
    COMPOSER_SOURCE,
    /logger\.warn\("\[v4-composer\] queue 撤回未应用：composer 仍有草稿内容"/,
  );
  // SessionPane 队列编辑冲突门禁由 composer 上报的同一 hasContent 驱动
  assert.match(
    SESSION_PANE_SOURCE,
    /if \(composerDraftStateRef\.current\.hasContent \|\| composerDraftStateRef\.current\.busy\)/,
    "SessionPane 撤回门禁必须读 composer 上报的 hasContent",
  );
  assert.match(COMPOSER_SOURCE, /hasContent: hasComposerDraftContent/);
});

// ── composer/B-2：scope guard + 函数形态内容更新 ──────────────────────────────

test("composer/B-2: 旧 scope 更新整条丢弃，函数式 updater 基于传入草稿累积", () => {
  const EMPTY_DRAFT_CONTEXTS = {
    codeComments: [],
    conversationSelections: [],
    webElements: [],
    pptxElements: [],
  } as const;
  const mention = {
    id: "mention-1",
    category: "files" as const,
    label: "a.ts",
    value: "src/a.ts",
    markdown: "[a.ts](./src/a.ts)",
  };
  const draft: V4ComposerDraft = { text: "hi", promptContexts: EMPTY_DRAFT_CONTEXTS, updatedAt: 0 };

  // ① scope 不同 → 原样返回且 dropped
  const dropped = applyScopedDraftContentUpdate({
    scopeKey: "session-b",
    currentScopeKey: "session-a",
    draft,
    update: { promptContexts: undefined },
  });
  assert.equal(dropped.dropped, true);
  assert.equal(dropped.draft, draft, "旧 scope 更新不得基于旧闭包写入");

  // ② 同 scope → 应用 updater，且以传入 draft 为基底；③ 同 tick 连续两次累积
  let current: V4ComposerDraft = draft;
  for (const suffix of ["1", "2"]) {
    const result = applyScopedDraftContentUpdate({
      scopeKey: "session-a",
      currentScopeKey: "session-a",
      draft: current,
      update: (latest) => ({ text: `${latest.text}${suffix}` }),
    });
    assert.equal(result.dropped, false);
    current = result.draft;
  }
  assert.equal(current.text, "hi12", "连续函数式更新必须累积，不得互相覆盖");

  // 只写上下文载体不得清编辑器结构；写正文才清
  const withEditor = { ...draft, editorStateJson: "{}", mention };
  const carrierOnly = applyScopedDraftContentUpdate({
    scopeKey: "session-a",
    currentScopeKey: "session-a",
    draft: withEditor,
    update: { promptContexts: undefined },
  }).draft;
  assert.equal(carrierOnly.editorStateJson, "{}");
  assert.equal(carrierOnly.mention, mention);
  const textWrite = applyScopedDraftContentUpdate({
    scopeKey: "session-a",
    currentScopeKey: "session-a",
    draft: withEditor,
    update: { text: "next" },
  }).draft;
  assert.equal(textWrite.editorStateJson, undefined);
  assert.equal(textWrite.mention, undefined);

  // 形状守卫：组件不再保留渲染期 ref 镜像，只做函数式转发
  assert.doesNotMatch(COMPOSER_SOURCE, /restoredPromptContextsRef/);
  assert.match(COMPOSER_SOURCE, /updateComposerContent\(\(currentDraft\) =>/);
  assert.match(COMPOSER_SOURCE, /currentDraft\.promptContexts \?\? EMPTY_RESTORED_PROMPT_CONTEXTS/);
});

