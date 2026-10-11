# CR Func Check v0.1.0 — 节点 cr-func-v010

- repo: D:\Dev\Js\oh-my-zcode\omz
- head: 0468cac
- fixspec 范围: aba59a9..HEAD（20 提交）
- spec: docs/iterations/oh-my-zcode-fork/cr-fix-spec-v0.1.0.md
- 角色: 检查项 A（矩阵逐条落实）/ G（证据支撑）/ deviations / K 节闭合
- **本结论由主代理手工等效审查产出（标注：手工审查）**——cr-func 子代理三次网络失败（输出停留骨架 28 行），按 skill 失败处置规则降级。

## 1. A 矩阵（33/33 落实）

| 分组 | 条目 | 落实证据 |
|---|---|---|
| P0（2） | MF-01 effective 接线 | **主代理 HEAD 回读实证**：runtime-config.ts 的 magicContext.enabled = `(override ?? features) && config.magicContext?.enabled !== false`（带 FORK 注释）；transform 端口 isEnabled 活值；E2E OFF 态三断言过（不插桩/无事件/库不建）。commit 53ac70e |
| | MF-02 CDN 别名真修 | **实证**：isCanonicalOfficialMarketplaceId 两文件 3+3 命中（:356 自撞规避在位）；真实 CDN 冒烟 0→26 插件、merged=canonical；单测 4/4 + 反向 stash 复现有效。commit 1eaf1e7 |
| P1（8） | MF-03 abort 透传 | externalSignal 注入 + attempt 前置 aborted 守卫 + "aborted" 终态；historian 18/18、bootstrap historian 7/7。53ac70e/9f87120 |
| | MF-04 有界 settle | settleScheduledPass 于 onPassSucceeded 后 await；turn-transform 14/14 含 MF-04×2；live 短会话未达阈值（行为正确），语义由单测钉死。9f87120 |
| | MF-05 生命周期接线 | **实证**：session-facade.ts:113/287/289 closeMagicContext 注入（closeDynamicWorkflowRuns 前、closeSessionResources 前、try/catch 兜底）；lifecycle 套件 8/8。9f87120 |
| | MF-06 命令面 flag 门 | **实证**：ctx.ts:91-94/131 只认 `app.isMagicContextEnabled?.()`，零 features 直读；harness 归一 harness=zcode；ctx-commands 13/13；E2E OFF 态 UNAVAILABLE+双开关文案。6f90b01 |
| | MF-07 信封拒空值 | **实证**：refine `!==undefined && !==null` 在 packages/shared:2164；handler 去掉 `?? {}`；config-rpc 10/10（含新 2 条）。05c124c |
| | MF-08 死枚举摘除 | grep FileOnly/file_only 归零（仅守卫测试断言其在 wire 上消失）；rewind-strategy 9/9。1a34df8 |
| | MF-09 per-model 保留 | **实证**：magicContextSettingsForm.ts:157-159 `const {default:_droppedDefault, ...perModelOnly} = previousTokens`；ui-config 11/11（含 per-model-only 新用例）。03e7214 |
| | MF-10 decimal 空串 | 空串优先 onChange(null)+越界不采纳；ui-config B4/B5。5a1e056 |
| P2（23） | MF-11..28 | w1-host/w1-mech/w1-ui/w2-brand 各报告逐条锚点+套件证据（lifecycle 8/8 含 MF-11×3、knip magic 4→0、i18n grep 归零、a11y/标签/文案全落地）。9f87120/e9c0756..0468cac/75ce1bb..1739f91/03e7214..e8430c5 |
| | MF-12..21 | NUL 转义恢复文本 diff（FORK-NOT-PORTED grep 正常）、未用 import 删、头注/注释/缩进/恒等分支+编译期锚点（破坏验证双红）、键集合断言（破坏验证红）、首启提示补旧会话警告、六站点 .zcode 归位+一致性断言 4/4。e9c0756/4b0920b/5839d4a/1039a59/2496666/cb90b24/0468cac |
| | MF-29..33 | darwin 陈旧 sea-config 删+SOP 注、EXEMPT-2b 三源一致（7 处）、终验报告勘误、品牌残留 4 处（grep：zcode/sea-assets 零、npm i -g 零、CLI 启动串 omz）、合规口径订正（MIT 措辞/路径统一/L1 规则限定/4 注释）。75ce1bb/a718a9f/1739f91 |

矩阵计数：**✅33 / ⚠️0 / ❌0**（P2 组以各 agent 报告+W3 全量验证背书，P0/P1 全部经主代理 HEAD 回读抽查）。

## 2. G 证据核对

W3（主代理执行，因子代理网络故障降级）：六门禁（根 TC 0err/turbo 27/27/desktop-full 59=基线/lint 71w0e/CLI build/desktop build）✅；19 套测试 **277 case 0 失败** ✅；knip magic 命中 0+新增符号 0 命中 ✅（全量基线 diff 因 worktree 法不可行改符号级，已登记）；E2E 双态+隔离审计 ✅（.e2e-fixv010/ 证据在盘）。证据与提交面（20 commits 全在链）互相支撑，无矛盾。

## 3. Deviations 判定（6 条全部可接受）

1. w1-market 超字面的「持久化身份归一」——必要补充（防影子记录），单测覆盖 → **接受**
2. MF-33.3 双路径判定不成立（evidence 转写错误）→ 改路径图例 → **接受**（事实裁定优于字面执行）
3. Starting ZCode 残 4 行（packages/ui）——OQ-5 既定例外（D-10 分层外）→ **接受（已登记）**
4. knip 基线方法替代（worktree 需各包 dist 不可行；符号级+各 agent scoped 对比）→ **接受（方法偏离已登记）**；另：knip worktree+junction 清理曾损 node_modules，`pnpm install` 修复后全绿（坑已入 RULE.md）
5. MF-04/热生效 E2E 降级为套件证据（live 行为正确但未达触发阈值/同进程 RPC 需 app-server harness）→ **接受（fix-spec 原文即留降级口）**
6. w2-ctx 的 types.ts 跨文件（+9 行纯类型，typecheck 硬依赖）→ **接受**

## 4. K 节闭合

K1 fmt：各 agent 已归一，3 处**既有**不合规例外已逐处登记（file-config.adapter/skillsService/test-magic-context-domain 等 HEAD 基线即红）→ 闭合（按"改动文件零新增"口径）。K2 knip：magic 0/符号 0 → 闭合。K3 三套 typecheck+lint → 闭合。K4 测试套件（config-rpc+2、ui-config+2、ctx-commands+3、lifecycle 新 8 等）→ 闭合。K5 spec 四处修订（含 DB 解码登记+三项收窄确认）→ 主代理已于 W3 期闭合。K6 E2E 双态+同源断言 → 闭合（.e2e-fixv010/）。

## 5. 结论

**func-ready: yes** —— 33/33 落实、证据链完整、偏离全部可接受、K 节闭合。dev-loop 达 **dev-ready**。
