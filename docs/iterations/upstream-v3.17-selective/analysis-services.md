---
date: 2026-11-04
title: 上游 v3.16.2 → v3.17.2 Services/Desktop/Shared/Server 区域缺陷修复与性能优化候选
upstream_base: 3c5b2276（v3.16.2）
upstream_target: v3.17.2（a9fe401e）
fork_head: main @ 36bc100f（omz v1.1.3）
scope: packages/services/src、packages/desktop/src、packages/shared/src、packages/server/src、packages/client、packages/rpc、packages/provider*、packages/zcode-server-cli、config/provider、scripts（仅构建/打包/发布缺陷）、packages/desktop/scripts
---

# Services/Desktop/Shared/Server 区域分析

## 0. 口径与结论

- 只统计 `packages/*/test/**`、`*.test.*`、`*.spec.*`、`e2e` 以外的源码；文档单列为包内 `*.md`（CONTRACT/README），不含 `docs/`。
- 上游 v3.17.1 删除的约 1500 个 `packages/*/test` 单测属于开源导出裁剪，未计入候选。
- 判定依据：diff hunk 能读出「旧行为错误 → 新行为正确」，或上游工单/注释给出用户可感知症状；纯新增能力、纯重构、纯测试、纯文案不进候选。
- fork 交集用 `git diff --name-only 3c5b2276 main -- <path>` 判定；「fork 现状」用工作区源码核对，不只看文件名。
- 远程产品线甄别结论：fork 仍保留 SSH/WSL/Docker 远程 workspace（`packages/server/src/remote/create-backend.ts`、`packages/desktop/src/main/desktopWslTargetResolver.ts`）与旧 Source 连接管理器（`packages/desktop/src/host/index.ts:3399` 实例化并注册 `ISourceServerManagementService`）；fork 下线的是 source-server R3 新架构、web-remote relay v2、data-sync。因此 `packages/server/src/remote/**`、`packages/server/src/source-server/**`（被 `createSourceServerTransportAdapter` 使用）、`sourceServerConnectionManager` 的缺陷修复按活路径处理；只属于 R3/relay v2/data-sync 的新功能排除。
- 结果：**42 个候选（bugfix 39，其中 SVC-B14 兼具性能收益；perf 3）**，另有 3 项因依赖 electron-builder 26.17 升级列为「跳过」。其中 16 项需要人工融合（fork 已改过同文件或同文件部分区域），其余可直接重放。

## 1. 区域规模

`git diff --numstat 3c5b2276 v3.17.2 -- <scope>` 聚类（行数为增/删）：

| 区域 | 源码文件 | 源码 +/- | 测试文件 | 测试 +/- | 包内文档 | 文档 +/- |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| packages/services | 102 | +6483 / -2048 | 34 | +28 / -3969 | 8 | +80 / -3 |
| packages/desktop/src | 79 | +5194 / -760 | 12 | +0 / -876 | 7 | +41 / -2 |
| packages/desktop/scripts + electron-builder.config.js + package.json | 38 | +1769 / -174 | 9 | +285 / -9 | 0 | 0 |
| packages/shared | 82 | +5707 / -279 | 8 | +62 / -564 | 8 | +56 / -1 |
| packages/server | 15 | +469 / -128 | 0 | 0 | 0 | 0 |
| packages/client | 6 | +70 / -21 | 7 | +0 / -1561 | 0 | 0 |
| packages/rpc | 6 | +67 / -27 | 8 | +0 / -1445 | 0 | 0 |
| packages/provider | 3 | +24 / -12 | 23 | +0 / -7068 | 0 | 0 |
| packages/zcode-server-cli | 19 | +805 / -250 | 31 | +120 / -5684 | 0 | 0 |
| config/provider | 3 | +2292 / -85 | 1 | +2281 / -85 | 0 | 0 |
| scripts | 25 | +1944 / -5462 | 14 | +872 / -71 | 0 | 0 |
| **合计** | **378** | **+24824 / -9246** | **147** | **+3648 / -21332** | **23** | **+177 / -6** |

补充：

- `scripts` 的源码增删被 `scripts/architecture/upstream-snapshot.json`（+1202 / -5284）主导；剔除后约 +742 / -178。
- `config/provider` 的 +2292 几乎全部是 `zcode-builtin.json` 的内置模型目录扩充（新增模型/模板），属于产品数据更新，不是候选。
- 测试侧的 -21332 行绝大部分是上游删除单测（开源导出裁剪）；其中 `provider`（-7068）、`zcode-server-cli`（-5684）、`services`（-3969）最集中。

## 2. 候选表

「fork 改过」= 该文件在 `3c5b2276..main` 有改动，移植需人工融合。「红线」= fork 四条红线（遥测、magic-context、原生压缩、品牌）是否受影响。

