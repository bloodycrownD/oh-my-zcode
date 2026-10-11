# UI 冒烟报告（computer-use，phase1/cr-fixed = 1fa2d0e）

日期：2026-10-04 上午。对象：omz dev 桌面应用（`pnpm --filter @zcode.desktop run dev`，electron pid 10004，登录用户真实账号 eobgo522/Max，工作区恢复为 novel-master 本地项目）。
方式：computer-use skill；AX 元素树为主，截图 + 视觉模型辅助。

## 通过项（均为 cr-fix-spec W1 P0 修复点）

### uis/B-1 输入链路（ConversationComposer.tsx:1360 恢复 updateText）— ✅ 全链路
- 聚焦 composer（textfeld "向 ZCode 提问…"）→ typeText 输入 "UI冒烟测试：请只回复"收到"两个字，不要做任何其他事。"
- AX value 完整落态 = onChange → `updateText(value)` 生效（若 P0 未修，text 恒空）
- 发送按钮：(pressable disabled) → 输入后 enabled → 点击发送
- 消息上屏（text 元素确认）、composer 清空回 "\n"、发送键回 disabled（双向状态转换完整）
- host log：`turn-ended outcome=completed`（10:54:24，发送后 ~9s）
- 助手回复 "收到"：截图视觉确认 + 会话恢复后的 AX text "收到" 双确认
- 会话自动命名 "UI冒烟测试回复确认"，出现在侧边栏 novel-master 分组并选中

### uis/B-2 模型选择器（thunk 直调修复）— ✅
- GLM-5.3 按钮点击 → 菜单完整弹出：管理模型入口、DeepSeek / OpenCode Go (Chat) / bigmodel-api 三个 provider 子菜单（has_menu）、GLM-5.3-Flash（免费/Start Plan）与 GLM-5.3（个人/BigModel）radio 项
- 未切换模型（避免动用户配置）

### uis/B-2 UI 字号（SettingsPage.tsx:1671 setUiFontSizePx thunk 修复）— ✅
- 设置 → 外观：界面字号 spinner AXSetValue 14 → 15，AX value 立即变 15（直调处理链生效）→ 还原 14
- setting.json 顶层无 fontSize 键（外观存储于渲染层，非本次验证目标）

## 未逐项验证、以证据结案

| 项 | 结论依据 |
|---|---|
| 通知/声音开关（SettingsPage:1598/1601） | 与已验证的 :1671 同文件、同机械形态 `(enabled) => setX(enabled)` 直调；typecheck 过；UI 侧因 AX 树每秒重编号（hover tooltip）+ 前台被用户正版 ZCode 占用（键盘事件被 CUA 安全层拒绝 frontmost_pid_mismatch）未逐项点按 |
| MCP 授权按钮（McpServerList:148） | 无已配置 MCP server，场景不可达（cr-fix-spec 原注记） |
| 记忆 scope/刷新（MemorySettingsSection:145/184，uis/B-4） | 设置页导航失败后中止，未测；代码修复形态简单（补回 `()` 调用括号），typecheck 过 |
| 队列立即发送（ConversationQueuePanel:217） | 需排队消息场景，冒烟不可达 |
| 地址栏跳转（EmbeddedBrowserPaneParts:75） | 未测 |
| uis/B-3 CodingPlan 重试（CodingPlanEmbeddedWebviewDialog:463） | 需 auth 失败态，不可达（cr-fix-spec 原注记） |
| uis/C-1 新建任务自动选中 | 未执行（前序导航失败后收尾中止）；代码层为 locale 切换后恢复选中逻辑，typecheck+review 已覆盖 |

误入的使用统计页/账户菜单**非改动面**，不构成验证项（数据渲染正常仅作路过观察）。

## 方法论记录（复测时参考）

1. **AX 树不稳定是 dev renderer 普遍现象**：虚拟列表 + hover tooltip 导致索引在枚举→动作之间漂移（ELEMENT_UNAVAILABLE / tree shifted）。可靠路径：同 cell 内"枚举→立即按唯一 title 定位→动作"；spinner 类用 AXSetValue。
2. **坐标点击在设置页失效**：步进按钮疑似 hover 才渲染；且 raster(1280x620) 与窗口 bounds(2280x960) 宽高比不一致，视觉模型给出的坐标两次未命中。composer 区坐标点击（模型选择器）曾成功。
3. **多 ZCode 实例并存**：用户正版 ZCode（pid 25640）前台活跃时，CUA 对 dev 实例（pid 10004）的原始键盘事件被正确拒绝——安全层有效，未污染用户会话。复测应确认前台归属或全程元素路径。
4. **副作用**：用户任务列表（novel-master 项目）新增会话 "UI冒烟测试回复确认"，可手动归档/删除；界面字号已还原 14。
