/**
 * T-PR1（Step 20 / phase-pill-restore，blocking）：富反解析纯函数边界。
 *
 * 钉住 parseMentionMarkdownRich 的六条契约：
 * 1) 往返恒等：所有段（text + mention.markdown）按序拼接 === 输入原文，
 *    即编辑器 getMarkdown() 与输入逐字节相同（`markdown` 恒等于 fullMatch）；
 * 2) 转义：label 的 `\[`/`\]`/`\\` 还原，destination 的 `\` 转义按还原值判白名单；
 * 3) 目录尾斜杠：`./dir/` 还原成 directory 语义（data.kind），不能退化成 file；
 * 4) 白名单外 URL 不转：http/mailto/未知协议/裸相对路径一律留在正文；
 * 5) 代码块 fence 跳过：``` 与 ~~~ 内的 mention 链接不解析（R7）；
 * 6) inline 裸 token 不转：@name / $slug / /cmd / #sess_x 保持用户文本（用户拍板）。
 *
 * 运行形态：node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/composerMentionPillParse.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFileMentionMarkdown,
  buildPluginMentionMarkdown,
  buildSessionMentionMarkdown,
  buildSkillMentionMarkdown,
  parseMentionMarkdownRich,
  splitRichMentionParagraphs,
  type RichMentionSegment,
} from "../src/mentions/mentionMarkdown.js";
import { mapWorkspaceFileToMentionItem } from "../src/mentions/providers/fileMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "../src/mentions/providers/skillsMentionProvider.js";
import { isMentionAlreadyPresent } from "../src/mentions/mentionTypes.js";

const FENCE = "`".repeat(3);
const TILDE_FENCE = "~".repeat(3);

/** 往返恒等：text 段与 mention 段（用 markdown 原文）拼接后必须逐字节等于输入。 */
function assertRoundTrip(input: string, segments: readonly RichMentionSegment[]): void {
  const rebuilt = segments
    .map((segment) => (segment.type === "text" ? segment.text : segment.markdown))
    .join("");
  assert.equal(rebuilt, input, "解析结果拼接必须与输入逐字节相同");
  for (const segment of segments) {
    if (segment.type !== "mention") continue;
    assert.ok(
      input.includes(segment.markdown),
      `mention.markdown 必须是输入原文子串：${segment.markdown}`,
    );
  }
  // 相邻文本段必须已合并（编辑器装填时少造 TextNode）。
  for (let index = 1; index < segments.length; index += 1) {
    assert.ok(
      !(segments[index - 1]?.type === "text" && segments[index]?.type === "text"),
      "相邻文本段必须合并",
    );
  }
}

function mentionsOf(segments: readonly RichMentionSegment[]) {
  return segments.filter((segment) => segment.type === "mention");
}

test("T-PR1-1: 链接形态全类往返恒等（file/directory/skill/session/plugin 混合正文）", () => {
  const input = [
    buildPluginMentionMarkdown("alpha", "alpha@market"),
    " 请参考 ",
    buildFileMentionMarkdown("src/lib/mentionMarkdown.ts", "mentionMarkdown.ts"),
    " 与目录 ",
    buildFileMentionMarkdown("src/lib", "lib", "directory"),
    "，技能 ",
    buildSkillMentionMarkdown("code-review", "/skills/code-review"),
    "，会话 ",
    buildSessionMentionMarkdown("sess_abc123", "重构讨论"),
    "。",
  ].join("");

  const segments = parseMentionMarkdownRich(input);
  assertRoundTrip(input, segments);

  const mentions = mentionsOf(segments);
  assert.deepEqual(
    mentions.map((mention) => mention.category),
    ["plugins", "files", "files", "skills", "sessions"],
  );
  assert.deepEqual(
    mentions.map((mention) => mention.markdown),
    [
      buildPluginMentionMarkdown("alpha", "alpha@market"),
      buildFileMentionMarkdown("src/lib/mentionMarkdown.ts", "mentionMarkdown.ts"),
      buildFileMentionMarkdown("src/lib", "lib", "directory"),
      buildSkillMentionMarkdown("code-review", "/skills/code-review"),
      buildSessionMentionMarkdown("sess_abc123", "重构讨论"),
    ],
  );
  // 文本段保留原文（包括中文标点与空格）。
  assert.equal(segments[1]?.type, "text");
  assert.equal(segments[1]?.type === "text" ? segments[1].text : "", " 请参考 ");
});