| ID | 类型 | 一句话问题 | 上游文件 | fork 改过 | 红线 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SVC-B01 | bugfix | 配置写入方把损坏/读失败的 `config.json` 当空对象整文件写回，冲掉 MCP/插件/命令等其他字段；写入非原子、权限随 umask | services/fs/atomicFileUtils.ts、commandsService.ts、hooksService.ts、skillsService.ts、settingsSyncService.ts；desktop/main/mcpUserDirectory/index.ts | 部分（atomicFileUtils 未改） | 无 | M | 取 |
| SVC-B02 | bugfix | 目录 `readdir`/`stat` 永久不返回时，每次重试再占一个 libuv 线程，4 次后本进程所有文件操作卡死 | services/file/fileService.ts、services/project/index.ts | 否 | 无 | S | 取 |
| SVC-B03 | bugfix | 远端项目目录 `readdir` 无截止时间，且截止不 abort admission；重试叠加占满远端 Core 线程池 | desktop/host/remoteWorkspacePreparation.ts、shared/source-server/errorCodes.ts | 否 | 无 | M | 取 |
| SVC-B04 | bugfix | 纯 trailing debounce 下持续写入永不刷新；`fs.watch` 绑定已移走 inode 仍把旧目录事件冒充原路径 | services/fileWatcher/fileWatcherService.ts | 否 | 无 | M | 取 |
| SVC-B05 | bugfix | 合并轮多条 `task-notification` 只解析第一条；失败任务跨块读到下一条 `result`，后续任务无终态 | shared/background-task-notifications.ts、services/zcode-agent/zcodeTaskServiceAdapter.ts | shared 否；adapter 大改 | 无 | M | 适配后取 |
| SVC-B06 | bugfix | 用户主动中断（`completedInterrupted`）仍生成未读红点，必须切走再切回才清 | services/zcode-agent/zcodeTaskIndexSyncer.ts | 是 | 无 | S | 取 |
| SVC-B07 | bugfix | 定时任务派发回写无条件写 `active/enabled=1`，把派发窗口内刚暂停的任务复活 | services/session/automationRepo.ts | 是 | 无 | S | 取 |
| SVC-B08 | bugfix | 事件订阅抛错（如终端已结束）逃逸为未捕获异常，整个 Host 退出；订阅失败没有独立错误帧，监听器与活动请求不释放 | rpc/channels.shared.ts、channelServer.ts、channelClient.ts | 否 | 无 | S | 取 |
| SVC-B09 | bugfix | RPC 错误透传白名单丢 `profileId`，远程安装确认后只能拿无凭据 target，报 SSH 认证失败 | rpc/channelServer.ts、channelClient.ts | 否 | 无 | S | 取 |
| SVC-B10 | bugfix | 远端命令被信号杀死/无 exit-status 时 `code=null` 被当 0 成功，下载/解包/update 失败静默 | server/remote/closeEvent.ts、ssh-backend.ts、wsl-backend.ts、docker-backend.ts | docker 是；其余否 | 无 | S | 取 |
| SVC-B11 | bugfix | SSH 认证中 dispose 后 ssh2 既不 ready 也不 error，`ensureConnected` 永不结束，设备永久「连接中」 | server/remote/ssh-backend.ts | 否 | 无 | S | 取 |
| SVC-B12 | bugfix | 2FA 提示被误判为密码错误、重复密码被误判为 2FA；keepalive 超时报成握手超时 | server/remote/sshAuth.ts、ssh-backend.ts | 否 | 无 | S | 取 |
| SVC-B13 | bugfix | WSL 身份探测走 `bash -lc`，profile echo 污染 distro/user，之后每次连接报 distro 不存在；失败被永久缓存 | server/remote/wsl-backend.ts、wsl-detect.ts | 否 | 无 | M | 取 |
| SVC-B14 | bugfix/perf | Docker 每条 exec 重复 `docker version/ps`，冷启动耗尽 10s probe 预算；失败原因只剩「未检测到 Docker」 | server/remote/docker-backend.ts、docker-detect.ts | docker 是 | 无 | S | 取 |
| SVC-B15 | bugfix | probe 输出不完整时把空 PLATFORM/INSTALLED 当事实，误报平台不支持并覆盖安装状态；旧 glibc 硬拒已有服务；Windows shell 报错被当预检失败 | server/source-server/sourceServerProbe.ts | 否 | 无 | M | 适配后取 |
| SVC-B16 | bugfix | SSH 用户名含冒号时 remote identity 解析失败，连接准入/目录状态误报身份非法 | shared/remote-workspace-identity.ts | 否 | 无 | S | 取 |
| SVC-B17 | bugfix | 连接日志脱敏不认 `unix://npipe://tcp://`，docker daemon 报错被 Windows 盘符规则吞到行尾 | shared/source-server/connectionLog.ts | 否 | 无 | S | 取（低） |
| SVC-B18 | bugfix | 手机 attachment 白名单仍含 SkillSync/PluginSync，RPC 层可直接导入写配置；McpSync 同步方法未按方法限制 | desktop/host/windowHostAttachmentRpcPolicy.ts | 是 | 无（手机 replayable 保留） | S | 取 |
| SVC-B19 | bugfix | Source 连接：握手 close 竞态把已关闭连接发布为 online / sibling close 拆掉健康连接；复用 stale probe 不拉起 daemon；换 target 后旧 SSH 会话泄漏；不可解密凭据卡整批重连 | desktop/host/sourceServerConnectionManager.ts、sourceServerDirectory.ts | 否 | 无（旧 Source 路径仍接线） | L | 适配后取 |
| SVC-B20 | bugfix | 首次 Provider 同步未完成时重复 connect 被拒「尚无可用 renderer attachment」 | desktop/main/desktopRemoteSessions.ts | 是 | 无 | S | 取 |
| SVC-B21 | bugfix | 远程 bind 失败的错误 `code/retryable` 跨 contextBridge 丢失；fork 在 preload 还原仍会丢 | desktop/preload/index.ts、renderer/src/desktopPlatform.ts、shared/platform.ts | 是 | 无 | S | 取 |
| SVC-B22 | bugfix | 通用「另存为」拒绝 0 字节文件，用户无法保存空文件 | desktop/main/desktopSaveFile.ts | 否 | 无 | S | 取 |
| SVC-B23 | bugfix | macOS 系统应用 `.icns` 为全透明占位时返回透明 PNG，菜单图标空白；每次查询重复起 `osascript` | desktop/main/editors.ts | 否 | 无 | S | 取（低） |
| SVC-B24 | bugfix | Windows 遮挡检测残留：Alt-Tab/focus 后画面停最后一帧；主窗口 `window.open` 绕过管控；嵌入浏览器下载被当加载失败 | desktop/main/desktopWindowChrome.ts | 是 | 无 | M | 取 |
| SVC-B25 | bugfix | 附件 URL 未提交页面却写入 `cachedUrl`，每次 rebind 重复下载；human tab 切走后后台反复请求 rebind | desktop/main/browserView/browserGuestManager.ts | 是 | 无 | M | 适配后取 |
| SVC-B26 | bugfix | Docker 容器内数字 UID 无 passwd 条目，`userInfo()` 抛错阻断 Core ready | server/http.ts、zcode-server-cli/src/server-core/http.ts、shared/node.ts | 两处 http 是 | 无 | S | 取 |
| SVC-B27 | bugfix | `getClient` 返回已 dispose 的 client；进程回收无屏障可并发清理/再 spawn | services/zcode-agent/zcodeAgentProcessManager.ts | 是 | 无 | M | 适配后取 |
| SVC-B28 | bugfix | Windows autocrlf 工作区 CRLF lockfile 被误判与安装快照不一致，构建失败且重装无效 | scripts/third-party-npm.mjs | 否 | 无 | S | 取 |
| SVC-B29 | bugfix | node-pty 预编译目录整目录 force 覆盖 / 只塞 pty.node，JS 与 native 版本混装，macOS/Linux resize 必失败 | scripts/zcode-distribution/assets.mjs、zcode-server-cli/src/packaging/stageDependencies.ts | 否 | 无 | M | 取 |
| SVC-B30 | bugfix | macOS 顶层 `electronLanguages` 用 `en-US/zh-CN`，匹配不到 `en.lproj/zh_CN.lproj`，Chromium 文案全被删 | desktop/electron-builder.config.js | 是 | 无 | S | 取 |
| SVC-B31 | bugfix | 旧模型配置迁移丢 `templateId` 后无 logo；补展示素材 | provider/src/resolver.ts | 是 | 无 | S | 取（低） |
| SVC-B32 | bugfix | 远端锁只凭 PID 判活：PID 复用/容器或 WSL 重启后残留锁被判活；共享 home 两台主机互相接管活锁；macOS `ps lstart` 受 TZ 影响 | zcode-server-cli/src/runtime/lock.ts | 否 | 无 | M | 取 |
| SVC-B33 | bugfix | Core 事件循环卡死但进程仍在时 status 一直 ready；Core 启动失败原因被退出码覆盖 | zcode-server-cli/src/supervisor/supervisor.ts、contracts.ts | 否 | 无 | M | 取 |
| SVC-B34 | bugfix | daemon 运行中 server root 被删除/替换后，旧 Supervisor 继续往新 root 写 ready 快照，后续读 token 全失败 | zcode-server-cli/src/supervisor/supervisor.ts、runtime/statusSnapshot.ts | 否 | 无 | M | 取 |
| SVC-B35 | bugfix | systemd `enable --now` 失败无法区分装载/启动阶段，装载失败也不回退 detached，SSH 每次重连都失败 | zcode-server-cli/src/platform/serviceManager.ts、cli.ts | 否 | 无 | M | 取 |
| SVC-B36 | bugfix | 同一 archive 强制重装时，磁盘内容偏离完整性记录被当冲突，永远无法重装，只能手删 `releases/<id>` | zcode-server-cli/src/runtime/immutableRelease.ts | 否 | 无 | M | 取 |
| SVC-B37 | bugfix | `serve --daemon` 10s 等待短于 Supervisor 15s Core ready 预算；复用 starting Supervisor 返回 `port:null`；放弃等待后慢 fallback 仍会取锁 ready | zcode-server-cli/src/cli.ts、contracts.ts | 否 | 无 | M | 取 |
| SVC-B38 | bugfix | 远端 Core 缺 `ZCODE_APP_VERSION`，Agent 请求头报 CLI 包版本 0.17.0，按客户端版本拦截的网关会拒绝 | zcode-server-cli/src/server-core/core.ts | 否 | 无 | S | 取 |
| SVC-B39 | bugfix | Windows 上 `spawn("pnpm")` 不经 shell 无法解析 `.cmd` shim，e2e onPrepare 的 `prepare:remote-assets` 直接 fatal | zcode-server-cli/src/packaging/stageRemoteAssetsCli.ts | 否 | 无 | S | 取 |
| SVC-P01 | perf | RPC 二进制序列化先走 `toJSON`，Buffer 被展开成 `{type:"Buffer",data:[...]}`，体积约 3.6 倍、单跳十几秒、>28MB 超 WS 上限 | rpc/serialization.ts | 否 | 无 | S | 取 |
| SVC-P02 | perf | 同一 protocol 上 ChannelClient/ChannelServer 对每条消息体各解码一次，反向端白解码 | rpc/channelClient.ts、channelServer.ts | 否 | 无 | S | 取 |
| SVC-P03 | perf | 远端项目每次 readTree/prepareSession 对每个路径重复 `resolveWorkspace`，多一次 SSH 往返 + 远端两次开库 | services/project/index.ts、desktop/host/index.ts | project 否；host 是 | 无 | M | 取 |
| SVC-X01 | bugfix/perf | electron-builder 26.17 收集器把 sharp 全平台变体打进 asar（约 110MB），非 PE 送签导致 Windows 签名链 0x8010006a | desktop/scripts/packaged-platform-dependency-prune.mjs、desktop-native-package-policy.mjs、sign-windows-hook.cjs、electron-builder.config.js | 部分 | 无 | M | 跳过（升级 26.17 时取） |
| SVC-X02 | bugfix | 26.17 打包契约：`allowMissingDependencies:false`、electron-updater 闭包、macOS LICENSE 源目录、dmg 隐藏文件、Builder env 隔离 | desktop/electron-builder.config.js、scripts/bundle.mjs、macos-update-manifest.mjs | 是 | 无 | M | 跳过（升级 26.17 时取） |
| SVC-X03 | perf | 26.17 工具镜像预检/镜像 404 回退/HTTP 授权隔离 | scripts/verify-electron-builder-binaries-mirror.mjs、scripts/electron-builder-binaries-macos.json、bundle.mjs | 是 | 无 | M | 跳过（升级 26.17 时取） |

## 3. 候选详述

### SVC-B01 用户级 `config.json` 写入加固

- **旧行为**：命令、钩子、技能、迁移导入（MCP/插件目录）以及 Desktop MCP 设置页在写 `~/.zcode/cli/config.json` 前用宽松读取，读失败/JSON 损坏/根节点不是对象都当空对象，再用 `writeFile` 整文件写回；结果是 MCP、插件、命令、技能等其他字段被冲掉，且写入非原子、权限跟随 umask。
- **新行为**：新增 `updateJsonObjectFile`（严格读取 + 写前重读 + 只改自己的字段 + 同目录临时文件 rename + 0600）；损坏时抛 `JsonObjectFileUnreadableError`，字节保持不变；迁移导入的插件目录在登记失败时回滚本次放入的目录，避免修好配置后重试被判 `targetExists`。
- **证据**：`docs/issues/data-sync/01-harden-user-config-writers.md`（Status: done，验收项逐条勾选）；目标 `packages/services/src/fs/atomicFileUtils.ts:293`（`updateJsonObjectFile`）、`commandsService.ts:113`、`hooksService.ts:291`、`skillsService.ts:558`、`settingsSyncService.ts:1105`、`packages/desktop/src/main/mcpUserDirectory/index.ts:241`。
- **移植要点与风险**：`atomicWritePrivateTextFile` 在 fork 的 `@zcode/shared/node` 已导出（`packages/shared/src/node.ts:19`），可直接用；fork 已改过 hooks/commands/skills/settingsSync/mcpUserDirectory，需按函数替换而非整文件覆盖。并发限制（读与替换之间无锁）上游明确不解决，不要额外加锁。

### SVC-B02 本地目录读取永久挂起占满 libuv 线程

- **旧行为**：`IFileService.readdir` 直接 `readdir`；项目树 `readPrimaryRootStatus` 直接 `stat`。目录在 macOS 等授权、网络盘无响应时永久不返回，每次重试/重连再占一个 libuv 线程，默认 4 个线程耗尽后本进程所有文件操作都不再返回。
- **新行为**：同一路径已有在途读取且超过阈值时复用该 Promise，不再占新线程；返回后立即删除，不缓存结果。`fileService` 用 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS`（30s）判定无响应；项目主目录 stat 用 30s 截止，超时返回 `unavailable`。
- **证据**：工单 `ZCT-2113660144497782784`（目标文件注释）；`packages/services/src/file/fileService.ts:235`（`readDirectoryEntries`）、`packages/services/src/project/index.ts:63`（`readPrimaryRootStatus`）。
- **移植要点与风险**：`fileService` 需要 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS`，与 SVC-B03 同一常量，建议一起取；健康目录不会触发阈值，行为不变。注意 `projectPrimaryRootStatuses` 原按目录去重，改造后由 `readPrimaryRootStatus` 复用，不要双重去重。

