# CR v0.1.0 · review-ui-tui（scope 模式）

- 节点 id: `review-ui-tui`
- 模式: scope（只评 `packages/ui/**`、`apps/zcode-cli/packages/tui/**`、`apps/zcode-cli/packages/i18n/**` 在 `1fa2d0e..aba59a9` 的变更）
- BASE_SHA: `1fa2d0e` ／ HEAD_SHA: `aba59a9`
- 维度: A + B + C + C-orch + G（本 scope）+ J（UI 适用）
- Spec: `docs/iterations/oh-my-zcode-fork/spec.md`（S27=L216-239 / S29=L233-237 / S30=L239,291-292；D-10=L46；D-12=L48；D-13=L49）
- 证据包: `cache/cr-v010-evidence-ui-tui-i18n.md`
- fix-spec: 尚未创建

> 只读评审。未修改任何代码/文档；唯一写入为本文件。

## 裁决方法

证据包的每条结论均按 `file:line` 回读 HEAD（`git grep`/`git show`）复核，不以索引代替证据。
复核中**推翻证据包 4 条、修正计数 1 处、新发现 2 处 P1**（见文末「对证据包的订正」）。

---

## must-fix

### review-ui-tui/C-01 · P1 · 配置数据静默丢失：`execute_threshold_tokens` 的 per-model 表被删键

- **文件**：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\magicContextSettingsForm.ts`（读侧 `:64-67`、写侧 `:140-146`；调用侧 `MagicContextSettingsSection.tsx:125-127`）
- **维度**：C（正确性 / 数据保全）
- **描述**

CLI schema 里 `execute_threshold_tokens` 的 `default` 是**可选**的：

```
apps/zcode-cli/packages/magic-context/src/host/config/schema.ts:157-162
  z.object({ default: z.number().min(5_000).max(2_000_000).optional() })
   .catchall(z.number().min(5_000).max(2_000_000))
   .optional()
```

同文件 `:164` 的 describe 明确写着「Accepts `default` for all models **or** per-model keys」——即 `{ "zcode/glm-4.6": 30000 }`（**无 `default`**）是受支持的合法配置。对照组：`execute_threshold_percentage`(`:151`) 与 `cache_ttl`(`:184`) 的 `z.object({ default: ... })` 里 `default` 是**必填**，只有 tokens 这条是可选的。

由此产生两条缺陷：

1. **读侧信息坍缩**：`readTokensDefault`（`:64-67`）只取 `default` 分支，无 `default` 时返回 `undefined` → `form.executeThresholdTokens = undefined ?? null` = `null`。「per-model 表存在但没有 default」与「压根没配」被压成同一个 `null`。
2. **写侧删整表**：`buildMagicContextConfigFromForm`（`:140-141`）看到 `form.executeThresholdTokens === null` 就 `delete next.execute_threshold_tokens` —— 连用户从未在 UI 里看见、也从未编辑过的 per-model 键一起抹掉。

这**直接违反本文件自己声明的不变式**。`magicContextSettingsForm.ts:55` 写着「首版 UI 不提供按模型编辑的入口，**也不该在这里悄悄丢掉用户已有的按模型覆盖**」。

3. **附带放大为「挂载即 dirty」**：保存按钮的启用条件是 `disabled={!canSave || !dirty}`（`MagicContextSettingsSection.tsx:251`），而 `dirty` 用
   `JSON.stringify(buildMagicContextConfigFromForm(baseConfig, form)) !== JSON.stringify(baseConfig)`（`:125-127`）计算。读回的有效域里带 per-model 表时，**用户一个字符都没改**，这个不等式就已经成立 → 打开页面即 `dirty=true`、保存按钮可点 → 点一下即销毁配置。误触门槛为零。

- **具体改法**

写侧改为「只摘 `default` 分支，保留 per-model 键」，读侧不动：

```ts
// magicContextSettingsForm.ts:140-146 替换
if (form.executeThresholdTokens === null) {
  if (isRecord(previousTokens) && Object.keys(previousTokens).length > 0) {
    // 「留空 = 不覆盖」只应作用于 default 分支；per-model 表是用户已有的配置，
    // UI 没有编辑入口，就更没有资格替用户删掉（schema:164 明确允许只有 per-model 键）。
    const { default: _droppedDefault, ...perModelOnly } = previousTokens;
    if (Object.keys(perModelOnly).length > 0) {
      next.execute_threshold_tokens = perModelOnly;
    } else {
      delete next.execute_threshold_tokens;
    }
  } else {
    delete next.execute_threshold_tokens;
  }
} else if (isRecord(previousTokens)) {
  next.execute_threshold_tokens = { ...previousTokens, default: form.executeThresholdTokens };
} else {
  next.execute_threshold_tokens = { default: form.executeThresholdTokens };
}
```

改完后 `dirty` 误报自动消失：base `{model:30000}` → next `{model:30000}` → `stringify` 相等。

配套（可选但建议）：在 `settings.context.executeThresholdTokens.description` 后追加一句「已有按模型覆盖时本项留空只清除通用值」，或在只读到 per-model 表时于该行下渲染一条提示，避免「留空看着没反应」的困惑。

- **验收/测试要点**
  1. 在 `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs` 补一条用例：base = `{ execute_threshold_tokens: { "zcode/big": 90_000 } }`（**无 default**），form 从它读出后不改动任何字段，断言 `buildMagicContextConfigFromForm(base, form)` 的 `execute_threshold_tokens` 仍 deepEqual `{ "zcode/big": 90_000 }`。
  2. 同脚本补「挂载即 dirty」回归：断言对上述 base，`build(base, formFromConfig(base))` 的 stringify **等于** base 的 stringify。
  3. 保留既有 `{ default, "zcode/big" }` 用例（`:245/:259`）仍绿——现测试**只覆盖了带 `default` 的形态**，这正是缺口所在。
  4. 手工（对应 T-U1）：在 `~/.omz/cli/config.json` 写 `{"magicContext":{"execute_threshold_tokens":{"zcode/glm-4.6":30000}}}` → 打开设置页「上下文管理」→ 确认保存按钮为**禁用** → 切一次 smartDrops 保存 → 确认该键仍在。

---

### review-ui-tui/C-02 · P1 · `inputMode="decimal"` 分支：清空「历史预算占比」直接写入 `0`（越下界）

- **文件**：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\MagicContextSettingsFields.tsx:63-70`（onChange）、`:152-165`（historyBudget 调用点）、`:105-118`（percentage 对照）
- **维度**：C（正确性 / 输入校验）
- **描述**

