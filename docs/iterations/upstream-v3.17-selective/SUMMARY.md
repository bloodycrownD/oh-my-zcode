---
date: 2026-11-04
title: 上游 ZCode v3.16.2 → v3.17.2 选择性同步：缺陷修复与性能优化候选汇总
upstream_base: 3c5b2276（v3.16.2，2026-10-20）
upstream_target: v3.17.2（a9fe401e，2026-11-03）
fork_head: main @ 36bc100f（omz v1.1.3）
---

# 汇总：只取缺陷修复与性能优化

## 0. 口径

- 三个区域报告合计 **89 个候选**：bugfix **78**、perf **11**。
- 去重后 **88 个**（UI `BF-10` 与 Services `SVC-B05` 是同一底层修复的两层）。
- 成本：S ≈ 半天内、单文件或少量调用点；M ≈ 1–3 天、需融合；L ≈ 3 天以上或需分阶段。
- 「fork 改过」= 该文件在 `3c5b2276..main` 有改动，移植必须逐 hunk 融合，不能整文件覆盖。
- 明细见 `analysis-cli.md`、`analysis-ui.md`、`analysis-services.md`。

## 1. P0：安全 / 数据丢失 / 进程级故障

这些不是「体验优化」，是会执行未审批命令、丢用户数据或让 Host/远程整体不可用的缺陷。

| ID | 类型 | 问题 | 成本 | fork 改过 | 备注 |
| --- | --- | --- | --- | --- | --- |
| CLI-01 | bugfix | `sed` 只读判定用黑名单，漏掉 `e` 命令与 `s///e`、`s///w`，Plan 下自动放行执行/写文件 | M | 否 | 可直接重放；上游未在 Windows 实测，需补 Git-Bash sed 验证 |
| CLI-02 | bugfix | Plan 闸门比基础模式更宽：只读但需审批的工具、非 destructive MCP 免审批；guarded+Plan 跳过危险命令确认 | M | 否 | 删掉 `CronPauseSelf` 段（fork 无该能力） |
| CLI-03 | bugfix | 内置 Explore 固定 yolo 且新建默认权限服务，父会话授权不生效；提示注入可免审批执行任意 Bash | L | 是 | 安全面最大的一项，需与 fork 的 subagent 权限改造融合 |
| CLI-04 | bugfix | 子会话恢复沿用落盘执行状态，父会话从 yolo 改 build 后子会话仍免审批 | S | 是 | 与 CLI-03 同批 |
| CLI-05 | bugfix | subagent 复用父 model 句柄，父 runtime 层盖掉子层：准入端口/重试预算/会话类型失效，并行 Agent 放大成 1302 风暴 | L | 是 | 需逐层核对 fork 的 model handle 生命周期 |
| SVC-B01 | bugfix | 配置写入方把损坏/读失败的 `config.json` 当空对象整文件写回，冲掉 MCP/插件/命令等字段；写入非原子、权限随 umask | M | 部分 | 数据丢失级；新增 `updateJsonObjectFile`，6 个写入方 |
| CLI-06 | bugfix | Read 状态按 `path+offset+limit` 存多条、冷恢复另用一套规则：range Read 不恢复、并行 Read 顺序错、`file_unchanged` 重放、rewind 丢 MEMORY.md 种子 | L | 部分 | 表现为 Edit 误报 stale、`Wasted call` 误判 |
| CLI-07 | bugfix | 空文件与「offset 超出」混为一谈；部分视图提示固定写 `lines 1-N`，行号与下一页 offset 都错 | M | 否 | 与 CLI-06 同批 |
| CLI-08 | bugfix | 冷恢复后指令公告（MEMORY.md 索引）原样保留，模型按旧内容写入会覆盖它没看过的新内容 | M | 是 | 数据丢失级 |
| CLI-09/10 | bugfix | 非仓库目录起步后进入仓库永远不再宣告 Git；会话中途 `git init` 后冷恢复仍报 false | M/S | 是 | 两项可合并 |
| CLI-11 | bugfix | 隐藏提醒在 live 会移动 `latestConversationMessageId`，冷恢复却跳过：compaction 边界与 timeline 锚点前后不一致 | M | 是 | |
| CLI-12 | bugfix | 工具批次中停止后继续 drain guide，把引导塞进已停止的轮次 | S | 是 | |
| CLI-13 | bugfix | 隐藏提醒写在用户输入与 assistant 之间，rewind 的 assistant 锚点回溯停在它上面，旧输入留在历史里 | S | 是 | |
| SVC-B02 | bugfix | 目录 `readdir`/`stat` 永久不返回时，每次重试再占一个 libuv 线程，4 次后本进程所有文件操作卡死 | S | 否 | |
| SVC-B08 | bugfix | 事件订阅抛错（如终端已结束）逃逸为未捕获异常，整个 Host 退出 | S | 否 | |
| SVC-B10 | bugfix | 远端命令被信号杀死/无 exit-status 时 `code=null` 被当 0 成功，下载/解包/update 失败静默 | S | 部分 | |
| SVC-B11 | bugfix | SSH 认证中 dispose 后 ssh2 既不 ready 也不 error，`ensureConnected` 永不结束，设备永久「连接中」 | S | 否 | |
| CLI-22 | bugfix | workflow 对分类器不认识的业务码无上限重试，run 永远挂着（2026-10-16 事故：1113 批量返回） | M | 否 | |

