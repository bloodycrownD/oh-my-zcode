// 候选 (a) —— 编辑器提交值回退：**已验证非缺陷**（e2e 复现结论，见下方「复现结论」）。
//
// ============================================================================
// 候选 (a) 的描述与复现目标
// ============================================================================
//
// `ChatPromptEditor.tsx:214` 的提交值解析：
//
//   onSubmit(resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current)
//
// 假设：ref 未就绪 / 时序竞态时提交旧正文（「编辑器打开 → 改文本 → 立即提交」
// 的挂载竞态 → 编辑重发发出的还是被编辑前的旧文本）。
//
// ============================================================================
// 复现结论：未命中（机制不可达）
// ============================================================================
//
// 1. **ref 在提交前必然就绪**。`resolvedInputApiRef.current` 由
//    `EditorApiPlugin` 的 passive effect 赋值（LexicalChatInput.tsx:1251-1292），
//    卸载时置 null。用户点击发送按钮 / 按 Enter 都要等浏览器绘制之后，
//    React 的 passive effect 在绘制前就已 flush——交互式提交发生时 editorApiRef
//    不可能还是 null。ConversationRowView 的 `inputApiRef` 还是**行内私有** ref
//    （ConversationRowView.tsx:917），不存在跨行复用导致读到别的编辑器的可能。
//
// 2. **两个来源在可读时恒等**。`latestTextRef.current` 与编辑器正文由同一条
//    更新链驱动：Lexical 的 update listener（LexicalChatInput.tsx:846-866）在
//    文本变化的那一拍同步回调 `handleTextChange`（ChatPromptEditor.tsx:203-209），
//    它同时更新 `latestTextRef.current` 与父级 `draft`（`onChange={setDraft}`，
//    ConversationRowView.tsx:1190）。程序化 `setText` 回填同样过这条链
//    （listener 无 tag 过滤，只做「文本没变就跳过」的短路）。所以
//    `getMarkdown()` 与 `latestTextRef.current` 只要都可读，值必然相同——
//    回退分支不可能拿出一个「旧的已编辑值」。
//
// 3. **主提交链（Enter）根本不走这个表达式**。KeyboardPlugin 直接读编辑器状态
//    （LexicalChatInput.tsx:551 `getEditorMarkdown(editor.getEditorState())`）。
//    只有发送按钮的 form onSubmit 走 ChatPromptEditor.tsx:214。
//
// 4. 「ref 未就绪」窗口内（编辑器首帧前）提交会发生什么：`latestTextRef.current`
//    刚被首帧同步 effect 置为 `initialValue`（ChatPromptEditor.tsx:180-201），
//    提交的是**未编辑的原文**——这是用户在还没打字时的正确值，不是「提交旧正文」。
//    同期主提交链会提交空串并被 `handleSubmitEdit` 的空值门禁挡下
//    （ConversationRowView.tsx:1015），表现为「无动作」而非「发旧消息」。
//
// 5. **为何没有组件级复现**：仓库 UI 测试基建是纯逻辑测试（无 jsdom /
//    happy-dom / linkedom，packages/ui 也没有任何组件渲染先例），且
//    ChatPromptEditor 的传递依赖会经 `@/lib/pluginIconSource.ts` 摸到
//    `.png` 资产导入，tsx 下无法加载该模块——组件挂载竞态只能走 CDP 实机
//    （spec 已把候选 (a) 的 CDP 脚本划到 `.cu-shots/`，非门禁）。
//
// 因此 1g（提交值统一受控来源）**不改**：它针对的回退分支是实际不可达的死代码，
// 改了反而会把「编辑器为空」从显式空提交变成别的语义。残留的理论风险是另一条
// 机制（initialValue 首帧回填的 rAF 时序，ChatPromptEditor.tsx:193-200：
// 用户在挂载后同一帧内打字会被 `setText(initialValue)` 冲掉），窗口约一帧、
// 无法用本仓测试基建覆盖，也与 1g 的描述无关——留给桌面 CDP 人工验收。
//
// 本文件做两件事，把上述结论钉住：
//   A. 用忠实模型跑「两源一致性」不变量：任何编辑器更新序列下，提交值解析的
//      两个来源只要可读就相同；
//   B. 源码形状守卫（tripwire）：若后人把提交值改成无条件读 `latestTextRef`
//      （那才会真正引入「提交旧正文」）或删掉首帧回填的 no-op guard，本文件报红。
//
// 硬约束（沿袭 test/timelineRowHeightCache.test.ts）：本文件只用 node: 内置与
// 相对路径，零 `@/` 导入。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHAT_PROMPT_EDITOR_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/prompt-editor/ChatPromptEditor.tsx", import.meta.url)),
  "utf8",
);
const LEXICAL_CHAT_INPUT_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/LexicalChatInput.tsx", import.meta.url)),
  "utf8",
);

// ── A: 两源一致性模型 ────────────────────────────────────────────────────────

/**
 * ChatPromptEditor 提交值链路的忠实模型：
 * - `editor.text` 模拟 Lexical 编辑器正文；`update()` 同步派发（Lexical 的
 *   update listener 是同步回调）；
 * - `handleTextChange` 复刻 ChatPromptEditor.tsx:203-209：同拍更新
 *   `latestTextRef.current` 与父级 `draft`；
 * - `submit()` 复刻 ChatPromptEditor.tsx:214 的解析式。
 */