`NumberField` 的 onChange 按 `inputMode` 分两条路：

```tsx
// :63-70
if (props.inputMode === "decimal") {
  const next = Number(event.target.value);
  if (Number.isFinite(next)) props.onChange(next);
  return;
}
props.onChange(parseOptionalNumber(event.target.value));
```

`parseOptionalNumber`（`:26-31`）对空串返回 `null`，被调用点的 `if (value !== null)` 守卫（`:116`、`:163`）吞掉——所以「执行阈值」清空后弹回 65，这是**设计意图**。

但 decimal 分支绕过了它。实测 `Number("") === 0` 且 `Number.isFinite(0) === true`。于是 `historyBudgetPercentage`：

1. 用户全选删除 → `event.target.value === ""`
2. `next = 0`，finite → `props.onChange(0)`
3. 调用点 `:162-164` 的守卫判 `0 !== null` → **放行** → `patch("historyBudgetPercentage", 0)`
4. 受控值变 `0`，输入框显示 `0`；`dirty=true`，保存按钮可点
5. 保存必被 CLI 拒：`schema.ts:177` 是 `z.number().min(0.05).max(0.5)`
6. 用户只看到一句「保存上下文管理配置失败，请重试。」（见 C-03）

即：**同一个组件里的两个数字框，清空行为不一致；后者会把一个必然被拒的值写进表单并弹给用户。** 这与 `magicContextSettingsForm.ts:220-222` 自述的意图（「UI 这一层只负责不给用户必然被拒的输入」）直接矛盾。

同一缺陷的第二面：非空越界值（如 `0.9`、历史预算敲 `0.9`）也会原样进 `form` —— `min`/`max` 只驱动步进器与浏览器原生校验，不阻止键入。

- **具体改法**

两条分支统一走空串优先，并按已声明的意图在 UI 层挡住必然被拒的值：

```tsx
// MagicContextSettingsFields.tsx:63-70 替换
onChange={(event) => {
  const raw = event.target.value.trim();
  if (!raw) {
    props.onChange(null);          // 清空交给调用点的 null 守卫 → 弹回原值
    return;
  }
  const next = Number(raw);
  if (!Number.isFinite(next)) return;
  if (next < props.min || next > props.max) return;  // 不让必然被拒的值进 form
  props.onChange(next);
}}
```

（若产品希望允许临时越界、只在提交时拦，则改为在 `onBlur` 里 clamp 到 `[min,max]` 并同步 `patch`；二选一，但必须与 `:220-222` 的注释保持一致，别留「软约束 + 不校验」的空档。）

- **验收/测试要点**
  1. 单测（若抽 onChange 为纯函数最好测）：`onChange("")` → `onChange` 收到 `null` 而非 `0`。
  2. 手工：历史预算占比框全选删除 → 输入框应弹回 `0.15`，不出现 `0`；保存按钮保持禁用。
  3. 手工：历史预算占比敲 `0.9` → 值不被采纳（回弹）或被 clamp 到 `0.5`，保存按钮禁用。
  4. 对照：执行阈值百分比清空仍弹回 `65`（行为不变）。

---

### review-ui-tui/C-03 · P2 · 保存失败丢弃服务端已给出的字段级错误，只弹固定文案

- **文件**：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\MagicContextSettingsSection.tsx:142-148`
- **维度**：C（可诊断性）/ B（错误路径）
- **描述**

CLI 侧的 `-32602` 消息**已经带了字段路径与具体约束**：

```
apps/zcode-cli/packages/bootstrap/src/zcode-protocol/magic-context-config.ts:124-128
  throw new ProtocolRequestError(-32602,
    `Invalid params — magicContext: ${formatIssues(parsed.error)}`, parsed.error);
