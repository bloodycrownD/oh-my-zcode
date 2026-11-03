---
name: omz-bug-repro-e2e
description: 用于 oh-my-zcode 的用户可感知 bug：先用真实 Electron E2E 打日志定死代码，至少 3 次同签名复现，再修复，再用同一脚本回归。用户报告“有时候/偶发/切换后正常”这类状态 bug 时优先使用。
---

# omz Bug 复现与 E2E 回归

面向 oh-my-zcode 仓库的用户可感知缺陷。核心原则：**单测不能作为结论**；必须真启动 Electron，用日志把现象钉到唯一代码路径，复现至少 3 次且签名一致，才允许修。

## 适用

- 用户报“有时候/偶发/切换会话后正常/重启后恢复”的状态 bug。
- UI 显示、草稿/选择状态、虚拟列表位置、未读/蓝点、分页/截断、发送门禁。
- 需要先判断是回归还是历史问题时。

## 不适用

- 纯文案/样式微调、无状态的一次性错误。
- 已有稳定单测且用户只要结论的只读调查（可以只读，但不要声称“修好”）。

## 铁律

1. **未 3 次同签名复现，不改实现代码。**
2. **不用单测替代 E2E。** 单测只能作为修复后的补充防线。
3. 日志必须能区分候选路径；区分不了就继续加探针，不猜。
4. 修复前做一次突变验证：临时改对目标行 → 复现用例转绿 → 立即还原。
5. 修后必须用**同一份 E2E spec** 跑 3 次全绿，并检查无重复 setState、无 React 告警。
6. 探针文件收口前还原；`git status` 只留修复本身和必要测试。
7. 不提交、不发版，除非用户明确要求。

## 阶段

### 1. 固定症状

先问清或从证据确认三件事：

- “空”是纯空白，还是占位文案（`选择模型`/`管理模型`）？
- 是新建会话还是会话内？
- 触发动作与恢复动作各是什么（清空输入、切会话、重启、等待）？

没有这三点，先做只读代码链路调查。

### 2. 起真实应用

仓库已有一套 WebdriverIO + `wdio-electron-service` 基建，命令可复用：

```bat
pnpm --filter @zcode/e2e-report build:node
node packages/desktop/scripts/ensure-e2e-desktop-build.mjs
set ZCODE_E2E_SKIP_BUILD=1 && set ZCODE_E2E_SKIP_AGENT_BUILD=1 && node_modules\.bin\wdio.CMD run packages/desktop/wdio.conf.ts --spec "<spec>"
```

已知坑：

- E2E 数据根是 `~/.omz`（与产品一致）。若 fixture 仍写 `~/.zcode`，说明 sweep 没做完，不要手工复制绕行，直接修 fixture。
- 构建必须走 `ensure-e2e-desktop-build.mjs`（内部有共享 build lock）；不要直接 `build:no-runtime-assets` 与别的 agent 抢写 `packages/desktop/out`。
- 本机 Node 22 目前可跑，但 `mise.toml`/`engines` 要求 Node 24；优先用 mise，Node 22 只作为临时兜底。
- `Read` 工具不能渲染 PNG；用 DOM/data-\* 与探针 JSON 作证据，截图只作附件。
- 应用正在运行时 LevelDB 会被锁；只读扫描要逐文件 try/catch，跳过 `LOCK`。
- 真实草稿/候选状态可从 `%APPDATA%\omz\session\Local Storage\leveldb` 只读扫描；注意值可能是 UTF-16LE，键是 Latin1。

### 3. 加最小探针

只加状态快照，不改逻辑。典型两个 phase：

- 状态 owner（如 `useDraftConfigControl`）：`initialization`、`initGateOpen`、`initApplied`、`compensationApplied`、`draft.textLen`、`draft.mode`、`draft.modelSelection`、`storedDraft`、`view.status`、`view.effectiveSelection`、`view.preferredSelection`、`view.selectionIssue`、`derived.effectiveSelection`、`sessionConfigPresent`、`sessionConfigModelSelection`、`submissionReady`。
- 渲染层（如 `V4ComposerToolbar`）：`modelMenuVisible`、`status`、`groupCount`、`normalizedValue`、`triggerLabel.fullLabel`、`data-provider`、`data-model`、`data-mode`、`disabled`。

探针可以写 `window.__probe` 队列，E2E `execute` 取回；不要只 `console.log`（CLI 日志里未必有 renderer 输出）。

### 4. 跑矩阵与签名

每个变体至少 3 次；签名要剔除时间戳、路径、随机 id 后比对。至少包含：

- 对照（正常路径）；
- 候选 1、候选 2；
- “用户恢复动作”前后各一帧；
- 冷启动首帧（如果怀疑时序）。

签名一致才进入下一步；否则把差异列出来，说明是“偶发”还是复现条件没找对。

### 5. 定死代码

- 用 `file:line` 写出唯一路径。
- 做突变验证：临时改目标行 → 对应 E2E/断言转绿 → `git checkout -- <file>` 还原。
- 如果临时改完不转绿，说明路径判断错了，回到阶段 3。

### 6. 修复与回归

- 只改被日志钉死的那条路径；不顺带重构。
- 跑：`tsc -b` 对应包、`oxlint` 目标文件、相关 UI 测试。
- 重建 renderer，确认修复进 bundle（可在 `out/renderer/assets` 搜索新增标识）。
- 同一 E2E spec 3 次全绿；记录 `data-*`、探针、截图路径。
- 检查 `probeGrowth2s=0`、无 `Maximum update depth`/`Cannot update a component`/`Too many re-renders`。
- 还原探针，重新构建，确认 `out/renderer` 无探针字符串。

## 常见判别式（oh-my-zcode）

- 模型选择器：`data-model` 非空 + `normalizedValue` 空 = 渲染层冷启动/分组过滤；两者都空 = 状态层（草稿/会话/view）。
- 模型选择器：`selectionIssue=provider-not-found/model-not-found` 是硬失效，可回退；`selection-missing` 是草稿没写；`reasoning-level-*` 是档位问题，发送门禁会静默为 null。
- 未读蓝点：蓝点是 `unreadAt`，不是终态；`unread` 优先级高于 `loading` 会顶掉运行中转圈。
- 虚拟列表：`scrollMargin` 只在列表自身尺寸/`tasks.length`/window resize 时重算；列表纵向位移变化不会触发，表现为行整体偏移。
- 分页/截断：先确认磁盘正文完整，再看 manifest `firstMessageId` 是否落到轮内 assistant（model-only 轮常见）。

## 证据模板

```md
## 复现

- 应用/版本：
- 操作：
- 3 次签名：
- 截图/报告路径：

## 定死

- 代码路径：file:line
- 日志证据：
- 突变验证：改哪行 → 哪个用例转绿 → 已还原

## 修复

- 改动文件：
- 为什么只改这里：
- 本地门禁：typecheck / lint / 相关测试

## 回归

- 同一 spec 3 次：通过/失败
- data-\* / 探针：
- 重复 setState / React 告警：
```

## 禁止

- 用单测跑绿就宣称修复。
- 没有 3 次同签名就改代码。
- 把探针留在生产包里。
- 修完不跑同一 E2E。
- 顺手重构、顺手改无关路径。
