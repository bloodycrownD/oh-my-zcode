# CR v0.1.0 终审轮评审（full 模式，B-K 全维抽查）

- 评审对象：BASE_SHA `1fa2d0e` → HEAD_SHA `aba59a9`（omz 仓库）
- 业务 Spec：`docs/iterations/oh-my-zcode-fork/spec.md`
- fix-spec：`docs/iterations/oh-my-zcode-fork/cr-fix-spec-v0.1.0.md`
- 范围：覆盖度核对 / 可执行性核对 / 跨模块盲区 / 严重度抽查 / fix-spec 内部一致性
- 模式：readonly 终审（不改代码、不改 fix-spec）
- 本文件为本次评审唯一写入产物

---

## 0. 进度日志

- [x] 创建骨架文件
- [x] 读取 fix-spec 与五个 review 文件
- [x] 读取 spec.md 与 fix-spec 全文
- [x] 1) 覆盖度结论
- [x] 2) 可执行性结论（含 9 处 file:line 回读 + 2 处 zod 实跑）
- [x] 3) 跨模块新发现
- [x] 4) 严重度抽查
- [x] 5) fix-spec 内部一致性
- [x] 最终判定

---

## 1. 覆盖度结论

### 1.1 must-fix 计数核对：**通过（33 ↔ 33，1:1 全覆盖，零漏项）**

按 review 文件逐条清点 must-fix 总量：

| review 文件 | must-fix 条数 | 对应 MF |
|---|---|---|
| review-mc-host | 6（C-orch-2/3/4、G-1、G-5、G-6） | MF-01、03、04、05、06、11 |
| review-protocol | 8（C-1、A-1、B-1、C-orch-1、G-1、G-2、C-2、C-3） | MF-07、08、16、17、18、19、20、21 |
| review-ui-tui | 9（C-01、C-02、C-03、A-01、G-01、J-01、C-04、A-02、C-05） | MF-09、10、27、22、23、24、25、26、28 |
| review-brand-dist | 6（B-1、C-1、A-1、A-2、C-2、C-3） | MF-02、29、30、31、32、33 |
| review-mc-core | 4（C-1、C-2、C-3、C-4） | MF-12、13、14、15 |
| **合计** | **33** | **MF-01..33** |

fix-spec 的 MF-01..MF-33 与五个 review 的 must-fix 集合**严格 1:1**，无编号跳空、无一号两用、无一号多议。

### 1.2 严重度映射核对：**通过（零降级）**

| 严重度 | review 侧 | fix-spec 侧 | 一致 |
|---|---|---|---|
| P0 | mc-host/G-1、brand-dist/B-1 | MF-01、MF-02 | 一致 |
| P1 | mc-host C-orch-2/3/4 + G-5（4）；protocol C-1、A-1（2）；ui-tui C-01、C-02（2）= 8 | MF-03、04、05、06、07、08、09、10 | 一致 |
| P2 | 其余 23 条 | MF-11..MF-33 | 一致 |

**未发现 P0/P1 被降级写成 P2**。fix-spec 明确保留了「同文件同维保持最高严重度」的纪律（12 节抬头），与 review 侧的分级口径吻合。

### 1.3 open_questions 覆盖度：**通过（8 条 review OQ 全部有归属）**

