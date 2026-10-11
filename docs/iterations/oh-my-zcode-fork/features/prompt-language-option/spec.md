---
date: 2026-10-08
agile_trace: true
---

# prompt-language-option 实现规格（SPEC）

## 根因 / 方案摘要

上游已预留 `AgentRuntimeConfig.language` → `ContextBuilderConfig.language` 通路但**零消费者**（context/types.ts:123 仅声明）——本功能以它为注入点，不新造管道。遵循仓库约束（apps/zcode-cli/AGENTS.md:21 不新增环境变量）走 config.json 域 + 协议方法 + ConfigPort 活值链（magic-context 范式），提示词消费采用「中文文案集中单文件 + 被改文件最小 diff + FORK 登记」把上游同步冲突面压到最小。

## 变更点清单

**apps/zcode-cli（14 文件）**
- contracts/src/config/index.ts：ConfigKey.PromptLanguage、ConfigValue 分支、`PromptLanguage = "auto"|"zh-CN"|"en-US"`、RuntimeConfig(+Patch) 字段、DefaultRuntimeConfig "auto"。
- adapters/src/config/schema.ts：顶层 promptLanguage 枚举；装载映射进 RuntimeConfigPatch。
- adapters/src/config/file-config.adapter.ts：`updatePromptLanguageInFileConfig`（仿 updateUiLocaleInFileConfig，atomic write、保留其它顶层键）。
- adapters/src/config/index.ts：ConfigPort merge/getAll/getDefaultValue 接入。
- core/src/context/prompt-copy-zh-cn.ts（新增）：Layer 1 全部中文文案 + `isChinesePromptLanguage`。
- core/src/context/sections/{cli-prefix,identity,desktop}.ts、core/src/context/dynamic-sections.ts：按 language 选文案（英文原文保留为默认；identity 的 language 参数可选，子代理不传保持英文）；文件头 `FORK（prompt-language-option）：…` 登记。
- core/src/context/builder.ts：把 config.language 透传给各段。
- bootstrap/src/app/runtime-config.ts：装配点 `resolvePromptLanguage`（auto→复用 i18n resolveEffectiveLocale 探测，非 zh-CN 落 en-US；无值即 auto）。
- bootstrap/src/zcode-protocol/prompt-language.ts（新增）+ server.ts：read（ConfigPort 优先、文件兜底）/ update（校验→写盘→ConfigPort.set→runtime.updateConfig({language}) 热更新，activeTurn 中不重建、下一轮生效）。

**omz 根（8 文件）**
- packages/shared/src/zcode-protocol/index.ts：方法名 + params/result schema（zcodePromptLanguageSchema）。
- packages/shared/src/test-ids.ts：TID_SETTINGS_MODEL_LANGUAGE_SELECT_TRIGGER/_ITEM。
- packages/services/src/zcode-agent/zcodeAgent.ts + zcodeAgentService.ts：readPromptLanguage/updatePromptLanguage（read-only 控制面；旧 CLI -32601 → supported:false 降级，不抛错卡 General 分区）。
- packages/ui/src/settings/ModelLanguageSetting.tsx（新增）：协议读写 + 自动保存 + 失败 toast 保持原值（MagicContextSettingsSection 范式）。
- packages/ui/src/settingsPageHelpers.tsx + SettingsPage.tsx：General 分区 locale 行下方挂载。
- i18n en/zh 各 +7 key（settings.modelLanguage*）。

## 详细改动说明

- 数据通路：设置页 Select → services 包装 → 协议 workspace/updatePromptLanguage → CLI 写 config.json + ConfigPort.set + updateConfig 热值 → ContextBuilder 下一轮 build 用新 language 选文案。
- auto 语义：CLI 侧环境探测（LC_ALL/LANG/Intl），中文系统 → zh-CN；显式值透传。
- 中文文案含显式指令：「与用户交流时使用简体中文；技术术语、代码、命令、路径保持原文」；品牌统一 omz。
- 已知边界（handler 注释登记）：宿主 uiDetectedLocale 不透传到协议热路径——冷启动优先宿主 UI 语言，运行中热更新用 CLI 侧 env→Intl 探测（与冷启动同源）；两者仅在「宿主 UI 语言 ≠ 进程 locale」时可能不一致，显式选择无此问题。（2026-10-09 修复后口径：热路径已补 Intl 探测，Windows 无 LANG 场景不再回落英文；如需热路径也跟随宿主 UI 语言，须另做 detectedLocale 协议透传。）

## 测试策略

- `cd apps\zcode-cli && pnpm typecheck`：27/27 successful。
- oxfmt --check 改动文件：零新增不合规（唯一标记项 core/src/runtime/types.ts 为 HEAD 既有）。
- `node scripts/check-i18n-parity.mjs`：通过（各 5900 key）。
- tsx 临时脚本 20 项功能断言：中英文装配（builder.build 中文 system prompt）、写盘保留其它键、ConfigPort 优先级、updateConfig 热值（auto+LANG=zh_CN.UTF-8→zh-CN；en-US 透传）、非法值 -32602、createConfig/resolveAppRuntimeConfig 两分支——ALL CHECKS PASSED（历史证据，已被下列常驻测试取代）。
- `node scripts/typecheck-desktop-full.mjs`：gate OK（no new errors）。
- **常驻测试（2026-10-09 cr-fix PL-G-1 落盘，UPSTREAM-SYNC.md §4 测试族已登记）**：
  - `node --test apps/zcode-cli/packages/bootstrap/scripts/test-prompt-language-rpc.mjs`（10 用例：三态写盘/非法值 -32602/read 三路径/schema round-trip/auto 冷热一致——含 PL-B-1 Intl 修复断言）
  - `node --test apps/zcode-cli/packages/core/scripts/test-prompt-language-context.mjs`（6 用例：zh/en/undefined 三态段落语言、desktop 段门控、workflowActor 分支、PL-B-2 zh_CN 归一）
  - `npx tsx --test packages/services/test/promptLanguageDegradation.test.ts`（2 用例：旧 CLI -32601 read 降级 / update 可读错误）

### 测试用例

见 prd.md；实机用例（设置页切换 + config.json 落盘断言 + 新会话 prompt 抽查）在桌面验收阶段执行。

## 风险与回滚方案

- 上游同步：prompt 文件演进会与选文案 diff 冲突——中文文案全部集中在 prompt-copy-zh-cn.ts（新文件永不冲突），原文件仅最小接线。
- Prompt cache：切换语言使 stable 前缀 cache miss（一次性成本）。
- 回滚：还原 22 个文件 + config.json 中 promptLanguage 字段被 schema 容忍（老代码 strip 未知键）。