test("T-PR1-2: 各分类的 label/value/data 还原口径", () => {
  const plugin = mentionsOf(
    parseMentionMarkdownRich(buildPluginMentionMarkdown("Alpha", "alpha@market")),
  )[0];
  assert.equal(plugin?.category, "plugins");
  assert.equal(plugin?.label, "Alpha", "plugin label 去掉 @ 前缀");
  assert.equal(plugin?.value, "alpha@market", "plugin value 是 stable id");
  assert.deepEqual(plugin?.data, { pluginId: "alpha@market" });

  const file = mentionsOf(
    parseMentionMarkdownRich(buildFileMentionMarkdown("src/a.ts", "a.ts")),
  )[0];
  assert.equal(file?.category, "files");
  assert.equal(file?.label, "a.ts");
  assert.equal(file?.value, "src/a.ts", "相对路径去掉 ./ 前缀");
  assert.deepEqual(file?.data, { kind: "file", relativePath: "src/a.ts" });

  const skill = mentionsOf(
    parseMentionMarkdownRich(buildSkillMentionMarkdown("code-review", "./skills/cr.md")),
  )[0];
  assert.equal(skill?.category, "skills");
  assert.equal(skill?.label, "code-review", "skill label 去掉 $ 前缀");
  assert.equal(
    skill?.value,
    "code-review",
    "skill value 是技能名（与 provider `value: skill.name` 同口径）",
  );
  assert.deepEqual(skill?.data, { path: "./skills/cr.md" }, "skill 的路径落 data.path");

  const session = mentionsOf(
    parseMentionMarkdownRich(buildSessionMentionMarkdown("sess_x9", "标题")),
  )[0];
  assert.equal(session?.category, "sessions");
  assert.equal(session?.label, "标题", "session label 去掉 # 前缀");
  assert.equal(session?.value, "sess_x9");
});

test("T-PR1-3: 转义——label 的 \\] / \\\\ 还原，destination 转义按还原值判白名单", () => {
  const escapedLabel = "[a\\]b\\\\c](./x.ts)";
  const labelSegments = parseMentionMarkdownRich(escapedLabel);
  assertRoundTrip(escapedLabel, labelSegments);
  const labelMention = mentionsOf(labelSegments)[0];
  assert.equal(labelMention?.category, "files");
  assert.equal(labelMention?.label, "a]b\\c", "label 转义必须还原成用户可见文本");

  // Windows 盘符绝对路径：builder 会把 `\` 转义成 `\\`（`:` 不在转义集内），
  // 白名单必须按还原后的值判定。
  const windowsPath = buildFileMentionMarkdown("C:\\dev\\x.ts", "x.ts");
  assert.ok(windowsPath.includes("C:\\\\dev"), `builder 应转义反斜杠：${windowsPath}`);
  const windowsSegments = parseMentionMarkdownRich(windowsPath);
  assertRoundTrip(windowsPath, windowsSegments);
  const windowsMention = mentionsOf(windowsSegments)[0];
  assert.equal(windowsMention?.category, "files", "盘符绝对路径在白名单内");
  assert.equal(windowsMention?.value, "C:\\dev\\x.ts");
  assert.deepEqual(windowsMention?.data, { kind: "file", path: "C:\\dev\\x.ts" });

  // 尖括号包裹的 destination（含空格路径）。
  const angle = "[my file](<./dir/my file.ts>)";
  const angleSegments = parseMentionMarkdownRich(angle);
  assertRoundTrip(angle, angleSegments);
  const angleMention = mentionsOf(angleSegments)[0];
  assert.equal(angleMention?.category, "files");
  assert.equal(angleMention?.label, "my file");
  assert.equal(angleMention?.value, "dir/my file.ts");

  // 尖括号里以反斜杠收尾是歧义写法（`\>` 会被当成转义），解析器必须 fail-safe 留正文。
  const ambiguous = "[a](<D:\\work\\lib\\>)";
  const ambiguousSegments = parseMentionMarkdownRich(ambiguous);
  assertRoundTrip(ambiguous, ambiguousSegments);
  assert.equal(mentionsOf(ambiguousSegments).length, 0, "歧义 destination 不得猜成 chip");
});