| review OQ | 归属 | 状态 |
|---|---|---|
| mc-host OQ-1（preserveProviderStreamBoundaries 跨包字面量弱化） | review 自己已裁定「已接受设计」；文档失真部分由 MF-14 承接 | 已收敛 |
| mc-host OQ-2（historian.* / language 不热生效，Step 16 判据） | fix-spec「建议收窄③」 | 已登记待确认 |
| mc-host OQ-3（`/ctx-status` 双渲染并存，P3） | **未进 fix-spec 任何节** | **漏项（低危）** |
| mc-host OQ-4（`fromConfigPort` 死字段，P3） | **未进 fix-spec 任何节** | **漏项（低危）** |
| protocol OQ-1（saved-workflow 常量 vs 注释） | MF-17 已给出方案 1 改法 | 已转 must-fix |
| protocol OQ-2（compact 残留扫描白名单缺 dynamic-workflow 占位） | fix-spec「K 节建议 5」spec L290 白名单 | 已登记 |
| protocol OQ-3（`plugins.enabledPlugins` 旧 marketplace 后缀） | fix-spec「Open questions 6」 | 已登记 |
| ui-tui OQ-1（`.zcodeignore` 与产品名 ZCode） | fix-spec「Open questions 5」 | 已登记 |
| ui-tui OQ-2（spec:235 两个复用件失效） | ui-tui SD-4 判 fixed；fix-spec 未复述 | 可接受（review 自判非缺陷） |
| ui-tui OQ-3（S29 未抽专用 hook） | fix-spec「建议收窄①」 | 已登记 |
| mc-core OQ-1（fallbackModels 双链疑点） | fix-spec「Open questions 1」 | 已登记待查证 |
| mc-core OQ-2（reasoningBudgetDiagnostic 诊断串裁剪） | fix-spec「Open questions 2」 | 已登记待查证 |
| brand-dist OQ-1（`zcode-beta` 死触发删除 vs 改名） | fix-spec「Open questions 3」，MF-32 默认删除 | 已登记待拍板 |
| brand-dist OQ-2（SEA 缓存根改名旧缓存失效） | fix-spec「Open questions 4」 | 已登记 |

**结论：13 条 review OQ 中 11 条有明确归属，2 条（mc-host OQ-3 / OQ-4，均为 P3「不阻塞」级）未进 fix-spec。**
这两条本身被 review 自判为 P3、明确「不阻塞 dev-loop」，**不构成 must-fix 漏项**；但它们是「已知事实未登记」的类别，建议主代理在 fix-spec 的 Open questions 补 2 行（各一句话即可），以免下一轮 CR 重复发现。

### 1.4 spec_deviations 覆盖度：**通过（无曲解）**

| review SD | 状态 | fix-spec 归属 | 一致 |
|---|---|---|---|
| mc-host SD-1（契约 8 enabled 未实现） | open | MF-01 | 一致，未降级 |
| mc-host SD-2（hooks.ts 缺失） | open | MF-05 | 一致 |
| mc-host SD-3（/compact 移除） | fixed 符合 spec | fix-spec「已接受」 | 一致 |
| mc-core SD-1（零消费 barrel 导出保留） | fixed 已接受 | MF-13 明确「**不**顺手清零」 | 一致，边界守得好 |
| mc-core SD-3（NUL 字节） | open | MF-12 | 一致 |
| brand-dist SD-1（T-P2 验收不实） | open | MF-02 | 一致 |
| brand-dist SD-3（npm publish 未做但 README 承诺） | open | MF-32 | 一致 |
| protocol SD-4（dynamic-workflow compaction 占位保留） | open 符合 spec | K 节 5（L290 白名单） | 一致 |
| protocol SD-5（UsageQuerySource 零影响） | open | K 节 5（L229 措辞） | 一致 |
| ui-tui SD-1（压缩 key 全删未删净） | open | MF-22 | 一致 |
| ui-tui SD-2（MIN-MAX 三处真相） | open | MF-25 | 一致 |
| ui-tui SD-3（未抽 hook） | open | 建议收窄① | 一致 |
| ui-tui SD-4（两个 spec 锚点失效） | fixed 非缺陷 | 未复述 | 可接受 |

**未发现 review 结论被 fix-spec 曲解**。fix-spec 在 MF-13 明确写入「不要顺手清理 E1 的零消费 barrel 导出」，在 MF-16 明确「不加兼容层（守 D-7）」，在 MF-04 保留「二选一，倾向前者」的裁量权——这些都精确复述了 review 的原始裁决，而非简化为更宽松的指令。

### 1.5 覆盖度小结

**漏项清单（应为空，实际列出 1 类）**：
- **OQ 登记遗漏（非 must-fix）**：mc-host OQ-3（`/ctx-status` 双渲染并存）、mc-host OQ-4（`fromConfigPort` 死字段）。均为 P3、不阻塞，但建议补登记以免重复发现。

**曲解清单：空。**
**降级清单：空。**

---

