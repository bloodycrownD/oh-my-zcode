# CR Fix-Spec 证据包：②⑥ ui/exec 域——主代理手工审查（兜底）

- 审查对象：`docs/iterations/bugfix-batch-20261009/cr-fix-spec.md`
- 仓库：`D:\Dev\Js\oh-my-zcode\omz`；sha：5a35027；轮次：spec-check r1
- 取证方式：evidence 代理 provider 故障（原始+2 续派+重派均亡，未留包）。**主代理手工审查**（skill 失败处理规则：重试耗尽转手工，标注于此）。
- 规则：git 只读；未修改任何代码/spec。

## uix/A-1（P1）guard 释放信号竞态 → measuredKeys tracker

### 代码事实
- 写点 1：`ConversationTimeline.tsx:794-806` `measureElement` useCallback，`:801` `heightCacheRef.current?.set(sessionKey, cacheKey, height)`——行号准确。
- 写点 2：`:1183-1206` liveTail useLayoutEffect，`:1188-1192` `cacheHeight`，`:1190` 同一 `set` 调用——行号准确（fix-spec 写 :1188-1201，实际 observer 逻辑延至 :1206+，可接受）。
- 释放 effect：`:1701-1750`（fix-spec 写 :1701-1760）——`:1702` armed 早退、`:1703` `new Set(virtualizer.measurementsCache.map(item=>item.key))` 非响应式快照、`:1704` tryRelease。行号准确。
- 判定纯函数：`timelineRowHeightCache.ts:145-162` `canPlaceSessionInitialAnchor`——入参 `measuredKeys: ReadonlySet<unknown>`，判首项 `unitKeys[0]`。fix-spec 描述准确。

### 可疑点 A1-a（P1 级）：tracker 未定义 per-arm 语义，重访会话会借 tracker 复活 bug
- 事实：两写点写的 `heightCacheRef`（timelineRowHeightCache）是**全局 LRU、按 sessionKey 持久**（4000 条容量，跨会话切换保留）。会话 A→B→A 重访时，A 的旧键仍在缓存。
- 推论：若 measuredKeys tracker 由「缓存已有键」派生、或在 arm 时不清零，重访 A 的 guard 会在首个 commit 即用**上一次访问**的键释放——这正是 guard 要防的跳顶回归（tanstack measurementsCache 每实例重建，而 heights 缓存不重建）。
- spec 现文字只说「写点维护 measuredKeys + 释放 effect 判 has(首个 unit key)」，**未写 tracker 在 arm（切会话）时清零/换代**。验收例 a/b/c 也不含「重访会话」用例。
- 要求：spec 明示 tracker 为 per-arm 代际（arm() 清零或 generation 计数），验收补「A→B→A 重访：arm 后首个 commit 不释放，待本会话新测高到达才释放」用例。

## uix/B-1（P1，含 N-1）截断收尾状态判定 + 结果面信号

### 代码事实
- `node-execution-adapter-run.ts:110-114`：`outputLimitDetected` 标志存在，注释明说覆盖「requestStop 被 `file && exited` 抑制」场景——r1 修订措辞（非死标志）与代码一致。
- `:164-165`：`requestStop` 守卫 `executionSettled || stopRequested || (file && exited)` → return（`outputLimitExceeded` 不置位）。
- `:251-257`：`watchBashLimit` 上膛守卫 `if (!file || exited || stopRequested) return;`；onLimit 回调 `:254` **无条件** `outputLimitDetected = true` 后才 `:255` requestStop。
- 主缺口确认：看门狗 5s 轮询（`bash-file-output.ts:10` OUTPUT_WATCH_INTERVAL_MS=5_000，`:203-219` watchLimit stat→onLimit），子进程在两次 poll 之间自然退出且未触发任何 onLimit → 两标志皆 false。
- `:333-343`：截断门 `else if (outputLimitExceeded || outputLimitDetected)` → `truncateBashOutputAfterKill({filePath, closePromise, killCompletion: bashProcessTreeKill, limitBytes, onDebug})`。
- `:351` `if (file && outputLimitExceeded) cancelled = true;`；`:360-370` failure 选择（output_limit 文案在 `:362-368`）。
- 落地性：`bash-file-output.ts:47-80` `truncateBashOutputFileKeepHeadTail` **已自判** `:56` `if (size <= limitBytes) return undefined;`——「isBashOutputOverLimit 轻判定（stat 比较）」可直接按同形状新增，或复用该自判语义。N-1 结果面附注可写入 `:360-370` failure message / onDebug 通道。**改法可落地**。
- 可疑点 B1-a（轻微）：fix-spec 改法保留 `outputLimitDetected ||` 与新增 stat 判定并存的写法；因 stat 判定（exit 时 size>limit）在标志置位的场景必然为真，二者并列语义上冗余——保留无害，但 spec 可注明「stat 判定严格覆盖标志场景，标志保留仅为少一次 stat IO 的快路径」以免实施者困惑。

## uix/B-2（P1）截断预算扣 marker

- `bash-file-output.ts:18`：`BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES = 256` **已定义**；`:47-80` 窗口收缩 `:58` `headKeep = min(headKeepBytes, floor(limitBytes/2))`、`:59` `tailKeep = min(tailKeepBytes, limitBytes - headKeep)`——**确实未扣 marker**（finalBytes = head+marker+tail ≤ limit+marker，:37-39 doc 注释自认「上限+标记行之内」）。spec 改法（budget = limit - MARKER_MAX）直接可落地。**无问题**。

