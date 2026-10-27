# CR Fix Spec: v1.0.30 修复 与 C（session-open-latency）并发/窗口化

## 元信息

- repo：`D:\Dev\Js\oh-my-zcode`，分支 `main`（v1.0.30 已发布，HEAD `ea08001e`）
- 对象一（修复）：`8669819a..684f9a55`（3 文件 +86−9），spec `docs/iterations/bugfix-batch-20261025/bugs/edit-resend-stale-text/spec.md`
- 对象二（性能改造）：`"5306cc27^1"..5306cc27`（96 文件 +25142−606），spec `docs/iterations/session-open-latency/spec.md`；评审范围收窄到 9 个核心文件，must-fix 实际触达 ≥12 个源文件
- 评审记录：`docs/iterations/cr-20261027-v1030/cr-review-notes.md`（两 scope 原始结论与映射）
- 模式：diff（1 轮 readonly 评审 + 3 轮 spec-check 复审）
- review_round / dag_version：8 / 8
- 状态：**execute-ready（待用户确认后开工）**——P0=0、P1 已闭合；CR-1 为方案 A（零 schema）

### 复审收敛史

| 轮次 | 结论 | 主要发现 |
| --- | --- | --- |
| round 1（首诊） | No-Go | 4 P0 + 2 P1：CR-1 验收与推荐方案互斥、provenance 置位点会把编辑重发带回来、CR-2 空窗口、CR-8 恒真断言；两 scope 报告未归档、CR-6 无形状断言 |
| round 2 | No-Go | 2 P0 + 4 P1：CR-2 判据与兜底互斥、`rows.rowIdOrigin` 不存在；CR-1 片段不可编译、派生比较漏 caveman 子集；CR-5 反验证空操作、CR-8 token 断言不可区分 |
| round 3 | No-Go | 1 P0 + 2 P1：CR-1 的 `derived` **无条件恢复**会把编辑重发症状放回 wire（且与自验收第 3 步矛盾）、caveman source 契约被冻结；CR-5 例子仍在 K6 pin 内；CR-10 断言与新返回类型互斥 |
| round 4 | No-Go（P0=0） | 1 P1 + 8 P2：CR-10 的期望正文与 b5 夹具 / CR-8 三方互斥；`TagTarget` 字段漏写、`:258` drop 派生落法、`setTagTokenCount` 落点、`TagEntry.tokenCount` 理由、`hasOlderRows` 表现、Closure 计数 |
| round 5 | **Go（P0=0，P1 已闭合）** | 1 P1 + 5 P2：CR-6② 的「严格相等」与 34 条只读冲突（改子集断言）；`hasOlderRows` 文件引用与 Spec deviations 旧措辞；b5 行号清单漏 `:971/:979`；CR-8 三处引用不实；`derivedFrom` 兜底不一致；heuristic 尺寸同步未覆盖 |
| round 6（本轮之前） | 已闭合 round 5 的 6 项 | 子集断言、五处行号、导入方式、`derivedFrom: pristine`、显式不覆盖、`hasOlderRows` 位置与 `loadAllOlder` 守卫 |
| round 7 | No-Go（P0=0） | 3 P1：replay 缺 drop 语义（整段注入会写出裸 `§N§`/空串）、CR-10 仍用已废弃的对象化 API、CR-9 仍要求写 `derived`；方案 A 的方向、落点、`protectedCutoff` 可达性、零 schema 均被核实成立 |
| round 8（本轮） | 已闭合上述 3 项 | replay 加「整段只剩注入则跳过」，b6 加第 6 段钉住；CR-9/CR-10 改成 pristine 语义；补改动四（同 pass caveman 复活）、FORK 标记、首次剥离未计价；清理 CR-8 / Open questions / QA 里的旧方案残留 |

## 结论摘要

两个 P1 **都已在发布版（v1.0.29 / v1.0.30）里**：

1. **CR-1**：v1.0.30 的 source 相等判据与 `heuristic-cleanup` 的「故意把 source 改写成派生文本」契约冲突，会在「带 system 注入的消息 + 后续非 routine pass」下让注入重新回到 wire（token 回涨、prompt cache 振荡）。
2. **CR-2**：窗口化投影 + manifest 事实作废后，快照的 `totalCount` / `firstRowId` 退化成窗口长度（真机 160 行 vs 5255 行），滚动条与 `hasOlderRows` 一起崩塌。升级成全量投影的路径已删除（`v4-gateway.ts:4445-4448`），窗口化持续整个会话生命周期。

其余 8 条 P2 见下。锁的实现本身未发现缺陷（获取/释放成对、无重入死锁、FIFO 严格、旁路仅 stop / cancelGenerateText 两条）。

## Must-fix（按 P0 → P1 → P2）

