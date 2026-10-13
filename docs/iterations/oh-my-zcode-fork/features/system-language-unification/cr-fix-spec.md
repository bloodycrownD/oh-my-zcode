# CR Fix Spec: system-language-unification（系统语言统一）

## 元信息

- repo: D:\Dev\Js\oh-my-zcode；branch: feature/system-language-unification
- base_sha: main → head_sha: aafae0ba
- prd_path / spec_path: docs/iterations/oh-my-zcode-fork/features/system-language-unification/{prd.md,spec.md}
- review_round: 1 / dag_version: 1
- 状态：**fix-spec-ready（无必须修复项）**
- 评审方式：**主代理手工审查**（review 子代理两次 provider 限流，按 skill 失败纪律转手工，标注在此）

## Must-fix

- **无**（P0=P1=P2=0）

## 评审记录（支撑「无修复项」结论）

- A 需求符合性：设置页单行「系统语言」+ 删除模型语言行 + 联动写盘 + system 跟随宿主 locale——与 PRD/用户拍板一致；真机 e2e S0-S3 全绿（cache/realdevice-e2e.md，含设置页形态、en-US↔zh-CN 写盘往返、system 态宿主 locale 解析）。
- B 正确性：`useSystemLanguagePromptSync` 单飞+补跑（inFlight/rerunAfterFlight refs）与 pending 语义核对无误——`skipped-unsupported`（旧 CLI）清 pending 是正确取舍（不会自愈，重试无意义）；`skipped-no-workspace`/`failed` 保持 pending 待补跑正确。`IntlProvider.localeChangeToken` 仅 `setLocalePreference`（发起方）递增、广播接收侧不递增，防回环语义复用既有机制无第二写路径。
- C 质量：`promptLanguageSync.ts` 零 `@/` 依赖（纯函数可单测）设计良好；ModelLanguageSetting 整文件删除后无残留引用（i18n/testid/类型全清，parity 5901）。
- C-orch：N/A——语言变更→写盘单路径收敛（token 防多窗口重复写），无平行入口。
- F 中文注释：关键逻辑注释完备（发起窗口纪律、存量迁移语义、静默降级分级均有依据引用）。
- G 测试：systemLanguagePromptSync.test.ts 6 例 + promptLanguageDegradation.test.ts 2 例（口径注释更新、断言未动）+ 真机 e2e。
- K 收尾：CHANGELOG Unreleased 已登记；无调试残留。

## Spec deviations

- none

## Open questions / 待拍板

- 存量用户 `promptLanguage` 首次进 workspace 被改写为界面语言解析值（含曾手选旧值的用户）——合并语义已由用户拍板并写入 spec/CHANGELOG，此处仅留痕提示，不阻塞。

## 已豁免（用户确认不修）

- 无

## 合并后 QA（manual_user）

- 真机：多窗口同时开时切换界面语言，确认只有发起窗口写 CLI 配置（`~/.omz/cli/config.json` 的 promptLanguage 不被重复写/不闪变）。
- 旧 CLI 二进制混装场景：设置页语言切换无报错（静默跳过同步），界面语言本身正常保存。

## Fix-Spec Closure

| 项 | 状态 |
| --- | --- |
| fix-spec-ready | yes |
| fix_spec_path | docs/iterations/oh-my-zcode-fork/features/system-language-unification/cr-fix-spec.md |
| dag_version / review_round | 1 / 1 |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 0 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | N/A（单路径收敛） |
| C 类合并后 QA | 见上 |