## uix/G-1（P2，r1 硬性修订=四闸门）toolOutputs cleanability

### 代码事实（四闸门逐一核对）
- 闸门① `storageCatalog.ts:259`：`if (categoryId === "other" || CLEANABILITY[categoryId] === "none") return [];`——none 时 override 分支 `:262-265`（`CLEAN_PATH_OVERRIDES[categoryId]` 枚举）不可达。✓ fix-spec 属实。
- 闸门② `storageService.ts:84-86`：`clean()` 先 `getStorageCategoryCleanability(...) === "none"` → `throw new Error("storage category is not cleanable: ...")`。✓
- 闸门③ `cleanPlan.ts:45-47`：`planStorageClean` none → `{targets: [], skippedCount}`。✓
- 闸门④ `usageAggregate.ts:73`：`categories[].cleanability: getStorageCategoryCleanability(id)` → UI `StorageCategoryList.tsx:37` `const cleanable = category.cleanability !== "none" && category.bytes > 0;`（cleanable 门控清理按钮）。✓
- `hasStorageCleanPathOverride(categoryId)` **已存在**（cleanPlan.ts:62 在用）——四闸门统一以其优先于 none 门，函数无需新建。✓
- 既有测试 `storageExecOutputClean.test.ts:173-184` T-C2-4a：`:174` `assert.equal(hasStorageCleanPathOverride("toolOutputs"), true)`、`:175` `assert.notEqual(getStorageCategoryCleanability("toolOutputs"), "none")`——`:175` 确实把「回 none」锁死，须改写。✓

### 可疑点 G1-a（P1 级）：r1「回 none+四闸门放行」路线不闭环且比替代方案重
- 事实链：类别回 none 后，闸门①—④全要加 override 优先级；且 UI `:37` 以 cleanability 门控按钮——**none 时清理入口从 UI 消失**。要让「入口仍工作」，还得给 aggregate 增加 override 语义字段并改 UI 判定（`cleanability !== "none" || hasOverride`）→ 实为 service 四处 + aggregate + UI 的六点改动，且 T-C2-4a `:174-179` 的 none 家族断言、`:175` 全要改写。
- 而当前已提交行为（toolOutputs="safe" + CLEAN_PATH_OVERRIDES + isStoragePathInCleanScope 双收敛）：**删除范围已正确收敛到 cli/exec**（getStorageCleanScopes :262-265 只枚举 override 前缀；planStorageClean owned 过滤），唯一错误是**展示面**（类别行 cleanable 徽标暗示整组可清）。
- 替代路线（更小且不丢 6c 功能）：保持 `"safe"`，aggregate 暴露 override 范围信息（如 `cleanScope: "paths"` 或复用 hasStorageCleanPathOverride 的类别注记），UI 徽标/文案收敛为「仅 cli/exec」；service 三闸门零改动；T-C2-4a `:175` 保持，仅追加展示语义断言。
- 要求：spec 必须在两条路线中显式拍板并写全改动面——现文字（回 none+四闸门）按上事实**不闭环**（缺 UI `:37` 与 aggregate 字段两项），照做会得到「服务层可清但 UI 无入口」的半成品。

## uix/G-2（P2）在飞保护时钟基准

### 可疑点 G2-a（改法为 no-op）
- 事实：`cleanPlan.ts:100-105` `filterInactiveFiles` 判据 `now - candidate.mtimeMs > EXEC_OUTPUT_ACTIVE_WINDOW_MS`——mtimeMs > now 时差值为负，`负数 > 24h` 为 false → **未来 mtime 文件已被算术排除、天然不删**。spec 的「前置 `mtimeMs <= now` 过滤」行为上零变化。
- 真实剩余风险仅是「时钟回拨/前跳导致窗口失真」的回归锁定——交付物应是 fake clock 测试（验收里已有），改法段应改写为「显式卫语句仅作可读性/防御（可选）；核心交付=两例时钟测试锁定现有算术语义」，避免实施者以为有行为修复。

## uix/G-3（P2）测试缺口四项

- `truncateBashOutputAfterKill` 定义于 `bash-file-output.ts:109`（export）——直测 4 例可行。✓ 其余（LRU/POSIX 登记）无锚点问题。

## uix/C-1（P2）截断 5s 逃逸

- `execution-utils.ts:23` `FORCE_EXIT_AFTER_KILL_MS = 5_000`、`:29` `BASH_OUTPUT_TRUNCATE_WAIT_MS = 5_000`（注释 :24-28 自述「同档」）——r1 校正行号准确。改法（WAIT 提到 > kill 上界 + 逃逸 message 附注）可落地。✓

---

## ②⑥ 域可疑点汇总
| 编号 | 条目 | 事实 | 严重度建议 |
|---|---|---|---|
| A1-a | uix/A-1 | heights 缓存跨会话持久；tracker 未定义 per-arm 清零 → A→B→A 重访借旧键误释放（跳顶回归复活）；验收缺重访用例 | P1 |
| B1-a | uix/B-1 | 标志与 stat 判定并列冗余，spec 宜注明保留理由（快路径） | P2（措辞） |
| G1-a | uix/G-1 | 「回 none+四闸门」不闭环：UI :37 以 cleanability 门控按钮，none 后入口消失，还需 aggregate 字段+UI 判定共 6 点改动；替代路线（保持 safe+展示收敛）更小且不丢 6c 功能 | P1 |
| G2-a | uix/G-2 | 前置过滤与现有算术等价（no-op）；应改写为测试锁定+可选卫语句 | P2（改法失效） |