### CR-1 [P1] 新 source 判据与 heuristic 派生改写冲突
- 维度：B（正确性）/ A（与既有契约冲突）
- 文件：`apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/heuristic-cleanup.ts:226,258,281`（删两处 `replaceSourceContent`）；`.../transform.ts:2521`（replay 落点）、`:2299`（`protectedCutoff` 来源）；新增 `replaySystemInjectionStrips`（建议放 `caveman-cleanup.ts` 旁或同目录新文件）；`.../tag-messages.ts:923-931`（**不改**，仅作为判据正确性的前提）；上游对照 `.reference/magic-context/packages/plugin/src/hooks/magic-context/tag-messages.ts:893-896`、`heuristic-cleanup.ts:252,275`
- 问题：`heuristic-cleanup` 在 routine pass 里**故意**把 `source_contents` 改写成「剥离 system 注入后的派生文本」（`:281`），整段被吃光时写 `""`（`:258`）。而 v1.0.30 的判据把「persisted source ≠ 入站正文」一律解释为「该 tag 已指向另一条消息」，于是下一个非 routine pass（defer/force 轮）会把带注入的宿主原文判为「新正文」，覆写 source 并把注入放回 wire：reminder 回涨 token、与上一 pass 字节不同导致 prompt cache 失效，且每个 routine pass 多写两次 DB、`droppedInjections` 虚增。
- 改法（**定稿：方案 A —— 让 `source_contents` 回到单一语义，剥离改为每 pass 幂等重放，零 schema 改动**）。

  **核心判断**：`source_contents` 只应存 pristine 原文。上游三处文档都这么写（`caveman-cleanup.ts:28`「压缩永远从 pristine 原文出发，绝不从已压缩文本」、`:35`「`source_contents.content` is unchanged (remains the pristine original)」、`storage-db.ts:2221`「the ORIGINAL pre-caveman text is `source_contents.content`」），是 `heuristic-cleanup` 的派生写入违反了它。让实现回到契约后，v1.0.30 的判据自动正确，**不需要任何新状态**（`derived` / `derived_from` / `TagTarget.inboundSource` 全部不引入）。

  **改动一：heuristic 停止写 source**（`heuristic-cleanup.ts`）
  - 删除 `:258`（整段 drop 分支）与 `:281`（部分剥离分支）两处 `replaceSourceContent(...)` 调用；
  - `setContent` / `drop` / `updateTagStatus` / `droppedInjections` 记账**全部保留**（wire 与账务行为不变）；
  - 注释改写：「source 保持 pristine；剥离结果不落库，由每 pass 的 `replaySystemInjectionStrips` 重放」。

  **改动二：新增每 pass 的注入重放**（与 `replayCavemanCompression` 同构，后者已「runs on EVERY transform pass (defer too)」，`caveman-cleanup.ts:11`）

  ```ts
  export function replaySystemInjectionStrips(
      targets: Map<number, TagTarget>,
      tags: TagEntry[],
      protectedCutoff: number | null,
  ): number {
      let replayed = 0;
      for (const tag of tags) {
          if (tag.type !== "message" || tag.status !== "active") continue;
          if (tag.messageRole === "system") continue;
          const target = targets.get(tag.tagNumber);
          // 与 heuristic :243 的防御对齐：messageRole 在存量行上可能是 NULL
          if (target?.message?.info.role === "system") continue;
          if (protectedCutoff !== null && tag.tagNumber >= protectedCutoff) continue;
          const content = target?.getContent?.();
          if (!content) continue;
          const stripped = stripSystemInjection(content);
          if (stripped === null) continue;                     // 幂等：已剥离 → null
          // 整段只剩注入（剥离后只余裸 §N§ 或空）：**不在这里 drop**。
          // drop 需要 updateTagStatus + 占位符契约，只由 heuristic 在 routine pass 做；
          // 这里保留原样一 pass，交给下一次 heuristic，避免写出空 text block 或悬空 §N§。
          if (stripTagPrefix(stripped).trim().length === 0) continue;
          if (target?.setContent?.(stripped, { keepReasoning: true })) replayed += 1;
      }
      return replayed;
  }
  ```

  - **落点**：`transform.ts` 的 `runPostTransformPhase` **调用结束（`:2629`）之后**、`describeFinalWireTail`（`:2635`）与 final-wire 估算之前。`targets`（`:2016` 声明、`:2104` 赋值）与 `activeTags`（`:2160`）在同一闭包内可用。必须走 `targets` 的闭包（`setContent`/`getContent` 带 `partialEnd` 与 `§N§` 前缀语义，`transform.ts:945-962`），不要另起 message 数组重写；`postTransformPhase` 是最后一次字节改写（`transform.ts:3059-3062` 注释自陈），落点之后没有别的 `setContent`。
  - **顺序理由**：放在 heuristic 之后，routine pass 的剥离与记账仍由 heuristic 完成，replay 不碰任何计数器（`droppedInjections` 不会被打成 0）；non-routine / defer pass 才由 replay 兜底。**例外**：caveman 开启时 heuristic 自己的 `applyCavemanCleanup`（`heuristic-cleanup.ts:375`）会把注入压回去，此时 routine pass 的 replay 仍需真剥离，不是 no-op。
  - 不读也不写 `source_contents`，纯 wire 层；判据与 heuristic 对齐（`heuristic-cleanup.ts:230-243`：`status === active` / `type === message` / `tagNumber < protectedCutoff` / `tag.messageRole !== "system"` + `target.message?.info.role !== "system"` 双判）。
  - `protectedCutoff` 取自 `transform.ts:2518`（`const protectedCutoff = protectionWindow.cutoff;`；同一值在 `:2577` 透传给 postprocess）。

  **改动三：`tag-messages.ts` 不动**

  `source_contents` 恒 pristine 后，v1.0.30 的判据自动恢复正确性：`persistedSource === stripTagPrefix(textPart.text)` → 恢复（去掉入站可能携带的 `§N§` 前缀）；不等 → **只能是重指**（编辑重发 / rewind 换消息）→ 以入站为准纠正。`derived` / `derived_from` / `inboundSource` 一概不需要，`getSourceContents` 的 5 个调用点、`storage-clone`、`ensureColumn` 全部不碰。

  **改动四（承重）：修掉同 pass 的 caveman 复活**

  `applyHeuristicCleanup` 在 `:258` 把 tag 落成 dropped 后，同一函数在 `:375` 调 `applyCavemanCleanup`，传进去的 `tags` 来自 `:108` 的内存数组，`status` 仍是 `"active"`（`updateTagStatus` 只写库）。此前 `caveman-cleanup.ts:256-257` 靠「`source === ""`」跳过；source 改成 pristine 后该拦截失效，caveman 会用 pristine 把刚 drop 的消息**以压缩态写回 wire**，还给 dropped tag 落 `caveman_depth`。

  修法：`applyHeuristicCleanup` 内维护 `const droppedThisPass = new Set<number>()`，drop 分支 `droppedThisPass.add(tag.tagNumber)`；调 `applyCavemanCleanup` 前把 tags 过滤 `!droppedThisPass.has(t.tagNumber)`。ZCode 侧 caveman 三臂恒 false（`magic-context-turn-transform.ts:1172-1174`），属潜伏缺陷，但包与测试会踩。

  **顺带修好两件事**
  1. caveman 契约恢复：`replayCavemanCompression` 从 pristine 原文重压，不再是「压一个已经压过的文本」（此前 heuristic 把压缩后文本写进 source，`caveman-cleanup.ts:28-35` 的契约被破坏，逐 pass 退化）。
  2. v1.0.30 的「每 routine pass 多两次 DB 写」消失（source 不再每 pass 被覆写两次）。

  **代价与风险**
  - 每 pass 多一次全量 `stripSystemInjection` 正则扫描（与已每 pass 运行的 `replayCavemanCompression` 同量级）。
  - non-routine pass 的剥离不记账：`droppedInjections` 只反映 routine pass 的真实回收，语义反而更准（不再是「每轮重复计同一个注入」）。
  - **首次剥离未计价**：tag 越过 `protectedCutoff` 的那个 pass（cutoff 由工具 tag 质量前移，`protection-window.ts:286-330`）会由 replay 改写已服务字节，可能落在非 bust pass 上；一次性 cache miss，可接受，需写进风险。
  - **两条约束必须同时成立**：replay 真的每 pass 跑（含 defer）+ heuristic 真的不再写 source。漏前者的回归形态是「注入回 wire」，漏后者是「派生态回到 source」——两者症状不同，验收要分开钉。
  - **必须打 FORK 标记**：上游 `heuristic-cleanup.ts:252/275` 与 fork 逐字相同（同样写派生 source），这是上游文档与实现不一致，不是 fork 的偏离。改动处需标 `FORK（source 恒 pristine）`，否则下次上游同步会原样覆盖回来。
