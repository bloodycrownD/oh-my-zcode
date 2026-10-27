// 编辑态胶囊恢复的反解层单测（fix/composer-mention-restore）。
//
// 背景：从消息 / 提示词队列重新编辑时，胶囊会退化成 markdown 字面量——恢复路径只调
// `setText`（纯 TextNode）。修复把恢复改成 `parseMentionMarkdownParts` + mention 节点。
//
// 这里钉住三件事：
//   1. 七类 mention 都能反解出正确的 category / label / value；
//   2. 原始片段 `markdown` 原样保留（节点靠它做 getMarkdown 往返）；
//   3. **往返逐字节相等**——否则「点一下编辑、内容就被改写」。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildFileMentionMarkdown,
  buildPluginMentionMarkdown,
  buildSessionMentionMarkdown,
  buildSkillMentionMarkdown,
  type MentionMarkdownPart,
  parseMentionMarkdown,
  parseMentionMarkdownParts,
} from "../src/mentions/mentionMarkdown.js";

const here = dirname(fileURLToPath(import.meta.url));

type MentionPart = Extract<MentionMarkdownPart, { kind: "mention" }>;

/** 把段按顺序拼回原文：必须与原串逐字节相等。 */
function rejoin(parts: readonly MentionMarkdownPart[]): string {
  return parts.map((part) => (part.kind === "text" ? part.text : part.markdown)).join("");
}

function mentions(parts: readonly MentionMarkdownPart[]): MentionPart[] {
  return parts.filter((part): part is MentionPart => part.kind === "mention");
}

test("mention parts: file link restores as a files mention and round-trips", () => {
  const text = `看下 ${buildFileMentionMarkdown("src/main.ts", "main.ts")} 这个文件`;
  const parts = parseMentionMarkdownParts(text);

  assert.equal(rejoin(parts), text, "往返必须逐字节相等");
  assert.deepEqual(
    mentions(parts).map((part) => ({
      category: part.category,
      label: part.label,
      value: part.value,
      path: part.data?.path,
      kind: part.data?.kind,
    })),
    [
      {
        category: "files",
        label: "main.ts",
        value: "src/main.ts",
        path: "src/main.ts",
        kind: "file",
      },
    ],
  );
});

test("mention parts: directory link keeps the folder kind", () => {
  const text = buildFileMentionMarkdown("src/components/", "components/", "directory");
  const [mention] = mentions(parseMentionMarkdownParts(text));

  assert.ok(mention, "目录链接必须反解出 mention");
  assert.equal(mention.category, "files");
  assert.equal(mention.data?.kind, "directory");
  assert.equal(mention.value, "src/components/");
  assert.equal(rejoin(parseMentionMarkdownParts(text)), text);
});

test("mention parts: skill link and bare $token both restore as skills", () => {
  const linked = buildSkillMentionMarkdown("code-review", "skills/code-review/SKILL.md");
  const text = `${linked} 然后 $quick-fix`;
  const parts = parseMentionMarkdownParts(text);

  assert.equal(rejoin(parts), text);
  assert.deepEqual(
    mentions(parts).map((part) => ({
      category: part.category,
      label: part.label,
      value: part.value,
    })),
    [
      { category: "skills", label: "code-review", value: "code-review" },
      { category: "skills", label: "quick-fix", value: "quick-fix" },
    ],
  );
  // 链接形态带 skill 路径（供消息气泡与后续 catalog 关联）。
  assert.equal(mentions(parts)[0]?.data?.path, "skills/code-review/SKILL.md");
});

test("mention parts: commands, subagents and sessions restore from bare tokens", () => {
  const text = "/compact 之后 @reviewer 看一下 #sess_abc123";
  const parts = parseMentionMarkdownParts(text);

  assert.equal(rejoin(parts), text);
  assert.deepEqual(
    mentions(parts).map((part) => ({ category: part.category, value: part.value })),
    [
      { category: "commands", value: "compact" },
      { category: "subagents", value: "reviewer" },
      { category: "sessions", value: "sess_abc123" },
    ],
  );
});

test("mention parts: session link keeps the sess_ id as value", () => {
  const text = buildSessionMentionMarkdown("sess_abc123", "释放前排查");
  const [mention] = mentions(parseMentionMarkdownParts(text));

  assert.ok(mention);
  assert.equal(mention.category, "sessions");
  assert.equal(mention.value, "sess_abc123");
  assert.equal(mention.label, "释放前排查");
  assert.equal(rejoin(parseMentionMarkdownParts(text)), text);
});

test("mention parts: plugin link keeps the stable id", () => {
  const text = buildPluginMentionMarkdown("Weather", "weather@marketplace");
  const [mention] = mentions(parseMentionMarkdownParts(text));

  assert.ok(mention);
  assert.equal(mention.category, "plugins");
  assert.equal(mention.value, "weather@marketplace");
  assert.equal(mention.data?.pluginId, "weather@marketplace");
  assert.equal(rejoin(parseMentionMarkdownParts(text)), text);
});

test("mention parts: non-plugin external links stay plain text", () => {
  const text = "参考 [Google](https://google.com) 和 [mail](mailto:a@b.com)";
  const parts = parseMentionMarkdownParts(text);

  assert.equal(mentions(parts).length, 0, "外链不得被当成文件胶囊");
  assert.equal(rejoin(parts), text);
});