// :171-175  formatIssues → `${issue.path.join(".")}: ${issue.message}`
```

即形如 `Invalid params — magicContext: history_budget_percentage: Too small: expected number to be >=0.05`。

`packages/services/src/zcode-agent/zcodeAgentService.ts:3782` 的注释明写「校验失败由 CLI 以 -32602 结构化返回，这里**原样上抛**」，所以 `error.message` 在 catch 里是完整可用的。但 `MagicContextSettingsSection.tsx:142-148` 只 `logger.warn` 后 toast 一句固定的 `settings.context.saveFailed`，把这段信息全丢了。

证据包 §5.5 把这描述成「用户拿不到哪个字段越界的信息」——**方向正确但归因错了**：信息拿得到，是 UI 主动丢弃的。这让修复成本从「要服务端配合」降到「一行」。

- **具体改法**

```tsx
// MagicContextSettingsSection.tsx:142-148
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  logger.warn("[MagicContextSettingsSection] 保存 magicContext 配置失败", { error: detail });
  // 服务端 -32602 已带「字段路径: 约束」，原样带给用户，别只给一句「请重试」。
  toast(`${intl.formatMessage({ id: "settings.context.saveFailed" })}（${detail}）`);
}
```

若要更精细，可在 catch 里按 `detail` 里 `-32602` 的字段前缀把错误挂到对应 `SettingsRow` 上（`loadError` 已有现成的行内红条范式可抄 `:193-202`），但最小形态（追加 detail）即可闭合 C-02 的可诊断性缺口。

- **验收/测试要点**
  1. 构造越界值（如 C-02 复现路径），点保存，toast 必须出现字段名与约束文本。
  2. `logger.warn` 仍保留完整 detail（不回归可观测性）。
  3. `saving` 在 finally 复位、保存按钮恢复可用（现有 `:147-149` 行为不变）。

---

### review-ui-tui/A-01 · P2 · S27 i18n 清理漏 3 条孤立 key + 1 条陈旧注释

- **文件**：
  - `D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\i18n\locales\en-US.ts:4730`、`:4731`、`:4680`
  - `D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\i18n\locales\zh-CN.ts:4429`、`:4430`、`:4382`、`:4381`（注释）
- **维度**：A（规范符合性 / i18n）
- **描述**

spec:225 的主句是「压缩相关 key **全删**」，后面跟的「zh-CN 实测：`chat.contextCompaction.*` 8 个、`chat.contextOptimization.*` 5 个、`chat.compact.*` 3 个」是那个时刻的**清单快照**，不是封闭的白名单。HEAD 仍留着这 3 条**零消费**的 key（`git grep` 全仓实测，消费侧 0 命中）：

| key | 定义 | 值 |
|---|---|---|
| `chat.contextUsage.compress` | en-US.ts:4730 / zh-CN.ts:4429 | `"Compress"` / `"压缩"` |
| `chat.contextUsage.compressDescription` | en-US.ts:4731 / zh-CN.ts:4430 | `"Send {command} to compress the current context"` / `"发送 {command} 压缩当前上下文"` |
| `chat.queue.runNow` | en-US.ts:4680 / zh-CN.ts:4382 | `"Run now"` / `"立即"` |

前两条正是被删的 `getContextCompressionCommand`（恒返回 `"/compact"`）这条死链**唯一的 UI 文案载体**；`compressDescription` 里的 `{command}` 占位符指向那个已删除的函数，且文案本身含明确的压缩指令语义。第三条原消费点是 `ConversationQueuePanel.tsx` 的 `isCompact ? "chat.queue.runNow" : "chat.queue.sendNow"`，S27 改成恒 `sendNow` 后成为孤儿（`ConversationQueuePanel.tsx:216` 现在只引用 `sendNow`）。

附带一条陈旧注释：`zh-CN.ts:4381` 仍写着「compact 队列项曾单独显示"立即执行"，与同一队列中的即时动作文案不一致。」——描述的是已被删除的行为。

- **具体改法**

从双语 locale 各删 3 条 key（`en-US.ts:4730-4731`、`:4680`；`zh-CN.ts:4429-4430`、`:4382`），并删掉 `zh-CN.ts:4381` 的注释行。删后跑一次 zh/en 键集双向 diff 确认差集仍为背景已拍板的 `settings.memory.viewer.disabled` 单向 1 条。

- **验收/测试要点**
  1. `git grep -n "chat.contextUsage.compress\|chat.queue.runNow"` → 0 命中。
  2. zh/en 顶层键集双向差集：en-only = 1（`settings.memory.viewer.disabled`，BASE 遗留已登记）、zh-only = 0。
  3. 桌面 UI 构建 + 设置页/队列面板渲染无缺失文案告警（`react-intl` missing message）。

---

### review-ui-tui/G-01 · P2 · knip 口径破防：4 条新增未用导出，且全部命中 magic-context

- **文件**：
  - `D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\magicContextSettingsForm.ts:183`（`NO_HISTORIAN_MODEL_VALUE`）、`:208`（`MagicContextNumberFieldSpec`）
  - `D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\chat-input-toolbar\magicContextUsageRows.ts:25`（`MagicContextUsageRow`）、`:34`（`MagicContextUsageRowInput`）
- **维度**：G（本 scope）
- **描述**

拍板口径是「与前一提交 stash 对比**零新增** + **零 magic-context 命中**」。这两条同时被破：

回读全仓实测，4 个符号**只在各自定义文件内被消费**（`git grep` 结果逐条如下）：

```
magicContextSettingsForm.ts:183  NO_HISTORIAN_MODEL_VALUE  → 同文件 :187 / :199
magicContextSettingsForm.ts:208  MagicContextNumberFieldSpec → 同文件 :232 (satisfies)
magicContextUsageRows.ts:25      MagicContextUsageRow        → 同文件 :63 (返回类型)
magicContextUsageRows.ts:34      MagicContextUsageRowInput   → 同文件 :63 (参数类型)
```

包外 0 引用；两套 bootstrap 测试脚本（`test-magic-context-ui-config.mjs:79`、`test-magic-context-usage-projection.mjs:75`）只 `import()` dist 里的**函数**，不 import 类型/常量。

所以：既是相对基线的**新增**（不是净增——同批还移除了 2 条 S27 遗留 `getContextCompressionCommand`，这解释了「411 vs 408 = 净 +3」与「本范围 +4」的口径差），又**全部落在 magic-context 文件上**，两条口径各破一次。

模块头注释（`magicContextSettingsForm.ts:15-18`、`magicContextUsageRows.ts:14-18`）自称「纯函数可被 CLI 侧测试直接加载 dist 产物」——但那说的是**函数**的可达性，不能给类型和常量开 `export` 找理由。

- **具体改法**

去掉 4 个 `export` 关键字（消费点全在同文件，不影响任何编译）：

- `magicContextSettingsForm.ts:183` → `const NO_HISTORIAN_MODEL_VALUE = "none";`
- `magicContextSettingsForm.ts:208` → `interface MagicContextNumberFieldSpec { ... }`
- `magicContextUsageRows.ts:25` → `interface MagicContextUsageRow { ... }`
- `magicContextUsageRows.ts:34` → `interface MagicContextUsageRowInput { ... }`

保留 `export` 的 `buildMagicContextConfigFromForm` / `magicContextSettingsFormFromConfig` / `toModelPickerValue` / `toPersistedModelId` / `MAGIC_CONTEXT_NUMBER_FIELD_SPECS` / `buildMagicContextUsageRows`（这些确有包外或 dist 消费者）。

- **验收/测试要点**
  1. 重跑 knip，`Unused exports` / `Unused exported types` 中**不再出现**这 4 条；magic-context 相关文件零命中。
  2. `pnpm typecheck`（desktop）全绿——去 export 后若有隐藏的跨文件类型引用会立刻暴露。
  3. 两套 `test-magic-context-*.mjs` 仍能 import dist 产物并跑通（它们只取函数，去 export 不影响）。

---

### review-ui-tui/J-01 · P2 · a11y：同文件内 3 个 Switch 有 `aria-label`，5 个输入类控件没有

- **文件**：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\MagicContextSettingsFields.tsx`（`:52-71` 的 `NumberField` Input、`:172-180` 的 cacheTtl Input、`:190-213` 的 ModelConfigSelect trigger）
- **维度**：J（UI 适用维度 / 可访问性）
- **描述**

