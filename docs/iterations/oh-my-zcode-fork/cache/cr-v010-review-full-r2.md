# oh-my-zcode v0.1.0 — review-full round-2 轻量终校

- fix-spec: `docs/iterations/oh-my-zcode-fork/cr-fix-spec-v0.1.0.md`（193 行）
- 依据: `cache/cr-v010-review-full.md` §2.1 / 2.2 / 2.3 / 3.1–3.5
- 模式: readonly 轻量终校；唯一写入产物为本文件

## 0. 进度日志

- [x] 创建骨架
- [x] 读 fix-spec 全文 + review-full §2.1/2.2/2.3/3.1-3.5
- [x] 8 项核对逐项落盘
- [x] 最终判定

---

## 1. 逐项核对表

| # | 核对项 | 判定 | 依据（fix-spec 行号 + 摘录） |
|---|---|---|---|
| 1 | MF-02 canonical/legacy 双函数 + `:356` 自撞规避 + bootstrap 四调用点 + OQ-6 互指 | **partial** | 三项落地、L4 单向 |
| 2 | MF-07 `!==undefined && !==null` refine + 两条验收用例 | **yes** | L63 / L64 |
| 3 | MF-05 锚点 + 插入位置 + try/catch + 顺序断言 | **yes** | L49 / L50 |
| 4 | MF-17 三处站点 + 跨 scope 授权 + MF-33 去重归属 | **partial** | L107 全含，L155 未反向标注 |
| 5 | MF-06 「effective 同源 / ctx.ts 不得自行读 features」硬约束 | **yes** | L56 + L57 |
| 6 | MF-01 / MF-27 验收口径界定 | **yes** | L18 / L137 |
| 7 | 元信息 review_round:3 / dag_version:3 | **yes** | L7 |
| 8 | 全文格式破损抽查 | **partial** | 无截断；MF-04 标题粘连（r1 遗留） |

---

### 1. MF-02 — partial

review 2.1 的四项要求，前三项忠实落实：

- **双函数拆分**：L25「`isOfficialMarketplaceId(id)` = canonical ∪ legacy 扩集；新增 `isCanonicalOfficialMarketplaceId(id)` 只认 canonical」——与 review 建议的语义切分逐字一致。
- **`:356` 自撞规避**：L26「`isOfficialMarketplaceId(name) && !isCanonicalOfficialMarketplaceId(input.trustedId ?? "") && name !== input.trustedId` 才抛」，与 review 建议代码块一致；`:366` 守卫（L27）与 `:375`（L27）亦已改对。
- **bootstrap 四调用点复核**：L28 显式列出 `bootstrap/src/plugins.ts:1084/1094/1111/1184`，并写明扩集后语义由 canonical 变为 canonical∪legacy、方向无害、需逐处登记确认。

**未完全落实的一点**：review 3.4 要求「**并**在 OQ-6 的描述里回指 MF-2」。fix-spec 只做了单向——MF-02 L29 有「与 OQ-6 互相回指…旧后缀不复活是预期，勿误报为本条未修好」；而 Open questions 第 6 条（L168）仍为原文「`plugins.enabledPlugins` 旧后缀不 canonicalize（D-7 下可接受，建议 spec 登记）」，**无 MF-02 回指**。反查 OQ-6 时看不出它与 MF-02 的语义耦合仍在。补 5 字即可闭合。

顺带确认无回归：验收（L30）含「旧名 manifest + trustedId=canonical → 刷新成功」与「第三方名 + 非 trusted → 仍抛 reserved」两条，与新守卫语义自洽。

### 2. MF-07 — yes

- **refine 判据**：L63「`.refine((p)=>p.config!==undefined && p.config!==null, {message:…, path:["config"]})`（勿用 .default/.catch）」——正是 review 2.2 建议的改法，两条真实路径一次覆盖。
- **两条验收用例**：L64「新增**两条**用例——`{workspace}`（键缺席 → -32602）与 `{workspace, config:null}`（空值 → -32602 + 磁盘与 ConfigPort 均未动）」，与 review「验收用例需相应改为两条」逐项对上。
- 附带超额落实：review 2.2 建议的 handler `:122` 显式抛错（L63）、`:2142-2144` 注释订正（L63）、问题陈述的 r1 前提订正（L62）均已写入。

