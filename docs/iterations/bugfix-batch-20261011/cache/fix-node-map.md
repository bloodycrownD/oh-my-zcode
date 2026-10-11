# 证据包 — fix 节点（wave-1.5）执行记录（bugfix-batch-20261011）

| 项 | 值 |
|---|---|
| 节点 | fix-node（wave-1.5） |
| 分支 | `bugfix-batch-20261011`（进入点 `214823ce` 之后） |
| 日期 | 2026-10-11 |
| 来源 | `docs/iterations/bugfix-batch-20261011/cr-fix-spec.md`（12 条 must-fix + 追加 A/B/C，已过 spec-check ready） |

> 本文件是 fix 节点的执行证据落盘，**不提交**（docs/ 按约定不入库）。cr-fix-spec.md 的
> Fix-Spec Closure 表已按本文件勾选。

## 1. 提交记录（8 提交，全部 `[bugfix-batch-20261011/fix]` 前缀）

| commit | 条目 | 内容 |
|---|---|---|
| `ca42775c` | MF-1(a-lease) | core `scripts/test-promotion-lease.mjs` 4 用例 + `test:promotion-lease` script |
| `08ac3966` | MF-ML-2/3 | 头注释 T-MU1/2→T-ML5；queue.ts `?? 0` 注释真实论据；T-ML2d |
| `1138d6d0` | MF-ML-4 | bootstrap `test:model-live` + 根 test:v4-perf 两入口（提交时误夹带 Step 17 已暂存的 3 个 deferred 删除，`reset --soft` + `git restore` 修复后重提，见观察项 1） |
| `2021b5d9` | MF-MC-1/2 | T-MC0b2 + skip 日志（compartment-runner-incremental.ts）+ T-MC0c |
| `41f756df` | MF-CTX-1/3 | ctx-search.ts id 短路可见性谓词对齐 FTS（唯一源码级功能修复）+ core 测试两例收敛 |
| `19490d3a` | MF-CTX-2 + 追加C | muralEnabled 文案补 vision 前置限定（中英）+ i18n 死 key 清理 |
| `b4f0b6f2` | MF-PS-1 | getToolSetHash 构造后赋值活读 + test-prompt-surface-toolset-hash + 两处挂载 |
| `28c23a5c` | oxfmt | 5 个新/改测试脚本格式化收口（CLI 侧 .oxfmtrc，oxfmt 0.47.0） |

spec 侧条目（MF-1 b、MF-ML-1、MF-ML-4 Step 19、MF-ML-5、OQ-1、OQ-MC-2、追加 A/B、
T-MC0b/b2/c、T-P1 锚点）全部落 `spec.md`；cr-fix-spec.md Closure 表勾选。docs/ 不入库。

## 2. 逐条状态

| 条目 | 状态 | 落点 |
|---|---|---|
| MF-1 (a-lease) | done | core 单测 4/4；spec T-S1 后半改「core lease 单测直证」 |
| MF-1 (b-落库) | done（登记收窄） | spec T-S2 覆盖映射 + cache/settle-chain.md 第 6 节 |
| MF-ML-1 | done（b 登记 + 实机升级） | spec 测试策略 ui 条目 + Step 7 清单两断言；a 备选路径留文 |
| MF-ML-2 | done | 头注释 T-MU1/2→T-ML5 |
| MF-ML-3 | done | queue.ts 注释论据（snapshot.ts:258 schema 必填 + :257 不持久化）+ T-ML2d 8/8 |
| MF-ML-4 | done | 两 script 进根 test:v4-perf；spawn 测试 4/4、model-live 8/8 |
| MF-ML-5 | done | 脚本名勘误 + 3a 删 profile.ts 并注 runner.ts resolveProfiles 达成 |
| MF-MC-1 | done | T-MC0b2（autoPromote=false 右臂，compartment 落 1 + memories 不变） |
| MF-MC-2 | done | skip 处 sessionLog（reason + facts）；T-MC0c 断言落盘日志 `reason=discarded_last facts=2` |
| MF-CTX-1 | done（唯一源码级修复） | id 短路 status ∈ active/permanent + expires_at 未过；验收三态探针（archived/expired/foreign → No results） |
| MF-CTX-2 | done（口径修正见 3） | muralEnabled 补 vision 前置；中英同步；zh/en key 集合对称 |
| MF-CTX-3 | done | 两例名副实（foreign/archived/expired + limit:1/合法 from/to），10/10 |
| MF-PS-1 | done（口径修正见 3） | getToolSetHash 现读 deps.promptSurface；审计列 full→light；区分力验证见 4 |
| 追加 A | done | Step 16 + 结构节 protected-tokens 落点勘误为 core/shared/protected-tokens.ts |
| 追加 B | done | Step 13/14 K-note（09b52efe/e81dc870）+ 设置面消费入步骤表 + D11 builder.ts 措辞 + 行数口径 210/162/283 |
| 追加 C | done（勿重做项已核验） | OQ-PS 空串收口 = Step 18 已落地（buildMagicContextSectionEntry 空串进 null 路，本轮未重复动）；i18n 死 key 已清理 |

