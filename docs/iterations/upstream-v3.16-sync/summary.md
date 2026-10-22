# 上游 v3.15.1 → v3.16.2 同步评估汇总

日期：2026-10-22 · 分支：trace-nm-borrow · 快照：`.reference/ZCode` 已更新至 v3.16.2 @ `3c5b2276`（UPSTREAM-SYNC.md 基线表已同步）

## 输入事实

- 上游两个新 squash 提交：`0a1fc56d`（v3.16.1，10-19）、`3c5b2276`（v3.16.2，10-20）；无内部历史，只能整段 diff 甄别。
- 总量：4579 文件（+1693 新增 / 2535 修改 / 307 删除），+365,731 / −124,850 行（含锁文件）。
- 交集（fork 自 baseline/v3.14.3 改过 ∩ 上游本轮改过）：**378 文件** → 丢弃 81 / 人工适配-分叉 174 / 低摩擦重放 123。
- 唯一新增 workspace 包：`apps/zcode-cli/packages/office-runtime`（+4 个文档插件包依赖它）。
- Node 版本要求未变（24.14.0 / pnpm@10.33.2）；新增 patch：`@radix-ui/react-collapsible@1.1.12`（fork patches/ 需连带带入）。

## 结构性前置决策（先于一切移植）

**v3.15.1 基线政策。** fork 从未整体合入 v3.15.1：378 个交集文件里 237 个仍是 v3.14.3 底子；`git merge-file` 报 CLEAN 的有 83 个是假阳性（打在错误基线上，其中 78 个文件的 3143→3162 全量增量比 v3.16 增量还大 50 行以上）。任何「重放/适配」动手前必须先拍板：补 v3.15.1 基线（按 baseline/v3.14.3..3c5b2276 估工作量），还是本轮显式跳过这 83 个文件。详见 analysis-intersection.md。

## 分层结论

### A. 建议直接移植（S，缺陷修复/小改，撞红线风险低）

| # | 项 | 来源报告 |
|---|---|---|
| A1 | UI 基础组件 5 修复：dialog "Close" 硬编码走 i18n、collapsible 嵌套 `group/` 淡出被祖先覆盖（轨迹面板在用）、kbd 未定义 `muted` token、dropdown sub-trigger indicator 插槽、tooltip `alwaysDelay` | analysis-ui.md T10 |
| A2 | CLI 旧 `config.json` 导入丢 `maxOutputTokens`（omz 同款 bug，评测刚需） | analysis-cli.md #10 |
| A3 | dynamic-workflows skill 提示词加固「不擅自跨 provider 换子代理模型」（纯文本） | analysis-cli.md #10 |
| A4 | `thoughtLevelLabels.ts` 档位表外提（纯重构，为 C3 铺路） | analysis-ui.md T09 |
| A5 | server 静态路由路径穿越测试（+100） | analysis-services.md #10 |
| A6 | `localUsageEvidence`（+163，修复线上引导误弹） | analysis-services.md #10 |
| A7 | `fileApplications.ts`（+321，独立新文件） | analysis-services.md #10 |

### B. 值得做（M，需人工适配但收益明确）

| # | 项 | 关键注意 | 来源 |
|---|---|---|---|
| B1 | side-pane-full-view 面板全屏视图（+1210，⇧⌘F） | 前置件齐备，需与 project-sidebar 解耦后摘 | analysis-ui.md T03 |
| B2 | i18n locales 键级合并（上游 zh +1273 键 / omz 自有 228 键） | **绝不能整文件覆盖**（会丢 modelTrajectory.* 中文文案）；顺手清 20+ 条 conversationShare.* 死键 | analysis-ui.md T07/T04 |
| B3 | 模型创建失败→终态落库（+379 子集） | 去掉 highspeed/selectionFallback 分支 | analysis-cli.md #6 |
| B4 | ToolCallBlocks 缺陷子集（内嵌图片终态收口等） | 只摘缺陷，解耦全量不做 | analysis-ui.md T08 |
| B5 | `windowRemoteConnectionRegistry` transitionEpoch 竞态修复（epoch 换代/回滚） | 通用竞态修复可独立抽出；handle `dispose()` 签名变化波及 omz 全部实现 | analysis-services.md #7 |
| B6 | autoUpdater 两个缺陷点 + `auto-update-install-reentry-smoke.mjs` 冒烟门槛 | fork 分叉 −1924 行，只摘点不搬面 | analysis-services.md #8 |
| B7 | DB 迁移 4 条（0004_project_execution_scopes / 0006_task_group_admissions / 0004_controller_remote_identity / 0005_source_server_workspace_schema） | 账本与 checksum 算法兼容；上游 0004 双 scope 同号，移植须改全局唯一编号；后两条依赖 source-server 系，仅在被采纳时随迁 | analysis-services.md #2 |
| B8 | v4 可选增量：`provider/refreshRegistry`、`runtimeInitialization`、`sessionsIndexReconcile`、`lastOutcome` | 守卫逻辑单点评估，不整体搬 v4 网关 | analysis-cli.md #4 |
| B9 | remote-connection 纯 UI 缺陷档（SSH alias、Docker/WSL 提示二分、端口校验、聚焦跟随） | 档 A；档 B（三屏向导）依赖 source-server 主链，随 D2 拍板 | analysis-ui.md T02 |
| B10 | windows 任务栏未读角标 overlay（+313） | 独立 | analysis-services.md #10 |