### SVC-B03 远端 workspace 目录准备超时与重试复用

- **旧行为**：`prepareRemoteWorkspaceIdentity` 对远端 `readdir` 的等待没有截止时间，连接一直停在「启动并检查兼容性」；即使外层截止，也只是结束 Desktop 等待，远端那次调用仍占着 Core 的一个 libuv 线程，用户每次重试再发一次，4 次后远端线程池占满。
- **新行为**：增加 30s 截止并抛 `remote-workspace-directory-unresponsive`（可重试）；截止时 abort 本次 admission（合并调用方 signal），避免截止后仍登记身份；同一连接/同一路径的读取复用 in-flight Promise，返回即删。
- **证据**：目标 `packages/desktop/src/host/remoteWorkspacePreparation.ts:21`（`readWorkspaceDirectory`）、`:50-63`（deadlineController）；`packages/shared/src/source-server/errorCodes.ts` 新增 `REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE` 与 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS = 30_000`。
- **移植要点与风险**：fork 没有新增的 `REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE` 与 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS`，需要先补 shared；`prepareRemoteWorkspaceIdentity` 在 fork 未改，可直接重放。Main 的 bind 兜底（`desktopRemoteSessions`）当前 30s，需要按 SVC-B20/上游改为 `timeout + 10s`，否则仍是 Main 先报「附着已取消」。

### SVC-B04 file watcher 持续写入不刷新与 rename 身份失效

- **旧行为**：只有 trailing debounce（150ms），低于间隔的持续写入会不断重置定时器，订阅者永远收不到刷新；`rename` 事件没有身份校验，目录被移走后 `fs.watch` 仍绑定旧 inode，旧目录事件被冒充成原路径事件。
- **新行为**：增加独立的 1s max-wait（不随事件重置），保证长写入期间周期性通知；记录创建时的 `dev/ino/isDirectory`，rename 收口时 `stat` 一次比对，失效时发一次最终刷新并关闭 watcher；flush 增加 `flushing/flushRequested` 串行化，避免检查期间新事件被旧批次清掉。
- **证据**：目标 `packages/services/src/fileWatcher/fileWatcherService.ts:119`（maxWaitTimer）、`:30`（`sawRename`）、`:210`（`targetIdentity`）。
- **移植要点与风险**：fork 未改该文件，可直接重放；新增可注入的 `watchFactory/statPath/debounceMs/maxWaitMs` 是为单测，保留。注意 `stat` 必须跟随符号链接，与 `fs.watch` 绑定的解析目标一致。

### SVC-B05 后台任务通知合并轮解析

- **旧行为**：一条消息可能是多条 `<task-notification>` 合并；旧解析只在整段文本里取第一个匹配，失败任务没有 `<result>` 时会读到下一条通知的 `<result>` 当失败原因，后面的任务也拿不到终态；`tool_call_update` 每条消息只产出一条，合并轮只更新一个工具；失败详情在合并轮为空。
- **新行为**：按 `<task-notification>` 块逐条解析，每块只读块内标签；`originMeta.subagentResult`（仅单块时）提供结构化终态与失败原文；`parseZCodeBackgroundTaskNotifications` 返回数组，适配层逐条产出 `tool_call_update`；新增 `zcodeBackgroundTaskNotificationFailureText`（error → result → summary）。
- **证据**：目标 `packages/shared/src/background-task-notifications.ts:31`；`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3509`（`backgroundTaskNotificationToolUpdatesFromInput`）、`:4009`。
- **移植要点与风险**：fork 的 `subagentResultMetaSchema` 不存在（属于 v4 workflow-row-meta 新增），第一步可只移植「按块解析 + 数组化 + failureText」，`originMeta` 部分待验证；fork 的 `zcodeTaskServiceAdapter` 已大改（-367 行），且 UI `packages/ui/src/lib/zcodeSessionProjection.ts:1292` 也在用旧单条解析，跨区域改动要一起评估。

### SVC-B06 主动中断仍产生未读红点

- **旧行为**：`resolveTerminalUnreadSignal` 对 `completedInterrupted` 返回 `background_terminal`，用户主动停止/打断/新建对话后任务仍出现未读红点，必须切走再切回才清。
- **新行为**：`completedInterrupted` 直接返回 `undefined`，不制造未读；任务状态仍收口为 `completed`。
- **证据**：目标 `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts:185`；fork 当前 `:192` 仍是 `(completedSuccess || completedInterrupted) && ...`。
- **移植要点与风险**：fork 该文件已改过（+30 行），按函数替换；只影响未读信号，不动终态映射。

### SVC-B07 定时任务派发回写复活已暂停任务

- **旧行为**：`markDispatched` 无条件写 `lifecycle_status='active'`、`enabled=1`。scheduler 回写与 Host 侧暂停跑在两个独立连接上，用户/自暂停在派发窗口内落下的 `paused` 会被回写复活。
- **新行为**：同一条 UPDATE 用 `CASE` 按行当前值判定（SQLite SET 表达式读更新前的旧值）：completed 优先收口；否则 `enabled=0` 的行保持原 lifecycle/enabled，只记录本次派发；其余回 active。
- **证据**：目标 `packages/services/src/session/automationRepo.ts:987`（`markDispatched`）及 `:1016-1030` 的 CASE；fork `:990` 仍是 `lifecycle_status = @lifecycle_status`、`:1002` 无条件 `enabled=1`。
- **移植要点与风险**：fork 该文件只差 1 行改动，融合成本低；`pause()` 方法本身是 v3.17 新增（CronPauseSelf），不必一并取；只取 `markDispatched` 的 CASE 即可覆盖 UI 暂停场景。

### SVC-B08 RPC 事件订阅抛错逃逸导致 Host 退出

- **旧行为**：`ChannelServer.onEventListen` 直接调用 `channel.listen(...)`，已结束的终端等资源拒绝迟到订阅时异常逃逸为未捕获异常，可能退出整个 Host；协议没有订阅失败的错误帧，客户端订阅失败后监听器与活动请求也不释放。
- **新行为**：新增 `ResponseType.EventError`；Server 捕获 `listen` 异常，回独立失败帧（不写入正常事件流）；Client 收到后删除 handler、`activeRequests`、`dispose` emitter，并把错误打到 console。
- **证据**：目标 `packages/rpc/src/channels.shared.ts`（`EventError = 205`）、`channelServer.ts:232`、`channelClient.ts` 的 `onResponse` 分支。
- **移植要点与风险**：协议新增消息类型，旧客户端 `onBuffer` 的 switch 无 default，会忽略未知类型，向后兼容；fork 未改 rpc，可直接重放。注意 `ChannelServer` 的 `activeRequests` 在异常路径不能登记。

### SVC-B09 RPC 错误透传白名单丢 `profileId`

- **旧行为**：`ChannelServer`/`ChannelClient` 把 Error 序列化时只透传 `message/name/stack/code/details/taskId/traceId/retryable`；Host 的远程等待点（需要安装/升级、补凭据）用 `profileId` 指明实际操作线路，丢失后侧栏项目只能把不含凭据的 target 交给向导，确认安装后报「SSH 认证失败」。
- **新行为**：白名单增加 `profileId`，Server 序列化与 Client 还原两侧同步。
- **证据**：目标 `packages/rpc/src/channelServer.ts:152/172`、`channelClient.ts:98-110`；fork 的白名单只有到 `retryable`。
- **移植要点与风险**：纯字段透传，无协议版本影响；与 SVC-B19 的远程凭据修复配套，单独取也能改善错误定位。

### SVC-B10 远端退出码 null 被当成功

- **旧行为**：SSH/WSL/Docker 三套 backend 都写 `code ?? 0`；进程被信号杀死时 `code` 为 null，ssh2 通道没有 exit-status 时 close 也不带 code，于是被 `kill -9` 的下载、解包、update 都被当成成功。
- **新行为**：新增 `resolveRemoteExitCode(code, signal)`：有 code 用 code；有 signal 按 shell 惯例返回 `128 + 信号值`；完全没有退出信息返回 255（与 OpenSSH 一致）。三套 backend 的 exit/close 全部改走它。
- **证据**：目标 `packages/server/src/remote/closeEvent.ts:51`；fork `docker-backend.ts:213/216`、`ssh-backend.ts:310/316/396/399`、`wsl-backend.ts:370/373` 仍是 `code ?? 0`。
- **移植要点与风险**：fork 未改 closeEvent/ssh/wsl，可直接重放；docker-backend 已被 fork 改过，需按行融合。注意 `ssh2` 的 `close` 回调签名在类型上允许 `(code?, signal?)`，与现有类型定义对齐。

### SVC-B11 SSH dispose 期间在途连接永不结束

- **旧行为**：ssh2 收到服务端 banner 后，认证完成前 `dispose()` 调 `end()`，ssh2 既不发 ready 也不发 error，还清掉 60s readyTimeout；`ensureConnected` 只等 ready/error，Promise 永不结束。启动重连 10s 超时释放 backend 后，设备一直「连接中」，后续手动连接都 join 到这个死 flight。
- **新行为**：`ensureConnected` 登记 `failPendingConnect` 失败出口；`dispose()` 立即让它失败并摘掉 ready/error 监听，manager 的 catch/finally 写回 `failed` 并移除 flight。删掉「释放后 ready 迟到」的不可达分支。
- **证据**：工单 `docs/issues/remote-tickets-3-16-2-1022/02-startup-reconnect-cancel-hangs-ssh-flight.md`（Status: done，工单 ZCT-2112827425880723456）；目标 `packages/server/src/remote/ssh-backend.ts:108/217/644`。
- **移植要点与风险**：fork 未改，可直接重放；上游明确不采用 ssh2 `close` 事件判定（同一 Client 重连时旧 close 可能晚到），不要自行改方案。

### SVC-B12 SSH 2FA 与 keepalive 超时分类

