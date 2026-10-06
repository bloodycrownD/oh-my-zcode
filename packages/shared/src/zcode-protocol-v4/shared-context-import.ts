import { z } from "zod";

// 分享导入已随官方端点移除。schema 仅存旧会话解析容错：存量日志里的
// sharedContextImport 状态（v2 四字段 / legacy 仅 title）原样读入后不再被
// 任何消费方使用，也不再校验 shareUrl 形状（原 /cn/share/<code> 硬绑已删）。
export const sharedContextImportStateSchema = z.object({
  contextId: z.string().optional(),
  title: z.string().optional(),
  shareUrl: z.string().optional(),
  status: z.enum(["pending", "reserved", "attached", "discarded"]).optional(),
});

export type SharedContextImportState = z.infer<typeof sharedContextImportStateSchema>;
