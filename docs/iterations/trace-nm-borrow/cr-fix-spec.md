# trace-nm-borrow CR fix spec

> CR 收敛对象（开发 spec `spec.md` 冻结，仅作 readonly 对照）。
> 分支：trace-nm-borrow；审查基线：`c7478032..14032fea`（12 commits）；CR 修复链：`d350d3a0` + `68e5a57a` + `52de0f2d` + `bd7c29bf` + `778d2929`（J2-5 口径修正）+ `5e9320d6`（spec-check r1 doc-fix，含本文档入库）+ `4db237ae`（spec-check r2 doc-fix，含本文档附录）+ `5d273d97`（spec-check r3 doc-fix，J2-5 降级登记）+ `ea5ea327`（spec-check r4 doc-fix）。权威分支头以 `git rev-parse trace-nm-borrow` 为准；`.iteration-state.yaml` head_sha 为记账基线（可能滞后多个 doc 提交），仅供回溯。
> 纪律：review 子代理只读；must-fix 落本文件；主代理核验后派 fix 节点或直改；fix 后重跑 verify + 复审。

## 元信息

- iteration: trace-nm-borrow（v1.0.18 候选）
- 开发 spec: docs/iterations/trace-nm-borrow/spec.md（v3 + 实现注 1–18，spec-check 3 轮 Go）
- dev-ready: 14032fea（typecheck 0 / parity 5936 / lint 0err / v4-perf 448/448【dev 期口径，CR 修复新增 7 例后为 455/455】/ architecture 0 / e2e-ext 25/25【dev 期口径；CR 期 24 断言 + J2-5 登记行】/ cr-func func-ready）
- 用户真机预验收：配对卡/回合头/新数据路径 OK；「展开」胶囊判接受；旧代际数据回退路径为设计内

## r1 审查结论（4 scope 并行，编号规则：scope 前缀 = 首轮审查；RF- 前缀 = review-full 轮；SC- 前缀 = spec-check 轮；spec 实现注中「r1 CR D-1/D-2/D-3/D-6」等为历史遗留写法，同义。文件简称 = `ModelTrajectory` 前缀省略）

| scope         | ready | P0/P1/P2                                                                    |
| ------------- | ----- | --------------------------------------------------------------------------- |
| A 纯函数      | no    | 0/1/7                                                                       |
| B 配对卡+搜索 | yes   | 0/2/9                                                                       |
| C clamp+Modal | yes   | 0/0/11（编号自 C-P2-2 起，C-P2-1 为未签发空号）                             |
| D 回合头+i18n | no    | 0/1/8                                                                       |
| 合计          | —     | **0 / 4 / 35**（B-P1-2 为 spec 措辞缺口，归 doc 修复；35 条逐条归属见附录） |

## must-fix 总表（条目 → 状态 → 证据）

### P1 总表（r1 四条 P1 + review-full 轮 RF-P1-1，全 landed）

| 编号    | 内容                                                                                        | 状态            | 证据                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-P1-1  | badgeText 零断言 → 补 6 用例（badgeText 5：四分支+空串回退+unknown 无徽标；sidecar-last 1） | landed          | modelTrajectoryToolJoin.test.ts:375-435 + :449-476（`68e5a57a`）                                                                                                                                  |
| B-P1-1  | 配对卡丢 call 侧 input 错误红标 → use 格接 trajectoryToolHasError                           | landed          | ToolPairCard.tsx:83→198→377（`68e5a57a`）                                                                                                                                                         |
| B-P1-2  | spec 措辞缺口（跨分隔符搜索高亮误落 ranges[0]）→ 实现注 8 补全措辞                          | doc 修复 landed | spec.md 实现注 8（`52de0f2d`）；代码锚点 Search.ts:158-177（target 构造区；折叠实现实际在 Search.ts:217-248 normalizeTrajectorySearchText，spec 原文锚点措辞差异已知、记于此行备查——spec 冻结不改）、SearchHighlight.ts:88-99 |
| D-P1-1  | 行 2 truncate 裁掉失败标识 → shrink-0 前缀 + title 兜底                                     | landed          | TurnGroup.tsx:129-134/:127（`d350d3a0`）                                                                                                                                                          |
| RF-P1-1 | C-P2-10 复位后无重测（RO 钳住盒子不触发）→ measuredText 入 layout effect deps               | landed          | ExpandedContent.tsx:92 / ClampedPreview.tsx:73（`bd7c29bf`）                                                                                                                                      |