- 验收/测试：`test-transform.mjs` 新增 b6（六段）：
  1. **routine pass 不动 source**：tagMessages → `applyHeuristicCleanup(routine:true)`（用户正文 `hello` + 尾部 `<system-reminder>`）→ 断言 `stripTagPrefix(wire) === "hello"`（`setContent` 的文本仍带 `§N§ ` 前缀，`:937` 才 prepend，不能直断 `wire === "hello"`），并**直查** `SELECT content FROM source_contents WHERE session_id=? AND tag_id=?` 断言 `content === "hello<reminder>"`（仍是 pristine 原文，**没有被改成剥离后的文本**）；
  2. **non-routine pass 靠 replay 兜底**：用原始带注入入站跑 tagMessages → 只跑 `replaySystemInjectionStrips`（**不跑 heuristic**）→ 断言 wire 是剥离文本、`source_contents` 仍为 pristine；
  3. **编辑重发不被 replay 干扰**：入站换 `world` → tagMessages → 断言 wire 为 `world`、`source_contents.content === "world"`（v1.0.30 行为保持）；再跑一遍确认第二次编辑仍能纠正；
  4. **caveman 契约**：`cavemanDepth > 0` + 注入的 tag 连跑两 pass（tagMessages → caveman replay → injection replay）→ 断言 `source_contents.content` 仍是 pristine 带注入原文、wire 是压缩后且**不含注入**、第二 pass 的压缩结果与第一 pass 字节相同（不逐 pass 退化）；
  5. **drop 场景**：整段被注入吃光的消息 → 断言 `source_contents.content` 仍是 pristine（不是 `""`）、tag `status === dropped`、下一 pass wire 仍是 `[dropped §N§]`（占位符不丢）；
  6. **replay 不得产生空串/裸 tag**：整段只有 `<system-reminder>` 的消息，在 **heuristic 不跑**的 pass 上跑 replay → 断言 wire 原样保留（不是 `""`、不是裸 `"§N§"`）、tag 仍 `active`，下一次 routine pass 才由 heuristic 落 `[dropped §N§]`；
  7. 反向验证两条，分别对应两种漏法：① 删掉 replay 调用 → 第 2 步必红（注入回到 wire）；② 恢复 `replaceSourceContent(strippedSource)` → 第 1 步必红（source 不再是 pristine）。
- 来源：review-scope-fix `fix/B-1` / round 1；round 2 补 caveman 子集；round 3 补「无条件恢复」出口；**round 7 改为方案 A（零 schema）**

