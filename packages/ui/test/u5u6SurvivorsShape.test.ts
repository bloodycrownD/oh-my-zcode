/**
 * T-UF1（backlog-sweep Step 12/13）：U5 + U6 定点形状守卫。
 *
 * 形态与 T-VU/P41/P42 一致：无 jsdom，纯源码形状守卫，可直接 tsx --test。
 * 锁死面：
 * ①U5——collapsible 动画类形状（去组名改 `[&>div]` 直接子层选择）、dialog 的
 *   `DialogCloseText`（i18n `common.close`，不再硬编码 "Close"）、kbd 复用
 *   `ControlShortcutBadge`；
 * ②U6——ToolCallBody 图片失败态分支存在（try/catch + path 变更清态 + previewFailed 主路径，
 *   `previewUnavailable` 在 omz 口径不可达已登记）、cuaScreenshotDetails 的 sharedImageSrc 优先、
 *   nodeReplImageGrid 的 `image.src` 优先（含 display 提取侧的 src 面）。
 *
 * 落点说明：`isInvalidPort` 边界属于 U7（Step 14 / P9 节点），本宿主不含该断言，避免跨节点红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const read = (...parts: string[]) => readFileSync(path.join(uiSrc, ...parts), "utf8");

const collapsible = read("components", "ui", "collapsible.tsx");
const dialog = read("components", "ui", "dialog.tsx");
const kbd = read("components", "ui", "kbd.tsx");
const toolCallBody = read("ToolCallBlocks", "ToolCallBody.tsx");
const cuaDetails = read("ToolCallBlocks", "renderers", "cuaScreenshotDetails.ts");
const nodeReplGrid = read("ToolCallBlocks", "renderers", "nodeReplImageGrid.tsx");
const nodeReplDisplay = read("lib", "nodeReplToolDisplay.ts");

test("T-UF1 U5：collapsible 用 [&>div] 直接子层动画，组名形态零残留", () => {
  for (const shape of [
    "data-[state=open]:[&>div]:animate-in",
    "data-[state=open]:[&>div]:fade-in-0",
    "data-[state=closed]:[&>div]:animate-out",
    "data-[state=closed]:[&>div]:fade-out-0",
    "data-[state=closed]:[&>div]:[animation-fill-mode:forwards]",
    "data-[state=open]:animate-collapsible-down",
    "data-[state=closed]:animate-collapsible-up",
  ]) {
    assert.ok(collapsible.includes(shape), `collapsible 动画类缺失：${shape}`);
  }

  // 嵌套 content 的同名 group 会匹配到祖先 open 覆盖当前 closed 淡出，必须彻底去掉组名。
  assert.ok(
    !collapsible.includes('"group/collapsible-content '),
    "collapsible content 不得再声明同名组",
  );
  assert.ok(!collapsible.includes("group-data-["), "collapsible 子层不得再读 group-data");
  // fork 注释融合面：resize trace 的 transition 说明与嵌套 group 的失效原因都要保留。
  assert.ok(collapsible.includes("scrollbar-color"), "fork 的 transition-property 注释必须保留");
  assert.ok(collapsible.includes("祖先"), "嵌套 group 失效原因注释必须保留");
});

test("T-UF1 U5：dialog 关闭文案走 DialogCloseText（i18n common.close）", () => {
  assert.ok(dialog.includes("function DialogCloseText()"), "DialogCloseText 必须在位");
  assert.ok(dialog.includes('id: "common.close"'), "关闭文案必须走 i18n common.close");
  assert.ok(dialog.includes('import { useZCodeIntl } from "@/i18n/IntlProvider.js"'));
  // 两处消费点：右上角 sr-only 与 footer close 按钮。
  const usages = dialog.match(/<DialogCloseText \/>/g) ?? [];
  assert.equal(usages.length, 2, "DialogCloseText 应在 sr-only 与 footer 两处消费");
  assert.ok(!dialog.includes(">Close<"), "不得残留硬编码 Close 文案");
  assert.ok(!dialog.includes('sr-only">Close'), "sr-only 不得残留硬编码 Close");
});

test("T-UF1 U5：kbd 复用 ControlShortcutBadge", () => {
  assert.ok(
    kbd.includes('from "@/ControlShortcutBadge.js"'),
    "kbd 必须 import ControlShortcutBadge",
  );
  assert.ok(kbd.includes("<ControlShortcutBadge"), "Kbd 必须以 ControlShortcutBadge 为基座");
  assert.ok(!/<kbd\b/.test(kbd), "不得再直接渲染裸 <kbd>");
  // 复用共享徽标后不再自带 bg-muted / 字体规则。
  assert.ok(!kbd.includes("bg-muted"), "不得保留旧键帽的自有底色");
});

test("T-UF1 U6：ToolCallBody 图片读取失败态收口（try/catch + path 变更清态）", () => {
  assert.ok(/try \{/.test(toolCallBody), "读取必须包在 try 里");
  assert.ok(/catch \(error\)/.test(toolCallBody), "必须有 catch 收口 rejection");
  assert.ok(toolCallBody.includes("setResult(null)"), "path 变更必须清态");
  assert.ok(
    toolCallBody.includes("result?.path === preview.path"),
    "展示前必须校验结果归属当前 path",
  );
  assert.ok(toolCallBody.includes('"chat.toolCall.previewFailed"'), "失败态必须走 previewFailed");
  assert.ok(toolCallBody.includes("logger.warn("), "失败必须留 warn 日志");
  // omz 口径：fileService 恒可用，没有上游 resourceUrl / 可选 reader 能力面 → previewUnavailable 不可达。
  assert.ok(
    !toolCallBody.includes('"chat.toolCall.previewUnavailable"'),
    "omz 无 capabilities 面，previewUnavailable 分支不可达，不得引入",
  );
});

test("T-UF1 U6：cuaScreenshotDetails 的 sharedImageSrc 优先于内嵌 data URL", () => {
  assert.ok(cuaDetails.includes("const sharedImageSrc = asRecord(toolCall.raw)?.sharedImageSrc;"));
  const sharedIndex = cuaDetails.indexOf('typeof sharedImageSrc === "string" ? sharedImageSrc');
  const outputIndex = cuaDetails.indexOf("findImageDataUrl(toolCall.output)");
  assert.ok(
    sharedIndex > 0 && outputIndex > sharedIndex,
    "sharedImageSrc 必须排在 output 回退之前",
  );
});

test("T-UF1 U6：nodeRepl 图片 src 优先（renderer 与 display 提取两侧）", () => {
  assert.ok(
    nodeReplGrid.includes("src: image.src ?? `data:${image.mimeType};base64,${image.base64}`"),
    "grid 必须优先使用 image.src",
  );
  assert.ok(nodeReplDisplay.includes("src?: string;"), "display image 类型必须带可选 src");
  assert.ok(nodeReplDisplay.includes("const src = readNonEmptyString(value.src);"));
  assert.ok(nodeReplDisplay.includes("(!base64 && !src)"), "仅有 src 的图片也应入列");
  assert.ok(nodeReplDisplay.includes("...(src ? { src } : {})"), "src 必须透传到 display image");
});
