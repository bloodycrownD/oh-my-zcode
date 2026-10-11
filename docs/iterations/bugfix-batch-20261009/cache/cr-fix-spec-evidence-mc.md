# CR Fix-Spec 证据包：mc 域（⑤ magic-context）——主代理手工审查补全

- 审查对象：`docs/iterations/bugfix-batch-20261009/cr-fix-spec.md`
- 仓库：`D:\Dev\Js\oh-my-zcode\omz`；sha：5a35027；轮次：spec-check r1
- 取证方式：原 evidence 代理 provider 故障两度丢失（遗留本包前 40 行）；mc/A-1 工厂段及 mc/C-1 / mc/G-1 / mc/K-1 / e2e/R-2 由**主代理手工审查**补全（skill 失败处理规则：重试耗尽转手工，标注于此）。
- 规则：git 只读；未修改任何代码/spec。

---

## mc/A-1（P1）disabled 事件生产不可达 + 事件单点化

### 代码事实（主代理手工核对）
- `create-app.ts:801-814`：行号精确。`:802` `if (runtimeConfig.magicContext?.enabled === true)` 内才 `await import("./magic-context-turn-transform.js")`；**无 else 分支**——flag 关时零事件、零 import，spec「生产不可达」与代码一致。`:806-811` import_failed 分支内联 `logger.warn({event:"magic_context.transform_absent", reason:"import_failed"})` 后 `throw`（fail-closed + 可观测）。
- `magic-context-turn-transform.ts:914-921`：行号精确。工厂内 `if (!options.enabled) { emitTransformAbsent(..., "disabled", ...); return undefined; }`——仅直构工厂（测试）可达。
- 事件发射共三处：create-app import_failed（内联字面量）、工厂 disabled（emitTransformAbsent）、`:971` db_null 分支（emitTransformAbsent）+ `:975-979` storage_unavailability warn——「两处字面量/词表无类型约束」属实，leaf 模块单点化可落地。
- 验收可测性：bootstrap 测试脚本已有 capturingLogger 模式（test-boot-busy-retry.mjs:246 `eventsOf(entries, event)`），「enabled!==true 捕获 disabled 事件」可在现有基建断言；「未 import 工厂、未开库」可用模块加载副作用（initializeMagicContextHost 于 :926 仅在 enabled 分支执行）间接断言。
- 结论：**无问题**。

## mc/C-1（P2）migration_guard 守卫与包内口径分歧

### 代码事实（主代理手工核对）
- `magic-context-turn-transform.ts:814-837`：`:818` `const refusal = getMigrationOnOpenRefusal();` `:819` `if (refusal)` 即判 migration_guard，**无守卫**——spec 问题陈述准确。
- 包内 `magic-context/src/core/features/magic-context/storage-unavailable-reason.ts:23-27`：`blockingProcesses = migration?.blockingProcesses ?? migration?.serverPids.map(pid=>({kind:"process",pid})) ?? []`；`:26` `if (migration && (blockingProcesses.length > 0 || migration.unreadableFile))` 才判 migration_guard。refusal 类型**确实有** `blockingProcesses?`（可选）、`serverPids`、`unreadableFile?`、`unreadableArm?` 字段。
- 结论：fix-spec 的守卫表达式 `refusal && ((refusal.blockingProcesses?.length ?? refusal.serverPids.length) > 0 || refusal.unreadableFile)` 与包内派生口径一致、字段全部真实存在。**无问题**。

## mc/G-1（P2）T1 时序耦合 flaky

### 代码事实（主代理手工核对）
- `test-boot-busy-retry.mjs:250-288`：`:255` 持锁 `5_000`；`:276-279` `retryEvents.length >= 3`（与持锁 5s ≡ busy_timeout 5s 等量耦合，flake 风险属实）；`:280-283` 断言 `reason==="storage_busy_retry"`、`attempt===1`、`retryEvents[1].context?.attempt===2`、`retryInMs===1_000`。
- **可疑点 mc-G1-a（轻微）**：fix-spec 改法说「断言改 >=1 + attempt===1 + retryInMs===1000」，但 **`:282` 的 `retryEvents[1]...attempt===2` 断言必须一并删除**（>=1 时 retryEvents[1] 可能不存在，实施者照 spec 字面改会留下越界断言）；且 `:253-254` 的时序模型注释（「第 4 次约 7s 锁已释放 ⇒ 至少 3 次」）在持锁改 9s 后失真，须同步更新（9s 下生产序列 0/1/3/7/15s，第 4 次 7s 仍撞锁、15s 成功）。
- 结论：**改法可行，spec 需补两处实施细节**。

## mc/K-1（P2）storage_unavailable 改名无登记

### 代码事实（主代理手工核对）
- `:975-979`：事件名 `magic_context.storage_unavailability`，上下注释（:968-970、:980）均无「旧名 storage_unavailable」改名登记。fix 改法（补注释）可直接落地。**无问题**。

## e2e/R-2（P2）unknown provider usage → percentage=0 适配

### 代码事实（主代理手工核对）
- 日志源头：`magic-context/src/core/hooks/magic-context/transform.ts:2546-2549`（`sessionLog`，字面 `transform: unknown provider usage; using ... wire estimate ... percentage=...`）。
- 真实链路：`:2522` `contextUsage.inputTokens <= 0 && protectionCacheBustingPass` → `:2524` `estimateFinalWireInputTokens({...})` → `:2531` `contextUsage = resolveUnknownUsageFromWireEstimate({usage, pricedPass, wireEstimateTokens, wireEstimateTrusted, providerProvenInputTokens: providerProvenInputForRecovery, providerProvenLimitTokens: providerProvenLimitForRecovery, usableHardLimit: windowGeometry?.usableHard})`。percentage 由该函数派生（providerProven/usableHard 缺席时可为 0）。
- **可疑点 R2-a（P1 级 spec 错误）——已撤回（r1 judge 推翻，主代理复核确认）**：~~fix-spec 写「定位 getModelUsageContextTokens 为何提不到」——该函数不存在~~。撤回原因：本包检索只覆盖 magic-context/src 与 core/src，**漏检 contracts 包**。judge r1 实测 + 主代理复核（findstr）：`getModelUsageContextTokens` 真实存在于 `apps/zcode-cli/packages/contracts/src/model/index.ts:540`，且正是 `bootstrap/src/app/magic-context-turn-transform.ts:384` recorder `record()` 的调用对象，`:385-394` 的 `magic_context.usage_skipped` 分支即「provider 报不出 input → transform 恒见 0%」现场。**fix-spec e2e/R-2 原指针正确，不得改写**；仅可选增强：改法补 record() 锚点（magic-context-turn-transform.ts:383-405）与 usage_skipped note 名。
- 结论：**改法的调查指针必须改写为真实符号**，两步结构（调查→最小适配）本身可保留。

---

## mc 域可疑点汇总
| 编号 | 条目 | 事实 | 严重度建议 |
|---|---|---|---|
| mc-G1-a | mc/G-1 | `:282` attempt===2 断言未随 >=1 弱化方案删除；`:253-254` 注释在 9s 锁下失真 | P2（spec 补细节） |
| R2-a | e2e/R-2 | `getModelUsageContextTokens` 幻影函数名；真实锚点 transform.ts:2522-2550 / resolveUnknownUsageFromWireEstimate / estimateFinalWireInputTokens / 宿主 recorder usage 提取 | P1（错误指针必返工） |