### CR-2 [P1] 窗口化 + live 后 totalCount / firstRowId 崩塌
- 维度：C（正确性）/ G
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts:527-535`、`:739-748`；`.../product-projection.ts:466`（`private rowIdOrigin`）
- 问题：`facts === null` 时用 `visibleRows.length` / `visibleRows[0].rowId` 冒充全序量。全量物化下成立，窗口化下不成立（窗口恒为 active 分支后缀，真机 160 行 vs 5255 行）。窗口化冷开后第一条「改动行集合」的 live ingest 会清 facts（`:940,977-978`），此后任何一次快照下发（`seedRuntimeFacts` 的 `requireSnapshotResync`、客户端重订、web 重连、`assistantConservation` 后重水化）都会把 `totalCount` 报成 ≤160、`firstRowId` 报成窗口 base，滚动条高度与 `data-total-row-count` 缩水、`hasOlderRows` 永久 false。spec 风险 15 只登记了「翻页退回 hasMore:false」，未登记计数崩塌。
- 改法：
  - **先新增只读出口**：`ProductProjection.getRowIdOrigin(): number`（`product-projection.ts:466` 为私有、全仓无 getter；publisher 持有 `private projection`，`conversation-topic-publisher.ts:286`，可直接调）。**不能**读 `rows.rowIdOrigin`——`packages/shared/src/zcode-protocol-v4/snapshot.ts:520-527` 的 rows 只有 `window` / `totalCount` / `firstRowId`。
  - 判据：`const origin = this.projection.getRowIdOrigin();` **`origin > 1`**（准确含义：窗口首行不是分支首行）。不要用 `window.length > 0 && window[0].rowId > 1`——空窗口时恒 false，会让兜底不可达。
  - 窗口化：`firstRowId = 1`，`totalCount = rows.window.at(-1)?.rowId ?? (origin - 1)`。空窗口（rewind 命中窗口首轮，`product-projection.ts:2085-2113`）取 `origin - 1`，因 `origin > 1` 该分支恒可达。
  - 非窗口化：维持现状（`totalCount = visibleRows.length`、`firstRowId = visibleRows[0]?.rowId ?? null`）。注意**覆盖整条分支的冷窗口**（`coldWindow` 存在但 `rowIdBase === 1`）会落进这一支，数值仍正确，属保守退化——不要把 `fullyMaterialized:false` 与 `origin > 1` 当等价。
  - `encodeRowsRangePage`（`:739-748`）复用同一 helper，但 **`totalCount` 必须取自 `snapshot.rows.window` 而非该函数的 `rows` 形参**（形参是一页，取它会给出页末 id）。**口径变化**：`firstRowId` 同时喂 `hasMore`（`:748`），窗口化 + facts 失效时 `hasMore` 会由 `false` 翻成 `true`。注意客户端 `loadOlder`（`packages/ui/src/v4/conversationProjectionStore.ts:1208-1253`）**不读 `hasMore`**，而 `hasOlderRows`（同文件 `:285-290`，判据 `first.rowId > snapshot.rows.firstRowId`）在 `firstRowId=1` 下**恒为 true**——实际表现是「每次上滚发一次空请求」而不是「客户端收尾」；`loadAllOlder`（`:1321-1333`）会读 `hasMore`，但 `:1323` 有「游标不推进即停机」守卫，不会死循环。spec 风险 15 的措辞需按此改写，CR-4 的「hasMore 语义不动」也随此口径调整。
  - **不要**引入 `stickyTotals` 取 max：rewind 截断后 sticky 会高估（截断前 5255 vs 派生 5095），给出不复存在的翻页区间。
  - 已知边界（不属本修复）：rewind 到窗口之上的消息时 `rowIdForMessageId` 反查不到、返回空 delta（`product-projection.ts:2117-2124`），投影不截断、派生总数停在旧值——既有缺陷，另立条目。
- 验收/测试：`test-session-row-manifest.mjs` 新增，夹具写死行号账目——`origin = 98`、pre-window `[98, 99]`；ingest 一条 **visible** TurnStarted 追加 2 行（turnHeader + userInput，`product-projection.ts:2296-2330`），新 turn base = `origin + window.length`（`:5530`）→ 末行 `101`。断言新订阅快照 `rows.totalCount === 101`、`rows.firstRowId === 1`，且 `getRowManifestFacts() === null` 仍成立。另加空窗口用例：rewind 掉窗口首行 → 断言 `totalCount === 97`（`origin - 1`）。`test-view-runtime-split.mjs:199-225`（A2）当前把「回退到 window.length」钉成契约、只因夹具是全量投影才没红，需补窗口化版本。
- 来源：review-scope-c `B-1` / round 1；round 2 补判据与字段可达性；round 3 补 origin 语义

### CR-3 [P2] hydrateRowManifest 读清单期间的行集合变化不登记
- 维度：C-orch
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1595-1608`、`:1639-1658`、`:1674-1677`、`:801-807`
- 问题：先取 `getTurnManifestBranchState()` → `await read(...)` → 无条件 `seedRowManifestFacts`。作废判据在 `publisher.ingest` 内带 `rowManifestFacts !== null` 前置，seed 之前（facts 天然为 null）发生的行集合变化没有任何地方记得住；读清单的几毫秒里进来的 TurnStarted/TurnComplete 会让过时清单被当作权威注入（totalCount 少算、turnDirectory 少条目），直到下一次换行事件才自愈。不报错、不写坏数据，属静默缺边。
- 改法：读前 `const sig = publisher.getRowSetSignature()`（`:489-508`），读后不一致则不注入（保持 null，走 CR-2 的派生路径），并写 `rowManifestOutcomes.set(sessionId, { action: "skip", reason: "invalidatedDuringRead" })` + 一条 debug。**`action` 联合当前只有 `"use-manifest" | "materialize-and-rebuild"`（`:801-807`），需扩 `"skip"`**——该接口是本文件局部、未导出，消费方只有 `getRowManifestOutcome()` 与测试断言，全仓无 `switch(action)` / `assertNever`，扩联合安全。`:1639-1658` / `:1674-1677` 播种的 `coldWindow.facts` 来自物化前同一批快照（`:1642-1644`），签名守卫同样覆盖。
- 验收/测试：`test-session-row-manifest.mjs` 新增「读清单期间进入换行事件」用例——`readRowManifest` mock 在 await 里 `gateway.ingest(turn_started)`，断言 `publisher.getRowManifestFacts() === null`、ACK 快照 totalCount 不等于清单值、`getRowManifestOutcome().action === "skip"`。现有 F1/M8 只在 seed 之后造事件，覆盖不到。
- 来源：review-scope-c `C-1` / round 1；round 2 补 action 联合

