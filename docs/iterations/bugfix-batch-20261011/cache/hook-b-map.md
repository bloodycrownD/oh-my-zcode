# hook-b-map — Step 18（impl-hook-b）收口证据包

节点：impl-hook-b（Step 18，phase-mc-hook-closure）｜分支：bugfix-batch-20261011｜HEAD 起点：e81dc870（Step 14）
并行：Step 15（mural）在飞（已落盘未提交）；Step 16（hook-a）在飞（event-resolvers / ctx-reduce-availability 已 git mv 至 `core/hooks/magic-context/`，import 改指进行中）。

## 交付物（spec Step 18 原文逐项）

| spec 条目 | 落点 | 状态 |
|---|---|---|
| 「从段文本正则提取工具名集合，断言 ⊆ {ctx_reduce, ctx_expand, ctx_search, ctx_memory} ∪ 登记豁免集」 | `magic-context/scripts/test-tool-name-closure.mjs`（新，挂 `test:tool-name-closure` + `test:all`） | 6/6 绿 |
| 「豁免必须带 FORK 登记与适配口径，如 ctx_note」 | 豁免集写死 `["ctx_note"]`；`light-descriptions.ts` 文件头 + 本包测试头注释双重登记；core 侧 `sections/magic-context.ts` 长注登记降级差异 | 已登记 |
| 「ctx_note 句处置：无 flag ⇒ host 装配处最小适配（适配函数落宿主层，不改动包内逐字常量）+ FORK 注释登记差异」 | `core/src/context/sections/magic-context.ts`：`degradeCtxNoteReference()`（唯一漏斗 = 主路径 builder.ts:104 + 子智能体 context-builder.ts:152 共用的 `buildMagicContextSectionEntry`） | 7/7 绿 |
| 「断言测试固化」 | 包侧闭合（T-P2）+ core 侧适配行为（128 组合矩阵 + 强度自证 + OQ-PS）双测试 | 全绿 |
| cr-fix-spec 波次⑤ OQ-PS（空串→null 死代码） | `buildMagicContextSectionEntry`：空串/纯空白归 null，判定先于 heading 校验 | 绿（E 组用例） |
| user-facing-codes / shared 层收口 | r5 P1-1：改 import 真身已由 Step 8 闭合；本节点无 spec 剩余动作（note 相关 MC-C03/C04/C08 为逐字表内惰性条目，零 fork 消费者，按逐字纪律不动） | 核对=无剩余 |
| barrel 收口 | Step 15 mural barrel 扩面已在其工作区落盘（未提交）；Step 16 event-resolvers barrel 改指（`index.ts:164-165`/`:301`）待其返回；本节点无新增 barrel 需求（测试走内部 dist 路径） | 登记留待 |
| N1-N6 终局裁定登记核对 | 见下文「N1-N6 核对」 | 核对不重做 |

## T-P2 闭合断言设计（两半）

- **包侧（raw 文案）**：`buildMagicContextSection` 128 组合（ctxReduceCallable × preset × memoryEnabled × dreamer × temporal × caveman × subagent）+ `MEMORY_MURAL_GUIDANCE`/`MEMORY_MURAL_BLOCK` + `SELF_TAG_GUIDANCE` + `LIGHT_TOOL_DESCRIPTIONS`（键+值）regex 提取 `\b(ctx_[a-z]+)\b` → ⊆ 四条已注册 ∪ `["ctx_note"]`；注册表为**独立硬编码副本**（ZCODE_CTX_TOOL_IDS，外部事实不与被测代码同源）；豁免集非空转（ctx_note 必须真在场）且精确等于 `["ctx_note"]`——**豁免集长大即红**。
- **core 侧（适配后）**：同一 128 矩阵逐组合断言适配后剥掉降级句再无 ctx_note；`ACTIVE_TOOL_IDS` == contracts 四常量（双侧真值）；primaryOverride 有/无托盘句两条路径；mural 指导常量闭合。
- **强度实证**（对 dist 变异后还原）：向 `MEMORY_MURAL_GUIDANCE` 注入 ctx_note 之外的假名 `ctx_ghost` → 闭合测试 exit 1（红）；还原 → exit 0（绿）；dist 逐字节还原。测试内另有合成文本自证（`ctx_ghost` 谓词 throws / 豁免名与已注册名不红）。

## ctx_note host 装配层最小适配（spec Step 18 / N2）

