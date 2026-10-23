import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  resolveComposerScope,
  readComposerWorkspaceScope,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/** 在激活首次导入的 Session 前调用；不依赖模型可执行，也不把原新任务正文带入分享。 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
  /** omz 分享入口无 namespace 注入面；desktop 默认值与 composerScopeKey 序列化对齐。 */
  clientNamespace?: string;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  // 项目草稿按组织归属分 key；未登记 scope 的旧目录回落无项目身份，与上游 readComposerWorkspaceScope 一致。
  const scope =
    readComposerWorkspaceScope(
      workspacePath,
      workspaceIdentity,
      result.clientNamespace ?? "desktop",
    ) ?? resolveComposerScope(null, workspaceIdentity, result.clientNamespace ?? "desktop");
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  // 导入已创建真实 Session，旧初始化把空 snapshot 当成确定选择，跳过了新任务规则。
  // 显式标记首次导入来源，而非按“会话没模型”猜测；Root 的明确空选择也必须保留。
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