### P2 代码修（18 条，全 landed；commit 归属见执行记录；其余 17 条为 doc 登记 / OQ / 发布挂账，见附录归属表）

A-P2-1（badgeText `||` + call 侧 `|| "tool"` 双兜底，ToolJoin.ts:73-74）、A-P2-2（filterTrajectoryInputRows slice，ToolJoin.ts:277-281）、A-P2-3（sidecar 尾部判 missing 用例，test:449-462）、A-P2-4（key 家族来源注释，modelTrajectoryToolJoin.test.ts:327-329）、A-P2-6（unknown displayText 并入 raw + raw pre 补挂 content 字段 + rawText helper 单源迁入，ToolJoin.ts:138-178 + ToolPairCard.tsx:73-75/:363-371）、B-P2-1（showAll 收起复位，ToolPairCard.tsx:332-337）、B-P2-2（溢出测量依赖补 text/rawText/placeholder，:313-318）、B-P2-7（注释上/下，:41）、C-P2-2（遮罩现算清零，ExpandedContent.tsx:42-48/:117）、C-P2-3（容差回 2px，Clamp.ts:23——spec T-N3 已补 2px 锚点）、C-P2-4（内容盒 pb-0 + 外层 pb-2/pb-12，ExpandedContent.tsx:129-139）、C-P2-5（焦点归位 capture/restore，MessageView.ts:78-95 + MessageDialog.tsx:42-44）、C-P2-6（标题 aria-hidden）、C-P2-7（Dialog w-[calc(100%-2rem)] max-w-3xl）、C-P2-8（空正文入口不渲染，trim 口径）、C-P2-9（删死属性）、C-P2-10（溢出态随内容重置 + measuredText 重测，渲染期 setState）、D-P2-3（en 去冒号，en-US.ts:1080）。

### RF-P2（6 条，全 landed 或注释化收口）

RF-P2-1（badgeText result 侧空串档位语义 → 实现注 18 登记）、RF-P2-2（短内容留白 → 外层无条件 pb-2，`bd7c29bf`）、RF-P2-3（失败段渲染前置与纯函数序不一致 → 实现注 15 登记）、RF-P2-4（capture 排除 body，`bd7c29bf`）、RF-P2-5（close 死路径 → 注释化契约，`bd7c29bf`）、RF-P2-6（T-N3 容差数值锚点，spec 已补）。

### spec/文档修订（doc 批 `52de0f2d` + 收口批 `bd7c29bf`，全 landed）

实现注 7/8/9 修订（use 格红标落地、ranges[0] 误高亮措辞、badgeText 双兜底）；注 10–18 新增（displayText 空段、charCount 分隔符公式、查看全文恒渲染口径、unknown 命令槽、errorCount 死字段、失败段渲染前置、重测与留白口径、Provider 硬前置与焦点归位、badgeText 空串档位与 text-ui-sm 观感）；契约 3 徽标单源措辞；接口块补 pairedResultToolName/Id；charCount 公式澄清；T-N3 容差锚点；T-N4 补「窄侧栏失败标识可见」（SC-P1-2）。

## 发布期待办（独立挂账，发布链按此执行；SC-P1-3 集中）

CHANGELOG v1.0.18 用户向条目（4 条）：

1. **O-3 徽标真名优先**：配对卡徽标优先取 result part 真实工具名；兜底名（"tool"）仅无结果时出现——搜兜底名不再命中已配对调用（搜索行为变化，A-P2-1/实现注 9）。
2. **D-P2-7 错误标识口径变更**：回合错误图标不再含 sidecar 辅助调用失败；工具调用失败（status=error）新增点亮图标与「N 失败」计数。
3. **D-P2-8 DOM 锚点替换**：`data-trajectory-turn-stats` → `data-trajectory-turn-meta`（外部脚本若有依赖需同步）。
4. 新增功能条目：工具配对卡 / 回合头计数行 / 6 行 clamp + 查看全文全屏 / 搜索自动展开定位（对应用户向描述）。

