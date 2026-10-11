# 证据包：exec 文件日志 vs db.sqlite 入库——截断常量、层级、先例与测试挂点

> 取证子代理产出（evidence only，不下结论、不改代码）。路径均相对 `D:\Dev\Js\oh-my-zcode\omz\`（除绝对路径注明外）。
> 事故现象复述：失控命令 stdout 在文件日志里 5.13GB，同一调用写入 db.sqlite 的记录只有约 338 字符。

## 0. 现场事实（先摆证据，再谈代码）

1. **文件日志路径**：`${toolCallId}-stdout.log`，根目录 `resolveDefaultOutputRootDir()` = `ZCODE_STORAGE_DIR` 或 `~/.omz` + `/cli/exec`，再拼 `<sessionId>/<toolCallId>-stdout.log`（`apps/zcode-cli/packages/adapters/src/exec/execution-utils.ts:18-21`；`apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-base.ts:94-116`，第 100 行）。本机运行态实际落在 `C:\Users\BloodyCrown\.zcode\cli\exec\<sessionId>\...`。
2. **5.13GB 文件已不在盘上**：只读扫描 `C:\Users\BloodyCrown\.zcode\cli\exec` 全部 session 目录，>500MB 文件 0 个（证据脚本走 `node:fs` 只读 stat，未改动任何文件）。无法直接对事故文件取指纹。
3. **live db.sqlite 只读取证**（`C:\Users\BloodyCrown\.zcode\cli\db\db.sqlite`，`node:sqlite` `readOnly:true`）：tool part 行最短 270 字符；`state.output` 为 background 通知的记录实测 **323 字符**（多条同型），模板见 §1.4。把更长的 session/call 路径代入即 ≈338。
4. background 通知原文样例（live db 实测）：
   ```
   Command running in background with ID: exec_36d306a8-2ff7-440d-b376-5a21027d2b23. Output is being written to: C:\Users\BloodyCrown\.zcode\cli\exec\sess_f3c2e4a3-4b11-4ac8-9b92-68a6ff5839fe\call_a5f2f160dc4a4d9abf8d0070-stdout.log. You will be notified when it completes. To check interim output, use Read on that file path.
   ```
5. **大输出 Bash 的正常入库形态**（live db 实测，4 条）是 `<persisted-output>` envelope，`state.output` 长 2180–2227 字符 = 固定信封（~180 字符，含完整文件路径）+ 2000 字符 preview + `...`。即「路径不截断、正文只留 preview」是既有设计。

## 1. 截断常量表（tool 输出进 sqlite 之前）

### 1.1 Bash / exec adapter 层（文件与 inline 的上限都在这层）

| 常量 | 值 | file:line | 作用 |
|---|---|---|---|
| `MAX_INLINE_OUTPUT_BYTES` | 30_000 | `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:62` | Bash inline/buffer 上限；同时作为 `outputLimit.maxInlineBytes` / `maxBufferBytes` 传入（`bash.ts:311-316`） |
| `MAX_RUNTIME_PERSISTED_OUTPUT_BYTES` | `5 * 1024 * 1024 * 1024`（5 GiB） | `bash.ts:63`（传入 `bash.ts:314` `outputLimit.maxPersistedBytes`） | **Bash 合并输出文件的软上限**（每 5s 轮询，超限杀进程树） |
| `BASH_RUNTIME_OUTPUT_LIMIT_BYTES` | 5 GiB | `apps/zcode-cli/packages/adapters/src/exec/execution-utils.ts:11` | adapter 兜底默认值；后台 lifecycle 同值（`node-execution-adapter-lifecycle.ts:129`） |
| `DEFAULT_MAX_PERSISTED_OUTPUT_BYTES` | 50 MiB | `execution-utils.ts:10` | 通用 pipe 执行每路写盘硬上限 |
| `DEFAULT_INLINE_OUTPUT_BYTES` | 10 MiB | `execution-utils.ts:8` | 通用执行 inline 默认 |
| `DEFAULT_BASH_MAX_OUTPUT_LENGTH` | 30_000 | `apps/zcode-cli/packages/adapters/src/exec/bash-output-policy.ts:1` | env `BASH_MAX_OUTPUT_LENGTH` 解析（`bash-output-policy.ts:4-19`） |
| `MAX_BASH_MAX_OUTPUT_LENGTH` | 150_000 | `bash-output-policy.ts:2` | 上述 env 的钳制上限 |
| 读回上限（匿名） | `bashInlineLimit(request)` | `node-execution-adapter-base.ts:127-129` + `node-execution-adapter-results.ts:38`（`file.result(this.bashInlineLimit(request))`，head 读） | 前台 Bash 结算时只读文件前 30KB 作为 `stdout.text` |

> 契约文档（中文注释即规格）：`apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts:115-133` ——「通用执行为每路写盘硬上限；Bash 为合并文件的软阈值，每 5 秒检查，严格超出后终止」「Bash 直写保留完整原始文件」「Bash 的文件软阈值在前后台都生效」。

### 1.2 tool executor 结果序列化层（决定进 db 的正文形状）

| 常量/配置 | 值 | file:line |
|---|---|---|
| `DEFAULT_RESULT_BUDGET` | `maxInlineBytes/maxModelBytes = 100_000`，`strategy: "truncate"` | `apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts:33-40` |
| Bash `resultBudget` | `maxInlineBytes=30_000`、`maxModelBytes=30_000`、`preview.maxBytes=30_000 direction:"tail"`、`strategy:"artifact"`、`artifact.enabled=true` | `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:369-381` |
| `MODEL_RESULT_PREVIEW_CHARS` | 2_000 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts:10` |
| `PERSISTED_OUTPUT_PREVIEW_CHARS` | 2_000 | `apps/zcode-cli/packages/core/src/tool/result-persistence-format.ts:5` |
| 截断后缀文案 | `[Tool output truncated by resultBudget: artifactPath=…, originalBytes=…, maxModelBytes=…, strategy=…]` | `result-serialization.ts:201` |
| envelope 模板 | `<persisted-output>\nOutput too large (<size>). Full output saved to: <path>\n\nPreview (first 2KB):\n<preview>\n…\n</persisted-output>` | `result-persistence-format.ts:29-42` |
| 通用序列化兜底 | 4000 + `...[truncated]` | `apps/zcode-cli/packages/core/src/tool/executor/utils.ts:22` |
| TaskOutput 一族 | `TASK_OUTPUT_DEFAULT_LENGTH=32_000`、`TASK_OUTPUT_MAX_LENGTH=160_000`、`TASK_OUTPUT_PERSIST_THRESHOLD_CHARS=100_000`（→ `maxModelChars`，`task-output.ts:85`）、`TASK_OUTPUT_RESULT_BUDGET_BYTES=400_000`、`TASK_OUTPUT_PERSIST_PREVIEW_CHARS=2_000` | `apps/zcode-cli/packages/core/src/tool/handlers/task-output.ts:29-33` |
| `TASK_NOTIFICATION_MAX_CHARS` | 120_000 | `apps/zcode-cli/packages/core/src/runtime-task/notification.ts:18`（截断在 `:381-382`） |
| display 侧上限（不进 db 正文，只进 metadata.display/事件） | `TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS=2_000` / `TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS` | `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts:19-20`，用于 `core/src/tool/executor/result-display.ts:144-162` |
| bash display 上限 | 150_000 bytes | `apps/zcode-cli/packages/core/src/tool/executor/bash-result-display.ts:16-19` |
| CUA display 上限 | 32 KB 文本/JSON、256 KB 单图、512 KB 图总量 | `result-display.ts:207-209` |

