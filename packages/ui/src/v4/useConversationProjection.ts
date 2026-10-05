import { useSyncExternalStore } from "react";
import type {
  ConversationStoreState,
  ConversationTurnDirectoryState,
} from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

/** 与 store 的 INITIAL 目录态同构：无 lease 时 rail 按「目录未知」处理，不误判隐藏。 */
const CLOSED_TURN_DIRECTORY: ConversationTurnDirectoryState = {
  entries: [],
  realUserQueryTotal: 0,
  atRevision: null,
  atSeq: null,
  atLogEpoch: null,
  hasMore: false,
  truncated: false,
  loaded: false,
};

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
  turnDirectory: CLOSED_TURN_DIRECTORY,
  loadingDirectory: false,
};

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(lease: SessionLease | null): ConversationStoreState {
  const store = lease?.store ?? null;
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? CLOSED_STATE,
    () => CLOSED_STATE,
  );
}
