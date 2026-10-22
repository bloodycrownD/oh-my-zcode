/**
 * bug A/B UI 侧回归 tripwire（2026-10-23）。
 *
 * 钉住两处源码形状（本仓 UI 测试基建为纯逻辑/形状测试，无 jsdom）：
 * 1) bug B：ConversationComposer 的 confirmationRequired 分支必须 `return;`
 *    ——24af3955 拆遥测误删后，setHeldQueueConfirmation(null) 同步覆盖确认框
 *    state（React 后写胜出）→ 弹窗永不出现且输入被吞。现路由已改 held→enqueue，
 *    该分支仅兜底，但 return 若再丢，防御面即破。
 * 2) bug A：ChatPromptEditor 首帧回填竞态哨兵——runAfterFrame 回调必须检查
 *    textChangeSerialRef，排队期间用户已打字时放弃程序化 setText(initialValue)，
 *    否则挂载首帧内输入被 initialValue 覆盖（编辑历史消息「发旧文本」的残留窗口）。
 *
 * 运行形态：node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test packages/ui/test/composerHeldQueueGuard.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

const composerSource = readFileSync(
  join(here, "..", "src", "v4", "ConversationComposer.tsx"),
  "utf8",
);
const editorSource = readFileSync(
  join(here, "..", "src", "prompt-editor", "ChatPromptEditor.tsx"),
  "utf8",
);

test("bug B：confirmationRequired 分支以 return 结束（确认框不被 null 覆盖）", () => {
  // 结构锚：分支体 return → 收括号 → 紧随的 setHeldQueueConfirmation(null)（null 重置
  // 必须在分支之外；24af3955 曾把 return 删掉导致 null 覆盖确认框 state）。
  assert.match(
    composerSource,
    /\breturn;\s*\n\s*\}\s*\n\s*setHeldQueueConfirmation\(null\);/,
    "confirmationRequired 分支必须 return 后才落到 null 重置",
  );
});

test("bug A：首帧回填带竞态哨兵（用户首帧打字不被 initialValue 覆盖）", () => {
  assert.match(editorSource, /textChangeSerialRef/, "哨兵 ref 存在");
  // runAfterFrame 回调内：先比 serial 再 setText
  const rafIdx = editorSource.indexOf("runAfterFrame(() => {");
  assert.ok(rafIdx > 0, "runAfterFrame 回调存在");
  const rafBody = editorSource.slice(rafIdx, editorSource.indexOf("});", rafIdx));
  const serialCheck = rafBody.indexOf("textChangeSerialRef.current !== scheduledSerial");
  const setTextIdx = rafBody.indexOf("setText(initialValue)");
  assert.ok(serialCheck > -1, "回调内有序列号检查");
  assert.ok(setTextIdx > serialCheck, "序列号检查先于 setText");
  // handleTextChange 递增序列号
  assert.match(editorSource, /textChangeSerialRef\.current \+= 1/);
});
