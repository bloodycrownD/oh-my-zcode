# hook-c-map — Step 17（impl-hook-c）证据包

- 节点：impl-hook-c（Step 17，phase-mc-hook-closure，blocking，qa: auto）+ 协调者补充职责（8 缝终局措辞 + yaml 登记）
- 分支：bugfix-batch-20261011；base HEAD=a0dc4704（起点）；日期 2026-10-11
- 依据：docs/iterations/bugfix-batch-20261011/spec.md Step 17 全文 + N5/N6 终局裁定行 + r2-N2/r5 审查修正（spec 内已并文）

## 一、删除手术（3 缝，git rm）

| 文件 | 裁定 | 收口 |
|---|---|---|
| `core/deferred/compaction-off-transition.ts` | N5：fork 无 compaction 域（D-7 已删原生压缩；`compaction` 在 EXCLUDED_CONFIG_KEYS 下 compactionOff 恒假——删除不改变任何运行时行为） | 删缝 + transform.ts compaction 模式段整体退场（r2-N2：非仅 import） |
| `core/deferred/hook-handlers.ts` | N6：OpenCode plugin 事件面 type-only 摘录；ZCode 事件走 appendEvent/SessionEventType | 删缝 + 4 alias 内联 + import 改指 + barrel 随删 |
| `core/deferred/embed-session-state.ts` | N1：embedding 运行时面（prompt 裁定删除，与 spec N1 行「同改 FORK-NOTE」措辞的偏离已登记，见观察项 1） | 删缝 + EmbedDrainUiStatus 本地化 |

### transform.ts 级联清单（逐项核，spec 行号为 a0dc4704 基线、实际行号有 +1 漂移）

| spec 锚点 | 实际位置（术前） | 动作 |
|---|---|---|
| `:75/:76` import | :75 | 删 `import { commitCompactionModeRecord, reconcileCompactionMode } from "../../deferred/compaction-off-transition.js"` |
| `:573` `Parameters<typeof reconcileCompactionMode>` 类型引用 | :582 | 删 `hostCleanupCompactionMarkers?` 字段（全仓仅 transform.ts:582 定义 + :893 使用，均随块删） |
| `:867-945` 运行时块 | :873-954 | 删 comment+`reconcileCompactionMode({...})`+hasTransitionEffects 效果处理+notice 投递（sendStatusNotification/runNotificationParams）+`commitCompactionModeRecord`+`failPass("compaction-mode-transition-failure")`；保留 `const compactionOff` 本地常量（下方 ~26 处 mutating gate 仍读）并改写头注为 N5 终局说明 |
| `:953` `!compactionOff` 判定 | :962 | `if (deps.client !== undefined && !compactionOff)` → `if (deps.client !== undefined)`（恒假条件从未生效，行为中性） |
| — （r5 P2-4 勘误） | :108 | `LiveModelBySession` import 由 `../../deferred/hook-handlers.js` 改指 `./live-session-state.js` |

`deps.compactionOff` 字段本体、doc comment（:569-580）、:768 `deps.compactionOff === true` early-return、其余全部 `!compactionOff` 条件引用：**保留**（spec：「flag 本体保留（恒假、gate 为死代码无害）——仅删 transition 段，禁止顺手清理」）。

### 其他引用清理

- `live-session-state.ts`：删 hook-handlers import；4 个 Map alias 按上游 `hook-handlers.ts:67-70` 逐字内联（`LiveModelBySession` 导出供 transform.ts:108；其余三个本地化）；头注 + 「See hook-handlers.ts」doc-comment 改指上游路径防悬空。
- `format-embed-status.ts`：`EmbedDrainUiStatus` 本地声明（缝头原建议的「四成员并集体」路线）；`getEmbedDrainUiStatus` 全仓零消费者，随删。
- barrel `src/index.ts`：`export type { LiveModelBySession } from "./core/deferred/hook-handlers.js"` 随删——全仓（apps+packages）零外部消费者（git grep 实证），如需公共面按 barrel 注释块规矩重开。
- EXCLUDED_CONFIG_KEYS=["compaction"]：**不动**（spec 引为「恒假」既有事实；Step 16 测试 `scripts/test-config.mjs` 断言其存在，删了会红——该测试属禁触区）。
- `pass-outcome.ts:27` `"compaction-mode-transition-failure"` 表项：保留（死数据、非 import；摘除超出 spec 显式删除清单，登记观察项 4）。