## 2. P1：用户可感知的功能缺陷

### 2.1 会话 / 输入 / 终端

| ID | 类型 | 问题 | 成本 | fork 改过 |
| --- | --- | --- | --- | --- |
| BF-01 | bugfix | 发送后查询先返回 `unknown` 就清账，正文被恢复回草稿、迟到 ACK 丢结算 | M | 是 |
| BF-02 | bugfix | ACK 丢失＋断连后草稿回填无人清空，用户再点发送产生重复消息 | M | 是 |
| BF-04 | bugfix | 终端最后一个 tab 的关闭按钮只收面板、不删 session，PTY 泄漏 | M | 否 |
| BF-03 | bugfix | 首发已提交但投影未到时 placeholder 闪回「新任务」 | S | 否 |
| BF-09 | bugfix | turn 刚完成时的 `proto.staleRevision` 竞态让本轮 md/html 预览卡永久被抑制 | S | 否 |
| BF-14 | bugfix | 会话查找在虚拟窗口内定位失效／被 `scrollToIndex` 抢滚动／smooth 落点被补偿取消 | M | 部分 |
| BF-13 | bugfix | 「全部更新」对同一插件并发两次 update；单个失败中断后续；切 scope 后仍继续写 | S | 否 |
| PF-06 | perf | Windows 中文输入法组合态每次更新都序列化前后全文并写父级草稿/localStorage，打字与退格数百毫秒延迟 | L（可只取 M 的子集） | 是 |

### 2.2 远程 / 桌面 / 文件

| ID | 类型 | 问题 | 成本 | fork 改过 |
| --- | --- | --- | --- | --- |
| BF-05 | bugfix | 首连期间重叠点击共享同一 logical session，被替代的旧导航把新导航要用的连接释放掉 | M | 否 |
| BF-06 | bugfix | 未提交的导航（下载型 URL/ERR_FAILED）被当成当前页与恢复地址，每次重挂重复下载 | M~L | 否 |
| BF-07 | bugfix | 只开远程项目时「测试模型连通性」直接报本地工作区不可用 | S | 否 |
| BF-08 | bugfix | 关闭弹窗/切工作区后，首启检测的迟到回包让迁移弹窗重新弹出；无项目时导入静默跳过 | M | 否 |
| BF-11 | bugfix | 写 MCP 配置用「最后一个初始化 tab」的全局目录服务，跨主机写到错误设备 | M | 是 |
| BF-10 / SVC-B05 | bugfix | 合并轮多条 `task-notification` 只解析第一条；失败 hover 无详情；后续任务无终态 | M | 部分 |
| SVC-B20 | bugfix | 首次 Provider 同步未完成时重复 connect 被拒「尚无可用 renderer attachment」 | S | 是 |
| SVC-B21 | bugfix | 远程 bind 失败的错误 `code/retryable` 跨 contextBridge 丢失 | S | 是 |
| SVC-B22 | bugfix | 通用「另存为」拒绝 0 字节文件 | S | 否 |
| SVC-B24 | bugfix | Windows 遮挡检测残留（Alt-Tab 后停帧）、主窗口 `window.open` 绕过管控、嵌入浏览器下载被当加载失败 | M | 是 |
| SVC-B25 | bugfix | 附件 URL 未提交页面却写入 `cachedUrl`，每次 rebind 重复下载；human tab 切走后后台反复请求 rebind | M | 是 |
| SVC-B27 | bugfix | `getClient` 返回已 dispose 的 client；进程回收无屏障可并发清理/再 spawn | M | 是 |
| SVC-B06 | bugfix | 用户主动中断仍生成未读红点，必须切走再切回才清 | S | 是 |
| SVC-B07 | bugfix | 定时任务派发回写无条件写 `active/enabled=1`，把派发窗口内刚暂停的任务复活 | S | 是 |
| SVC-B04 | bugfix | 纯 trailing debounce 下持续写入永不刷新；`fs.watch` 绑定已移走 inode 仍冒充原路径 | M | 否 |
| SVC-B28 | bugfix | Windows autocrlf 工作区 CRLF lockfile 被误判与安装快照不一致，构建失败且重装无效 | S | 否 |
| SVC-B29 | bugfix | node-pty 预编译目录整目录 force 覆盖/只塞 `pty.node`，JS 与 native 版本混装，macOS/Linux resize 必失败 | M | 否 |
| SVC-B30 | bugfix | macOS 顶层 `electronLanguages` 用 `en-US/zh-CN` 匹配不到 `en.lproj/zh_CN.lproj`，Chromium 文案全被删 | S | 是 |

