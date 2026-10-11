# 证据包：后台任务与子代理产物落盘链路（exec-log）

- 取证范围：**只管后台任务与子代理产物的落盘链路**（Bash `run_in_background` 与 Agent 后台两条链）。不落业务结论。
- 取证方式：只读源码。仓库根 `D:\Dev\Js\oh-my-zcode\omz`（pnpm monorepo，apps/zcode-cli）。
- 取证日期：2026-10-09。所有行号为取证时当前文件行号。
- 背景事故（用户已诊断，作为待验证事实引用）：子代理的**后台** Bash 任务跑死循环，stdout 无上限落盘（exec 目录 `-stdout.log` 单次 5.13GB ×5）；「后台任务超时被杀」才停止。

---

## 1. 链路地图

### 1.1 链路 A：Bash `run_in_background`（含子代理 runtime 内发起）

| 步骤 | 位置 | 行为 |
|---|---|---|
| 工具入口 | `D:\Dev\Js\oh-my-zcode\omz\apps\zcode-cli\packages\core\src\tool\handlers\bash.ts:130-160` | `run_in_background=true` → `executionPort.runBashWithBackgroundLifecycle(request, {mode:"explicit"}, runOptions)`；`auto_on_timeout` 是前台 Bash 超时自动转后台的另一入口（同文件 :151-156） |
| 请求构造 | `bash.ts:296-333` | `timeoutMs: resolveBashTimeoutMs(input.timeout, policy)`；`outputLimit.maxPersistedBytes = MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5*1024³`（`bash.ts:63`）；`persistOutput: run_in_background ? "always" : "on_truncate"`（:315） |
| 后台生命周期 | `...\packages\adapters\src\exec\node-execution-adapter-lifecycle.ts:102-298` | **`runRequest.timeoutMs = 0`（:124-132）——后台 Bash 不带任何超时计时器**；`killProcessOnPersistedLimit: false`（:128）+ `maxPersistedBytes: BASH_RUNTIME_OUTPUT_LIMIT_BYTES`（:129）+ `shouldStopOnPersistedLimit: () => state === "backgrounded"`（:256）。explicit 模式在 `started` 事件后立即 `commitBackground()`（:245-246）；auto 模式前台窗口 = `request.timeoutMs`，到时 `commitBackground`（:217-222） |
| 执行/spawn | `...\node-execution-adapter-run.ts:74-98, 180-310` | bash  merged output（`shell` + `posix-bash`，见 `execution-utils.ts:28-30`）走 `BashFileOutput`：`prepared.spawnOptions.stdio = [stdin, file.fd, file.fd]`（:197-201）——**子进程 stdout+stderr 都由 OS 直接写文件，不经过 Node 的 collector** |
| 5GB 看门狗 | `node-execution-adapter-run.ts:243-250`；`bash-file-output.ts:65-87` | `file.watchLimit(persistedOutputLimit(request), () => requestStop("output_limit"))`；`watchLimit` 是 `setInterval` **每 5s**（`OUTPUT_WATCH_INTERVAL_MS = 5_000`，`bash-file-output.ts:9`）`stat` 一次文件大小，超限即停表 + 触发 kill。登记时机：spawn 后（:247-248）与 commitBackground 时经 `bashLifecycle.onBackgrounded`（:249-250, lifecycle:197）各武装一次 |
| 超时 timer | `node-execution-adapter-run.ts:280-282` | `if (timeoutMs > 0) timeoutTimer = setTimeout(() => requestStop("timeout"), timeoutMs)`——后台链路 `timeoutMs=0`，**永不设** |
| 路径生成 | `...\node-execution-adapter-base.ts:86-117` | `join(rootDir, sessionId, `${toolCallId}-stdout.log`)`（:100）；merged 时同一文件即 `outputPath`（:101-108）。rootDir 生产值 = `join(storageRoot,"cli","exec")`（`...\packages\bootstrap\src\app\create-app.ts:443`）；缺省 `resolveDefaultOutputRootDir()` = `$ZCODE_STORAGE_DIR \|\| ~/.omz` + `/cli/exec`（`execution-utils.ts:18-21`） |
| 注册/追踪/通知 | `...\packages\core\src\tool\executor\background-tasks.ts`（`BackgroundTaskTracker.trackBackgroundTask` :91-366） | 1s 轮询 `getBackgroundTask` 快照（:355-361）+ `waitForBackgroundTask` 直等；`registerRuntimeBackgroundTask`（`background-task-registry.ts:47`）进 `runtimeTaskRegistry`（local_bash）；终态入队完成通知（:289-301, `formatBackgroundTaskNotification` :601-638） |

