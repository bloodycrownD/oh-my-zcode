# oh-my-zcode 项目持久规则

## 项目结构

- `omz/` 是 fork 主仓（git，分支 dev/phase-0；tag 链 baseline/v3.14.3 → phase1/telemetry-removed → phase1/cr-fixed → phase2a/magic-context-mvp）。上游参照源只读放 `.reference/`（ZCode 快照、magic-context 源码）。
- 迭代编排状态在 `docs/.iteration-state.yaml`；证据与报告落 `docs/iterations/oh-my-zcode-fork/cache/`；主 spec 是 `docs/iterations/oh-my-zcode-fork/spec.md`（35 步 4 阶段）。
- docs/ 在 omz 仓库**外**（父目录非 git 仓），报告类文件不需要提交。

## 工具链（Windows 坑）

- 一律用便携 Node：`set "PATH=D:\Dev\Js\oh-my-zcode\omz\node_modules\.bin;D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64;%PATH%"`。nvm 的 node 22 会被 pnpm shim 优先选中并报 engine 警告（无害）；直接 `node`/`node:sqlite` 必须确认是 24。
- PowerShell `ConvertFrom-Json`+`ConvertTo-Json` 会重排 package.json——改依赖边用 node 字符串手术插入。
- 控制台中文乱码是显示层问题；写文件用 node 或 Write 类工具保证 UTF-8+LF（.gitattributes 已有 *.ts/*.json eol=lf 兜底）。**严禁用 PowerShell `Get-Content`+`[IO.File]::WriteAllText` 往返改无 BOM 的 UTF-8 中文文件**——PS5 默认按 ANSI 读，往返即双重编码永久损坏（CR 期间曾毁掉 fix-spec，靠上下文全量重写恢复）；必须用 `-Encoding UTF8` 或干脆用编辑工具。
- rg 多个排除 glob 组合会静默返回零结果——用 git grep；`%ERRORLEVEL%` 链式回显是解析期展开假象。
- tsc 命令行文件模式在本仓需 `--ignoreConfig`（tsconfig 存在时 TS5112）；tsc 报错在 stdout 不在 stderr。
- `apps/zcode-cli` 有**自己的 oxfmt**：根 .prettierignore 整条忽略该子树，须在 `apps/zcode-cli` 目录下跑包内 oxfmt；其 `format:check` 基线本就红（~1285/1403），判据=改动文件**零新增**不合规。编辑类工具写文件会落 CRLF——改完 apps/zcode-cli 下文件必须复核并归一 LF（.gitattributes `* text eol=lf` 兜底）。
- Windows `echo` 重定向写 JSON 会把引号写坏（单引号进文件）——写 config/JSON 一律用 node `writeFileSync`。
- **严禁 `git worktree add` + `mklink /J` 挂主仓 node_modules 后再 `git worktree remove --force`**——Windows 上强制删除会穿透 junction 损坏主 node_modules 的 .pnpm 链接（症状：per-package deps 突然 resolve 不到，如 magic-context 的 zod）。修复=`pnpm install --prefer-offline`。knip 基线对比改用符号级 grep 或在 worktree 内完整 `pnpm install`。

## 门禁口径

- 真门禁：根 `pnpm typecheck`（0 err）、根 `pnpm lint`（**71w/0e** 为真基线）、`cd apps\zcode-cli && pnpm typecheck`（turbo 全 successful）、knip（判据=与前一提交 stash 对比零新增 + 零 magic-context 命中）、`pnpm --filter @zcode/cli build`、oxfmt（改动文件零新增不合规；src/core/ 移植件豁免以保持与上游可 diff）。
- **CLI turbo lint 不是门禁**：根 .oxlintrc ignorePatterns 含 apps/zcode-cli（基线即如此），CLI lint 在基线就是红的（contracts 多个 max-lines 400）。
- 桌面门禁是差分模式：`node scripts/typecheck-desktop-full.mjs`（无新增错误即可）。

## agent 派遣纪律（用户明确要求）

- **长任务一律后台派（run_in_background，立即拿 agentId）+ TaskOutput(block=true) 阻塞等待**——等效同步，且网络闪断后可 SendMessage 续同一 agent（保留其上下文），不要重派新 agent。
- 同步 agent 失败时**不返回 agentId**，无法续——所以别用纯同步派长任务。
- 并发派：同一条消息发多个 Agent 调用即并发。前提是作用域切分到不相交文件集；仓库级门禁（turbo build/typecheck、pnpm install、lockfile、knip.json）收口归主代理统一跑。
- 网络闪断期给 agent 下 **WIP 检查点纪律**（每内聚块一个 wip 提交），恢复从最后检查点继续。
- 并发 agent 的 `git commit` **必须带 pathspec 或独占作用域**（曾发生无 pathspec 提交卷走兄弟暂存，事后 reset --soft 拆分修复）。

## magic-context 包硬约束

- `hidden-completion-executor` 的 `SidecarModelCallOptions.preserveProviderStreamBoundaries` 是**必填字面量 true**（编译期强制；漏传则 compact_stream_boundary 不发、tool-call 提交判定静默失准）。S25 更名旁路原语时不得破坏此链。
- `src/core/` 是上游逐字移植件：不重排不改风格，fork 适配点一律写 FORK 注释块登记（源位置/上游语义/ZCode 差异/改动面）。已登记的重要偏离：data-path 重定向、migrations 跳 v85/v87、transform 首 pass usage 的 hostProcessLifetime、raw-message 单读单权威（两半边 mc<N> vs msg_* 两套词汇表禁止混读）。
- deferred/ 缝模式：后续步骤的模块先逐字摘录声明进 `src/core/deferred/`（头注 FORK-DEFERRED(Sxx)），真身落地时删缝改指。现存 23 条 FORK-NOT-PORTED（E 组/Batch2/不搬层）。
- E2E 隔离：用户级 config 路径硬编码 `~/.zcode/cli/config.json` 不受 `ZCODE_STORAGE_DIR` 重定向——开 flag 用项目级 `<cwd>/.zcode/config.json`；`ZCODE_LOG_DIR` 与 `MAGIC_CONTEXT_DB_DIR` 需显式设。绝不写用户真实 ~/.zcode。
- magic-context 包的 `options.db ?? openDefaultDatabase()` 默认会打开用户真实 `~/.zcode/cli/db/magic-context.db`——任何新调用点/测试必须显式传 db 或加 nullish 防护（S30 曾因此误写用户库一行，已删已防护）。
- `features.magicContext` 默认 **true**（D-11 已于 Step 28 执行翻转，tag `phase2b/compact-removed`）；off 仅表示"transform 直通、无预算管理"（T-M8 显式退路）。
- 分发/SEA 约束（S35 系）：① `@zcode/magic-context` 在 cli esbuild external 名单里，分发产物靠 `sea-tui-assets.mjs` 的 staging 落 `agent/node_modules/**`——给它加新包时种子必须进 **deferred 队列**（进首轮 BFS 会把它的 zod4 抢 `node_modules/zod` 根位、挤掉 contracts 的 zod3，破坏 zod-to-json-schema peer 解析）；② Node SEA 的 `require()` 只解析内置模块，裸说明符（含 staging 落盘的包）在 SEA 里永远 `ERR_UNKNOWN_BUILTIN_MODULE`——要加载须按 `sea-playwright-runtime.ts`/`tui-runtime-loader.ts` 范式走显式路径加载层；③ 本机 cmd 里 `set VAR=x` 与 `%VAR%` 不能同行（解析期展开假象，终验曾因此误建真实 ~/.omz）。

## 产品方向（用户拍板 2026-10-05）

- **桌面 Electron 是唯一重要的用户面**：「zcode 重要的就是这个 electron，tui 没有用」。TUI 不是目标用户面；桌面 UI 是验收面——CLI 层测试不能替代桌面实机验收（本轮 historian 下拉 bug 就漏在 CLI 层全绿之下）。/ctx-* 命令已于 2026-10-05 接入桌面 composer（ctx-desktop 提交链：实现下沉 bootstrap/ctx-commands + v4 命令通道 + 目录白名单 + UI 拦截，toast 呈现）。
- 免登录完整使用（2026-10-05 落地）：纯外部 API 用户不再被 WelcomeScreen 强制选 family（门禁条件收窄为「未登录且无可用 provider」）；验收时曾出现「合成输入对 v4 composer 无效」——execCommand 只改 DOM 不改编辑器 model，旧草稿会被恢复，合成键盘 Enter 会被 slash 面板消费为「选中」；驱动该 composer 需谨慎，勿再依赖 execCommand。
- 设置页交互语义：**自动保存**（用户拍板「为什么不是自动保存？」）——不留 保存/放弃 按钮；失败 toast + 回滚到上次成功态。

## 桌面 UI 实机验证方法（2026-10-05 教训）

- **不要用 computer-use 操作真实鼠标键盘做 UI 验证**：①Radix DropdownMenu/SubTrigger 靠 pointerdown/pointerenter，AX 合成 click 不触发 React 合成事件；②合成坐标点击落到真实光标处；③硬件级 SetCursorPos+mouse_event 会与用户抢输入（用户正在用电脑时冲突），且前台激活时序不稳。
- **正解：dev 模式 electron 带 Node inspector（端口 9229），`/json/list` 里 title 为 ZCode 的 ws target 就是 renderer 上下文**——Runtime.evaluate 直接跑 DOM 代码：`el.click()` 触发 React 合成事件（Switch/菜单项可点）；开 Radix 菜单需 `dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`；子菜单 SubTrigger 用 pointerenter+pointermove+click。选择器用 data-testid（菜单项 testId 携带 custom: 编码值可直接断言）。验收脚本模板见 `.cu-shots/cdp-verify-settings.mjs` / `cdp-verify-historian.mjs`（untracked，复用其结构即可）。
- 该通道还能落盘核对：UI 操作后直接读 `~/.omz/cli/config.json` 断言写盘结果（fork 数据目录，可写）。
- 打开工作区的可控方式：再起一个 electron 实例带 `--open-workspace <path>`，单实例锁把它转成 second-instance 深链给已运行实例（desktopDeepLinkUrl.ts:224），比 UI 点「添加项目」可靠。

## 进程清理纪律（2026-10-08 事故教训）

- **清理 dev 进程只按可执行文件路径前缀匹配（`D:\Dev\Js\oh-my-zcode\*`），绝不按进程名**：宿主 ZCode 客户端进程名就是 `ZCode`（agent 跑在其内），按名 `Stop-Process ZCode,electron` 会误杀宿主及其后台任务基础设施（2026-10-08 曾把管理后台任务的子进程带走，任务静默消失）。

## 标识符命名边界（2026-10-08 用户拍板）

- 品牌层面已改名 **omz**（productName/appId/AUMID/数据目录/关于/右键/i18n，见 `omz/docs/specs/desktop-app-rename-omz.md`），但 `@zcode/*` 包名、`ZCODE_*` 环境变量、`zcode://` scheme **三族维持原样**——当日曾全量改名（2072 文件）后用户撤回、完整回滚；再提全量改名须用户重新拍板。

## 基线纪律：v1.0.20 是回滚基线（2026-10-25 用户拍板）

- 上游 v3.16.2 全量同步（v1.0.21~v1.0.26）已被用户整体否决并回滚，main 以 **v1.0.20**（6c84cfcd）为基线。**未经用户明确指令，不得重新引入 v1.0.21+ 的任何代码树内容**（虚拟项目存储、远程开发 R3、设备管理、按设备 source-settings、ToolSearch、C1/C2 合组等一律不恢复）。
- 已发布 tag v1.0.21~v1.0.26 保留可装；回滚前 HEAD 归档在 tag archive/pre-rollback-v1.0.26；数据备份在 ~/.omz/backup-20261025-rollback。
- 版本号接着往上走：基线补丁版从 v1.0.27 起步，别复用已占用的号。

## 交付纪律（两条事故教训）

- **门禁必须自己实跑**：子代理的「已验证通过」不算证据；打包发版前必须真启动一次构建产物（v1.0.21 因只信测试未启动，装上去直接崩）。
- **汇报不得把「未接线」说成「拍板不做」**：差异必须分三态——①用户拍板不做（有原话）②未接线（能力在、调用方没接）③未实现（代码不在）。
- **用户点名「发新版本」才算发布**：bump/CHANGELOG/tag/push 之前该跑的针对性测试、聚合回归、打包启动冒烟一项都不能省。