test("T-PR1-4: 目录尾斜杠只留在 markdown，chip 字段与 file provider 同形", () => {
  // ① 相对目录：尾斜杠是目录语义的唯一载体（markdown 保留），
  //    但 chip 的 kind/relativePath/value 必须与 provider 产出同形（不带尾斜杠）。
  const relativeDir = buildFileMentionMarkdown("src/lib", "lib", "directory");
  assert.ok(relativeDir.endsWith("/)"), "目录 mention 的 destination 必须以斜杠结尾");
  const relativeSegments = parseMentionMarkdownRich(relativeDir);
  assertRoundTrip(relativeDir, relativeSegments);
  const relativeMention = mentionsOf(relativeSegments)[0];
  assert.equal(relativeMention?.category, "files");
  const providerDir = mapWorkspaceFileToMentionItem({
    name: "lib",
    path: "/workspace/src/lib",
    relativePath: "src/lib",
    type: "directory",
  });
  assert.equal(relativeMention?.data?.kind, providerDir.data?.kind, "kind 与 provider 一致");
  assert.equal(
    relativeMention?.data?.relativePath,
    providerDir.data?.relativePath,
    "relativePath 与 provider 一致（provider 不带尾斜杠）",
  );
  assert.equal(relativeMention?.value, providerDir.value, "value 与 provider 一致");
  assert.deepEqual(relativeMention?.data, { kind: "directory", relativePath: "src/lib" });

  // ② POSIX 绝对目录：绝对分支同去尾斜杠，path/value 对照。
  const posixDirMarkdown = buildFileMentionMarkdown("/workspace/src", "src", "directory");
  const posixDir = parseMentionMarkdownRich(posixDirMarkdown);
  assertRoundTrip(posixDirMarkdown, posixDir);
  const posixMention = mentionsOf(posixDir)[0];
  assert.equal(posixMention?.data?.kind, "directory");
  assert.equal(posixMention?.data?.path, "/workspace/src", "绝对目录 path 不带尾斜杠");
  assert.equal(posixMention?.value, "/workspace/src", "绝对目录 value 不带尾斜杠");

  // ③ Windows 绝对目录：盘符分支同样去尾斜杠（不能因为反斜杠口径被漏掉）。
  const windowsDirMarkdown = buildFileMentionMarkdown("D:\\work\\lib", "lib", "directory");
  const windowsDir = parseMentionMarkdownRich(windowsDirMarkdown);
  assertRoundTrip(windowsDirMarkdown, windowsDir);
  const windowsMention = mentionsOf(windowsDir)[0];
  assert.equal(windowsMention?.data?.kind, "directory");
  assert.equal(windowsMention?.data?.path, "D:\\work\\lib", "Windows 绝对目录 path 不带尾分隔符");
  assert.equal(windowsMention?.value, "D:\\work\\lib");

  // ④ 仓库根：builder 产出 `[root](/)`（走绝对分支）。根路径剥尾斜杠会变空串、
  //    丢失身份，故 path/value 原样保留 `/`；markdown 侧仍是 `/`，往返恒等不破。
  const rootMarkdown = buildFileMentionMarkdown("", "root", "directory");
  assert.equal(rootMarkdown, "[root](/)", "仓库根的 markdown 就是 `/`");
  const rootSegments = parseMentionMarkdownRich(rootMarkdown);
  assertRoundTrip(rootMarkdown, rootSegments);
  const rootMention = mentionsOf(rootSegments)[0];
  assert.equal(rootMention?.data?.kind, "directory");
  assert.equal(rootMention?.data?.path, "/", "仓库根保留 `/` 身份（去斜杠为空会丢根）");
  assert.equal(rootMention?.value, "/");
});

