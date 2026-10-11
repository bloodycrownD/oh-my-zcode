---
date: 2026-10-08
dependency: []
---

# add-model-fetch-and-presets Feature PRD

## 背景与变更动机

用户要求：①「添加模型」处增加模型拉取——配置好 OpenAI 兼容端点后能一键拉取可选模型列表，而不是手工抄模型 ID；②「添加模型」处直接移除 zai 和 bigmodel——omz 定位独立开源通用 agent，不再展示智谱系预设入口（推翻 official-endpoints-removal D-16「标准开放 API 预设保留」的拍板）。

## 范围说明（相对原需求）

- **面 1（左栏「智谱」预设占位组）整删**：OAuth 早已删除，两张「Z.ai/BigModel」占位卡与「尚未同步，请先完成 OAuth 登录。」死文案不再渲染；零引用死组件（StartPlanCard/StartPlanQuotaStatusCard/BigModelRegistrationHint）一并删除。
- **面 2（「添加供应商」模板选择器）移除智谱分组与 4 张模板卡**（zai-api/zai-standard-api/bigmodel-api/bigmodel-standard-api），不再落入「其他」组重复可见。
- **`config/provider/zcode-builtin.json` 模板数据与 revision 不动**：存量用户从模板创建的 personal provider 只存稀疏 overlay（baseUrl/logo 等在模板层），删除数据会触发 missing-template 使旧 provider 不可执行（破坏性变更），登记为后续可选。
- **模型拉取**：`IProviderSettingsService.listProviderModels({providerId})` 主机侧实现（走 host 代理/CA 传输层，API Key 不作为 RPC 参数传递）；「添加模型」弹窗内按钮拉取 + 可输入下拉点选填入 ID；编辑态同样可用（内置只读模型自动隐藏）。

## 影响模块与接口

- services：providerFacadeServices（接口+工厂）、providerRuntime（apiFetch 依赖）、node.ts（hostApiNetworkTransport.fetch 注入）、新增 providerModelList.ts。
- ui：model-provider-section 系（constants/Navigation/Detail/ProviderPlaceholderCards/ProviderTemplatePicker/ProviderModelMetadataDialog/ProviderFormControls/ProviderCardSections）、ModelProviderSection、useModelProviderNavigation。
- i18n：删 presetTitle/presetDescription/presetEmpty/templateGroup.zhipu，增 fetchModels 族（zh/en 同步）。

## 验收标准

1. 设置页模型服务分区无「智谱」组、无 Z.ai/BigModel 占位卡；无供应商时显示空状态（不再永久 loading）。
2. 「添加供应商」选择器只有「其他」组（Kimi/DeepSeek/OpenAI/Anthropic 等通用模板 + 创建自定义供应商）。
3. 已配置 baseUrl+apiKey 的 provider 在「添加模型」弹窗可拉取模型列表，点选或回车填入；401/超时/网络错误有可读提示；密钥不出现在日志/错误。
4. 存量从智谱模板创建的 provider（若有）不受影响。

## 测试用例

1. 打开设置 → 模型设置：断言无「智谱」「尚未同步」文案（实机已验）。
2. 打开添加供应商：断言无 Z.ai/BigModel/智谱（实机已验）。
3. 对 mock OpenAI/Anthropic 端点拉取：断言请求行/头/解析/去重/错误分类（服务层烟雾已过）。
4. i18n parity 门禁通过（已过，5900=5900）。
