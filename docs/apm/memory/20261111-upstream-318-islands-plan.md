---
date: 2026-11-11 21:30
title: 上游 v3.18.0 盘范围收官与孤岛升级 spec 落盘
keywords: v3.18.0, 孤岛升级, vendor 工具, omz-upgrade skill, spec 待确认
abstract: 上游发 v3.18.0 后，用"多维交错拆分"完成全量盘点（工具+inventory+skill 三层沉淀）；4608 小岛分 A/B/C 三类，用户拍板"死代码先落地"；孤岛升级 spec 已落盘待确认，执行侧工具五个能力待补。
---

user:
上游 ZCode 发了 v3.18.0（单 commit 整包同步）。这跟 1.0.x 差多少？能挑着升级吗？

assistant:
base（v3.15.1）→ theirs（v3.18.0）共 6916 个变动源文件：新增 2208 / 删除 2065 / 修改 2488（62% 对调用方完全无感）/ 纯移动 155。文件级闭包在主干会炸成 1793 文件巨块，但符号级（签名没变不往上翻）能把外围收到 3–10 个文件/波。工具链落成 scripts/vendor-{graph,symbols,scope}.mjs，方法论沉淀进 .agents/skills/omz-upgrade/SKILL.md 和 docs/vendor/318/inventory.md。

user:
按闭包拆吧，≤5 文件的小岛有 4608 个，够你升级的了。是不是每升一个孤岛就得 e2e 一次？

assistant:
重新分类后发现 4608 个里 88%（4088）是"整岛全新"——ours 没有这些文件。验证分层：每岛 tsc+自带测试，改运行时行为的岛才跑定向 E2E，Electron 全量留给发布门。第一个岛（scripts/licenses）就撞了险情：4 文件里 2 个被 fork 改过（删了 PROD_REVIEWED 许可复核表），checkout theirs 会覆盖 fork 改动——三方检查拦住并还原了。最终分类：A 类 4088 整岛全新（其中 3180 是测试文件，搬了必红）、B 类 226 纯取岛、C 类 294 需三方合并。

user:
A 类搬过来是死代码——不正是因为死代码才安全吗？等要改重要代码时再搬才容易出问题。

assistant:
同意，且还有一个战略收益：先把树拉近上游，下次同步 delta 就从"新增"变成"修改"，15425 的差距每同步一次被吃掉一块。但"死"分两种：src 里的 ts（没人 import = 运行时/打包零风险，唯一门是 tsc）可以先行；3180 个测试文件是可执行物，vitest 会真跑，必须等功能接线。所以 A 拆 A1（950 src + 55 脚本，现存包）+ A1b（3 个全新包 design-plugin/session-control/plugin-api，要建包脚手架）+ A2（测试随功能）。

user:
先写个 spec，补一条记忆，我要换 session 了。

assistant:
spec 落在 docs/iterations/upstream-v3.18-islands/spec.md：Phase 0 工具补齐（rename 感知/ours==base 守卫/vendor-wave 执行器/wave 账本，探索确认这五个执行能力目前全部零实现）→ A1 现存包分批（shared→server→office-runtime→web→services→desktop→ui→bootstrap/core，一包一 commit）→ A1b 三新包 → B 类 226 岛 → C 类 294 岛（先做基线抽验，v3.16 轮有 83 个假 CLEAN 先例）→ 发布（版本号问用户）。全程 upgrade/318-islands 分支，main 不动。spec 状态：待用户确认。

user:
（换 session 前的最后状态）

assistant:
main = 1.0.34 已发布（MCP 三修复 + 队列 onTurnSettled）；两个只读 worktree 留在 D:/Dev/Js/omz-base（aac47556）与 D:/Dev/Js/omz-318（b95ebaff）；4 个 vendor 工具 commit + inventory.md + omz-upgrade skill 已提交；spec 刚落盘未确认、未开工。下一个 session 从"确认 spec → Phase 0 工具补齐"开始。
