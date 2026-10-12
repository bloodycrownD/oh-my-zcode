import { z } from "zod";
import { attachmentSourceKindSchema } from "../attachment-source.js";

/** 仅承载已提交内容引用与展示元信息；内容本体不进入 command/topic frame。 */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    // 附件来源（clipboard-text = 长粘贴落盘的临时文本）：预览授权闸按它放行 text/plain。
    // 上游同形字段；本仓生产端只发 clipboard-text（见 attachment-source.ts 的 FORK 说明）。
    sourceKind: attachmentSourceKindSchema.optional(),
    previewRef: z.string().optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