### 3. MF-05 — yes

- **锚点**：L49「真实挂载点在 `bootstrap/src/app/session-facade.ts:264-308` 的 `close()` 链」，正是 review 2.3 回读出的行号区间。
- **插入位置**：L49「插在 `:274 closeDynamicWorkflowRuns` 之前、`:294 closeSessionResources` **之前**」，review 3.3 的两个「之前」都钉死，并保留了「否则写库到已关闭 store 上是隐性 bug」的判据。
- **try/catch 兜底**：L49「整段套 `:274-289` 的 try/catch + logger.warn 兜底——historian 关闭抛错不得吃掉后续资源关闭」，与 review 3.3 建议逐字一致。
- **顺序断言**：L50「关闭顺序断言（historian drain 完成先于 closeSessionResources）」。
- 另补了 review 2.3 提到的 `create-app.ts:958-960` 注入范式。

小备注（不阻塞）：review 2.3 尾句「drain 必须排在 `beginShutdown` 之后」未显式写出，但「插在 `:274` 之前」已隐含 `:267 beginShutdown` 在前，语义无歧义。

### 4. MF-17 — partial

- **三处站点**：L107 完整列出 `core/src/tool/handlers/saved-workflows/store.ts:53`、`packages/ui/src/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.ts:20`、同文件 `:62`（并标注为用户可见日志文案）——与 review 3.5 实测的 3 处未覆盖站点逐条对上。
- **跨 scope 授权**：L107「**跨 scope 授权**：packages/ui 属 ui-tui scope，本条显式授权执行者跨入」，正是 review 3.5 要求的显式授权。
- **去重归属**：L107「saved-workflow.ts:43-46 由本条独占编辑，MF-33 对该文件只复核不重复改」——归属判定已下。

**未完全落实的一点**：归属只做了单向标注。MF-33 条目（L155）的文件清单里 `saved-workflow:43-46（=MF-17）` 仍在「5 处注释……按代码事实改」的编辑指令内，**未加「本文件由 MF-17 负责、MF-33 只复核」的标注**。Wave D 的执行者若以 MF-33 为准去编辑该段，仍可能与 MF-17 双写。review 3.5 给的是二选一（剔除或反向标注），当前只做了「MF-17 单侧声明」。

附带瑕疵（不阻塞）：L107 改法写「**六处**注释/文案全部改回 `.zcode/workflows`」，但文件清单枚举的是 3（saved-workflow.ts `:19/:25/:43-46`）+ 1（shared `index.ts:2729`）+ 3（r2 补）= 7 处，计数少一处。以逐条清单为准即可。

### 5. MF-06 — yes

L56：「**r2 硬约束（review-full N-1）**：effective 必须**同源**——经 `CommandCenterApp` 可选能力 `isMagicContextEnabled?()` 暴露，其值由 create-app 从 `runtimeConfig.magicContext.enabled` 透传（与 MF-01 同一字段同一次求值）；`ctx.ts` **不得**自行读 `features` 或重算，否则 features=true+enabled=false 时命令面与 turn-loop 分叉」——与 review 3.1「必须-fix 补充建议」逐要素对齐（同源、透传字段、禁止重算、分叉场景说明）。L57 验收另补「两处 effective 同源」断言，闭合 review 3.1 末尾「写成硬约束 + E2E 合并」的另一半。

### 6. MF-01 / MF-27 验收口径 — yes

- **MF-01（L18）**：热生效验收「限定『实现了 `getConfigPort` 的 resident session』——轻量 embedder 与测试 record 不实现该能力、收不到 fan-out 属既有设计，勿写出只在后者上通过的验收」。review 3.2 的口径要求（界定「对哪些 session 生效」）已明确落地，并带上了成因说明。
- **MF-27（L137）**：「-32602 时用户看到字段名即可（r2 口径：MF-07 的 refine 消息较长，toast 含 config 字段名即达标，不要求完整可读）」。review 3.2「次级盲区」的建议原文即「消息里含 config 字段名即可，不要求用户能读懂」，逐字落实。