## 二、7 缝 FORK-NOTE 终局措辞（N1-N4，每个含 不做+理由+不影响使用论证+收口）

| 文件 | 裁定 | 措辞要点 |
|---|---|---|
| compartment-chunk-embedding.ts | N1 | 壳保留（A 组 cleanup 唯一载体）；三 provider 依赖外部服务/被排除依赖、本地 provider SEA+HF 下载坑、off 合法态；记忆链不依赖向量 |
| auto-search-runner.ts | N1 | 壳保留（transform-postprocess-phase 唯一调用面）；自动搜索是 embedding 消费面、ctx_search 为 FTS5 关键词 |
| embedding-status-tables.ts | N1 | 壳保留（type 面 + 两个 formatter 运行时值=/ctx-embed 状态块唯一载体） |
| note-nudger.ts | N2 | ZCode D 组工具面无 note；记忆主链不经 note；Step 18 段句适配已闭合 |
| dreamer-task-registry.ts | N3 | agent 进程无 cron 宿主；读写链完整；unions 保持裁剪态 |
| channel2-cycle.ts | N4 | steerTurn 需干预 turn-loop；日志/时间线/DEBUG_WIRE 覆盖 |
| send-session-notification.ts | N4 | 同步订正陈旧 bullet：transform.ts:910 compaction-mode notice 投递点已随 N5 删除（原「=== "sent" gate」描述失效） |

头注风格沿用仓内先例（FORK-NOT-PORTED/FORK-NOTE 标记 + 中文叙事；event-resolvers.ts Step 16 先例为中文头注）。

## 三、deferred/ 终局盘点（对账 spec 裁定表）

删除前 10 个文件；删除后 **7 个**，全部与 spec「保留」集一致（除观察项 1 的 embed-session-state 按 prompt 裁定删除）：

- 壳（FORK-NOTE 终局保留）：auto-search-runner / channel2-cycle / compartment-chunk-embedding / dreamer-task-registry / embedding-status-tables / note-nudger / send-session-notification
- 已删（git rm）：compaction-off-transition / embed-session-state / hook-handlers
- 差异登记：spec N1 行原文对 embed-session-state 的收口是「同改 FORK-NOTE」（保留），本步按节点 prompt + 协调者确认执行删除（理由：N1 语义域不存在、唯一消费者仅一个四成员并集 type、本地化成本低于留壳）——spec 文本与执行的偏离在此登记，待 spec 勘误。

## 四、compactionOff 全仓计数（口径：git grep，apps+packages，tracked，匹配行/文件）

- 术前：**85 处 / 80 行 / 6 文件**（transform.ts 33、transform-postprocess-phase.ts 36、inject-compartments.ts 6、transform-compartment-phase.ts 3、channel2-cycle.ts 1、compaction-off-transition.ts 1）
- 术后：**78 行 / 5 文件**（transform.ts 32——删 :890 参数与 :962 条件、删缝 1 处；新增头注 1 处）
- spec 计数 82/38、r5 P2 实测 84/41 与本步实测口径均有漂移；prompt 裁定「以实测为准」→ 采用上数。处置范围严格限于 transition 段（prompt/spec 明令）。

## 五、残留清零（git grep apps+packages）

- `deferred/(compaction-off-transition|hook-handlers|embed-session-state)\.js` import：**0**
- `reconcileCompactionMode|commitCompactionModeRecord|hostCleanupCompactionMarkers|getEmbedDrainUiStatus`：**0**
- 仅存注释级提及（migrations.ts:676、todo-view.ts:12/:93、transform.ts:1150/:3067 指上游文件名的行为描述，非 import）：保留不动（上游引用语义，删反而失真）。

## 六、验证实跑