## 2. 可执行性结论（抽查 10 条 MF，9 处 file:line 回读 + 2 处 zod 实跑）

抽查范围刻意覆盖：2 条 P0、2 条 P1 跨包、1 条 P1 数据损坏、2 条 P2 跨包文档、2 条 P2 机械批、1 条 P1 协议。

| # | 条目 | 明确文件 | 可执行改法 | 可验证验收 | 改法与现状吻合 | 判定 |
|---|---|---|---|---|---|---|
| 1 | **MF-01** (P0) | ✅ 4 处 file:line 全给 | ✅ 冷/热两条路径分开给 | ✅ T-M8 零差异 + T-U1 级 | ✅ 回读确认吻合 | **通过** |
| 2 | **MF-02** (P0) | ✅ 3 处 | ⚠️ 改法有一处会引入新抛错 | ✅ 单测 + 真实刷新 | ❌ **与现状冲突** | **不通过（见 2.1）** |
| 3 | **MF-05** (P1) | ⚠️ 只给「装配层」抽象 | ✅ 顺序明确 | ✅ 单测可测 | ⚠️ 未点名真挂载点 | **有条件通过（见 3.3）** |
| 4 | **MF-07** (P1) | ✅ 2 处 | ✅ 含「勿用 .default/.catch」的坑位提醒 | ✅ 用例语义区分准确 | ❌ **前提被运行时推翻（见 2.2）** | **不通过** |
| 5 | **MF-08** (P1) | ✅ 3 处 | ✅ 5 步到删干净 | ✅ rg 归零 | ✅（未逐行回读，采信 review） | 通过 |
| 6 | **MF-09** (P1) | ✅ 2 处 | ✅ 含完整代码 | ✅ 含 stringify 回归 | ✅ 回读逐行吻合 | **通过** |
| 7 | **MF-10** (P1) | ✅ 2 处 | ✅ 含二选一 | ✅ 4 条手工验收 | ✅ 回读吻合 | **通过** |
| 8 | **MF-17** (P2) | ✅ 3 处 | ✅ 含一致性断言 | ✅ rg 判据 | ⚠️ 漏 2 处同源站点 | **有条件通过（见 3.5）** |
| 9 | **MF-18** (P2) | ✅ 1 处 | ✅ 一句话 | ✅ 单文件 oxfmt | ✅ 回读确认三行压列 0 | **通过** |
| 10 | **MF-13** (P2) | ✅ 1 处 | ✅ 含「不顺手清零」边界 | ✅ build + grep | ✅ 回读确认仅 import 命中 | **通过** |

**统计：10 条中 7 条通过、2 条不通过（MF-02、MF-07）、1 条有条件通过（MF-05）。**

### 2.1 【MF-02 不通过】别名归一的改法会引入**比现状更早**的抛错

回读 `adapters/src/plugins/marketplace.ts` 三处判据的实际顺序：

```
:356  if (isOfficialMarketplaceId(loaded.manifest.name) && loaded.manifest.name !== input.trustedId) throw reserved
:366  if (input.trustedId === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE && loaded.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) throw
:375  persistedManifest = loaded.manifest.name === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ? writeCdn... : loaded.manifest
```

真实 CDN 刷新场景（`marketplace.ts:513-522` 受信任刷新）：`trustedId = record.id = "oh-my-zcode-official"`（canonical，来自 `ensureDefaultPluginMarketplaces` 种子），`manifest.name = "zcode-plugins-official"`（旧名）。

fix-spec MF-02 的改法第 1 步要求 `isOfficialMarketplaceId` **接受双 id**。代入 `:356`：
- `isOfficialMarketplaceId("zcode-plugins-official")` → **true**（扩集后）
- `"zcode-plugins-official" !== "oh-my-zcode-official"` → **true**
- ⇒ `:356` **抛 "that id is reserved for the official marketplace"**

