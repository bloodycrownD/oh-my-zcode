import { z } from "zod";

/**
 * 附件来源词汇（UI 生产端 → 协议引用 → CLI 投影 → 预览授权链共用）。
 * 文本材料只传递文件引用，不能因跨端上传而退回自动全文注入。
 *
 * FORK 说明（对照上游 .reference/ZCode@aac4755 同形保留两支）：
 * fork 自身只生产 `clipboard-text`（长粘贴落盘的临时文本附件，见
 * packages/ui/src/lib/chatAttachments.ts 的 ChatComposerAttachmentSourceKind）。
 * `topic-history` 在本仓没有任何生产端与消费端，保留取值只为：
 * 1) 与上游协议同形，跨版本 peer 发来的引用不会被 `.strict()` 直接判死；
 * 2) 预览授权闸只放行 `clipboard-text`（v4-gateway 的 isReadablePreviewAttachment），
 *    上游专属支即使出现在 wire 上也不会被误授权。
 */
export const attachmentSourceKindSchema = z.enum(["clipboard-text", "topic-history"]);
export type AttachmentSourceKind = z.infer<typeof attachmentSourceKindSchema>;