### 1.3 能对上「338 字符」的东西

- **不是**「截断 + 前后缀提示」格式，而是 **background 固定通知文案**（stdout 全在文件里，db 只存通知 + 路径）：
  - `Command running in background with ID: <id>. Output is being written to: <path>. You will be notified when it completes. To check interim output, use Read on that file path.` —— `bash-model-content.ts:131`（`formatBackgroundInfoForModel`）+ `:142`（`formatBackgroundOutputPaths` 拼 ` Output is being written to: ${outputPath}.`）。
  - assistant 自动转后台的长文案（15s blocking budget，`ASSISTANT_BLOCKING_BUDGET_MS = 15_000`，`bash-model-content.ts:11,123`）。
  - live db 实测同型记录 323 字符；本机 session/call 路径更长时 ≈338，量级吻合。
- 次可能形态：`<persisted-output>` envelope 去掉 preview 只剩信封（~180 字符）；带 preview 的完整 envelope 实测 2180–2227 字符（对不上 338）。
- 结论性事实（供写文档时引用）：**db 侧不存在针对 part 输出的长度截断代码**；入库小是上游投影的结果（§2）。

## 2. 截断发生在哪一层

入库链路（自底向上）：

```
turn-tools.ts:301-315   state.output = content（content = stringifyToolResultOutput(result)，turn-tools.ts:282）
  → core/src/runtime/methods/message-persistence.ts:354  persistPart()   ← 无任何截断，仅 debug 日志
    → adapters/src/storage/session-store/repositories/messages.ts:113  savePart()
      → insert into part (... data=encodeJson(...))   ← 无任何截断；on conflict 只做 legacy 字段保留
```