| 门禁 | 命令 | 结果 |
|---|---|---|
| magic-context build+test:all | `pnpm run test:all`（便携 Node 24.14.0） | 全绿：smoke/config 11/host 30/**transform 38/38 零裁剪**/historian 18/ctx-tools 20/ctx-search-memory 10/prompt-surface 26/memory-promotion 4/mural-render 8/tool-name-closure 6/boot-busy-retry 7 |
| CLI turbo typecheck | `turbo run typecheck`（apps/zcode-cli） | 27 successful, 27 total（15 cached） |
| 根 typecheck | `pnpm run typecheck`（tsc -b 全项目） | exit 0 |
| 架构检查 | `pnpm run architecture:check -- --changed` | OK / violations 0 / baseline 0 / new 0 |
| oxfmt | 根 `oxfmt --check` + apps/zcode-cli `oxfmt --check` + `src/index.ts` stdin 逐字节对比 | `src/core/**` 被 `apps/zcode-cli/.oxfmtrc.json` ignorePatterns 排除（保持与上游可 diff，非本步引入）；`src/index.ts` 格式化输出与原文件 IDENTICAL；根全量仅两处既有错误（非本步文件，见观察项 3） |
| 测试脚本禁触 | scripts/test-* 未动（本步零测试改动，transform 38 基线零裁剪） | ✓ |

环境注记：`pnpm` shim 会回落到 nvm node 22，turbo 直调需 `node_modules\.bin` 入 PATH；oxfmt positional 文件参数在该构建不可用（"Expected at least one target file"），用全量跑+stdin 对比替代。

## 七、观察项（遗留/登记）

1. **spec N1 行 vs 执行的偏离**：spec 裁定表 N1 对 embed-session-state 的收口写「同改 FORK-NOTE」，本步按节点 prompt+协调者确认删除。建议 spec 勘误该行。
2. **yaml 既有非法 YAML**：docs/.iteration-state.yaml 第 33 行起共 9 处值以 `**` 起头（YAML alias 指示符）致整文件无法被 YAML 解析（node yaml 包实证：「Unexpected scalar at node end at line 33」）；按「勿动既有行」未修，本步 append 全部避开 `**` 起头值。待文件 owner/Step 19 处置。
3. **oxfmt 既有红**：根 `oxfmt --check` 对该 yaml 与 `.reference/` 模板 CSS 报 SyntaxError（均非本步文件、untracked）；apps/zcode-cli 子树 1211/1495 文件 list-different（CLI 子树既有红基线，门禁判据=改动文件零新增）。
4. **pass-outcome.ts 死表项**：`compaction-mode-transition-failure` 随唯一调用点删除成死数据，保留（删除清单外，摘除需 spec 追加授权）。
5. **并行事故**：本步 `git rm` 暂存的删除曾被并行节点 `git reset` 撤销且三文件被还原（HEAD 内容一致、无内容损失）；提交前重新原子暂存并核对 commit 内容。工作区另有并行节点未跟踪产物（.fix-ml4.cjs、.tmp-*.log 等）未动。
6. **resolveCompactionModeRecord**（storage-meta-persisted.ts:748）原仅经被删缝 re-export 出声、本就零消费者；knip 对 magic-context src/** 整体 ignore（knip.json），无新增命中。

## 八、提交

见 git log（前缀 `[bugfix-batch-20261011/Step 17]`）；显式 pathspec `git rm`/`git add` 后 `git commit -F <utf8 文件>`，未用 `git commit -- pathspec` 语义。cache/ 证据包与 docs/.iteration-state.yaml（untracked 惯例）未入提交。

- **commit：`145f8f2a`**（[bugfix-batch-20261011/Step 17]，14 files，+114/−330）
- numstat 核验：3 删（compaction-off-transition −129 / embed-session-state −38 / hook-handlers −31）+ 11 改；并行节点 `41f756df`（MF-CTX-1/3，core 两文件）在其前提交、零夹带；提交后全仓 grep 三缝 import 残留=0，磁盘三缝确认删除，deferred/ 终局=7 壳。
- 附注：并行节点当时仍有未提交 bootstrap MF-PS-1 改动（`magic-context-turn-transform.ts` + `test-prompt-surface-toolset-hash.mjs`），本提交未触碰。
