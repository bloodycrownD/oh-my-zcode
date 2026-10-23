/**
 * T-PR2（Step 21 / phase-pill-restore，blocking）：装填路径形状守卫。
 *
 * 本仓 UI 测试基建是纯逻辑/源码形状测试（无 jsdom），因此这里钉源码形状：
 * 1) LexicalChatInput 暴露富装填 API，且 setTextWithPluginMentions 只是它的薄包装；
 * 2) spec 点名的 5 个 setText 点全部换成富 API，装填路径不再出现纯文本 setText；
 * 3) 队列行预览复用消息气泡渲染器（胶囊预览）；
 * 4) 队列撤回把 item.text 拆成「正文 + 上下文尾块」，尾块还原成 chip 并参与重发序列化。
 *
 * 第 5 组用真实 serializer/parser 验证「撤回后重发字节不变」（T-QA3 的自动面）。
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

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const LEXICAL_INPUT_SOURCE = readSource("../src/LexicalChatInput.tsx");
const CHAT_PROMPT_EDITOR_SOURCE = readSource("../src/prompt-editor/ChatPromptEditor.tsx");
const COMPOSER_SOURCE = readSource("../src/v4/ConversationComposer.tsx");
const QUEUE_ROW_SOURCE = readSource("../src/v4/ConversationQueueRow.tsx");
const MENTION_MARKDOWN_SOURCE = readSource("../src/mentions/mentionMarkdown.ts");

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

test("T-PR2-4: 队列撤回 chip 恢复链在位（正文进编辑器 + 尾块还原成 chip）", () => {
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
  // 撤回装载：正文进编辑器，上下文进 restored 状态并合并进 chip 行
  assert.match(
    COMPOSER_SOURCE,
    /request: \{ \.\.\.composerRestoreRequest, text: restoredContent\.visibleContent \}/,
  );
  assert.match(COMPOSER_SOURCE, /restoredPromptContexts: restoredContent\.contexts/);
  assert.match(COMPOSER_SOURCE, /onPromptContextsRestored: setRestoredPromptContexts/);
  assert.match(
    COMPOSER_SOURCE,
    /text: restoredContent\.visibleContent,[\s\S]{0,80}editorStateJson: undefined/,
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
  // 发送成功清空撤回 chip，避免下一条消息重复携带
  assert.match(COMPOSER_SOURCE, /setRestoredPromptContexts\(EMPTY_RESTORED_PROMPT_CONTEXTS\)/);
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