**事故路径吻合点**：子代理 child runtime 的 Bash 后台任务，exec 目录落到 `childSessionId`（`sess_subagent_agent_*`，见 `runner.ts:806 createSessionId(`subagent_${agentId}`)`）下，文件名为 `call_<toolCallId>-stdout.log`。本次取证期间自身的后台 findstr 即产生同类文件（`C:\Users\BloodyCrown\.zcode\cli\exec\sess_subagent_agent_*\call_*-stdout.log`），链路由此实证。

### 1.2 链路 B：Agent 后台（`async_launched`）

| 步骤 | 位置 | 行为 |
|---|---|---|
| 工具入口 | `...\packages\core\src\tool\handlers\agent.ts:174-220` | `subagentPort.launch({..., runInBackground})`；Agent tool entry `timeout: { kind: "none" }`（:267）——**无工具级超时** |
| 端口 launch→start | `...\packages\core\src\subagent\runner.ts:141-171, 440-526` | `launch` 判 `backgroundRequested` → `port.start()`；`start` 里 `registry.register` + `writeAgentMetadataFile(...,"running")` + `taskAbort`，随后 `void runBackgroundAgent(...)` 即返回 `async_launched`（:470-507, 525） |
| 运行体 | `runner.ts:1327-1366`（`runBackgroundAgent`）→ `runAgentToCompletion` → 终态 `finalizeBackgroundCompletion`（:1494-）/`finalizeBackgroundFailure` | child runtime 由 `runtime\methods\subagent.ts:93-413`（`runExploreAgent`）创建并 `childRuntime.executeTurn(...)`；child 的 Bash 后台任务再进入链路 A |
| 产物目录 | `runner.ts:800-815`（`createSubagentLifecycle`） | `join(options.outputRootDir ?? join(tmpdir(),"zcode-agents"), request.sessionId, agentId)`；生产 `outputRootDir = <cliStorageRoot>/agents`（`bootstrap\src\app\create-app.ts:298`，`cliStorageRoot=getCliStorageRoot(storageRoot)`，storage.dir 默认 `~/.omz`，`contracts\src\config\index.ts:360`）。目录内三文件：`metadata.json` / `output.txt` / `task.output`（:813-815） |
| 读侧 | `...\tool\handlers\task-output.ts`、`task-output-projection.ts`、`task-output-bash.ts` | TaskOutput 投影：运行中 bash 读文件头 30000 bytes；终态 8MiB 尾读；模型面再截断 |

---

## 2. 防护现状矩阵（写入点 × 有无上限）

| # | 写入点 | 机制 | 上限 | 超限行为 | 行号证据 |
|---|---|---|---|---|---|
| 1 | `exec/<session>/<toolCallId>-stdout.log`（bash merged，stdout+stderr 合并且由子进程 OS 直写） | 流式（内核页缓存，无 Node 缓冲） | **5 GiB 硬上限**（`BASH_RUNTIME_OUTPUT_LIMIT_BYTES`，`execution-utils.ts:11`） | 5s 轮询 `stat` 发现超限 → `requestStop("output_limit")` → taskkill 杀进程树；因轮询间隔+写入吞吐，**文件会超调到 ~5.13GB**（事故文件形态） | `node-execution-adapter-run.ts:243-250`；`bash-file-output.ts:65-87`；常量 `execution-utils.ts:11` |
| 2 | `exec/<session>/<toolCallId>-stderr.log`（非 merged 的通用 pipe 执行，OutputCollector 路径） | 流式 `createWriteStream`，背压 pause/resume | `maxPersistedBytes`（Bash handler 传 5 GiB；通用默认 `DEFAULT_MAX_PERSISTED_OUTPUT_BYTES=50MiB`，`execution-utils.ts:10`）+ 可跨流共享预算 | 超限只置 `artifactTruncated=true` 并**停止写该流**，不杀进程（除非 `shouldStopOnPersistedLimit`） | `output-collector.ts:140-173` |
| 3 | `agents/<session>/<agentId>/output.txt` | **终态一次性**全量 `writeFile` | **无上限、无截断** | 内容 = 子代理最终文本（`output.content.map(b=>b.text).join("\n\n")`），失控时等于模型最终一条回复的大小 | `runner.ts:1923-1937, 1981-1987, 2139-2141` |
| 4 | `agents/<session>/<agentId>/task.output` | 同上，与 output.txt **同一内容副本** | 无 | 同上 | `runner.ts:1985-1986, 1956-1957` |
| 5 | `agents/<session>/<agentId>/metadata.json` | 启动("running") + 终态各写一次，`JSON.stringify(...,2)` | 无硬上限；实际量级小（prompt/profile/usage） | — | `runner.ts:1989-2021`；启动写点 `runner.ts:191, 458` |
| 6 | 详情快照 `readBackgroundBashOutput` | 读侧 | 8192 bytes 尾读 | `BACKGROUND_BASH_OUTPUT_MAX_BYTES=8192` | `packages\shared\src\background-bash-output.ts:3`；`node-execution-adapter-lifecycle.ts:315-320` |
| 7 | TaskOutput 读侧 | 读侧 | 终态 8 MiB 尾读 / 运行中 30000 bytes 头读 / 模型面 32000 chars（env `TASK_MAX_OUTPUT_LENGTH`，最大 160000） | — | `task-output-projection.ts:10-11`；`task-output.ts:29-33, 199-217` |
| 8 | 进度事件 `stdoutTail`/`stderrTail` | 读侧 | 4096 bytes 尾 | — | `execution-utils.ts:16`；`output-collector.ts:111-118` |
| 9 | 后台 Bash 启动即预创建空文件 | — | — | `ensureBackgroundOutputFiles` 对非 merged 预 `open(path,"a")`；merged 由 `BashFileOutput.prepare()` 创建（win32 `"w"` 截断，posix `O_APPEND`） | `node-execution-adapter-results.ts:58-69`；`bash-file-output.ts:32-47` |