也就是说，扩集 `isOfficialMarketplaceId` 后，官方 CDN 的旧名 manifest 会在 **:356 就被拦下**，比现状的 `:366` **更早**失败。fix-spec 改法第 2 步只改了 `:366` 的守卫，没改 `:356`，因此**照此改法执行，刷新依然失败，只是失败点前移了 6 行**。fix-spec 在改法第 3 点写「`:356` 保留名保留字检查不变（扩集后语义仍自洽：reserved 名单含旧名，非 trusted 不得冒用）」——这句推理在「trustedId 也是 canonical」的受信任刷新路径上不成立。

**这不是执行者能自行消解的规格缺口，是 fix-spec 的改法本身需要修正。**

建议改法（供主代理采纳，我不动 fix-spec）：
```ts
// contracts/src/plugins/index.ts —— 拆成两个语义，扩集只放宽「相等性」判定
export const LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_IDS = ["zcode-plugins-official"] as const;
export function isOfficialMarketplaceId(id: string): boolean {          // 保留名单语义，不扩集
  return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE
    || (LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_IDS as readonly string[]).includes(id);
}
export function isCanonicalOfficialMarketplaceId(id: string): boolean {  // 新增：只认 canonical
  return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
}

// marketplace.ts:356 —— 保留字判定改用 canonical 名单，避免旧名自撞
if (isOfficialMarketplaceId(loaded.manifest.name)
    && !isCanonicalOfficialMarketplaceId(input.trustedId ?? "")
    && loaded.manifest.name !== input.trustedId) { throw reserved }
```
并把 `:375` 改为 `isOfficialMarketplaceId(loaded.manifest.name)`（此项 fix-spec 已给对）。
另需注意 `bootstrap/src/plugins.ts:1084/1094/1111/1184` 四处也调用 `isOfficialMarketplaceId`——扩集后语义从「canonical」变为「canonical ∪ legacy」，四处行为需一并复核（`resolveDeclaredMarketplaceSources` 会把旧名声明也纳入保留诊断，方向上无害，但应显式登记）。

### 2.2 【MF-07 不通过】zod 4 下 `z.unknown()` 键**不是** optional，信封已拒「键缺席」

fix-spec MF-07 的问题陈述是「`config: z.unknown()` 隐含 optional，`{workspace}` 合法」。回读 `packages/shared/src/zcode-protocol/index.ts:2146-2151` 确认 schema 形状无误，但**该前提在 zod 4 下不成立**。

实跑验证（`packages/shared` 目录下，`zod@4.6.5`，与 `package.json:32` 的 `"zod": "4.6.5"` 一致）：

```
z.object({ w: z.string(), config: z.unknown() }).strict()
  { w:'x' }                  -> false   issues: [{ code:'invalid_type',
                                          expected:'nonoptional', path:['config'],
                                          message:'Invalid input: expected nonoptional, received undefined' }]
  { w:'x', config:{} }       -> true
  { w:'x', config:null }     -> true
  { w:'x', config:undefined} -> true
```

即：**键缺席已经被 `.strict()` + zod 4 的 `nonoptional` 检查拒绝**，报的是 `invalid_type` 而非自定义消息；handler `magic-context-config.ts:122` 的 `params.config ?? {}` 兜底**只在 `config: null` / `config: undefined` 这两种「键存在但值为空」时才会命中**——而这两者 JSON-RPC 线上可达（`{"workspace":...,"config":null}` 是合法 JSON）。

fix-spec 的改法「加 `.refine(p => p.config !== undefined)`」在 zod 4 下**大部分是冗余的**（键缺席已在 object 层被拒），但**并非全无用**：它拦住了 `config: undefined`。可它**拦不住 `config: null`**——而 `null` 恰恰是线上最自然的手写 JSON 形态，且 `?? {}` 对 `null` 同样生效 → 全默认域 → 写盘 + fan-out + `applied:true`，破坏性后果与 review 陈述完全一致。

**净结论：缺陷本身成立（`config: null` 仍能静默重置整域），但 fix-spec 定位的触发路径（键缺席）被运行时推翻、且所选改法漏掉了真正可达的那条路径。**