### CR-4 [P2] rowsRange 在 facts 缺席且请求窗口之上时无诊断落点
- 维度：E（可观测性）
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:2376-2406`、`:858-864`
- 问题：`facts === null` 且 `beforeRowId` 在窗口之上时返回空页 + `hasMore:false`，但 `rowPageOutcomes` 不写、无 debug，`getRowPageOutcome()` 返回上一次的旧结论。spec Step 7 要求「新增降级原因必须进 reason」，否则「没生效」与「翻页坏了」无法区分。
- 改法：该分支显式落 `rowPageOutcomes.set(sessionId, { applied:false, reason:"manifestInvalidated", beforeRowId, limit })` + `onDebug` 一行；落点前对 `params.beforeRowId === undefined` 加守卫（`RowPageOutcomeSummary.beforeRowId` 是必填 `number`，`:858-864`）；`hasMore` 语义随 CR-2 的口径变化，此处不改逻辑；**不要**把 `manifestInvalidated` 并入 `ColdRowPageUnavailableReason`（`session-row-manifest.ts:715-723`）——`selectColdRowPage` 永远看不到 facts 失效，该成员不会有生产者；落点 reason 是 `string`（`:861`）。
- 验收/测试：M8 增补 `assert.equal(gateway.getRowPageOutcome(SESSION_ID)?.reason, "manifestInvalidated")`。
- 来源：review-scope-c `C-orch-1` / round 1

### CR-5 [P2] 并发门禁只校键存在、不校分类值
- 维度：G（测试有效性）
- 文件：`apps/zcode-cli/packages/bootstrap/scripts/test-command-concurrency.mjs:280-398`；`.../src/zcode-protocol/command-concurrency.ts:200-204`
- 问题：K5 只查 `COMMAND_CONCURRENCY[wireName] === undefined`（`:325`）；K6 的值级检查只有三样（只读名单名称正则 `:356-361`、两条 legacy 显式 pin `:366-375`、三条「必须在只读侧」pin `:377-383`）。把一条变更命令登记成 `readonly` 在门禁上全绿——与「漏写入口、不报错」同族的静默缺边。
- 改法：把只读清单做成显式字符串数组——**只读登记条目 34 条**（v4 23 + legacy 7 + workspace 4，`command-concurrency.ts:55-83/102-108/126-129`；对 `"readonly"` 文本计数得 36，多出类型声明 `:37` 与 `readonlyCommandNames()` 过滤行 `:202`，不要按 36 写）；新增 K7 与 `readonlyCommandNames()`（`:200-204`）逐项相等断言（顺序无关）。
- 验收/测试：把只读清单里**一条未被任何 pin 覆盖**的命令（`conversationUsage` `:65`，或 `conversationPlans` `:62` / `backgroundBashOutput` `:68` / `commandsQuery` `:83`）在实现侧改成 `mutating` → K7 必红（当前全绿）。**不能用** `conversationRowsRange`（它是 K6 三条 pin 之一，`:377-383`，会被抢先打红）、`attachmentBegin`（本来就是 `mutating`，`:87`）、`conversationUnsubscribe`（也是 `mutating`，`:86`）。
- 来源：review-scope-c `G-1` / round 1；round 2、round 3 两次修正反向验证用例

### CR-6 [P2] 7 条「激活型只读」未登记为分类例外
- 维度：B / C-orch
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/command-concurrency.ts:69-76`（判据 `:42-46`）；`v4-gateway.ts:2658,2677,2701,2724,2765,2797,2821`（7 个调用点）、`:2932`（定义）、`:4763`（注释）
- 问题：判据①是「handler 不写服务端自有可变状态」，但 7 条 dwf 读面全部 `await this.ensureHostRecordForJournalRead` → `ensureRuntimeReady`（`createRecord` + `coldResume.ensureResumed` + 7 个 MCP 连接 + resume hooks）。判据与登记自相矛盾，例外只写在行注释里（且 `:69` 写「五个读面」实际 7 条），没有门禁或 spec 段落承接；Step 17 之后与 `conversationSubscribe` 并发，成为 IS3 顺序的又一个并发触发者。
- 改法：① 登记 `ACTIVATION_INDUCING_READONLY`，**元素必须是 wire 串**（`"v4/conversation/workflowRuns"` 等，见 `packages/shared/src/zcode-protocol-v4/transport.ts:416`），不是方法标识符；② 测试断言 **`ACTIVATION_INDUCING_READONLY` ⊆ `readonlyCommandNames()`**（7 条全部登记为 readonly；**不能**写「严格相等」——`readonlyCommandNames()` 返回全部 34 条，见 CR-5）；③ 源码形状断言：扫描 `v4-gateway.ts` 中 **`await this.ensureHostRecordForJournalRead(`** 的调用点（**必须锚定 `await this.`**——文件里 9 处文本命中，其中 `:2932` 是定义、`:4763` 是注释），把调用点方法名经一张**硬编码方法名 → wire 名映射**（仓里无现成映射表）折算后与常量逐项相等（这里是相等，因为形状扫描的产出就是那 7 个调用点）；④ spec 风险 29 补「分类契约例外」。
- 验收/测试：把 `conversationWorkflowRunEvents` 从常量删掉 → 子集断言红（34 条只读里少了一条登记）；在任一 handler 新增 `await this.ensureHostRecordForJournalRead(` 而不同步常量 → 形状断言红。
- 来源：review-scope-c `B-2` / round 1；round 2 修正锚定与命名口径