**无轮转（rotation）、无按 session/任务的自动回收、无 fsync**：全仓 `fsync/fdatasync` 在 exec/runner 写入路径零命中（仅 `storage\workspace-hook-trust-store.ts:519` 一条注释）。

---

## 3. 超时机制与常量（含「后台任务超时被杀」的实际语义）

| 机制 | 常量/默认 | 位置 | 说明 |
|---|---|---|---|
| 后台 Bash 自身超时 | `timeoutMs = 0` | `node-execution-adapter-lifecycle.ts:124-132` + `node-execution-adapter-run.ts:280-282` | 显式 `run_in_background` 与 auto 转后台都置 0：**没有 timer，永不超时** |
| **子代理后台 Bash 最大运行时长** | `DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000`（**60 分钟**） | `runtime\helpers\runtime-tools.ts:27`；武装点 `tool\executor\background-tasks.ts:177-204` | 仅当 `runtimeScope==="subagent"` 且 `subagentBackgroundBashMaxMs !== undefined` 时设 timer，到期调 `executionPort.cancelBackgroundTask(taskId)`。配置键 `subagents.backgroundBashMaxMs`（`runtime\types.ts:134`；`runtime\helpers\runtime-tools.ts:242-245, 318-323`，非正数/非数回落 60min）。**主会话的后台 Bash 没有这个 timer**（非 subagent scope 不武装）——这是链路 A 的重要不对称 |
| 前台 Bash 超时政策 | default `120_000` / max `600_000` | `tool\bash-timeout-policy.ts:6-12` | env `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` 可改；只影响 auto_on_timeout 的前台窗口与真正前台执行 |
| 子代理不活动 watchdog | `DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000`（**10 分钟**） | `contracts\src\config\index.ts:342`；使用点 `subagent\runner.ts:208-219, 1191-1267` | 只在**前台** `run()` 路径安装；**后台 `start()` 路径没有装 watchdog**（runner.ts 内 Watchdog 出现处仅 :208/:219）。静默 10min 触发 `Subagent was inactive for ...ms`（ToolTimeout，:1228） |
| 模型流 idle | `ModelStreamConfig.idleTimeoutMs` 默认 600_000，重试 +30s | `contracts\src\config\index.ts:348-351`；`adapters\src\model\stream-idle-timeout.ts:7-24` | 覆盖所有模型请求；**模型在持续产出的死循环不会命中** |
| 5GB 落盘上限 | `BASH_RUNTIME_OUTPUT_LIMIT_BYTES = 5*1024³`（=5GiB） | `execution-utils.ts:11`；同值副本 `bash.ts:63` `MAX_RUNTIME_PERSISTED_OUTPUT_BYTES` | 看门狗间隔 `OUTPUT_WATCH_INTERVAL_MS = 5_000`（`bash-file-output.ts:9`）→ 超调机理 |
| autoBackgroundMs（前台 Agent 自动转后台） | 无默认（无效值→`undefined`） | `subagent\runner.ts:653-658`；配置 `runtime\types.ts:133` | 不配置则前台 Agent 不存在"到点转后台" |
| 通用 run 超时缺省 | `DEFAULT_TIMEOUT_MS = 300_000` | `execution-utils.ts:5` | 仅 `request.timeoutMs` 缺省时生效；后台链路被 0 覆盖 |

