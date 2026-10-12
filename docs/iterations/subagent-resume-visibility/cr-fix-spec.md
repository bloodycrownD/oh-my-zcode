# CR Fix Spec: 子智能体终态续跑可见性（subagent-resume-visibility）

## 元信息

- repo：D:\worktree\subagent-resume-visibility（分支 subagent-resume-visibility）
- base_sha：5c2d2234（spec 定稿）→ head_sha：e565c5a9
- prd_path：未提供（需求用户口述，spec「需求来源」节记录）
- spec_path：docs/iterations/subagent-resume-visibility/spec.md
- review_round：1 / dag_version：1
- fix-spec 文档校验：spec-check-loop 1 轮 Go（P0/P1=0，2 条 P2 表述精度已订正：
  OQ-2 插值「新增/既有」归类、OQ-1 spec 引用改推论措辞）
- 状态：**fix-spec-ready（待用户确认）**

## Must-fix（按 P0 → P1 → P2）

无。review-full 首轮（B–K 全维 + C-orch，新鲜回读非照抄 cr-func 结论）认定
**P0=P1=P2=0**。关键新鲜取证：

1. registry 同源：agent-runtime.ts:285 单实例同时供给 port 装配与 call-runner deps，
   C1 识别条件非空转；
2. C3 可达性：runner 三处 finalize 直调 formatLocalAgentTaskNotification，两支指引
   均可达，executor 侧只走 local_bash/workflow 分支，无死代码；
3. C5 描述与实现一致（TERMINAL_STATUSES 全集 vs "finished or was stopped"）；
4. executor 契约：createErrorResult 第三参为 durationMs，无截断误用；
   AGENT_TOOL_FAILURE_CODE=1000 形状合法；
5. 调试残留 grep 零命中（TODO/FIXME/console.log/debugger/.only/.skip）。

## Spec deviations

- **accepted（cr-func-all 已接受，本轮复核沿用）**：
  1. CHANGELOG Unreleased 条目归「新增」而非「修复」；
  2. C1 try 包裹范围略宽于 launch 单行——窄识别条件（registry 在册 + CoreError
     带句柄）保证行为等价，T-RV1d 负例锁定原样 rethrow。
- open：无。

## Open questions / 待拍板

### OQ-1（review-full/B-1）前台同步等待中被 TaskStop 的子 agent 无句柄透出——**已拍板执行，落地 8ecece66（2026-10-13）**

- **落地**：runner.ts 412-424（TaskStop 短路分支 CoreError rethrow 前与 C8 逐字同款
  浅拷贝合并 agentId/agentType/parentToolCallId）+ T-RV1e 竞争窗口夹具
  （makeGatedRejectingChild + registry.update 稳定化「child rejection 先 settle、
  abort guard 未及转换、终态已置」的窗口）。真实 stopTask 的 abort 抢先路径
  （guardSubagentPromiseWithAbort→ToolCancelled 自带句柄）不受影响；T-S1a 语义
  不回归（killed 不被覆写）。验证：sync-dispatch 11/11、typecheck 27/27、
  e2e 1/1、全量 test:v4-perf 0 fail 段；cr-func func-ready yes（含「移除修复
  测试必红」无假绿推演）。

- 现状：runner.ts:411-414——TaskStop 已把 registry 置终态后 CoreError 原样 rethrow
  （不带 agentId），C1 识别条件不命中 → 前台 tool result 无句柄。该 killed 任务
  实际仍可 SendMessage 续跑（T-RV4 已证）。
- 定性：C8 被钉死为 458-460 单点（spec.md:49「主场景的唯一闭环路径」、:90 显式
  取代「runner 其余不动」），411-429 的 TaskStop 短路分支由此推出在 C8 范围外，
  属**spec 内知情边界**而非实现遗漏；但对照口述需求「失败/停止都透出 agentId」
  字面有 gap。
- 若拍板覆盖（三要素已备）：411-414 分支 rethrow 前同款浅拷贝合并 agentId context
  （C8 手法复用），T-RV1 补一组「TaskStop 形态」夹具；验收 = 该形态 handler 收口
  后 modelContent 信封含句柄。
- 不阻塞本轮 fix-spec-ready。

### OQ-2（review-full/D-1）指引句/兜底句插值点未走 escapeXml（前瞻条件）

- 三处插值（agent.ts 收口 message、notification.ts:183 resumeSentence——此两处为
  本迭代**新增**；runner.ts:996 C6 兜底句的 `${request.to}` 插值为**既有**
  （5c2d2234 基线 :981 已在），本迭代仅追加尾部边界文案）均未 escape。当前
  agentId 生产路径为 `agent_${crypto.randomUUID()}`（runner.ts:881），无外部注入
  通道；指引句位于 `</task-notification>` 之后不破坏 XML；与同文件
  workflowDeliveryGuidance 的 runId 插值同款既有范式。**生产不可达，不认定 must-fix。**
- 前瞻条件（登记即可）：未来若 `createAgentId` 开放外部可控值（如允许用户命名
  agent），三处须同步补 escapeXml。

### OQ-3（review-full/G 微瑕，不建议修）

T-RV3d 长度上界断言 `<= 120_013` 比实际截断输出宽 1 字符——上界断言只防超长，
无假绿方向漏报，可留置。

## 已豁免（用户确认不修）

无。

## 合并后 QA（manual_user）

- 真机（桌面端/CLI）跑一次「前台派 agent → 观察失败收口文案带 agentId 与
  SendMessage 指引 → SendMessage 续跑」人工过目（自动化已由 e2e 三幕覆盖，
  此项为体验级抽查，不阻塞）。

## K 节建议（下游执行时闭合）

无新增（lint 74w/0e=基线、knip 零新增、无调试残留、文档 CHANGELOG/iteration-state
均已同步，verify 阶段已闭合）。

## Fix-Spec Closure

| 项 | 状态 |
| fix-spec-ready | yes（待用户确认） |
| fix_spec_path | docs/iterations/subagent-resume-visibility/cr-fix-spec.md |
| dag_version / review_round | 1 / 1 |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 0 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | accepted×2（cr-func 沿用）；open 0 |
| C-orch | ✅（指引句/常量无平行路径散落，五项取证之一） |
| C 类合并后 QA | 1 项 manual_user（不阻塞） |
