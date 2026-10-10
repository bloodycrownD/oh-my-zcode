#!/usr/bin/env node
/**
 * historian 模型选择器的取值转换链测试（`toPersistedModelId` / `toModelPickerValue`）。
 *
 * 背景（2026-10-05 实机复现的设置页 bug）：`ModelConfigSelect` 菜单项的 value 是
 * `encodeCustomModelValue` 的产物（`custom:provider:model`，URI 编码 + 冒号分隔），
 * 而 `toPersistedModelId` 修复前只走 `parseModelPickerValue`（只认 `provider/model`），
 * 对 `custom:` 串在 `indexOf("/")` 一步就抛「缺少 Provider」，被 catch 静默吞成 ""——
 * 用户在设置页选中的模型直接消失：触发器回不到模型名、保存按钮永不点亮。
 * 本套件锁住读写两个方向的转换，防止再次只修一端。
 *
 * 与 `test-magic-context-ui-config.mjs` 同一条纪律：跑 `packages/ui` 的 **dist 产物**
 * （先 `pnpm typecheck` / `tsc -b packages/ui`），`@zcode/shared` 同样解析到 dist。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const { encodeCustomModelValue } = await import("@zcode/shared");
const { MagicContextConfigSchema } = await import("@zcode/magic-context");

const UI_FORM_DIST = `${REPO_ROOT}packages/ui/dist/settings/magicContextSettingsForm.js`;
if (!existsSync(UI_FORM_DIST)) {
  throw new Error(
    `missing ${UI_FORM_DIST} — run the root \`pnpm typecheck\` (tsc -b packages/ui) first`,
  );
}
const {
  buildMagicContextConfigFromForm,
  magicContextSettingsFormFromConfig,
  toModelPickerValue,
  toPersistedModelId,
} = await import(pathToFileURL(UI_FORM_DIST).href);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — historian model picker value conversion"
      : `TEST FAIL — historian model picker value conversion (exit code ${code})`,
  );
});

test("menu item values (`custom:provider:model`) persist as `provider/model`", () => {
  // 修复前：parseModelPickerValue("custom:bigmodel-api:GLM-5.3") 抛「缺少 Provider」，
  // catch 返回 ""，选中即清空。
  assert.equal(toPersistedModelId(encodeCustomModelValue("bigmodel-api", "GLM-5.3")), "bigmodel-api/GLM-5.3");
  assert.equal(toPersistedModelId(encodeCustomModelValue("deepseek", "deepseek-chat")), "deepseek/deepseek-chat");
});

test("URI-encoded provider/model round-trips through the picker value", () => {
  // provider/model 里含保留字符（空格、斜杠）时 encode 会做 encodeURIComponent；
  // decode 端必须还原成原始字符，否则写盘的身份串与真实 provider/model 不一致。
  const encoded = encodeCustomModelValue("my provider", "model/name with space");
  assert.equal(
    toPersistedModelId(encoded),
    "my provider/model/name with space",
  );
});

test("legacy `provider/model` picker values still parse directly", () => {
  assert.equal(toPersistedModelId("zcode/glm-4.6"), "zcode/glm-4.6");
});

test("sentinel and unparseable values collapse to empty (off)", () => {
  assert.equal(toPersistedModelId("none"), "");
  assert.equal(toPersistedModelId("garbage-without-separator"), "");
  assert.equal(toPersistedModelId(""), "");
});

test("FORK（impl-historian-inherit）：inherit sentinel passes through both directions", () => {
  // 下发的「继承会话模型（默认）」footer 项不走身份串解析，但往返链上任何一端把它
  // 当成「解析不出来」都会把用户的显式选择静默变成「关闭」。
  assert.equal(toPersistedModelId("inherit"), "inherit");
  assert.equal(toModelPickerValue("inherit"), "inherit");
});

test("read direction: persisted `provider/model` renders back as the same picker value", () => {
  const encoded = encodeCustomModelValue("bigmodel-api", "GLM-5.3");
  // 写方向落盘 "bigmodel-api/GLM-5.3"；读方向要能回到菜单项的 value，
  // 否则选中态高亮和触发器 label 都对不上。
  assert.equal(toModelPickerValue("bigmodel-api/GLM-5.3"), encoded);
  assert.equal(toModelPickerValue(""), "none");
});

test("end-to-end: a menu selection survives a full form save", () => {
  const base = MagicContextConfigSchema.parse({});
  const persisted = toPersistedModelId(encodeCustomModelValue("bigmodel-api", "GLM-5.3"));
  assert.equal(persisted, "bigmodel-api/GLM-5.3");

  // buildMagicContextConfigFromForm 是设置页写盘的唯一入口；选中值必须原样
  // 落到 historian.model 且整域仍能被 CLI 的 schema 接受。
  const form = magicContextSettingsFormFromConfig(base, {
    enabled: true,
    executeThresholdPercentage: 65,
    executeThresholdTokens: null,
    protectedTokens: null,
    historyBudgetPercentage: 0.15,
    cacheTtl: "5m",
    historianModel: "inherit",
    smartDrops: false,
    failClosedBlocking: true,
  });
  assert.equal(form.historianModel, "inherit");
  const next = buildMagicContextConfigFromForm(base, { ...form, historianModel: persisted });
  assert.equal(next.historian.model, "bigmodel-api/GLM-5.3");
  const reparsed = MagicContextConfigSchema.parse(next);
  assert.equal(reparsed.historian.model, "bigmodel-api/GLM-5.3");
});