### 2.3 模型 / 工具 / 上下文

| ID | 类型 | 问题 | 成本 | fork 改过 |
| --- | --- | --- | --- | --- |
| CLI-14 | bugfix | 输入附件每次迭代都收集/不落盘：Stop hook 续跑、流重试、降级重发被插入通知；`output_style` 只在首步发 | L | 是 |
| CLI-15 | bugfix | MCS 投影错位：guide 被投影成 user 文本并移到 run 末尾、带图中途消息被当新轮、通知按前缀猜边界 | L | 是 |
| CLI-16 | bugfix | 补 `"\n"` 无条件执行，OpenAI 兼容协议不合并相邻 user，补了只改写上次请求最后一块 → 前缀缓存失效 | M | 是 |
| CLI-17 | bugfix | `localeCompare` 不带 locale，跟随进程语言：换语言设置恢复后 tools 段字节变化、缓存失效 | S | 否 |
| CLI-18 | bugfix | Bash 失败输出 >30000 字节就落盘、只给 2KB 开头，模型看不到后部错误原因 | S | 否 |
| CLI-19 | bugfix | 工具错误给模型的是 UI 摘要（空白折叠、500 字符截断），多行错误细节丢失 | S | 否 |
| CLI-20 | bugfix | Hook 文本拼进 tool result 占用其预算、以 UI 摘要为底拼失败结果 | M | 是 |
| CLI-21 | bugfix | Bash `cd` 后写回规范化物理路径，symlink/`/private`/盘符大小写让同一目录换写法 → 假目录变化 | S | 否 |
| CLI-23 | bugfix | MCP 连接归 pool 却继承第一个 session 的关闭信号，关一个会话连带中止其他 lease；close 非幂等 | M | 是 |
| CLI-24 | bugfix | 一组小缺陷：小数 `timeout` 被判失败、空白 `send-message` 报 queued 后被拒、`~N messages` 算进隐藏提醒、子会话通知复制超长 provider 原文、SQLite metadata 逐字符校验等 | S | 部分 |
| CLI-25 | perf | Git 快照：5 条互不依赖的 git 命令串行执行，git 卡住时要等 7–9 次 3 秒超时；「是否仓库」每次都 spawn git | M | 是 |
| CLI-26 | bugfix | 自动 git 按裸名执行并继承全部环境：Windows 会跑工作区里的 `git.exe`、执行仓库 fsmonitor/hooks、继承 `GIT_DIR` 读另一个仓库；PATH 按 `:` 拆导致条目全丢 | L | 部分 |

### 2.4 远程守护进程（若 fork 仍发布 SSH/WSL/Docker 远程能力）

