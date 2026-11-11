---
name: omz-upgrade
description: Use when upstream ZCode publishes a new whole-tree sync and we need to inventory the delta, decide what to backport onto the omz 1.0.x stable line, scope upgrade waves, or shrink an uncontrollable change range. Covers the multi-dimension decomposition methodology (nature × dependency closure, down to symbol/hunk level) and the vendor-* analysis tooling.
---

# OMZ 升级（上游整包同步 → 1.0.x）

上游把每次发版压成**一个 sync commit**（v3.17.2→v3.18.0 = 5099 文件），没有 commit 边界可 cherry-pick。本 skill 用**三方对比**自己造粒度，把"差距"拆到可控范围再动手。

工具本体在仓库 `scripts/`（不是本 skill 目录，勿复制副本）：`vendor-graph.mjs` / `vendor-symbols.mjs` / `vendor-scope.mjs`。从仓库根运行。

## 0. 总纲（先读这个）

**拆分是多维交错的，不是单选。** 依赖维度（要带谁走）和性质维度（要不要看它）互相喂料；一种思路拆不开就换另一种，目的只有一个——缩小范围。两维不是并列，是互相削弱：**性质决定闭包的边**。

```
while (范围 > 可控) {
  ① 性质过滤  新增/纯机械/impl-only/无导出内部件 → 出局或闭眼跟（要不要看）
  ② 依赖闭包  向下（theirs 的 import 都要在）+ 向上（只跟破坏性符号）（要带谁）
  ③ 还大     → 回到 ①，对闭包内部再细分性质
  ④ 还大     → 降粒度：文件 → 符号 → hunk
  ⑤ 每步 tsc -b 当裁决（图产生候选，编译器做裁决）
}
```

向上传播的规则：**签名没变就不往上翻**；调用方自己的导出签名没变就停在该调用方。实测这是最大的削减器（69.3% 的修改是 impl-only）。

## 1. 每轮发版的准备工作

```bash
git fetch upstream main --tags          # 上游 = github.com/zai-org/ZCode
git worktree add D:/Dev/Js/omz-318 <新上游commit> --detach   # theirs
git worktree add D:/Dev/Js/omz-base aac47556 --detach        # base（1.0.x 分叉所基于的 v3.15.1，固定不变）
```

**陷阱 1：rename 检测必须显式抬高 renameLimit**，否则文件移动被拆成 A+D 污染全部统计：

```bash
git -c diff.renameLimit=40000 diff -M --name-status <base> <theirs>
```

**陷阱 2：上游习惯"删了换地方新建"**——纯移动很少（3.18 轮只有 155/6916），别指望 rename 解决问题。

## 2. Step 1：全量统计（性质 × 幅度）

对整个 delta 出矩阵，"文件数"必须按性质拆开才有决策价值：

```
新增 2208 | 删除 2065 | 修改 2488 | 纯移动 155
修改细分（性质×幅度）：
  纯注释 22 / 纯 import 45        ← 纯机械
  代码·表面未变 613               ← impl-only
  代码·无导出内部文件 866         ← 谁也 import 不到它，天然不传播
  代码·纯新增表面 166             ← 只加不删，旧调用方无感
  代码·表面破坏 776（文本口径上限）← 结构化判定会显著收窄
```

判"表面破坏"用结构化兼容四规则（`vendor-scope.mjs` 已实现）：成员顺序无关；纯新增不算 breaking；尾部可选参兼容；删除/改既有成员/必选变可选 = breaking。

产出落到 `docs/vendor/<版本>/inventory.md`（参考 3.18 轮的成品），下次发版改一个 ref 全部重出。

## 3. Step 2：岛屿划分（找外围波次）

```bash
node scripts/vendor-graph.mjs --partition --top 25 --examples
```

连通分量把 delta 切成岛。读法：小岛（≤5 文件）多是**上游新增但未接线**的文件，"独立"恰因没被接上；真正的波次候选是 10–90 文件的中型岛（ui 组件块、desktop 子功能、plugins、web、scripts）。主干会焊成一个巨块（3.18 轮 = 1793 文件）——**文件级粒度在主干不可用**，此时回到总纲换维度。

## 4. Step 3：波次盘范围（单点出击）

```bash
node scripts/vendor-scope.mjs --seed apps/zcode-cli/packages/adapters/src/mcp/index.ts --json wave.json
node scripts/vendor-symbols.mjs --file <路径> --verbose          # 看单文件哪些导出签名变了
```

`vendor-scope` = 向下文件闭包 ∪ 向上签名传播，输出每个文件进范围的理由。实测收敛：mcp adapter 52→10、fileService→3；主干 core mcp 831（此时按总纲回到 Step 1 拆性质：831 = 52% 新增 + 27% 机械 + 20% 实质，实质里再分修 bug vs 功能开发）。

**陷阱 3：「文件存在 ≠ 能直接搬」**——`ours == base` 只说明我们没改过，不代表依赖都在、接口都对。范围必须过依赖闭包。
**陷阱 4：barrel 假耦合**——`@zcode/x` 解析到 `src/index.ts` 全量 re-export，文件级闭包会被灌水；符号级要穿透 barrel 找真实来源（工具已处理）。

## 5. Step 4：验证与交付

- 范围应用后跑 `tsc -b`（受影响包），红了按报错扩张范围——**图只是候选，tsc 是 oracle**。
- 回移 bug 时必须**红验证**：回退产品改动跑测试确认旧行为下红，恢复后绿。
- bootstrap 测试套件单进程全量跑不可信（STACK_TRACE_ERROR / 假超时），判定红必须"单文件独跑 + git stash 对比 HEAD 基线"。
- 交付形态三选一，按范围性质定：
  - **叶子波次**（3–10 文件，表面稳定）：整文件搬，一波一 commit，独立可 revert
  - **主干 hunk 回移**（bug 修复集中在少数文件）：点对点按 1.0.x 形状重写（参考 `3ef91590` 回移模式），一条一 commit + 测试
  - **功能岛**（上游新子系统）：先决定"要不要"，再搬 + 接线；不接线就是死代码
- 发布走 `omz-publish` skill 的流程；**版本号和目标分支永远不猜，问用户**。

## 6. sanity anchor（3.18 轮实测，2026-11-11）

| seed | 文件级 | 符号级·文本 | 符号级·结构化 |
|---|---|---|---|
| `adapters/src/mcp/index.ts` | 52 | 1027 | **10** |
| `core/runtime/methods/mcp.ts` | 144 | — | 831 |
| `services/file/fileService.ts` | 3 | — | **3** |

全量：6916 变动源文件，修改里 62% 对调用方完全无感；主干实质改动 168 个，其中 37 个带「修复原因/Bug 根因」注释（即 CHANGELOG A 组清单对应的文件）。若新一轮的数字形态与此严重不符，先怀疑口径/工具，再下结论。

## 7. 相关

- 成品盘点：`docs/vendor/318/inventory.md`
- 工具实现：`scripts/vendor-{graph,symbols,scope}.mjs`（commit `ed181df0` `faae811f` `96cf13ab` `28ae2dc1`）
- 上游回移先例：`3ef91590`（MCP 断连恢复，按 1.0.x 形状重写的 hunk 回移范例）