- **旧行为**：`createKeyboardInteractiveResponder` 用「多于一个提示/一轮」当二次验证证据，重复问 Password 的主机输错密码也被判成 2FA，UI 失去补密码入口；计数挂在 backend 生命周期上，自动恢复重连时第一轮提示就被误判。`normalizeSSHConnectError` 把 keepalive timeout 与握手超时都写成「握手超时」。
- **新行为**：只认提示文字（verification code/OTP/2FA/MFA/动态口令等）并回调标记；responder 不再保存状态；认证失败时若本轮有额外验证提示，返回带 `remote-authentication-unsupported` 公开码的专用错误。`established` 为 true 的 `client-timeout` 报「约 60 秒没有心跳响应」，不再报握手超时。
- **证据**：目标 `packages/server/src/remote/sshAuth.ts:101`（`normalizeSSHConnectError`）及 `:54-100`（responder）；`ssh-backend.ts:119`（传入 `established/additionalVerificationPrompted`）。
- **移植要点与风险**：fork 未改，可直接重放；需要 shared 新增 `remote-authentication-unsupported` 公开码（与 SVC-B15 同一批）。

### SVC-B13 WSL 身份探测污染与失败缓存

- **旧行为**：身份探测用 `bash -lc` 并按行解析，profile 里的 `echo` 先于身份输出，被当成 distro/user 写进设备 Profile，此后每次连接都报「未找到名为 … 的 WSL distro」；`resolvedInfoPromise` 失败也被永久缓存，长生命周期 backend 一直复用失败结果。
- **新行为**：改用 `bash --noprofile --norc -c` + 哨兵行，只取哨兵后的 distro/user/HOME；distro 以 `wsl -l` 列表为准（大小写不敏感），列表不可用才用 distro 内上报名；`isValidWslUser` 校验 user；失败时清空 `resolvedInfoPromise` 允许下次重探；`createWslExecError` 在 stderr 为空时带 stdout 与退出码。
- **证据**：目标 `packages/server/src/remote/wsl-backend.ts:57`（`WSL_IDENTITY_COMMAND_ARGS`）、`:551`；`wsl-detect.ts:39`（`createWslExecError`）。
- **移植要点与风险**：fork 未改，可直接重放；`isValidWslUser` 来自 `@zcode/shared`，fork 已有？若没有需一并补（检查 `packages/shared/src` 的 wsl 校验）。风险低，属于纯探测路径。

### SVC-B14 Docker 可用性探测重复与原因丢失

- **旧行为**：Source probe 内每条 Docker exec 都重复执行 `docker version`，首次解析 container/home 又重复 `docker ps`；冷启动峰值下四五个 CLI round-trip 让单个本地 Docker Source 在真正 probe 前耗尽 10 秒预算。失败经 `isDockerAvailable` 只剩「未检测到可用的 Docker 环境」，无法区分未安装、daemon 未启动、socket 权限不足。
- **新行为**：Backend 生命周期内只探测一次 daemon（失败清空 promise 允许显式重试）；新增 `probeDockerDaemon()` 保留 CLI 原始原因，`ensureAvailable` 把原因拼进错误并标 `remote-connection-unknown`（避免文本被错误分类）；新增 `diagnoseExecFailure()`，仅在 exec 非零退出后重新探测一次，区分「daemon 不可用」与「命令自身失败」。
- **证据**：目标 `packages/server/src/remote/docker-backend.ts:269`（`diagnoseExecFailure`）、`:286-306`（`ensureAvailable`）；`docker-detect.ts:166`（`probeDockerDaemon`）；`sourceServerProbe.ts:158` 调用 `backend.diagnoseExecFailure?.()`。
- **移植要点与风险**：fork 的 docker-backend 已改过，需融合；`IRemoteBackend` 新增可选方法，旧 backend 不受影响。

### SVC-B15 Source probe 不完整输出误判

- **旧行为**：probe 脚本 `set +e` 加末尾 `printf` 会把 `uname` 失败覆盖为退出 0，空 PLATFORM/ARCH 被当「系统不支持」；退出 0 不保证脚本执行完整，缺失 INSTALLED 被当未安装并覆盖已有 Source 的安装状态（ZCT-2114700808714715136）。旧 glibc 检查把系统 glibc 报告当拒连依据，连已有服务也无法尝试连接。Windows OpenSSH 默认 shell 是 cmd/PowerShell，固定 `/bin/sh` 无法启动，只报「远端环境检查失败」并把 GBK 乱码当原因。
- **新行为**：`uname -s || exit $?`、`uname -m || exit $?`；在唯一探测边界校验 PLATFORM/ARCH/ROOT/INSTALLED/END 完整性，不完整直接报错；glibc 过旧/musl 改为 warning 并继续连接；识别明确的 Windows shell 报错并抛 `remote-platform-unsupported`；Docker 传输失败先 `diagnoseExecFailure` 再归类。
- **证据**：目标 `packages/server/src/source-server/sourceServerProbe.ts:175-182`（invalidFields）、`:156-171`（Windows shell / diagnose）；`docs/electron` 无直接工单，注释含 ZCT-2114700808714715136。
- **移植要点与风险**：fork 的 `sourceServerProbe` 未改，但依赖 `createUnsupportedRemotePlatformError`、`diagnoseExecFailure`、`REMOTE_WORKSPACE_*` 等新符号；`warnUnsupportedLibc` 需要 `TransportContext.onLog`。建议与 SVC-B03、SVC-B10、SVC-B14 作为「远程连接修复组」一起取。

### SVC-B16 SSH 用户名含冒号导致 identity 解析失败

- **旧行为**：`parseRemoteWorkspaceIdentity` 按单个冒号截断 SSH 身份段；SSH 用户名可能含冒号，截断后连接准入和目录状态读取误报身份非法。
- **新行为**：SSH 第三段（绝对路径前）以 `":/"` 收口，保留用户名与完整身份字符串，不改凭据或存量键。
- **证据**：目标 `packages/shared/src/remote-workspace-identity.ts:135`；fork 仍是 `const next = rest.indexOf(":", cursor)`。
- **移植要点与风险**：纯解析修复，fork 未改，可直接重放；注意只对 `kind === "ssh" && i === 2` 生效，其他 kind 保持单冒号。

### SVC-B17 连接日志脱敏吞掉 Docker 原因

- **旧行为**：脱敏规则不认 `unix://`、`npipe://`、`tcp://`；`unix:` 里的 `x:/` 又被 Windows 盘符规则当成路径开头，一直遮到行尾，用户看不到 "Is the docker daemon running?" 这类原因。
- **新行为**：URL 规则扩展到 `unix|npipe|tcp`，按 URL 整体遮蔽并保留后续正文；`redactUnquotedPath` 额外放行 `: connect: no such file or directory|connection refused|permission denied` 三种明确诊断。
- **证据**：目标 `packages/shared/src/source-server/connectionLog.ts:53` 及 `:1-12`。
- **移植要点与风险**：只影响日志，fork 未改，可直接重放；低优先，但与 SVC-B14/B15 的远程排障配套。

### SVC-B18 手机 attachment 同步通道写入

- **旧行为**：`WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS` 仍含 `SkillSync`、`PluginSync`；手机端没有同步 UI，但 RPC 层导入方法仍可调用，能写本机配置。`McpSync` 整通道放行，同步方法也能被手机调用。
- **新行为**：白名单移除 `SkillSync`/`PluginSync`；`McpSync` 保留通道但用 Proxy 按方法放行（`loadMcpFromUserDirectory`/`saveMcpToUserDirectory`/`listWorkspaceMcpServerStatuses`/`setWorkspaceMcpTrust`），其余（含未来新增方法）返回 `feature_disabled`。
- **证据**：工单 `docs/issues/data-sync/02-block-sync-channels-on-mobile.md`（Status: done）；目标 `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts:89`（`MOBILE_MCP_SYNC_ALLOWED_METHODS`）、`:108`。
- **移植要点与风险**：fork 已有显式 allowlist（`windowHostAttachmentRpcPolicy.ts:52/54` 仍含 SkillSync/PluginSync），改动很小；`setWorkspaceMcpTrust` 是 v3.17 新方法，fork 没有该能力时不要放进允许集。桌面 `desktop-continuous` 不受影响。

### SVC-B19 Source 连接管理器竞态、泄漏与坏凭据

- **旧行为**（同一文件四个独立缺陷）：
  1. close 事件只按 `sourceServerId` 路由，并用在线表是否存在做守卫；握手落盘期间连接关闭时，在线表要么为空（事件被丢弃，随后把已关闭连接发布为 online），要么指向同 Source 的另一条健康连接（sibling 的 close 拆掉在线 owner 并清掉它的重试）——RV-P1-1。
  2. probe 只凭 `status.json` 为 ready 且 Core PID 能 `kill -0` 就复用端口；远端重启后快照残留、PID 被同用户进程复用、端口已无人监听，握手报 socket hang up 且一直不拉起 daemon。
  3. Adapter 按 target 对象缓存会话，只在连接中止或 Host 释放时关闭；显式断开、停止、恢复意图换 target 以及一次性操作结束后都没有释放，停止远端服务后本机仍连着设备。
  4. `~/.zcode` 换机/换用户后，已有 Profile 的密码解不开；连接、启动重连、补凭据、编辑、删除直接读取并上抛，一个坏 Profile 卡住整批启动重连，Source Directory 整体不可用，侧栏连同本地项目一起为空。