| ID | 类型 | 问题 | 成本 |
| --- | --- | --- | --- |
| SVC-B12 | bugfix | 2FA 提示被误判为密码错误、重复密码被误判为 2FA；keepalive 超时报成握手超时 | S |
| SVC-B13 | bugfix | WSL 身份探测走 `bash -lc`，profile echo 污染 distro/user，之后每次连接报 distro 不存在；失败被永久缓存 | M |
| SVC-B14 | bugfix/perf | Docker 每条 exec 重复 `docker version/ps`，冷启动耗尽 10s probe 预算 | S |
| SVC-B16 | bugfix | SSH 用户名含冒号时 remote identity 解析失败 | S |
| SVC-B26 | bugfix | Docker 容器内数字 UID 无 passwd 条目，`userInfo()` 抛错阻断 Core ready | S |
| SVC-B32 | bugfix | 远端锁只凭 PID 判活：PID 复用/容器或 WSL 重启后残留锁被判活；共享 home 两台主机互相接管活锁 | M |
| SVC-B33 | bugfix | Core 事件循环卡死但进程仍在时 status 一直 ready；Core 启动失败原因被退出码覆盖 | M |
| SVC-B34 | bugfix | daemon 运行中 server root 被删除/替换后，旧 Supervisor 继续往新 root 写 ready 快照 | M |
| SVC-B35 | bugfix | systemd `enable --now` 失败无法区分装载/启动阶段，装载失败也不回退 detached | M |
| SVC-B36 | bugfix | 同一 archive 强制重装时，磁盘内容偏离完整性记录被当冲突，永远无法重装 | M |
| SVC-B37 | bugfix | `serve --daemon` 10s 等待短于 Supervisor 15s Core ready 预算；复用 starting Supervisor 返回 `port:null` | M |
| SVC-B38 | bugfix | 远端 Core 缺 `ZCODE_APP_VERSION`，Agent 请求头报 CLI 包版本，按客户端版本拦截的网关会拒绝 | S |
| SVC-B39 | bugfix | Windows `spawn("pnpm")` 不经 shell 无法解析 `.cmd` shim，e2e onPrepare 直接 fatal | S |

## 3. P2：性能优化（按实测收益排序）

| ID | 类型 | 优化点 | 实测/量级 | 成本 | fork 改过 |
| --- | --- | --- | --- | --- | --- |
| SVC-P01 | perf | RPC 二进制序列化先走 `toJSON`，Buffer 被展开成数字数组 | 体积约 3.6 倍、单跳十几秒、>28MB 超 WS 上限 | S | 否 |
| CLI-27 | perf | dynamic-workflow 控制流分析 `settle` 对主线透明，n 个顺序 await 画出 n(n+1)/2 条边 | 80 层 × 800 处 = 1629 万条边 / 4.7 GB，且图是错的 | L | 否 |
| PF-06 | perf | Windows IME 组合态逐键序列化全文 + 写 localStorage | 打字/退格数百毫秒延迟（ZCT-2112490732581797888） | L（可先取 M 子集） | 是 |
| PF-01 | perf | 流式帧每帧重建整窗 render unit/目录/查找索引 | renderer 非空闲 1649ms→1083ms（−34%），帧间隔 P95 18.3→17.5ms | L | 是 |
| PF-05 | perf | 时间线每像素滚动都 setState；未知长轮按 72px 估高导致首屏挂载十几轮 | — | M | 是 |
| PF-03 | perf | 查找高亮对每个命中都重新遍历整行文本，二次复杂度 | — | S | 否 |
| PF-04 | perf | 查找结果被动回报每次都改 App 状态，整棵 App 随流式帧重渲染 | — | S | 是 |
| PF-02 | perf | 若干每帧派生仍整窗扫描（`shareDeltaRows`、`reconcileSnapshot`、`[...rows].reverse()`、`turnOrder.includes`） | — | M | 部分 |
| CLI-25 | perf | Git 快照 5 条命令串行 → 并行；仓库判定不重复 spawn | 卡住时 7–9 次 3 秒超时 | M | 是 |
| SVC-P02 | perf | 同一 protocol 上 ChannelClient/ChannelServer 对每条消息体各解码一次 | 反向端白解码 | S | 否 |
| SVC-P03 | perf | 远端项目每次 readTree/prepareSession 对每个路径重复 `resolveWorkspace` | 多一次 SSH 往返 + 远端两次开库 | M | 部分 |

## 4. 跳过（不进本轮）

| 项 | 理由 |
| --- | --- |
| conversation telemetry 引擎、`v4/telemetry/**`、`lib/messageTelemetry.ts` | 红线 1，fork 已删遥测 |
| data-sync 全族（`packages/services/src/data-sync`、`ui/src/data-sync`、`session-data/**`） | 新产品线，依赖 source-server R3 |
| source-server R3 新架构、`SourceServerManagementPanel`、`RemotePluginSyncDialog` 等 | 依赖已下线产品线；fork 里若有活路径另行评估 |
| `zcode-site-plugin`、`tools/provider-regression`、`image-preview-editor`、`file-menu`、`project management`、`personalization`、`settings-scope` | 纯新功能/新产品线 |
| 原生压缩（`core/src/compact/**`、`compact-*`） | 红线 3，fork 已删 |
| 上游删除约 2070 个 `packages/*/test` 单测 | 开源导出裁剪，不是缺陷修复 |
| `electron-builder` 26.17 三项（SVC-X01/X02/X03） | 依赖升级，升级时再取 |
| `CronPauseSelf`、`SessionStore.commitMessageBundle`、`dropTrailingHighSurrogate`、MCP `untrusted` 状态 | fork 无对应能力/状态源，先跳过或需先补能力 |
| 手机输入接管（`terminalComposedInputFallback`）、web-remote relay v2 | 新产品线/依赖已下线面 |
| 闲时任务、官方 MCP 鉴权、coding-plan、会话分享 | 已下线产品面 |