test("T-PR1-5: 白名单外目的地一律不转（http/mailto/未知协议/协议相对 URL/裸相对路径）", () => {
  const input = [
    "[docs](https://example.com/a.ts)",
    "[mail](mailto:dev@example.com)",
    "[proto](foo:bar)",
    "[bare](src/a.ts)",
    "[anchor](#heading)",
  ].join(" ");

  const segments = parseMentionMarkdownRich(input);
  assertRoundTrip(input, segments);
  assert.equal(segments.length, 1, "白名单外链接必须整体留在正文，不产生 mention 段");
  assert.equal(segments[0]?.type, "text");

  // 协议相对 URL（`//host/x`）首字符也是 `/`：旧实现按前缀命中绝对路径白名单，
  // 把网络地址误还原成本地文件胶囊（composer/B-3）。它必须留在正文。
  const protocolRelative = "[proto](//cdn.example.com/x)";
  const protocolRelativeSegments = parseMentionMarkdownRich(protocolRelative);
  assertRoundTrip(protocolRelative, protocolRelativeSegments);
  assert.equal(protocolRelativeSegments.length, 1, "协议相对 URL 不得产生 mention 段");
  assert.equal(protocolRelativeSegments[0]?.type, "text");
  assert.equal(mentionsOf(protocolRelativeSegments).length, 0);
  // 对照组：真正的 POSIX 绝对路径仍必须还原（否则修复会把目录/文件引用一起打死）。
  const posixAbsolute = parseMentionMarkdownRich("[abs](/workspace/src/a.ts)");
  assert.equal(mentionsOf(posixAbsolute).length, 1, "单斜杠绝对路径仍在白名单内");
  assert.equal(mentionsOf(posixAbsolute)[0]?.value, "/workspace/src/a.ts");

  // plugin:// 但 stable id 非法：不造身份，保留正文。
  const invalidPlugin = "[@bad](plugin://not-a-stable-id)";
  const invalidSegments = parseMentionMarkdownRich(invalidPlugin);
  assertRoundTrip(invalidPlugin, invalidSegments);
  assert.equal(mentionsOf(invalidSegments).length, 0, "非法 stable id 不得还原成 plugin chip");
});

test("T-PR1-6: 代码块 fence 跳过（``` 与 ~~~，含未闭合 fence）", () => {
  const pluginLink = buildPluginMentionMarkdown("alpha", "alpha@market");
  const input = [
    "前面的正文",
    FENCE,
    "ts",
    pluginLink,
    FENCE,
    "中间 [x](./x.ts)",
    TILDE_FENCE,
    "md",
    pluginLink,
    TILDE_FENCE,
    "结尾",
  ].join("\n");

  const segments = parseMentionMarkdownRich(input);
  assertRoundTrip(input, segments);
  const mentions = mentionsOf(segments);
  assert.equal(mentions.length, 1, "fence 内的链接不得还原成 chip");
  assert.equal(mentions[0]?.category, "files", "fence 外的链接照常还原");
  assert.equal(mentions[0]?.value, "x.ts");

  // 未闭合 fence：其后内容全部视为代码正文，不解析。
  const unclosed = ["正文", FENCE, pluginLink, "still code"].join("\n");
  const unclosedSegments = parseMentionMarkdownRich(unclosed);
  assertRoundTrip(unclosed, unclosedSegments);
  assert.equal(mentionsOf(unclosedSegments).length, 0, "未闭合 fence 之后不得再解析链接");

  // 未闭合 fence 前的正文仍要解析。
  const headAndUnclosed = ["[y](./y.ts)", FENCE, pluginLink].join("\n");
  const headSegments = parseMentionMarkdownRich(headAndUnclosed);
  assertRoundTrip(headAndUnclosed, headSegments);
  assert.equal(mentionsOf(headSegments).length, 1);
  assert.equal(mentionsOf(headSegments)[0]?.value, "y.ts");
});

test("T-PR1-7: inline 裸 token 一律不转（用户拍板）", () => {
  const input = "@name $slug /cmd #sess_abc 都是手打文本";
  const segments = parseMentionMarkdownRich(input);
  assertRoundTrip(input, segments);
  assert.equal(segments.length, 1, "裸 token 不得产生 mention 段");
  assert.equal(segments[0]?.type === "text" ? segments[0].text : "", input);
});

test("T-PR1-8: 空输入与纯文本边界", () => {
  assert.deepEqual(parseMentionMarkdownRich(""), []);
  const plain = "只是一段普通正文，没有引用。";
  const segments = parseMentionMarkdownRich(plain);
  assertRoundTrip(plain, segments);
  assert.equal(segments.length, 1);
});

/** 段落内按序拼接、段间补 \n\n —— 编辑器 getMarkdown 与输入字节相同。 */
function joinParagraphs(paragraphs: readonly (readonly RichMentionSegment[])[]): string {
  return paragraphs
    .map((paragraph) =>
      paragraph
        .map((segment) => (segment.type === "text" ? segment.text : segment.markdown))
        .join(""),
    )
    .join("\n\n");
}