- **新行为**：close 只认当前这次握手（`liveHandshake`/`attempt`），发布前只记录关闭事实、发布后按连接身份处理；复用 probe 握手失败时回退一次 `serve --daemon`，由 Supervisor 实时状态接管残留锁；`releaseTargetTransport` 在 target 持有者结束时统一释放会话；`loadUsableCredential` 把「本机无法解密」视为「无可用值」，只跳过该来源，其他 IO/损坏错误仍失败回滚。
- **证据**：目标 `packages/desktop/src/host/sourceServerConnectionManager.ts:1311`（`onHandshakeClose`）、`:1349`（`reusedProbeStatus` 回退）、`:1504/1571`（`releaseTargetTransport`）；`packages/desktop/src/host/sourceServerDirectory.ts:1310`（`loadUsableCredential`）。文档：`docs/architecture/r3-source-server-remote-architecture.md`、`docs/issues/remote-startup-failures-3-16/01-source-server-startup-failure-triage.md`。
- **移植要点与风险**：fork 未改这两个文件，但上游同一 diff 混入了 stop/restart/downgrade 新功能（`lifecycleOperationFlights`、`expectedDisconnectOperation`、`registerLifecycleOperation`）。**只摘上述四个 hunk**，不要整文件重放；`loadWarn` 是 fork 需要的注入点（fork 的 manager options 是否有 `logWarn` 待验证）。成本 L，建议与远程连接组一起排期。

### SVC-B20 远程重复 connect 在首个 attachment 前被拒

- **旧行为**：Main 先把新 route 放入 `routesBySessionId`，再等 `registration.initialSync`，随后才创建 renderer attachment；此窗口内合法的重复 connect 会找到 route，却因 attachment 尚不存在被立即拒绝，页面停留本地并报「远程 workspace route 尚无可用 renderer attachment」。
- **新行为**：route 增加 `initialAttachmentReady`，首连阶段重复 connect 等待同一个首连结果（同成同败），不再直接拒绝；`workspaceBindReadyTimeoutMs` 改为 `REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS + 10_000`，确保 Host 的 30s 截止先报具体原因，Main 兜底只处理 Host 完全不应答。
- **证据**：工单 `docs/issues/e2e-promotion/04-remote-join-before-renderer-attachment.md`；目标 `packages/desktop/src/main/desktopRemoteSessions.ts:82/418/551/598`。
- **移植要点与风险**：fork 该文件已改过，需按 route 字段与两处 `attachRendererPort` 调用融合；依赖 SVC-B03 的常量。

### SVC-B21 远程 bind 错误码跨 contextBridge 丢失

- **旧行为**：`ipcMain.handle` 返回结构化 `BindRemoteWorkspaceSessionContextIpcResult`，但 fork 在 preload 里 `unwrapRemoteWorkspaceBindResult` 后 `throw`；Error 跨 contextBridge 会丢失自定义 `code/retryable`，renderer 只剩 message。
- **新行为**：preload 原样返回结构化结果；`unwrapRemoteWorkspaceBindResult` 移到 `@zcode/shared`，由 renderer 的 `desktopPlatform` 调用并还原 `code/retryable`。删除 `preload/remoteWorkspaceBindBridge.ts`。
- **证据**：目标 `packages/shared/src/platform.ts:675`、`packages/desktop/src/preload/index.ts:294-296`、`packages/desktop/src/renderer/src/desktopPlatform.ts:47`；fork 的 preload 仍在抛错（`packages/desktop/src/preload/remoteWorkspaceBindBridge.ts` 存在）。
- **移植要点与风险**：fork 已实现同一逻辑但层次错误，属「已修一半」；改动小，但要同步 `IPlatformService.bindRemoteWorkspaceSessionContext` 的返回类型与所有调用方。

### SVC-B22 另存为拒绝 0 字节文件

- **旧行为**：`desktopSaveFile` 对 `data.byteLength === 0` 直接返回 `invalid_file_payload`，通用「另存为」无法保存空文件（远程下载仍单独拒绝空响应）。
- **新行为**：删除通用零字节拒绝，只保留大小上限；远程下载路径继续单独拒绝空响应。
- **证据**：目标 `packages/desktop/src/main/desktopSaveFile.ts:195-200`；fork `:203` 仍是 `if (data && data.byteLength === 0) return invalid_file_payload`。
- **移植要点与风险**：fork 未改，可直接重放；确认调用方没有依赖「零字节=非法」的语义（UI 侧应已允许空文本保存）。

### SVC-B23 macOS 应用图标全透明占位

- **旧行为**：`.icns` 只判断 `isEmpty()`，图书等系统应用的 `AppIcon.icns` 是全透明占位，会被当成功返回透明 PNG，菜单 `<img>` 加载成功、通用兜底也不显示，结果是空白图标位；每次查询都为每个候选应用重复起 `osascript`。
- **新行为**：`isFullyTransparent` 检查 BGRA alpha，全透明时视为没有 `.icns`；回退到 NSWorkspace（可读 `Assets.car`），失败再回退 `app.getFileIcon`；按 bundle 路径缓存 Promise，并发共享，失败/空结果移除缓存。
- **证据**：目标 `packages/desktop/src/main/editors.ts:590`（`isFullyTransparent`）、`:633`、`:680`（NSWorkspace 结果校验）。
- **移植要点与风险**：fork 未改，可直接重放；`osascript -l JavaScript` 依赖 macOS 系统组件，超时 5s，失败要回退而不是抛错。

### SVC-B24 窗口残帧、主窗口 popup、嵌入浏览器下载

- **旧行为**：
  1. Windows Chromium 遮挡检测把被完全覆盖的窗口标记 occluded 并停止提交帧；部分 Intel 核显驱动组合下 Alt-Tab/点通知/点窗口只触发 focus，不触发 show/resized，画面停在最后一帧。
  2. 文档渲染库直接 `window.open` 绕过 DOM 链接检查，主窗口会创建未经管控的原生子窗口。
  3. 嵌入浏览器 `loadURL` 遇到下载响应会以 `ERR_FAILED` 拒绝，被当成网络失败。
- **新行为**：`focus` 时执行与 resize/show 相同的有界双帧重绘；主窗口 `setWindowOpenHandler` 只允许 http/https，合法外链转给现有 Browser 路由，其余 deny；guest session 监听 `will-download` 并向宿主发送 `BrowserViewDownloadStarted`，用真实下载事件区分网络失败。
- **证据**：目标 `packages/desktop/src/main/desktopWindowChrome.ts:269`（focus）、`:385`（will-download）、`:643`（主窗口 handler）；工单 ZCT-202610-E0C5B48D（注释）。
- **移植要点与风险**：fork 该文件已改过，需按三个独立 hunk 融合；`BrowserViewDownloadStarted` 需要 preload/renderer 同步新增（上游在 `packages/desktop/src/preload/index.ts`、`packages/shared/src/platform.ts` 有对应类型），若只取 focus 修复可先不做下载链路。

### SVC-B25 浏览器 guest 重复下载与后台 rebind 循环

- **旧行为**：
  1. `restoreGuestState` 在附件 URL 触发下载、页面未提交时仍把未提交 URL 写入 `cachedUrl`；每次 rebind 都再下载一次。
  2. `requestGuestRebind` 对 human tab 也请求 rebind；Ready 是 Browser Use 事件，renderer 会在当前 workspace 为同一 tabId 新建隐藏 shell 并恢复页面，切走 workspace 后在后台反复请求附件 URL。
  3. `releaseGuestCdpAfterIdle` 异步释放，scope release 时无法等待 CDP 真正 detach；human tab 释放归属时丢失 `controlScopeId`。
- **新行为**：restore 后回落到 `guest.getURL()` 的已提交 URL（`about:blank` 置空）；human tab 直接 `return false`，由 shell 重新挂载 attach 时恢复；`releaseGuestCdpAfterIdle` 改为可等待并在 `requireReleased` 时抛错，scope release 等它完成；释放归属保留当前 `controlScopeId`。
- **证据**：目标 `packages/desktop/src/main/browserView/browserGuestManager.ts:4024-4025`（committedUrl）、`:4224`/`:4232`（`isUserOwnedTab`）；`docs/issues/e2e-promotion/15-browser-guest-destroyed-on-task-switch.md` 是同一区域的待办记录（Status: needs-triage，不能当作已修证据，仅作背景）。
- **移植要点与风险**：fork 该文件已改过（含大量 browser control 新功能），只摘 `cachedUrl` 与 `isUserOwnedTab` 两个独立 hunk；`releaseGuestCdpAfterIdle` 的 async 化牵动 scope 释放流程，建议单独评估。

### SVC-B26 Docker 数字 UID 无 passwd 条目

- **旧行为**：Server/Core 的 `ServerRemoteInfo.identity.osUser` 直接 `userInfo().username`；Docker 里以数字 UID 运行、passwd 无对应条目时 `userInfo()` 抛 `ENOENT (uv_os_get_passwd)`，阻断 Core ready。该字段只用于展示。
- **新行为**：新增 `resolveServerOsUser()`，捕获该特定错误并返回 `uid:<euid>`，其他系统错误继续抛出；`packages/server/src/http.ts` 与 `zcode-server-cli/src/server-core/http.ts` 都改用它。
- **证据**：目标 `packages/shared/src/node.ts:8-29`、`packages/server/src/http.ts:194`、`packages/zcode-server-cli/src/server-core/http.ts:228`。
- **移植要点与风险**：fork 的 `server/http.ts` 与 `zcode-server-cli/src/server-core/http.ts` 都已改过，需按行融合；新增函数无副作用，低风险。

### SVC-B27 进程管理器返回已释放 client / 回收无屏障

- **旧行为**：`getClient` 只判断 `existing && !existing.child.killed`，client 已 dispose 时仍返回，后续请求全部失败；`cleanupManagedProcessWithRetry` 没有 in-flight 屏障，restart/exit 回调/主动回收可并发进入同一进程的清理，或在清理期间再 spawn 第二棵进程树。
- **新行为**：`getClient`/`getRuntimeClient` 增加 `!existing.client.isDisposed`；`cleanupManagedProcessWithRetry` 用 `closing` Map 按 processKey 登记 in-flight 屏障，清理完成后再清 binding；`restartWorkspaceProcess` 同时从 `ownedProcesses` 找待回收进程。
- **证据**：目标 `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` 的 `closing`/`publishAvailable`/`getClient`；fork `:825` 仍是 `if (existing && !existing.child.killed)`，`:776` 无屏障。
- **移植要点与风险**：fork 已改过该文件（80/59），且上游 diff 与「shared task runtime」新功能强耦合（bindings/processKey）。**只摘 `isDisposed` 检查**可作为独立小修；`closing` 屏障需要连同 `processKey` 抽象一起评估，否则半移植会引入新的并发窗口。

