/**
 * T-PV2（backlog-sweep Step 25）：删除入口右移 + 更多菜单整删的形态守卫。
 *
 * ①`canDeleteModelProvider`：只有 standard-personal 展示删除入口（服务层同一约束）；
 * ②删除按钮：标题栏右侧 TID + Trash2 + 仅 onDelete 存在时渲染 + 确认框 destructive；
 * ③更多菜单零残：DropdownMenu/MoreHorizontal/Pencil/actionsVisible/secondaryActionsVisible
 *   /model-provider-actions-button/名称编辑 TID 在触碰面全部 0 命中；
 * ④i18n 孤儿键 `settings.modelProvider.renameProvider` 两语言均删除（对称）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { canDeleteModelProvider } from "../src/settings/model-provider-section/modelProviderActions.js";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(here, "..", "src");
const sharedSrc = join(here, "..", "..", "shared", "src");

const actionsSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "modelProviderActions.ts"),
  "utf8",
);
const cardSectionsSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "ProviderCardSections.tsx"),
  "utf8",
);
const editableCardSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "InlineEditableProviderCard.tsx"),
  "utf8",
);
const detailSource = readFileSync(
  join(uiSrc, "settings", "model-provider-section", "Detail.tsx"),
  "utf8",
);
const testIdsSource = readFileSync(join(sharedSrc, "test-ids.ts"), "utf8");
const zhLocale = readFileSync(join(uiSrc, "i18n", "locales", "zh-CN.ts"), "utf8");
const enLocale = readFileSync(join(uiSrc, "i18n", "locales", "en-US.ts"), "utf8");

function providerWithGroup(group: string | undefined): ProviderSettingsFormProvider {
  return {
    providerId: "provider-1",
    providerName: "自定义供应商",
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: { group },
    config: { group },
    models: [],
  } as unknown as ProviderSettingsFormProvider;
}

test("canDeleteModelProvider：仅 personal provider 展示删除入口", () => {
  assert.equal(canDeleteModelProvider(providerWithGroup("standard-personal")), true);
  // FORK（D-13/D-4）：family 面已整删，判定仍按服务层约束给出 false，而不是「按钮可点但服务层拒绝」。
  assert.equal(canDeleteModelProvider(providerWithGroup("zai-family")), false);
  assert.equal(canDeleteModelProvider(providerWithGroup("bigmodel-family")), false);
  assert.equal(canDeleteModelProvider(providerWithGroup(undefined)), false);
});

test("删除链路：去掉 family 死守卫，确认框使用 destructive 变体", () => {
  assert.doesNotMatch(
    actionsSource,
    /provider\.config\.group === "zai-family"/,
    "family 早退守卫已无命中对象，必须删除",
  );
  assert.match(actionsSource, /confirmVariant: "destructive"/);
  assert.match(detailSource, /canDeleteModelProvider\(customProvider\)/);
  assert.match(
    detailSource,
    /onDelete=\{deletable \? \(\) => onDelete\(customProvider\) : undefined\}/,
    "不可删除的供应商不得传 onDelete（标题栏按钮随之不渲染）",
  );
});

test("删除按钮在标题栏右侧：TID + Trash2 + 仅 onDelete 存在时渲染", () => {
  assert.match(testIdsSource, /export const TID_MODEL_PROVIDER_DELETE_BUTTON =/);
  const deleteButtonIndex = cardSectionsSource.indexOf(
    "data-testid={TID_MODEL_PROVIDER_DELETE_BUTTON}",
  );
  assert.ok(deleteButtonIndex > 0, "标题栏删除按钮必须挂 TID");
  const deleteBlock = cardSectionsSource.slice(
    cardSectionsSource.lastIndexOf("<Button", deleteButtonIndex),
    cardSectionsSource.indexOf("</Button>", deleteButtonIndex),
  );
  assert.match(deleteBlock, /size="icon-sm"/, "删除按钮使用 icon-sm 尺寸");
  assert.match(deleteBlock, /<Trash2 className="size-3.5"/, "删除图标与 Subagents 卡片同构");
  assert.match(deleteBlock, /onClick=\{onDelete\}/);
  assert.match(cardSectionsSource, /\{onDelete \? \(/, "删除按钮仅在 onDelete 存在时渲染");
  // 删除仍留在卡片子树内：handleDeleteProvider 设置 deleteRequestedRef 后才交给父层。
  assert.match(editableCardSource, /onDelete=\{onDelete \? handleDeleteProvider : undefined\}/);
  assert.match(editableCardSource, /deleteRequestedRef\.current = true/);
});

test("更多菜单零残：DropdownMenu/Pencil/MoreHorizontal/死参数全部 0 命中", () => {
  for (const residue of [
    "DropdownMenu",
    "MoreHorizontal",
    "Pencil",
    "actionsVisible",
    "secondaryActionsVisible",
    "model-provider-actions-button",
    "TID_MODEL_PROVIDER_NAME_EDIT_BUTTON",
  ]) {
    assert.ok(!cardSectionsSource.includes(residue), `ProviderCardSections 不得残留 ${residue}`);
  }
  assert.ok(!editableCardSource.includes("headerActionsVisible"), "卡片不得再透传死参数");
  assert.ok(!testIdsSource.includes("TID_MODEL_PROVIDER_NAME_EDIT_BUTTON"), "名称编辑 TID 已退役");
  assert.ok(!testIdsSource.includes("model-provider-name-edit-button"));
  assert.match(testIdsSource, /export const TID_MODEL_PROVIDER_NAME_TRIGGER =/);
});

test("i18n：renameProvider 两语言对称删除，复用键仍两语言在位", () => {
  assert.ok(!zhLocale.includes('"settings.modelProvider.renameProvider"'), "zh-CN 已删除孤儿键");
  assert.ok(!enLocale.includes('"settings.modelProvider.renameProvider"'), "en-US 已删除孤儿键");
  for (const key of [
    "settings.modelProvider.name",
    "settings.modelProvider.namePlaceholder",
    "settings.modelProvider.addProviderTitle",
    "settings.modelProvider.addProviderDescription",
    "settings.modelProvider.addFromCatalog",
    "settings.modelProvider.addPureCustom",
  ]) {
    assert.ok(zhLocale.includes(`"${key}":`), `zh-CN 缺少 ${key}`);
    assert.ok(enLocale.includes(`"${key}":`), `en-US 缺少 ${key}`);
  }
});