test("T-PR1-9: 段落装配——整篇先解析，fence 跨空行不被误转 chip（P2-1）", () => {
  const pluginLink = buildPluginMentionMarkdown("alpha", "alpha@market");
  // 代码块内含空行：旧实现先按 \n\n 切段再逐段解析，第二段的 fence 状态丢失，
  // 代码块（以及其后的真实正文）判定都会跑偏，fence 内的链接会被误转成 chip。
  const input = ["正文 [x](./x.ts)", FENCE, "ts", pluginLink, "", pluginLink, FENCE, "结尾"].join(
    "\n",
  );

  const paragraphs = splitRichMentionParagraphs(parseMentionMarkdownRich(input));
  assert.equal(joinParagraphs(paragraphs), input, "段落拼接必须与输入逐字节相同");
  assert.ok(paragraphs.length >= 2, "空行必须切出多个段落");

  const mentions = paragraphs
    .flat()
    .flatMap((segment) => (segment.type === "mention" ? [segment] : []));
  assert.deepEqual(
    mentions.map((mention) => mention.category),
    ["files"],
    "fence 内的链接一律不转，只有 fence 外的 canonical 链接还原成 chip",
  );

  // 对照组：旧口径（先切段再逐段解析）确实会把 fence 后半段的链接误转 chip，
  // 证明本用例对回归有区分力，不是恒真断言。
  const legacyMentions = input
    .split("\n\n")
    .flatMap((chunk) => parseMentionMarkdownRich(chunk))
    .flatMap((segment) => (segment.type === "mention" ? [segment] : []));
  assert.ok(
    legacyMentions.length > mentions.length,
    "旧口径必须复现误转 chip 的 bug（否则用例没有区分力）",
  );

  // 空输入仍然装配成一个空段落（与 replaceEditorText 的 split 结果一致）。
  assert.deepEqual(splitRichMentionParagraphs([]), [[]]);
});

test("T-PR1-10: skill chip 与 skills provider 同形，去重键 category+value 互认（B-6）", () => {
  const skillPath = "./skills/cr.md";
  const restored = mentionsOf(
    parseMentionMarkdownRich(buildSkillMentionMarkdown("code-review", skillPath)),
  )[0];
  assert.ok(restored, "恢复态 skill chip 必须还原");

  // provider 侧同一技能：path 与 markdown 里的不同，但 name 相同即同一技能（身份是 name）。
  const providerSkill = mapSkillsToMentionItemsForTest([
    {
      id: "skill-cr",
      name: "code-review",
      description: "代码评审",
      path: "/home/user/.omz/skills/cr.md",
      scope: "user",
    },
  ])[0];
  assert.ok(providerSkill, "provider 必须产出该技能");

  assert.equal(restored.value, "code-review", "① value 是技能名（provider `value: skill.name`）");
  assert.equal(restored.data?.path, skillPath, "② 路径落 data.path（markdown 目的地）");
  assert.equal(restored.label, providerSkill.label, "③ label 与 provider label 一致");

  // 去重键 = category + value：同一技能（name 相同、path 不同）必须互认为已存在，
  // 否则恢复态 chip 与同技能 provider/prefill chip 会重复插入。
  assert.equal(isMentionAlreadyPresent(providerSkill, restored), true);
  assert.equal(isMentionAlreadyPresent(restored, providerSkill), true);
  assert.equal(
    isMentionAlreadyPresent(providerSkill, { category: "skills", value: "code-review-pro" }),
    false,
    "不同技能不互认",
  );
  assert.equal(
    isMentionAlreadyPresent(providerSkill, { category: "files", value: "code-review" }),
    false,
    "同名但跨 category 不互认",
  );
  // 反向守卫：把技能路径当身份（修复前的 value 口径）时，同技能会互不相认 —— 这正是 B-6 的病因。
  assert.equal(
    isMentionAlreadyPresent(providerSkill, { category: "skills", value: skillPath }),
    false,
    "路径不能当技能身份",
  );

  // 恢复态推不出的两处必须显式留白（不是遗漏）：id 只能到 skill:<name>，data 没有 scope。
  assert.equal("scope" in (restored.data ?? {}), false, "markdown 推不出 scope，data 只保证 path");
});