### SVC-B28 Windows CRLF lockfile 误判

- **旧行为**：`assertProductionGraphs` 把 `pnpm -r ls --lockfile-only` 与安装树对比，并用原始字符串比较根 `pnpm-lock.yaml` 与 `node_modules/.pnpm/lock.yaml`；Windows autocrlf 工作区根 lockfile 是 CRLF、安装快照是 LF，依赖图一致也被判「安装快照过期」，重装无法消除。
- **新行为**：`assertInstalledLockfileSnapshot` 先统一 `\r\n → \n` 再比较；依赖图读取改为按唯一 workspace 名逐个 `pnpm --filter <name> list --prod --json --depth Infinity`（`NPM_CONFIG_LOCKFILE_ONLY=true`），避免 pnpm 10.33.2 递归 list 在 Windows 打开整个 workspace 超出命令上限。
- **证据**：目标 `scripts/third-party-npm.mjs:145`（`assertInstalledLockfileSnapshot`）、`:166`（`createPnpmLockfileOnlyEnv`）、`:207`；fork `:145` 仍是旧 `assertProductionGraphs`。
- **移植要点与风险**：fork 未改，可直接重放；这是构建/发布脚本，需在 Windows 工作区实测 `pnpm licenses` 链路。低风险。

### SVC-B29 node-pty JS 与 native 版本混装

- **旧行为**：
  1. `scripts/zcode-distribution/assets.mjs` 的 `patchNodePtyPrebuilds` 把平台包 `prebuilds` 整目录 `cp(..., { force: true })` 到官方 node-pty；平台包是 1.2.0-beta.10（resize 要 5 个参数），官方 JS 只传 3 个，macOS resize 必然失败。
  2. `zcode-server-cli/src/packaging/stageDependencies.ts` 只在 `pty.node` 不存在时塞平台包的 pty.node；桌面 Linux 打包的 beforePack 会把平台包 pty.node 回填进共享 workspace node-pty，staging 复制到这份文件后旧逻辑跳过整包替换，JS 1.1.0 + native 1.2.0-beta.10 混装，Linux 终端每次 resize 抛 Usage。
- **新行为**：desktop 侧按平台目录逐个复制，目标平台已存在则跳过，不整目录覆盖；server-cli 侧 Linux 无条件整包替换为平台包（含 `lib/index.js`），其他平台保持官方自带 prebuild，并新增 `assertNodePtyNativeMatchesJs` 构建守卫（JS 与 native 版本必须一致）。
- **证据**：目标 `scripts/zcode-distribution/assets.mjs:194-205`、`packages/zcode-server-cli/src/packaging/stageDependencies.ts:185`（守卫）、`:237`。
- **移植要点与风险**：fork 两处都未改，可直接重放；`zcode-server-cli` 的 staging 逻辑与桌面打包共享 workspace，需同时验证 macOS/Linux 产物。注意 server-cli 侧要求平台包自带 `lib/index.js`。

### SVC-B30 macOS 语言包匹配失败

- **旧行为**：顶层 `electronLanguages: ["en-US", "zh-CN"]` 被 builder 按语言包文件名精确匹配；macOS 是 `en.lproj`/`zh_CN.lproj`，一个都匹配不上被全部删掉，Chromium 自带文案丢失（视频控件菜单只剩图标、播放速度子菜单空白）。
- **新行为**：`mac.electronLanguages: ["en", "zh_CN"]`，Windows/Linux 继续用顶层 `en-US/zh-CN`。
- **证据**：目标 `packages/desktop/electron-builder.config.js:607-608`、`:869`；fork `:464` 只有顶层，`mac` 段无覆盖。
- **移植要点与风险**：fork 的 electron-builder 26.8.1 也按文件名匹配，问题同样存在；fork 配置文件已大改，按 mac 段新增一行即可。低风险。

### SVC-B31 模型 Provider logo 缺失

- **旧行为**：旧版模型配置迁移可能只保留 API 地址、缺 `templateId`；`effectiveProviders` 只按 `templateId` 取模板，导致这些 Provider 没有 logo（展示缺失）。
- **新行为**：按 `api.type + 规范化 baseUrl` 建立模板 logo 索引（同 key 多模板且 logo 不同时置空，避免猜错），只给缺 logo 的配置 `overlay({ logo })`，不补整份模板，不改模型成员/认证/请求行为。
- **证据**：目标 `packages/provider/src/resolver.ts:210-226`；fork 该文件已改过。
- **移植要点与风险**：纯展示修复，fork 已改过需融合；确认 `ProviderConfig.overlay` 语义只覆盖 logo。

### SVC-B32 远端锁 PID 复用与共享 home

- **旧行为**：`DataRootLock.isHolderAlive` 只凭 PID（PID 等于自己、`kill 0` 成功或 EPERM 都算存活）。容器/WSL 重启后进程全没了但锁文件还在，同样的启动顺序让新 Supervisor 拿到旧 PID，或旧 PID 落到其他进程上，残留锁被判活，Supervisor 每次启动都报 already running 并 exit 1。共享 home 的两台主机都把对方活着的锁判为 stale 并接管。macOS `ps lstart` 按调用进程时区格式化，写锁与检查锁 TZ 不同会把活着的持锁者判 stale。
- **新行为**：锁记录增加 `processIdentity`：Linux 用 `boot_id + /proc/<pid>/stat starttime`，macOS 用 `LC_ALL=C TZ=UTC ps -o lstart=`；身份一致才算存活；PID 等于自己时只认本进程 `heldOwnerTokens` 里的 token；旧锁无身份字段才退回 PID 判定（EPERM 视为 PID 复用，不再保守判活）。新增 `readLoss()` 供 Supervisor 判断锁是否仍属于自己。
- **证据**：目标 `packages/zcode-server-cli/src/runtime/lock.ts:559-620`（`isHolderAlive`/`readProcessIdentity`）、`:395`（`readLoss`）；文档 `docs/issues/remote-startup-failures-3-16/04-shared-home-across-hosts.md`、`06-legacy-lock-pid-reuse-after-upgrade.md`。
- **移植要点与风险**：fork 未改，可直接重放；`readLoss` 被 SVC-B34 使用，建议一起取。风险：旧锁（3.16.2 格式）仍按 PID 判定，升级后第一次连接仍可能撞锁，这是上游明确保留的兼容边界。

### SVC-B33 Core 卡死 watchdog 与启动失败原因

- **旧行为**：Core 事件循环被同步工作占满后进程仍在，但不发 heartbeat、不响应握手、执行不了 SIGTERM 处理；Supervisor 只在 Core 退出时才走 crash budget，status 一直报 ready，Desktop 回退的 `serve --daemon` 也只复用同一端口，设备只能人工 `kill -9`（ZCT-2113570821476302848）。Core 启动失败时先发 `fatal` 再退出，旧逻辑用退出码覆盖 fatal，status 只剩 `core exited code=1`，CLI 与远端都看不到原因。
- **新行为**：ready 后按 `CORE_HEARTBEAT_INTERVAL_MS` 计数，连续 `CORE_UNRESPONSIVE_HEARTBEAT_PERIODS` 个周期没有任何 IPC 消息就 `SIGKILL`，由既有退出处理按崩溃重启（只计周期、不比较时钟，Supervisor 自身被挂起时不会误判）；`coreFatalMessage` 与退出码拼进 `lastExitReason`（截断 500 字符）。
- **证据**：目标 `packages/zcode-server-cli/src/supervisor/supervisor.ts:550`（`watchCoreLiveness`）、`:441-442`（exitReason）、`:534`；`contracts.ts:24-30`（心跳常量）。
- **移植要点与风险**：fork 未改，可直接重放；需要确认 fork 的 Core 也按 `CORE_HEARTBEAT_INTERVAL_MS` 发心跳（fork `core.ts` 当前写死 10_000，数值相同但建议一并改为常量）。

### SVC-B34 server root 被替换后旧 Supervisor 继续写快照

- **旧行为**：daemon 运行中 server root 被删除或替换后，本实例的锁、control socket、Core 写的 ingress-token 都随旧目录消失，Supervisor 仍按路径把 ready 与旧端口写进新 root 的 `status.json`；probe 与 `serve --daemon` 把这份快照当成新 root 的 daemon，随后读 token 失败，OS service unit 仍 active，`start` 不会拉起新实例，每次重连都一样（ZCT-2112854001415753728）。
- **新行为**：写快照前 `ownsServerRoot()` 用 `lock.readLoss()` 确认路径上的锁仍是自己的；不是就不再写，停掉 Core 后通过 `onServerRootLost(loss)` 结束进程（missing 非 0 退出让服务管理器拉起新 owner，taken 0 退出因新 owner 已在运行）；不走 `stopInternal`，避免按路径清理新 owner 的 socket/锁。
- **证据**：目标 `packages/zcode-server-cli/src/supervisor/supervisor.ts:110-135`（`ownsServerRoot`/`stepDownAfterServerRootLost`）、`runtime/statusSnapshot.ts:42/50`（`canWrite`）。
- **移植要点与风险**：fork 未改，可直接重放；依赖 SVC-B32 的 `readLoss`，两者必须一起取。需要 `cli.ts` 处理 `onServerRootLost` 的退出码（上游在 `serve --daemon` 分支新增）。

### SVC-B35 systemd 注册阶段与 detached 回退

- **旧行为**：`systemctl enable --now` 把装载和启动合成一次调用，失败时无法知道 unit 是否已启动，调用方一律报错；服务管理器可用时旧逻辑会停掉空闲 fallback 再注册，重连时再次注册失败并重新拉起，有运行任务时直接报错，SSH 连接被阻断。能力探测只证明 user manager 的 bus 能连上，enable 由 manager 用它自己的组列表和权限判定，仍可能失败，而同一 root 的 detached fallback 能正常运行。
- **新行为**：拆成 `daemon-reload` → `enable`（stage=load）→ `start <basename>`（stage=start）；注册错误带 `stage`，`isServiceLoadFailure` 只在 load 阶段为 true；`cli.ts` 在 load 失败时改用 detached fallback 并带回原因（写入本次启动结果的 `serviceFallbackReason`，不写 `status.json`），start 阶段失败仍原样返回。
- **证据**：目标 `packages/zcode-server-cli/src/platform/serviceManager.ts:203`（`isServiceLoadFailure`）及 `:220-250`；`packages/zcode-server-cli/src/cli.ts:331/337/359-362/422`。
- **移植要点与风险**：fork 的 `serviceManager.ts` 与 `cli.ts` 均未改（`git diff 3c5b2276 main` 为空），可直接重放。风险：launchd/Task Scheduler 不带 stage，行为保持原样。