**「超时被杀」的实际语义（取证结论级事实）**：
- 后台 Bash 的终态只可能是 `completed / failed / cancelled / spawn_error`；`normalizeBackgroundTaskNotificationStatus`（`background-tasks.ts:828-844`）把 `cancelled/timed_out/killed/stopped` 一律折算为通知里的 "killed" → 文案 `Background command "…" was stopped`（`background-tasks.ts:853-872, 629-637`）。**后台链路不存在产出 `timed_out` 状态的代码路径**（auto 模式是 commitBackground 而非报 timeout）。
- 真正能杀死一个持续吐 stdout 的后台 Bash 的，只有两个：**5GiB 看门狗**（消息 `Background command killed: output file exceeded 5GB`，`node-execution-adapter-results.ts:163-179`；run 内 also `Command killed: output file exceeded 5GB`，`node-execution-adapter-run.ts:342`）与**子代理 60min 最大运行时长取消**。用户所述「后台任务超时被杀」对应后者/或看门狗的合称；5×5.13GB 的单文件形态指向 5GiB 看门狗先命中（60min 是外层兜底）。
- kill 执行：`terminateProcessTree`（`node-execution-adapter-process.ts:146-200`）Windows = `taskkill /pid <pid> /T /F`；文件直写路径结算 exit code 137（`node-execution-adapter-run.ts:139-142`）。`FORCE_EXIT_AFTER_KILL_MS = 5_000`（`execution-utils.ts:13`）后强制销毁流。

---

## 4. 收尾行为（触发后是否停止读 stdout、文件如何收尾）

1. **读侧全部停止**：`run()` 的 `finally`（`node-execution-adapter-run.ts:385-397`）清 `timeoutTimer`、`progressTimer`、`forceExitTimer`，并 `file?.stopWatching()`（同时停 `watchLimit` 与 `watchProgress` 尾读订阅，`bash-file-output.ts:89-96`）；abort 监听移除；`completeActiveExecution`。此后 ZCode 侧不再 stat/read 该日志。
2. **fd 关闭但无 fsync**：`BashFileOutput.close()` = `handle.close()`（`bash-file-output.ts:49-54`，失败吞掉）；`run()` finally 里 `await file?.close()`。父进程持有的 fd 关闭；子进程写进口袋的已是页缓存数据，**进程被 kill 不会回退，5.13GB 文件作为残留留在磁盘**。
3. **进程非正常死亡**（CLI 被 SIGKILL）：finally 不执行，fd 由 OS 回收，文件同样残留、无 close 记录、无截断标记。
4. **record 结算**：`finalizeBackgroundTaskRecord`（`node-execution-adapter-base.ts:182-192`）写 status/result 并 resolve completion；5GB 路径经 `normalizeBashBackgroundOutputLimitResult` 覆写为 `status:"cancelled", exitCode:137, error:{type:"output_limit", "…exceeded 5GB"}`（`results.ts:163-179`）；60min cancel 路径 `cancelBackgroundTask`（`lifecycle.ts:365-373`）立即置 `cancelled` + `controller.abort()`。
5. **子代理侧收尾**：`runBackgroundAgent` catch → `finalizeBackgroundFailure`（写 `output.txt`/`task.output`=errorMessage + metadata）；`stopTask` → `finalizeBackgroundStopped`→`writeStoppedAgentArtifacts` 写固定 stopped 文案（`runner.ts:1952-1979`）。parent 取消时 child runtime `finally` 里 `sealBackgroundTaskNotifications` + `cancelRunningRuntimeBackgroundTasks`（`runtime\methods\subagent.ts:399-411`）把 child 的后台 Bash 全部取消（`runtime\methods\background.ts:294-319`）。
6. **写方式**：output.txt/task.output 是 `mkdir + writeFile(全量)`（`runner.ts:2139-2141`），**非 temp+rename、非追加**；若在写出过程中被杀，可能留下部分写入的文件。

---

## 5. 清理/回收机制

- **exec 目录（`<storage>/cli/exec/<session>/*-stdout.log`）：无任何自动删除/保留期/轮转。** 全仓删除点仅三处，均不覆盖运行后日志：
  - `bash-file-output.ts:56-63` `discard()`：仅删"本次创建且 spawn 前失败"的文件；
  - `node-execution-adapter-results.ts:114-121`：仅前台 foreground 结算不保留 artifact 时删；
  - `shell-init-snapshot.ts:83/216`：只删 shell 快照。