### CR-7 [P2] 懒历史闸门 check-then-act，无在飞登记
- 维度：H（正确性）
- 文件：`apps/zcode-cli/packages/core/src/runtime/methods/history-hydration.ts:56-76`；字段声明 `core/src/runtime/internal.ts:97`
- 问题：先读 `deferredHistoryHydration` → `await ensureContextInitialized` → `await messages` → `await hydrate` → 末尾清 flag。两个入口（`turn.ts:208-213` 与 `control-only-turn.ts:55-61`，后者经 `/goal`、`recordExternalUserPrompt`、`dynamic-workflow-run-start`）在首轮窗口内重叠时都能读到非空 pending，各跑一遍 init→hydrate→addEntries，历史进两份（`history-hydration.ts:40-43` 注释已写明）。`beginActiveTurn` 在闸门之后（`turn.ts:239`），闸门期间没有「忙」标记。
- 改法：改成在飞单飞 `private deferredHistoryHydrationFlight?: Promise<void>`（与 `viewReadyFlights` 同形态），入口命中即复用；新字段同时加到 `internal.ts:97` 声明块；或入口先取出 pending、catch 里恢复（失败可重试）。
- 验收/测试：`core/scripts/test-lazy-history.mjs` 新增并发用例——`await Promise.all([hydrateDeferredMessageHistory(), hydrateDeferredMessageHistory()])`，用夹具 `calls`/`order` 观测（`:241` 记录 `"init"`、`"read-messages"`）断言各出现一次、flag 为 undefined（不要 spy 静态导入的 hydrate 函数）。
- 来源：review-scope-c `H-1` / round 1

### CR-8 [P2] 纠正 source 后未同步 tag 的 byte_size / token_count
- 维度：B（账务）
- 文件：`apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/tag-messages.ts:884,929`；`.../core/features/magic-context/tagger.ts:404-443`；`.../core/features/magic-context/storage-tags.ts:80-116`、`:521-528`、`:700-715`
- 问题：`allocateTag` 命中已有 tag 直接返回、不再写尺寸；而 `byte_size` 被 `compartment-trigger.ts:223,237`、`emergency-drop.ts:100`、`caveman-cleanup.ts:158`、`dropped-token-estimate.ts:109` 消费。编辑重发后 wire 已是新正文，账务仍是旧消息尺寸。
- 改法：① `replaceSourceContent` 之后 `updateTagByteSize(db, sessionId, tagId, byteSize(sourceContent))`（裸 `UPDATE tags SET byte_size = ?`，`storage-tags.ts:80-87`；其文档写「No-op if not strictly larger」与实现不符，但正好需要下降，不影响）。**导入方式**：`tag-messages.ts:7-18` 已直接从 `storage-tags.js` 导入 10 个符号，照此加一行即可；`updateTagByteSize` **不在** `storage.ts:295-319` 的再导出块里，若想走桶导出需同步补。② `token_count` 需**新增导出** `setTagTokenCount(db, sessionId, tagId, tokenCount)`（裸 `UPDATE tags SET token_count = ?`），定义放在 `storage-tags.ts:517-554`（`updateTagTokenCount` 旁）并从 `storage.ts` 的桶导出；在 `tag-messages.ts:929` 之后调用 `setTagTokenCount(db, sessionId, tagId, estimateTextTagTokenCount(sourceContent))`（`estimateTextTagTokenCount` 是本文件 `:417-421` 的私有定义，无需导入）。现有写入只有首插 `tagger.ts:451-464`（`insertTag(..., tokenCounts)`；`:437-443` 只是取值处）与 `WHERE token_count IS NULL` 的回填 `:700-715`，`updateTagTokenCount` 带 `MAX(COALESCE(...))`（`:521-528`）只能升不能降。（方案 A 后 `heuristic-cleanup.ts:258/:281` 不再写 `source_contents`，本条只剩 `tag-messages.ts:929` 的纠正分支需要同步尺寸；`compartment-trigger.ts:223,237` 按含注入的入站尺寸累计属既有行为，不在本条范围。）
- 验收/测试：b5 第 2 pass 改用**长 → 极短**的正文变化（`"123"`→`"7890"` 不行：启发式 `ceil(len/3.5)` 是 1→2，方向相反；有 tokenizer 时两者都是 1）。第 1 pass `"a long user message body"`（24 → 7 tokens）、第 2 pass `"x"`（1 token），从 `b4Db` **直查 SQL**：`SELECT byte_size, token_count FROM tags WHERE session_id=? AND tag_number=?`（`TagEntry` 的 `tokenCount` 是 declaration merging 加上去的**可选**字段，`storage-tags.ts:8-13` + `toTagEntry` `:889`；直查 SQL 仍更稳，先例见 `test-transform.mjs:1506,1536`），断言两者都**下降**。反向验证：注释掉 `updateTagByteSize` 调用 → 断言必红。
- 来源：review-scope-fix `fix/B-2` / round 1；round 2 修方向；round 3 补落点

### CR-9 [P2] 新判据注释两处误导
- 维度：F（注释）
- 文件：`apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/tag-messages.ts:916-922`
- 问题：①「一旦与持久 source 不一致，只能说明该 tag 已指向另一条消息」不成立（heuristic 是同一消息的故意改写，见 CR-1）；②「一致时仍恢复持久 source（保留 tag 号重绑时的字节稳定性）」——`prependTag` 内部会先 `stripTagPrefix`（`tag-content-primitives.ts:142-145`），该赋值对 wire 是空操作，真正起作用的是纠正分支。
- 改法：注释改为「`source_contents` 恒存 pristine 入站原文；一致分支仅用于去掉入站可能携带的 `§N§` 前缀；不相等只可能是重指（编辑重发 / rewind 换消息），以入站为准纠正。注入剥离由每 pass 的 `replaySystemInjectionStrips` 重放，**不落库**」；`heuristic-cleanup.ts:258/281` 的注释改为「source 保持 pristine，剥离结果不写回」。**方案 A 下不引入 `derived` / `derived_from`，旧稿要求写这两列的内容作废。**
- 验收/测试：纯注释，随 CR-1 定稿；无独立验收。
- 来源：review-scope-fix `fix/F-1` / round 1

