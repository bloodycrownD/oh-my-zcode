# 上游 v3.15.1 → v3.18.0 升级盘点（1.0.x 视角）

> 2026-11-11。只读分析，不含任何代码升级。目的：把"1.0.x 距上游 3.18 有多远、按什么粒度跟"变成可统计、可复跑的口径。

## 0. 三方对比口径

```
base   = aac47556  上游 v3.15.1 同步 commit（1.0.x 分叉所基于的最后一次上游同步）
theirs = b95ebaff  上游 v3.18.0（2026-11-11，单 commit 整包同步）
ours   = main      1.0.x（v1.0.34）
```

配套只读 worktree：`D:/Dev/Js/omz-base`（base）、`D:/Dev/Js/omz-318`（theirs）。

## 1. 全量统计（6916 个变动源码文件）

| 变动性质 | 数量 | 占比 |
|---|---|---|
| 新增 | 2208 | 32% |
| 删除 | 2065 | 30% |
| 修改 | 2488 | 36% |
| 纯移动（rename 相似度 ≥90%） | 155 | 2% |

**修改的 2488 个文件按「性质 × 幅度」细分**（性质由变更行分类 + 导出表面对比得出）：

| 性质 \ 幅度 | 微小 | 小 | 中 | 大 | 合计 |
|---|---|---|---|---|---|
| 纯注释 | 14 | 6 | 2 | 0 | 22 |
| 纯 import/导出语句 | 32 | 6 | 6 | 1 | 45 |
| 代码·表面未变（impl-only） | 241 | 220 | 112 | 40 | 613 |
| 代码·纯新增表面 | 18 | 36 | 51 | 61 | 166 |
| 代码·无导出（模块内部文件） | 173 | 255 | 271 | 167 | 866 |
| 代码·表面破坏（文本口径上限） | 100 | 219 | 228 | 229 | 776 |

读法：

- **对调用方完全无感的 = 1546 个（62%）**：纯注释/纯 import（67）+ 表面未变（613）+ 无导出内部文件（866，谁也没 import 它的符号，改动天然不传播）。
- **兼容新增 166 个**：只加不删，旧调用方不受影响。
- **表面破坏 776 个是文本口径的上限**——结构化兼容判定（成员顺序无关、纯新增不算 breaking、尾部可选参兼容）会显著收窄，实测同一文件从 1027 → 10。

实质改动（中+大，965 个）按区域：

```
290  pkgs/ui          163  cli/core        132  pkgs/desktop
104  cli/bootstrap     64  pkgs/services     56  cli/adapters
 36  pkgs/shared       21  pkgs/zcode-server-cli   16  cli/contracts
 13  cli/dynamic-workflow   12  pkgs/web     11  scripts
```

## 2. 三层分解与各层结论

### 层 1：文件级连通分量（vendor-graph --partition）

7030 个变动源文件 → 4631 个岛：4608 个 ≤5 文件（多为上游新增、尚未接线的文件）、18 个 6–20、2 个 >100（**1793 文件主干巨块** + 177 文件 desktop 块）。剔除 barrel 只降 14 个 → **主干巨块是真耦合，不是 barrel 假象**。结论：文件级粒度在主干不可用。

### 层 2：变动性质分类（本文件 §1）

831 文件的 core 主干范围拆开：52% 新增、27% 机械/小改、20% 实质改动。纯移动几乎不存在（上游习惯"删了换地方新建"，git rename 只配对上 155/6916）。

### 层 3：符号级范围（vendor-scope）

```
S = 向下（theirs 侧文件闭包：保证 import 都在）
  ∪ 向上（只跟「签名变了」的符号；调用方自己的导出签名没变就停）
```

同一 seed 的收敛对比：

| seed | 文件级 | 符号级·文本签名 | 符号级·结构化兼容 |
|---|---|---|---|
| `adapters/src/mcp/index.ts` | 52 | 1027 | **10** |
| `core/runtime/methods/mcp.ts` | 144 | — | 831 |
| `services/file/fileService.ts` | 3 | — | **3** |

结构化兼容四规则：成员顺序无关；纯新增不算 breaking；尾部可选参兼容；删除/改既有成员/必选变可选 = breaking。

## 3. 升级思路（本轮学到的方法论）

1. **「文件存在 ≠ 能直接搬」**：`ours == base` 只说明我们没改过，不代表依赖都在、接口都对得上。必须做依赖闭包。
2. **签名没变就不往上翻**：69.3% 的修改是 impl-only，这是范围削减的最大来源。向上的传播只在「导出签名变了」时发生，且调用方自己的签名没变就停。
3. **先分性质再谈范围**：新增/删除/机械改/实质改四类混在一起的"文件数"没有决策价值；52% 的新增文件要逐个决定要不要，而不是"升级"。
4. **rename 检测必须显式抬高 renameLimit**（`git -c diff.renameLimit=40000 diff -M`），否则移动被拆成 A+D 污染全部统计。
5. **图只产生候选，tsc 是 oracle**：闭包算出的范围要靠 `tsc -b` 验证，红了按报错扩张。
6. **三层策略**：叶子/接口稳定的子系统走整文件波次（3–10 个/波）；主干走 hunk 级点对点回移（bug 修复集中在 37 个文件）；新功能走功能岛（新增+接线）。
7. **上游是单 commit 整包同步，没有 commit 边界**——一切粒度都要自己造（三方对比就是替代品）。

## 4. 与 1.0.x 的对接

- 主干 831 范围里的实质改动 168 个，其中 **37 个带「修复原因/Bug 根因」注释**（`turn.ts`、`steering.ts`、`context.ts`、`background-notifications.ts`、`session-fork.ts`、`resume.ts`、`message-persistence.ts`…），与 CHANGELOG 盘点的 A 组 15 条用户可感知修复对应。
- 上游新子系统（1.0.x 完全没有）：app-control、受管 worktree、voice-input、active-transcript、cli-session-control、plugin-discovery、data-sync、design-plugin、node-repl-host、session-control 等——这些是"要不要"的产品决策，不是升级。

## 5. 工具与复跑方式

| 工具 | 作用 |
|---|---|
| `scripts/vendor-graph.mjs` | 文件级闭包（--seed）与全量划分（--partition） |
| `scripts/vendor-symbols.mjs` | 单文件导出符号 diff + 引用方穿透 barrel |
| `scripts/vendor-scope.mjs` | 合一版：向下闭包 + 向上签名传播（--json 出清单） |

```bash
git worktree add D:/Dev/Js/omz-base aac47556 --detach
git worktree add D:/Dev/Js/omz-318 <新上游commit> --detach   # 每次发版重建
node scripts/vendor-scope.mjs --seed <文件> --json wave.json
```

相关 commit：`ed181df0`、`faae811f`、`96cf13ab`、`28ae2dc1`。