### SVC-B36 同一 archive 强制重装永远失败

- **旧行为**：`assertExistingReleaseMatches` 把「完整性记录与本次 archive 一致、但磁盘内容已偏离记录」也判成冲突；同一 archive 强制重装永远失败，用户只能手动删除 `releases/<id>`（A2）。
- **新行为**：`inspectExistingRelease` 区分 `match`/`damaged`：记录缺失或指向别的身份仍按冲突失败；记录一致但内容偏离时判 damaged，`replaceDamagedRelease` 先把损坏副本 rename 到隐藏名，再 rename 已校验的 incoming，第二步失败移回；移回也失败时抛 `AggregateError` 并保留损坏副本路径，不再吞掉（CR-01）。
- **证据**：目标 `packages/zcode-server-cli/src/runtime/immutableRelease.ts:55`（`inspectExistingRelease`）、`:100`（`replaceDamagedRelease`）、`:163-164`。
- **移植要点与风险**：fork 未改，可直接重放；依赖调用方持有 `update.lock`（上游注释明确），不要挪到无锁路径。

### SVC-B37 `serve --daemon` 等待/复用/回退收口

- **旧行为**：
  1. `serve --daemon` 等待写死 10s，短于 Supervisor 自身 15s Core ready 预算；机器繁忙时 Supervisor 冷启动实测 8～14s，CLI 先报 `Timed out waiting for Server ready`，daemon 随后照常 ready。
  2. 复用 `starting` 的 Supervisor 时立即以 `exit 0` 返回 `port:null`，Desktop 只认带端口的成功结果，报 `did not report a valid ingress port`。
  3. CLI 放弃等待后，冷启动过慢的 fallback Supervisor 仍会取锁并 ready，调用方拿到的失败与远端事实相反，update 回滚的 stop 还可能因它尚未监听 control 而够不着、随后争锁。
  4. Core 启动失败时 Supervisor 已把原因写进 status，CLI 等待失败却只报 `Timed out waiting for Server ready`。
- **新行为**：新增 `SERVER_READY_WAIT_TIMEOUT_MS = CORE_READY_TIMEOUT_MS + 10_000`；复用 starting Supervisor 时 `waitForControlReady(layout)` 等 ready 再返回；fallback Supervisor 由本 CLI fork，放弃等待时先 `SIGKILL` 并等到 exit 再报失败（OS service 不越权停止）；`describeStartupStatus` 把 status 里的 `lastExitReason` 拼进超时错误。
- **证据**：目标 `packages/zcode-server-cli/src/cli.ts:309`（reuse）、`:397/414-416`（kill fallback）、`:730/767`（deadline）、`:708`（describeStartupStatus）；`contracts.ts:23`。
- **移植要点与风险**：fork 的 `cli.ts` 与 `contracts.ts` 均未改，可直接重放；`SERVER_READY_WAIT_TIMEOUT_MS` 是纯常量新增，低风险。与 SVC-B35 同一文件，建议一起排期。

### SVC-B38 远端 Core 缺 App 版本环境变量

- **旧行为**：Agent 的模型请求头从 `ZCODE_APP_VERSION` 读 App 版本，缺失时回退到 CLI 包版本（0.17.0）。本地由 Desktop main 注入；远端 Core 由 SSH/WSL/Docker exec → Supervisor fork 拉起，整条链都没有这个 env，远端请求报 0.17.0，按客户端版本拦截的网关会拒绝。
- **新行为**：Core 启动时用自身编译期 `ZCODE_VERSION` 写入 `process.env[ZCODE_APP_VERSION_ENV]`，Agent spawn 时继承；升级时旧 Supervisor 拉起新 release 的 Core 也能生效。
- **证据**：目标 `packages/zcode-server-cli/src/server-core/core.ts:27`。
- **移植要点与风险**：fork 未改，可直接重放；确认 fork 的 `@zcode/shared` 导出 `ZCODE_APP_VERSION_ENV`（已有则无依赖）。这条对远程模型请求可用性影响直接，优先级高。

### SVC-B39 Windows 下 pnpm shim 无法被 spawn

- **旧行为**：`stageRemoteAssetsCli` 直接 `spawn(command, args)`；Windows 上 pnpm 只以 `.cmd/.ps1` shim 存在，Node 不经 shell 无法解析，`spawn("pnpm")` 直接 ENOENT，e2e `onPrepare` 自动 `prepare:remote-assets` 时 fatal。
- **新行为**：仅 Windows 传 `shell: true`，与 `wdio.conf.ts` 的 `runPnpmWorkspaceCommand` 一致；当前参数均无空格，无需额外转义。
- **证据**：目标 `packages/zcode-server-cli/src/packaging/stageRemoteAssetsCli.ts:26`。
- **移植要点与风险**：fork 未改，可直接重放；纯 Windows 构建/测试修复，低风险。

### SVC-P01 RPC 二进制序列化 Buffer 被展开

- **旧行为**：`JSON.stringify(data, encodeRpcJsonValue)` 先调用 `toJSON` 再调用 replacer；Node Buffer（Uint8Array 子类，技能/插件归档都是 gzip 产出的 Buffer）到 replacer 时已被展开成 `{type:"Buffer",data:[...]}`，不进 base64 标记：体积约 3.6 倍，每一跳解码 1500 万个数字的数组（15MB 归档单跳十几秒，渲染进程卡住），约 28MB 以上的插件还超出远端 WebSocket 单条消息 100MiB 上限；接收端拿到普通对象，归档大小检查读不到 `byteLength`。
- **新行为**：`encodeRpcJsonValue` 改为普通函数并使用 `this`（holder），按 `(this as Record)[key]` 上的原值判断 `instanceof Uint8Array`，再走 base64 标记。
- **证据**：目标 `packages/rpc/src/serialization.ts:220`；fork 未改。
- **移植要点与风险**：这是本轮收益最大的性能修复（数据同步/插件归档越大越明显），fork 即使不做 data-sync，技能/插件/附件归档仍走同一 RPC。注意 replacer 的 `this` 语义在严格模式/箭头函数下不同，必须保持普通函数。

### SVC-P02 RPC 消息体重复解码

- **旧行为**：同一 protocol 上同时挂着反向 ChannelServer/ChannelClient，对方发来的请求/响应也会到本端；`onBuffer`/`onRawMessage` 先无条件 `deserialize(reader)` 读 body，再按 type 判断，导致每条消息体被完整解码两次（反向端白解码）。大请求（例如数据同步归档）白白多花一倍 CPU。
- **新行为**：先读 header 判断 type，只在属于本端的类型分支里 `deserialize(reader)` 读 body。
- **证据**：目标 `packages/rpc/src/channelClient.ts:222`（`onBuffer`）、`channelServer.ts:69`（`onRawMessage`）；fork 未改。
- **移植要点与风险**：与 SVC-B08 同一函数，建议一起改（EventError 分支需要新的 type 判断）。纯 CPU 优化，无行为变化。

### SVC-P03 远端身份登记缓存

- **旧行为**：每次远端 `readTree`、`resolveSessionDirectories`、`prepareSession` 都对每个路径重新调用一次远端 `resolveWorkspace`；登记只写 Server Core 进程内的 stable → canonical 映射表，同一连接内重复登记不改变任何状态，却给发送前的目录解析多加一次串行 SSH 往返，并让远端每次同步打开两个 SQLite 库。
- **新行为**：`createRemoteIdentityRegistrationCache()` 按物理连接对象（`WeakMap`）缓存每个 workspacePath 的登记 Promise；映射表随 Core 进程存活且只增不删，Core 重启一定断开连接、Host 拿到新的物理连接对象，所以按连接缓存即可，不需要超时；登记失败删除缓存，下次重试。
- **证据**：目标 `packages/services/src/project/index.ts:420`（`createRemoteIdentityRegistrationCache`）；`packages/desktop/src/host/index.ts` 的 `registryProjectIdentityRegistrations`/`managerProjectIdentityRegistrations`（上游 diff）；fork 的 `host/index.ts:3258/3287` 仍是每次 `resolveWorkspace`。
- **移植要点与风险**：fork 的 `project/index.ts` 未改、`host/index.ts` 已改，需在两处 `bindRemoteProjectIdentities` 调用点接入；Registry 路径带 Host 目录的 legacy hint，Manager 路径不带，上游用两个独立缓存，不要合并。远程产品线保留时收益明确（少一次 SSH 往返/路径）。

## 4. 看起来像修复但排除