### CR-10 [P2] b5 抓不住「纠正未落库」且缺多 part 覆盖
- 维度：G（测试有效性）
- 文件：`apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs:960-993`
- 问题：①把 `replaceSourceContent` 换回 `saveSourceContent`（`INSERT OR IGNORE`）后，第 2/3 pass 仍在 mismatch 分支直接服务入站文本，三条断言全绿——「纠正落库」这一半没有回归网；②只有单 text part（`b5Message` 单 part，`:960-967`），若比较写成 message 级，b5 仍全绿。
- 改法：① 第 2 pass 后从 wire 解析 tag 号（`/^§(\d+)§ /u`），断言 `storage.getSourceContents(b4Db, B5_SESSION, [tagNumber]).get(tagNumber)` **字符串直比**等于该 pass 正文（返回类型是 `Map<number, string>`，`storage-source.ts:40-63`；方案 A 下没有 `derived` 列，**不要**写 `.content` 或 `derived === 0`）。**正文取值必须与 CR-8 定稿一致**：CR-8 把 b5 改成第 1 pass `"a long user message body"`、第 2 pass `"x"`，所以这里断言 `=== "x"`（`"7890"` 是错值——b5 夹具第 2 pass 是 `"789"`，`test-transform.mjs:979`，全仓无 `7890`），并**同步改 `test-transform.mjs` 的五处**：`:971` 夹具 `b5Message("123")` 与 `:974` 断言（`§N§ 123`）→ 长正文；`:979` 夹具 `b5Message("789")` 与 `:982` 断言（`§N§ 789`）→ `§N§ x`；`:987` 的第三 pass 稳定对照夹具同步改 `"x"`；入参是 `number[]`（`storage-source.ts:40-44`），漏方括号在 `.mjs` 里是**运行期 `TypeError` 而非 typecheck 红**（`tsconfig.json:15` 的 include 只有 `src/**/*`）；② 新增双 text part 用例（需新夹具，`p0`/`p1` 各带 tag），第 2 pass 只改 `p1`，断言 `p0` 走一致恢复、`p1` 走纠正、tag 号各自稳定。
- 验收/测试：本条即验收；反向验证——把 `replaceSourceContent` 临时替换为 `saveSourceContent`，新增断言必红。
- 来源：review-scope-fix `fix/G-1`、`fix/G-2` / round 1；round 3 修断言类型

## Spec deviations

1. **open**：`totalCount` 在「窗口化 + 基线作废」后的取值 spec 未定义（Step 4 / IS5 默认投影=全序）。需在风险 15 补：`firstRowId=1`、`totalCount=末行 rowId`（空窗口 `rowIdOrigin-1`），且 `hasMore` 随该口径变 `true`——客户端表现是「每次上滚发一次空请求」（`loadOlder` 不读 `hasMore`，`hasOlderRows` 在 `firstRowId=1` 下恒真），`loadAllOlder` 有游标守卫不会死循环。
2. **open**：只读分类判据①与 7 条激活型只读冲突（CR-6），需把「激活型只读」作为分类契约的显式例外写进 spec。
3. **open**：T-SL9「逐页与全量物化逐值相等」被实现收窄为行事实相等，`fileChanges` 摘要不在其中（`materializeRowPage` 不读摘要缓存）。需补实现或收窄措辞。
4. **open**：`shouldBypassProcessingQueue` 在 Step 17 后语义已变（旁路不过锁而非旁路串行），`lastQueuedMessageStarted` 仍是旧语义产物——stop 可能被长只读挡到该只读排空。与改造前等价，spec 未写。
5. **open**：`disposeSession` 未清 4 张诊断表（`v4-gateway.ts:3762-3845` 未清，仅 `dispose()` `:3871-3874` 清），关闭再打开同一会话时 getter 返回上一代结论。
6. **open（round 7 更新）**：`heuristic-cleanup` 把 `getContent()`（caveman 之后的压缩 wire）写进 `source_contents`，破坏 `caveman-cleanup.ts:28-35` 的「source 恒为 pristine 原文」契约，导致 `replayCavemanCompression` 逐 pass 再压退化。CR-1 的方案 A 顺带修掉这一条（heuristic 不再写 source），需在 magic-context spec 登记「source 只存 pristine」为不变量。

## Open questions / 待拍板

1. （方案 A 已消解：`getSourceContents` 签名不变，`caveman-cleanup.ts` 三处 `typeof !== "string"` 守卫无需改。）
2. 宿主是否把 MC 自己的输出（drop 占位符、caveman 压缩文本、带 `§N§` 前缀文本）当作入站回灌：方案 A 下 source 恒 pristine，`persistedSource === sourceContent` 的比较对回灌同样成立（回灌文本会被当作新正文落库），风险与改造前一致。
3. `skipPrefixInjection === true` 且入站自带 `§N§` 前缀时，mismatch 分支不剥离它，wire 可能带过期 tag 号（与 2 同源）。
4. 位置级状态是否随 rewind 迁移：`caveman_depth > 0` 的 tag 被新消息继承后，新正文按旧消息的压缩等级重放。
5. `source_contents.harness` 在 `replaceSourceContent` 的 UPDATE 分支不改，跨 harness 复用同一 (session, tag) 时 provenance 停留在旧值。
6. `conversationSubscribe` 作为 readonly 的副作用（rehydrate/seed/markViewReady/prewarm 激活）只靠四个单飞兜底；`conversationResync` 标 readonly 但会 supersede 前一个 reservation（并发丢帧），约束不在协议与测试里。
7. 按需物化的一页丢 fileChange 摘要（`materializeRowPage` 不读 `store.fileChangeSummaries`），与 T-SL9 不符，行数守卫抓不到。
8. `rowsRange` 按页物化没有单飞，并发请求重复付正文读（无正确性问题）。
9. 页返回的 `atSeq/atRevision` 取当次投影水位，rewind 与页物化并发时可能给出换分支前水位（靠对齐守卫拦，值得补用例）。
10. `product-projection.ts:2117-2124`：rewind 到窗口之上的消息时 `rowIdForMessageId` 反查不到、返回空 delta，投影不截断（既有缺陷，影响 CR-2 派生总数，建议另立条目）。

