# 证据包：前台工具执行链路 exec stdout/stderr 落盘写入点（omz）

- 取证范围：**前台工具执行链路**（Bash 工具 → execution adapter → `cli/exec` 落盘）。不涉及子代理 transcript、模型 rollout debug 等其他落盘。
- 仓库根：`D:\Dev\Js\oh-my-zcode\omz`（pnpm monorepo）。本文件只作证据记录，未修改任何源码。
- 事故对应：宿主 `~/.zcode/cli/exec/` 单文件 5.13GB、5 次共 25.7GB；omz 同源 fork，自有数据目录 `~/.omz`，落盘代码为同一实现（见 §1.4）。

---

## 1. 写入点地图

### 1.1 根目录与命名构造（唯一事实源）

`apps/zcode-cli/packages/adapters/src/exec/execution-utils.ts:18-21`

```ts
export function resolveDefaultOutputRootDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  const storageRoot = processEnv.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".omz");
  return join(storageRoot, "cli", "exec");
}
```

`apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-base.ts:86-117`（`outputPathsForRequest`）：

```ts
const rootDir = this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
const toolCallId = sanitizePathSegment(String(request.trace?.attributes?.toolCallId ?? crypto.randomUUID()));
const stdoutPersistedOutputPath = join(rootDir, sessionId, `${toolCallId}-stdout.log`);
// bash merged 输出时 stderr 并入同一文件；否则另有 `${toolCallId}-stderr.log`
```

`sanitizePathSegment`（execution-utils.ts:41-43）：`[^a-zA-Z0-9._-]` → `_`，截断 120 字符。事故文件名形如 `sess_subagent_…/call_082fce20eec7452e935d35e5-stdout.log`，与规则完全吻合（sessionId/toolCallId 原样保留）。

### 1.2 写入者 A —— BashFileOutput（事故路径，子进程 stdio 直写 fd）

代码位置：`apps/zcode-cli/packages/adapters/src/exec/bash-file-output.ts`

- 类注释（第 13 行）：「Bash 只持有文件身份和观察器；原始输出由子进程写入，不经过 Node collector。」
- `prepare()`（32-47 行）：`mkdir(dirname)` 后 `open(path, flags, 0o600)`；**Windows 用 `"w"`**（注释：MSYS 判 append-only 句柄为只读），POSIX 用 `O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW`。
- `watchLimit(maxBytes, onLimit)`（65-87 行）：`setInterval(... OUTPUT_WATCH_INTERVAL_MS=5000)` → `stat(path).size > maxBytes` → `onLimit()`（杀进程）。**这是唯一的上限执行手段。**
- `discard()`（56-63 行）：仅当本 adapter 创建的文件且 pre-spawn 取消/出错时删除。

挂载点：`apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts`

```ts
// run.ts:32
const useBashMergedOutput = isBashMergedOutputRequest(request);        // execution-utils.ts:36-38: mode==="shell" && shellProfile==="posix-bash"
// run.ts:74-80
const file = useBashMergedOutput
  ? new BashFileOutput(this.outputPathForRequest(request, "stdout")!, this.platform, legacyOutputEncoding)
  : undefined;
// run.ts:197-201  spawnOptions.stdio = [stdin?"pipe":"ignore", file.fd!, file.fd!]  ← 子进程 stdout+stderr 直接写同一 fd，无 JS 层介入
// run.ts:243-246  watchBashLimit(): file.watchLimit(this.persistedOutputLimit(request), () => requestStop("output_limit"))
```

即 **Bash 工具的每条命令** = 文件从头（`"w"` 截断）创建，子进程全程向 fd 流式直写；stdout、stderr 合并进同一个 `-stdout.log`（非 merged 场景才有独立 `-stderr.log`）。

### 1.3 写入者 B —— OutputCollector（pipe 收集器，非 bash-merged 的通用执行路径）

代码位置：`apps/zcode-cli/packages/adapters/src/exec/output-collector.ts`

```ts
// ensurePersistedStream() 120-128 行
mkdirSync(dirname(this.outputPath), { recursive: true });
this.stream = createWriteStream(this.outputPath, { flags: "w" });
// writePersisted() 140-173 行：剩余预算 = min(单流 maxPersistedBytes, aggregatePersistedBudget)；
// remaining<=0 → artifactTruncated=true 停止再写；有背压：
const canContinue = this.stream.write(persistedChunk);
if (!canContinue && source) { source.pause(); this.stream.once("drain", () => source.resume()); }
```

