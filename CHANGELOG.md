## [Unreleased]

### 修复

- **修复 MCP 服务器增删改后需重启应用才能生效**：此前在设置页新建/改名/禁用/删除 MCP 服务器后，已打开的会话永远看不到变化（工具面是会话创建时的快照），必须重启应用。现在保存或启停后立即对当前所有活跃会话热刷新——新工具立即可用、删除/禁用的工具即时消失，无需重启。
- **修复 Shift+Enter 偶发直接发送**：中文输入法确认候选词的 Enter 在特定时序下（compositionend 先于 keydown 派发）被误判为裸 Enter 触发发送。现在 Enter 判定链的三处（入口门禁、发送分支、改绑路径）都加了 `keyCode 229` IME 兜底。
- **修复换模型后编辑重发报错**：编辑重发的模型优先级从「会话活值优先」改为「编辑提交时的当前模型优先」——换模型后立即编辑上一条消息重发，会用新模型发请求，不再因活值停留在旧模型而报错。
- **修复引导在轮次间隙点击后永久滞留**：上一轮已结束、新轮未开始时点击「引导」，消息既不会被注入（core 物化要求活跃轮次）也不会被自动消费（队列只消费普通车道）——表现为"第一轮引导无效"。现在间隙点击引导等效「立即执行」。
- **修复 Magic Context 对子代理不生效**：子代理 runtime 构造时未继承 magic context 的配置门与三个端口（transform/提示词段/工具描述），导致子代理看不到记忆摘要、ctx_* 工具也不注册。现在随主会话透传。
- **编辑重发被拒时给出可见提示**：此前 CLI 拒绝编辑重发（如重启后状态未恢复完成）时 UI 静默，用户会误以为编辑成功而 agent 无响应。现在会 toast 拒绝原因。

（待下一批改动。新条目由 omz-changelog skill 写入本段，发版时挪入版本号段。）

## [1.0.11](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.10...v1.0.11) (2026-10-14)

### 新增

- **Doom loop 检查**：agent 对同一工具发起**完全相同的调用连续重复到第 4 次**时（事不过三：重复 3 次内属正常验证，第 4 次即死循环征兆，第 3 次已有文字提醒），该次调用在执行前被拦截并弹出确认卡——可「允许一次」「本会话总是允许该工具」或「拒绝并停止本轮」；拒绝时本轮停止、排队消息保留。子代理或无确认通道的场景自动降级为直接拒绝（不会悬挂等待）。可在配置中调整：`ask`（默认，弹卡）/ `deny`（检测即停不弹卡）/ `off`（关闭检查）。

### 修复

- **修复「引导」排队项实际从未在当前轮内执行**：此前点击「引导」后消息只是显示为「等待引导」，但底层从未把它注入当前对话——当前任务结束后仍按普通排队逐条开新轮，引导语义名存实亡。现在点击引导后，消息会在当前正在执行的步骤（工具调用或回复文本）结束后的下一个边界直接插入当前轮执行；切回「排队」则恢复原样。带附件的排队项暂不支持引导（保持普通排队）。

## [1.0.10](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.9...v1.0.10) (2026-10-14)

### 新增

- **排队消息可改「引导」**：消息排队后（上一条还在跑时发送），队列里每项新增「引导」按钮——点击后该项在当前轮的下一个工具调用边界插入执行（不打断当前轮），随即转入「等待引导」列表，可再点「恢复排队」改回普通排队。此前投递方式在提交时定下后不可更改。

### 变更

- **界面语言与模型语言合并为「系统语言」**：设置页只保留一行「系统语言」（系统默认 / 简体中文 / English），agent 系统提示词语言跟随该设置同步，不再单独配置；原「模型语言」下拉移除。此前界面用中文、提示词却用英文（或相反）的分裂组合不再可能出现；切换语言对运行中会话下一轮生效，无需重启。

### 修复

- **修复排队项「引导」切换在会话繁忙时点击无效**：会话流式输出期间投影版本号快速前进，点击瞬间携带的版本号到达时已落后被拒，且此前的静默回滚让操作无痕丢失。现在切换命令在被拒后会带最新版本号自动重试（最多 2 次），重试仍失败会显式提示；被并发消费的极端竞态也从「假装成功」改为显式拒绝，便于观测。

