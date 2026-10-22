// T-CP2（upstream-v316-fullsync §phase-c1-composer Step 4）：ModelConfigSelect 的
// composerOptions 合并入口移植载体断言。
//
// 断言分三层（Radix DropdownMenu 的 Content 走 Portal，SSR 恒不输出，故菜单内容
// 用 @radix-ui/react-menu 原语直桥渲染同一批装配组件——断言的是同一棵装配子树）：
// 1. 触发器层：composerOptions 缺席时旧版面逐结构等价、无任何合并标记；
//    在场时进入 combined 形态（data-composer-combined-model + collapse-priority 3）。
// 2. 菜单装配层：旧路径渲染分组/菜单项/吸底 footer；合并路径渲染
//    ComposerModelMenu 内容（供应商列表/模型列表/思考滑杆/providerFooter）。
// 3. 纯函数层：isGlmHighspeedModel / getComposerThoughtDisplay。
//
// 运行形态（组件链依赖 @/ 路径别名与二进制资产 mock，裸 node --test 无法直接解析）：
//   TSX_TSCONFIG_PATH=packages/ui/tsconfig.json \
//   node --import tsx --import ./packages/ui/test/helpers/register-ui-asset-loader.mjs \
//   --test packages/ui/test/modelConfigSelect-composer.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { TID_CHAT_MODEL_SELECT_GROUP, TID_CHAT_MODEL_SELECT_ITEM, testId } from "@zcode/shared";
import { ModelConfigSelect, type ModelSelectGroup } from "../src/ModelConfigSelect.js";
import { ModelConfigSelectLegacyMenu } from "../src/ModelConfigSelectLegacyMenu.js";
import { ModelConfigSelectComposerMenu } from "../src/ModelConfigSelectComposerMenu.js";
import {
  getComposerThoughtDisplay,
  isGlmHighspeedModel,
  type ComposerModelOptions,
} from "../src/chat-input-toolbar/ComposerModelMenu.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

const modelGroups: ModelSelectGroup[] = [
  {
    key: "registry-provider:glm",
    label: "GLM",
    items: [
      { key: "glm-4.7", value: "glm-4.7", name: "GLM-4.7" },
      { key: "glm-4.7-air", value: "glm-4.7-air", name: "GLM-4.7 Air" },
    ],
  },
  {
    key: "registry-provider:openai",
    label: "OpenAI",
    items: [{ key: "gpt-5", value: "gpt-5", name: "GPT-5" }],
  },
  {
    // directItems 分组的模型项不经子菜单（Radix SubContent 在 SSR 不渲染），可断言直渲染。
    key: "direct:builtin",
    label: "Direct",
    directItems: true,
    items: [{ key: "local-model", value: "local-model", name: "Local Model" }],
  },
];

const composerOptions: ComposerModelOptions = {
  providerLabel: "供应商",
  modelsLabel: "模型",
  effortLabel: "思考强度",
  selectModelLabel: "选择模型",
  levels: [
    { value: "off", label: "关闭" },
    { value: "low", label: "低" },
    { value: "high", label: "高" },
  ],
  value: "low",
  onValueChange: () => {},
};

function renderSelect(props: Parameters<typeof ModelConfigSelect>[0]): string {
  // 应用壳在根层提供 TooltipProvider；SSR 渲染这里补齐同一上下文。
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ModelConfigSelect, props),
      ),
    ),
  );
}

/**
 * Radix 菜单原语直桥：为装配组件提供 MenuContent 上下文（真实组件树由 omz 的
 * DropdownMenuContent 提供，但它内部包 Portal 在 SSR 恒不输出，故这里绕开
 * Portal、直用与组件同模块实例的 dropdown-menu 原语）。
 */
function renderInsideMenuContent(children: Parameters<typeof createElement>[0]): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          DropdownMenuPrimitive.Root,
          { open: true },
          createElement(DropdownMenuPrimitive.Content, null, children),
        ),
      ),
    ),
  );
}

function includesAll(html: string, markers: readonly string[], scope: string) {
  for (const marker of markers) {
    assert.ok(html.includes(marker), `${scope} 应包含 ${marker}`);
  }
}

function includesNone(html: string, markers: readonly string[], scope: string) {
  for (const marker of markers) {
    assert.ok(!html.includes(marker), `${scope} 不应出现 ${marker}`);
  }
}

const legacyMenuBase = {
  normalizedValue: "glm-4.7",
  isItemLocked: () => false,
  lockReasonMessage: "已锁定",
  onSelectModel: () => {},
  onConnectionValueChange: undefined,
  close: () => {},
} as const;

test("composerOptions 缺席：关闭态触发器保持旧版面（fullLabel+ChevronDown，无 combined 标记）", () => {
  const html = renderSelect({
    modelGroups,
    normalizedValue: "glm-4.7",
    triggerLabel: "GLM-4.7",
    showManageModelsAction: false,
    lockReasonMessage: "已锁定",
    isItemLocked: () => false,
    onValueChange: () => {},
    tooltipTitle: "模型",
  });
  includesAll(
    html,
    ['data-testid="chat-model-select-trigger"', 'data-model-current-value="glm-4.7"', "GLM-4.7"],
    "关闭态旧路径",
  );
  // omz 版面红线：触发器下拉指示保持原样（ChevronDown 图标与 subtle 色类名不变）。
  assert.ok(html.includes("text-foreground-subtle"), "Chevron 指示类名应保留");
  // 合并入口专属标记一律不出现。
  includesNone(
    html,
    [
      "data-composer-combined-model",
      "data-composer-collapse-priority",
      "data-composer-open-label",
      "composer-thought-slider",
      "composer-provider-trigger",
    ],
    "关闭态旧路径",
  );
});