其他：真机 manual T-N4 清单（含窄侧栏失败标识可见）；e2e 脚本是否登记 package.json（待拍板）。附录中 4 条「原文佚失」条目（A-P2-7/B-P2-4/B-P2-8/D-P2-4）按推定归类，未经 r1 原文实证——若后续找回 r1 原始报告需重核。

## 附录：r1 35 条 P2 逐条归属表（SC2-P1-2 落表）

> r1 四 scope 原始报告未入库且不可恢复（git 全历史检索无更早来源）；下表按编号空间重建（7+9+11+8=35，C scope 编号自 2 起），「原文摘要」为二手痕迹（CR 摘要/spec 实现注/源码注释）复原。
> 处置类别：代码修 = 现仓库文件:行核到；spec 注 = 仅实现注登记；OQ = open questions 留观；发布挂账 = CHANGELOG/发布清单。

| ID      | scope 原文摘要                              | 处置                  | 落点                                                 |
| ------- | ------------------------------------------- | --------------------- | ---------------------------------------------------- |
| A-P2-1  | badgeText `\|\|` 双兜底                     | 代码修                | ToolJoin.ts:73-74 + 注 9 + 发布挂账条目 1            |
| A-P2-2  | filterTrajectoryInputRows 返回副本          | 代码修                | ToolJoin.ts:277-281                                  |
| A-P2-3  | sidecar 尾部判 missing 用例                 | 代码修（测试）        | modelTrajectoryToolJoin.test.ts:449-476              |
| A-P2-4  | key 家族来源注释（手抄旧模板处）            | 代码修（测试注释）    | modelTrajectoryToolJoin.test.ts:327-329（68e5a57a）  |
| A-P2-5  | stats.errorCount 无生产消费者               | spec 注 14 + 代码注释 | Turns.ts:201-206                                     |
| A-P2-6  | unknown displayText 并入 raw + content 字段 | 代码修 + 注 10        | ToolJoin.ts:138-178、ToolPairCard.tsx:363-371        |
| A-P2-7  | **scope 原文佚失（不可恢复）**              | 以处置为准            | 推定：被 A-P2-1/2/6 与注 9/10 吸收或原为观察项       |
| B-P2-1  | 收起复位 showAll                            | 代码修                | ToolPairCard.tsx:332-337                             |
| B-P2-2  | 溢出测量依赖补内容                          | 代码修                | ToolPairCard.tsx:313-318                             |
| B-P2-3  | observer 量性能观察                         | OQ                    | open questions 第 1 条                               |
| B-P2-4  | **scope 原文佚失（不可恢复）**              | 以处置为准            | 推定：被契约 1–9 或相邻 P2 吸收                      |
| B-P2-5  | unknown 命令槽沿用 tool-call                | spec 注 13            | 判定接受                                             |
| B-P2-6  | 配对卡查看全文恒渲染口径                    | spec 注 12 + 代码注释 | ToolPairCard.tsx:213-217                             |
| B-P2-7  | 注释左右→上下                               | 代码修（注释）        | ToolPairCard.tsx:41                                  |
| B-P2-8  | **scope 原文佚失（不可恢复）**              | 以处置为准            | 推定：被相邻 P2 或 spec 契约吸收                     |
| B-P2-9  | 默认展开回合高度观感                        | OQ                    | open questions 第 2 条                               |
| C-P2-2  | 渐隐遮罩现算清零                            | 代码修                | ExpandedContent.tsx:42-48/:117                       |
| C-P2-3  | clamp 容差回 2px                            | 代码修 + T-N3 锚点    | Clamp.ts:23                                          |
| C-P2-4  | 内容盒 pb-0 + 外层留白                      | 代码修                | ExpandedContent.tsx:129-139                          |
| C-P2-5  | 全屏焦点归位                                | 代码修                | MessageView.ts:78-95、MessageDialog.tsx:42-44        |
| C-P2-6  | 可见标题 aria-hidden                        | 代码修                | MessageDialog.tsx:70                                 |
| C-P2-7  | Dialog 窄视口宽度                           | 代码修 + 注 16        | MessageDialog.tsx:60-64                              |
| C-P2-8  | 空正文入口不渲染                            | 代码修                | ExpandedContent.tsx:125/:220、ClampedPreview.tsx:105 |
| C-P2-9  | 删死属性                                    | 代码修                | 已移除（全仓零命中）                                 |
| C-P2-10 | 溢出态随内容重置                            | 代码修 + 注 16        | ExpandedContent.tsx:59-68、ClampedPreview.tsx:49-56  |
| C-P2-11 | Provider 硬前置 throw                       | spec 注 17 + 代码     | MessageView.ts:64-68                                 |
| C-P2-12 | useZCodeIntl 风格不动                       | 判定不修              | OQ 第 5 条                                           |
| D-P2-1  | stats.errorCount 死字段（同 A-P2-5 落点）   | spec 注 14            | Turns.ts:201-206                                     |
| D-P2-2  | charCount use 段一次 join 口径              | spec 注 11 + 单测锁定 | TurnCounts.ts:55-59/:83、test:150-177                |
| D-P2-3  | en-US 去冒号                                | 代码修                | en-US.ts:1080                                        |
| D-P2-4  | **scope 原文佚失（不可恢复）**              | 以处置为准            | 推定：被相邻 P2 或实现注吸收                         |
| D-P2-5  | estimateSize 64 vs ~50                      | OQ                    | open questions 第 3 条                               |
| D-P2-6  | charCount stringify 成本                    | OQ                    | open questions 第 4 条                               |
| D-P2-7  | 错误标识口径变更                            | 发布挂账 + 注 2       | TurnCounts.ts:26/:30-31/:111、TurnGroup.tsx:219-223  |
| D-P2-8  | DOM 锚点替换                                | 发布挂账              | TurnGroup.tsx:125（8847aeca）                        |