| 项 | 上游文件/位置 | 排除理由 |
| --- | --- | --- |
| 任务全局搜索（`workspaceScopes === "host"`、`kind === "all"`） | services/session/taskIndexRepo.ts、desktop/host/windowHostControllerService.ts | `workspaceScopes: "host"` 是 v3.17 新增的全局搜索能力（fork 的 `workspaceScopes` 仍是数组类型），修复位于新功能内部；不属于既有行为缺陷。 |
| `automation.pause()` / CronPauseSelf | services/session/automationRepo.ts、shared/zcode-protocol/index.ts | 新增执行轮自暂停能力；`markDispatched` 的竞态修复已单列为 SVC-B07，不依赖 `pause()`。 |
| `createSession` 预分配 `sessionId` | services/zcode-agent/zcodeV4HostCommand.ts | 与新增 `session_creation_commands` 幂等回执表配套；fork 无该表，单独给 payload 塞随机 ID 不能解决跨调用重试，收益不成立（待验证）。 |
| `sessionLifecycle` / `invalidateConnectionOnTimeout` | services/zcode-agent/zcodeProtocolClient.ts、shared/zcode-protocol/index.ts | 全新 session 运行实例生命周期能力；超时不回收整个 workspace 的语义只在新能力内成立。 |
| 个性化指令保存队列/mkdir/0600 | services/setting/settingService.ts | 整个「用户自定义指令」是 v3.17 新功能（base 无 `getUserInstructions`），其中的评审修复不构成对既有行为的修复。 |
| 工作区 MCP 信任 / `environment` 别名 / `normalizeMcpStdioCommand` | shared/mcp.ts、shared/zcode-protocol/index.ts、services/zcode-agent/zcodeAgentService.ts | 工作区 MCP 信任是新产品能力；`environment` 别名与命令归一化共享是为该审核链新增，base 没有 `environment` 字段。 |
| `session_creation_commands` 迁移 | services/session/controllerRemoteIdentityMigration.ts、project-storage/schema.ts | 新表随幂等创建能力引入；fork 无此表，迁移无对象。 |
| data-sync / skill-sync / plugin-sync / mcp-sync 大重构 | services/data-sync/**、skill-sync/**、plugin-sync/**、mcp-sync/** | 新产品线（fork 已下线 data-sync）；删除的远端同步接口不属于缺陷修复。 |
| 会话遥测 / remote-sync / web-remote relay v2 / 手机推送 / 输入预测 / local-ttft / file-open-apps / browser-local-preview / gen-ui context | shared/conversation-telemetry/**、shared/remote-sync.ts、desktop/main/web-remote-relay/**、shared/zcode-protocol-v4/input-prediction/**、shared/local-ttft/**、desktop/main/file-open-apps/**、desktop/main/browser-local-preview/** | 纯新功能/新产品线；fork 已移除遥测与 relay v2，且这些文件在 fork 多不存在。 |
| Provider Provisioning lane 状态/重试 | desktop/main/providerProvisioningEnvironmentCoordinator.ts、desktopRemoteSessions.ts | 数据同步页的新只读状态与重试能力；`initialAttachmentReady` 的 join 修复已单列 SVC-B20。 |
| 闲时票据 3106 分码 | shared/off-peak-types.ts | fork 已删除闲时任务产品面。 |
| conversation-share 允许 `file:`/`data:` | shared/conversation-share-content.ts | fork 已下线会话分享；且这是放宽过滤，不是修复。 |
| 托盘未读角标删除 | desktop/main/desktopTray.ts、unreadBadge.ts | 上游文档明确 2026-10-30 产品决定移除托盘红点（任务栏 overlay + 应用内蓝点承担），属功能移除，不是缺陷修复。 |
| shared task runtime（共享本地任务运行时） | services/zcode-agent/zcodeAgentProcessManager.ts、zcodeAgentService.ts、node.ts | 全新共享进程能力；`isDisposed`/`closing` 的独立部分已单列 SVC-B27，其余绑定/分配逻辑不取。 |
| 子智能体 profile 注释变更 | shared/subagent-profile-parser.ts | 仅注释，代码行为未变（项目级剥离逻辑 base 已有）。 |
| `getWorkspaceCheckpointDirectory` 导出 | services/git/repo/gitCheckpointStore.ts | 为新增项目数据彻底删除功能抽出的路径工具，纯重构。 |
| 远端项目 `cached_deleted` / `reuseExistingRoot` / `restoreProject` / 项目数据 purge | services/project/index.ts、project-storage/** | 新产品能力（远端项目删除态缓存、按目录打开复用项目、项目数据彻底删除）。 |
| `forked_from_task_id` / `admitTaskIdentity` 继承 | services/session/taskIndexRepo.ts、project-storage/legacy-tasks.ts | 新项目数据/归属模型的一部分；fork 的 task index 已有自己的归属链，不混入。 |
| `channelReplyExecutor` 注释停用 | services/node.ts | 功能下线（渠道工具等待插件入口），不是修复。 |
| `providerRuntimeResolver` 去掉 `cc-refactor` | services/runtime-tools/providerRuntimeResolver.ts | 只影响仓库根存在历史研发目录的开发机，fork 无该目录，且无用户可感知证据。 |
| `connectViaProtocol` 增加 signal | client/src/websocket.ts | 唯一传 signal 的调用方在 `packages/web` 的 web-remote relay v2 workspace bridge（`webRemoteControlWorkspaceBridgeSession.ts`，fork 已无该文件/产品线）；fork 内 desktop/services/server 均未传 signal，无活路径证据。 |
| `conversation-telemetry` 相关的 `run.step`/远控计数 | services/zcode-agent/zcodeAgentService.ts | 遥测红线 + 新产品线。 |
| `licenses.mjs` 许可证分类调整 | scripts/licenses.mjs、license-identifiers.mjs | 为新增依赖（electron-updater/react-doctor 等）放行的构建门禁，不是缺陷修复。 |
| `build-desktop-agent-cli` 增加 zcode-site-plugin | scripts/build-desktop-agent-cli.mjs | 新官方插件构建，纯新功能。 |
| `prepare-native-search-tools` 固定来源 | scripts/prepare-native-search-tools.mjs | 依赖 v3.17 新增的 `native-search-tools-config.mjs` 产物来源机制，fork 无该模块。 |
| `stage-agent-bundle` 暂存 node-repl-host | packages/desktop/scripts/stage-agent-bundle.mjs | 仅修复 dev 环境消费旧 cache 的问题，不影响发布产物；属开发工具链，不是用户可感知缺陷。 |
| `electronVersion` 改为读 package.json | packages/desktop/electron-builder.config.js | 防版本分叉的重构，fork 当前硬编码 41.0.3 与 package.json 一致，无缺陷证据。 |
| `sign-windows-hook` 非 PE 跳过（单独看） | packages/desktop/scripts/sign-windows-hook.cjs | 根因是 26.17 收集器打入非 PE；fork 26.8.1 不产生该输入，已并入 SVC-X01 跳过。 |

## 5. 纯新功能 / 纯重构 / 纯测试（不候选）

- **纯新功能**：data-sync 全目录、conversation-telemetry、remote-sync、web-remote-relay v2（mobileLog*/mobilePush*）、手机输入预测、local-ttft、file-open-apps、browser-local-preview、gen-ui model context、provider-provisioning-status、request-security-edition、workspace MCP 信任、session 生命周期、共享任务运行时、项目数据彻底删除、个性化指令、子智能体/命令/钩子数据同步通道、MCP `environment` 兼容导入、远端服务 stop/restart/downgrade（RDLC-01）、远端项目删除态缓存、`reuseExistingRoot`。
- **纯重构/接口整理**：`localTtft.ts` → `local-ttft/contract.ts`、`ProjectRepository` 实现拆分、`ProjectDataRepositoryContract`、`sourceServerOperationLogs` 多操作文案表、`accessor/index/node` 的注册与导出整理、`compatibilityManifest` 版本常量、`subagent-profile` 注释、`electronVersion` 读取方式。
- **纯测试/测试基建**：v3.17.1 删除约 1500 个 `packages/*/test` 单测（开源导出裁剪）；`scripts/engineering-tests`、`scripts/architecture/*`、`check-push-worktree`、`check-stale-doc-phrases`、`verify-electron-builder-binaries-mirror`（26.17 专属）、`e2e-*` 脚本与 fixture、`conversation-docker-plan`、`r3-remote-spec-inventory`。
- **纯文档**：`docs/**`（包括 `docs/issues/**`、`docs/electron/**`、`docs/desktop/**`、`docs/remote/**`）全部不计入；本报告只把它们当证据。
- **产品数据**：`config/provider/zcode-builtin.json`（+2245/-85）与 `zcode-builtin.test.json`（+2281/-85）是内置模型目录扩充。

## 6. 待验证与缺口

1. **SVC-B05 的 `originMeta.subagentResult`**：fork 没有 `subagentResultMetaSchema`。需要确认 fork 的 `message.info.metadata.originMeta` 是否已有等价结构；没有则先只取「按块解析 + 数组化 + failureText」，`originMeta` 部分留待 v4 row meta 一起移植。
2. **SVC-B19 的 `logWarn` 注入点**：上游在 `SourceServerConnectionManagerOptions`/`SourceServerDirectoryOptions` 增加 `logWarn`；fork 的 options 是否有等价 logger 需核对（fork 未改该文件，可能没有）。若没有，先补一个可选 logger，不要用 console。
3. **SVC-B27 的 `closing` 屏障**：与 shared task runtime 的 `processKey/bindings` 强耦合；只摘 `isDisposed` 检查是安全的，完整屏障需评估 fork 的 `processesByWorkspaceKey` 是否仍是一 workspace 一进程（是，则 barrier 的收益主要是防 restart/exit 双清理，可单独设计）。
4. **SVC-B29 的 server-cli staging**：需要确认 fork 的 `@lydell/node-pty-<target>` 平台包是否自带 `lib/index.js`（上游新守卫要求）；若没有，只能取 desktop 侧「按平台目录复制、不覆盖」的一半。
5. **SVC-B30 的 26.8.1 行为**：上游文档只写了 26.17 的收集器差异；macOS `electronLanguages` 文件名匹配是 builder 通用行为，但建议在 fork 的 mac 打包产物里实际检查 `locales/*.pak` 数量后再落。
6. **SVC-X01/X02/X03**：fork `packages/desktop/package.json` 声明 `electron-builder ^26.8.1`、lockfile 固定 26.8.1，26.17 的收集器/工具镜像/许可布局缺陷当前不复现；只有决定升级 builder 时才取，且必须与 Electron 升级一起验证。
7. **远程产品线假设**：本报告把 `packages/server/src/remote/**`、`packages/server/src/source-server/**`、`sourceServerConnectionManager` 视为活路径（已核对 import/实例化）。若后续确认 fork 的远程 workspace 入口也要下线，则 SVC-B03/B10/B11/B12/B13/B14/B15/B16/B17/B19/B20/B21/P03 可整体降级为「跳过」。