## 已豁免（用户确认不修）

（无）

## 合并后 QA（manual_user，不阻塞）

1. 带 system reminder 的消息连发 3 轮，观察 wire 是否每轮字节稳定（CR-1 真机复验）。
2. 窗口化冷开 + 触发一次 live 回复后，订阅快照 `totalCount` 是否仍等于真实总行数（CR-2）。
3. 编辑重发主症状复验：编辑最后一条用户消息 → 模型复述新内容；**再编辑一次**，确认第二次仍生效（CR-1 的 pristine 判据）。

## K 节建议（下游执行时闭合）

- CR-1 落地后回填 magic-context spec：把「入站永远权威」改为「`source_contents` 恒存 pristine 原文；注入剥离是每 pass 幂等重放（`replaySystemInjectionStrips`），不落库」。
- CR-2 修复后重跑 `test-session-row-manifest` 与 `test-view-runtime-split` 的 A2 用例，复核 `hasMore` 口径变化对客户端翻页循环的影响。
- CR-5 / CR-6 修好后，把「分类表改动必须同时改显式清单 + 源码形状断言」写进 `docs/apm/RULE.md`。
- **CR-1 方案 A 无 schema 变更**，v1.0.31 可直接作为补丁版发布；迁移说明无需提及 `source_contents`。

## 落地记录（2026-10-27，v1.0.31 待发布）

### CR-1（方案 A，零 schema）
- `heuristic-cleanup.ts`：删除 `:258` / `:281` 两处 `replaceSourceContent`（含 import）；新增 `droppedThisPass` 集合，调 `applyCavemanCleanup` 前过滤，避免同 pass 用 pristine 把刚 drop 的消息压回 wire。
- 新增 `hooks/magic-context/system-injection-replay.ts`：`replaySystemInjectionStrips(targets, tags, protectedCutoff)`，整段只剩注入（剥离后只余裸 `§N§`/空）时跳过，不做 drop。
- `transform.ts`：`passOutcome.markFinalized()` 之后、`describeFinalWireTail` 之前调用，每 pass 兜底（routine pass 为 no-op，不碰计数器）。
- 验收：`test-transform.mjs` 新增 b6 四例（routine 不动 source / non-routine 靠 replay / 编辑重发不被 replay 干扰 / drop 保 pristine 且 replay 不产空 part）。`test:all` **56 cases 全绿**（原 52 + 4）。

### CR-2
- `product-projection.ts`：新增 `getRowIdOrigin(): number`。
- `conversation-topic-publisher.ts`：新增 `isWindowedProjection()` / `deriveRowsTotals()`；`getWireSnapshotForProfile` 与 `encodeRowsRangePage` 的 facts 缺席分支改用派生口径（`origin > 1` ⇒ `firstRowId = 1`、`totalCount = 末行 rowId`；空窗口取 `origin - 1`）。
- 验收：`test-session-row-manifest.mjs` 新增 N1（窗口化 totalCount/firstRowId + 空窗口 `origin-1`），**61/61 全绿**。

### 门禁
- `tsc --noEmit`：magic-context ✓、bootstrap ✓；根 `pnpm typecheck` ✓
- MC `test:all` ✓（SMOKE 56 checks / host 30 / TRANSFORM 56 cases / 其余 node --test 段 `# fail 0`）
- `test:session-row-manifest` 61/61 ✓；`test:cold-open-window` 10/10 ✓；`test:turn-manifest-entry` 12/12 ✓
- `test:view-runtime-split` **46/46** ✓ —— 其中 K8 在本轮之前是既有红：它断言 `v4-bridge.ts` 含旧形态 `const fileChangeSummariesByMessageId = record`，而该文件自 v1.0.30 起已把 id 集合抽成 `fileChangeSummaryMessageIds`。断言已跟到现形态并在 `a8c11881` 修好（现在断言的是「id 集合来自本次物化的 `source.messages`」+「不得退回 `windowPlan.activeMessageIds`」两条语义）。
- 根 `pnpm lint`：**170 warnings / 0 errors**（warnings 全部来自未跟踪的 `.reference/`）；包级 `oxlint src` 有 40 条既有 max-lines 类错误，不是门禁。

## Fix-Spec Closure

| 项 | 状态 |
| --- | --- |
| fix-spec-ready | **yes（待用户确认）**——8 轮复审，P0=0、P1 全部闭合；CR-1 定稿方案 A（零 schema） |
| fix_spec_path | `docs/iterations/cr-20261027-v1030/cr-fix-spec.md` |
| 评审记录 | `docs/iterations/cr-20261027-v1030/cr-review-notes.md` |
| dag_version / review_round | 8 / 8 |
| P0 / P1 / P2（must-fix 条目） | 0 / 2 / 8 |
| round 1 的 4 P0 + 2 P1 | 已闭合 |
| round 2 的 2 P0 + 4 P1 | 已闭合（P1-D「CR-5 反验证」在 round 3 被判换了例子仍不隔离，本轮改 `conversationUsage` 后闭合） |
| round 3 的 1 P0 + 2 P1 | 已闭合：CR-1 加 `derived_from` 出口并修 caveman source 契约；CR-5 换 `conversationUsage`；CR-10 改 `.content` |
| round 4 的 1 P1 + 8 P2 | 已闭合：b5 正文三方取值统一（CR-8 与 CR-10 同为 `"a long user message body"` → `"x"`，并写明同步三处 wire 断言）、`TagTarget.inboundSource?`、`:258` drop 派生、`setTagTokenCount` 落点与桶导出、`TagEntry.tokenCount` 理由、`hasOlderRows` 恒真表现、Closure 计数 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | open: 6 条（新增 caveman source 契约一条） |
| C-orch | ✅（CR-3 为静默缺边） |
| C 类合并后 QA | 3 条，不阻塞 |