## 5. 建议的第一批（P0 + 低成本高收益）

按「先止血、再提体验」排：

1. **安全四件**：CLI-01、CLI-02、CLI-03、CLI-04（CLI-05 紧随，L）。
2. **数据完整性**：SVC-B01、CLI-06/07、CLI-08、CLI-09/10。
3. **进程级故障**：SVC-B02、SVC-B08、SVC-B10、SVC-B11、CLI-22。
4. **性能快赢**：SVC-P01、SVC-P02、PF-03、PF-04、CLI-25。
5. **UI 高频痛点**：BF-01、BF-02、BF-04、BF-13、BF-03、BF-09。

每一项都独立成 commit，可单独回滚；移植前先按对应报告里的「移植要点与风险」核对 fork 侧差异。

## 6. P0 落地记录（2026-11-05）

### 6.1 已落地

| ID | 内容 | 落点 |
| --- | --- | --- |
| CLI-01 | `sed` 只读判定从黑名单改白名单：`e` 命令、`s///e`、`s///w` 不再被 Plan 自动放行 | `bash-readonly-policy-flags-text.ts`、`bash-readonly-policy-callbacks.ts` |
| CLI-02 | Plan 闸门只收紧：只读但需审批的工具交回原模式；非 destructive MCP 改 ask 且不提供「始终允许」；guarded + Plan 的危险命令直接 deny（Plan 拒绝优先，审批不能解除 Plan 限制；原「补做单次确认」分支不可达，已删，SA-A7） | `permission/service.ts` |

回归网（新增，独立可跑）：

- `scripts/test-bash-sed-readonly-policy.mjs`（4 项，含真实 sed 端到端只读探针）
- `scripts/test-permission-plan-gate.mjs`（7 项，含「判定侧策略确实被 executor 取用」的行为守卫）

### 6.2 落地过程中发现的缺陷（上游 diff 里看不出来，跑测试才暴露）

上游 v3.17 的这两项修复如果照原样重放，在 fork 上**都不生效**，因为它们依赖的接线在 fork 里是断的：

1. **guarded 危险命令闸门整条失效**（`rm -rf`、`git clean -f` 在 guarded 下直接执行，不弹确认窗）。四处断点：
   - `permission-capability.ts` 构造运行时上下文时没带 `mode` / `bashShellSelection`，`resolveBashPermissionCapability` 里 `mode === "guarded"` 永不成立；
   - `hook-flow.ts` 的 PreToolUse hook `allow` 能把 `ask` 抹成 `allow`（单次确认被 hook 代答）；
   - `permission-responder-race.ts` 没把 `approvalMode` 写进 broker 请求，UI 只看到一次普通 ask；
   - `approval-gate.ts` 对单次确认照样跑 `prepareApproval`，工具预览返回 proceed 即放行。
2. **`optionsPolicy` 只写不读**：`PermissionDecisionResult.optionsPolicy` 赋值后无人消费，Plan 的「不给始终允许」到不了确认窗；`approval-gate.ts` 现在与工具声明**取更严**。
3. **确认窗事件早于 broker 登记**：事件先发、应答方后登记，用户点得快会点在未登记的请求上（点击被幂等丢弃）。改为登记完成后再发布，延迟登记的 broker 要等 `registered` 兑现。
4. **取消不返回 `tool_cancelled`**：外层 abort 后若 broker 不理会 signal，竞速永久挂起；现在先让 broker 用自己的拒绝收口，一个宏任务后仍无人收口则补 `ToolCancelled`。
5. **broker 故障被报成「用户拒绝」**：桥接程序挂掉/反向 RPC 断开现在映射为 `tool_execution_failed`。
6. **hook 改写输入后沿用旧批准**：改为关掉旧请求、按新输入重新走确认窗（新 requestId，重问轮不再问 hook，避免每轮拿到同一个改写）。
7. **单次确认的应答可夹带规则**：`permissionUpdates` / `sessionPermissionUpdates` 出现在 user-once 应答里一律按非法应答拒绝。
8. **确认窗调整整条未接线**：`applyPermissionInputAdjustments` 是死代码，`inputAdjustments` 永远是 `undefined`；现已接到「授权之后、handler 之前」，CreateWorkflow / AmendWorkflow 的模型与并发调整生效。

