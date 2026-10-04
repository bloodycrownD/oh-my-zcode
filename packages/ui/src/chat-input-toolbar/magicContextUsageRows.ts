/**
 * FORK（Step 30 / D-13）——magic-context 预算摘要 → ChatContextUsage 面板的几行。
 *
 * ============================================================================
 * 为什么单独成文件
 * ============================================================================
 *
 * 与 Step 29 的 `settings/magicContextSettingsForm.ts` 同一条纪律，只是这次的理由是
 * **可断言性**：
 *
 *   1. 这一段的**缺席语义**（`usage.magicContext` 不在 → 整段不渲染）是 T-U2 的核心
 *      判据。把它和 1000 行的 quota-reset 弹层状态机放在一个 `.tsx` 里，自动化就只能
 *      靠截图或 e2e 断言「那里有字」；抽成纯函数后，node 直接 import dist 产物就能
 *      断言「字段缺席 ⇒ 空数组 ⇒ 整段不渲染」，不必起浏览器。
 *   2. **零 React 依赖**：本文件只 import `@zcode/shared` 与一个相对路径的
 *      `tokenNumberFormat`，**不用 `@/` 别名**——别名只有 UI 打包器解析得了，而这个
 *      模块要能被 node 直接 import（见上）。
 *   3. 组件仍然只做「把 rows 画成两列」这一件事，排版规则的改动不会散进状态机。
 */

import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";
import { formatCompactTokenNumber } from "../lib/tokenNumberFormat.js";

/** 面板里的一行：`label` 左对齐、`value` 右对齐等宽。 */
export interface MagicContextUsageRow {
  id: string;
  label: string;
  value: string;
}

/** 未知值统一用破折号；`0` 与「不知道」在面板上是两件事，绝不混。 */
const UNKNOWN = "—";

export interface MagicContextUsageRowInput {
  /** 已解析的 `chat.contextUsage.magicContext.*` 文案（组件注入，模块本身不引 i18n）。 */
  labels: {
    budget: string;
    cache: string;
    cacheHit: string;
    cacheMiss: string;
    compartments: string;
    dropped: string;
    used: string;
  };
  locale: string;
  /** 缺席 = magic-context 关着 / 宿主还没读到读数 ⇒ 返回 `[]` ⇒ 整段不渲染。 */
  magicContext: SessionMagicContextUsage | null | undefined;
}

/**
 * 把一份预算摘要摊成面板里的几行。
 *
 * 三条不能省的语义：
 *   - **protected floor 是「保底额度」，不是上限。** 所以它只报自己，绝不与
 *     `usedTokens` 拼成 `used/total`——那会凭空造出一把不存在的尺子。
 *   - **`cache: null` 是「这一列在当前库里读不到」（迁移前），不是「都没命中」。**
 *   - `usedPercent` 是 0–100 的数字，格式化前先除 100（`Intl` 的 percent 风格按分数算）。
 */
export function buildMagicContextUsageRows({
  labels,
  locale,
  magicContext,
}: MagicContextUsageRowInput): MagicContextUsageRow[] {
  if (!magicContext) {
    return [];
  }
  const numberFormatter = new Intl.NumberFormat(locale);
  const percentageFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  });
  const formatTokens = (value: number) =>
    formatCompactTokenNumber(locale, value, { maximumFractionDigits: 1 });
  const cache = magicContext.cache;

  return [
    {
      id: "budget",
      label: labels.budget,
      value: magicContext.budgetTokens === null ? UNKNOWN : formatTokens(magicContext.budgetTokens),
    },
    {
      id: "used",
      label: labels.used,
      value: `${formatTokens(magicContext.usedTokens)} (${percentageFormatter.format(
        magicContext.usedPercent / 100,
      )})`,
    },
    {
      id: "compartments",
      label: labels.compartments,
      value: numberFormatter.format(magicContext.compartmentCount),
    },
    {
      id: "dropped",
      label: labels.dropped,
      value: `${numberFormatter.format(magicContext.droppedTagCount)} (${formatTokens(
        magicContext.droppedTagTokens,
      )})`,
    },
    {
      id: "cache",
      label: labels.cache,
      value:
        cache === null
          ? UNKNOWN
          : `m[0] ${cache.m0 ? labels.cacheHit : labels.cacheMiss} · m[1] ${
              cache.m1 ? labels.cacheHit : labels.cacheMiss
            }`,
    },
  ];
}
