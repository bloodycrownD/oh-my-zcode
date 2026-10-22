# CR Fix Spec: upstream-v3.16-backport wave-1（CLI 四项 + Step 7b）

## 元信息
- repo：D:\worktree\upstream-316（分支 upstream-v3.16-backport）
- base_sha：b952d749 / head_sha：1ca54c4c（12 commits）
- prd_path：未提供（用户口述 A/B 档） / spec_path：docs/iterations/upstream-v3.16-sync/spec.md（§U1-U4、Step 1-7b）
- review_round：1（diff 模式单轮）+ spec-check r1（手工审查，1 轮） / dag_version：2
- 状态：**fix-spec-ready**（待用户确认）
- 评审方式标注：**手工审查**（①code-review-loop diff 评审：Agent 通道两连断转主代理等效审查；②spec-check-loop r1：Agent 通道两连断转主代理等效审查，其断言经机械核验——warn 字符串/stub 形态/单用例现状/knip 四条/head_sha 对账全部命中 §482。局限声明：文档与审查同为一人，判断类结论以机械证据背书）

## Must-fix（按 P0 → P1 → P2）

### CR-P2-1 [P2] T-C4 补「落库失败不覆盖创建错误」分支用例
- 维度：G（测试覆盖缺口）
- 文件：apps/zcode-cli/packages/core/scripts/test-model-creation-failure.mjs
- 问题：外层 catch 的 `reportedCreationFailure` 守卫（落库链抛出普通错误时只 warn、终态仍报创建错误——上游 CR-01 的另一半语义）当前无用例覆盖；现有用例只覆盖「落库成功」路径。
- 改法：在测试文件追加第二个 `test()`：**stub 覆写机制钉死为「用例内覆写」**——沿用同一 `buildRuntimeStub(recorder)` 构造后，在本用例内 `runtime.persistUserPrompt = () => Promise.reject(new Error("persist-boom"));`（不改 buildRuntimeStub 签名，两用例互不干扰）；断言 ① recorder.warns 含 `"Accepted input persistence failed after model creation failed"`（与 turn.ts 外层 catch 实际消息逐字一致，已核）；② TurnError 终态事件 payload 仍含 `PROVIDER_VANISHED_MARKER`（创建错误未被 persist-boom 覆盖）；③ `turnPhase === "model_creation"`。
- 验收/测试：`node --import tsx --test scripts/test-model-creation-failure.mjs` 2 用例全绿；随 `test:cli-backport` 聚合绿。
- 来源：手工审查 r1（G 维覆盖面评估）；spec-check r1 手工审查补钉 stub 覆写机制（P2 精度）

## Spec deviations
- **合理适配（不阻塞）**：
  1. U4 executor: main（Agent 通道故障，skill 认可路径；实现后经 T-C4 真实源码路径验证）
  2. omz 无 `compactInstructions`（/compact 不经 turn.ts）→ catch 无 compact 终态分支（上游专属路径；代码注释已说明）
  3. U4 引入 `Model` 类型导入 + `isTurnCancellationError`（自 helpers/index.js，已核实存在且导出）——移植必需
  4. `test:ui-backport`/`test:desktop-backport` 为占位脚本（spec Step 7b 原文允许，w3/w9 充实）
- open：无

## Open questions / 待拍板
- 无

## 已豁免（用户确认不修）
- 无

## 合并后 QA（manual_user）
- 无新增（spec 的 T-M1/M2/M3 真机项属 U5+ 波次，与本 wave 无关）

## K 节建议（下游执行时闭合）
1. CR-P2-1 执行时顺带核对 `test-wiring-map.md` T-C4 行数（1→2 用例）
2. Step 18 全门禁时统一跑 `node scripts/typecheck-desktop-full.mjs` 差分与 knip 基线对比（knip.json 四条新 ignore 已落，无待办）

## Fix-Spec Closure
| 项 | 状态 |
| fix-spec-ready | yes |
| fix_spec_path | docs/iterations/upstream-v3.16-sync/cr-fix-spec.md |
| dag_version / review_round | 2 / 1（CR diff）+ 1（spec-check 手工） |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 1 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none open（4 条合理适配已登记） |
| C-orch | ✅（登记链三处=既有惯例形态，无冗余 hop；其余 N/A——单模块移植无跨端协调） |
| C 类合并后 QA | 无 |

## 评审记录（手工审查 r1 证据摘要）
- **范围**：git diff b952d749..1ca54c4c 22 文件 = 8 迭代文档（Step 1 入库）+ 12 代码/登记；out-of-scope 文件 0（§461 机械核验）
- **污染检查**：turn.ts + product-projection.ts 中 `highspeed|selectionFallback|turn-execution-fallback` 0 命中（§461）
- **U4 关键路径推演**（对照上游 3c5b2276 turn.ts）：① catch 记 creationFailure 不抛（上游 CR-01 主干，剔除 fallback 机=spec 纪律）② context/session-hooks 包 `if (!creationFailure)`（上游 :439 区语义一致）③ beginActiveTurn 第 4 参 `creationFailure === undefined`（T-C4 断言 steerable=false 已锁）④ submissionModel/startedTarget 条件化（避免主 try 外二次抛错）⑤ throw 点在 persistUserPrompt 之后、loopState 之前（spec 定点位）⑥ 外层 catch reportedCreationFailure 三件套（warn 守卫/fallbackMessage/turnPhase）——与上游逐点对应；`turnMachine.start()` 在 beginActiveTurn 后已执行（外层 catch 用 state.startedAt 安全）；targetRunHeartbeat 因 startedTarget=null 不启动；finally 的 finishActiveTurn/releaseTurnStart 在 T-C4 真实源码路径全被走过（记录型桩验证）
- **U1**：与上游逐字一致（impl 代理 git diff --no-index 验证）+ 变异测试 3 次捕获 + e2e-A 真实决策层复验（四形态/m4 未跳过/错误语义）
- **U2**：T-C2 文本断言 + e2e-B 运行时 loader 复验（三句/persona 措辞/无矛盾句/未误迁 API）
- **U3**：T-C3 双形态 + 红/绿验证 + e2e-C 回归（bootstrap 全套零新增、v4-perf 全绿）；openToolRow 未动、常量名保留
- **聚合**：test:cli-backport 16/16 实跑绿；knip.json 四条登记与四个新脚本一一对应；core 包 script 形态与既有先例一致（node --import tsx --test，规避 #118 解析限制）