- **sqlite adapter（messages.ts）无截断**：`encodeJson` 原样序列化；`part` 表无长度约束。
- 所有截断/投影都发生在两层：
  1. **tool executor 结果序列化**（`core/src/tool/executor/result-serialization.ts:46-218` `serializeOutput`）：`maxModelChars` / `resultBudget` → `strategy:"artifact"` 时写 artifact 并把 `modelContent` 换成 envelope preview；`strategy:"truncate"` 时 `fitContentWithSuffix` + 截断后缀。
  2. **exec adapter 采集层**（`core/../adapters/src/exec/*`）：`OutputCollector.append` inline 30KB 封顶（`output-collector.ts:51-78`）；Bash 合并输出由子进程直写文件、结算时 head 读 30KB（`node-execution-adapter-results.ts:31-56`）。
- 对「文件日志加上限应该抄哪套」的直接含义：可抄模式在 **adapters/exec 层**（§3），db 侧没有对应物。

## 3. 仓内「文件写入加上限」现成先例（可复用）

| # | 先例 | file:line | 机制 |
|---|---|---|---|
| 1 | `OutputCollector.writePersisted` | `apps/zcode-cli/packages/adapters/src/exec/output-collector.ts:140-173` | 每路 `maxPersistedBytes` 硬上限 + `aggregatePersistedBudget`（stdout/stderr 共享预算）+ 触限置 `artifactTruncated` + `onPersistedLimit` 回调 + 背压（`source.pause()` / `drain` 后 resume） |
| 2 | `BashFileOutput.watchLimit` | `apps/zcode-cli/packages/adapters/src/exec/bash-file-output.ts:65-87` | `setInterval` 5s（`OUTPUT_WATCH_INTERVAL_MS`，`:9`）`stat` 文件，`file.size > maxBytes` → `onLimit()`；挂载点 `node-execution-adapter-run.ts:243-250`（前台 + `onBackgrounded` 重挂） |
| 3 | 触限杀进程的收尾文案 | `node-execution-adapter-run.ts:341-342`（`"Command killed: output file exceeded 5GB"`）；后台版 `node-execution-adapter-results.ts:163-179`（`"Background command killed: output file exceeded 5GB"`，status→cancelled、exitCode 137） | `requestStop("output_limit")` → `StopReason: "output_limit"` |
| 4 | `capForegroundArtifactStream` | `node-execution-adapter-results.ts:137-161` | 结算时 `handle.truncate(maxBytes)` 物理截断 artifact 文件 + 标 `artifactTruncated`（Bash 直写**不走**这条，注释 `:104`、契约 `execution.port.ts:126-127`） |
| 5 | `readBashOutput` | `bash-file-output.ts:153-183` | 有界读：`length = min(size, maxBytes)`，head/tail 两种，`truncated: size > bytesRead`，`artifactPath` 原样带回 |
| 6 | magic-context logger 写盘上限 | `apps/zcode-cli/packages/magic-context/src/core/shared/logger.ts:22`（`MAX_LOG_FILE_BYTES = 32MB`）、`:95-112`、`:164` | 单次写入与文件增长的 32MB 钳制 |
| 7 | runner-debug 会话预算 | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts:39`（`MAX_DEBUG_SESSION_BYTES = 256MB`） | 调试会话总字节预算 |
| 8 | zip 解压单文件上限 | `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts:15`（`ZIP_EXTRACT_MAX_BYTES = 500MB`，另有 `:17` `ZIP_MAX_SINGLE_FILE_BYTES = 50MB`） | 解压写盘上限 |

## 4. 既有测试挂点与用例风格

### 4.1 现状：无覆盖

全仓（`omz/apps/zcode-cli/packages`）搜索 `resultBudget|serializeOutput|ToolExecutor|executeTools|OutputCollector|BashFileOutput|writeToolResultArtifact|tool-executor` 的测试文件：**0 个相关**（唯一命中的 `magic-context/scripts/test-historian.mjs` 指 hidden-completion executor，与本题无关）。即 tool executor / bash / exec adapter / output-collector / part 持久化**均无既有测试**。

### 4.2 仓内四种测试范式（挂新用例的落点）

| 范式 | 样例 | 运行方式 | package.json script |
|---|---|---|---|
| A. `node --test` + dist resolve 钩子（需先 build） | `apps/zcode-cli/packages/core/scripts/test-prompt-language-context.mjs` | `node --test scripts/test-prompt-language-context.mjs` | core: `test:prompt-language-context` |
| B. `tsx --test` 直吃 `src/*.ts`（免 build） | `apps/zcode-cli/packages/bootstrap/scripts/test-turn-directory.mjs` | `tsx --test scripts/test-turn-directory.mjs` | bootstrap: `test:turn-directory` |
| C. `node --import tsx --test test/*.test.ts` | `apps/zcode-cli/packages/cli/test/provider-runtime-env.test.ts` | `node --import tsx --test test/provider-runtime-env.test.ts` | cli: `test:provider-runtime-env` |
| D. `node scripts/test-*.mjs` 自建断言壳 | `magic-context/scripts/test-host.mjs` 等 | `node scripts/test-*.mjs` | 各包 `test:*` |

- `tsx` 是 monorepo root devDependency（`omz/package.json`）；范式 B 的文件头（`test-turn-directory.mjs:33-37`）明确解释了为什么必须 tsx（`@zcode/shared` 等 `exports` 直指 `src/*.ts`，裸 node 加载不了）。
- **推荐挂点**：`apps/zcode-cli/packages/adapters/scripts/test-bash-output-limit.mjs`（被测单元 `OutputCollector` / `BashFileOutput` / `readBashOutput` / `watchLimit` 全在 `adapters/src/exec`，纯 fs + Buffer，不依赖 db/model；adapters 包已有 `scripts/test-*.mjs` 惯例，`package.json` 已有 `test:magic-context-domain` 等 script 可类推新增）。db 投影侧用例（`serializeOutput` / `formatBashModelContent` / `persistPart` 无截断）可另放 `packages/core/scripts/test-tool-output-projection.mjs`（范式 A）。

### 4.3 相邻用例风格片段（`bootstrap/scripts/test-turn-directory.mjs` 的 B1）

```js
test("B1: 只有 origin==='realUser' 的 userInput 成条，其余系统来源一律排除", () => {
  const rows = [];
  const origins = [
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ];
  origins.forEach((origin, index) => {
    const turnId = `t-${origin}`;
    rows.push(header(turnId, "completedSuccess", index * 10 + 1));
    rows.push(query(turnId, `text-${origin}`, origin, index * 10 + 2));
  });
  // 非 userInput 的行即便 text 长得像 query，也不得成条。
  rows.push(assistantText("t-assistant", "一段正文", 100));

  const result = withRows(rows).getTurnDirectory({});
  assert.deepEqual(
    result.entries.map((entry) => entry.queryPreview),
    ["text-realUser"],
  );
  assert.equal(result.realUserQueryTotal, 1);
});
```

风格要点：`import assert from "node:assert/strict"; import test from "node:test";`；被测源码用 `await import(new URL("../src/....ts", import.meta.url).href)` 直接加载 TS 源；测试名带编号前缀（A1/B1/C1）与中文断言消息。

### 4.4 造数提示（写用例时会用到）

- `OutputCollector` 不需要 spawn 子进程：构造时传 `outputPath`（tmpdir 下真实路径，`ensurePersistedStream` 会 `mkdirSync(recursive)` + `createWriteStream(flags:"w")`），直接 `append(Buffer)` → `close()` → `result()` 断言 `text/bytes/truncated/artifactPath/artifactBytes/artifactTruncated`。
- 关键可断言面：触限后 `artifactTruncated=true` 且文件实际字节 == `maxPersistedBytes`（`output-collector.ts:151-166`）；`persistOutput:"on_truncate"` 时只有 inline 超限才开始落盘（`:51-57`）。
- `BashFileOutput` 需要真实文件：`prepare()` 后用 `open(path,"w")` 写入超限字节，`watchLimit(maxBytes, cb)` 的轮询间隔 5s（`bash-file-output.ts:84`）——同步断言要注入/缩短间隔或直接对 `readBashOutput` 的有界读 + `truncated` 断言。
- 只读取证 live db 的查询范式见本仓临时脚本手法：`new DatabaseSync(path,{readOnly:true})` + `json_extract(data,'$.state.output')`。

## 5. 写⑥章节需要的最小事实清单

1. **入口**：新测试文件 `apps/zcode-cli/packages/adapters/scripts/test-bash-output-limit.mjs`（建议名），并在 `apps/zcode-cli/packages/adapters/package.json` 的 `scripts` 增加 `test:bash-output-limit`（照 `test:magic-context-domain` 的写法）。
2. **运行命令**：`node --test scripts/test-bash-output-limit.mjs` 或 `pnpm --dir apps/zcode-cli/packages/adapters run test:bash-output-limit`（若需直吃 TS 源则用 `tsx --test`，tsx 在 root devDeps）。
3. **被测签名**：
   - `new OutputCollector({ maxInlineBytes, maxPersistedBytes, legacyOutputEncoding, maxTailBytes, onPersistedLimit?, outputPath?, persistOutput: "none"|"on_truncate"|"always", aggregatePersistedBudget? })`；`append(chunk, source?)` / `close()` / `result(): ExecutionStreamResult` / `tailText()`。
   - `new BashFileOutput(path, platform, legacyEncoding)`；`prepare()` / `watchLimit(maxBytes, onLimit)` / `stopWatching()` / `result(maxBytes)`；`readBashOutput(path, maxBytes, tail, legacyEncoding)`。
4. **常量默认值**（断言基准）：inline 30_000（`bash.ts:62`）、persisted 5 GiB（`bash.ts:63` / `execution-utils.ts:11`）、env 钳制 150_000（`bash-output-policy.ts:2`）、预览 2_000 chars（`bash-model-content.ts:10` / `result-persistence-format.ts:5`）、默认 budget 100_000（`result-serialization.ts:33-40`）。
5. **入库契约**：`state.output = stringifyToolResultOutput(result)`（`core/src/runtime/methods/turn-tools.ts:282`，写入 `:301-315`）；`persistPart`（`core/src/runtime/methods/message-persistence.ts:354`）与 `savePart`（`adapters/src/storage/session-store/repositories/messages.ts:113-182`）**均无截断**——「db 入库截断」若作为论点需要改写成「上游投影」，否则与代码不符。
6. **实测证据**：live db（`C:\Users\BloodyCrown\.zcode\cli\db\db.sqlite`，只读）background 通知 323 字符；envelope 记录 2180–2227 字符；tool part 最短行 270 字符（running 态，无 output）。
7. **外部依赖**：Windows + cmd；tmpdir 走 `os.tmpdir()`；断言只用 `node:assert/strict` + `node:test`；不引入新依赖。
8. **边界事实**（防误测）：Bash 合并输出由子进程**直写文件不过 collector**（`node-execution-adapter-run.ts:74-80`，`stdout/stderr` collector 为 `undefined`），collector 的硬上限路径只覆盖通用 pipe 执行；Bash 只有 5s 轮询软上限（`bash-file-output.ts:65-87`）。5.13GB < 5 GiB(5.368GB) 时软上限不触发——「5.13GB 无上限」的观感与两个常量直接相关，写⑥时这是核心待验证命题。