test("composerOptions 缺席：旧菜单装配层渲染 provider 分组 + 吸底 footer，无合并菜单内容", () => {
  const html = renderInsideMenuContent(
    createElement(ModelConfigSelectLegacyMenu, {
      modelGroups,
      showProviderLevel: true,
      renderedFooterActions: [{ key: "manage-models", label: "管理模型", onSelect: () => {} }],
      ...legacyMenuBase,
    }),
  );
  // provider 分组子菜单与直渲染模型项 testId 与移植前一致。
  // （子菜单 SubContent 由 Radix Presence 控制，未展开的 SSR 不输出——子菜单内容
  // 结构由扁平分支用例覆盖，这里断言分组入口与 directItems 直渲染项。）
  includesAll(
    html,
    [
      testId(TID_CHAT_MODEL_SELECT_GROUP, "registry-provider:glm"),
      testId(TID_CHAT_MODEL_SELECT_GROUP, "registry-provider:openai"),
      // 当前选中值所在分组带选中态。
      'data-model-provider-selected="true"',
      testId(TID_CHAT_MODEL_SELECT_ITEM, "local-model"),
      "Local Model",
      // manage-models 仍在旧版吸底 footer。
      'data-model-footer-action="manage-models"',
    ],
    "旧菜单装配层",
  );
  // 合并菜单专属结构不出现。
  includesNone(
    html,
    [
      "data-composer-provider-list",
      "data-composer-model-list",
      "composer-thought-slider",
      "data-composer-provider-back",
    ],
    "旧菜单装配层",
  );
});

test("composerOptions 缺席：扁平列表（showProviderLevel=false）仍渲染第一组模型项", () => {
  const html = renderInsideMenuContent(
    createElement(ModelConfigSelectLegacyMenu, {
      modelGroups,
      showProviderLevel: false,
      flatItems: modelGroups[0]?.items,
      renderedFooterActions: [],
      ...legacyMenuBase,
    }),
  );
  includesAll(
    html,
    [
      testId(TID_CHAT_MODEL_SELECT_ITEM, "glm-4.7"),
      testId(TID_CHAT_MODEL_SELECT_ITEM, "glm-4.7-air"),
    ],
    "扁平旧路径",
  );
});

test("composerOptions 在场：触发器进入 combined 形态并携带折叠优先级 3", () => {
  const html = renderSelect({
    modelGroups,
    normalizedValue: "glm-4.7",
    triggerLabel: "GLM-4.7",
    composerOptions,
    showManageModelsAction: false,
    lockReasonMessage: "已锁定",
    isItemLocked: () => false,
    onValueChange: () => {},
    tooltipTitle: "模型",
  });
  includesAll(
    html,
    [
      'data-composer-combined-model="true"',
      'data-composer-collapse-priority="3"',
      // 关闭态展示模型名与档位指示（aria-label 追加当前档位）。
      'aria-label="模型 低"',
      "data-composer-thought-label",
      'data-testid="composer-thought-meter"',
    ],
    "合并关闭态",
  );
});

test("composerOptions 在场：合并菜单装配层内容来自 ComposerModelMenu（供应商/模型/滑杆/管理入口）", () => {
  const html = renderInsideMenuContent(
    createElement(ModelConfigSelectComposerMenu, {
      modelGroups,
      normalizedValue: "glm-4.7",
      composerOptions,
      isItemLocked: () => false,
      lockReasonMessage: "已锁定",
      onSelectModel: () => {},
      onModelValueChange: () => {},
      onConnectionValueChange: undefined,
      showManageModelsAction: true,
      manageModelsLabel: "管理模型",
      onManageModels: undefined,
      close: () => {},
    }),
  );
  includesAll(
    html,
    [
      // 供应商行（宽形态 SubTrigger；列表在 SubContent 内，未展开的 SSR 不输出）。
      'data-testid="composer-provider-trigger"',
      'aria-label="供应商: GLM"',
      // 模型列表与分组内模型项（Content 直下，SSR 输出）。
      "data-composer-model-list",
      testId(TID_CHAT_MODEL_SELECT_ITEM, "glm-4.7-air"),
      // 思考强度滑杆（3 档目录，SSR 把 JSON 属性值里的引号转义为 &quot;）。
      "composer-thought-slider",
      'data-levels="[&quot;off&quot;,&quot;low&quot;,&quot;high&quot;]"',
      "思考强度",
      // providerFooter（manage-models）与供应商列表同在 SubContent，SSR 不可断言；
      // 其装配正确性由 ComposerMenu 的 props 透传与真机验收（Step 5）覆盖。
    ],
    "合并菜单装配层",
  );
});

test("合并入口纯函数：isGlmHighspeedModel 只按显示名命中 GLM Highspeed/FlashX", () => {
  assert.equal(isGlmHighspeedModel("GLM-4.7-Highspeed"), true);
  assert.equal(isGlmHighspeedModel("glm-flashx"), true);
  assert.equal(isGlmHighspeedModel("GLM-4.7"), false);
  assert.equal(isGlmHighspeedModel("Other Highspeed"), false);
});

test("合并入口纯函数：getComposerThoughtDisplay 的进度把无思考档位排除在分母外", () => {
  // thinking = [low, high]，当前 low → (0+1)/2 = 50%。
  const display = getComposerThoughtDisplay(composerOptions);
  assert.equal(display.label, "低");
  assert.equal(display.progress, 50);
});