### C. 需用户拍板（L，产品/体验方向）

| # | 项 | 争议点 | 来源 |
|---|---|---|---|
| C1 | chat-input-toolbar 模型+Think 档位合并入口 | **红线 2 冲突点**：`contextUsage.tsx`（fork 自研 Magic Context 面板 474 行）与上游同文件改动必须逐行合并 | analysis-ui.md T09 |
| C2 | `buildUserMessageEntries` 装配统一（+444/−346） | 直接命中 magic-context turn-transform（87KB 双向投影），不能逐字重放 | analysis-cli.md #5 |
| C3 | `cli-default-selection.ts` CLI 默认选择与 Session 选择分离（+58） | Off-Peak 主线不移植，此项可单独评估 | analysis-cli.md #3 |

### D. 不建议移植（产品线/撞红线/P0 风险）

| # | 项 | 原因 | 来源 |
|---|---|---|---|
| D1 | source-server R3 远程架构（+10000） | omz 零基线；上游删旧主链不留双链，半移植比不移植更糟；应独立立项 | analysis-services.md #4 |
| D2 | 远程连接三屏向导（档 B）/ project-sidebar 虚拟项目 / project-storage 全家（+4000） | 依赖 D1 的 SourceServerRecord/ConnectionProfile/sourceServerId；等于引入产品线 | analysis-ui.md T01/T02、analysis-services.md #6 |
| D3 | web-remote relay v2 | omz 无任何 web-remote-control 实现（v3.15.1 的 9 个文件 omz 就没有），属产品引入非同步 | analysis-services.md #5 |
| D4 | ToolSearch / DeferredToolCall（+8171） | omz 无工具规模爆炸动机；`prepareRuntimeProviderRequest` 改动撞 magic-context 插入点 | analysis-cli.md #1 |
| D5 | office-runtime + 4 文档插件（+13258） | 产品边界冲突 + 22 个新依赖（pdfjs/playwright-core 等）许可与体积面，单独开轮 | analysis-cli.md #2 |
| D6 | Off-Peak 闲时任务生命周期 | omz 已删官方端点/闲时 server | analysis-cli.md #3 |
| D7 | conversation-share 重构 | omz 已删整条分享链；`zcode://share/import` 撞红线 4 | analysis-ui.md T04 |
| D8 | `includeArchived` 协议移除 | **P0 数据风险**：omz `repairSubagentTaskIndex.ts` 活跃依赖，跟了会致老库历史任务误删 | analysis-services.md #3 |
| D9 | telemetry 增量（shared/telemetry.ts +153、v4/telemetry.ts +10、withPluginTelemetry） | 红线 1；v4/telemetry 依赖已删的 sanitizeTelemetrySkillName，**必须成对不移植**否则编译断 | analysis-services.md #10 |
| D10 | `.oxlintrc.json` max-lines 400→800 + 豁免名单 | fork 更严是刻意选择（trace-nm-borrow 刚按 400 设计）；只挑必要条目 | analysis-intersection.md |
| D11 | settings SourceServer/archives 分区、`test-ids` 子路径迁移（120 文件） | 依赖 D1 / 零功能价值高噪音 | analysis-ui.md T06/T16 |

## 红线与品牌注意（移植任何项时通用）

- 上游新代码写死 `~/.zcode/cli/db/db.sqlite`、`ZCODE_SESSION_DB_PATH`、`publicZCodeErrorCodeSchema` 等字面量——**路径漏改会让修复静默失效**（红线 4）。
- `packages/shared` 的 exports 拆分是 ui/web 大量改动的隐形前置：omz 缺 `sourceServerId`（52 文件依赖）、`parseRemoteWorkspaceIdentity`（18）、`ConnectionProfile`（11）等符号，不采纳 D1/D2 时这些引用必须一并剔除。
- 上游 424 个 CLI 测试文件（+20544 行）在 omz 无法直接重放：omz 无 vitest、测试全是包内 `scripts/test-*.mjs`——「带测试搬」按逐条重写计成本。

## 报告索引

- `analysis-ui.md` — packages/ui/src + packages/web/src（16+ 主题）
- `analysis-cli.md` — apps/zcode-cli 全部（19 主题）
- `analysis-services.md` — services/desktop/server/shared/relay（25 主题，含 DB 迁移逐条与协议变更逐条）
- `analysis-intersection.md` — 378 交集文件三档处置 + 热点 60 逐文件表 + 根配置/依赖面
- `fork-upstream-intersection.txt` / `upstream-v3.15.1-to-v3.16.2-filelist.txt` — 原始清单