回读确认：`MagicContextSettingsSection.tsx:214`（enabled）、`MagicContextSettingsFields.tsx:230`（smartDrops）、`:244`（failClosedBlocking）三个 Switch **都有** `aria-label={intl.formatMessage({ id: "...label" })}`。而同一分区内的 5 个输入类控件都没有：

| 控件 | 位置 | 可访问名称 |
|---|---|---|
| 4 个 NumberField 的 `<Input type="number">` | `Fields.tsx:52-71`（渲染）、`:105-165`（4 处使用） | ❌ 无 `aria-label`、无 `id` |
| cacheTtl 的 `<Input type="text">` | `Fields.tsx:172-180` | ❌ 无 `aria-label`（只有 placeholder） |
| historianModel 的 `ModelConfigSelect` trigger | `Fields.tsx:190-213` | ❌ 未传 `aria-label`（有可见 `triggerLabel`，但不是可访问名称绑定） |

根因在共用原语：`packages/ui/src/settings/SettingsPageParts.tsx:133` 把 label 渲染成 `<div className="text-ui-base font-medium text-foreground">{label}</div>`——**不是 `<label>`，也没有 `htmlFor`**（回读 `SettingsPageParts.tsx` 全文，`aria-label`/`htmlFor` 均为 0 命中）。所以 `SettingsRow` 无法给任何 detail 控件建立名称关联。

