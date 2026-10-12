#!/usr/bin/env node
/**
 * cr-fix-spec b/A-1（upstream-v3.15.1-backport）：快照 reports 被钳到
 * `DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS`（256）条后，`<reports count>` 与 manifest 的
 * count 必须说 run 的**真实总条数**（快照的 `reportCount`），而不是预览里的条数——否则报满的
 * run 会在通知里自称只报了几条，模型就不会去用 run id 取剩下的。
 *
 * 四组断言（转写上游 core/tests/background-task-control.test.ts「count 读快照的 reportCount」
 * 与 core/tests/dynamic-workflow-run-track.test.ts「reports.count 读快照的 reportCount」的断言
 * 本体，外加同两条用例的文本渲染面）：
 *
 *   A. 通知节：items 256 条 + total 65536 → count=65536，shown ≤ 256，预览从 [1] 起。
 *   B. manifest 节：items 256 条 + total 65536 → count=65536，shown=8。
 *   C. 老快照（无 reportCount，即 total 缺席）退回 items.length：count=3，且通知文本里
 *      `<reports count="3">` 不带 shown 属性（shown === count 时整属性缺席）。
 *   D. 通知文本按真实总数渲染：`<reports count="65536" shown="M">`，M < 65536。
 *
 * 依赖已构建的 dist：`pnpm --dir apps/zcode-cli --filter "@zcode/core" build`（陈旧时先重建）。
 * 口径与 `test-magic-context-prompt-section.mjs` 同款：node --test + `../dist/**` import。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * 与 `test-magic-context-prompt-section.mjs` 同一范式：workspace 包的 dist 之间存在「dist 引用
 * dist」与「dist 引用 ts 源码」两种形态（`@zcode/shared` 的 exports 直指 `src/*.ts`），把被测链会
 * 碰到的 workspace 包指到各自 dist，node 才不必解析 `.ts`。被测的 core 代码走 `../dist/**`。
 */
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);
const PACKAGE_DIST_ENTRY = {
  "@zcode/contracts": `${REPO_ROOT}apps/zcode-cli/packages/contracts/dist/index.js`,
};

registerHooks({
  resolve(specifier, _context, nextResolve) {
    const entry = PACKAGE_DIST_ENTRY[specifier];
    if (entry !== undefined) {
      return { url: pathToFileURL(entry).href, shortCircuit: true };
    }
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
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
    return nextResolve(specifier, _context);
  },
});

const { buildWorkflowReportsNotificationSection, buildWorkflowReportsManifestSection } =
  await import(new URL("../dist/tool/executor/workflow-artifact.js", import.meta.url).href);
const { formatTaskNotification } = await import(
  new URL("../dist/runtime-task/notification.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — workflow reports count reads the snapshot reportCount (b/A-1)"
      : `TEST FAIL — workflow reports count (exit code ${code})`,
  );
});

/** 快照只带前 256 条 item（contracts 的 DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS）。 */
const SNAPSHOT_REPORTS = Array.from({ length: 256 }, (_, index) => `f${index + 1}`);
/** 真实总数：远超快照条数，count 若退回 items.length 会一眼暴露。 */
const TRUE_TOTAL = 65_536;

test("A: 通知节 count 读 reportCount：快照截在 256 条时仍报真实总数", () => {
  const section = buildWorkflowReportsNotificationSection(SNAPSHOT_REPORTS, TRUE_TOTAL);
  assert.ok(section, "expected a reports section");
  assert.equal(section.count, TRUE_TOTAL);
  assert.ok(section.shown > 0, "at least one item must be previewed");
  assert.ok(section.shown <= SNAPSHOT_REPORTS.length, "shown can never exceed the snapshot cap");
  assert.ok(section.shown < section.count, "preview is partial once the run reported more");
  // 预览从第一条开始给（最早的发现最可能是别的条目的前提）。
  assert.match(section.preview, /^\[1\] f1/);
});

test("B: manifest count 读 reportCount：preview 仍最多 8 条", () => {
  const section = buildWorkflowReportsManifestSection(SNAPSHOT_REPORTS, TRUE_TOTAL);
  assert.ok(section, "expected a manifest reports section");
  assert.equal(section.count, TRUE_TOTAL);
  assert.equal(section.shown, 8);
  assert.equal(section.preview[0], "f1");
});

test("C: 没有 reportCount 的老快照退回条目数", () => {
  const notification = buildWorkflowReportsNotificationSection(["a", "b", "c"]);
  assert.ok(notification, "expected a reports section");
  assert.equal(notification.count, 3);
  const text = formatTaskNotification({
    taskId: "dwf-reports-count-legacy",
    taskType: "local_workflow",
    status: "completed",
    summary: "nightly audit",
    reports: notification,
  });
  // shown === count 时整属性缺席：老快照没有「还有更多」可报。
  assert.ok(text.includes('<reports count="3">'), text);
});

test("D: 通知文本按真实总数渲染 <reports count>（shown 小于 count 才出现）", () => {
  const section = buildWorkflowReportsNotificationSection(SNAPSHOT_REPORTS, TRUE_TOTAL);
  assert.ok(section, "expected a reports section");
  const text = formatTaskNotification({
    taskId: "dwf-reports-count-from-snapshot",
    taskType: "local_workflow",
    status: "completed",
    summary: "nightly audit",
    reports: section,
  });
  const count = /<reports count="(\d+)"( shown="(\d+)")?>/u.exec(text);
  assert.ok(count, text);
  assert.equal(Number(count[1]), TRUE_TOTAL);
  assert.ok(count[3] !== undefined, "shown must appear while the preview is partial");
  assert.ok(Number(count[3]) < TRUE_TOTAL, "shown is the preview length, not the total");
  assert.match(text, /\[1\] f1/);
});
