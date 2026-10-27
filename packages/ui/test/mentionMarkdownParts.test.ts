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
import test from "node:test";

import {
  buildFileMentionMarkdown,
  buildPluginMentionMarkdown,
  buildSessionMentionMarkdown,
  buildSkillMentionMarkdown,
  type MentionMarkdownPart,
  parseMentionMarkdownParts,
} from "../src/mentions/mentionMarkdown.js";

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