判定：**这不是 S29 引入的更差实践**（证据包 §5.3 已核实 `MemorySettingsSection.tsx` 全文仅 1 处 `aria-label`、`SubagentsSection.tsx` 3 处，整个设置页覆盖率本就不高），而是 S29 在同一文件内自相矛盾。修复成本低、不动共用原语，值得在本轮闭合。

- **具体改法**

只在本分区内补齐，不改 `SettingsRow`（改共用原语会波及全设置页，超出本 scope）：

```tsx
// MagicContextSettingsFields.tsx NumberField 的 props 增加 ariaLabel，Input 上：
aria-label={props.ariaLabel}
// 4 处调用点传 ariaLabel={intl.formatMessage({ id: "settings.context.executeThreshold.label" })}
//   / ...".executeThresholdTokens.label" / ...".protectedTokens.label" / ...".historyBudget.label"

// cacheTtl 的 Input（:172-180）补：
aria-label={intl.formatMessage({ id: "settings.context.cacheTtl.label" })}

// ModelConfigSelect（:190-213）补：
aria-label={intl.formatMessage({ id: "settings.context.historianModel.label" })}
```

顺带：`:195` 的 `lockReasonMessage=""` 是个空的可访问性文案槽位，确认 `ModelConfigSelect` 在空串时不会渲染出一个空的 `title`/提示节点。

- **验收/测试要点**
  1. 用读屏（或 devtools a11y 树）逐个聚焦 5 个控件，均能读出「执行阈值」「执行阈值（Token 覆盖）」「受保护 Token 下限」「历史预算占比」「前缀缓存有效期」。
  2. 3 个 Switch 的现有 `aria-label` 不回归。
  3. `pnpm typecheck`（desktop）全绿。

---

### review-ui-tui/C-04 · P2 · MIN-MAX 三处独立常量，i18n 文案里的数字无任何自动化校验

- **文件**：
  - 权威：`D:\Dev\Js\oh-my-zcode\omz\apps\zcode-cli\packages\magic-context\src\host\config\schema.ts:61`、`:159-161`、`:166-171`、`:177-178`
  - UI 常量：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\magicContextSettingsForm.ts:223-232`
  - 文案：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\i18n\locales\zh-CN.ts:2021`、`:2028`、`:2032`（en-US 对应 `:2150`、`:2157`、`:2161`）
- **维度**：C（单一真源）
- **描述**

同一组上下界写了三遍：zod 约束（权威）、`MAGIC_CONTEXT_NUMBER_FIELD_SPECS`（驱动 `min/max/step`）、i18n description 里硬写的数字（zh「取值 20–90」/「取值 4000–1000000」/「取值 0.05–0.5」，en「Range 20–90」等）。

已核实**当前 4/4 精确一致**（证据包 §3.3 的对照表我逐项复核成立）。风险在演进：`MAGIC_CONTEXT_NUMBER_FIELD_SPECS` 有测试锚点可挂（`test-magic-context-ui-config.mjs` 已覆盖 form 映射），文案里的数字**没有任何校验**。上游改 schema 上下界时，UI 输入框会跟着变，而 description 里的「取值 20–90」会静默过期——这是 spec L1 同步改动的典型漏点，且是**用户可见的错误信息**（比过期注释严重）。

- **具体改法**

二选一，推荐第 1 种：

1. **把数字从文案里拿掉**（推荐）：description 改为不含具体区间（「上下文占用达到该百分比时，强制执行已排队的上下文操作。越高越晚执行，留给输出与突发增长的空间越小。」），区间只由输入框的 `min/max` 与浏览器原生校验体现。这样三处降为两处，且剩下的两处一个是权威、一个是有测试锚点的复述。
2. **加一条测试断言文案与常量一致**：在 `test-magic-context-ui-config.mjs` 里 import `MAGIC_CONTEXT_NUMBER_FIELD_SPECS`，断言 locale 文件的 description 含 `${spec.min}–${spec.max}`。可行但脆弱（文案措辞一变就红）。

注意：若走方案 1，i18n 的 30 键 parity 不受影响（只改 value 不改 key）。

- **验收/测试要点**
  1. 改后 `zh-CN.ts` / `en-US.ts` 的三条 description 不再含硬写区间。
  2. `settings.context.*` 仍是 zh/en 各 30 键、差集为空。
  3. 走方案 2 时，测试能实际拦住一次人为改动（改 `MAGIC_CONTEXT_NUMBER_FIELD_SPECS` 的 max，测试必须红）。

---

### review-ui-tui/A-02 · P2 · `placeholder="5m"` 绕过 i18n，且与 description 已有文案重复

