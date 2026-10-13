# realdevice-e2e 证据包（queue-item-guide-toggle）

节点：realdevice-e2e（主代理手工执行——执行子代理两次 provider 限流后按 agile-dev 失败纪律接管）｜日期：2026-10-14｜分支：feature/queue-item-guide-toggle（HEAD=5a63ceb3+留痕）

## 环境信息

| 项 | 值 |
| --- | --- |
| 仓库路径 | D:\Dev\Js\oh-my-zcode |
| Node | v22.22.0 / win32 10.0.26200 |
| 启动 | pnpm --filter @zcode/desktop dev（ZCODE_STORAGE_DIR/ZCODE_DESKTOP_HOME_DIR/MAGIC_CONTEXT_DB_DIR 指 os.tmpdir() 一次性目录） |
| CDP | 9229（主进程自动开），/json/list 匹配 type=page + localhost:5174 + 排除 resource-manager.html |
| workspace 打开 | 第二实例 electron . --open-workspace=<tmp>\ws 经单实例锁转发 |
| 凭据 | 复制真实 ~/.omz/v2（provider 配置+凭据）到一次性 home，结束即删（真实模型调用若干次制造 busy turn） |
| driver | cache/e2e-guide-toggle.mjs（v11，CDP Runtime.evaluate 驱动） |

## 场景状态表（7 轮迭代 v5→v11 的最终态）

| # | 场景 | 状态 | 原因/结论 | 证据 |
| --- | --- | --- | --- | --- |
| S0 | workspace 打开（composer 出现） | passed | 第二实例转发可靠 | v5-v11 各轮 log |
| S4 | busy 排队 + 「引导」按钮存在性 | passed | 真模型 turn busy 中排队成功；每行渲染 `v4-queue-item-guide-<id>` 按钮（含 tooltip 文案「引导至下一轮工具调用后运行（内联当前轮，不抢占）」） | v5-v11 ids/guideBtns |
| S5 | queue→guide→queue 切换往返 | **failed（疑似产品缺陷，待裁决）** | 详见下节 | v8-v11 s5Diag/s5Console |

## S5 症状与证据链（v8-v11 收敛后）

1. 原子点击成功（入队确认后 0ms 即点，按钮 enabled）。
2. 行级 ACK 等待态正确翻转（点击后 1 帧 disabled=true → 复位 false）——hook 的 dispatchCommand promise 正常 settle。
3. **renderer console 无任何 setQueueItemDelivery 拒绝日志**（patch console.error/warn 捕获，仅无关 Tooltip 警告）→ ack.status ∈ {accepted, noop, duplicate}，未走 onRejected。
4. 点击后 45s（ping 循环任务稳定 busy 窗口）：队列项纹丝不动、`v4-queue-item-guide-restore` 按钮不出现、时间线无「正在引导对话/等待引导当前任务」turnSteer 痕迹、无 toast。
5. 主进程日志无 setQueueItemDelivery 痕迹（tail 被流式输出刷屏，此项证据力弱）。
6. 对照：core/bootstrap 单测 20 例全过（切换改 pendingInputs、投影 reducer、guard 门序均验证）。

**疑似缺陷定位（待修）**：命令被接受（accepted 或 noop）后 UI 无任何投影变化。两个候选断点：
- handler「同值 noop」误判：`host.getQueueItem(...).delivery.admitted` 若因投影滞后读到 guide（不应发生——项显示在 queue 面板），则 queue→guide 点击被 noop 吞掉；
- 或 accepted 路径事件已产生但 renderer 侧 guide 投影消费链断（pendingGuideProjection 过滤/ConversationPendingGuideList 挂载/Timeline props——conversationProjectionCore.test 只覆盖纯投影函数，未覆盖 SessionPane 挂载链）。

**另一观测**：首 turn 结束与 autoDrain 提升间隙极短（100ms 重试），早期轮次（v5-v9）点击被 reserved/promoting guard 正确拒绝或被 drain 抢先——guard 行为符合设计。

## 方法论备注（复用价值）

- config.json 落点 = `os.homedir()/.omz/cli`（`file-config.adapter.ts` DEFAULT_BASE_DIR，Windows 读 USERPROFILE），**ZCODE_STORAGE_DIR 不控制它**——e2e 须用备份/恢复式验证（本包 v3+ 口径）。USERPROFILE 重定向不可用（Electron appData 解析失败）。
- 真模型制造 busy：纯数数/作文任务在 GLM 上几秒完成，窗口不足；工具循环任务（ping×10）可制造 30s+ 稳定窗口。
- e2e 结果 JSON 注意脱敏：绝不 dump 完整 config.json（含 MCP Bearer）。


## 2026-10-13 code-dev-loop 验收（S5 根因修复后）

- 定位手段：renderer hook + CLI handler/core + publisher 四层临时插桩，7 轮 e2e 对照 pass/fail；fail 轮 ack 实锤 status=stale / proto.staleRevision / revisionAtDecision=7 vs 发送 rev=6，CLI 零执行（命令在 gateway CAS 层被拒）。
- 修复：c1671fae（hook stale 单次重试 + P0-2 rejected + P2-1 观测）→ 复跑 1/3（单次重试读本地滞后 revision 仍连败）；2158c8ed（重试升级：max(本地, ack.revisionAtDecision)，上限 2 次）。
- 验收：修复后 S0/S4/S5 真机 3/3 全过（v3 含 turn 提前结束但切换已生效的正向样本）。fix-spec「开发落地记录」节留痕。