## [1.0.9](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.8...v1.0.9) (2026-10-13)

### 新增

- **失败/停止的子智能体可以继续对话**：子智能体失败或被停止后，结果里现在会带回它的 agentId——直接用 SendMessage 就能让它在原有上下文里继续跑（此前失败结果只有报错原文、句柄丢失，只能整个重开）；后台失败/停止的完成通知同样附带续跑提示；Agent 与 SendMessage 的工具说明也如实写明了终态续跑能力。句柄仅在当前会话内有效，重启应用后无法续跑（会如实提示）。

## [1.0.8](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.7...v1.0.8) (2026-10-12)

### 修复

- **异常状态码不再打死应用**：代理或网关返回 999 等标准 HTTP 表示不了的状态码时，该次请求按失败返回，应用不再整个退出；无正文状态（204/304）也不误判为超限。
- **长会话内存不再随轮次暴涨**：会话事件的驻留副本此前随轮次线性增长（长会话实测可达百余 MB），现在只保留计数不保留全文，内存平稳。
- **超大内容的卡顿与假死**：单条超大输出（巨型快照帧、超长命令输出）此前会让内存分配暴涨、CPU 拉满甚至界面假死，现在分帧与缓冲都有上界，超限自动降级。
- **中断后恢复不再丢媒体**：会话中途停止后恢复，截图等媒体内容此前会丢失，现在完整保留。
- **旧格式会话恢复更稳**：升级后找不到新版会话快照时，自动回退读取旧格式文件（含早期导入的 Claude 会话），不再直接报错丢会话；恢复时流式输出的最后一段也能补齐。
- **Windows 上 MCP 服务器无法启动**：从 git-bash/WSL 继承的 SHELL 环境变量指向 Windows 用不了的路径时，stdio 方式的 MCP 服务器会全部启动失败——现在自动回退到系统默认命令行。
- **Windows 关窗后应用失联**：关闭窗口时若托盘还没就绪，现在会弹窗确认退出，不再无声隐藏导致找不到应用入口。
- **深链与调试参数安全加固**：外部链接唤起应用时的参数注入边界收紧；打包版忽略调试检查器启动参数。
- **长工作流不再拖慢会话**：工作流运行详情、恢复与订阅推送等主要读取路径改为带上界的有界读取（另有非轮询的运行清单读取维持原状），几十上百节点的工作流不再引起卡顿或内存堆积。
- **上下文记忆在某些模型上错位**：部分模型底层会把相邻的同角色消息合并，导致上下文记忆的分段标记失效或定位错位——现在发送前按原边界拆回。
- **工作流快照报告总数显示错误**：报告条数超过上限被截断时，完成通知与清单里的条数此前只报截断后的数量，模型会误以为全部就这些、不去取剩下的；现在如实报告真实总条数。
- **超大型工作流运行详情打不开**：运行事件一页的数据量过大时会超出底层单帧上限、整页读取失败；现在分页按字节上界收口，再大的运行也能正常打开。
- **剪贴板长文本附件无法预览**：长粘贴落盘的文本附件此前点不开预览（授权与结果两道校验只认图片、上行数据也丢了标记），现在从上传、授权到预览全链可用；普通文本文件不受影响。
- **旧版导入会话升级后收不到实时消息**：早期导入的会话升级为正式会话后，本进程内仍被当作只读旧格式，该会话的实时更新被永久降级；现在升级成功后恢复正常订阅。

### 维护

- 上游 v3.15.1 修复批次同步：30 项崩溃/内存/协议/Windows/安全修复与配套重构移植，遥测、上下文记忆集成、品牌命名等本项目的既有差异全程保持不变；测试防线从 236 例扩到 357 例（补齐存储层读写契约、附件预览链、深链安全、托盘异常兜底等自动化钉子），桌面端类型错误面继续收敛。

## [1.0.7](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.6...v1.0.7) (2026-10-11)

### 修复

- **提问卡片显示「未提供回答」**：模型中途弹出提问、你作答之后，提问卡片现在如实回显所选答案（或自定义输入；全部跳过时如实显示自动继续）；此前仅界面回显错误地显示「未提供回答」，提问与作答功能本身一直正常（模型始终能收到回答）。修复也覆盖关窗重开后的历史回看；更早版本的旧会话因当时未记录答案，维持原显示。