- **子代理产物（`<storage>/cli/agents/<session>/<agentId>/**`）：无清理**（`zcode-agents` 字符串仅存在于 runner.ts 的缺省值，无删除逻辑）。
- 唯一存在保留期的机制：`cleanupStaleShellInitSnapshots`（`node-execution-adapter-base.ts:50-52, 259-278`；`shell-init-snapshot.ts:192-225`），**只清 `<rootDir>/shell-snapshots/*.sh`，保留 30 天**（`DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS = 30`，`shell-init-snapshot.ts:17`），且仅在 adapter 构造时触发一次，无周期任务。
- `adapters\src\logging\retention.ts` 的日志保留期服务的是应用日志，不是 exec bash 日志。

---

## 6. 「写⑥章节需要的最小事实清单」

给后续写第⑥章（大概是修复/加固方案）的最小事实集，逐条可直接引用：

1. **写入点与载体（唯一真正的磁盘放大器）**：`exec/<session>/<toolCallId>-stdout.log`，merged bash 的 stdout+stderr 由子进程 **OS 直写**（`node-execution-adapter-run.ts:197-201`），Node 侧零缓冲 → 任何进程级限额都必须在"看门狗 stat"或"限额即杀"层面做。
2. **现存的唯一硬闸是 5GiB 看门狗**：`BASH_RUNTIME_OUTPUT_LIMIT_BYTES`（`execution-utils.ts:11`）+ `watchLimit` 5s 轮询（`bash-file-output.ts:65-87`），超调形态 = 5.13GB。消息串：`Background command killed: output file exceeded 5GB`（`results.ts:176`）。
3. **后台 Bash 无超时**：`runBashWithBackgroundLifecycle` 强置 `timeoutMs:0`（`lifecycle.ts:124-132`）。
4. **子代理后台 Bash 有 60min 最大运行时长**，主会话后台 Bash **没有**：`DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS=3_600_000`（`runtime-tools.ts:27`），武装条件 `runtimeScope==="subagent"`（`background-tasks.ts:177-204`），配置键 `subagents.backgroundBashMaxMs`（`runtime/types.ts:129-139`）。
5. **后台 Agent（start/async_launched）无 watchdog、无最大运行时长、工具 timeout kind "none"**：`agent.ts:267`；watchdog 只装在前台 `run()`（`runner.ts:208-219`）；`autoBackgroundMs` 无默认（`runner.ts:653-658`）。
6. **产物三文件的写入策略**：`output.txt`/`task.output` = 终态一次性全量同内容写（无上限，`runner.ts:1923-1937, 1981-1987, 2139-2141`）；`metadata.json` 小。子代理产物不会造成 GB 级膨胀；GB 级只来自链路 A 的 exec 日志。
7. **收尾语义**：kill 后 run() finally 停所有 timer/watch 并 close fd，**无 fsync、无删除**；文件残留即事故现场的 5×5.13GB。终态通知把 cancelled 折算成 "killed"/"was stopped"（`background-tasks.ts:828-844`），不存在 `timed_out` 后台终态。
8. **清理现状**：exec 与 agents 目录**均无保留期/轮转/自动回收**；唯一 retention 是 shell-snapshots 30 天且与日志无关（`shell-init-snapshot.ts:17, 192-225`）。
9. **可下手的设计缝隙（事实推论最小集）**：把 5GiB 上限从" kill 级"改成"更小限额 + 时窗统计（如 bytes/min）"，或给主会话后台 Bash 也接 `subagentBackgroundBashMaxMs`，或给后台 Agent 接 watchdog/maxRuntime——三个旋钮的接线点分别是 `execution-utils.ts:11`、`background-tasks.ts:177-204`、`runner.ts:440-526`（start 路径）。
10. **配置/环境变量面**：`ZCODE_STORAGE_DIR`（exec 根，`execution-utils.ts:18-21`）、`BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS`（`bash-timeout-policy.ts:14-28`）、`subagents.{backgroundBashMaxMs,inactivityTimeoutMs,autoBackgroundMs,outputRootDir}`（`runtime/types.ts:129-139` → `bootstrap\src\app\runtime-config.ts:177-186`）、`TASK_MAX_OUTPUT_LENGTH`（`task-output.ts:199-217`）。

**未取证/需磁盘取证的问题（本包不含结论）**：5 个 5.13GB 文件分别对应哪 5 个 taskId/toolCallId、是否同一会话、60min timer 与 5GiB 看门狗谁先命中——需直接统计 `~/.omz/cli/exec/**/*-stdout.log`（或 `$ZCODE_STORAGE_DIR/cli/exec`）的文件名/时间戳与 registry 状态。
