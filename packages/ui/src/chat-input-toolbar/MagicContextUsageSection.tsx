/**
 * FORK（D-13）：context 面板里的 magic-context 预算摘要段。
 *
 * ============================================================================
 * 为什么单独成文件
 * ============================================================================
 *
 * `contextUsage.tsx` 是上游 ZCode 的 context 气泡（Context windows / breakdown /
 * cache 命中 / trigger 都在里面），跟随上游升级时改动概率高；本段是 **fork 独有**的
 * （`git diff baseline/v3.14.3..HEAD` 里整段都是新增），夹在宿主里纯属冲突面。
 * 抽出来后宿主只剩：可选 prop、一条存在性判据、一次调用。
 *
 * 本文件拥有：`chat.contextUsage.magicContext.*` 的标签 id 表、`buildMagicContextUsageRows`
 * 的调用与 memo 化、以及这段两列布局的 JSX。
 *
 * ============================================================================
 * 不能丢的语义
 * ============================================================================
 *
 * 1. **「有就说」**：这一段不依赖 Context windows 的 `taskUsage`——provider 窗口还没
 *    建起来时它照样有话说，而那正是「为什么我的上下文被裁了」最需要被看见的时刻。
 *    唯一的渲染条件就是 `magicContext` 在场（见 `hasMagicContextUsage`）。
 * 2. **分隔线由宿主决定**：上方是否渲染了 Context windows / 额度段只有宿主知道，
 *    所以条件收敛成 `separated` 布尔透传，本组件不复制那套判据。
 * 3. class / `data-testid` / `aria-label` / `key` 与抽取前逐字一致，DOM 形状不变。
 * 4. 无 state / effect / ref（只有一次 props 派生的 `useMemo`）：宿主重挂载 / 出现消失
 *    都不会带来可观察的行为差异。
 *
 * 判据 `hasMagicContextUsage` 放在本文件而不是 `magicContextUsageRows.ts`：那边是
 * **零 React 依赖的纯投影模块**（要能被 node 直接 import dist 断言 rows），
 * 「整段要不要渲染」是渲染层的决定，不进投影模块。
 */
import { useMemo } from "react";
import { TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT } from "@zcode/shared";
import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

import { buildMagicContextUsageRows } from "@/chat-input-toolbar/magicContextUsageRows.js";

/** D-13：面板里的 magic-context 段是「有就说」，字段缺席时整段不渲染。 */
const MAGIC_CONTEXT_ROW_LABEL_IDS = {
  budget: "chat.contextUsage.magicContext.budget",
  cache: "chat.contextUsage.magicContext.cache",
  cacheHit: "chat.contextUsage.magicContext.cacheHit",
  cacheMiss: "chat.contextUsage.magicContext.cacheMiss",
  // 面板不呈现 `m[0]`/`m[1]` 这两个 SQLite 侧的名字（见 magicContextUsageRows.ts）。
  cacheSegment1: "chat.contextUsage.magicContext.cacheSegment1",
  cacheSegment2: "chat.contextUsage.magicContext.cacheSegment2",
  compartments: "chat.contextUsage.magicContext.compartments",
  dropped: "chat.contextUsage.magicContext.dropped",
  used: "chat.contextUsage.magicContext.used",
} as const;

/**
 * 「整段不渲染」判据，与 `buildMagicContextUsageRows(...).length === 0` 精确等价：
 * builder 只在 `magicContext` 缺席时返回 `[]`，非缺席恒返回 5 行（见
 * `magicContextUsageRows.ts`）。宿主用它做早退，避免为了判断有没有内容先把九条文案
 * 全部格式化一遍。
 */
export function hasMagicContextUsage(
  magicContext: SessionMagicContextUsage | null | undefined,
): boolean {
  return magicContext != null;
}

export function MagicContextUsageSection({
  intl,
  locale,
  magicContext,
  separated,
}: {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  magicContext: SessionMagicContextUsage | null | undefined;
  /** 上方已渲染出 Context windows / 额度段时补一条分隔线；条件由宿主决定。 */
  separated: boolean;
}) {
  // hook 不能条件调用：先无条件算 rows（缺席时 builder 返回 `[]`），再决定是否渲染。
  const magicContextRows = useMemo(
    () =>
      buildMagicContextUsageRows({
        labels: {
          budget: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.budget }),
          cache: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.cache }),
          cacheHit: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.cacheHit }),
          cacheMiss: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.cacheMiss }),
          cacheSegment1: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.cacheSegment1 }),
          cacheSegment2: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.cacheSegment2 }),
          compartments: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.compartments }),
          dropped: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.dropped }),
          used: intl.formatMessage({ id: MAGIC_CONTEXT_ROW_LABEL_IDS.used }),
        },
        locale,
        magicContext,
      }),
    [intl, locale, magicContext],
  );

  if (magicContextRows.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={intl.formatMessage({ id: "chat.contextUsage.magicContext.title" })}
      className={cn("space-y-1.5", separated && "border-t border-border pt-3")}
      data-testid={TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT}
    >
      <div className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage({ id: "chat.contextUsage.magicContext.title" })}
      </div>
      {magicContextRows.map((row) => (
        <div className="flex min-w-0 items-center gap-2 text-ui-sm" key={row.id}>
          <span className="min-w-0 truncate text-foreground-subtle">{row.label}</span>
          <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}