- **文件**：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\settings\MagicContextSettingsFields.tsx:175`
- **维度**：A（i18n 一致性）
- **描述**

cacheTtl 输入框的 `placeholder="5m"` 是用户可见文案却走硬编码，而同文件另外两个 placeholder（`:125-127` 的 executeThresholdTokens、`:140` 的 protectedTokens）都走了 `intl.formatMessage`。更关键的是它与 description 里的已有说明重复：`zh-CN.ts:2034-2035` 已经是「假定服务端前缀缓存仍然有效的时长，例如 5m、1h；填 never 表示不做有效期假设。」——placeholder 再写一遍 `5m` 没有增加信息量。

（注：schema `:184` 对 `cache_ttl` 只有 `z.union([z.string(), ...])`，**无任何格式校验**，`"5m"/"1h"/"never"` 只是约定；所以这里的示例文案是用户唯一的格式指引，不能删。）

- **具体改法**

保留示例信息但走 i18n：新增 `settings.context.cacheTtl.placeholder` 键（zh `"5m"` / en `"5m"`——值本身语言中性，走 i18n 是为了将来 locale 想换成 `"例：5m"` / `"e.g. 5m"` 时不必改代码），`Fields.tsx:175` 改为
`placeholder={intl.formatMessage({ id: "settings.context.cacheTtl.placeholder" })}`。

或者更彻底：既然 description 已含「例如 5m、1h」，直接删掉 placeholder。

- **验收/测试要点**
  1. `git grep -n 'placeholder="5m"'` → 0 命中。
  2. `settings.context.*` 键数由 30 变 31，zh/en 仍齐备、差集为空。
  3. 输入框仍能看出该填什么格式。

---

### review-ui-tui/C-05 · P2 · 面板把 SQLite 列名 `m[0]` / `m[1]` 直接呈现给用户

- **文件**：`D:\Dev\Js\oh-my-zcode\omz\packages\ui\src\chat-input-toolbar\magicContextUsageRows.ts:104-109`（另见 `:32` 的 `UNKNOWN = "—"`）
- **维度**：C（用户可见表达）/ J（UI 适用）
- **描述**

`cache` 行的值是模板拼出来的字符串：

```ts
:107  `m[0] ${cache.m0 ? labels.cacheHit : labels.cacheMiss} · m[1] ${
:108    cache.m1 ? labels.cacheHit : labels.cacheMiss
:109  }`
```

`m[0]` / `m[1]` 是宿主侧 SQLite BLOB 列名（`magic-context-usage-summary.ts:104-109` 的 `isCachedBlock`），**直接漏到了最终用户的界面上**，且与同一行的其它 4 个标签风格完全不一致（其余 4 行都是「标签 · 值」的自然语言）。用户看到「m[0] 命中 · m[1] 重建」无从理解 m 是什么。

同时 `:32` 的 `UNKNOWN = "—"` 是硬编码符号，未走 i18n——这一点影响小（破折号是语言中性的），但既然本文件的设计前提是「模块本身不引 i18n，labels 全部由调用方注入」（`:35`），把「不知道」的呈现符号也交给调用方更自洽。列为同条的次要项。

- **具体改法**

把 `m[0]` / `m[1]` 换成可读的标签，或直接把前缀去掉。最小改法是让 cache 行只输出状态词：

```ts
// magicContextUsageRows.ts:104-109
value:
  cache === null
    ? UNKNOWN
    : `${cache.m0 ? labels.cacheHit : labels.cacheMiss} · ${cache.m1 ? labels.cacheHit : labels.cacheMiss}`,