- 上游句（逐字常量 `CTX_NOTE_GUIDANCE` / `CTX_NOTE_GUIDANCE_LIGHT`）不受任何 flag 控制（dreamerEnabled 只摘 SMART_NOTE 从句）。
- 适配 = 在 `buildMagicContextSectionEntry`（段文本进 system prompt 的唯一漏斗）把两句托盘文案**逐字 regex 替换**为降级说明：「`ctx_note` is not available on this host: keep work you intend to return to in your own reasoning for the rest of the turn, and pin anything that must survive beyond this session with `ctx_memory`」——删托盘隐喻、明示缺席、指回已注册替代。
- 上游若改写句子 ⇒ regex 落空 ⇒ core 测试（剥降级句后不得有 ctx_note）红，fail-visible，不会静默注入幽灵工具指令。
- subagentMode 分支上游本无 note 文案 ⇒ 断言适配逐字节恒等（证明适配不是无脑重写整段）。
- 包内逐字常量零改动；差异在本文件长注 + `light-descriptions.ts` 文件头 + 本证据包三处登记。

## OQ-PS 收口（cr-fix-spec 波次⑤）

`buildMagicContextSectionEntry("")` 旧路径：`"".startsWith(heading)` 先抛错，契约注释承诺的「空=不注入」是死代码。改为 `content === undefined || content.trim().length === 0` → null，且**先于** heading 校验；非空无 heading 仍大声失败（A3 回归护栏保留）。

## 验证实跑（便携 Node 24.14.0，apps/zcode-cli cwd 下 oxfmt 用 node 直启 bin 规避位置参数吞噬）

| 命令 | 结果 |
|---|---|
| `pnpm --dir apps/zcode-cli/packages/magic-context test:all` | **全绿**：smoke / config 11 / host 30 / transform 38 cases 0 failures / historian 18 / ctx-tools 20 / ctx-search-memory 10 / prompt-surface 26 / memory-promotion 4 / **mural-render 8（Step 15）** / **tool-name-closure 6（本节点）** / boot-busy-retry 7 |
| `node --test scripts/test-magic-context-section-ctx-note.mjs`（core） | **7/7**（矩阵 128 组合闭合+降级、override 两路、mural 常量、降级句诚实性、OQ-PS、双侧真值） |
| `node --test scripts/test-magic-context-prompt-section.mjs`（core，T-P1 回归） | **10/10** 不回归 |
| `pnpm --dir apps/zcode-cli run typecheck`（turbo） | **27 successful, 27 total**（15 cached / 12 fresh） |
| `pnpm typecheck`（根 tsc -b） | 0 error |
| `pnpm architecture:check --changed` | OK / violations 0 / baseline 0 / new 0 |
| oxfmt（apps/zcode-cli cwd，`--check` 三个代码文件） | 全部 OK（初检 3 文件不合规 → `--write` 归一后复检通过；格式化后全套测试重跑仍全绿） |
| `pnpm lint`（根） | 我的改动区（apps/zcode-cli，被根 .oxlintrc ignorePatterns 排除）**零命中**；全仓 781w/310e 来自并行节点未追踪目录（.reference 923 diagnostics、cache-tmp、.sum.cjs、docs 3、packages 70 为既有基线外条目），与本节点无关，留待 Step 19 在并行节点落地后重采基线 |
| 变异强度 | dist 注入 `ctx_ghost` → 闭合测试红（exit 1）；还原 → 绿（exit 0）；dist 逐字节还原 |

## 并行节点事实与挡下项登记