## [1.0.6](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.5...v1.0.6) (2026-10-11)

### 新增

- **项目记忆**：上下文管理现在自带跨会话的项目记忆——模型会把值得长期记住的发现（尤其是翻了好几轮才找到的）钉进记忆库，之后的会话自动带上、随时可搜；记忆按项目归档，重启应用仍在。可在设置中整体关闭。
- **记忆与折叠设置面板**：设置里新增记忆开关、按模型的提示词分档（完整/轻量）、记忆图开关，修改即时生效。
- **上下文搜索工具**：新增 `ctx_search` 与 `ctx_memory`——会话中可直接搜索这个项目曾说过的、决定过的、记下的一切（含已归档内容），不再只靠翻聊天记录；搜索结果只返回仍有效的记忆。

### 修复

- **排队消息被卡住**：桌面端把消息排队后（上一条还在跑时发送），提升开跑不再被后台整理拖住——此前最坏要多等约两分钟，现在上一条完成即接续。
- **切换模型不生效**：已有会话里选模型立即生效，不用再开新会话或重启；排队中的消息和编辑重发的消息也都用切换后的最新模型。
- **子智能体模型改动不生效**：设置里改子智能体模型，同一会话内下一次派遣立即用新模型，此前需要重启应用。
- **新会话第一条消息卡顿**：把首条消息前的内部准备（词典加载、项目识别）移到应用启动时后台完成，实测首条消息的等待从约 1.4 秒降到毫秒级。
- **搜索翻出过期记忆**：上下文搜索不再返回已归档或已过期的记忆。

### 变更

- **移除内置安全提示段**：系统提示词中「仅在获得明确授权的场景下协助安全测试」一整段按要求移除。
- **上下文管理指令跟随语言设置**：上下文管理相关的系统指令（折叠、标签、记忆的用法说明）现在随语言设置显示中文或英文，与整体提示词语言保持一致。

### 维护

- 上游 magic-context 能力全量移植收口（此前搁置清单从 21 项收到 7 项，逐字对照纪律），补齐记忆链、提示词面与视觉记忆图的承载；测试防线大幅扩充（含编辑重发、中文提示词、端到端四场景）；桌面端类型错误面从 366 种收敛到 55 种。

## [1.0.5](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.4...v1.0.5) (2026-10-10)

### 新增

- **Windows 便携版**：Release 页新增 zip 安装包，解压即可运行，无需安装——与 macOS 的 dmg + zip 双产物对齐。
- **上下文折叠默认继承会话模型**：分舱折叠（后台把长历史摘要成「折叠区」的机制）不再需要手动配置模型，默认直接使用会话当前模型，开箱即用；仍可在设置中换一个更便宜的小模型，或显式关闭折叠。

### 维护

- **Release 更新说明改由 CHANGELOG 驱动**：发布时自动把 CHANGELOG 对应版本段落写入 GitHub Release 正文，不再显示机器生成的提交列表。

## [1.0.4](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.3...v1.0.4) (2026-10-10)

### 新增

- **子智能体手动停止**：状态面板与子智能体目录页都可停止正在运行的子智能体，停止后如实显示「已取消」而不再误报「失败」。
- **工具输出清理**：资源管理器新增历史命令输出日志的清理入口（覆盖 cli/exec 输出，界面文案注明范围）。
- **上下文回收工具更易懂**：模型现在会主动使用 ctx_expand 找回被压缩的内容（上下文出现 §N§ 标记时），不再需要精确指令。

### 修复

- **编辑消息重发**：编辑后发送不再发出旧内容，编辑时选择的模型会被正确应用；修改默认模型后新会话即时生效；并修复编辑回退后偶发的界面崩溃。
- **切换会话列表跳顶**：长会话之间切换时，消息列表保持原位与滚动位置，不再跳回顶部。
- **上下文到了阈值也不压缩**：修复多处导致「占用已很高却始终不压缩」的问题（装配静默失败、数据库忙等无重试、模型窗口缺失）；未单独配置模型的会话也能正常压缩。
- **失控命令撑爆磁盘**：命令输出上限收紧至 256MiB（可用环境变量调整），超限终止后自动截断、保留开头与结尾各约 1MiB，并在结果中明确提示已截断。
- **同步派遣子智能体缺少会话标识**：同步派遣的工具结果现在与异步派遣一致，附带子会话 ID，便于后续查询与停止。