## 3. 两处口径修正（fix 节点复验发现 CR 前置条件已变）

1. **MF-CTX-2**：CR 时「三开关未接线」的前置已被 Step 12/13/15 消费落地改变
   （`applyConfigToDeps` 填 memoryConfig/promptSurface/muralEnabled；transform.ts
   消费点在场；MF-PS-1 测试实测 prompt_surface 翻转 full→light 在两个 pass 间生效）。
   故不加「接线后生效」限定（加了反而失真）；唯一残留过度承诺是 muralEnabled 无条件
   断言渲染——实际门为 `muralEnabled && 当轮模型 supportsImage`，补前置限定。
2. **MF-PS-1 验收面**：fix-spec 要求断言 `transform_decisions.m0_tool_set_hash_new`，
   但 fork 的 durable writer 已裁（`transform-decision-log.ts` FORK-NOTE 明示「which
   nothing in the fork writes」，表恒空），pending decision 仅 bustedThisPass 记录且
   无读出口。改落同源审计列 `session_meta.cached_m0_tool_set_hash`——materialize 的
   markers.toolSetHash 写入（`inject-compartments.ts` markers.toolSetHash = hard.toolSetHash，
   即每 pass `deps.getToolSetHash()` 现读值），与 transform_decisions 的 m0_tool_set_hash_new
   语义同源。断言策略：pass1(full) 后审计列=f(full)；ConfigPort.set light → bridge onChange →
   applyConfigToDeps；清 cached_m0_bytes 强制 pass2 materialize；审计列=f(light) ≠ f(full)。

## 4. 区分力验证（两条关键测试都验过「不修会红」）

- MF-PS-1：把 dist 的指纹临时改回陈旧形态（恒 full）→ 测试按预期失败
  （actual `{"default":"full",…}` vs expected light），重建还原后复跑 1/1 过。
- MF-CTX-1：三态探针（archived/expired/foreign）直接对应修复前的恒真守卫——
  archived/expired 两种在修复前会从 id 短路漏回。

## 5. 实跑验证（便携 Node 24.14.0）

| 链 | 结果 |
|---|---|
| core `test:promotion-lease` + `test:ctx-search-memory`（tsx --test 同进程） | 14/14 |
| bootstrap `test-magic-context-turn-transform` + `test-settle-background` + `test-magic-context-historian` | 38/38 |
| bootstrap `test:model-live` / `test:subagent-live-model` / `test:prompt-surface-toolset-hash`（根链三入口） | 8/8 + 4/4 + 1/1 |
| magic-context `test:all`（build+smoke+test+host+transform+historian+ctx-tools+ctx-search-memory+prompt-surface+memory-promotion+mural-render+tool-name-closure+boot-busy-retry） | 142/142 |
| bootstrap `test-e2e-live-all`（T-E2E1..4 四场景，含长驻真工厂 E3） | 4/4 |
| CLI turbo `typecheck` | 27/27 successful |
| 根 `tsc -b`（rpc/provider/shared/services/ui/desktop…） | 0 error |
| `architecture:check --changed` | violations 0 / baseline 0 / new 0 |
| oxfmt（CLI 侧 .oxfmtrc，cwd=apps/zcode-cli，改动 11 文件） | 我的文件全净；`apps/zcode-cli/package.json` 基线既脏（devDeps 排序分歧、工作区 clean），按纪律不动 |
| oxlint（改动 11 文件单独） | 0 warning / 0 error |

## 6. 观察项

1. **并行暂存区教训**：MF-ML-4 首次提交误夹带 Step 17 并行节点已 `git add` 的 3 个
   deferred 删除（`git commit` 提交的是整个索引）。修复：`git reset --soft HEAD~1` +
   `git restore --source=HEAD --staged --worktree <3 文件>` + 精确重提。此后每次提交前
   `git diff --cached --stat` 核对。后续提交均干净。
2. **根 `pnpm lint` 环境性偏差**：310 errors 全部位于 untracked 的 `.reference/`
   （上游参考树，未入 .gitignore/.oxlintrc ignorePatterns）。spec 基线 71w/0e 是该树
   不存在时的口径；本批改动文件 oxlint 单独跑 0/0。`.reference/` 的 lint 归属交后续
   节点裁定（ignore 或使用后删除）。
3. **MF-MC-2 的 logger 行为**：node --test 会置 NODE_ENV=test，logger 顶层据此整臂
   静默；T-MC0c 在 import 前 `delete process.env.NODE_ENV`（test:all 下该脚本独立进程，
   不影响其他套件）。落盘断言前 `logger.flushLogger()`。
4. **MF-PS-1 测试成本**：双 pass 真工厂 + SQLite，单文件约 1.5-5s（Windows），可接受。
5. `docs/.iteration-state.yaml` 未改（fix 节点无新裁定入登记；Spec deviations SD-1
   已由 MF-1 混合方案闭合并在 spec 落文）。