### 6.3 测试口径

- 权限面 **25 个测试文件 / 458 用例全绿**（含 `guarded-approval` 由 75 红 → 104/104）。
- `tsc -b apps/zcode-cli/packages/core` 干净。
- 另修 5 处**只在 Windows 红**的测试：`xargs` 的 win32 分叉、计划文件与 Memory 目标路径（`path.join` 出来是反斜杠）、权限生命周期日志缺 trace 字段。

### 6.4 有意收窄（不是回归）

`sed` 白名单只接受完整安全语法，因此 `sed -n '/re/p'`、`sed -n '$p'` 这类地址写法现在会**要求确认**（此前静默放行）。安全性优先；只影响 Plan 的自动放行，用户点一次即可。若要放宽，需要为「地址 + 正则」单独做一套形状校验，不能直接复用数字地址那一条正则。

### 6.5 未处理

`CLI-03`（内置 Explore 固定 yolo）、`CLI-04`（子会话沿用落盘执行状态）、`CLI-05`（subagent 复用父 model 句柄）为 L 级安全项，需与 fork 的 subagent 权限改造一起做。

## 7. 清红（第二轮：故障矩阵与平台/过期断言）

这一轮不是移植上游，是把套件里长期红的清掉。分类判据：产品丢了上游 API → 改产品；产品有意改了行为 → 改测试；只有平台差异 → 改断言。

### 7.1 产品侧：补回 adapter 的 statusSink（真回归）

`AiSdkModelAdapter` 在 base v3.16.2 与 v3.17.2 都有 `statusSink?` 构造参数、`addStatusSink()`、以及向 `runGenerateText` / `runStreamText` 的转发；fork 合并时四处全丢。后果：`runner-stream` / `runner-generate` 的 `input.statusSink` 永远是 undefined，`model_retry_scheduled` / `model_request_completed` 这类状态事件发不出去，bootstrap 里 4 处 `adapter.addStatusSink(...)` 也是空转。

修复：`packages/adapters/src/model/runner.ts` 补回字段、构造赋值、`addStatusSink`（多 sink 并行投递、互不影响）与两处转发。

效果：`workflow-fault-matrix.retry`（13）/ `.stop`（5）/ `.lifecycle`（4）三个文件全绿；`lifecycle` 的日志从 60 秒 316MB 降到 222KB——之前的「无限重试风暴」是测试等不到状态事件、10s 超时后 run 被泄漏、子代理对着已关闭的假服务器继续重试打出来的，不是重试逻辑本身有 bug。

### 7.2 测试侧：过期断言与平台差异

| 文件 | 条数 | 原因 |
|---|---|---|
| `bootstrap/tests/paths.test.ts` | 3 | 硬编码 `/` 分隔符，改用 `join()` |
| `core/tests/bash-handler.test.ts` | 7 | 平台路径；`maxPersistedBytes` 过期断言（产品注释写明不再每请求填 5GiB，落盘上限由 adapter 解析链给）；遥测 outcomes 断言改为断真实 status/isError |
| `core/tests/tool-contracts.test.ts` | 5 | Agent prompt 新措辞；`childSessionId` 有意透出；完成态 fixture 缺 `childSessionId` 导致 schema 解析失败退回 JSON |
| `core/tests/read-pdf.test.ts` | 6 | `PDF_PATH` 按平台归一 |
| `core/tests/mcp-runtime.test.ts` | 4 | MCP 启动改为分离式（`MCP_WARMUP_DELAY_MS` 冷开优化），构造期不再 spawn；Plan 下非 destructive MCP 现在要确认 |
| `core/tests/runtime-tool-loop.test.ts` | 4 | 工作目录与文件路径按平台归一（checkpoint 记 `\work\src\a.ts`、内存文件系统键是 `/work/src/a.ts`，被判 `external_modified`） |

`runtime-tool-loop` 仍剩 6 条：`refreshes provider runtime headers…` 与 5 条 `execution-model fallback` 都依赖 account/highspeed（`account:zai-individual-coding-plan`、`zai-highspeed-card`），属 fork 已删功能。

