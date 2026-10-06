// T-TD1：摘要工具（`@zcode/shared` 的 `previewText.ts`）与它下沉重身前的 renderer
// 实现**逐字节一致**，且流式实现的扫描量被 `maxChars` 卡住（B-4 买到的新性质）。
//
// 放 test/ 而不是 src/：src 会被 tsc emit 进 dist，测试是纯消费方不进产物
// （先例见同目录 apply.test.ts）。只用相对路径导入（不用 `@/` 别名），
// `npx tsx --test` 可直接跑。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreviewText,
  buildPreviewTextWithStats,
  DEFAULT_MAX_PREVIEW_CHARS,
  DEFAULT_MAX_PREVIEW_PARAGRAPHS,
} from "../src/zcode-protocol-v4/previewText.js";

// ── 参照实现：下沉重身前的 renderer 原件，逐字照抄（conversationTurnNavigatorHelpers.ts
// 旧 :118-154）。它是等价性的唯一判据，改它等于改题目。
function legacyNormalizePreviewParagraphs(text: string, maxParagraphs: number): string[] {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
}

function legacyTruncatePreview(text: string, maxChars: number): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function legacyBuildPreviewText({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: {
  texts: readonly string[];
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}): string {
  const paragraphs = legacyNormalizePreviewParagraphs(texts.join("\n\n"), maxPreviewParagraphs);
  if (paragraphs.length === 0) {
    return fallback;
  }
  return legacyTruncatePreview(paragraphs.join("\n"), maxPreviewChars);
}

const FALLBACK = "（无内容）";
const LIMITS = { fallback: FALLBACK, maxPreviewChars: 24, maxPreviewParagraphs: 2 };

interface PreviewCase {
  name: string;
  texts: readonly string[];
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

/** 四类固定边界语料（外加 maxChars / 段数扫描），逐条与参照实现对拍。 */
const BOUNDARY_CASES: readonly PreviewCase[] = [
  {
    name: "超长空白前缀段：段首空白串远长于预算，且尾部仍超限",
    texts: [
      `${" ".repeat(4_096)}\t${" ".repeat(2_048)}　${"回答".repeat(64)}`,
      `${"\n".repeat(9)}${"答".repeat(80)}`,
    ],
  },
  {
    name: "段间多空白：空行分隔符的各种宽度（含单换行不切分）",
    texts: [
      `第一段${" ".repeat(3)}\n 换行不切分 `,
      `\n\n\n`,
      ` \n \n `,
      `\t\t\n\t\n`,
      `第二段${"\n".repeat(6)}`,
      `第三段不该出现`,
    ],
  },
  {
    name: "截断边界落在空白串内：长空白串正中央放截断点",
    texts: [`${"答".repeat(18)}${" ".repeat(120)}${"尾".repeat(40)}`],
  },
  {
    name: "纯空白输入：空串、全空白、单换行、全角空白全部回落 fallback",
    texts: ["", "   \t\n", "\n\n\n", " 　  ﻿", "\v\f\r"],
  },
  {
    name: "单换行不切分：折叠成一个空格而非分段",
    texts: [`行一\n行二\n行三\n\n行四`],
  },
  {
    name: "段上限为 0 / 负数：与 Math.max(1, n) 同语义",
    texts: [`甲\n\n乙\n\n丙`],
    maxPreviewParagraphs: 0,
  },
  {
    name: "段上限放大：截断点落在第三段之内",
    texts: [`甲段正文\n\n乙段正文\n\n丙段正文\n\n丁段正文`],
    maxPreviewParagraphs: 3,
    maxPreviewChars: 40,
  },
  {
    name: "空数组：与空串同语义",
    texts: [],
  },
];

for (const testCase of BOUNDARY_CASES) {
  test(`T-TD1 逐字节一致：${testCase.name}`, () => {
    const maxPreviewChars = testCase.maxPreviewChars ?? LIMITS.maxPreviewChars;
    const maxPreviewParagraphs = testCase.maxPreviewParagraphs ?? LIMITS.maxPreviewParagraphs;
    const params = {
      texts: testCase.texts,
      fallback: LIMITS.fallback,
      maxPreviewChars,
      maxPreviewParagraphs,
    };
    assert.equal(buildPreviewText(params), legacyBuildPreviewText(params));
  });
}

test("T-TD1 逐字节一致：maxChars 扫描（截断点遍历段内/空白串/换行等位置）", () => {
  const corpora: readonly string[][] = [
    [`${"答".repeat(18)}${" ".repeat(40)}${"尾".repeat(20)}`],
    ["甲  乙\n丙\n\n丁", "戊\n\n\n己"],
    ["", " \n\n ", "庚" + " ".repeat(30)],
    [`${"字".repeat(60)}\n\n${"空".repeat(60)}`],
  ];
  for (const texts of corpora) {
    for (let maxPreviewChars = 8; maxPreviewChars <= 72; maxPreviewChars += 1) {
      for (const maxPreviewParagraphs of [1, 2, 5]) {
        const params = { texts, fallback: LIMITS.fallback, maxPreviewChars, maxPreviewParagraphs };
        assert.equal(
          buildPreviewText(params),
          legacyBuildPreviewText(params),
          `texts=${JSON.stringify(texts)} maxPreviewChars=${maxPreviewChars} maxPreviewParagraphs=${maxPreviewParagraphs}`,
        );
      }
    }
  }
});

test("T-TD1 逐字节一致：确定性混合语料（空白/换行/多字节字符随机交织）", () => {
  // 固定种子的 LCG：既覆盖真实组合爆炸，又不引入随机失败。
  let seed = 0x2f6e2b1;
  const nextInt = (bound: number): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed % bound;
  };
  const pieces = ["a", "b", "中", "🙂", " ", "  ", "\t", "\n", "\n\n", "\n \n", "　", " ", "﻿"];
  for (let round = 0; round < 400; round += 1) {
    const textCount = 1 + nextInt(3);
    const texts: string[] = [];
    for (let i = 0; i < textCount; i += 1) {
      let text = "";
      const pieceCount = nextInt(24);
      for (let p = 0; p < pieceCount; p += 1) {
        text += pieces[nextInt(pieces.length)] ?? "a";
      }
      texts.push(text);
    }
    const maxPreviewChars = 8 + nextInt(60);
    const maxPreviewParagraphs = 1 + nextInt(3);
    const params = { texts, fallback: LIMITS.fallback, maxPreviewChars, maxPreviewParagraphs };
    assert.equal(buildPreviewText(params), legacyBuildPreviewText(params), `round=${round}`);
  }
});

test("T-TD1 扫描量有界：1 MiB 输入只扫 maxChars 的常数倍", () => {
  const paragraph = `${"回答正文片段 with mixed ascii 与中文 标点。".repeat(20)}`;
  const oneMiB = paragraph.repeat(Math.ceil((1024 * 1024) / (paragraph.length + 2)));
  const texts = oneMiB.split("\n\n");
  const maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS;

  const stats = buildPreviewTextWithStats({
    texts,
    fallback: LIMITS.fallback,
    maxPreviewChars,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });

  assert.equal(
    stats.text,
    legacyBuildPreviewText({
      texts,
      fallback: LIMITS.fallback,
      maxPreviewChars,
      maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
    }),
  );
  assert.ok(stats.text.endsWith("..."), "超长输入必须走截断分支");
  // 无长空白串语料：折叠是前缀单调的，输出封顶 maxChars+1，扫描量随之封顶。
  assert.ok(
    stats.scannedChars <= maxPreviewChars * 2 + 64,
    `scannedChars=${stats.scannedChars} 应远小于 1MiB`,
  );
  assert.ok(stats.scannedChars < 1_024, `scannedChars=${stats.scannedChars} 与输入长度脱钩`);
  // 含长空白串语料：扫描量以遇到第一个非空白码元为界，可达输入全长。
  const longBlank = " ".repeat(512 * 1024);
  const longBlankInput = `${longBlank}${"x".repeat(64)}`;
  const longBlankStats = buildPreviewTextWithStats({
    texts: [longBlankInput],
    fallback: LIMITS.fallback,
    maxPreviewChars,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });
  assert.ok(
    longBlankStats.scannedChars <= longBlankInput.length,
    `scannedChars=${longBlankStats.scannedChars} 不应超过输入长度`,
  );
});

test("T-TD1 扫描量有界：单条超长无空行正文在首段就收工", () => {
  const texts = ["x".repeat(512 * 1024)];
  const stats = buildPreviewTextWithStats({
    texts,
    fallback: LIMITS.fallback,
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });
  assert.ok(stats.scannedChars <= DEFAULT_MAX_PREVIEW_CHARS + 8);
});

test("T-TD1 纯空白输入：全量扫完（判定 fallback 的必要代价）但不产出正文", () => {
  const stats = buildPreviewTextWithStats({
    texts: [" ".repeat(4_096), "\n\n", "　\t"],
    fallback: LIMITS.fallback,
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  });
  assert.equal(stats.text, LIMITS.fallback);
});
