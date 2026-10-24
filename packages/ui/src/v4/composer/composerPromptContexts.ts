import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import {
  buildPromptWithPptxElementReferences,
  parsePromptPptxElementReferences,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";

/**
 * 四类上下文 chip 的纯数据快照（与 parseComposerPromptContexts 的产出同形）。
 * 队列撤回的恢复态以它为载体随 composer 草稿持久化：切 scope/刷新回来由草稿重建 chip，
 * 否则重发会静默丢掉 code comments/选区/web/pptx 四类尾块。
 */
export interface ComposerPromptContexts {
  codeComments: readonly CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: readonly WebElementContextComposerAttachment[];
  pptxElements: readonly PptxElementReference[];
}

export function countComposerPromptContexts(contexts: {
  codeComments: readonly unknown[];
  conversationSelections: readonly unknown[];
  webElements: readonly unknown[];
  pptxElements: readonly unknown[];
}) {
  return (
    contexts.codeComments.length +
    contexts.conversationSelections.length +
    contexts.webElements.length +
    contexts.pptxElements.length
  );
}

/**
 * 撤回 chip（restored，随 composerDraft.promptContexts 载体）与 live hook 状态的合并。
 *
 * 参数顺序固定为 **restored 在前、live 在后**：同 key 时 live 覆盖 restored——live 是用户
 * 刚加/正在操作的最新事实，restored 只是撤回快照。倒序会让恢复态反向覆盖用户输入。
 *
 * `contentKeyOf` 为**跨来源内容指纹**（可选）：身份键只有 live 侧才稳定（恢复项丢了 id），
 * 只按身份键判重时「撤回后再选同一段」会同时出恢复项与 live 项两枚 chip。给了内容键，
 * 恢复项只要与任一 live 项内容相同就不再出现。
 */
export function mergeContextList<T>(
  restored: readonly T[],
  live: readonly T[],
  keyOf: (item: T) => string,
  contentKeyOf?: (item: T) => string,
): readonly T[] {
  if (restored.length === 0) return live;
  if (live.length === 0) return restored;
  const liveKeys = new Set(live.map(keyOf));
  const liveContentKeys = contentKeyOf ? new Set(live.map(contentKeyOf)) : null;
  const isDuplicate = (item: T): boolean => {
    if (liveKeys.has(keyOf(item))) return true;
    if (!liveContentKeys || !contentKeyOf) return false;
    return liveContentKeys.has(contentKeyOf(item));
  };
  return [...restored.filter((item) => !isDuplicate(item)), ...live];
}

/**
 * 队列项 → 预览正文 + 上下文条数。
 *
 * `item.text` 是发送时序列化过的完整 prompt（可见正文 + 四类上下文尾块）；队列行必须与
 * 气泡/编辑态同口径先剥离尾块再渲染，否则用户会在预览里看到 `# Code comments:` 等内部块，
 * 纯上下文队列项更是只剩块。解析失败/无尾块时原样返回正文。
 */
export function resolveQueuePreview(
  item: { text: string },
  workspace: { workspacePath: string; workspaceIdentity?: string },
): { previewText: string; contextCount: number } {
  const parsed = parseComposerPromptContexts(item.text, workspace);
  return {
    previewText: parsed.visibleContent,
    contextCount: countComposerPromptContexts(parsed),
  };
}

/**
 * 四类 context parser 都只识别 prompt 尾块，因此序列化顺序和解析顺序必须严格相反。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: ComposerPromptContexts,
): string {
  const withSelections = buildPromptWithConversationSelections(
    text,
    contexts.conversationSelections,
  );
  const withCodeComments = buildPromptWithCodeComments(withSelections, contexts.codeComments);
  const withWebElements = buildPromptWithWebElementContexts(withCodeComments, contexts.webElements);
  return buildPromptWithPptxElementReferences(withWebElements, contexts.pptxElements);
}

export function parseComposerPromptContexts(
  content: string,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): {
  visibleContent: string;
  codeComments: CodeCommentComposerAttachment[];
  conversationSelections: readonly ConversationSelectionDisplayReference[];
  webElements: WebElementContextComposerAttachment[];
  pptxElements: PptxElementReference[];
} {
  const pptx = parsePromptPptxElementReferences(content);
  const web = parsePromptWebElementContexts(pptx.visibleContent, workspace);
  const code = parsePromptCodeComments(web.visibleContent, workspace);
  const selections = parsePromptConversationSelections(code.visibleContent);
  return {
    visibleContent: selections.visibleContent,
    codeComments: code.codeCommentAttachments,
    conversationSelections: selections.references,
    webElements: web.webElementContexts,
    pptxElements: pptx.pptxElementReferences,
  };
}
