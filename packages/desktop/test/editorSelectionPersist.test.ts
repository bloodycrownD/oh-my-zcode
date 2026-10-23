/**
 * desktop/B-1（CR fix-spec）：文件应用 id 不得污染全局「上次选择的编辑器」偏好。
 *
 * 形态：纯逻辑测试（node --test + node:assert）。`lib/editorPreference.ts` 只依赖 localStorage
 * 的注入形参，不碰 React/electron，可直接跨包加载；`OpenSplitButton.tsx` 侧只做源码形状守卫
 * （本仓无 jsdom，组件无法渲染）。
 *
 * 锁死的失效形态：OpenSplitButton 的编辑器列表是按扩展名补出来的（PDF → Preview/Acrobat），
 * 用户为某个 PDF 选一次 Preview 就写 `zcode-last-editor-id=preview`；读取侧
 * WorkspaceEditorButtonGroup / PreviewPane 用无 path 的 getInstalledEditors()（不含文件应用），
 * 偏好命中不了就回落 availableEditors[0]，而 Finder/Explorer 被钉在最前 → 工作区头从
 * 「VS Code」静默变「Finder」且无法自愈。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  persistLastSelectedEditorId,
  readLastSelectedEditorId,
  shouldPersistEditorSelection,
} from "../../ui/src/lib/editorPreference.js";

const uiSrc = (relative: string) =>
  fileURLToPath(new URL(`../../ui/src/${relative}`, import.meta.url));

function createFakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("B-1 纯函数：文件应用不持久化，IDE/终端/文件管理器持久化", () => {
  assert.equal(shouldPersistEditorSelection({ id: "preview", fileApplication: true }), false);
  assert.equal(shouldPersistEditorSelection({ id: "adobe-reader", fileApplication: true }), false);
  assert.equal(shouldPersistEditorSelection({ id: "vscode" }), true, "缺省即工作区级入口");
  assert.equal(shouldPersistEditorSelection({ id: "terminal", fileApplication: false }), true);
  assert.equal(shouldPersistEditorSelection({ id: "finder" }), true);
});

test("B-1 行为：为 PDF 选 Preview 后 zcode-last-editor-id 保持为此前的 IDE", () => {
  const storage = createFakeStorage();

  // 用户此前在工作区头显式选过 VS Code。
  persistLastSelectedEditorId("vscode", storage);
  assert.equal(readLastSelectedEditorId(storage), "vscode");

  // 随后在 PDF 的「打开方式」里选了 Preview：不得写偏好。
  const previewApp = { id: "preview", fileApplication: true };
  if (shouldPersistEditorSelection(previewApp)) {
    persistLastSelectedEditorId(previewApp.id, storage);
  }
  assert.equal(
    readLastSelectedEditorId(storage),
    "vscode",
    "文件应用的 id 不能覆盖工作区级偏好（否则重启后工作区头/预览头回落 Finder）",
  );

  // 反证：同样的用户动作换成 IDE 必须写入，否则这条用例没有区分力。
  const ide = { id: "zed" };
  if (shouldPersistEditorSelection(ide)) {
    persistLastSelectedEditorId(ide.id, storage);
  }
  assert.equal(readLastSelectedEditorId(storage), "zed");
});

test("B-1 接线形状：OpenSplitButton 的持久化调用被 shouldPersistEditorSelection 守卫", async () => {
  const openSplitButton = await readFile(uiSrc("OpenSplitButton.tsx"), "utf8");
  const guarded =
    /if \(shouldPersistEditorSelection\(editor\)\) \{\s*persistLastSelectedEditorId\(editor\.id\);\s*\}/u;
  assert.match(openSplitButton, guarded, "OpenSplitButton 必须在持久化前判断 fileApplication");
  assert.equal(
    openSplitButton.match(/persistLastSelectedEditorId\(/gu)?.length,
    1,
    "OpenSplitButton 只应保留这处受控持久化调用",
  );

  const editors = await readFile(
    fileURLToPath(new URL("../src/main/editors.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    editors.includes("fileApplication: true"),
    "主进程必须给文件应用条目打 fileApplication 旗标（否则 UI 侧无从判断）",
  );
});
