---
date: 2026-11-11
---

# 上游 v3.18.0 孤岛升级（upstream-v3.18-islands）技术规格（SPEC）

## 需求来源

用户口述（2026-11-11 session），无独立 prd.md。核心诉求：上游 ZCode v3.18.0（单 commit 整包同步，base=v3.15.1，共 6916 个变动源文件）要与 1.0.x 稳定线对接；已通过盘范围方法论（见 `docs/vendor/318/inventory.md`、`.agents/skills/omz-upgrade/SKILL.md`）把变动拆到可控粒度，本 spec 把结论落成可执行的分批升级方案。

用户已拍板的决策：
- **A 类（4088 个整岛全新文件）先落地，哪怕是死代码**——无人 import = 运行时/打包零风险；先拉近树距，让下次同步的 delta 从"新增"变"修改"
- A 类中 3180 个测试文件**不搬**（vitest 会真跑，没接线必红），随功能接线走
- B 类（226 个纯取岛）一岛一 commit；C 类（294 个 fork 改过）三方合并
- 版本号与发布分支**永远问用户，不自行决定**

## 设计目标

1. 把 3.18.0 变动按 A1/A1b/A2/B/C 五轨分批落进 `upgrade/318-islands` 分支，每批独立可 revert、可验证
2. 补齐执行侧工具（Phase 0），使"盘范围→搬→验证→记账"成为可复跑流水线
3. 全程不动 main；每完成一个阶段向用户汇报，发布节点走 `omz-publish` skill

## 总体方案

```
Phase 0  工具补齐（blocking，先行）        scripts/vendor-*.mjs 增强 + vendor-wave.mjs 新增
Phase 1  A1 现存包新文件落地（约 969 个）    shared→server→office-runtime→web→services→desktop→ui→bootstrap/core
Phase 2  A1b 全新包建包（3 包 40 文件）      design-plugin / session-control / plugin-api
Phase 3  B 类 226 岛真升级                  一岛一 commit，四层验证
Phase 4  C 类 294 岛三方合并                 先验证基线成立性，再逐岛
Phase 5  发布 1.0.35（用户拍板后）           omz-publish 流程
```

A2（3180 个测试文件）无独立 phase：哪个功能接线（用户点名 A 类功能时），哪个功能的测试随接线一起进。

### 关键约束（探索报告结论）

| 约束 | 依据 |
|---|---|
| 新文件落 `packages/*/src` 即被 `tsc -b` 编译，类型错误挡门 | 各包 tsconfig `include:["src"]` composite |
| architecture:check 对 unmanaged 模块直接跳过；knip 不在任何门 | `scripts/architecture/index.mjs:130-132`、根 package.json |
| 死代码唯一门禁 = `tsc -b`（根 11 项列表 + apps/zcode-cli 独立 turbo） | 根 package.json typecheck |
| ui/services/shared/client 无 build/exports 直指 src | 各包 package.json |
| 全新包需自建 package.json+tsconfig 并入 workspace/typecheck 列表 | pnpm-workspace.yaml |
| CI 仅 release-desktop.yml，无 PR CI → 分批安全性靠本地门禁 | .github/workflows |
| ours==base 是整取前提；违反即 C 类（licenses 岛实证） | 本 session 险情 |
| 三个 vendor 脚本裸 `git diff` 丢 R 状态 old 路径，rename 感知未实现 | vendor-graph.mjs:59/61 等 |

## 最终项目结构

```
scripts/
  vendor-graph.mjs        增强：-M + renameLimit=40000，changed 存 {status, oldPath}
  vendor-symbols.mjs      增强：--json；对齐 --list-importers 声明
  vendor-scope.mjs        增强：--json 结构化（boundary/status/oursModified/reasonKind）；
                           反向索引补 oursRoot 侧；--seed-dir 改 readdirSync；口径统一 ts/tsx
  vendor-wave.mjs         新增：读 wave 清单 → 批量 checkout/del → ours==base 守卫
                           → tsc -b → 失败登记（补依赖 or 押后）→ 写账本
docs/vendor/318/
  inventory.md            已存在
  waves/
    wave-NN-{pkg}.md      账本：文件清单、tsc 结果、押后项、commit hash
```

## 变更点清单

1. `scripts/vendor-graph.mjs` / `vendor-symbols.mjs` / `vendor-scope.mjs`：按上表增强（只读分析层）
2. 新增 `scripts/vendor-wave.mjs`（执行层，唯一会改工作树的 vendor 工具）
3. Phase 1/1b/3/4 产出的代码文件本身（来自 `git checkout b95ebaff -- <paths>` 或三方合并）
4. `docs/vendor/318/waves/*.md` 账本
5. Phase 2 新增 3 个包的 package.json/tsconfig + 根 typecheck 列表登记

## 详细实现步骤

