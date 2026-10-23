/**
 * 新建模型供应商「名称弹窗」的纯逻辑：预填与名称校验。
 *
 * 本仓 UI 测试基建为纯逻辑/源码形状守卫（无 jsdom），因此把「必填 / 重名 / 预填」
 * 这些可判定规则收敛到这里，组件只负责渲染、聚焦与提交回调。
 */

/**
 * 重名提示文案与服务层同源：`assertProviderLabelMutationIsUnique` 抛出的错误固定为
 * `Provider 名称已存在: {name}`。前端拦截必须给出同一句提示，重命名与新建的失败
 * 反馈才一致，因此这里不用另造 i18n 键。
 */
export const PROVIDER_NAME_EXISTS_MESSAGE = "Provider 名称已存在";

/** Template 选择页交给 Section 的一次选择结果。 */
export interface ProviderTemplatePick {
  /** 模板路径的模板 ID；自定义路径为空。 */
  templateId?: string;
  /** 模板路径为按当前语言解析后的模板名；自定义路径为通用「新供应商」。 */
  suggestedName: string;
}

export type CreateProviderNameResolution =
  | { status: "ok"; name: string }
  | { status: "empty" }
  | { status: "duplicate"; name: string };

/**
 * 名称校验：空/纯空白拦截为 `empty`；重名（大小写不敏感 + 去首尾空白）拦截为
 * `duplicate`；通过时返回归一化后的名称。
 *
 * 逐字对齐服务层 `nextPersonalProviderLabel` / `assertProviderLabelMutationIsUnique`
 * 的比较口径（trim + toLocaleLowerCase），避免前端放行、后端改名或报错的错位。
 */
export function resolveCreateProviderName({
  rawName,
  existingNames,
}: {
  rawName: string;
  existingNames: readonly string[];
}): CreateProviderNameResolution {
  const name = rawName.trim();
  if (!name) {
    return { status: "empty" };
  }
  const normalized = name.toLocaleLowerCase();
  const duplicated = existingNames.some(
    (existing) => existing.trim().toLocaleLowerCase() === normalized,
  );
  return duplicated ? { status: "duplicate", name } : { status: "ok", name };
}

/**
 * 弹窗打开时的名称预填：模板路径预填模板名，自定义路径预填「新供应商」。
 * 模板名缺失（历史模板没有名称映射）时回退到通用名，避免把空串带进必填校验。
 */
export function resolveCreateProviderPrefillName({
  templateId,
  templateName,
  fallbackName,
}: {
  templateId?: string;
  templateName?: string;
  fallbackName: string;
}): string {
  const templatePrefill = templateId ? (templateName?.trim() ?? "") : "";
  return templatePrefill || fallbackName.trim();
}