function createComposerModel({ initialValue = "old text", editorApiReady = true } = {}) {
  const editor = { text: "" };
  const latestTextRef = { current: initialValue };
  const state = { draft: initialValue };
  // 编辑器 API ref：未就绪时（首帧前）为 null，提交值回退 latestTextRef。
  const editorApi = editorApiReady ? { getMarkdown: () => editor.text } : null;
  const pushEditorText = (next: string) => {
    if (editor.text === next) return; // listener 的「文本没变就跳过」短路
    editor.text = next;
    // update listener（LexicalChatInput.tsx:846-866）→ handleTextChange
    latestTextRef.current = next;
    state.draft = next;
  };
  const submit = () => (editorApi ? editorApi.getMarkdown() : latestTextRef.current);
  return { editor, latestTextRef, pushEditorText, state, submit };
}

test("A1: 编辑器已就绪时提交值恒为编辑器正文（不会回退到任何旧值）", () => {
  const composer = createComposerModel({ initialValue: "old text" });
  // 首帧回填（rAF → setText(initialValue)）：编辑器进入初始态。
  composer.pushEditorText("old text");
  assert.equal(composer.submit(), "old text");
  // 用户改文本后立即提交：提交值必须是新文本。
  composer.pushEditorText("edited text");
  assert.equal(composer.submit(), "edited text");
  assert.equal(composer.state.draft, "edited text", "父级 draft 与编辑器同拍一致");
  // 连续多拍编辑同理。
  composer.pushEditorText("edited text v2");
  assert.equal(composer.submit(), "edited text v2");
});

test("A2: ref 未就绪窗口内回落的是最新镜像值，不是旧的已编辑值", () => {
  const composer = createComposerModel({ editorApiReady: false });
  // 首帧同步 effect 把 latestTextRef 置为 initialValue（未打字时的正确值）。
  assert.equal(composer.latestTextRef.current, "old text");
  assert.equal(composer.submit(), "old text");
  // 若用户已打字，镜像必然已跟上（同拍更新），回落值仍是新文本。
  composer.pushEditorText("edited text");
  assert.equal(composer.latestTextRef.current, "edited text");
  assert.equal(composer.submit(), "edited text");
});

test("A3: 不变量——挂载回填后，任何编辑序列下两来源可读时值相同（回退拿不到旧值）", () => {
  for (const sequence of [
    [],
    ["a"],
    ["a", "ab", "abc"],
    ["a", ""],
    ["old text", "edited text", "old text"],
  ]) {
    const model = createComposerModel({ editorApiReady: true });
    const mirrorOnly = createComposerModel({ editorApiReady: false });
    // 真实挂载序：首帧同步 effect 置镜像 → rAF 回填编辑器（同一拍更新镜像）。
    model.pushEditorText("old text");
    mirrorOnly.pushEditorText("old text");
    for (const text of sequence) {
      model.pushEditorText(text);
      mirrorOnly.pushEditorText(text);
      // 每一拍之后两来源都必须一致（可读时）。
      assert.equal(model.submit(), text, "编辑器优先分支（第 " + text + " 拍）");
      assert.equal(mirrorOnly.submit(), text, "回落分支（第 " + text + " 拍）");
    }
    const finalText = sequence.length > 0 ? sequence[sequence.length - 1] : "old text";
    assert.equal(model.editor.text, finalText);
    assert.equal(mirrorOnly.latestTextRef.current, finalText, "镜像 ref 与编辑器一致");
  }
});

test("A4: 文档化——首帧回填前的窗口：回落提交的是未编辑原文，不是「旧的已编辑值」", () => {
  const composer = createComposerModel({ editorApiReady: false });
  // 挂载后、rAF 回填前：编辑器还是空初始态，镜像已被同步 effect 置为 initialValue。
  assert.equal(composer.editor.text, "", "首帧前编辑器为空初始态");
  assert.equal(composer.submit(), "old text", "该窗口回落的是未编辑原文（用户还没打字，属正确值）");
  // 用户一旦开始打字，同一拍镜像就跟着走，回落值立即变成新文本。
  composer.pushEditorText("edited text");
  assert.equal(composer.submit(), "edited text");
});

// ── B: 源码形状守卫（tripwire） ───────────────────────────────────────────────

test("B1: 提交值仍以编辑器正文为权威来源，latestTextRef 仅作兜底", () => {
  // 记录的复现结论依赖这个形态：一旦改成无条件读 latestTextRef，
  // 「父级 state 未跟上编辑器」的窗口就会把旧正文提交出去（候选 a 描述的缺陷）。
  assert.match(
    CHAT_PROMPT_EDITOR_SOURCE,
    /onSubmit\(resolvedInputApiRef\.current\?\.getMarkdown\(\) \?\? latestTextRef\.current\)/,
    "ChatPromptEditor 提交值必须保持「编辑器优先 + ref 兜底」",
  );
  // 首帧回填必须保留 no-op guard，否则每次挂载都会程序化重写编辑器。
  assert.match(
    CHAT_PROMPT_EDITOR_SOURCE,
    /resolvedInputApiRef\.current\?\.getMarkdown\(\) === initialValue/,
    "initialValue 首帧回填必须保留「已是目标文本则跳过」的 guard",
  );
});

test("B2: Enter 主提交链仍直读编辑器状态（不经 form 的 ref 兜底）", () => {
  assert.match(
    LEXICAL_CHAT_INPUT_SOURCE,
    /getEditorMarkdown\(editor\.getEditorState\(\)\)/,
    "KeyboardPlugin 必须继续从编辑器状态取提交文本",
  );
});
