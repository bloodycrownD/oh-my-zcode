/**
 * T-PV1（backlog-sweep Step 23-24）：新建供应商名称弹窗 + 点击命名。
 *
 * 形态沿用本仓 UI 测试基建（无 jsdom）：可判定规则走纯逻辑，接线走源码形状守卫。
 * ①`resolveCreateProviderName`：空/纯空白拦截、重名（大小写/首尾空白归一）拦截、通过值归一；
 * ②`resolveCreateProviderPrefillName`：模板路径预填模板名，自定义路径预填「新供应商」，
 *   模板名缺失回退通用名；
 * ③弹窗挂载点形状：Section 持选中意图 state、Template 选择回调只上报 onPicked、
 *   弹窗三 TID 在位、6 个孤儿键全部复用；
 * ④点击命名 button 形状：名称本身为 button 且单击进入命名态，重复点击幂等。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { PROVIDER_NAME_EXISTS_MESSAGE_PREFIX } from "@zcode/provider";

import {
  isProviderNameExistsError,
  resolveCreateProviderBanner,
  resolveCreateProviderName,
  resolveCreateProviderPrefillName,
} from "../src/settings/model-provider-section/createProviderNameDialog.js";
import { resolvePendingProviderDraftSave } from "../src/settings/model-provider-section/ProviderDraftSave.js";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(here, "..", "src");
const sharedSrc = join(here, "..", "..", "shared", "src");

const sectionSource = readFileSync(join(uiSrc, "settings", "ModelProviderSection.tsx"), "utf8");
const pickerSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "ProviderTemplatePicker.tsx"),
  "utf8",
);
const dialogSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "ProviderCreateNameDialog.tsx"),
  "utf8",
);
const nameDialogLogicSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "createProviderNameDialog.ts"),
  "utf8",
);
const localesDir = join(uiSrc, "i18n", "locales");
const zhLocaleSource = readFileSync(join(localesDir, "zh-CN.ts"), "utf8");
const enLocaleSource = readFileSync(join(localesDir, "en-US.ts"), "utf8");
const cardSectionsSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "ProviderCardSections.tsx"),
  "utf8",
);
const editableCardSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "InlineEditableProviderCard.tsx"),
  "utf8",
);
const testIdsSource = readFileSync(join(sharedSrc, "test-ids.ts"), "utf8");

test("resolveCreateProviderName：空/纯空白名称拦截，不进入创建链路", () => {
  assert.deepEqual(resolveCreateProviderName({ rawName: "", existingNames: [] }), {
    status: "empty",
  });
  assert.deepEqual(resolveCreateProviderName({ rawName: "   ", existingNames: [] }), {
    status: "empty",
  });
  assert.deepEqual(resolveCreateProviderName({ rawName: "\t\n\u3000", existingNames: [] }), {
    status: "empty",
  });
});

test("resolveCreateProviderName：重名按 trim + 大小写不敏感拦截", () => {
  const existingNames = ["Z.ai GLM", "My Provider"];
  // 大小写与首尾空白都不应绕过拦截：服务层用同一口径比较。
  assert.deepEqual(resolveCreateProviderName({ rawName: "  z.ai glm  ", existingNames }), {
    status: "duplicate",
    name: "z.ai glm",
  });
  assert.deepEqual(resolveCreateProviderName({ rawName: "MY PROVIDER", existingNames }), {
    status: "duplicate",
    name: "MY PROVIDER",
  });
});

test("重名文案单一定义：UI 引用服务层前缀常量，展示走 nameExists i18n 键", () => {
  // 文案唯一定义处在 @zcode/provider（服务层抛错拼接）与 i18n 键（展示）各一处：
  // UI 只引用前缀常量做匹配判定，不再自带中文副本。
  assert.equal(PROVIDER_NAME_EXISTS_MESSAGE_PREFIX, "Provider 名称已存在");
  assert.match(
    nameDialogLogicSource,
    /import \{ PROVIDER_NAME_EXISTS_MESSAGE_PREFIX \} from "@zcode\/provider"/,
    "UI 重名前缀必须引用 @zcode/provider 导出常量",
  );
  assert.ok(
    !nameDialogLogicSource.includes("Provider 名称已存在"),
    "UI 纯逻辑模块不得再复制重名文案字面量",
  );
  assert.ok(
    !dialogSource.includes("Provider 名称已存在"),
    "弹窗不得直接渲染服务层重名文案（en-US 会掉回中文）",
  );
  assert.match(zhLocaleSource, /"settings\.modelProvider\.nameExists": "Provider 名称已存在"/);
  assert.match(
    enLocaleSource,
    /"settings\.modelProvider\.nameExists": "Provider name already exists"/,
  );
  assert.equal(isProviderNameExistsError("Provider 名称已存在: 新供应商"), true);
  assert.equal(isProviderNameExistsError("个人供应商配置格式无效"), false);
});

test("resolveCreateProviderName：通过时返回 trim 后的名称", () => {
  assert.deepEqual(
    resolveCreateProviderName({ rawName: "  新供应商  ", existingNames: ["Z.ai GLM"] }),
    { status: "ok", name: "新供应商" },
  );
});

test("resolveCreateProviderBanner：优先级 duplicate > empty > create，只有创建失败给重试", () => {
  const duplicate = { status: "duplicate", name: "Z.ai GLM" } as const;
  const empty = { status: "empty" } as const;
  const ok = { status: "ok", name: "新供应商" } as const;

  // ①重名与服务端错误并存：重名优先，且不给重试（重试必然再次撞名）。
  assert.deepEqual(resolveCreateProviderBanner({ resolution: duplicate, errorMessage: "boom" }), {
    kind: "duplicate",
    showRetry: false,
  });
  // ②空名与服务端错误并存：必填优先于任何服务端错误。
  assert.deepEqual(resolveCreateProviderBanner({ resolution: empty, errorMessage: "boom" }), {
    kind: "empty",
    showRetry: false,
  });
  // ③仅服务端错误：创建失败，提供重试。
  assert.deepEqual(resolveCreateProviderBanner({ resolution: ok, errorMessage: "boom" }), {
    kind: "create",
    showRetry: true,
  });
  // ④全空：无横幅。
  assert.deepEqual(resolveCreateProviderBanner({ resolution: ok, errorMessage: null }), {
    kind: null,
    showRetry: false,
  });
  // 无服务端错误时，前端校验自身也要能出对应提示。
  assert.equal(
    resolveCreateProviderBanner({ resolution: duplicate, errorMessage: null }).kind,
    "duplicate",
  );
  assert.equal(
    resolveCreateProviderBanner({ resolution: empty, errorMessage: null }).kind,
    "empty",
  );
  // 服务层并发兜底：原始错误命中前缀也算重名（前端已拦截，仍可能被并发创建撞上），
  // 只做分类、不上屏，也不给重试。
  assert.deepEqual(
    resolveCreateProviderBanner({
      resolution: ok,
      errorMessage: `${PROVIDER_NAME_EXISTS_MESSAGE_PREFIX}: 新供应商`,
    }),
    { kind: "duplicate", showRetry: false },
  );
});

test("空名/纯空白必须给必填提示：kind === empty 分支复用 forms.validation.nameRequired", () => {
  assert.equal(
    resolveCreateProviderName({ rawName: "\u3000\t\n ", existingNames: [] }).status,
    "empty",
  );
  assert.match(
    dialogSource,
    /banner\.kind === "empty"\s*\?\s*"forms\.validation\.nameRequired"/,
    "kind === empty 分支必须渲染 forms.validation.nameRequired（不新增键）",
  );
  // 原始服务层错误串不上屏：data 属性直接取 kind。
  assert.match(dialogSource, /data-provider-create-error=\{banner\.kind\}/);
  assert.doesNotMatch(dialogSource, /PROVIDER_NAME_EXISTS_MESSAGE/);
});

test("resolveCreateProviderPrefillName：模板路径预填模板名，自定义路径预填通用名", () => {
  assert.equal(
    resolveCreateProviderPrefillName({
      templateId: "openai-compatible",
      templateName: "OpenAI 兼容",
      fallbackName: "新供应商",
    }),
    "OpenAI 兼容",
  );
  assert.equal(resolveCreateProviderPrefillName({ fallbackName: "新供应商" }), "新供应商");
  // 历史模板没有名称映射时不能把空串带进必填校验。
  assert.equal(
    resolveCreateProviderPrefillName({
      templateId: "legacy-template",
      templateName: "   ",
      fallbackName: "新供应商",
    }),
    "新供应商",
  );
});

test("名称提交归一化：仅 nameConfirmed 时写入 trim 后的名称", () => {
  const provider = {
    providerId: "provider-1",
    providerName: "旧名字",
    templateId: undefined,
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
    },
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-old" },
      api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
    },
    models: [],
  } as unknown as ProviderSettingsFormProvider;
  const draft = {
    nameValue: "  新名字  ",
    apiFormat: "openai-chat-completions" as const,
    baseUrlValue: "https://api.example.com/v1",
    apiKeyValue: "sk-old",
  };
  const now = () => 0;

  const confirmed = resolvePendingProviderDraftSave({
    provider,
    draft,
    nameConfirmed: true,
    now,
  });
  assert.equal(confirmed?.providerName, "新名字");
  assert.equal(confirmed?.providerNameUpdate, "新名字");

  // nameConfirmed 闸门不动：闲时保存/连接测试/卸载都不能夹带未确认的名称。
  const unconfirmed = resolvePendingProviderDraftSave({
    provider,
    draft,
    nameConfirmed: false,
    now,
  });
  assert.equal(unconfirmed, null);
});

test("弹窗挂载点：Section 持选中意图状态并渲染名称弹窗，Picker 只上报 onPicked", () => {
  assert.match(
    sectionSource,
    /const \[createPick, setCreatePick\] = useState<ProviderTemplatePick \| null>\(null\)/,
    "Section 必须持有名称弹窗的选中意图状态",
  );
  assert.match(sectionSource, /<ProviderCreateNameDialog/, "Section 渲染名称弹窗");
  assert.match(
    sectionSource,
    /onPicked=\{\(pick\) => \{/,
    "Template 选择页通过 onPicked 上报选择结果",
  );
  assert.match(
    sectionSource,
    /handleCreateProvider\(\{ templateId: createPick\?\.templateId, providerName \}\)/,
    "弹窗确认后由 Section 调既有创建链路",
  );
  // Picker 不再直接创建：旧回调与失败横幅都必须消失，避免双写创建入口。
  assert.doesNotMatch(pickerSource, /onCreateFromTemplate|onCreateCustom/);
  assert.doesNotMatch(pickerSource, /createWithFeedback|templateCreateFailed/);
  assert.match(pickerSource, /onPicked: \(pick: ProviderTemplatePick\) => void/);
  assert.doesNotMatch(sectionSource, /onCreateFromTemplate|onCreateCustom/);
});

test("弹窗三 TID 在位，失败复用 templateCreateFailed 与重试动作", () => {
  for (const tid of [
    "TID_MODEL_PROVIDER_NAME_DIALOG",
    "TID_MODEL_PROVIDER_NAME_DIALOG_INPUT",
    "TID_MODEL_PROVIDER_NAME_DIALOG_CONFIRM",
  ]) {
    assert.match(
      testIdsSource,
      new RegExp(`export const ${tid} =`),
      `${tid} 必须在 shared/test-ids.ts 定义`,
    );
    assert.ok(dialogSource.includes(tid), `弹窗必须挂载 ${tid}`);
  }
  // 展示统一在弹窗内按 kind 映射：Section 只回填原始错误，不再自带展示文案。
  assert.match(dialogSource, /settings\.modelProvider\.templateCreateFailed/);
  assert.doesNotMatch(sectionSource, /settings\.modelProvider\.templateCreateFailed/);
  assert.match(dialogSource, /settings\.modelProvider\.templateCreateRetry/);
  // 必填/重名在前端拦截：弹窗自身解析名称，非法值不进提交。
  assert.match(dialogSource, /resolveCreateProviderName/);
  assert.match(dialogSource, /settings\.modelProvider\.nameExists/);
});

test("6 个孤儿 i18n 键全部在新弹窗中复用", () => {
  for (const key of [
    "settings.modelProvider.name",
    "settings.modelProvider.namePlaceholder",
    "settings.modelProvider.addProviderTitle",
    "settings.modelProvider.addProviderDescription",
    "settings.modelProvider.addFromCatalog",
    "settings.modelProvider.addPureCustom",
  ]) {
    assert.ok(dialogSource.includes(key), `弹窗必须复用 ${key}`);
  }
});

test("点击命名：名称渲染为 button，单击进入命名态且重复点击幂等", () => {
  const triggerButton = cardSectionsSource.slice(
    cardSectionsSource.indexOf("data-testid={TID_MODEL_PROVIDER_NAME_TRIGGER}"),
    cardSectionsSource.indexOf(
      "</button>",
      cardSectionsSource.indexOf("data-testid={TID_MODEL_PROVIDER_NAME_TRIGGER}"),
    ),
  );
  assert.ok(triggerButton.length > 0, "名称触发按钮必须存在");
  assert.match(triggerButton, /onClick=\{onStartEditName\}/, "单击即进入命名态");
  // 单个 onClick（不是双击/切换语义）：避免一次双击派生「进入→退出」竞态。
  assert.doesNotMatch(triggerButton, /onDoubleClick/);
  assert.match(testIdsSource, /export const TID_MODEL_PROVIDER_NAME_TRIGGER =/);
  // 复用既有 IME/blur 机器：handleStartEditName 仍是唯一入口，且对重复点击幂等。
  assert.match(
    editableCardSource,
    /if \(nameEditProviderIdRef\.current === provider\.providerId\) \{\s*return;/,
    "handleStartEditName 必须对重复点击幂等（防双击重排焦点）",
  );
  assert.match(editableCardSource, /onStartEditName=\{handleStartEditName\}/);
  // Esc/Enter/blur 机器与 nameConfirmed 闸门保持原样。
  assert.match(editableCardSource, /resolveProviderNameEditKeyAction\(/);
  assert.match(editableCardSource, /commitPendingDraft\("name-blur", true\)/);
});
