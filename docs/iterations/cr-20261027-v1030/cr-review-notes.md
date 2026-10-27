# CR 评审记录（round 1 首诊，两个 scope 并行 readonly）

对象与基线：`main` @ `ea08001e`（v1.0.30 已发布）
- scope-fix：`8669819a..684f9a55`（MC source 判据修复，3 文件 +86−9）
- scope-c：`"5306cc27^1"..5306cc27`（session-open-latency 合入，96 文件 +25142−606；只审 9 个核心文件）

两 scope 均 **not-ready**。以下为原始结论摘要与到 fix-spec 的映射。

## scope-fix 的 must_fix

| 原始 id | 级别 | 一句话 | 映射 |
| --- | --- | --- | --- |
| fix/B-1 | P1 | 新判据与 `heuristic-cleanup` 故意改写 source 冲突 → 非 routine pass 注入回 wire、cache 振荡、每 pass 多写 2 次 DB、`droppedInjections` 虚增 | CR-1 |
| fix/B-2 | P2 | 纠正 source 后未同步 tag `byte_size`/`token_count`，账务停在旧消息尺寸 | CR-8 |
| fix/F-1 | P2 | 注释「不一致只能说明 tag 已指向另一条消息」不成立；「一致时恢复 source 保字节稳定」为空操作 | CR-9 |
| fix/G-1 | P2 | b5 抓不住「纠正未落库」：把 `replaceSourceContent` 换回 `saveSourceContent` 仍全绿 | CR-10① |
| fix/G-2 | P2 | b5 只有单 text part，message 级误写仍全绿 | CR-10② |

scope-fix open_questions（5 条，见 fix-spec「Open questions」1–5）：upsert 弱化 INSERT OR IGNORE、宿主是否回灌 MC 输出、`skipPrefixInjection` 下的前缀、`caveman_depth` 是否随 rewind 迁移、`harness` 列 provenance。

## scope-c 的 must_fix

| 原始 id | 级别 | 一句话 | 映射 |
| --- | --- | --- | --- |
| B-1 | P1 | 窗口化 + facts 作废后 `totalCount`/`firstRowId` 用窗口长度冒充全序（真机 160 vs 5255），A2 还把错误行为钉成契约 | CR-2 |
| C-1 | P2 | `hydrateRowManifest` 读清单期间的换行事件不登记，过时清单被当权威注入 | CR-3 |
| C-orch-1 | P2 | `rowsRange` 在 facts 缺席且请求窗口之上时无诊断落点 | CR-4 |
| G-1 | P2 | 并发门禁只校「键存在」不校「分类值」，写命令标成 readonly 全绿 | CR-5 |
| B-2 | P2 | 7 条 dwf 读面会 `ensureRuntimeReady`，违反只读判据①，例外只写在行注释 | CR-6 |
| H-1 | P2 | 懒历史闸门 check-then-act，两入口重叠时历史进两份 | CR-7 |

scope-c open_questions（6 条，见 fix-spec「Open questions」6–10 + 页物化/诊断表相关）：subscribe 的副作用靠四个单飞兜底、resync 并发丢帧、页物化丢 fileChange 摘要、页物化无单飞、页 `atSeq` 取当次投影水位、`disposeSession` 不清诊断表。

## scope-c 写入口清单（改变行集合/投影/manifest 事实的写点）

`ingest`（清 facts + 广播，有断言）｜`rehydrate`（显式清 facts，有断言）｜`seedRowManifestFacts`（只写不清、无签名校验 → CR-3）｜`clearRowManifestFacts`（有断言）｜`seedRowIdOrigin`/`seedTurnModelBaseline`（有行时抛错 fail-fast，有断言）｜`seedConfig/Usage/Subagents`（不产 delta + resync，有断言）｜`applyEvent` 批量/原子路径（行序记账，有断言）｜`row.removed`（与截断同提交，有断言）｜`ingestNormalizedEvent`（无条件作废索引，有断言）｜hydration buffer 重放环（补写 manifest，有断言）｜`hydrateRowManifest`（读→判定→seed，**缺读期间变更** → CR-3）｜`rebuildRowManifestFromProjection`（有断言）｜`rewriteTurnManifestBranchForRewind`（detached，无 gateway 级断言）｜`recordTurnManifestForEvent`（detached）｜`rowsRange` 按页物化（不驻留，**缺 facts 缺席落点** → CR-4）｜`seedRuntimeFacts`（resync + flush，有断言）｜`markViewReady`（有断言）｜`disposeSession`（**未清 4 张诊断表**，见 spec_deviations 5）

## 正面结论（如实记录）

锁的实现未发现缺陷：获取/释放成对（同步抛错与异步 reject 两条路都 `release`，无 double-release）；无读写重入死锁（`pumping` 重入保护、同 requestId 降级为独占）；FIFO 严格（读者不越过已排队写者、写者出队前不放新读者、`waitForIdle` 覆盖排队与在飞）；旁路仅 `session/stop` 与 `workspace/cancelGenerateText` 两条（K6 源码断言）。唯一推论：stop 可能被一条长只读挡到该只读排空，与改造前等价，只缺 spec 说明。

## 最可疑的三处分类

1. 7 条 dwf 读面（`readonly`）——会触发整条 runtime 激活，是判据①的直接违反（→ CR-6）。
2. `conversationSubscribe`（`readonly`）——副作用最多（注册、建外壳、rehydrate、seed、markViewReady、prewarm 激活），归只读是性能必需，但只靠四个单飞兜底。
3. `conversationResync`（`readonly`）——写 `sentSeq`/`buffer`/`inFlight` 并 supersede 前一个 reservation，并发 resync 会丢一份帧，约束不在协议与测试里。