```

若要保留「第几段缓存块」的可辨识度，则在 `chat.contextUsage.magicContext.*` 下补两条键（如 `block0` / `block1`）并注入 `labels`，由 locale 决定措辞（zh「第 1 段」/ en「block 1」）。

`UNKNOWN` 可选处理：移入 `MagicContextUsageRowInput` 作为 `unknownValue: string`，由 `contextUsage.tsx` 用一个 locale 值注入。

- **验收/测试要点**
  1. 面板渲染文本中不再出现字面量 `m[0]` / `m[1]`。
  2. 命中/未命中两种组合的文案仍可区分（现有投影测试 `test-magic-context-usage-projection.mjs:303` 传 `LABELS` 常量，需同步断言新的 value 形态）。
  3. `cache === null` 时仍输出「不知道」而非「都没命中」——这是该文件 `:56` 声明的核心语义，不得回归。

---

## 对证据包的订正（回读复核后）

证据包的价值在于摆事实，以下 4 条经 `file:line` 回读后**不成立或归因有误**，不进入 must-fix：

| 证据包条目 | 复核结论 | 依据 |
|---|---|---|
| §5.8「`labels` 7 字段与 `MAGIC_CONTEXT_ROW_LABEL_IDS` 靠字段名隐式配对，**无类型层面的编译期约束保证不漏项**」 | **驳回** | `contextUsage.tsx:829-838` 的 `labels` 是对象字面量，被 `MagicContextUsageRowInput`（`magicContextUsageRows.ts:34-44`，7 个必填字段）**上下文类型化**——缺一项、多一项都是 TS 编译错误；`MAGIC_CONTEXT_ROW_LABEL_IDS`（`:160`）是 `as const`，删键同样是 TS 错误。两端都有编译期约束 |
| §5.5「两个必填数字字段的 `if (value !== null)` 守卫使**清空输入框不生效**」 | **对 decimal 字段不成立**，已升级为 C-02（P1） | `Fields.tsx:63-70` 的 decimal 分支不走 `parseOptionalNumber`，`Number("") === 0` finite → 守卫放行 → 写入越下界的 `0` |
| §5.5「服务端只给一句粗粒度错误文案，用户拿不到字段名」 | **归因错误**，已改为 C-03（P2） | `magic-context-config.ts:124-128` 的 `-32602` 消息经 `formatIssues`（`:171-175`）已含 `字段路径: 约束`；`zcodeAgentService.ts:3782` 注释明写「原样上抛」。是 UI 在 `MagicContextSettingsSection.tsx:142-148` 主动丢弃 |
| §5.11「产品名 `ZCode` 在 zh-CN locale 内**约 25 处**」 | **计数错误** | `git grep -c ZCode`：zh-CN.ts **95** 行、en-US.ts **97** 行。该计数不能作为裁决依据（结论本身另见 OQ-1，结论不变但依据要换） |

**证据包成立、本轮采信的关键事实**（复核通过）：

- S27 删除完整性：`app-compact-timeline` 整删、`getContextCompressionCommand`/`onSendCompressionCommand`/`compressionDisabled` 零残留、4 个 prop 声明/解构/透传/deps 四处同步摘除——均已回读确认。
- zh/en 键集双向差集：en-only = 1（`settings.memory.viewer.disabled`）、zh-only = 0，且该 en-only 键在 BASE `1fa2d0e:en-US.ts:2146` 即存在（背景已拍板，不重复列）。
- S29 新增 38 键（`settings.context.*` 30 + `chat.contextUsage.magicContext.*` 8）双语齐备、差集为空。
- S30 三重保障已逐行回读确认成立：保障 A `magicContextUsageRows.ts:64-66` 返回 `[]`；保障 B `contextUsage.tsx:1018` 条件渲染（带 `data-testid` + `aria-label`，上边框条件化）；保障 C `contextUsage.tsx:845-852` 早返回纳入 `magicContextRows.length === 0`。且 `useMemo`（`:827-843`）在早返回之前，**无 hook 顺序违规**。
- `seedUsage` 不 clobber 修复两处 spread 均在位；S32 的 4 条 `/ctx-*` 双语落点位置对齐、参数签名一致。

---

## open_questions

### OQ-1 · `.zcodeignore` 与产品名 `ZCode` 文案：均**不属 L1 遗漏**，但需产品侧单独决策

背景要求我裁决「属 L1 遗漏还是 L2/L3 范围」。**我的裁决：两者都不属 L1，也不属 L2/L3——它们落在 D-10 分层之外，属未分配范围，因此不是本 scope 的 must-fix。**

依据三条：

1. **L1 是封闭清单，产品名文案不在其中。** spec:46 的 L1 枚举为「bin 名、npm name、README、数据目录、marketplace id、安装产物名」，spec:243 复述同清单。产品可见文案不在任一项，L2（`ZCODE_*` env / `@zcode/*` scope / `.zcode-plugin/`）与 L3（协议标识 / DB schema / 类型名）也都不含。spec-check 纪律下，未在枚举内的项不能在 review 阶段被追认为「遗漏」——那等于在评审期扩范围。
2. **README 自身已经把两者区分开了。** `README.md:1/:16` 以「oh-my-zcode」为产品名，但 `:156-159` 明写桌面产物仍叫 `ZCode.app`（macOS 安装步骤「将 ZCode 拖入"应用程序"」）。也就是说 **CLI 发行物改名了，桌面 app 没改名**。桌面 locale 里说「ZCode」与实际打不开的 app 同名，是自洽的，不是遗留缺陷。
3. **改动的代价与收益不成比例，且与 D-10 的设计意图相反。** D-10 分层的理由（spec:46）是「L2/L3 是内部标识符，改动面 2836 文件且**徒增上游同步冲突**」。locale value 批量改写会制造同等量级的上游合并冲突，换来零功能收益。`.zcodeignore` 更棘手：它不是内部标识符而是**用户磁盘上的既有文件名**，改名会静默失效所有存量用户的 ignore 规则，且 spec 对数据目录改名专门写了「新起 + 首启提示，不自动迁移」的处理，对 `.zcodeignore` 没有任何决策。

**需要产品/协调者回答的是**：是否要为「桌面端产品可见品牌」单独立项？若要，最小安全形态是——(a) 桌面 app 产物一并改名并给 `.zcodeignore` 一条兼容读取策略；(b) 或明确写进 D-10 作为 L1 补充并接受上游同步成本。在拍板前，本节点不动这两处。

### OQ-2 · spec:235 指定的两个复用件一个失效、一个不适用

- `runSettingsActionAsync`：spec 要求保存走它包裹。实测该函数在 `packages/ui/src/SettingsPage.tsx:112`，且**是本地函数（未导出）**，内容已被 Phase 1 遥测移除掏空成 `return options.operation()`（见 `:110-111` 注释「遥测链路移除后设置动作直接执行；保留本包装以免改动全部调用点的对象字面量形状」）。`MagicContextSettingsSection` 既无法 import 也无需包裹。**spec 文本锚点已失效，不构成 must-fix。**
- `SettingsResourceGroup`：实测全仓只有 `SettingsResourceGroupHeader`（`CommandsSection` / `McpSettingsSection` / `SkillsSection` / `SubagentsSection` 用）与 `SettingsResourceList`（`McpServerList` 用），都是**资源列表的头部/容器**。magic-context 分区没有资源列表，强行渲染一个空组头比不复用更糟。实现改用 `SettingsGroupCard` + `SettingsFormActions`（后者**确有复用**，符合 spec 意图）。**不构成 must-fix。**

### OQ-3 · spec:236 的调用点形态未采用

spec:236 写「`packages/ui/src/hooks/useSettingService.ts` 或专用 hook：调用点接入新 JSON-RPC」。实现直接在组件内 `useEffect` + `useCallback` 调 `services.zcodeAgentService.readMagicContextConfig/updateMagicContextConfig`（`MagicContextSettingsSection.tsx:80-150`），没有抽 hook。功能等价（竞态版本号 `loadVersionRef` 也做了），但与 spec 字面不符。是抽 hook 更好还是组件内联更好，属设计取舍，交协调者判断。见 spec_deviations SD-3。

---

## spec_deviations

| id | spec 锚点 | 偏离内容 | 状态 |
|---|---|---|---|
| SD-1 | spec:225「i18n：压缩相关 key **全删**……所有引用处同步删净」 | 清单外的 3 条压缩相关 key（`chat.contextUsage.compress` / `.compressDescription` / `chat.queue.runNow`）未删，引用侧确已删净 → 违反的是「全删」主句 | **open**（= must-fix A-01，P2） |
| SD-2 | spec:237「i18n：新增 `settings.context.*` 文案（zh-CN/en-US）」 | 文案齐备但把 MIN-MAX 区间硬写进 value，形成 schema/常量/文案三处真相，其中文案侧无校验 | **open**（= must-fix C-04，P2） |
| SD-3 | spec:236「`useSettingService.ts` 或专用 hook：调用点接入新 JSON-RPC」 | 实现内联在组件的 `useEffect`/`useCallback`，未抽 hook | **open**（无功能影响，见 OQ-3） |
| SD-4 | spec:235「复用 `SettingsResourceGroup`/`SettingsFormActions`；保存走 `runSettingsActionAsync` 包裹」 | `SettingsFormActions` 已复用；`SettingsResourceGroup` 不适用（无资源列表）；`runSettingsActionAsync` 已被遥测移除掏空且未导出，spec 锚点失效 | **fixed（非缺陷）**——见 OQ-2，建议由协调者在 spec 里把这两条锚点标注为失效 |
| SD-5 | spec:234 `settingsPageConfig.ts` 新增分区 + `settingsNavigation.ts` 的 `SettingsSectionId` 联合与 `isSettingsSectionEnabled` 白名单同步 | 三处全部按 spec 落地（`settingsPageConfig.ts:83-90`、`settingsNavigation.ts:22-23` 与 `:82`），`groupId:"agentCapabilities"` 与 spec 一致 | **fixed（符合）** |
| SD-6 | spec:235 字段集（enabled / 执行阈值 percentage + tokens / protected_tokens / history_budget_percentage / cache_ttl / historian 模型 / smart_drops / fail_closed_blocking） | 首版 10 个字段全部落地，`DEFAULT_FORM`（`MagicContextSettingsSection.tsx:44-54`）逐项与 schema `.default()` 核对一致 | **fixed（符合）** |
| SD-7 | spec:239 D-13 用量显示（预算总量/已用/compartments/dropped/cache 命中） | `magicContextUsageRows.ts:76-111` 5 行全覆盖；`autoCompactThresholdTokens` 已随 S27 删除，无残留引用 | **fixed（符合）** |

---

## 结论

**scope-ready: no**

理由：9 条 must-fix 未修，其中 **2 条 P1**：

- **C-01（P1）** 是本轮唯一的**数据损坏级**问题：合法的 per-model `execute_threshold_tokens` 配置会被 UI 保存静默删除，且「挂载即 dirty」把误触门槛降到零。它同时违反 `magicContextSettingsForm.ts:55` 自述的不变式，属于实现与自身声明不符，不是风格问题。
- **C-02（P1）** 是可稳定复现的错误输入路径：清空历史预算占比必写入越下界的 `0`，且必然触发一次服务端拒绝。

其余 7 条为 P2（i18n 清理残留、knip 口径、a11y 一致性、单一真源、SQLite 列名泄漏、硬编码占位符、可诊断性），均低风险、可在同一次 fix-spec 里一并闭合。

**本 scope 内无需外部依赖即可推进**：无一条 must-fix 需要跨节点决策。唯一需要协调者拍板的是 OQ-1（`.zcodeignore` / 产品名 `ZCode` 是否单独立项）——但它**不在本 scope 的 must-fix 内**，不阻塞 scope-ready 的收敛。

**建议 fix-spec 编排顺序**：C-01（独立、含回归测试）→ C-02 + C-03（同一缺陷的两半，宜同批）→ A-01 / G-01（机械清理）→ J-01 / C-04 / A-02 / C-05（质量项，可并行）。