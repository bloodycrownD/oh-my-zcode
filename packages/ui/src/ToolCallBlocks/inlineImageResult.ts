/**
 * 工具输出内嵌图片的读取结果归一化。
 *
 * `FileMediaPreview.dataBase64` 是必填 `string`：0 字节图片（损坏/空附件）会解析出 `""`。
 * 读取本身成功但内容为空时，旧实现把 `src: ""` 塞进 state，渲染侧 `!current.src` 走
 * 「加载中」分支、`failed` 又没有置位 —— 结果是永久 Loading，用户看不到失败态。
 *
 * 归一化口径：空串与非字符串一律视为「没有可用图源」，`failed = !src` 由纯函数给出，
 * 组件只负责渲染 `previewFailed` / `loading`。
 */
export interface InlineImageResult {
  src?: string;
  failed: boolean;
}

export function resolveInlineImageResult(
  mediaPreview: { dataBase64?: string | null } | null | undefined,
): InlineImageResult {
  const src = typeof mediaPreview?.dataBase64 === "string" ? mediaPreview.dataBase64 : "";
  const usableSrc = src.length > 0 ? src : undefined;
  return { src: usableSrc, failed: !usableSrc };
}