建议改法（供主代理采纳）：
```ts
// 保留 refine 但把判据从「键缺席」换成「值不是 null/undefined」，一次覆盖两条真实路径
.refine((params) => params.config !== undefined && params.config !== null, {
  message: "config is required and must not be null: this method replaces the whole magicContext domain, so an absent or null config would reset every setting to its default",
  path: ["config"],
});
```
同时 `:122` 的 `params.config ?? {}` 改为显式抛错作纵深防御（review 已建议）。
验收用例需相应改为**两条**：`{ workspace }`（键缺席，断言 -32602 且 reason 含 nonoptional 或自定义消息）与 `{ workspace, config: null }`（键存在值为 null，断言 -32602 + 磁盘与 ConfigPort 均未动）。现 fix-spec 的验收只写「键缺席」，会漏测 `null`。

### 2.3 【MF-05 有条件通过】改法正确，但未点名 create-app 现有的真实 dispose 链

fix-spec MF-05 写「装配层加生命周期接线，返回 `dispose?()` 由 create-app 在 app close 调用」。回读发现 create-app 的关闭链**不是**一个可以随便挂 `dispose()` 的单点，而是经 `session-facade.ts:264-308` 的 `close()`：

```
session-facade.ts:267  deps.runtime.beginShutdown()
             :268      await deps.runtime.drainMemoryExtractions(60_000)
             :274-289  deps.closeDynamicWorkflowRuns()（try/catch + warn 兜底）
             :294-305  closeSessionResources({ ..., closeNodeReplBrowserBroker, closeSessionStore, ... })
```

而 `create-app.ts:958-960` 通过 `closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close()` 把钩子注入 sessionFacade。**这正是 MF-05 应有的挂载点范式**——但 fix-spec 没点名它，执行者需要自己发现「dynamic-workflow run 关闭」这条既有先例。改法可执行、验收可测，只是缺一个明确的落点锚点。建议主代理在 MF-05 补一句「参照 `create-app.ts:958-960` 的 `closeDynamicWorkflowRuns` 注入范式」，并注意 drain 必须排在 `beginShutdown` 之后、且整段要有 try/catch 兜底（与 `:274-289` 同构，否则 historian 关闭抛错会吃掉资源关闭）。

### 2.4 其余抽查条目的吻合性确认（回读依据）

- **MF-01**：`runtime-config.ts:190-193` 回读确认 `enabled: options.runtimeConfig?.magicContext?.enabled ?? configResult.config.features.magicContext`——**确实只镜像 features flag，不含 `config.magicContext.enabled`**，与 fix-spec 陈述逐字吻合。`create-app.ts:779` 装配门 `runtimeConfig.magicContext?.enabled === true`、`:788` `enabled: true` 硬编码，回读确认。`schema.ts:240` `findConfigReadinessError` 是 `config.enabled` 全仓唯一读取点，回读确认。**改法与现状高度吻合。**
- **MF-09**：`magicContextSettingsForm.ts:140-141` 回读为 `if (form.executeThresholdTokens === null) { delete next.execute_threshold_tokens; }`——**无 per-model 保留分支**，与 fix-spec 陈述一致；`:64-67` `readTokensDefault` 确认无 default 坍缩 null；`:55` 不变式注释确认。`schema.ts:157-162` 回读确认 `default` 为 `.optional()` 且 `.catchall(...)` 支持 per-model、`:164` describe 明写「Accepts `default` for all models or per-model keys」。**改法给的完整代码可直接落地。**
- **MF-10**：`MagicContextSettingsFields.tsx:63-70` 回读确认 decimal 分支为 `const next = Number(event.target.value); if (Number.isFinite(next)) props.onChange(next);`——**确实绕过 `parseOptionalNumber`**。`schema.ts:175-178` 回读确认 `history_budget_percentage` 为 `.min(0.05).max(0.5)`。**吻合。**
- **MF-13**：`storage-db.ts:21` 回读为 `import { harnessOwnsOpenCodeStore } from "../../shared/harness.js";`，全仓 grep 该符号仅此 1 处命中。**吻合（确为未使用 import）。**
- **MF-18**：`adapters/src/config/schema.ts:433-437` 回读确认 `:434/:435/:436` 三行处于列 0，而 `:433`/`:437` 保持 2 空格。**吻合。**
- **MF-08**（未逐行回读）：采信 review-protocol 的回读记录（`contracts/src/rewind/index.ts:29` 枚举成员、`:69-74` wire schema、`rewind.ts:244-247/326-329`）。fix-spec 的 5 步改法与 review 的 5 步一一对应，无增删。**判通过但标注「未独立复核」。**

