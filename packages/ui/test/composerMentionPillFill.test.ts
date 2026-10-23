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
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "../src/v4/composer/composerPromptContexts.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const LEXICAL_INPUT_SOURCE = readSource("../src/LexicalChatInput.tsx");
const CHAT_PROMPT_EDITOR_SOURCE = readSource("../src/prompt-editor/ChatPromptEditor.tsx");
const COMPOSER_SOURCE = readSource("../src/v4/ConversationComposer.tsx");
const QUEUE_ROW_SOURCE = readSource("../src/v4/ConversationQueueRow.tsx");
const DRAFT_CONTROL_SOURCE = readSource("../src/v4/composer/useDraftConfigControl.ts");
const MENTION_MARKDOWN_SOURCE = readSource("../src/mentions/mentionMarkdown.ts");

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
  // 两个 handle 构造点（E2E bridge + EditorApiPlugin）都要接线
  assert.equal(
    countOccurrences(
      LEXICAL_INPUT_SOURCE,
      /setTextWithMentions: \(text: string\) => replaceEditorTextWithMentions\(editor, text\)/,
    ),
    2,
    "E2E bridge 与 EditorApiPlugin 都必须复用同一条富装填实现",
  );
  // 历史 API 保留为薄包装（ConversationComposer.tsx:271 调用面不动）
  assert.equal(
    countOccurrences(
      LEXICAL_INPUT_SOURCE,
      /setTextWithPluginMentions: \(text: string\) => replaceEditorTextWithMentions\(editor, text\)/,
    ),
    2,
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
  assert.equal(
    countOccurrences(COMPOSER_SOURCE, /inputApi\.setTextWithMentions\(request\.text\)/),
    2,
    "外部预填与队列撤回两条 request.text 装填都必须走富装填",
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
  // 发送成功清空载体（避免下一条消息/切回来重复携带）；失败按发送前快照回滚两侧
  assert.match(COMPOSER_SOURCE, /updateComposerContent\(\{ promptContexts: undefined \}\)/);
  assert.match(COMPOSER_SOURCE, /promptContexts: submittedPromptContexts/);
  // 草稿写入口径：只在正文写入时重算编辑器结构；纯载体内更新不能清掉 mention/editorState
  assert.match(
    DRAFT_CONTROL_SOURCE,
    /content\.text !== undefined[\s\S]{0,140}editorStateJson: undefined/,
    "只写上下文载体不得顺手清掉编辑器结构",
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
