import { PersistedToolSearchContentSchema, ToolSearchAnnouncementSchema, type Logger } from "@zcode/contracts";

/**
 * D4 隔离（spec phase-toolsearch）：上游的 hydrateCompactDiscovery 依赖
 * contracts 的 compactBoundaryPayloadSchema（compact 边界落盘面），omz 不迁；
 * hydrateToolSearchContent 在上游由 session-history-hydrator 消费（modelContent
 * 落盘恢复），omz 水合链同样不接线。这里保留两个纯函数供按需（内存态）校验与
 * 冒烟测试使用——它们是「校验器」，不是持久层恢复入口。
 */
export function hydrateToolSearchContent(value: unknown, logger?: Logger) {
  if (value === undefined) return undefined;
  const parsed = PersistedToolSearchContentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger?.warn("Invalid persisted ToolSearch content; using legacy tool result", {
    event: "session.tool_search.invalid_content",
    module: "core.session",
  });
  return undefined;
}

export function hydrateToolSearchAnnouncement(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = ToolSearchAnnouncementSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