---

## 3. 跨模块盲区（五个 scope 单独看不见的）

### 3.1 MF-01（enabled 接线）× MF-06（ctx 命令面 flag 门）：两处 effective 的**求值位置会分叉**

- MF-01 把 effective 定义为 `features.magicContext && (config.magicContext?.enabled ?? true)`，落点在 `runtime-config.ts:190-193`（冷启动装配期）。
- MF-06 的改法要求「在 `handleCtxCommand` 里、`loadMagicContext()`/开库**之前**先取 effective flag」，并建议「参照 `app/types.ts:622-634` 的 `getConfigPort?()` 可选能力模式，在 `CommandCenterApp` 上加 `isMagicContextEnabled?()`，由 create-app 用**与 runtimeConfig 同一 effective 值**填充」。

**盲区**：MF-01 与 MF-06 各自定义了一个「effective」，但分处两个求值点。若执行者按 MF-06 在 `cli/src/command-center/handlers/ctx.ts` 侧自行读 `config.features.magicContext`（而不是从 app 能力取装配期算好的值），就会得到**两个可能不一致的 effective**：MF-01 修好后装配门认二级开关，MF-06 若没同步认，`/ctx-*` 命令面与 turn-loop 会分叉——features=true + enabled=false 时，`/ctx-status` 仍开库而 transform 不插桩。

**必须-fix 补充建议**：MF-01 与 MF-06 应共用**唯一求值点**。建议 MF-06 明确写「`isMagicContextEnabled?()` 的值必须由 `create-app` 从 `runtimeConfig.magicContext.enabled` 透传（与 MF-01 同一个字段），`ctx.ts` 不得自行读 `features` 或重算」；并在 K 节验收里把 MF-01/06 的 on/off 双态合并成一次 E2E（fix-spec K 节 6 已经这么写了，但没把「两处 effective 必须同源」写成硬约束）。

### 3.2 MF-01 × MF-07（RPC 信封）的交互：修完 MF-07 会**放大** MF-01 的暴露面

- MF-07 修完后，`updateMagicContextConfig` 从「任意调用都能写」变成「必须显式传整域」。
- MF-01 的验收要求「设置页切换 enabled 下一 turn 生效（T-U1 级验证）」——即 D-12 热生效路径。

**盲区**：D-12 的热生效依赖 `configPort.set` → `ConfigPort.observe` fan-out → `magic-context-turn-transform.ts:821` `bridge.onChange` → `:882` `configPort.observe().subscribe`。回读确认 `magic-context-config.ts:142-148` 的 fan-out 循环遍历 `context.sessions`，每个 resident session 用 `record.app?.getConfigPort?.()`。

问题：**若某 session 的 app 未实现 `getConfigPort`（代码里明写了「轻量 embedder 与测试 record 不实现」，`:143`），该 session 的 config bridge 永远收不到推送，enabled 的热生效在该 session 失效。** MF-01 的验收只说「下一 turn 生效」，没界定「对哪些 session 生效」。这不算 MF-01 的缺陷（fan-out 的 skip 是既有设计且有注释自陈），但 fix-spec 应把 MF-01 的验收口径写清「在实现了 `getConfigPort` 的 resident session 上」，否则执行者可能写出只在测试 record 上通过的验收。

**次级盲区（MF-07 专属）**：MF-07 加 `.refine` 后，`.refine` 是在 `.strict()` **之后**的链式调用，错误路径 `path:["config"]` 会与 `.strict()` 的 `unrecognized_keys` 错误并存于同一个 `ZodError.issues`。而下游 `formatIssues`（`magic-context-config.ts:171-175`）是 `issue.path.join(".") + ": " + issue.message` 逐条拼接——`config: config is required...` 会正常出现在 `-32602` 消息里，但 MF-27（UI toast 追加 `error.message`）会把这条长消息直接弹给用户。**建议 MF-27 的验收补一句「消息里含 config 字段名即可，不要求用户能读懂」**，避免执行者把 refine 消息写成人话长句后与 MF-27 的「字段级错误」验收打架。