- Step 1 — phase-vendor-tooling — blocking: yes — qa: auto：三个分析脚本统一 `-c diff.renameLimit=40000 diff -M`，changed 结构存 `{status, oldPath}`，A/D/R 口径对齐（R 的 old 路径不丢）
- Step 2 — phase-vendor-tooling — blocking: yes — qa: auto：vendor-scope --json 结构化（boundary、每文件 status/oursModified/reasonKind）；反向索引补 oursRoot 侧解析（ours 独有调用方不漏）；`--seed-dir` 的 `dir /b` 改 readdirSync
- Step 3 — phase-vendor-tooling — blocking: yes — qa: auto：新增 vendor-wave.mjs：`--from-json wave.json` 批量应用；**ours==base 守卫**（内容哈希比对 baseRoot，不等式成立即拒绝并归 C 类清单）；应用后自动跑 `tsc -b` 受影响包，失败输出到账本"押后"区
- Step 4 — phase-a1-landing — blocking: yes — qa: auto：用增强后的工具重出 A1 清单（现存包内、非测试的新文件，预计 ~969 个）；按包生成 wave JSON
- Step 5 — phase-a1-landing — blocking: yes — qa: auto：建 `upgrade/318-islands` 分支；按 shared(68) → server(5) → office-runtime(55) → web(51) → services(125) → desktop(87) → ui(491) → bootstrap(13)/core(12) 顺序逐包 vendor-wave 应用，每包一 commit（`feat(vendor-318): A1 <pkg> 落地 N 文件（死代码，无人引用）`）；tsc 红的文件押后并记因
- Step 6 — phase-a1b-newpkgs — blocking: no — qa: auto：design-plugin(16) / session-control(16) / plugin-api(8) 三包：建 package.json + tsconfig（照抄最小现存包），入 pnpm-workspace 与根 typecheck 列表，文件落地 + tsc 绿，一包一 commit
- Step 7 — phase-b-upgrade — blocking: no — qa: auto：B 类 226 岛逐岛：vendor-scope --json 出范围 → vendor-wave 应用（守卫必过，B 定义即 ours==base）→ 该包 tsc + 岛自带测试（如有且可跑）→ 一岛一 commit；**改运行时行为的岛（core/adapters/bootstrap）另跑定向回归或真子进程 E2E（test:mcp-live-recovery 模式）**
- Step 8 — phase-c-merge — blocking: no — qa: manual_user：先抽验基线：随机 20 个 C 类文件验证 `aac47556:<path>` 内容 == base 侧假设（v3.16 轮曾实证 83 个假 CLEAN）；再逐岛三方合并（`git diff base theirs -- path | git apply -3` 于 ours），合并结果逐岛人工过目
- Step 9 — phase-release — blocking: yes — qa: manual_user：阶段完成、全部门禁绿后向用户汇报；**版本号/时机问用户**；确认后走 omz-publish（CHANGELOG、bump、tag、release-desktop.yml）

## 测试策略

### 测试用例

- T-V1 — blocking: yes — Step 1：构造含 rename 的对照（用 `%TEMP%\renamed.txt` 已有 R 记录抽查 3 条），断言工具输出含 oldPath
- T-V2 — blocking: yes — Step 3：`scripts/licenses` 岛（ours 已改过 licenses.mjs）喂给 vendor-wave，断言被守卫拒绝且归入 C 类清单，不写工作树
- T-A1 — blocking: yes — Step 5/6：每包应用后根 `tsc -b` exit 0（apps/zcode-cli 不受影响则单独验证不受影响）；`test:v4-perf` 在 shared/services 落地后各跑一次不回归
- T-B1 — blocking: yes — Step 7：B 类岛若含行为修复，必须红验证（stash 产品改动 → 测试红 → 恢复 → 绿）
- T-B2 — blocking: yes — Step 7：运行时行为岛补定向 E2E（新 test:<topic> 脚本，登记进对应包 package.json，命名照 `test-<kebab-topic>.mjs` 约定）
- T-C1 — blocking: yes — Step 8：基线抽验 20 文件零假 CLEAN 才允许开合并
- T-R1 — blocking: yes — Step 9：发布门禁 = 根 typecheck + lint + apps/zcode-cli typecheck + magic-context test:all + test:v4-perf + typecheck-desktop-full + architecture check（omz-publish 全集）

## 风险与回滚方案

| 风险 | 缓解 | 回滚 |
|---|---|---|
| A1 死文件编译错误连片（上游新文件 import 我们没有的符号） | 每包一批、tsc 即门；红文件押后登记，不硬修 | 单包 commit revert |
| 新包注册把根 typecheck 列表拖慢/拖炸 | A1b 独立 phase、non-blocking，可整体搁置 | revert 包 + 列表登记 |
| C 类三方合并在错误基线上打补丁（假 CLEAN 先例） | Step 8 强制基线抽验门（T-C1） | 岛级 revert |
| 死代码长期无人引用产生维护噪声 | knip 已存在但未入门禁；A 类功能接线时由接线 PR 清理 | — |
| bootstrap 全量测试并行假红误导判断 | 沿用口径：单文件独跑 + git stash 对 HEAD 基线（记忆 #216） | — |
| vendor-wave 误覆盖 fork 改动 | ours==base 内容哈希守卫 + T-V2 回归钉死 | git restore（工作树级）+ commit 级 revert |

全程在 `upgrade/318-islands` 分支，main 不动；任何阶段可整体放弃（删分支）。
