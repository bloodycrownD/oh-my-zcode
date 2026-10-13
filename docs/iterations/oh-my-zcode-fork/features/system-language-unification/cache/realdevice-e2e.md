# realdevice-e2e 证据包（system-language-unification）

节点：realdevice-e2e（主代理手工执行——执行子代理两次 provider 限流后按 agile-dev 失败纪律接管）｜日期：2026-10-14｜分支：feature/system-language-unification（HEAD=08114e10）

## 环境信息

| 项 | 值 |
| --- | --- |
| 仓库路径 | D:\Dev\Js\oh-my-zcode |
| Node | v22.22.0 / win32 10.0.26200 |
| 启动 | pnpm --filter @zcode/desktop dev（ZCODE_STORAGE_DIR/ZCODE_DESKTOP_HOME_DIR/MAGIC_CONTEXT_DB_DIR 指 os.tmpdir() 一次性目录） |
| CDP | 9229（主进程自动开），renderer=localhost:5174 |
| workspace 打开 | 第二实例 electron . --open-workspace=<tmp>\ws 经单实例锁转发（desktopDeepLinkUrl OPEN_WORKSPACE_ARG） |
| 驱动 | cache/e2e-system-language.mjs（v4：__testActions.setLocale 驱动语言切换 + DOM 断言设置页 + 轮询 config.json） |
| 隔离口径 | config.json 落点 = `os.homedir()/.omz/cli/config.json`，无环境变量可隔离（ZCODE_STORAGE_DIR 不控制；USERPROFILE 重定向致 Electron appData 解析失败）→ **备份/恢复式验证**：启动前备份，结束后删新建+还原原内容 |

## 场景状态表（v4 轮全绿）

| # | 场景 | 状态 | 结论 | 证据 |
| --- | --- | --- | --- | --- |
| S0 | workspace 打开 | passed | 第二实例转发可靠 | run log |
| S1 | 设置页形态 | passed | General 分区仅一行系统语言（`settings-locale-select-trigger`），全页无 modelLanguage testid、无「模型语言」文本；分区导航 14 项正常 | v4 form 快照 |
| S2 | 联动写盘（核心） | passed | `setLocale('en-US')` → config.json promptLanguage=**en-US**；`setLocale('zh-CN')` → **zh-CN**；初始迁移同步（before=zh-CN）生效；无错误 toast | v4 detail.before/afterEn/afterZh |
| S3 | system 态跟随 | passed | select 下拉三选项（系统默认/中文简体/English），选「系统默认」→ promptLanguage 写为宿主 locale（zh-CN，与 Intl 探测一致） | v4 menu/picked/afterSystem/hostLocale |

## 方法论备注（复用价值）

- 设置页打开：sidebar footer 齿轮按钮（aria-label=设置/Settings）→ `settings-page` 出现 → 需点 `settings-section-nav-general` 后 locale 行才在 DOM（分区懒渲染/激活）。
- Radix select 交互：trigger 用完整 PointerEvent 序列（pointerover/enter/down + mouse 序列 + click）；选项 `[role=option]` 直接 click 即可。
- **事故记录（已处置）**：v1 轮曾误信 ZCODE_STORAGE_DIR 能隔离 config.json，真实 `~/.omz/cli/config.json` 被写入 promptLanguage=zh-CN（与用户既有值一致，无行为影响）；v3 起改为备份/恢复口径，跑完已还原。教训已写入 APM 记忆。
- e2e 结果绝不 dump 完整 config.json（含 MCP Bearer）——只记录 promptLanguage 字段。
