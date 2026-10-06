import { useEffect, useMemo } from "react";
import {
  useDynamicWorkflowAvailabilityStore,
  type DynamicWorkflowAvailabilitySnapshot,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

/**
 * 读动态工作流开关快照（本地默认）。
 * 只读，不触发发布：快照由 Root 里的 loader 唯一负责。消费方（自动化页、run 面板）可能位于
 * 工作区级 ServiceProvider 内，让它们各自发布会把 app 级那一份覆盖掉。
 */
export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  // 逐字段订阅：返回对象字面量的 selector 每次都是新引用，useSyncExternalStore 会判定为变化。
  const status = useDynamicWorkflowAvailabilityStore((state) => state.status);
  const enabled = useDynamicWorkflowAvailabilityStore((state) => state.enabled);
  const config = useDynamicWorkflowAvailabilityStore((state) => state.config);
  return useMemo(() => ({ status, enabled, config }), [config, enabled, status]);
}

/**
 * app 会话级发布，挂在 Root 里一次。
 * FORK（D-20）：本地默认已就绪，无需远端取数。
 */
export function useDynamicWorkflowAvailabilityLoader(): void {
  const ensureLoaded = useDynamicWorkflowAvailabilityStore((state) => state.ensureLoaded);
  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);
}