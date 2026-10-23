import type {
  V4ComposerDraft,
  V4ComposerDraftContentUpdate,
} from "@/v4/composer/composerDraftStore.js";

export interface ScopedDraftContentUpdateParams {
  /** 调用点所属 scope（composer 闭包捕获的 session/draft scope key）。 */
  scopeKey: string;
  /** 当前已加载的 scope（store 的 stateRef 事实，不是渲染期镜像）。 */
  currentScopeKey: string;
  /** 当前草稿事实源（store 的 stateRef）；函数形态 updater 必须基于它执行。 */
  draft: V4ComposerDraft;
  update: V4ComposerDraftContentUpdate;
}

export interface ScopedDraftContentUpdateResult {
  draft: V4ComposerDraft;
  /** true = 调用点属于旧 scope，整条更新丢弃（不得拿旧闭包写新 scope 草稿）。 */
  dropped: boolean;
}

/**
 * 带 scope guard 的草稿内容更新（composer/B-2）。
 *
 * 旧实现先写组件内 `restoredPromptContextsRef` 再调 `updateComposerContent`，而后者被
 * `updateComposerDraft` 的 scope guard 静默丢弃 → ref 与草稿分叉；随后在新 scope 增删 chip
 * 时会以旧 scope 载体为基底写进新 scope 草稿。根修把「scope 判定 → updater 执行 → 合并」
 * 收成一个纯函数：判定失败返回原草稿且 `dropped === true`，调用方不得再做任何本地镜像。
 *
 * 函数形态 updater 与值形态共用同一条合并语义：只有真正写入正文时才清编辑器结构，
 * 只写上下文载体不能顺手清掉 mention/editorStateJson。
 */
export function applyScopedDraftContentUpdate({
  scopeKey,
  currentScopeKey,
  draft,
  update,
}: ScopedDraftContentUpdateParams): ScopedDraftContentUpdateResult {
  if (scopeKey !== currentScopeKey) {
    return { draft, dropped: true };
  }
  const patch = typeof update === "function" ? update(draft) : update;
  return {
    draft: {
      ...draft,
      ...(patch.text !== undefined ? { editorStateJson: undefined, mention: undefined } : {}),
      ...patch,
    },
    dropped: false,
  };
}
