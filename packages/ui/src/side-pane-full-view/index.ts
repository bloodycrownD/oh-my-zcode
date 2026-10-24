// side-pane-full-view 模块公开入口（spec：docs/ui/side-pane-full-view.md）。
// 上游 v3.16.2 的同名模块还导出 contract.example.ts / module.ts（vitest 与架构清单专用），
// omz 无 vitest-in-src 与 module 清单约定，这两件未搬：契约示例投影由
// packages/ui/test/sidePaneFullView.test.ts（T-UF5）覆盖。
export type * from "@/side-pane-full-view/contract.js";
export { SidePaneFullViewConversationHost } from "@/side-pane-full-view/ConversationHost.js";
export {
  SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE,
  SidePaneFullViewConversationTab,
} from "@/side-pane-full-view/ConversationTab.js";
export { SidePaneFullViewToggleButton } from "@/side-pane-full-view/ToggleButton.js";
export { useSidePaneFullView } from "@/side-pane-full-view/useSidePaneFullView.js";
export {
  readFloatingAnchorPreference,
  writeFloatingAnchorPreference,
} from "@/side-pane-full-view/anchorPreference.js";
export { useConversationPanePresentation } from "@/side-pane-full-view/conversationPanePresentation.js";
export {
  isFloatingPresentation,
  resolveSidePaneFullViewHostMode,
  SIDE_PANE_FULL_VIEW_ENTER_STATE,
} from "@/side-pane-full-view/model.js";
