export type MentionCategory =
  | "files"
  | "skills"
  | "commands"
  | "subagents"
  | "whiteboards"
  | "sessions"
  | "plugins";

export interface MentionItemData {
  kind?: "file" | "directory" | "whiteboard";
  path?: string;
  relativePath?: string;
  boardId?: string;
  scope?: "built-in" | "workspace" | "user" | "plugin";
  source?: "built-in" | "user" | "plugin";
  model?: string;
  /** Plugin 引用的稳定身份（`name@marketplace`），canonical 链接目标；label 不参与身份。 */
  pluginId?: string;
  /** Plugin 商店 listing 原始图标；仅用于 UI，必须经 HTTPS 校验后加载。 */
  icon?: string;
}

export interface MentionItem {
  id: string;
  category: MentionCategory;
  label: string;
  description: string;
  value: string;
  markdown: string;
  keywords?: string[];
  data?: MentionItemData;
  /**
   * 仅供面板渲染的本地化展示名（如 Plugin listing 的 displayName）。
   * `label` 同时是面板文案与 chip/markdown 载体的 label，直接本地化 `label` 会让
   * composer chip 与消息气泡（按 markdown label 重建）显示不一致；面板展示名单独走此字段。
   */
  displayLabel?: string;
  /** 禁选态（V1 同名 Plugin 冲突 fail closed）：面板可见但不可选择。 */
  disabled?: boolean;
  /** 禁选原因，展示在候选行右侧弱信息位。 */
  disabledReason?: string;
}

export interface MentionCategoryResult {
  items: MentionItem[];
  loading: boolean;
  error: Error | null;
  emptyText: string;
  title: string;
  refresh?: () => Promise<void>;
}

/**
 * mention 去重键：`category + value`（与 `prependEditorMentionIfMissing` 的插入前判定同源）。
 *
 * 恢复态 chip 与 provider/prefill chip 必须是同一把尺子，否则同一引用会出两枚 chip：
 * - skills：value 是技能名（provider `value: skill.name`，恢复态同口径）；
 * - files：value 是去掉尾斜杠的相对路径或绝对路径（provider 与恢复态同口径）。
 * 同一技能不同 path 仍视为同一条——名称才是技能身份，路径只是来源。
 */
export function isMentionAlreadyPresent(
  existing: Pick<MentionItem, "category" | "value">,
  candidate: Pick<MentionItem, "category" | "value">,
): boolean {
  return existing.category === candidate.category && existing.value === candidate.value;
}
