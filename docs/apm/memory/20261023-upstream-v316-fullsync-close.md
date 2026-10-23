# 2026-10-23 · upstream-v316-fullsync 迭代收尾（apm-record）

## 一句话

上游 ZCode v3.16.2 产品面全量同步迭代（89 commits，1ff8cad9→0eedac07）走完 auto-dev-loop 全流水线并入 main，发版 v1.0.21；全门禁绿+终审 0 must-fix。

## 流水线终态

阶段 1 exempt（无独立 PRD，用户多轮拍板三条产品政策）→ 2/3 spec 四轮核验 Go → 4 dev P0-P8 十波次全 func-ready → 5 测试全量绿 → 6 终审 GO（七项抽查：合并一致性/迁移安全/逃生开关/ToolSearch off 恒等/held 入队无死锁/品牌 26 处实义命名/测试可复现）→ 7/8/9 自动豁免 → 10 本篇 → 发布 v1.0.21（+0.0.1）。

## 关键结论（复用价值）

1. **三条产品政策贯穿全程，后续上游同步沿用**：①历史任务可删（includeArchived 跟上游）②UI 保 omz（向导壳族拍板 A 关闭、omz Dialog 链即入口）③MC 三端口零触碰+全套回归门禁（654/0）。
2. **ToolSearch 落地序教训**：spec 预定「MC transform→暴露决策→投影」不可行——MC 正投影文本化丢 tool_reference 块；实落=暴露决策→公告→MC transform→双投影。默认 off 三层缺省恒等（validationAppSettings/protocol/SettingsPage），冒烟集锁死。
3. **迁移安全模式**：scope 三分（base/controller-remote/source-server）+未知 scope 回退 base+checksum 只对 scope 内生效——老库升级零风险有直接测试断言（tasksMigrationsUpgrade 3/3）。
4. **门禁零新增口径实践**：lint 49w/0e（docs/** 出产品范围+触碰面清零）、oxfmt 触碰面 0（v1.0.20 blob 实证 96 存量非本迭代引入）、knip 豁免 222+删 0（cache/gate-knip.json 14 组登记）。
5. **D: 卷合 main 实操**：ff-only merge 433 文件无蒸发；主检出冲突面=8 个与分支 blob 逐一比对后删除的未跟踪陈旧件+1 个手改 UPSTREAM-SYNC（分支版取代）。
6. **cli 27 工程跑法**：主检出 apps/zcode-cli/node_modules/.bin 无 turbo（子 workspace 无 lockfile），从根 `..\..\node_modules\.bin\turbo.cmd run typecheck`（cwd=apps/zcode-cli）27/27；magic-context test:all 全 PASS。

## 挂账（下轮输入）

- 真机 QA 矩阵未跑（用户拍板跳过直接发版）：T-CP3/T-VU2/T-RM3/T-RM4/T-QA-bugAB——发布后用户实测反馈即验收。
- P3 挂账：entries 表+resolveHost 路由+RemoteProjectPicker 挂载+ProjectCreation 设备选择面。
- P9/发布轮挂账：management 服务+registry+设置设备卡；deployServer 退役拍板；remote-viewing 回填（relay v2 缓行）。
- U5-U12 仍在 upstream-v3.16-backport 待合流；i18n P3 卫生项（marketplace claudeCodePlugins 键消费点核对）。
