# CDP 实机验收锚点（bugfix-batch-20261011）

生成节点：cdp-anchors-collector（Explore readonly）｜日期：2026-10-10｜head_sha：d69ef5e4｜落盘：主代理（子代理只读）

## 1. 启动与 9229
- dev：`pnpm --filter @zcode/desktop dev` → scripts/dev-desktop-env.mjs production；dev:runtime = tsup --watch + vite + scripts/dev.mjs
- **9229 由主进程自动开**（packages/desktop/src/main/index.ts:165-167 appendSwitch remote-debugging-port 9229；条件：未打包且 `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT!=='1'`）——不需要传 --inspect
- Vite renderer：http://localhost:5174（vite.config.ts:189 strictPort）；主窗口 loadURL 见 desktopHostProcess.ts:129-135
- CLI 不透传参数给 electron；主进程 Node inspector 是 9231（.vscode/start-electron.mjs:29），勿混淆

## 2. /json/list 目标匹配（勘误！）
- **旧脚本 title==="ZCode" 已过期**：renderer index.html:6 现在 `<title>omz</title>`（scripts/dev/long-session-perf-sample.mjs:14,452 仍写死 ZCode，复用时必须改）
- 正确匹配：`type==='page' && url 命中 http://localhost:5174/ && 排除 resource-manager.html`（resourceManagerWindow.ts:277-279 独立页面）
- 残留脚本均不拼 executionContextId——直连 webSocketDebuggerUrl 默认主世界即可

## 3. data-testid 清单（拼接规则 `${base}-${suffix}`，shared/src/test-ids.ts:711）

### 模型选择（T-ML / T-S3 验收核心）
- `chat-model-select-trigger` / `chat-model-select-item-<value>` / `chat-model-select-group-<group>`（ModelConfigSelect.tsx:215,295,435；选中=data-model-option-selected / data-checked；当前值=data-model-current-value）
- 生效指示：`v4-model-config`（V4ComposerToolbar.tsx:540；data-provider/data-model/data-thought/data-mode/data-usage-*）
- 思考深度：chat-thought-level-select-trigger / -item-<value>（ThoughtLevelCycleControl.tsx:248,352）

### 发送/输入
- `v4-composer` / `v4-composer-input`（LexicalChatInput.tsx:1445）/ `v4-composer-send`（ConversationComposer.tsx:1883）/ 回退 `chat-send-button`（ChatPromptEditor.tsx:440）

### 排队（T-S3 验收核心）
- `v4-queue`（ConversationQueuePanel.tsx:304）/ `v4-queue-item-<id>`（:168）/ `v4-queue-item-send-now-<id>`（:210，命令 sendQueuedNow=SessionPane.tsx:2646）/ `v4-queue-item-delete-<id>`（:241）/ `v4-queue-item-edit-<id>`（:225）/ `v4-queue-paused-banner` / `v4-queue-resume`
- 拖动排序=data-v4-queue-drag-handle（:187；TID_V4_QUEUE_ITEM_UP 常量存在但未挂）

### 子智能体 override（T-MU2）
- `settings-page` / `settings-section-nav-subagents`（settingsPageConfig.ts:92）/ `subagent-row-<name>`（SubagentsSection.tsx:497）/ `subagent-built-in-model-trigger-<name>`（:729，data-model-current-value）

### 时间线 modelChange marker（切模型观感）
- `v4-timeline`（ConversationTimeline.tsx:2026，data-row-count/data-window-row-count/data-total-row-count 等）/ `v4-row-<rowId>`
- marker：`data-row-kind="timelineMarker"` `data-marker-type="modelChange"` `data-status="applied"`（ConversationRowView.tsx:1718-1728）；协议字段 fromProvider/fromModel/toProvider/toModel/toThought（shared/src/zcode-protocol-v4/rows.ts:344-361）
- 注意：无 data-turn-state，turnHeader 只渲染文本（ConversationRowView.tsx:1627-1636）——用 marker 属性 + turnHeader 文本断言

### magic-context 可见面
- `chat-context-usage-trigger` / `chat-context-usage-magic-context`（contextUsage.tsx:345,452；字段缺失整段不渲染）/ `chat-reasoning-trigger|content`（reasoning.tsx:364,537）
- 设置：`magic-context-enabled-switch` / `magic-context-autosave-status`（MagicContextSettingsSection.tsx:258,282）

## 4. 可复用脚本
- scripts/dev/long-session-perf-sample.mjs（完整 CDP 骨架：/json/list、Runtime.evaluate :257-261、webSocketDebuggerUrl 直连 :674——**title 匹配需改**）
- docs/iterations/desktop-long-session-perf/cache/：e2e-probe.mjs（:32-53 Runtime.evaluate+v4-timeline）、e2e-open-session.mjs（PointerEvent 序列 :58-77）、e2e-input-probe.mjs（Input.dispatchMouseEvent 坐标点击）、e2e-window-check.mjs（v4-timeline 属性读取）
- .cu-shots/ 目录不存在（旧 cdp-verify-*.mjs 确认丢失）

## 5. 注意
- 9229 会被 e2e/Chromedriver 抢占（long-session-perf-sample.mjs:462,469 有提醒）——实机验收前确认无并行 e2e
- Radix 菜单交互：PointerEvent('pointerdown')；子菜单 pointerenter+pointermove+click（RULE.md 通道口径）
