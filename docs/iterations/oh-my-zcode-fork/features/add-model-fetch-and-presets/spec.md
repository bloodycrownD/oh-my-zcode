---
date: 2026-10-08
agile_trace: true
---

# add-model-fetch-and-presets 实现规格（SPEC）

## 根因 / 方案摘要

预设两面分别是纯 UI 常量链（面 1）与模板分组过滤（面 2）；拉取模型列表无现成实现，选择 services 主机侧方法（renderer 默认 webSecurity=CORS 阻断且无代理语义；代理/CA 出口 `hostApiNetworkTransport` 只在 host 装配），经 ProxyChannel 动态转发（无方法白名单，扩接口即跨进程可用）。

## 变更点清单

**服务层**
- 新增 `packages/services/src/model-provider/providerModelList.ts`：listProviderModels 工厂——从 ProviderSettingsFacade 有效配置取 api.type/baseUrl/access.apiKey；**候选路径链**（404/405 逐条回落，401/403/其它状态立即抛出）：anthropic-messages 先 `{base}/v1/models`（与 SDK 消息端点同约定，覆盖 Anthropic 原生与 openrouter.ai/api 式前缀网关）→ `{base}/models` → 源站根 `{origin}/v1/models`、`{origin}/models`（Bearer；覆盖 DeepSeek `/anthropic` 这类只在 OpenAI 面提供列表的双面网关，以及 API 类型与基址错配的配置）；openai 系 `{base}/models` → `{base}/v1/models` → 同样源站兜底；鉴权头 Bearer 与 x-api-key+anthropic-version 双发（只认其一的网关不受影响）；15s 超时覆盖整条候选链；取 `data[].id` trim/去重/排序；错误信息列出已尝试路径（不含完整 URL）；日志/错误不含 key。候选顺序经真实端点实测确定（DeepSeek：`/anthropic/models` 与 `/anthropic/v1/models` 均 404，仅源站 OpenAI 面 200）。
- `providerFacadeServices.ts`：接口 `listProviderModels` + 工厂第 4 个可选依赖（未装配抛「当前 Environment 未装配模型列表能力」，对齐 testConnectivity 报错语义）。
- `providerRuntime.ts`：可选 `apiFetch` 依赖；`services/node.ts` 注入 `hostApiNetworkTransport.fetch`。

**UI（面 1 删除）**
- constants.ts 删 `PresetProviderSpec`/`PRESET_PROVIDER_SPECS`/`PRESET_PROVIDER_SPEC_BY_ID`；useModelProviderNavigation 只保留 custom 分组；ModelProviderSection 删 presetProviders 链并新增 `providerListLoading`；Detail 删占位分支并新增空状态（复用 `settings.modelProvider.empty`）；Navigation 删 preset 渲染路径；ProviderPlaceholderCards 删 PresetProviderPlaceholderCard；删除死组件 StartPlanCard/StartPlanQuotaStatusCard/BigModelRegistrationHint 及 BIGMODEL_REGISTRATION_URL 链。

**UI（面 2）**
- ProviderTemplatePicker：去智谱分组 + 过滤 4 个 zhipu 模板 id（不落「其他」组）；数据侧 zcode-builtin.json 不动。

**UI（拉取）**
- ProviderModelMetadataDialog：新增 providerId prop、「拉取模型列表」按钮（loading/错误/空态）+ **可输入下拉框（combobox，用户两轮反馈定型）**：拉取成功后模型 ID 输入框本身承担候选——聚焦或输入即弹出候选层（PopoverContent 不抢焦点 `onOpenAutoFocus` 阻止）、输入内容即过滤词（子串大小写不敏感，空=全部）、点选即填入（`onMouseDown` 阻止抢焦点），右侧 chevron 提示可下拉；保留任意手输。两个关键坑：①Radix Presence 在该上下文中 exit 动画可能不触发导致关闭后面板不卸载（幽灵弹层），内容改为跟随 `modelsPickerOpen` 条件渲染，关闭即卸载；②Popover 嵌 Dialog 的滚轮被滚动锁吞掉，显式驱动 `scrollTop`（同 RemoteConnectionFields 范式）。ProviderFormControls/ProviderCardSections 下传 providerId；新增/编辑态均可用。文件超 400 行门禁，按目录既有约定加 `/* eslint-disable max-lines */` 登记。

**i18n**：删 4 个智谱 key、增 5 个 fetchModels key（含两轮反馈新增的 fetchModelsNoMatch，zh/en 同步）。

## 详细改动说明

- 面板空态修复：预设组删除后原「占位卡兜底」消失会导致无供应商时永远 loading——改为按列表加载态判定，加载完且空则渲染空状态。
- 保留面（按拍板边界）：CODING_PLAN_PROVIDER_SPECS、BUILTIN_PROVIDER_TEMPLATE_IDS、legacy 导入映射、MODEL_PROVIDER_FAMILY_SPECS、模板数据。

## 测试策略

- `node scripts/check-i18n-parity.mjs` 通过（5900=5900）。
- `tsc -b`：packages/services ✓、packages/ui（含 provider/shared/services/rpc 工程）✓。
- oxlint 改动路径 0 error；architecture-check violations 0。
- 运行时烟雾（tsx + 本地 HTTP mock）：OpenAI 请求行/头、Anthropic 头、`[" b ","a","a","",42]→["a","b"]`、401 可读且 leaksKey:false、缺 baseUrl/不存在/超时可读。
- 候选链真实端点验证：anthropic 基址（`api.deepseek.com/anthropic`）与 openai 基址（`api.deepseek.com`）两种形态、以及「openai 类型 + /anthropic 基址」错配形态均拿到 `["deepseek-flash","deepseek-v4-pro"]`；全 404 时错误信息列出全部已试路径；401 仅发一次请求即抛出。
- 实机（CDP）：模型设置分区无智谱组/占位卡 ✓；添加供应商选择器仅「其他」组 ✓；添加模型弹窗实机拉取 DeepSeek 成功渲染芯片并点选填入 `deepseek-v4-pro` ✓（历史证据：当时为芯片形态，终态为可输入下拉，见「UI（拉取）」变更点）。

## 风险与回滚方案

- 模板数据保留导致 zcode-builtin.json 内仍有 zai/bigmodel 模板（不可见）；未来彻底删数据需配 overlay 物化迁移（登记后续）。
- /models 端点非标（部分网关不实现）时给出可读错误，不影响手输路径。
- 回滚：git checkout 相关文件即可（数据未动）。
