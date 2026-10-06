import { create } from "zustand";
import {
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";

// ============================================================
// 动态工作流开关快照在 renderer 的唯一副本
// ============================================================
//
// FORK（D-20）：远端灰度下发链（`/api/v1/client/configs`）已随账号面整删，
// 开关改为本地默认启用。这里只保留一份同步快照，消费方（自动化页、run 面板）
// 仍按逐字段订阅读取，避免各自重新折叠规则。

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** 未知即不提供，入口宁可晚半拍出现也不闪一下再收起。 */
  readonly enabled: boolean;
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** 本地快照已就绪；保留签名以便 Root 挂载时触发一次发布。 */
  ensureLoaded(): Promise<void>;
  /** 本地配置无远端缓存，refresh 与 ensureLoaded 等价。 */
  refresh(): Promise<void>;
}

const LOCAL_CONFIG: DynamicWorkflowClientConfig = createDynamicWorkflowClientConfig(
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  "default",
);

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>()(
  (set) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(): Promise<void> {
      set({ status: "ready", enabled: LOCAL_CONFIG.enabled, config: LOCAL_CONFIG });
      return Promise.resolve();
    },

    refresh(): Promise<void> {
      set({ status: "ready", enabled: LOCAL_CONFIG.enabled, config: LOCAL_CONFIG });
      return Promise.resolve();
    },
  }),
);