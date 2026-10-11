---
date: 2026-10-08
dependency: []
---

# prompt-language-option Feature PRD

## 背景与变更动机

agent 的系统提示词在代码里全部是英文，对中国用户不友好（模型默认倾向英文思考和回复）。用户要求：提示词支持中文，并在设置页增加「模型语言」选项控制。

## 范围说明（相对原需求）

- `~/.omz/cli/config.json` 顶层新增 `promptLanguage: "auto" | "zh-CN" | "en-US"`，缺省 auto（中文环境自动中文，满足「对中国用户默认友好」），老配置零迁移。
- 设置页 General 分区「界面语言」下方新增「模型语言」下拉（自动/简体中文/English），自动保存（失败 toast 并保持原值），写盘 + 运行中会话下一轮生效（热更新，无需重启）。
- 中文提示词第一层覆盖（对模型行为影响最大的段落）：cli-prefix、identity（intro/安全通告/Harness）、桌面上下文段、沟通规范大段、行为尾段、上下文管理段、session guidance；中文文案显式要求「与用户交流使用简体中文，技术术语/代码/路径保持原文」，品牌用 omz。
- 英文原文全部保留为默认/回退；未覆盖段落（memory/env-info/skills/meta 包装语/工具描述/子代理 prompt）自动回落英文。

**不做**（登记为后续层次）：工具描述（~42K 字符）与其余段落的中文版；TUI/Web 入口的独立设置界面（config.json 字段对它们同样生效）。

## 影响模块与接口

- apps/zcode-cli：contracts（ConfigKey.PromptLanguage 等）、adapters（schema/写盘/ConfigPort）、core/context（中文文案集中文件 + 各段按 language 选文案）、bootstrap（装配 + 协议 handler）。
- packages/shared：zcode-protocol 两个方法（workspace/read|updatePromptLanguage）+ schema + test-ids。
- packages/services：zcodeAgent(Service) 两方法（旧 CLI -32601 降级 supported:false）。
- packages/ui：ModelLanguageSetting 组件（新）、settingsPageHelpers/SettingsPage 挂载、i18n 7×2 key。

## 验收标准

1. 设置页出现「模型语言」选项，三态切换即时写盘且失败可回滚。
2. 中文模式下新会话的 system prompt 身份/沟通/行为段为中文（含明确中文回复指令）。
3. English 模式与既有行为一致（英文原文未被改动）。
4. `~/.omz/cli/config.json` 的其它配置不受写盘影响。

## 测试用例

1. auto + 中文系统 → 提示词 zh-CN；显式 en-US → 英文。
2. 运行中会话切语言 → 下一轮对话生效（updateConfig 热链）。
3. 非法值（协议直发）→ -32602 拒绝。
4. i18n parity 门禁通过（zh/en key 集合相等）。