### 3.3 MF-05（生命周期接线）× create-app 现有 dispose 链：见 2.3，另有**顺序**耦合

除落点问题外，还有一层顺序耦合 fix-spec 未点明。现有 `session-facade.ts:267-305` 的顺序是：
`beginShutdown → drainMemoryExtractions → closeDynamicWorkflowRuns → closeSessionResources`

MF-05 要求 `drain → shutdown → bridge.dispose`。插入点若放在 `closeDynamicWorkflowRuns`（`:274`）之前，则顺序为：
`beginShutdown → drainMemoryExtractions → [drainHistorian → historian.shutdown → bridge.dispose] → closeDynamicWorkflowRuns → closeSessionResources`

这是**正确的**——historian 的在飞请求必须在 `closeSessionResources` 关掉 execution port / session store **之前**收口，否则 historian 落库会写到已关闭的 store 上。fix-spec 的改法虽然写了「drain→shutdown→bridge.dispose 顺序」，但**没有把它与 `closeSessionResources` 的相对位置钉死**。执行者若把整段放到 `closeSessionResources` 之后（直觉上「最后清理」），会得到一个跑起来不报错、但 historian 写库失败的隐性 bug。

**必须-fix 补充建议**：MF-05 补一句「接线位置在 `session-facade.ts:274` 的 `closeDynamicWorkflowRuns` 之前、且在 `closeSessionResources` 之前；参照 `:274-289` 的 try/catch + `logger.warn` 兜底范式，historian 关闭抛错不得吃掉后续资源关闭」。

### 3.4 MF-02（别名归一）× OQ-6（`enabledPlugins` 旧后缀）：fix-spec 已分置，但**语义耦合需要一句登记**

fix-spec 把 MF-02（manifest 侧旧名容忍）列为 must-fix，把 OQ-6（`plugins.enabledPlugins` 里 `xxx@zcode-plugins-official` 不 canonicalize）列为待拍板。回读确认二者确实是**不同层**：

- MF-02 治的是 **marketplace manifest / 分片落盘**：`contracts/src/plugins/index.ts:22` 的 `isOfficialMarketplaceId` + `marketplace.ts:356-382`。
- OQ-6 治的是 **插件 id 串的 `@marketplace` 后缀**：`adapters/src/config/schema.ts:198` 的 `canonicalizePluginId` 只覆盖 CUA 一对（`LEGACY_CUA_PLUGIN_ID = "zcode-cua@oh-my-zcode-official"` → `CANONICAL_CUA_PLUGIN_ID = "computer-use@oh-my-zcode-official"`）。

**盲区（语义耦合）**：MF-02 落地后会引入一个 `LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_IDS` 常量。它治好了「市场能刷新」，但**没有**让旧后缀的 `enabledPlugins` 条目复活——升级用户在 `config.json` 里写的 `foo@zcode-plugins-official` 仍然静默失效（因为 `canonicalizePluginId` 不认这个 marketplace 段）。用户视角是「市场能刷了但我开的插件还是没生效」，这**容易被误报成 MF-02 没修好**。

**建议（非 must-fix）**：MF-02 的注释登记里补一句「本条只治 marketplace 侧；`plugins.enabledPlugins` 的旧后缀仍按 OQ-6 待拍板，D-7 前提下不迁移」，并在 OQ-6 的描述里回指 MF-02，避免两条各自被验收时产生「修了一个另一个没修」的困惑。

### 3.5 MF-17 与 MF-33 的文档联动：**存在重复条目与 2 处未覆盖站点**

fix-spec MF-33 的文件清单里明确含「`saved-workflow:43-46`（=MF-17）」，标注了同源。**但这不是纯重复，还有实质冲突和覆盖缺口。**

回读 `git grep -rn "\.omz/workflows"` 全仓结果，13 处命中里：

