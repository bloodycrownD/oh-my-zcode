---
date: 2026-10-08
dependency: []
---

# readonly-provider-config-fallback Bug PRD

## 背景

用户在设置页看到「读取上下文管理配置失败。」错误横幅（上下文管理/MagicContext 分区）。

## 现象描述

- 设置页上下文管理分区显示「读取上下文管理配置失败。」，无法读取/编辑配置。
- host 日志：`ZCode Protocol workspace/readMagicContextConfig 失败 {"message":"ZCode agent transport closed: stdout_closed"}`，每次请求约 1.3 秒后失败。

## 复现步骤

1. 本机存在用户级全局环境变量 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，指向已安装 ZCode 3.14.4 的旧缓存（`C:\Users\<user>\.zcode\v2\runtime\provider\...\zcode-builtin.json`，含已删除的 access.accountType/mode 字段）。
2. 启动 dev 桌面应用，打开设置 → 上下文管理分区。
3. UI 触发 readMagicContextConfig → services 拉起只读 app-server 子进程 → 进程启动即退出（stdout 关闭）→ 请求失败。

## 预期行为

- 只读控制面进程应能启动；显式 env 指向的配置与当前 schema 不兼容时应回落随包基线并告警（与桌面侧 bundledFallbackFilePath、构建脚本 D-16 同语义），设置页正常显示默认配置。

## 实际行为

- CLI 入口 `prepareCliProviderRuntimeEnv` 把显式 env 值直接当「随包基线」传给 source，且不提供任何兜底；source.read() 抛「Bundled 与 Active ZCode Built-in Release 均不可用」→ main.ts 顶层 catch → app-server 进程退出 → 桌面侧 transport closed → 设置页报错。
- 会话 agent 不受影响（session spawn env 由桌面 providerConfigRuntime 注入解析后的有效路径），仅裸 read-only lane 与独立 CLI/TUI 使用中招。

## 影响范围

- 桌面：设置页所有走 read-only 控制面的分区（上下文管理、hook 信任等）在「全局残留 stale env」机器上全部不可用。
- 独立 CLI/TUI：同样环境下启动即崩。

## 验收标准

1. 保留 stale 全局 env 的情况下，dev 应用设置页上下文管理分区正常读取（显示默认配置，stderr 有可检索回落告警）。
2. 无 env 残留的机器行为不变（显式值有效时仍优先使用显式值）。

## 回归测试要点

- 显式 env 有效（指向当前 schema 文件）→ 仍用显式值，无回落告警。
- 显式 env 无效 + 随包基线存在 → 回落成功（隔离脚本已验证 revision=30 读取成功）。
- 随包基线也不可解析的自定义部署 → 保持既有失败面，不新增错误。
