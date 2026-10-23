/**
 * composer 提交可用性与「撤回→发送」状态机的纯逻辑核心（composer/B-1 + composer/G-1）。
 *
 * 为什么必须集中到一处（B-1 根因）：
 * 队列撤回的恢复态只存在于 `composerDraft.promptContexts` 载体里，纯上下文队列项撤回后
 * `visibleContent === ""`，chip 不在任何 live hook 状态中。若「能不能发」「算不算有内容」
 * 「Enter 是否放行」仍只读 live hook，三个判定会同时为 false：
 *   - 发送键不亮、Enter 被判空（纯上下文项无法二次发送）；
 *   - `hasContent` 为 false 让 SessionPane 的队列编辑门禁放行，deleteQueueItem 已 ACK 后
 *     Composer 内部却判「有草稿」拒绝恢复 → 队列项已从 Host 删除却永不回来，编辑链卡死。
 * 因此三处判定统一消费 **merged 四类上下文**（restored 载体 + live hook，与发送序列化同源）。
 *
 * reducer（G-1）把 claim/rollback/finalize 写成显式状态迁移，便于行为测试：
 *   claim   → 冻结本次提交交出的 chip；
 *   succeed → 只移除冻结面，等待期用户新加的 chip 属于下一条消息；
 *   fail    → 把冻结面并回 live，四类 chip 全保留。
 */
import { countComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";

/** 四类上下文条目的最小结构：都带可选 id；无 id 的会话选区以 path+text 兜底。 */
export interface ComposerSubmitContextItem {
  id?: string;
  path?: string;
  text?: string;
}

export interface ComposerSubmitContexts {
  codeComments: readonly ComposerSubmitContextItem[];
  conversationSelections: readonly ComposerSubmitContextItem[];
  webElements: readonly ComposerSubmitContextItem[];
  pptxElements: readonly ComposerSubmitContextItem[];
}

export type ComposerSubmitContextKind =
  | "codeComments"
  | "conversationSelections"
  | "webElements"
  | "pptxElements";

const COMPOSER_SUBMIT_CONTEXT_KINDS: readonly ComposerSubmitContextKind[] = [
  "codeComments",
  "conversationSelections",
  "webElements",
  "pptxElements",
];

/**
 * 上下文条目身份键：有 id 用 id；无 id 的恢复态会话选区用「路径 + 正文」兜底。
 *
 * 与 `@/lib/conversationSelectionReference.js` 的 `conversationSelectionContextKey` 同义
 * （那边是选区专用入口、这里是四类通用入口）；测试用例把两者对齐，避免语义漂移。
 * 注意：绝不能给恢复项塞合成 id，否则 live/restored 永不相等，同一选区会出两枚 chip。
 */
export function resolveComposerSubmitContextKey(item: ComposerSubmitContextItem): string {
  if (typeof item.id === "string" && item.id.length > 0) return item.id;
  return `${item.path ?? ""}\u0000${item.text ?? ""}`;
}

export type ComposerSubmitPhase = "idle" | "claimed" | "failed";

export interface ComposerSubmitMachineState<
  C extends ComposerSubmitContexts = ComposerSubmitContexts,
> {
  phase: ComposerSubmitPhase;
  /** 本次提交冻结、已交给 Host 的 chip。 */
  frozenContexts: C;
  /** 当前 composer 里的 chip（含等待期用户新加的）。 */
  liveContexts: C;
}

export type ComposerSubmitMachineAction =
  | { type: "claim" }
  | { type: "succeed" }
  | { type: "fail" };

export interface ComposerSubmitAvailability {
  hasText: boolean;
  hasAttachments: boolean;
  /** merged 四类上下文总条数（与发送序列化同源）。 */
  contextCount: number;
  /**
   * 是否占用 composer：供 SessionPane 的队列编辑冲突门禁使用。
   * 含纯空白正文（用户确实写了东西，只是不可提交）。
   */
  hasContent: boolean;
  /** 是否可以发送：纯空白正文不算可提交内容。 */
  canSubmit: boolean;
  /** Enter 在空正文时是否放行：有附件或（含恢复态的）上下文即可。 */
  allowSubmitWhenEmpty: boolean;
}

function emptyComposerSubmitContexts(): ComposerSubmitContexts {
  return {
    codeComments: [],
    conversationSelections: [],
    webElements: [],
    pptxElements: [],
  };
}

function cloneComposerSubmitContexts<C extends ComposerSubmitContexts>(contexts: C): C {
  return Object.fromEntries(
    COMPOSER_SUBMIT_CONTEXT_KINDS.map((kind) => [kind, [...contexts[kind]]]),
  ) as unknown as C;
}

/** 从 live 中按 key 移除 frozen 面，保留等待期新增条目及其顺序。 */
function subtractComposerSubmitContexts<C extends ComposerSubmitContexts>(
  live: C,
  remove: C,
  keyOf: (item: ComposerSubmitContextItem) => string,
): C {
  return Object.fromEntries(
    COMPOSER_SUBMIT_CONTEXT_KINDS.map((kind) => {
      const removeKeys = new Set(remove[kind].map(keyOf));
      return [kind, live[kind].filter((item) => !removeKeys.has(keyOf(item)))];
    }),
  ) as unknown as C;
}

/** 把 frozen 面按冻结顺序并回 live：失败回滚不得让任何一类 chip 丢失。 */
function unionComposerSubmitContexts<C extends ComposerSubmitContexts>(
  live: C,
  frozen: C,
  keyOf: (item: ComposerSubmitContextItem) => string,
): C {
  return Object.fromEntries(
    COMPOSER_SUBMIT_CONTEXT_KINDS.map((kind) => {
      const liveKeys = new Set(live[kind].map(keyOf));
      return [kind, [...live[kind], ...frozen[kind].filter((item) => !liveKeys.has(keyOf(item)))]];
    }),
  ) as unknown as C;
}

export const composerSubmitMachine = {
  reduce<C extends ComposerSubmitContexts>(
    state: ComposerSubmitMachineState<C>,
    action: ComposerSubmitMachineAction,
    keyOf: (item: ComposerSubmitContextItem) => string = resolveComposerSubmitContextKey,
  ): ComposerSubmitMachineState<C> {
    switch (action.type) {
      case "claim":
        // 冻结 = claim 时刻的 live；冻结后双方各自独立演化（等待期的增删不污染提交面）。
        return {
          phase: "claimed",
          frozenContexts: cloneComposerSubmitContexts(state.liveContexts),
          liveContexts: cloneComposerSubmitContexts(state.liveContexts),
        };
      case "succeed":
        return {
          phase: "idle",
          frozenContexts: emptyComposerSubmitContexts() as C,
          liveContexts: subtractComposerSubmitContexts(
            state.liveContexts,
            state.frozenContexts,
            keyOf,
          ),
        };
      case "fail":
        return {
          phase: "failed",
          frozenContexts: state.frozenContexts,
          liveContexts: unionComposerSubmitContexts(
            state.liveContexts,
            state.frozenContexts,
            keyOf,
          ),
        };
    }
  },
};

/**
 * 三处可用性判定的唯一实现（B-1）：`hasDraftToSubmit` / `hasComposerDraftContent` /
 * `allowSubmitWhenEmpty` 都从它的同一份入参派生，`contexts` 必须是 merged 四类
 * （restored 载体 + live hook），不能只传 live。
 */
export function resolveComposerSubmitAvailability({
  text,
  attachments,
  contexts,
}: {
  text: string;
  attachments: readonly unknown[];
  contexts: ComposerSubmitContexts;
}): ComposerSubmitAvailability {
  const hasText = text.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const contextCount = countComposerPromptContexts(contexts);
  const hasContexts = contextCount > 0;
  return {
    hasText,
    hasAttachments,
    contextCount,
    hasContent: text.length > 0 || hasAttachments || hasContexts,
    canSubmit: hasText || hasAttachments || hasContexts,
    allowSubmitWhenEmpty: hasAttachments || hasContexts,
  };
}
