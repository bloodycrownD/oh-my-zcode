---
date: 2026-10-12 22:10
title: 子 agent 失败/停止后无法继续会话——agentId 透出缺口调查与 A 方案 spec
keywords: agentId, SendMessage, resume, 子代理, 失败, 停止, runner.ts, error-payload, subagent-resume-visibility
abstract: 用户反馈失败的 agent 不返回 agentId、停止的任务无法 SendMessage 续跑；调查确认运行时 resume 机制覆盖所有终态，缺口在模型侧句柄透出。用户拍板 A 方案，已完成 spec-generate（3 探索子代理 + spec 落盘 docs/iterations/subagent-resume-visibility/spec.md），待用户确认 spec。
---

user:
（背景）之前一轮改动让 Agent 工具同步/异步两分支都透出 agentId + childSessionId（fork 注释见 apps/zcode-cli/packages/core/src/tool/handlers/agent.ts，同步分支 agentId 行 + childSessionId 行），目的是父模型能用 SendMessage 继续追问子 agent。现在发现：失败的 agent 不返回 agentId，停止的任务也无法重新发送消息。我认为 agent 无论停止还是失败都不该被当成无法继续会话，应该像普通会话一样支持继续对话。

assistant:
调查结论（2026-10-12，基于 main@4fec62d4 / v1.0.8）：

运行时侧其实已经与用户期望一致——sendMessageToLocalAgent（runner.ts:963）对终态 task 一律走 resumeTerminalAgentInBackground（runner.ts:1020），不区分 failed/stopped/killed；resume 需要 profile 活读 + task.childSessionId（均满足，停止/失败的 task 保留在 registry）。甚至有现成 providerMessage "was stopped (killed); resumed it in the background"。

真正的缺口是模型侧句柄不可达：
1. 前台失败：runner.ts:462 抛 CoreError 时 context 里带了 agentId，但 error-payload.ts formatContextDetail 白名单只投影 provider/model/code/reason/status 等，agentId 被丢弃 → 模型看到的 tool result 无句柄。AgentOutput 契约也无 failed 形态（只有 completed/async_launched）。
2. 前台用户停止（turn abort）：走 failed 收口，错误结果同样无 agentId；早期 setup 失败更直接 registry.remove（runner.ts:290/556）。
3. 后台停止/失败通知（notification.ts:144 formatLocalAgentTaskNotification）：有 <task-id>（=agentId）但无任何「可 SendMessage 续跑」指引——对比 workflow 通知有整段 deliveryGuidance 教模型用 ResumeWorkflowRun。SendMessage 工具描述也只说 agentId 来自 spawn result。
4. registry 纯内存（InMemoryRuntimeTaskRegistry）：CLI/会话重启后所有 local_agent 句柄丢失，SendMessage 一律 "No active local_agent task found"——「像普通会话一样」的最大缺口（主会话可 resume，子 agent 跨重启不行；metadata.json 已落盘 childSessionId 但 registry 不从磁盘重建）。

方案三档（待拍板，未动手）：A=失败/停止收口文案带 agentId + 通知加续跑指引（小改，推荐先做）；B=AgentOutput 加 failed 形态（协议变更，动 provider schema/契约/UI 三处，不建议先做）；C=registry 从磁盘重建支持跨重启 resume（大工程，二期候选）。

user:
A 吧，生成 spec。

assistant:
按 spec-generate 流程完成（2026-10-12）：需求为口述（非标准 PRD），APM 上下文沿用调查记忆。并行派遣 3 个 readonly Explore 子代理（错误收口链路 / 通知与工具描述面 / 测试基线与历史文档），关键增量发现：①父模型实际吃 modelContent ?? stringifyToolResultOutput——只改 CoreError 文案不进模型，前台失败必须走 modelContent 通道（Agent handler 层 catch，不动公共 call-runner）；②docs/.iteration-state.yaml:127 有旧方法论「同步 agent 失败不回 agentId → 长任务一律后台派」，A 方案是决策反转，spec 已显式声明防 CR 误报；③当前仓对 6 个目标文案零断言（零订正成本零存量保护），终态 SendMessage resume 全仓零测试覆盖；④上游 .reference 有而 fork 丢失的 Agent 描述 bullet（continue a previously spawned agent）顺带补回。spec 落盘 docs/iterations/subagent-resume-visibility/spec.md：5 Step（前台失败收口 / 后台通知指引 / 工具描述 / 测试网 / 文档登记）、6 用例 T-RV1~6、明确不做清单（不动 AgentOutput union、不动 SendMessageOutputSchema、不做 registry 持久化）。待用户确认 spec。

user:
（用户触发 spec-check-loop 校验）

assistant:
进入 spec-check-loop（2026-10-12）：第 1 轮 readonly 审查子代理已派遣，重点核验 C1 的 modelContent 通道与 ToolResult/call-runner 类型契约是否硬冲突、C3 截断顺序与 notification.ts 实际代码一致性、T-RV1~6 可测性。

第 1 轮 No-Go（2 P0+2 P1+3 P2）→ doc-fix：门禁改指 `pnpm --dir apps/zcode-cli typecheck`（根 typecheck 不含 CLI 子树）；C1 机制改写为 rethrow 增强版 CoreError（executor 契约只有 ToolHandlerFailure 转 throw 或 validateOutput 严格 union 两条路，handler 无法直接返回自定义 error+modelContent）；识别条件加 registry 在册校验。
第 2 轮 No-Go（7/7 修复确认 + 新 P0）→ doc-fix：主场景（child 模型/provider 失败）到达 handler 的 CoreError 不带 agentId（runner.ts:458-460 原样 rethrow），registry 无反查接口、handler 无句柄来源——唯一闭环是 C8：runner rethrow 前把 agentId 合并进 CoreError context（不动 errorPayloadRole）；T-RV1 改双形态夹具（CoreError/非 CoreError）；getRuntimeTask→get(id)；error.code 漂移登记。进入第 3 轮审查。
第 3 轮 **Go（execute-ready）**：C8 机制逐行核验吻合（458-460 行号、作用域、CoreError context 可变、投影 uniqueStrings 去重无冲突、411-429 stopTask 短路与 C8 互斥）；终修 P1-1（C8 钉死浅拷贝替换、兼容 undefined context、禁原地 mutation）+ 4 项 P2（detail.code 双轨说明 / T-RV1 负例钉死 handler 直调形态 / T-RV3 补截断次序断言 / 通道①现状措辞）。spec 终版：3 轮审查、0 P0、门禁=apps/zcode-cli typecheck + test:v4-perf + 根 lint + knip。待用户确认 execute-ready 后开工。