test("mention parts: a realistic edited prompt round-trips with mixed content", () => {
  const text = [
    `${buildSkillMentionMarkdown("code-review", "skills/code-review/SKILL.md")} 帮我看下 ${buildFileMentionMarkdown("src/a.ts", "a.ts")}`,
    "",
    "第二段 $quick-fix 和 @reviewer",
  ].join("\n\n");
  const parts = parseMentionMarkdownParts(text);

  assert.equal(rejoin(parts), text, "跨段多 mention 必须逐字节往返");
  assert.deepEqual(
    mentions(parts).map((part) => part.category),
    ["skills", "files", "skills", "subagents"],
  );
});

test("mention parts: plain text without mentions is a single text part", () => {
  const text = "就一句话，没有引用。";
  const parts = parseMentionMarkdownParts(text);

  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { kind: "text", text });
});

test("mention parts: empty input yields no parts", () => {
  assert.deepEqual(parseMentionMarkdownParts(""), []);
});

// B-2a：页内锚点与空目标不是 mention。按文件还原会把可见文字从「见上文」改成
// `#commit-3`（displayLabel 走 resolveFileDisplayDescriptor → getPathLeaf）。
test("mention parts: page anchors and empty destinations stay plain text", () => {
  const anchorText = "先说结论：见 [见上文](#commit-3) 这节";
  const anchorParts = parseMentionMarkdownParts(anchorText);

  assert.equal(mentions(anchorParts).length, 0, "#锚点不得变成文件胶囊");
  assert.equal(rejoin(anchorParts), anchorText);

  const emptyTarget = "[空目标]()";
  const emptyParts = parseMentionMarkdownParts(emptyTarget);
  assert.equal(mentions(emptyParts).length, 0, "空 destination 不得变成胶囊");
  assert.equal(rejoin(emptyParts), emptyTarget);
});

// B-2b：气泡层与编辑器层共用同一分类入口，但**兜底不同**：
// - 编辑器侧：外链 / 锚点 / 空目标一律保持纯文本（不能把 URL 变成 token 节点）；
// - 气泡侧：外链仍按历史口径显示为 file/directory（改成字面量会让消息变丑且复制丢 URL），
//   但页内锚点与空目标不再被当成文件（否则可见文字会从「见上文」变成 `#commit-3`）。
test("mention markdown (bubble layer): page anchors and empty targets are not file mentions", () => {
  const anchorParts = parseMentionMarkdown("见 [见上文](#commit-3) 这节");
  assert.equal(
    anchorParts.some((part) => part.type === "file" || part.type === "directory"),
    false,
    "#锚点不得渲染成文件胶囊",
  );

  const emptyParts = parseMentionMarkdown("[空目标]()");
  assert.equal(
    emptyParts.some((part) => part.type === "file" || part.type === "directory"),
    false,
    "空 destination 不得渲染成胶囊",
  );

  // 既有口径：外链在气泡里仍按文件展示（本次不动，见 fix-spec B-2b 的范围说明）。
  const linkParts = parseMentionMarkdown("[Google](https://google.com)");
  assert.deepEqual(linkParts, [{ type: "file", label: "Google" }]);
});

// B-1 源码形状守卫：历史回填必须复用共享的 mention 重建，
// 否则带胶囊的 prompt 按 ↑ 回填后会退化成 markdown 字面量。
test("history navigation reuses the mention-aware restore (source guard)", () => {
  const source = readFileSync(join(here, "../src/LexicalChatInput.tsx"), "utf8");
  const start = source.indexOf("const applyHistoryEntry");
  assert.ok(start >= 0, "applyHistoryEntry 必须存在");

  const end = source.indexOf("const handleHistoryNavigation", start);
  assert.ok(end > start, "applyHistoryEntry 的边界必须可定位");

  const body = source.slice(start, end);
  assert.match(
    body,
    /\$replaceRootWithPromptMarkdown\(nextValue\)/,
    "历史回填必须走共享的 markdown→mention 重建",
  );
  assert.doesNotMatch(
    body,
    /\$createTextNode\(line\)/,
    "历史回填不得再自行拼 TextNode（胶囊会退化成字面量）",
  );
});

// 真机回归（2026-10-27）：Windows 绝对路径的 skill 在编辑态仍是 markdown 字面量。
// `buildSkillMentionMarkdown` 会 escape destination，落库形态是 `C:\\Users\\...`；
// 而 `^[a-zA-Z][a-zA-Z\d+.-]*:` 这条协议判据会把盘符 `C:` 误判成 scheme，
// 于是 skill/file 分支被跳过、整段退化成纯文本。
test("mention parts: Windows absolute paths are not mistaken for URL schemes", () => {
  const text =
    "[$brain-storm](C:\\\\Users\\\\BloodyCrown\\\\.agents\\\\skills\\\\brain-storm\\\\SKILL.md) " +
    "[$apm-recall](C:\\\\Users\\\\BloodyCrown\\\\.agents\\\\skills\\\\apm-recall\\\\SKILL.md) xxx";
  const parts = parseMentionMarkdownParts(text);

  assert.equal(rejoin(parts), text, "往返必须逐字节相等");
  assert.deepEqual(
    mentions(parts).map((part) => ({
      category: part.category,
      label: part.label,
      path: part.data?.path,
    })),
    [
      {
        category: "skills",
        label: "brain-storm",
        path: "C:\\Users\\BloodyCrown\\.agents\\skills\\brain-storm\\SKILL.md",
      },
      {
        category: "skills",
        label: "apm-recall",
        path: "C:\\Users\\BloodyCrown\\.agents\\skills\\apm-recall\\SKILL.md",
      },
    ],
  );
});
