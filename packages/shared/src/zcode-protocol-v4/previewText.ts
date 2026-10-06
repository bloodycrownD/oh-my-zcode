// 摘要口径（220 字符 / 2 段落）的**唯一**实现。
//
// 出身：renderer 侧 `conversationTurnNavigatorHelpers.ts` 的 `buildPreviewText` /
// `normalizePreviewParagraphs` / truncatePreview 三件套。turn 目录窄投影
// （`v4/conversation/turnDirectory`）要在服务端复用同一口径出 `queryPreview` /
// `assistantPreview`，口径两处实现必然漂移，故下沉到协议包，renderer 改引入。
// sessions-index 的 120 字符口径属另一产品面，不在此合并。
//
// B-4（流式折叠 + 计数）：旧实现一次性处理整串——
//   join("\n\n") → trim → split(/\n\s*\n/u) → 段内 replace(/\s+/gu," ")+trim
//   → filter(Boolean) → slice(0,段上限) → join("\n") → slice + 补点
// 一条长度 L 的长回复会被整体扫进若干个新串，长会话里 rail 每次重建 items 都付这笔账。
// 新实现逐 UTF-16 码元消费，累计输出到预算即停；因为折叠是前缀单调运算
// （任一前缀的折叠结果 = 整串折叠结果的对应前缀），对任意输入（maxChars 为有限非负整数时）
// 与旧实现**逐字节一致**（T-TD1 用四类边界语料 + maxChars 扫描钉住）。
//
// 逐字节等价依赖两个容易踩空的事实：
//   1) `/\s+/gu` 的空白集合 == `String.prototype.trim` 的空白集合
//      （WhiteSpace ∪ LineTerminator）。故「先 replace 再 trim」严格等价于
//      「跳过段首/段尾空白串 + 段内连续空白折叠为单空格」。
//   2) `/\n\s*\n/u` 的切分点恰是「含 ≥2 个换行的极大空白串」——`\s` 含 `\n`，
//      贪婪匹配后回溯到该串最后一个换行，整串被吞掉；只含 1 个换行的空白串
//      不切分，那个换行被折叠成普通空格。`filter(Boolean)` 再把空段丢掉，
//      所以整串首尾的 `trim()` 与「段内 trim」可合并成一处，不必单独处理末尾。

/** rail 摘要的字符预算（桌面 rail 一行放不下的就截断加省略号）。 */
export const DEFAULT_MAX_PREVIEW_CHARS = 220;
/** rail 摘要最多保留几个自然段；再多的段落不进目录（目录是导航面不是阅读面）。 */
export const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

/** truncatePreview 的下界：调用方把 maxChars 写成 0/负数时也不至于切出负长度。 */
export const PREVIEW_MIN_MAX_CHARS = 8;
const PREVIEW_TRUNCATION_SUFFIX = "...";
const PREVIEW_NEWLINE_CODE = 0x0a;

export interface BuildPreviewTextParams {
  texts: readonly string[];
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}

/**
 * 诊断/测试钩子：`scannedChars` 是本次实际消费的输入码元数（不是输入总长）。
 * 扫描量以遇到第一个非空白码元或 emit 预算用尽为界；含长空白串的输入扫描量
 * 可达输入全长——逐字节等价的必要代价。
 */
export interface PreviewTextBuildResult {
  text: string;
  scannedChars: number;
}

/**
 * JS 的 `\s` / `String.prototype.trim` 空白集合（WhiteSpace ∪ LineTerminator）。
 * 逐码元判定而非逐字符跑正则：长文本上这是热点。
 */
function isPreviewWhitespaceCode(code: number): boolean {
  if (code < 0x80) {
    // ASCII：空格 + \t \n \v \f \r
    return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  }
  return (
    code === 0xa0 || // NO-BREAK SPACE
    code === 0x1680 || // OGHAM SPACE MARK
    (code >= 0x2000 && code <= 0x200a) || // EN QUAD..HAIR SPACE
    code === 0x2028 || // LINE SEPARATOR
    code === 0x2029 || // PARAGRAPH SEPARATOR
    code === 0x202f || // NARROW NO-BREAK SPACE
    code === 0x205f || // MEDIUM MATHEMATICAL SPACE
    code === 0x3000 || // IDEOGRAPHIC SPACE
    code === 0xfeff // ZERO WIDTH NO-BREAK SPACE（BOM）
  );
}

/**
 * 流式折叠。`out` 是 `paragraphs.slice(0, 段上限).join("\n")` 的一个**前缀**，
 * 长度封顶 `maxChars + 1`（多出的那一位用来分辨「恰好等于上限」与「超过上限」，
 * 也就是旧 truncatePreview 的长度分支）。
 *
 * 扫描量以遇到第一个非空白码元或 emit 预算用尽为界；含长空白串的输入扫描量
 * 可达输入全长——逐字节等价的必要代价。只要输出超过预算，扫描就随之停止。
 */