合计：代码修 18 + spec 注 6（A-P2-5 与 D-P2-1 同为实现注 14；余为 B-P2-5、B-P2-6、C-P2-11、D-P2-2）+ OQ 5（B-P2-3/9、C-P2-12、D-P2-5/6）+ 发布挂账 2（D-P2-7/8，A-P2-1 代码修兼挂账）+ 原文佚失 4（A-P2-7、B-P2-4、B-P2-8、D-P2-4）= 35 ✓（C-P2-1 为未签发空号不在表内）。

## open questions（不阻塞）

- B-P2-3 observer 量（2N/回合）性能真机观察
- B-P2-9 配对卡默认展开回合高度/estimateSize 观感
- D-P2-5 estimateSize 64 vs 实测 ~50（首屏跳动观察）
- D-P2-6 charCount JSON.stringify 重算成本
- C-P2-12 useZCodeIntl 风格（不动）

## 执行记录

- r1 四 scope 并行审查（0 P0 / 4 P1 / 35 P2，见上表口径）
- fix-ab `68e5a57a`：A 批 6 条 + B 批 3 条（偏差 4 条均合理：badgeText call 侧双兜底、unknown raw pre 补挂 content 字段、sidecar-last 用例自然成立、sibling 之上重验全绿）
- fix-cd `d350d3a0`：D-P1-1 + C 批 9 条 + D-P2-3（偏差：C-P2-5 原语放 MessageView.ts；C-P2-10 渲染期 setState；C-P2-8 trim 判空——均合理）
- doc 批 `52de0f2d`：spec 实现注修订 + Turns.ts errorCount 死字段注释
- review-full 末轮：16/16 P2 + 3/3 P1 landed；判 no——RF-P1-1（fix 引入）+ 6 P2 + doc 登记遗漏
- 收口批 `bd7c29bf`：RF-P1-1 + RF-P2-2/4/5 + RF-P2-1/3/6 登记 + spec 注 15–18
- spec-check r1（对本文档）：4 P1 + 6 P2，全记账层——SC-P1-1 e2e J2-5 实跑红（raw 28 vs mapped 35：**计数为跨 session 重复相加**，集合级一致）；SC-P1-2 T-N4 缺窄侧栏条目；SC-P1-3 发布挂账分散；SC-P1-4 数量口径自相矛盾。doc-fix：J2-5 改集合包含断言（`778d2929`，当时复跑 25/25；后见 r3 段——数据继续漂移证明两口径无稳定包含关系，最终降级为登记）、本文档重构（总表+编号规则+发布挂账集中+口径统一）、spec T-N4 补条目、iteration-state 同步
- spec-check r2：代码/行为层全部独立验证过（typecheck 0 / lint 0 / parity 5936 / v4-perf 455/455 / e2e 25/25【当时口径】/ 5 锚点抽查成立），判 No-Go 仍为记账层——SC2-P1-1 iteration-state 重复键（严格解析失败）；SC2-P1-2 数量口径未真闭合（16 vs 18、10 条无归属）。doc-fix：重复键已修（YAML 可解析）；P2 代码修改口径 18 条；附录新增 35 条逐条归属表（r1 原始报告未入库不可恢复，按编号空间重建，4 条原文佚失显式标注）；B-D1/D1 悬空 ID 替换；锚点订正（MessageView.ts 78-95、A-P1-1 6 用例）；v4-perf 双口径注明；文件简称规则说明
- 最终验证：typecheck 0 错、test:v4-perf 455/455、e2e-tool-join 24/24 + J2-5 口径差异登记行（两口径无稳定包含关系，非缺陷信号）、oxlint 0err；oxfmt 本迭代源码干净 + yaml/cr-fix-spec 已对齐；spec.md 冻结不做 oxfmt（其对嵌套代码围栏有重排，语义等价但保持入库原样）
- spec-check r3：代码层零缺陷、7 门禁实跑全绿（typecheck 0 / lint 0err / parity 5936 / v4-perf 455/455 / architecture 0 / e2e 25/25【当时口径】/ oxfmt 干净），No-Go 仅 3 P1 + 4 P2 单行文本：HEAD 指针口径、P1 总表缺 B-P1-2 行、A-P2-4 锚错文件（ToolJoin.ts:102/:113 → test:327-329）。doc-fix：HEAD 口径改 git rev-parse、P1 总表补 B-P1-2（5 行）、正文 A-P2-4 落点订正为 test:327-329（附录行当时漏改，r4 补）、合计行括注改写、yaml cr 链补 778d2929、e2e 括注条件式（后随 J2-5 降级被取代）、佚失条目推定声明入发布期待办。r3 doc-fix 复跑时数据又漂移（records 430→437，raw=33 > mapped=30 反向）——三次实测三方向证明两层口径（消息级 isError vs output error-text）在动态真库上不可方向断言，J2-5 最终降级为信息登记行（双向差集计数，非缺陷信号），断言总数 25→24；「services 映射未丢 isError」由 J2-4 与 join 单测覆盖
- spec-check r4：r3 七项（3P1+4P2）中六项闭合，判 No-Go 仅 1 P1——附录 A-P2-4 行漏改（r3 只改正文）+ 执行记录「附录/正文」不实陈述；另 6 P2（e2e 脚本新旧注释矛盾、yaml head_sha 滞后量词、25/25 口径括注、B-P1-2 锚点措辞、yaml spec-check 轮次、简称混用）。doc-fix（`ea5ea327`）：附录 A-P2-4 补订正、r3 段措辞如实化（七项口径）、L4 滞后量词删除、25/25 补【当时口径】、B-P1-2 证据行补折叠实现真实锚点（Search.ts:217-248 normalizeTrajectorySearchText，spec 原文锚点 158-177 指 target 构造区）、e2e 旧注释改一致口径、yaml spec-check 推 r4
- spec-check r5（最终轮）：**Go（execute-ready）**——r4 八项实质闭合（七项完全、一项主体闭合），本轮独立实跑零缺陷（typecheck 0 / lint 0err / parity 5936 / v4-perf 455/455 / architecture 0 / e2e 24/24 + J2-5 登记行 / oxfmt 迭代文件全清），35 条附录锚点逐行回读全部命中真实代码；剩 4+1 条 P2 全为一行文本（OQ 悬空指针、r3 计数六/七、锚点 449-462 截断、修复链漏 5d273d97、历史 25/25 括注），审查者判定无需 r6，随本批 doc-fix 趁热清零
- **fix-spec-ready: yes**