### 7. 元信息 — yes

L7：「review_round: 3 / dag_version: 3（wave-1 evidence×5 → wave-2 review-scope×5 → spec-fix r1 → wave-3 review-full → 本 spec-fix r2，吸收 review-full 三条改法级修正与五条盲区建议）」。轮次与 DAG 均已推进，链路描述与本轮实际动作（三条改法级修正 = MF-02/07/05；五条盲区建议 = N-1..N-5）自洽。

### 8. 全文格式抽查 — partial

逐节走查（193 行）：元信息 → Must-fix → Spec deviations → Open questions → 已豁免 → 合并后 QA → K 节建议 → 执行编排建议，**节标题齐全、无截断、无条目被腰斩**。

- **MF 编号连续**：`### MF-01` 至 `### MF-33` 共 33 条，逐号在位，无跳号、无重号、无一号两议。
- **Open questions 编号 1–7 连续**，第 7 条为 r1 建议补登记的 mc-host OQ-3/OQ-4（已采纳）。
- **瑕疵（r1 遗留，非本轮编辑所致）**：L40 的 `### MF-04` 标题与其「维度/文件/问题/改法/验收」整段**被压在同一行**，与 MF-01~03、MF-05~08 的多行格式不一致。MF-04 不属于本轮 r2 编辑的 7 个条目（MF-01/02/05/06/07/17/27），故判定为 r1 遗留排版问题而非 r2 编辑破损；内容本身完整可读，不影响执行。仅提示主代理可顺手回车分段。
- 未发现反引号未闭合、`**` 未配对、表格错列、条目被截断等编辑损伤。

---

## 2. 未闭合项（建议主代理收口，均为单行文本改动）

| # | 位置 | 缺口 | 建议改法 |
|---|---|---|---|
| G-1 | `cr-fix-spec-v0.1.0.md:168`（Open questions 6） | 无 MF-02 回指 | 追加「（与 MF-02 语义耦合：MF-02 只治 marketplace 侧，本条治 `enabledPlugins` 旧后缀，勿互相误判）」 |
| G-2 | `cr-fix-spec-v0.1.0.md:155`（MF-33 文件清单） | `saved-workflow:43-46` 仍在编辑指令内，未反向标注归属 | 改为「saved-workflow:43-46（**由 MF-17 独占编辑，本条只复核**）」 |
| G-3 | `cr-fix-spec-v0.1.0.md:107`（MF-17） | 「六处」与枚举的 7 处不符 | 「六处」→「七处」 |
| G-4 | `cr-fix-spec-v0.1.0.md:40`（MF-04） | 标题与正文粘连单行（r1 遗留） | 回车分段，对齐 MF-03/MF-05 格式 |

G-1/G-2 属 review-full 明确点名的 must-fix 补充项（3.4 / 3.5），G-3/G-4 为排版级，均不改变任何条目语义。

## 3. 最终判定

**建议 fix-spec-ready: yes**（可进 code-dev-loop）

理由：review-full 第一轮的三条「不通过」全部转为忠实落实（MF-02 三要素 + MF-07 前提订正 + MF-05 锚点），两条 must-fix 补充建议（3.1 N-1、3.3 N-2）与两条建议级（3.2 N-5）全部落地，MF-17 的站点补齐与跨 scope 授权已就位，MF-33 归属判定已下。遗留 G-1/G-2 是「回指标注」这一层装饰性文本，双向语义本身已由 MF-17/MF-02 的单向声明加 OQ-6 原文共同承载，不会导致执行走偏；建议主代理在派发 Wave C/D 前顺手补上（合计约 2 行文本），补与不补均不阻塞执行。

若判定门禁要求「must-fix 补充项须双向闭合」，则降为 conditional yes（G-1 + G-2 补齐后转 yes）。
