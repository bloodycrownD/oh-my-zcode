/* New task 页闲时任务入口（Figma ⚫️ Z.ai - Zcode / node 5488-3978；spec §5「模板」/ D30-4 第二入口）。

   修复原因（upgrade-316）：上游 v3.16.2 新增了本入口，但它依赖的模块在 fork 中已随
   「官方 off-peak 计费任务 / Coding Plan 订阅面」整体移除：
     - @/settings/CodingPlanEntryButton（useCodingPlanEntryGate）
     - @/hooks/useOffPeakEligibility
     - @/lib/codingPlanFunnelTelemetry
     - @/settings/CodingPlanUpgradeDialogProvider
     - @/store/offPeakTaskStore
   同时上游的 automationTemplateCatalog 也没有 fork 侧 OffPeakAutomationTemplate /
   appendLocalCustomizeTemplate / materializeOffPeakTemplateDraft / resolveOffPeakTemplateText。
   这些实现都挂在已删除的遥测与订阅服务上，重新引入会违反「已移除特性不再实现」的约束，
   因此这里保留组件与 props 契约，但渲染为 no-op，避免把入口接到不存在的能力上。 */

interface OffPeakNewTaskEntryProps {
  /** 打开 Automations 主视图（idle tab）；无法再预填 off-peak 草稿，保留签名兼容调用方。 */
  onOpenAutomations?: () => void;
}

export function OffPeakNewTaskEntry(_props: OffPeakNewTaskEntryProps) {
  // TODO(upgrade-316): 若后续恢复官方 off-peak 计费任务与 Coding Plan 订阅服务，
  // 需要同时恢复上述 5 个 UI 模块与 automationTemplateCatalog 的 off-peak 模板映射。
  return null;
}