1. **magic-context/package.json 误覆盖事故（已修）**：Step 15 burst（01:45）把 bootstrap 的 package.json 全量内容写进了 `apps/zcode-cli/packages/magic-context/package.json`（name 变 @zcode/bootstrap、test:all 链消失）。本节点从 HEAD 恢复 + 补 `test:mural-render`（其新测试挂载，knip unused-file 需要）+ 补 `test:tool-name-closure`；已在该提交中显式 pathspec 提交，防止并行节点误提交损坏版。
2. **Step 15 在飞断链（已自愈）**：其 `memory/index.ts` 初版把 barrel 相对路径写成根级（`./core/...`）+ `render-trigger.ts` 漏 `.js` 后缀，导致包 build 红、barrel 链断（dist 一度带病）。02:11-02:14 Step 15 已自行修复，本节点重跑 build + test:all 全绿。本节点两个新测试**不走 barrel**（直取内部 dist 模块），与此类在飞状态解耦。
3. **Step 16 在飞**：`deferred/event-resolvers.ts`、`deferred/ctx-reduce-availability.ts` 已 RM 至 `core/hooks/magic-context/`；`scheduler.ts`/`lkg-replay-fit.ts`/`transform.ts` import 改指进行中。**挡下项**：barrel `index.ts:164-165` export 块与 `:301 resolveModelKey` 改指壳新落位、`magic-context-schema.ts`/`project-security.ts` 删除+3 处改指、`transform-postprocess-phase.ts:89-99` 改指——均属 Step 16 显式清单，待其返回后由其提交（本节点不重复落）。
4. **barrel 收口结论**：Step 15 的 mural barrel 扩面已在工作区（未提交）；Step 18 无自身 barrel 需求；无被禁触挡下应由本节点代劳的 barrel 项。

## N1-N6 终局裁定核对（核对不重做）

spec 裁定表 vs 当前落盘事实（核对时点：本节点提交前）：

| # | 裁定 | spec 收口动作 | 落盘事实 | 判定 |
|---|---|---|---|---|
| N1 | embedding 运行时面不做 | 4 缝头改 FORK-NOTE | `deferred/` 下 compartment-chunk-embedding / embed-session-state / auto-search-runner / embedding-status-tables **仍在，缝头未改写**（Step 17 在飞） | 待 Step 17 |
| N2 | ctx_note + note-nudger 不做 | 缝头 FORK-NOTE + Step 18 段文案处置 | 段文案处置=本节点已闭合；`deferred/note-nudger.ts` 缝头未改写 | 待 Step 17 |
| N3 | dreamer 不做 | 缝头 FORK-NOTE | `deferred/dreamer-task-registry.ts` 未改写 | 待 Step 17 |
| N4 | channel2-cycle + send-session-notification 不做 | 两缝头 FORK-NOTE + 预留端口保持预留态 | 两缝头未改写 | 待 Step 17 |
| N5 | compaction-off-transition 不做 | **删缝文件** + transition 段整体退场 | `deferred/compaction-off-transition.ts` 仍在；transform.ts compaction 段未删 | 待 Step 17 |
| N6 | hook-handlers 不做 | **删缝文件** + 4 alias 内联 live-session-state | `deferred/hook-handlers.ts` 仍在 | 待 Step 17 |

结论：N1-N6 的 FORK-NOTE 终局措辞与删除登记**尚未落盘**（Step 16/17 与 Step 18 同波并行，未返回）。spec 裁定表本身与本期口径一致（D1-D12 做 / N1-N6 不做，用户已确认）；`.iteration-state.yaml` 的 `bugfix-batch-20261011` 节尚无 N1-N6 登记条目——按 Step 17 职责登记，本节点只在 yaml 追加 impl-hook-b 节点状态（additive 单键，不动并行节点可能正在写的既有行）。

## 提交记录（本节点）

见 git log（`[bugfix-batch-20261011/Step 18]` 前缀，显式 pathspec，`-F` utf8 正文）。

## 观察项（不阻塞）

1. `docs/.iteration-state.yaml` 与 `docs/iterations/**`、`docs/apm/**` 在工作区**未追踪**（`??`）；spec impact_files 把它列为「修改」，批次结束时是否入库由主代理定。
2. 根 lint 门当前被并行节点未追踪目录污染（.reference 923 diagnostics / cache-tmp / .sum.cjs），Step 19 需在并行节点落地或清理后重采 71w/0e 基线；我的改动区零命中可先行确认。
3. i18n `settings.context.promptSurfaceOverrides.empty` 死 key（cr-fix-spec OQ-PS 第 2 条）按 spec 归 **Step 19**「清理或保留备用」，本节点未动两 locale 文件。
4. 降级句措辞若将来要随宿主能力演进（如真的注册了 note 宿主面），改点唯一：core `sections/magic-context.ts` 的 `CTX_NOTE_DEGRADED_SENTENCE` 常量 + 同步 core 测试中的 DEGRADED 常量。
5. `test-prompt-surface.mjs` 等 barrel 依赖型测试在 Step 15 断链期间曾红、其修复后复跑全绿——若后续再遇 barrel 链断裂，优先怀疑并行节点在飞文件而非本节点（本节点测试不走 barrel）。