挂载：`node-execution-adapter-process.ts:207-231` `attachPipedOutput` 对 `child.stdout/stderr` 的 `"data"` 事件逐 chunk `collector.append()`；`node-execution-adapter-base.ts:55-74` `createOutputCollector` 注入 `maxPersistedBytes`。

注意「通用 pipe 执行仍在写盘前限制单路和共享预算；**Bash 文件软阈值不经过这里**」（output-collector.ts:145 行注释）——即 BashFileOutput 路径不享有 writePersisted 的预算硬截断，只有 5s 轮询杀进程。

调用链上层（谁创建 adapter / 谁发请求）：

| 环节 | 文件:行 | 事实 |
|---|---|---|
| 组装 executionPort | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:434-445` | `createNodeExecutionAdapter({ outputRootDir: join(storageRoot, "cli", "exec"), processEnv })` |
| 其它同款注入 | `bootstrap/src/app/workflow-facade.ts:298-305`、`script-workflow-child-runtime.ts:188-195`（均 `join(deps.storageRoot,"cli","exec")`） |
| Bash tool handler | `core/src/tool/handlers/bash.ts:96-160`（`executeBashHandler`） | `executionPort.run(request, runOptions)` 或 `runBashWithBackgroundLifecycle(request, {mode:"explicit"\|"auto_on_timeout"})` |
| 请求构造 | `core/src/tool/handlers/bash.ts:277-333`（`createExecutionRequest`） | `command: { mode:"shell", shellProfile:"posix-bash" }`；`outputLimit: { maxInlineBytes: 30_000, maxBufferBytes: 30_000, maxPersistedBytes: 5GB, persistOutput: run_in_background ? "always" : "on_truncate" }` |
| 适配器实现链 | `adapters/src/exec/node-execution-adapter.ts`（`NodeExecutionAdapter extends NodeExecutionAdapterLifecycle`） |
| auto-on-timeout 准入 | `core/src/tool/handlers/bash-background-policy.ts`（`isBashAutoBackgroundEligible`） | 超时后前台自动转后台（mode `auto_on_timeout`），文件继续追加 |

Hooks（`core/src/hooks/configured-runner-callback.ts:47-51, 92-96`）对 executionPort 的 `persistOutput` 恒为 `"none"` → 不产生 `cli/exec` 文件（非 omz 写入点，排除）。

### 1.4 仓内外区分

- **仓内（omz 源码，唯一真实写入者）**：`apps/zcode-cli/packages/adapters/src/exec/` 下 3 个文件：`execution-utils.ts`（路径）、`node-execution-adapter-base.ts`（路径+预算）、`bash-file-output.ts` + `output-collector.ts`（两个写入者）。上层调用链见 §1.3 表。
- **bundled CLI（`packages/desktop/bundled-agents/win32-x64/glm/zcode.cjs`，15.9MB）**：grep 证实内含**同一实现**（压缩变量名）：`aTe`=resolveDefaultOutputRootDir（`ZCODE_STORAGE_DIR || homedir()/.omz` → `join(t,"cli","exec")`）、`…${toolCallId}-stdout.log`、`create-app` 处 `outputRootDir: join(storageRoot,"cli","exec")`。它是 omz 自己的 CLI bundle，不是额外写入者。
- **mock-cdn 上游 bundle**：`packages/desktop/mock-cdn/releases/{1.0.0,3.14.3}/server/zcode-server.cjs` 中的 `"cli/exec"` 仅为 `storageCatalog.ts` 的 `PREFIX_RULES.toolOutputs` 分类清单（非写入）。
- **宿主 ZCode 客户端（仓外）**：`~/.zcode/cli/exec` 的实际写者在 ZCode 客户端仓库，本仓不可见；但 omz 源码与 bundled CLI 证明其机制与本文档一致（同源 fork）。后续写修复方案时应按同源处理。

### 1.5 非本链路的相邻落盘（排除用，勿混淆）

- `core/src/subagent/runner.ts:808-815, 859-864`：subagent `output.txt`/`task.output`/`metadata.json` → `subagentOutputRootDir`，默认 `join(cliStorageRoot, "agents")`（create-app.ts:298，即 `~/.omz/cli/agents`）。
- `adapters/src/model/runner-debug.ts`：`cli/debug|rollout`（`rotateModelIOFiles` 轮转，与本链路无关）。
- `services/src/storage/domain/storageCatalog.ts`：仅分类/清理策略定义（见 §4「清理」）。

---

## 2. 防护现状（截断/轮转/背压/预算）

### 2.1 BashFileOutput 路径（事故路径）——防护清单

| 防护 | 有/无 | 证据 |
|---|---|---|
| 写时单 chunk 截断 | **无** | 子进程 → fd 直写，Node 侧不过数据 |
| 5GB 上限 | 有（软） | `BASH_RUNTIME_OUTPUT_LIMIT_BYTES = 5*1024*1024*1024`（execution-utils.ts:12）；`watchLimit` bash-file-output.ts:65-87 |
| 上限检测粒度 | 每 5s `stat` 轮询 | `OUTPUT_WATCH_INTERVAL_MS = 5_000`（bash-file-output.ts:9）；`if (this.watchTimer !== timer \|\| file.size <= maxBytes) return; onLimit()` |
| 超限动作 | `requestStop("output_limit")` → 杀进程树 | run.ts:243-246、130-154；错误文案 run.ts:341-343：`"Command killed: output file exceeded 5GB"` |
| 超限后清理文件 | **无** | 文件保留全量（≈5GB+轮询间隔内的溢出）；5.13GB 与 5×1024³=5.37GB 上限一致（未达 5.37GiB 即被杀） |
| 流式背压 | **无**（不需要，也无 JS 层限速，内核直写) |
| 轮转/多文件 | **无** | 单工具调用单文件，无 rotate；exec 目录按 session 无限累积 |
| per-request 可关闭 | **无**（见 §4） |

### 2.2 OutputCollector 路径（通用 pipe 执行）——防护较全

- 预算：`maxPersistedBytes`（默认 `DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 50MB`，execution-utils.ts:10；bash merged 时被 `persistedOutputLimit()` 换成 5GB）+ 可选 `aggregatePersistedBudget`（stdout/stderr 共享，lifecycle.ts:255 `sharePersistedOutputLimitAcrossStreams: true`）。
- 硬截断：writePersisted 预算耗尽即 `artifactTruncated=true` 并停止写（output-collector.ts:146-166）。
- 背压：`stream.write()` 返回 false → `source.pause()`，drain 后 resume（output-collector.ts:168-172）。
- `close()`：`stream.end(resolve)`（等待 flush）。

---

## 3. 触发时机与文件命名

- **命名规则**：`<storageRoot>/cli/exec/<sessionId>/<toolCallId>-stdout.log`（merged）或再加 `<toolCallId>-stderr.log`。`sessionId = request.trace.sessionId`，`toolCallId = request.trace.attributes.toolCallId`（即工具调用 id，如 `call_082fce20…`）。
- **BashFileOutput（事故路径）**：`file.prepare()` 在 **spawn 之前** open 文件（win32 `"w"` 截断创建）→ 子进程运行期间由内核持续追加写（流式，不是命令结束后一次性写）→ child exit 后 `file.close()` 关闭 fd，文件留在盘上。pre-spawn 阶段取消才 `discard()` 删除。
- **OutputCollector**：spawn 后 attach `stream.on("data")`，每个 chunk `append()`；`persistOutput:"on_truncate"` 时 inline 超过 30KB 才激活写盘；`"always"`（run_in_background）从第一个 chunk 写盘。退出时 drain + close。
- **结果读取**（不改文件）：`readBashOutput`（bash-file-output.ts:153-183）只按 tail/inline 限额读；TaskOutput 工具读后台文件同样只读（task-output-bash.ts → readBackgroundBashOutput）。

---

## 4. 配置开关（env/配置项）

| 开关 | 位置 | 作用 |
|---|---|---|
| `ZCODE_STORAGE_DIR` | execution-utils.ts:19；cli/src/env.ts:134-138 | 仅改根目录（默认 `~/.omz`），不改限流策略 |
| `BASH_MAX_OUTPUT_LENGTH` | adapters/src/exec/bash-output-policy.ts:4-23（默认 30_000，上限钳 150_000） | 仅影响回给模型的 inline/tail 长度（`bashInlineLimit`），**不影响文件** |
| `TASK_MAX_OUTPUT_LENGTH` | core/src/tool/handlers/task-output.ts:202-212 | TaskOutput 展示长度 |
| `ZCODE_MAX_TOOL_CONCURRENCY` | adapters/src/config/env-config.adapter.ts:70 | 并发，非限流 |

- **没有任何 env/配置项可关闭 exec 落盘或调整 5GB 文件上限**：5GB 为硬编码常量（`core/src/tool/handlers/bash.ts:63` `MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5GB` 与 `execution-utils.ts:12` `BASH_RUNTIME_OUTPUT_LIMIT_BYTES = 5GB`）。
- per-request 结构体字段 `ExecutionOutputLimit`（contracts `interfaces/execution.port.ts:115-132`：`maxInlineBytes / maxBufferBytes / maxPersistedBytes / maxArtifactBytes / persistOutput / killProcessOnPersistedLimit`）是**唯一可调面**，但 Bash 工具每次请求都固定填 5GB（bash.ts:311-316），无外部注入点。
- 代码级注入点（测试/替代实现用）：`createNodeExecutionAdapter({ outputRootDir, processEnv })` 或整个 `options.executionPort`（create-app.ts:434-446）。
- 清理：`services/src/storage/domain/storageCatalog.ts` 把 `cli/exec` 归入 `toolOutputs`，且 `CLEANABILITY` 为 **`toolOutputs: "none"`（第 29 行，注释「其余工具输出与临时缓存暂不可删」）** → 现网没有任何自动清理/轮转 `cli/exec`。

---

## 5. 「写⑥章节需要的最小事实清单」

1. **事故一行链路**：Bash 工具调用 → `executeBashHandler`（core/src/tool/handlers/bash.ts:96）→ `executionPort.run()` / `runBashWithBackgroundLifecycle()` → `NodeExecutionAdapterRun.run()`（adapters/src/exec/node-execution-adapter-run.ts:27）→ 条件 `mode==="shell" && shellProfile==="posix-bash"`（execution-utils.ts:36）→ `new BashFileOutput(<root>/<sessionId>/<toolCallId>-stdout.log)`（bash-file-output.ts:14）→ `stdio=[stdin, file.fd, file.fd]`（run.ts:197-201）→ 子进程持续直写。
2. **根目录**：`$ZCODE_STORAGE_DIR || $HOME/.omz` → `cli/exec/<sessionId>/`（execution-utils.ts:18-21）；宿主同源为 `~/.zcode/cli/exec/`。
3. **上限事实**：5GB = `BASH_RUNTIME_OUTPUT_LIMIT_BYTES`（execution-utils.ts:12）/ `MAX_RUNTIME_PERSISTED_OUTPUT_BYTES`（bash.ts:63），执行方式为 `watchLimit` **每 5s stat 轮询**后杀进程（bash-file-output.ts:9, 65-87）；**写时零截断、零背压、零轮转**；超限文件原样保留。5.13GB、共 25.7GB 与「5GB 软上限 + 5s 轮询间隔内溢出 + 5 次调用」完全自洽。
4. **落盘不可通过 env 关停**：只有 `ZCODE_STORAGE_DIR` 换根；`BASH_MAX_OUTPUT_LENGTH` 只影响 inline，不碰文件；5GB/inline 30KB 全硬编码。
5. **修复落点候选（供⑥章引用）**：`bash.ts:311-316` outputLimit（每请求 5GB 可下调或按需 none）、`execution-utils.ts:12` 常量、`bash-file-output.ts:65-87` watchLimit（轮询间隔改流式 stat/或改 fd 侧限额如 `ulimit`/写时截断）、`storageCatalog.ts:29` `toolOutputs:"none"`（加清理策略）。
6. **勿误伤面**：hooks 恒 `persistOutput:"none"`；subagent 输出在 `~/.omz/cli/agents`；模型 debug 在 `cli/debug|rollout`（有轮转）；OutputCollector 路径已有预算+背压，问题只在 BashFileOutput 直写路径。

---

*取证方式：全仓只读 grep/Read（node 单行脚本 + findstr）；未修改任何源码文件；本证据包为唯一产物。*
