// T-C2-6（bugfix-batch-20261009 uix/G-1）——资源管理器存储清理入口门控谓词。
//
// 被测模块 resource-manager/storage/storageCategoryModel.ts（零 `@/` 依赖的纯
// model，与 lib/subagentDirectoryCancel 同一约定；tsx 不解析 ui 包的 `@/*`
// 别名，所以带 `@/` 导入的 storageCategoryPresentation.ts 无法进单测）：
//   - isStorageCategoryCleanable 是三处 UI 门控（StorageCategoryList 类别行 /
//     StorageCategoryDetail 详情页 / StorageSection requestClean 守卫）的唯一口径；
//   - sumCategoriesAcrossRoots 负责把 aggregate 下发的 cleanScope 透传进
//     StorageCategoryTotal——漏传则三处门控恒 undefined、cli/exec 入口静默消失。
//
// 背景：toolOutputs 整组 cleanability 已回 "none"（不可一键清理），「仅 cli/exec
// 可清理」由 cleanScope="paths" 表达。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StorageCategoryId, StorageCategoryUsage, StorageRootUsage } from "@zcode/shared";
import {
  isStorageCategoryCleanable,
  sumCategoriesAcrossRoots,
} from "../src/resource-manager/storage/storageCategoryModel.js";

function usage(
  id: StorageCategoryId,
  bytes: number,
  overrides: Partial<StorageCategoryUsage> = {},
): StorageCategoryUsage {
  return { id, bytes, fileCount: 1, cleanability: "safe", entries: [], ...overrides };
}

function root(id: StorageRootUsage["id"], categories: StorageCategoryUsage[]): StorageRootUsage {
  return {
    id,
    path: `/data/${id}/.omz`,
    volume: null,
    bytes: categories.reduce((sum, category) => sum + category.bytes, 0),
    fileCount: categories.reduce((sum, category) => sum + category.fileCount, 0),
    categories,
  };
}

// ── 门控谓词 isStorageCategoryCleanable ─────────────────────────────────

test("safe / confirm 类别且有占用 → 放行（既有路径不变）", () => {
  assert.equal(isStorageCategoryCleanable({ cleanability: "safe", bytes: 1024 }), true);
  assert.equal(isStorageCategoryCleanable({ cleanability: "confirm", bytes: 1024 }), true);
});

test("none 且无 cleanScope → 不放行，即使有占用（整组不可一键清理）", () => {
  assert.equal(isStorageCategoryCleanable({ cleanability: "none", bytes: 4096 }), false);
  assert.equal(isStorageCategoryCleanable({ cleanability: "none", bytes: 0 }), false);
  // sessionStore 等真 none 类别：不能靠数据面拿到入口
  assert.equal(
    isStorageCategoryCleanable({ cleanability: "none", cleanScope: undefined, bytes: 999 }),
    false,
  );
});

test("none + cleanScope=paths（toolOutputs → cli/exec）+ 有占用 → 放行", () => {
  // r3 收口后 toolOutputs 唯一的入口依据：类别级 none，段级 paths。
  assert.equal(
    isStorageCategoryCleanable({ cleanability: "none", cleanScope: "paths", bytes: 4096 }),
    true,
  );
});

test("none + cleanScope=paths 但零占用 → 不放行（点进去无可清理）", () => {
  assert.equal(
    isStorageCategoryCleanable({ cleanability: "none", cleanScope: "paths", bytes: 0 }),
    false,
  );
});

test("带占用的 safe 类别即使 bytes 为 0 边界也按 cleanability 判定", () => {
  // cleanScope 缺省的普通类别维持旧口径：bytes>0 才放行
  assert.equal(isStorageCategoryCleanable({ cleanability: "safe", bytes: 0 }), false);
});

// ── 跨根合并 sumCategoriesAcrossRoots 透传 cleanScope ──────────────────

test("toolOutputs 跨根合并：bytes 相加、cleanScope=paths 透传", () => {
  const totals = sumCategoriesAcrossRoots([
    root("home", [
      usage("toolOutputs", 4096, { cleanability: "none", cleanScope: "paths" }),
      usage("logs", 1024),
    ]),
    root("dataBaseDir", [
      usage("toolOutputs", 2048, { cleanability: "none", cleanScope: "paths" }),
    ]),
  ]);
  const toolOutputs = totals.find((item) => item.id === "toolOutputs");
  assert.equal(toolOutputs?.bytes, 4096 + 2048);
  assert.equal(toolOutputs?.fileCount, 2);
  assert.equal(toolOutputs?.cleanability, "none");
  assert.equal(toolOutputs?.cleanScope, "paths");
  // 合并结果喂给门控谓词：入口仍在
  assert.equal(toolOutputs !== undefined && isStorageCategoryCleanable(toolOutputs), true);

  const logs = totals.find((item) => item.id === "logs");
  assert.equal(logs?.cleanScope, undefined);
  assert.equal(logs?.cleanability, "safe");
  assert.equal(isStorageCategoryCleanable(logs!), true);
});

test("跨根合并取任一非空 cleanScope（旧快照缺字段的根不拖丢 override）", () => {
  // 一个根的类别快照没有 cleanScope 字段（旧版本/缺字段）+ 另一个根有 → 合并后仍为 paths
  const totals = sumCategoriesAcrossRoots([
    root("home", [usage("toolOutputs", 100, { cleanability: "none" })]),
    root("dataBaseDir", [usage("toolOutputs", 50, { cleanability: "none", cleanScope: "paths" })]),
  ]);
  const toolOutputs = totals.find((item) => item.id === "toolOutputs");
  assert.equal(toolOutputs?.bytes, 150);
  assert.equal(toolOutputs?.cleanScope, "paths");
});

test("跨根合并后无 override 类别 → cleanScope 保持 undefined", () => {
  const totals = sumCategoriesAcrossRoots([
    root("home", [usage("sessionStore", 100, { cleanability: "none" })]),
    root("dataBaseDir", [usage("sessionStore", 50, { cleanability: "none" })]),
  ]);
  const sessionStore = totals.find((item) => item.id === "sessionStore");
  assert.equal(sessionStore?.cleanScope, undefined);
  assert.equal(isStorageCategoryCleanable(sessionStore!), false);
});

test("合并结果按 bytes 降序（图例/列表顺序约定不变）", () => {
  const totals = sumCategoriesAcrossRoots([
    root("home", [
      usage("toolOutputs", 10, { cleanability: "none", cleanScope: "paths" }),
      usage("logs", 9000),
    ]),
  ]);
  assert.deepEqual(
    totals.map((item) => item.id),
    ["logs", "toolOutputs"],
  );
});