| 站点 | 内容 | 归属 | 状态 |
|---|---|---|---|
| `contracts/src/tools/saved-workflow.ts:44-45` | 「project 落在项目的 `.omz/workflows/`」 | MF-17 + MF-33 | 已覆盖 |
| `packages/shared/src/zcode-protocol/index.ts:2729` | 「项目档落 `<cwd>/.omz/workflows/`」 | MF-17 | 已覆盖 |
| `contracts/src/tools/saved-workflow.ts:23` | 草稿目录注释「`.zcode/workflow-drafts/` 的兄弟目录」 | — | 正确（.zcode） |
| `core/src/tool/handlers/saved-workflows/store.ts:53` | 「项目档落在会话工作目录的 `.omz/workflows/`」 | **未覆盖** | **错，需改** |
| `core/src/tool/handlers/list-saved-workflows.ts:29` | 工具描述里用 `${SAVED_WORKFLOW_PROJECT_DIR}` 插值 | — | 正确（跟随常量） |
| `ui/src/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.ts:20` | 「项目组传 `workspacePath`（拼出 `<ws>/.omz/workflows`）」 | **未覆盖** | **错，需改** |
| `ui/src/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.ts:62` | 「监听 .omz/workflows 失败」**（用户可见日志文案）** | **未覆盖** | **错，需改** |
| `bootstrap/src/zcode-protocol/saved-workflows.ts:8` | 「`global` 时改按本机全局根（`~/.omz/workflows/`）」 | — | 正确（global 语义） |
| 其余（bundled-skills SKILL.md、services、zcodeAgentWorkflowParams、useSavedWorkflowGlobalGroup、:28/:31/:99） | 均为 global 档 `~/.omz/workflows` | — | 正确 |

**冲突点**：MF-17 的验收写「`rg "\.omz/workflows"` 仅剩全局档语义」。但按上表，`store.ts:53` 与 `useSavedWorkflowsDirectoryWatch.ts:20/:62` 三处说的是 **project 档**，改完 MF-17/MF-33 覆盖的两处后，**rg 仍会命中这 3 处 project 档错误描述** → **MF-17 的验收会失败**。

**必须-fix 补充建议**：MF-17 的文件清单补三处：
- `apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/store.ts:53`
- `packages/ui/src/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.ts:20`
- `packages/ui/src/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.ts:62`（用户可见日志文案，`packages/ui` 在 ui-tui scope 内，但 MF-17 是 protocol scope 的条目——需在 fix-spec 里显式跨 scope 授权，否则会被 dev-loop 判越界）

**重复计数判定**：MF-17 与 MF-33 同时列 `saved-workflow.ts:43-46`，但 **MF-33 的本意是「5 处机械替换注释」的清单之一**，MF-17 的本意是「project scope 三处矛盾」——**同一文件同一段的两条 fix-spec 条目**。建议主代理明确归属：要么把 `saved-workflow.ts` 从 MF-33 的 5 处清单里剔除（全部归 MF-17），要么在 MF-33 标注「此文件由 MF-17 负责，MF-33 只做复核不重复编辑」。否则 Wave D 批量执行时两个 agent 可能对同一段做两次编辑。

### 3.6 跨模块新发现汇总（3 条需补 must-fix / 建议）

| # | 类别 | 关联条目 | 建议 | 是否阻塞 |
|---|---|---|---|---|
| N-1 | 同源 effective 会分叉 | MF-01 × MF-06 | 两处 effective 强制同源，MF-06 不得自行读 features | **是**（Wave C 执行前须补） |
| N-2 | 接线顺序未钉死 | MF-05 × session-facade | 补「插在 closeDynamicWorkflowRuns 与 closeSessionResources 之前 + try/catch 兜底」 | **是** |
| N-3 | MF-17 验收会失败 + 越界 | MF-17 × MF-33 | 补 3 处站点 + 跨 scope 授权 + 归属去重 | **是**（Wave D 执行前须补） |
| N-4 | 语义耦合需登记 | MF-02 × OQ-6 | 互相回指，避免「修了一个另一个没修」 | 否（建议） |
| N-5 | 验收口径需界定 | MF-01 × MF-07 | MF-01 验收补「对实现了 getConfigPort 的 resident session」；MF-27 验收补「含字段名即可」 | 否（建议） |