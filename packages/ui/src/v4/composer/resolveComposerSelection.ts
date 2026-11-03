// Composer 的「当前有效模型选择」纯函数：只派生展示/提交使用的 resolvedSelection，
// 不修改 draft（用户原意图）。这样失效修复不依赖 firstSnapshot 的一次性渲染状态：
// View 迟到 ready、revision 更新、会话口径变化都会在下一次 render 重新解析。
import { completeNewModelSelection } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { isSelectionInView, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";

export type ComposerSelectionSource =
  | "draft"
  | "reasoning-completed"
  | "session"
  | "preferred"
  | "unresolved";

export interface ComposerSelectionResolution {
  /** 展示与提交使用的完整选择；unresolved 时没有可用选择，提交门禁应保持关闭。 */
  readonly selection?: ModelSelection;
  /** 结果来源，仅用于诊断与回归断言。 */
  readonly source: ComposerSelectionSource;
}

export interface ResolveComposerSelectionInput {
  /** 目标 Host 的模型 View；null 表示尚未 ready（不能判定失效）。 */
  readonly view: ModelSelectionView | null;
  /** 草稿里保存的用户原意图（文字草稿/用户显式选择/已接纳选择）。 */
  readonly draftSelection?: ModelSelection;
  /** 当前 Session Snapshot 的模型选择；Root 草稿没有。 */
  readonly sessionSelection?: ModelSelection;
}

function resolvePreferredSelection(
  view: ModelSelectionView,
): { selection: ModelSelection; source: "preferred" } | null {
  const selection = resolveDraftInitialModelSelection(view, null).selection;
  return selection ? { selection, source: "preferred" } : null;
}

function resolveSessionSelection(
  view: ModelSelectionView,
  sessionSelection: ModelSelection | undefined,
): { selection: ModelSelection; source: "session" } | null {
  return sessionSelection && isSelectionInView(view, sessionSelection)
    ? { selection: sessionSelection, source: "session" }
    : null;
}

/**
 * 解析顺序（需求见 docs/ui/composer-text-draft-persistence.md）：
 * 1. 没有 View（loading/失败/远端等待）：保留草稿原意图，Session 无草稿时用 Snapshot。
 * 2. 草稿选择有效：用 View 的 effectiveSelection（历史档位可能被解析成当前值）。
 * 3. 仅档位失效：用 completeNewModelSelection 补同一 provider/model 的最高有效档。
 * 4. 模型硬失效（provider/model-not-found）：Session 有效选择 → View preferredSelection。
 * 5. 没有草稿选择：Session 有效选择 → View preferredSelection。
 * 任何分支都不写 draft；调用方只在用户动作或 accepted 回执时持久化。
 */
export function resolveComposerSelection(
  input: ResolveComposerSelectionInput,
): ComposerSelectionResolution {
  const { view, draftSelection, sessionSelection } = input;
  if (!view) {
    if (draftSelection) return { selection: draftSelection, source: "draft" };
    return sessionSelection
      ? { selection: sessionSelection, source: "session" }
      : { source: "unresolved" };
  }
  if (draftSelection) {
    const hardInvalid =
      view.selectionIssue === "provider-not-found" || view.selectionIssue === "model-not-found";
    if (!hardInvalid) {
      const reasoningInvalid =
        view.selectionIssue === "reasoning-level-missing" ||
        view.selectionIssue === "reasoning-level-not-supported";
      if (reasoningInvalid) {
        const completed = completeNewModelSelection(view, draftSelection);
        if (completed) return { selection: completed, source: "reasoning-completed" };
      }
      // 有效选择原样保留；fallback 只覆盖调用方没把 selection 传给 View 的情况。
      return view.effectiveSelection
        ? { selection: view.effectiveSelection, source: "draft" }
        : { selection: draftSelection, source: "draft" };
    }
  }
  const fallback =
    resolveSessionSelection(view, sessionSelection) ?? resolvePreferredSelection(view);
  return fallback ?? { source: "unresolved" };
}