### 维护

- 大量稳定性建设：上下文管理的事件可观测性、模型选择的写回防线、消息映射对异常数据的防御、清理计划的时钟语义锁定等；上游 magic-context 包核心区零改动。

## v1.0.3（2026-10-09）

两处本地已验证修复的上游落地：magic-context 会话卡死修复、macOS 打包 ad-hoc 签名开关（CI mac 产物默认开启）。

### 修复

- **magic-context tool drop 残留孤儿 tool-call，会话卡死且重启/重放不恢复**：ZCode 把一个 tool call 拆成两个 part——assistant 消息上是 running 的 invocation（只有 input），user 结果消息上才是 completed/error 的 result（有 output）；而 tool 弧分类把 `type:"tool"` 一律当 result，FIFO 配对收不到 invocation 入队，result 一侧又复用了 user 宿主绑定（本是为 OpenCode「调用/结果同消息」形态准备的快路径）。两个 part 落进不同 composite key 后，drop 只清 result 一侧，invocation 成孤儿：客户端持续报 `AI_MissingToolResultsError: Tool result is missing for tool call ...`，坏字节还会被 LKG 固化逐 pass 重放。现在 `extractToolCallObservation` 按弧是否闭合（`partHasCompletedResult`）分流——完成/出错 → result、pending/running → invocation（anthropic 的 `tool_use`/`tool_result` 形态不变）；result 复用宿主绑定补 `role === "assistant"` 条件，user-role 宿主交回 FIFO 配对；`tag-messages` 与 `read-session-chunk` 两个 FIFO 消费方同时修正。缺陷链路与规则见 `docs/specs/magic-context-tool-arc-pairing.md`，transform 常驻测试 +3 例（38 cases 全过）。

### 功能

- **macOS 打包 ad-hoc 签名开关 `ZCODE_MAC_ADHOC_SIGN`**：无证书时 `identity: null` 让 bundle 完全不签名（没有 `_CodeSignature`），浏览器下载（带 com.apple.quarantine 隔离属性）后被 Gatekeeper 判「已损坏」且无法自救。开关打开后以 ad-hoc（identity `"-"`）完整封签，报错回到真实可行动的「无法验证开发者」提示。identity 回退链为 真实证书 → ad-hoc → 不签名；`notarize` 恒 false、`hardenedRuntime` 只跟随真实证书签名；默认关闭，本地与 CI 现状行为不变。CI 的 mac 产物自本版起默认 ad-hoc 封签（按 matrix 注入开关）——未公证包首次打开仍需右键 → 打开（或系统设置放行 / `xattr -rd com.apple.quarantine`），彻底解决需要开发者证书 + 公证。

## v1.0.2（2026-10-09）

v1.0.1 发布 diff 全量代码评审（32 项）+ 三线实机 E2E 验证后的修复批次：启动稳定性、品牌一致性收尾、模型体验补漏与测试基建。

### 修复

