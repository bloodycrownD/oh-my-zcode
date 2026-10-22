// 照搬上游 v3.16.2 project-sidebar/grouped/sticky-group-header-slot.tsx（upstream-v316-fullsync P4.1 分组视角批；omz 化差异见文件内注释）
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

const STICKY_GROUP_HEADER_EXIT_MS = 150;

export function StickyGroupHeaderSlot({ header }: { header: ReactNode | null }) {
  const [renderedHeader, setRenderedHeader] = useState<ReactNode | null>(header);
  const [visible, setVisible] = useState(Boolean(header));

  useEffect(() => {
    if (header) {
      setRenderedHeader(header);
      const animationFrame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(animationFrame);
    }

    setVisible(false);
    const timeout = window.setTimeout(() => {
      setRenderedHeader(null);
    }, STICKY_GROUP_HEADER_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [header]);

  if (!renderedHeader) {
    return null;
  }

  return (
    <div
      className={cn(
        "pointer-events-auto absolute left-0 right-0 top-0 z-20 pt-1",
        "transition-[opacity,transform] duration-150 ease-out motion-reduce:translate-y-0 motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
      )}
    >
      {renderedHeader}
    </div>
  );
}