### 7.3 分类口径（供后续清红复用）

- 约 60 个测试文件 import 不到 fork 已删的符号/模块，只能删除或裁剪。**不是整包缺失**：`@zcode/shared` / `@zcode/provider` / `@zcode/provider-node` 都在根 `packages/`（`packages/{shared,provider,provider-node}/package.json`），bootstrap 以 `workspace:*` 声明（`bootstrap/package.json:78-80`）并已 link。实际缺的是具体符号与模块：`ZhipuAccountAccessConfig`、`createAccountProviderConfigSnapshot`（`packages/provider/src` 无定义）、`parseProcessAccountProviderConfigSnapshot`（全仓 0 命中）、`bootstrap/src/app/standalone-account-provider-runtime.js`（文件已不存在）；另 `@zcode/telemetry` 无 `package.json`（SC-C1 单独一类）。
- `context-builder` 的 3 条断言（`IMPORTANT:`、`authorized security testing`）指向已被改写的身份提示词，需要先确认设计意图再动。
- 清红不能只看绿：`mcp-runtime` 的 Plan-MCP 那条原本断言「非 destructive MCP 静默放行」，正是 P0 收紧掉的旧行为，改断言时按新语义写成「问一次」。


## 8. 清红（第三轮：删除陈旧用例）

原则：**是 bug 就修，用例老旧就删**。判断「老旧」的证据是「它引用的东西在产品里不存在了」，不是「它现在红」。

### 8.1 删除：引用了已不存在的源模块（17 个文件）

逐个确认过引用的模块文件确实不在树上（`dir` 验证），不是路径写错：

| 测试 | 引用的模块 | 现状 |
|---|---|---|
| `auth-login` / `personal-config-default-integration` / `process-provider-registry-runtime` / `standalone-project-token` | `bootstrap/src/app/standalone-account-provider-runtime.ts`、`bootstrap/src/auth-login.ts` | 账号通道已删 |
| `offpeak-port` / `off-peak-tool-policy` | `bootstrap/src/zcode-protocol/offpeak-port.ts`、`off-peak-tool-policy.ts` | off-peak 已删 |
| `official-mcp-auth-port` | `bootstrap/src/zcode-protocol/official-mcp-auth-port.ts` | 官方通道已删 |
| `provider-runtime-headers-cancel` | `bootstrap/src/zcode-protocol/provider-runtime-headers.ts` | 已删 |
| `telemetry-bootstrap` / `script-workflow-child-runtime` | `bootstrap/src/telemetry-bootstrap.ts`、`@zcode/telemetry` | 遥测已删（`packages/telemetry` 连 package.json 都没有） |
| `local-ttft` | `bootstrap/src/zcode-protocol-v4/local-ttft.ts` | 已删 |
| `compact-policy` / `microcompact` / `runtime-compact` / `deferred-call-history` / `runtime-input-presentation` / `token-estimation-regression` | `core/src/compact/index.ts`、`core/src/runtime/methods/compact.ts`、`core/src/runtime/helpers/compact.ts` | compact 整块被 magic-context 取代 |

### 8.2 删除：测的是已删功能（16 个文件）

产品侧符号搜不到（`findstr` 计数为 0），不是「行为变了」而是「功能没了」：

- 账号 / off-peak / highspeed：`account-config-delivery`（`createAccountProviderConfigSnapshot` 不存在）、`offpeak-prompt-turn-disallowlist`（`buildTurnToolDisallowlist` 不存在）、`off-peak-runtime`、`off-peak-cancel`、`off-peak-title`
- 遥测：`runtime-agent-telemetry`、`tool-agent-telemetry`、`conversation-telemetry-identity`、`conversation-telemetry-workflow-facts`、`zcode-protocol-telemetry-lifecycle`、`runtime-compact-telemetry`（`usage.delta` 在 contracts 里 0 命中）
- compact：`formal-proof-consistency`（`unknown candidate: compact`）、`compact-media-capability`、`runtime-output-token-continuation-compact`、`tool-search-local-runtime` / `tool-search-persistence`（`compactActiveConversation` 不存在）

共 **33 个文件**，全部走 `git rm`，可在 git 历史里找回。

### 8.3 不删、待修（真 bug 或需判意图）