function buildPreviewTextStreaming(params: BuildPreviewTextParams): PreviewTextBuildResult {
  const cap = Math.max(PREVIEW_MIN_MAX_CHARS, params.maxPreviewChars);
  const maxParagraphs = Math.max(1, params.maxPreviewParagraphs);
  const emitBudget = cap + 1;

  const out: string[] = [];
  let emitted = 0;
  let scannedChars = 0;
  /** 已定稿的非空段数（空段被 `filter(Boolean)` 丢掉，不计数）。 */
  let paragraphs = 0;
  let paragraphHasText = false;
  /** 正处在一个极大空白串里（含 texts 之间 join 的 "\n\n" 记账）。 */
  let inBlankRun = false;
  /** 该极大空白串里已数到的换行数：≥2 即空行分隔符（等价 split(/\n\s*\n/u) 的切点）。 */
  let blankRunNewlines = 0;

  const push = (unit: string): boolean => {
    if (emitted >= emitBudget) return false;
    out.push(unit);
    emitted += unit.length;
    return emitted < emitBudget;
  };
  const closeParagraph = (): void => {
    if (paragraphHasText) {
      paragraphs += 1;
      paragraphHasText = false;
    }
  };
  /** 段数已取满：slice(0, 段上限) 之外的内容整段丢弃，可以就地收工。 */
  const paragraphBudgetSpent = (): boolean => paragraphs >= maxParagraphs;

  const texts = params.texts;
  scan: for (let t = 0; t < texts.length; t += 1) {
    const text = texts[t] ?? "";
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      scannedChars += 1;

      if (isPreviewWhitespaceCode(code)) {
        if (!inBlankRun) {
          inBlankRun = true;
          blankRunNewlines = code === PREVIEW_NEWLINE_CODE ? 1 : 0;
        } else if (blankRunNewlines < 2 && code === PREVIEW_NEWLINE_CODE) {
          blankRunNewlines += 1;
          if (blankRunNewlines >= 2) {
            // 该极大空白串就是空行分隔符（整串丢弃，当前段到此为止）。
            closeParagraph();
            if (paragraphBudgetSpent()) break scan;
          }
        }
        continue;
      }

      // 极大空白串结束。三种收尾互斥，且都等价旧管线：
      //   段首（含段首空白串的 trim、被分隔符丢掉的空段）→ 只补 join 的 "\n"；
      //   段内空白串（<2 个换行）→ 折叠成一个空格；
      //   段内分隔符 → closeParagraph 已把段收掉，这里落到段首分支。
      const wasBlankRun = inBlankRun;
      const wasDelimiter = blankRunNewlines >= 2;
      inBlankRun = false;
      blankRunNewlines = 0;

      if (!paragraphHasText) {
        // 空段被 filter(Boolean) 丢掉后不留分隔符——所以 "\n" 必须等到下一段
        // 真的产出首个字符时才发，否则会多出一个尾随换行。
        if (paragraphs > 0 && !push("\n")) break scan;
      } else if (wasBlankRun && !wasDelimiter && !push(" ")) {
        break scan;
      }
      if (!push(text[i] ?? "")) break scan;
      paragraphHasText = true;
    }

    // texts 之间恒插入 "\n\n"：它自己就带两个换行，故必然是分隔符；
    // 两侧若还有空白也只会并进同一个极大空白串（这里以 inBlankRun 记账）。
    if (t < texts.length - 1) {
      inBlankRun = true;
      blankRunNewlines = 1;
      closeParagraph();
      if (paragraphBudgetSpent()) break scan;
    }
  }

  if (paragraphs + (paragraphHasText ? 1 : 0) === 0) {
    return { text: params.fallback, scannedChars };
  }
  const streamed = out.join("");
  // 未被预算截断时 `streamed` 就是全量串（长度 ≤ cap）；被截断时它比上限多一位，
  // slice 出的前缀与旧实现同一表达式。
  if (streamed.length <= cap) {
    return { text: streamed, scannedChars };
  }
  const head = streamed.slice(0, cap - PREVIEW_TRUNCATION_SUFFIX.length).trimEnd();
  return { text: `${head}${PREVIEW_TRUNCATION_SUFFIX}`, scannedChars };
}

/**
 * 摘要文本：把 `texts` 拼成的正文折叠成最多 `maxPreviewParagraphs` 段、
 * 每段内连续空白折叠为单空格、整体截到 `maxPreviewChars`（超出补 "..."）。
 * 正文为空（纯空白/空数组）时回落 `fallback`。
 */
export function buildPreviewText(params: BuildPreviewTextParams): string {
  return buildPreviewTextStreaming(params).text;
}

/** 同 `buildPreviewText`，但额外回报实际扫描量（诊断与 T-TD1 的有界性断言用）。 */
export function buildPreviewTextWithStats(params: BuildPreviewTextParams): PreviewTextBuildResult {
  return buildPreviewTextStreaming(params);
}