- **带残留旧版环境变量的机器上，打包版桌面仍「启动即退」（v1.0.1 修复的盲区）**：v1.0.1 的修复只在开发布局验证过——CLI 侧解析「随包基线」的候选清单缺桌面打包布局（`resources/glm` → `resources/config/provider`），打包产物在残留 stale `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的机器上仍会抛「无法定位 CLI ZCode Built-in Provider Config」退出（read-only 控制面与会话 agent 均受影响）。现在解析收敛为 `@zcode/provider-node` 公共函数，CLI 与桌面 Main 共用同一候选清单（CLI 打包/桌面打包/桌面 dev/CLI dev 四布局），并在解析失败时接受继承的 `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` 兜底；agent spawn env 的 BUNDLED 恒指真实随包基线（fallback 优先、显式值仅兜底，单测锁定）。附带：成对环境变量探针改为纯读取校验，不再对（可能属于另一旧安装的）显式文件目录产生 mkdir/文件锁写副作用。
- **模型语言「自动」在 Windows 中文系统热切换回落英文**：运行中把「模型语言」切到「自动」（或从显式值切回）时，热路径只探测 `LANG`/`LC_*`（Windows 常缺位）会解析为英文直至重启，与冷启动（env → `Intl`）分叉。现在热路径与冷启动同源（公共函数单点），冷热一致有测试锁定；`zh_CN` 等 POSIX 风格标签也能正确识别为中文。
- **模型列表拉取三处补漏**：legacy 导入的自定义请求头（`api.headers`）随拉取上行——此前被丢弃，依赖自定义鉴权头的 provider 会 401 且误提示「请检查 API Key」（同名头大小写不敏感覆盖，显式鉴权头优先，头值不进日志/错误）；超时不再误报为「响应不是合法 JSON」、全链 405 不再误报 404（错误文案附最后状态与已尝试路径）；「密钥不经过 renderer」类注释与 CHANGELOG 措辞订正为事实（API Key 不作为 RPC 参数传递，由主机本地读取）。
- **「添加模型」可输入下拉的竞态与键盘可达性**：拉取未完成时关闭弹窗，晚到的响应不再把旧候选写进下次打开的弹窗（此前存在幽灵候选闪入）；已展开候选时点击输入框定位光标不再丢候选；补齐 combobox ARIA 契约（role/aria-expanded/aria-activedescendant），纯键盘（↓/↑ 选择、Enter 填入、Esc 收起候选且不连锁关弹窗）可完成全流程。
- **web 标签页标题回退 ZCode**：web 入口 `main.tsx` 运行时覆盖 `document.title` 的两处品牌串漏改（静态 `<title>` 已改但会被覆盖），现收敛为单一品牌常量；CUA 权限面板的运行时标题同理修正。

### 品牌

- **资产再生成管线可复现**：字标缩放精度修正（0.0185567，不再四舍五入漂移）、Z 字形保留原始贝塞尔曲线（不再折线化）、新增 `--check` 模式——36 项资产映射逐字节比对（SVG/PNG/ICO/ICNS/DMG/内嵌 favicon + 5 处内联 `d` 串），「重跑产物与仓库资产字节一致」首次可机验。
- **macOS 图标档位与 DMG 背景修正**：icns 补回 ic11..ic14（32/64/256/512 的 @2x 槽位——v1.0.1 重生成时档位回退，Finder 小图标此前只能降采样）；DMG 背景箭头纵向归位（与图标行 y=220 对齐，v1.0.1 补齐 mac 资产时错位约 80px 不指向「应用程序」）。
- **web 内嵌 favicon 与重生成图标同步**（v1.0.1 重绘全量图标后内嵌副本漂移）；`app-logo.svg` 描边环一处贝塞尔控制点抄错订正（与 Z.ai 供应商图标壳形逐字一致）；空状态明/暗线框线宽补偿（缩放后有效线宽此前约为原设计一半）；**原生菜单/托盘品牌词补齐**——Windows 帮助菜单「关于 omz」、托盘 tooltip「omz」/「打开 omz」（v1.0.1 改名在 shared 原生菜单 catalog 的漏网项，E2E 实机发现）；陈旧品牌注释清理与 DMG 卷图标注释对齐（安装器图标统一复用应用方标）。

### 工程

- 四组常驻测试落盘（共 40 用例）：Built-in 基线回落（含桌面打包布局回归锁）、模型语言（RPC 写盘/上下文构建三态/旧 CLI -32601 降级）、模型列表拉取（候选路径链/超时与错误分类/鉴权头/脏数据/密钥不泄漏）；资产 `--check` 纳入门禁（UPSTREAM-SYNC.md 测试族 15→17 项）。
- `electron-builder.config.js` 行尾归一 LF 并以 `.gitattributes` 锁定（`*.js text eol=lf`，消除 746/737 行的整文件噪音 diff）；设置页 i18n 清理删除组件遗留的 10×2 个孤儿 key（parity 5891=5891）；`presetLoading` 死别名与不可达 preset 分支清理。
- 全部 32 项经三线实机 E2E 验证：打包布局模拟 + stale env 真实 bundle、桌面实机（含真实端点拉取与键盘操作）、web 运行时标题；相关 feature/bug 的 PRD/SPEC 文档同步订正。

### 已知限制

- macOS 安装包仍未签名/未公证，首次打开需右键 → 打开（沿用 v1.0.1）。
- DMG 背景箭头指向与 icns 小尺寸槽位表现为像素级/结构级验证（箭头中心 y≈219.5、ic07..ic14 齐备），mac 实机视觉终判建议发版后目检确认。

## v1.0.1（2026-10-09）

品牌视觉定型 omz + 模型体验补齐（中文提示词、拉取模型列表、预设清理）与三处稳定性修复。

### 变更

- **桌面应用品牌由 ZCode 收敛为 omz**：打包身份（`productName` = `omz`、`appId` = `dev.omz.app`、Linux 可执行名/包名 = `omz`、Windows 开发态 AUMID）、运行时应用名（数据目录随之变为 `omz`/`omz Dev` 等，与旧 `ZCode` 安装互不干扰）、关于面板、深链确认文案、Linux 桌面项显示名、资源管理器右键项（新键 `omz.OpenInOmz` 并清理旧 `ZCode.OpenInZCode`）、界面 i18n 品牌词全部改为 omz，Windows 产物名随之变为 `omz-<version>-win-x64.exe`。`ZCODE_*` 环境变量、`@zcode/*` 包名、`zcode://` 深链 scheme 与 `~/.omz` 数据目录保持不变，详见 [docs/specs/desktop-app-rename-omz.md](docs/specs/desktop-app-rename-omz.md)。
- **品牌标志 Z → OMZ**：应用内全部 Z 字标渲染点（启动壳/关于面板/引导页/侧栏与顶栏方标/空状态明暗两套/CLI TUI ASCII）与全平台二进制图标（Windows icon.ico×3 同源/九档 png/icon_windows/web favicon、macOS icon.icns×2/DMG 背景 dmg_background×2）替换为 OMZ 三字母字标（设计语言沿用原 Z：笔画比例、末端斜切、对角斜率；Z 字母逐字沿用原字形）；安装器图标（icon_installer.\*，原“包裹箱插画”）统一复用应用方标；DMG 安装背景以 OMZ 字标重绘同构图；新增 `scripts/generate-omz-brand-assets.mjs` 作为可复用的再生成管线（纯 Node 栅格化 + ICO/ICNS 容器写入，无新依赖）。
- **模型语言选项与中文提示词**：`~/.omz/cli/config.json` 顶层新增 `promptLanguage: "auto" | "zh-CN" | "en-US"`（缺省 auto，中文环境自动中文），设置页「通用 → 模型语言」可切换（自动保存、热生效于下一轮对话）；agent 系统提示词的身份/沟通规范/行为段/桌面上下文段支持中文（文案集中在 `prompt-copy-zh-cn.ts`，英文原文保留为回退），中文提示词显式要求以简体中文交流、技术名词保持原文。协议 `workspace/read|updatePromptLanguage` 旧 CLI 自动降级。
- **设置页移除 zai/bigmodel 预设可见面**：左栏「智谱」预设占位组（OAuth 早已删除的死占位卡）与「添加供应商」模板选择器的智谱分组（zai-api/zai-standard-api/bigmodel-api/bigmodel-standard-api 四张模板卡）整体移除；`config/provider/zcode-builtin.json` 的模板数据保留不动（存量用户从模板创建的 provider 依赖稀疏 overlay，删除数据属破坏性变更，登记为后续可选）。

### 新增

- **「添加模型」支持拉取模型列表**：`IProviderSettingsService.listProviderModels` 在主机侧按 provider 的 api 类型请求模型列表端点（走 host 代理/CA 传输层，API Key 不作为 RPC 参数传递）；模型 ID 输入框为可输入下拉框——拉取后聚焦/输入即弹出候选、输入即过滤、点选即填入，也保留任意手输。**路径兼容**（实测各家网关差异）：anthropic-messages 按 `/v1/models` 约定先试（对齐 SDK 消息端点 `{base}/v1/messages`），OpenAI 系先试 `{base}/models`；404/405 时逐条回落（含源站根路径 `/v1/models`、`/models` 兜底，覆盖 DeepSeek `/anthropic` 这类只在 OpenAI 面提供列表的双面网关及 API 类型与基址错配的配置）；全部 404 时错误信息列出已尝试路径。

### 修复

- **设置页「读取上下文管理配置失败」（read-only 控制面进程启动即退出）**：CLI 入口 `prepareCliProviderRuntimeEnv` 在显式 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 存在时把该值直接当随包基线且无兜底（成对快捷路径更是零校验透传），残留旧安装 env 的机器上 app-server 启动即抛「Bundled 与 Active 均不可用」退出（桌面侧表现为 read-only 协议请求 `stdout_closed`）。现在无条件解析真实随包基线并作为 `bundledFallbackFilePath` 兜底（与桌面侧/构建脚本 D-16 同语义），显式值失效时回落并告警；返回 env 的 bundled 基线恒指向真实基线。

- **桌面端「Bundled 与 Active ZCode Built-in Release 均不可用 / 模型加载失败」**：用户级环境变量 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 若指向旧版本缓存（如 ZCode 3.14.4 的 `~/.zcode` 运行时文件，schema 已不兼容），桌面 Main 会把它当作 Bundled 基线原样透传给 Host，双候选同源失效后所有 provider/model RPC 持续失败。现在 `NodeZCodeBuiltinProviderConfigSource` 支持 `bundledFallbackFilePath`：Bundled 基线无效时回落随包基线（打包 `resources/config/provider/zcode-builtin.json`、开发态仓库 `config/provider/zcode-builtin.json`）并输出可检索告警，语义与构建脚本 `builtin-provider-config.mjs` 一致；接线经 shared `hostInitLocalMessageSchema` → Desktop Main/Host → Services → provider-node 全链路。

- **桌面版启动停在「数据准备进程意外退出或连接中断」**：`glm/zcode.cjs` 的运行期 external 依赖 `@zcode/magic-context`（连同闭包内的 `zod`、`ai-tokenizer`）从未随桌面包暂存，Host 的存储准备 Worker 一启动就 `Cannot find module` 静默退出，用户侧只看到 `Storage preparation failed: transport_closed`。现在 `stage-agent-bundle.mjs` 按生产依赖闭包把 external 依赖平铺到 `glm/node_modules/`，并在暂存后实跑 `zcode.cjs --version` 自检（含 require.resolve 断言）；`electron-builder.config.js` 的 agent 资产条目改为从平台目录取件，绕开 electron-builder 对「拷贝根下 node_modules」的剪枝；`bundle.mjs` 新增打包后校验，源已暂存而产物缺失时直接失败。规则与验收场景见 [docs/specs/desktop-agent-bundle-externals.md](docs/specs/desktop-agent-bundle-externals.md)。

### 已知限制

- macOS 安装包仍未签名/未公证，首次打开需右键 → 打开（沿用 v1.0.0）。

## v1.0.0（2026-10-06）

首个正式版本：本地化 fork 定型（官方端点退场）+ 长会话性能治理完成。

### 变更

- **官方端点与账号域全线退场**：自动更新链（electron-updater、强更 gate、菜单/托盘/设置页更新入口）、登录与订阅账号态（UI 订阅额度族、CLI `/login`、官方 MCP 鉴权）、闲时任务（off-peak）链路、会话分享域（发布/导入/web 落地页）、帮助/反馈/社区入口、OAuth/支付 deep link 死管道整删。模型 provider 收敛为本地配置两组（preset / custom），仅凭自备 API 即完整可用；zh/en 键集对齐（5893 键，新增 parity 门禁）。
- **长会话性能**：投影层增量渲染（accumulator + copy-on-notify 引用复用 + renderUnits 增量缓存）、turn 目录窄投影（侧边消息 rail 的目录合并 / 跳转 / 上滚分页）、内存护栏（shiki tokensCache LRU 上限 500 + 订阅表上界）、全局秒级 tick 下线改局部组件自刷新。979 消息会话实测：滚动 longtask 121→43（2.8x）、阻塞时长 12293→3553ms（3.5x）、滚动行程归一 5.8–7.1x、heap 增长 +81.8MB→−3.7MB。
- **测试基建**：`pnpm test:v4-perf` 单命令聚合全部本期 blocking 测试（125 项），测试文件纳入根 typecheck 工程。

### 修复

- **v0.1.1 全量代码评审的 22 条 must-fix**：无行变更帧引用复用、共享缓存 (scopeKey, phase) 口径统一、rail 可见性单一真源、rowElementRegistry 跨 pane 撞号过滤、跳转 loading 接入 aria-busy 与禁点、目录翻页截断显式提示等，全部落地并通过独立终验（22+1 条矩阵 + 四门禁复跑）。
- **升级兼容**：旧版本 provider 缓存含已删字段（access.accountType/mode）时按随包基线回落，不再「模型配置加载失败」；bootstrap 严格模式编译错修复。

### 已知限制

- macOS 安装包未签名/未公证，首次打开需右键 → 打开。
- GitHub Release 单文件上限 2 GiB：超限产物不上传 Release，仍在 workflow 的 Artifacts 中完整保留。
- CLI 单文件（SEA）运行时仍需显式加载层（推迟项）。

## v0.1.1（2026-10-05）

### 新增

- **免登录完整使用**：只配置外部 API（DeepSeek、OpenCode Go、bigmodel-api key 等自定义 provider）不再被首启欢迎页强制选择品牌身份或登录，直接进入主界面；会话、工具调用、设置全部可用。不登录仅缺少账号态功能（剩余额度/Pro 展示、Coding Plan 订阅管理、官方 MCP 配额、会话分享），均静默降级。
- **`/ctx-*` 命令接入桌面端**：`/ctx-status`（状态快照）、`/ctx-reduce`（排队回收上下文）、`/ctx-expand`（取回已丢弃内容）、`/ctx-recomp`（分舱重算）在桌面 composer 输入 `/` 即可见、可执行，结果以底部信息浮层展示（状态快照常驻可手动关闭）。与 CLI/TUI 共用同一份实现，行为一致。
- **发布自动化**：推送 `v*` tag 即自动构建并发布四平台安装包——macOS（dmg + zip，arm64/x64）、Windows（NSIS exe）、Linux（AppImage / deb / rpm / pacman）——并附到 GitHub Release。

### 修复

- **设置页「折叠模型」无法设置**：选中任何模型都被静默清空（模型选择器编码与落盘格式的转换不对称），保存按钮永不点亮。已修复并补转换链测试锁定。
- **magic-context 设置改自动保存**：移除「保存 / 放弃修改」按钮，任何改动自动写盘并即时生效；保存失败弹提示并回滚到上次成功状态。
- **v0.1.0 全量代码评审的 33 条修复**，要点：
  - `magicContext.enabled = false` 时 transform 直通且不再打开/创建 magic-context 数据库（此前存在不生效与多余落盘两类缺陷）
  - 内置市场 CDN 旧 id 别名容忍——官方市场刷新必败的问题修复
  - `workspace/updateMagicContextConfig` 拒绝空 config，杜绝整域静默重置
  - 设置页清空「Token 覆盖」只摘除 default 分支，不再误删用户已有的 per-model 键
  - 生命周期/中断守卫、协议信封校验、UI 无障碍标注、品牌与合规文档口径等其余各项

### 已知限制

- macOS 安装包未签名/未公证，首次打开需右键 → 打开。
- GitHub Release 单文件上限 2 GiB：超限产物不上传 Release，仍在 workflow 的 Artifacts 中完整保留。
- CLI 单文件（SEA）运行时仍需显式加载层（推迟项，计划 v0.1.1+ 版本处理）。

## v0.1.0（2026-10-04）

首个可用版本：magic-context 上下文管理 MVP（裁剪/折叠/分舱、historian 旁路模型、执行阈值与预算参数域、用户级配置与设置页、`/ctx-*` 命令）；移除上游 `/compact` 链路（由 magic-context 取代）；品牌由 ZCode 过渡为 omz；tarball + install.sh 主分发通道与 E2E 终验通过。

## v0.1.0 之前

继承上游 ZCode v3.14.3 基线（tag `baseline/v3.14.3`）：phase1 移除遥测并完成基线评审修复；phase2a magic-context MVP；phase2b 移除 compact。
