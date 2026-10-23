/**
 * 新建模型供应商「名称弹窗」的纯逻辑：预填、名称校验与失败横幅分类。
 *
 * 本仓 UI 测试基建为纯逻辑/源码形状守卫（无 jsdom），因此把「必填 / 重名 / 失败横幅」
 * 这些可判定规则收敛到这里，组件只负责渲染、聚焦与提交回调。
 */

import { PROVIDER_NAME_EXISTS_MESSAGE_PREFIX } from "@zcode/provider";

/** Template 选择页交给 Section 的一次选择结果。 */
export interface ProviderTemplatePick {
  /** 模板路径的模板 ID；自定义路径为空。 */
  templateId?: string;
  /** 模板路径为按当前语言解析后的模板名；自定义路径为通用「新供应商」。 */
  suggestedName: string;
}

type CreateProviderNameResolution =
  | { status: "ok"; name: string }
  | { status: "empty" }
  | { status: "duplicate"; name: string };

/**
 * 名称校验：空/纯空白拦截为 `empty`；重名（大小写不敏感 + 去首尾空白）拦截为
 * `duplicate`；通过时返回归一化后的名称。
 *
 * 逐字对齐服务层 `nextPersonalProviderLabel` / `assertProviderLabelMutationIsUnique`
 * 的比较口径（trim + toLocaleLowerCase），避免前端放行、后端改名或报错的错位。
 * 对齐重命名路径报错文案；创建路径服务层自动加序号，前端拦截更严格。
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
 * 服务层重名错误的识别口径：只按 `@zcode/provider` 导出的前缀匹配判定，
 * 原始错误串不直接上屏（展示统一由 `kind` 映射到 i18n 键）。
 */
export function isProviderNameExistsError(message: string | null | undefined): boolean {
  return message?.startsWith(PROVIDER_NAME_EXISTS_MESSAGE_PREFIX) ?? false;
}

/**
 * 创建失败横幅的分类结果。
 *
 * `duplicate`：名称与已有供应商重名（前端校验或服务层并发兜底）；
 * `empty`：名称为空/纯空白，必填提示优先于任何服务端错误；
 * `create`：仅在前端名称校验通过且服务层确实报错时成立；
 * `null`：无横幅。
 */
export type CreateProviderBannerKind = "duplicate" | "empty" | "create" | null;

export interface CreateProviderBanner {
  kind: CreateProviderBannerKind;
  /** 只有创建失败才提供重试（重名/必填要用户先改名称，重试必然再失败）。 */
  showRetry: boolean;
}

/**
 * 失败横幅分类：优先级 `duplicate > empty > create`。
 *
 * 只返回分类与时序决策，不返回展示串——文案由组件按 `kind → i18n 键` 映射，
 * 避免「服务层原始串」与「i18n 文案」两处来源打架。
 */
export function resolveCreateProviderBanner({
  resolution,
  errorMessage,
}: {
  resolution: CreateProviderNameResolution;
  errorMessage: string | null;
}): CreateProviderBanner {
  const duplicate = resolution.status === "duplicate" || isProviderNameExistsError(errorMessage);
  if (duplicate) {
    return { kind: "duplicate", showRetry: false };
  }
  if (resolution.status === "empty") {
    return { kind: "empty", showRetry: false };
  }
  if (errorMessage) {
    return { kind: "create", showRetry: true };
  }
  return { kind: null, showRetry: false };
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
