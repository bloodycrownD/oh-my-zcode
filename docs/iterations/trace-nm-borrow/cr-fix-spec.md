# trace-nm-borrow CR fix spec

> CR 收敛对象（开发 spec `spec.md` 冻结，仅作 readonly 对照）。
> 分支：trace-nm-borrow；审查基线：`c7478032..14032fea`（12 commits）；CR 修复链：`d350d3a0` + `68e5a57a` + `52de0f2d` + `bd7c29bf` + `778d2929`（J2-5 口径修正），HEAD `778d2929`。
> 纪律：review 子代理只读；must-fix 落本文件；主代理核验后派 fix 节点或直改；fix 后重跑 verify + 复审。

## 元信息

- iteration: trace-nm-borrow（v1.0.18 候选）
- 开发 spec: docs/iterations/trace-nm-borrow/spec.md（v3 + 实现注 1–18，spec-check 3 轮 Go）
- dev-ready: 14032fea（typecheck 0 / parity 5936 / lint 0err / v4-perf 448/448 / architecture 0 / e2e-ext 25/25 / cr-func func-ready）
- 用户真机预验收：配对卡/回合头/新数据路径 OK；「展开」胶囊判接受；旧代际数据回退路径为设计内

## r1 审查结论（4 scope 并行，编号规则：scope 前缀 = 首轮审查；RF- 前缀 = review-full 轮；SC- 前缀 = spec-check 轮）

| scope | ready | P0/P1/P2 |
|---|---|---|
| A 纯函数 | no | 0/1/7 |
| B 配对卡+搜索 | yes | 0/2/9 |
| C clamp+Modal | yes | 0/0/11 |
| D 回合头+i18n | no | 0/1/8 |
| 合计 | — | **0 / 4 / 35**（B-P1-2 实为 spec 措辞缺口，归 doc 修复） |

## must-fix 总表（条目 → 状态 → 证据）

### P1（4 条，全 landed）

| 编号 | 内容 | 状态 | 证据 |
|---|---|---|---|
| A-P1-1 | badgeText 零断言 → 补 7 用例（四分支+空串+unknown+sidecar-last） | landed | modelTrajectoryToolJoin.test.ts:375-435 + sidecar 用例（`68e5a57a`） |
| B-P1-1 | 配对卡丢 call 侧 input 错误红标 → use 格接 trajectoryToolHasError | landed | ToolPairCard.tsx:83→198→377（`68e5a57a`） |
| D-P1-1 | 行 2 truncate 裁掉失败标识 → shrink-0 前缀 + title 兜底 | landed | TurnGroup.tsx:129-134/:127（`d350d3a0`） |
| RF-P1-1 | C-P2-10 复位后无重测（RO 钳住盒子不触发）→ measuredText 入 layout effect deps | landed | ExpandedContent.tsx:92 / ClampedPreview.tsx:73（`bd7c29bf`） |

### P2 代码修（16 条，全 landed；commit 归属见执行记录）

A-P2-1（badgeText `||` + call 侧 `|| "tool"` 双兜底，ToolJoin.ts:73-74）、A-P2-2（filterTrajectoryInputRows slice，ToolJoin.ts:280）、A-P2-6（unknown displayText 并入 raw + raw pre 补挂 content 字段，ToolJoin.ts:146-178 + ToolPairCard.tsx:367）、A-P2-3（sidecar 尾部判 missing 用例）、A-P2-4（旧模板来源注释）、B-P2-1（showAll 收起复位，ToolPairCard.tsx:333-337）、B-P2-2（溢出测量依赖补 text，:314-318）、B-P2-7（注释上/下，:41）、C-P2-2（遮罩现算清零，ExpandedContent.tsx:117）、C-P2-3（容差回 2px，Clamp.ts:23——spec T-N3 已补 2px 锚点）、C-P2-4（内容盒 pb-0，:139）、C-P2-5（焦点归位 capture/restore，MessageView.ts:76-91 + MessageDialog.tsx:42-44）、C-P2-6（标题 aria-hidden）、C-P2-7（Dialog w-[calc(100%-2rem)] max-w-3xl）、C-P2-8（空正文入口不渲染，trim 口径）、C-P2-9（删死属性）、C-P2-10（溢出态随内容重置，渲染期 setState）、D-P2-3（en 去冒号，en-US.ts:1080）。

> 注：上表 16 条含 A-P2-3/A-P2-4（原在 must-fix 段外、随 fix-ab 落地，此处收编入表）。

### RF-P2（6 条，全 landed 或注释化收口）

RF-P2-1（badgeText result 侧空串档位语义 → 实现注 18 登记）、RF-P2-2（短内容留白 → 外层无条件 pb-2，`bd7c29bf`）、RF-P2-3（失败段渲染前置与纯函数序不一致 → 实现注 15 登记）、RF-P2-4（capture 排除 body，`bd7c29bf`）、RF-P2-5（close 死路径 → 注释化契约，`bd7c29bf`）、RF-P2-6（T-N3 容差数值锚点，spec 已补）。

### spec/文档修订（doc 批 `52de0f2d` + 收口批 `bd7c29bf`，全 landed）

实现注 7/8/9 修订（use 格红标落地、ranges[0] 误高亮措辞、badgeText 双兜底）；注 10–18 新增（displayText 空段、charCount 分隔符公式、查看全文恒渲染口径、unknown 命令槽、errorCount 死字段、失败段渲染前置、重测与留白口径、Provider 硬前置与焦点归位、badgeText 空串档位与 text-ui-sm 观感）；契约 3 徽标单源措辞；接口块补 pairedResultToolName/Id；charCount 公式澄清；T-N3 容差锚点；T-N4 补「窄侧栏失败标识可见」（SC-P1-2）。

## 发布期待办（独立挂账，发布链按此执行；SC-P1-3 集中）

CHANGELOG v1.0.18 用户向条目（4 条）：
1. **O-3 徽标真名优先**：配对卡徽标优先取 result part 真实工具名；兜底名（"tool"）仅无结果时出现——搜兜底名不再命中已配对调用（B-D1/D1 搜索行为变化并此条说明）。
2. **D-P2-7 错误标识口径变更**：回合错误图标不再含 sidecar 辅助调用失败；工具调用失败（status=error）新增点亮图标与「N 失败」计数。
3. **D-P2-8 DOM 锚点替换**：`data-trajectory-turn-stats` → `data-trajectory-turn-meta`（外部脚本若有依赖需同步）。
4. 新增功能条目：工具配对卡 / 回合头计数行 / 6 行 clamp + 查看全文全屏 / 搜索自动展开定位（对应用户向描述）。

其他：真机 manual T-N4 清单（含窄侧栏失败标识可见）；e2e 脚本是否登记 package.json（待拍板）。

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
- spec-check r1（对本文档）：4 P1 + 6 P2，全记账层——SC-P1-1 e2e J2-5 实跑红（raw 28 vs mapped 35：**计数为跨 session 重复相加**，集合级一致）；SC-P1-2 T-N4 缺窄侧栏条目；SC-P1-3 发布挂账分散；SC-P1-4 数量口径自相矛盾。doc-fix：J2-5 改集合包含断言（raw ⊆ mapped，差集=0；`778d2929`）、本文档重构（总表+编号规则+发布挂账集中+口径统一）、spec T-N4 补条目、iteration-state 同步
- 最终验证：typecheck 0 错、test:v4-perf 455/455、e2e-tool-join 25/25（J2-5 修正后口径：集合包含，raw=mapped=28）、oxlint/oxfmt 干净
- **fix-spec-ready: yes**
