# upstream-v316-fullsync dev-ready 报告

日期：2026-10-23 ｜ 分支：`upstream-v316-fullsync`（worktree `D:\worktree\fullsync`）｜ 基线：v1.0.20 @ `1ff8cad9` ｜ HEAD：见文末提交链

## 结论

**dev-ready：是**（自动化门禁全绿；真机 QA 挂账清单见 §5，不阻塞 dev-ready，发布前须验收）。上游 v3.16.2 产品面按用户拍板「五项全保留」全量纳入；三条产品政策贯穿：①历史任务可删（includeArchived 跟上游语义）②UI 以 omz 现状为准（骨架/接入点 omz，存储/模型/逻辑层照搬）③MC 三端口重接或零触碰+全套回归门禁。

## 1. 阶段交付（P0-P8 全部 func-ready）

| 阶段 | 内容 | 关键拍板/定案 | 审查 |
|---|---|---|---|
| P0 i18n | 6318 键×2 对称；采纳 419/仲裁 138/死键清 165/品牌 89+91 | --verify 幂等门禁常驻 | func-ready |
| P1 C1 合并入口 | 6 组件 verbatim 迁移+V4ComposerToolbar 接线；T-CP2 7/7 | ThoughtLevelCycleControl=在场退场/缺席保底；MC contextUsage 零触碰 | func-ready |
| P2 C2 组包统一 | buildUserMessageEntries 单一装配；T-AS 30/30 | MC 三端口零改动；4 项 hydrator 漂移登记（恢复向 live 收敛） | func-ready |
| bug A/B 热修 | 编辑历史旧内容（rAF 竞态）；中断队列不收输入（24af3955 误删 return;） | held 路由 choice→enqueue；立即发送=恢复；执行层对称修复 | func-ready |
| P3 vproj-storage | 7 存储目录+scope 三分 sqlite-migrations；0004/0005 逐字节冻结 | checksum=16dc0d2c/f9b295f5 基准测试锁死；同号不同 id 不撞账本 | func-ready |
| P4 vproj-ui | 三批 13 commits：壳层/UI 提交链/tabStore 键/未读信号/lineage walk | 上游 grouped 批 omz 化剔除面+max-lines 豁免纪律 | func-ready |
| P5 R3 一期 | source-server 契约/transport/daemon 链（572/572） | 品牌拍板=zcode-server 归档名保留族；一期排除面→三期解禁 | func-ready |
| P6 R3 二期 | ConnectionManager 薄层+registry 恢复状态机+换代链+B5 吞并 | 上游原生时序（open issues 005-024 族）按 spec 登记 | func-ready |
| P7 R3 三期 | r3c/r3d/r3e 三批 15 commits：directory/aliasRepo/身份迁移+主链切换+host 服务+Remote* 回填 | workspaceIdentity=本机键规则不变+remote:server: identity；向导壳按「UI 保 omz」关闭（拍板 A）；admitConnection 裁量不补 | func-ready |
| P8 ToolSearch+relay 清理 | 推演修正落地序（暴露决策→公告→MC transform→双投影）+搬入 8 面位+冒烟集；relay v1 全仓 0 残留 | spec 预定序不可行（MC 文本化丢 tool_reference）走推演修正通道；D4=0（内存元数据载体口径）；native×MC 降级面登记 | func-ready |

## 2. Step 21 全门禁终态

| 门禁 | 结果 |
|---|---|
| 根 typecheck（12 工程） | 0 错 |
| typecheck:desktop-full | 54 error kinds（基线 366、无新增；gate OK） |
| lint | **49w/0e，exit 0**——docs/** 出产品范围；本迭代触碰面 22 条 unused 清零（commit e33548d2）；剩余 49 全为基线存量未触碰文件 |
| oxfmt --check | 触碰面 0 违规（14 文件归一 f2bb2857）；基线存量 96 登记（v1.0.20 blob 实证存量，非本迭代引入）；docs/** 同口径豁免 |
| knip | 终态基线 `cache/gate-knip.json`：474 文件 1346 项；触碰面 264=豁免 222（14 组挂账依据）+存量 42+删 0（8438de78） |
| test:v4-perf | 46 段 **654 pass / 0 fail** |
| test:cli-backport | 4/4 段全绿（fail 0） |
| i18n verify | zh/en 6318 键对称；仲裁 89/91；品牌 0；幂等一致 |
| T-RU/T-TS/T-VU/T-RD 等本迭代用例 | 全绿（61+13+10+5+5+13+11+2 等，均挂 v4-perf） |

## 3. 产品政策执行记录

- **UI 保 omz**：向导壳族（remote-connection-flow 2185L+DialogContent/Fields 重写）按拍板 A 关闭——omz 现有 RemoteConnectionDialog/SSHDialog 链即连接入口（已走 daemon 主链）；上游 project-sidebar UI 不成套进，Remote* 回填按缝位融入 omz 侧栏。
- **MC 红线**：三批次全零触碰 magic-context 源码；ToolSearch 推演文档证明 MC transform 无 tools 通道；MC 全套 654/0。
- **品牌**：ZCODE_* env 保留族（含新 ZCODE_REMOTE_DEPLOY_SERVER_LEGACY）；zcode-server 归档名/.omz 口径；i18n 品牌改写 89+91。
- **deployServer 旧链**：零删除共存+逃生开关，退役拍板留发布轮。

## 4. 偏差登记（spec_deviations 全册）

closed：i18n 四项/落地序修正/行数漂移/YAML 修复等；open（4 项 DEV-bugB-1~4 均用户拍板留档）+D4 口径（内存元数据载体）。详见 `.iteration-state.yaml`。

## 5. 挂账清单（发布前须验收/处置）

**真机 QA**：T-CP3（合并入口三态）/T-VU2（项目树/归档/分组/编辑/新建）/T-RM3（SSH 端到端）/T-RM4（WSL-Docker 断连恢复/换代/升级）/T-QA-bugAB（编辑历史+中断队列复测）/T-RU5（远端矩阵并入 RM3/RM4）。

**P3 挂账**：entries 表+resolveHost 路由+legacySingleRoot+RemoteProjectPicker 挂载+ProjectCreation 设备选择面。
**P9/发布轮挂账**：management 服务+registry+设置设备卡+设备设置跳转；deployServer 退役拍板；remote-viewing 状态回填（relay v2 面缓行）。
**已知限制**：native ToolSearch×MC 文本化丢失（local 为主形态）；跨重启公告状态重置（重开全量公告一次）。

## 6. 提交链

1ff8cad9（v1.0.20 基线）→ 88+ commits → HEAD（本报告提交后）。主干锚点：a8106a4f 引导 / 28a9dc98 i18n / 3aa48309 C1 / 5d8396ff C2 / 52a99a96 bugAB+P3 vps / 13aaaeda P4 / 9807c415 P5 / 906f5ea6 P6 / 19386af6 P7 / 7c99f75e P8 / e33548d2 lint / f2bb2857 oxfmt / 8438de78 knip。

## 7. 后续

1. 真机 QA 矩阵验收 → 修真机发现 → 合 main 发版（CHANGELOG 已备「未发布」段）。
2. U5-U12（upstream-v3.16-backport 分支）回归合流评估。
3. relay v2 / server 直连传输 / ToolSearch native 形态：待外部基础设施/后续轮评估。