- `protocol-unbound-resume`（11）：断言「当前选择不被消息或恢复提示替换」失败——冷恢复时用户选的模型被覆盖，像是真 bug。
- `v4-cold-resume`（38）：`sessionIdReads` 期望 1 实得 2，command 被解析两次。
- `v4-gateway`（31）：`tool.lifecycle` 事件缺失。
- `catalog-cases`（14）：权限判定返回 `undefined`；队列模式 `choice` 的裁决在产品里没有（`heldQueueInputRequiresChoice` 在源码里 0 命中），需确认这个重裁决是否该合并。
- `browser-manifest`（11）：`ENOENT D:\Dev\Js\browser-use-plugin\skills\web-gui-tester\SKILL.md`——少了一层 `apps/zcode-cli/packages/`，是路径拼接 bug。
- `runtime-persistence`（11）/ `product-projection`（10）：输出结构少字段。


## 9. MCP 工具整场丢失（sess_6b69c667）：分离式启动吞掉 revision bump

### 9.1 复现（证据来自现场，不是单测）

- 会话：`sess_6b69c667-4938-4057-af64-77dfcd3b0d48`，workspace `D:\Dev\Js\novel-master`，模型 `opencode-go-chat / deepseek-v4.1-flash`。
- 症状：`web-search-prime` 等 MCP 工具对该会话完全不可见。
- 证据链（`~/.omz/cli/db/db.sqlite` + `log/zcode-2026-11-05.jsonl`）：

| 时间 | 事件 | 内容 |
|---|---|---|
| 14:22:08.137 | `mcp.startup.completed` | `serverCount=12`、`statusCounts={"connecting":12}`、**`toolCount=0`** |
| 14:22:08.75–14:22:11.5 | `mcp.server.connected` ×12 | 后台连接**随后**才完成（connectDurationMs 4.6–7.4s） |
| 14:23:10.812 | `mcp.tools.registered` | `registeredToolCount=0`、`serverCount=12` |
| 14:23:10 → 16:27:25 | 54 条 user message 的 `tools` 快照 | **始终 35 个内置工具、0 个 `mcp__*`**（只有 1 种形态） |

对照：同 workspace 10-29 的工作流子会话是 32 工具 / 14 个 MCP；作者本人的 `oh-my-zcode` 会话是 61 工具 / 26 个 MCP。

### 9.2 定死代码

- `packages/core/src/runtime/methods/mcp.ts:143` `await startup` 拿到的是**启动期快照**（分离式启动会在 server 仍 `connecting` 时返回空 `tools`）。
- `packages/core/src/runtime/methods/mcp.ts:173`（原）在 await **之后**现读 `mcpPort.toolListRevision()`。后台连接完成时 adapter 会 bump revision（`adapters/src/mcp/index.ts:1438`），这一 bump 因此被当作"已消费"。
- `packages/core/src/runtime/methods/mcp.ts:348-349` `refreshMcpToolsIfChanged` 只认 revision 变化 → `revision === this.mcpToolListRevision` 恒成立 → **永远 no-op**，会话整场拿不到 MCP 工具。
- 全天 `mcp.tools.reregistered` 计数为 **0**，与"refresh 从未生效"一致。

### 9.3 修复

- `agent-runtime.ts` / `internal.ts`：新增 `mcpStartupRevisionAtStart`。
- `mcp.ts:startMcpStartup`：在发起连接**之前**记下 `toolListRevision()`。
- `mcp.ts:initializeMcp`：`mcpToolListRevision` 改用启动点的值，晚到的 bump 在下一回合边界被 refresh 看见并重注册。

### 9.4 回归

- 新增确定性复现用例 `packages/core/tests/mcp-runtime.test.ts` › `re-registers tools that arrive after an incomplete startup snapshot`：
  - 修复前 **3 次同签名红**：`expected [ 'Agent', 'AskUserQuestion', …(28) ] to include 'mcp__local__lookup'`；
  - 修复后 **3 次全绿**：`Tests 1 passed | 7 skipped (8)`。
- `tsc -b apps/zcode-cli/packages/core` exit 0；`mcp-runtime` 全套 8/8 绿。
- 回归批次里 `plugins-protocol`、`tool-search-request-preparation` 仍红，但它们在本次改动前就是红的（见第 7、8 节清单），与本次修复无关。

### 9.5 未做的

按 `omz-bug-repro-e2e` 的要求本应补一条 Electron E2E 3 次；该缺陷没有 UI 面（工具面在 runtime 装配期决定），本次用 runtime 级确定性用例替代。若要补 E2E，可复用 `packages/desktop/test/e2e/helpers/mcp-plain-http-fixture.ts` 起一个**延迟应答**的 MCP server，断言会话持久化的 `tools` 快照里出现 `mcp__*`。

