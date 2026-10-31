import {
  PersistedToolSearchContentSchema,
  ToolSearchAnnouncementSchema,
  type Logger,
} from "@zcode/contracts";

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
