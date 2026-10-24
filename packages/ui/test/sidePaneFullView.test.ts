/**
 * T-UF5（backlog-sweep Step 19 / U10 side-pane 全屏）：
 * 1. 双投影纯逻辑：SidePaneFullViewState → 宿主模式（resolveSidePaneFullViewHostMode）→
 *    对话 pane 展示形态（isFloatingPresentation）；两条投影共用一条规则。
 * 2. 浮窗状态机：回答气泡基线推进（不依赖观察到「运行中」）。
 * 3. fullViewSlot 投影：面板内容区只有一个 slot，宿主按它定位；源码形状守卫。
 * 4. shortcutCommands 注册形状（含 Web 设置页过滤）。
 * 5. 完整视图 i18n 键在 zh/en 双侧对称。
 *
 * 本仓无 jsdom：全部是纯逻辑 + 源码形状守卫，不做 DOM 断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isFloatingPresentation,
  resolveSidePaneFullViewHostMode,
  SIDE_PANE_FULL_VIEW_ENTER_STATE,
  dismissFloatingAnswerBubble,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
} from "../src/side-pane-full-view/model.js";
import type {
  ConversationPanePresentation,
  FloatingAnswerBubbleState,
  SidePaneFullViewHostMode,
  SidePaneFullViewState,
} from "../src/side-pane-full-view/contract.js";
import {
  peekTaskSidePaneFullView,
  saveTaskSidePaneFullView,
} from "../src/lib/taskSidePaneMemory.js";
import { SHORTCUT_COMMANDS, getDefaultShortcutBindings } from "@zcode/shared";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.join(testDir, "..", "src");
const repoRoot = path.join(testDir, "..", "..", "..");

function readUiSource(relativePath: string): string {
  return readFileSync(path.join(uiSrcDir, relativePath), "utf8");
}

/* ---------------- 1. 双投影 ---------------- */

const SURFACE_STATES: readonly (SidePaneFullViewState | null)[] = [
  null,
  { surface: "side-pane", floating: "collapsed" },
  { surface: "side-pane", floating: "expanded" },
  { surface: "side-pane", floating: "minimized" },
  { surface: "conversation", floating: "collapsed" },
  { surface: "conversation", floating: "expanded" },
  { surface: "conversation", floating: "minimized" },
];

test("T-UF5-1 宿主模式投影：未进入 → normal，面板 surface → floating，对话 surface → conversation", () => {
  assert.equal(resolveSidePaneFullViewHostMode(null), "normal");
  for (const state of SURFACE_STATES) {
    if (!state) continue;
    assert.equal(
      resolveSidePaneFullViewHostMode(state),
      state.surface === "conversation" ? "conversation" : "floating",
      `${state.surface}/${state.floating}`,
    );
    // abandoned 变体：浮窗子状态（collapsed/expanded/minimized）不改变宿主模式。
  }
  assert.deepEqual(
    SURFACE_STATES.slice(1, 4).map((state) => resolveSidePaneFullViewHostMode(state)),
    ["floating", "floating", "floating"],
  );
});

test("T-UF5-2 isFloatingPresentation 是唯一浮动判定：两种投影字面量共用一条规则", () => {
  const hostModes: SidePaneFullViewHostMode[] = ["normal", "conversation", "floating"];
  assert.deepEqual(
    hostModes.map((mode) => isFloatingPresentation(mode)),
    [false, false, true],
  );
  const panePresentations: ConversationPanePresentation[] = ["docked", "floating"];
  assert.deepEqual(
    panePresentations.map((presentation) => isFloatingPresentation(presentation)),
    [false, true],
  );
});

test("T-UF5-3 双投影一致：会话侧 presentation=floating 当且仅当宿主模式为 floating", () => {
  for (const state of SURFACE_STATES) {
    const mode = resolveSidePaneFullViewHostMode(state);
    // ConversationHost 的投影：宿主模式 → context 里的 presentation。
    const presentation: ConversationPanePresentation = isFloatingPresentation(mode)
      ? "floating"
      : "docked";
    // SessionPane 的投影：presentation → isFloatingPresentation（同一规则）。
    assert.equal(
      isFloatingPresentation(presentation),
      state !== null && state.surface === "side-pane",
      JSON.stringify(state),
    );
  }
});

test("T-UF5-4 进入态常量：进 full view 先落在 side-pane/collapsed，不回写任何原有状态", () => {
  assert.deepEqual(SIDE_PANE_FULL_VIEW_ENTER_STATE, {
    surface: "side-pane",
    floating: "collapsed",
  });
});

/* ---------------- 2. 回答气泡基线 ---------------- */

test("T-UF5-5 回答气泡：第一次看到已结束回合只建立基线，之后的新回合才弹出", () => {
  let bubbles: ReadonlyMap<string, FloatingAnswerBubbleState> = new Map();

  // 基线：第一次看到 owner 时回合已结束 → 记为看过，不弹。
  bubbles = reduceFloatingAnswerBubbles(bubbles, {
    ownerKey: "task-1",
    latestTurn: { turnKey: "turn-1", running: false, answer: { rowId: 1, text: "旧回答" } },
  });
  assert.equal(bubbles.get("task-1")?.seenTurnKey, "turn-1");
  assert.equal(bubbles.get("task-1")?.answer, null);

  // 同一回合的重放不重复弹。
  bubbles = reduceFloatingAnswerBubbles(bubbles, {
    ownerKey: "task-1",
    latestTurn: { turnKey: "turn-1", running: false, answer: { rowId: 1, text: "旧回答" } },
  });
  assert.equal(bubbles.get("task-1")?.answer, null);

  // 新回合结束 → 弹出并推进基线。
  bubbles = reduceFloatingAnswerBubbles(bubbles, {
    ownerKey: "task-1",
    latestTurn: { turnKey: "turn-2", running: false, answer: { rowId: 2, text: "新回答" } },
  });
  assert.equal(bubbles.get("task-1")?.seenTurnKey, "turn-2");
  assert.deepEqual(bubbles.get("task-1")?.answer, { rowId: 2, text: "新回答" });

  // 关闭气泡只清 answer，基线不变（同一回合不会再弹）。
  bubbles = dismissFloatingAnswerBubble(bubbles, "task-1");
  assert.equal(bubbles.get("task-1")?.answer, null);
  assert.equal(bubbles.get("task-1")?.seenTurnKey, "turn-2");
  bubbles = reduceFloatingAnswerBubbles(bubbles, {
    ownerKey: "task-1",
    latestTurn: { turnKey: "turn-2", running: false, answer: { rowId: 2, text: "新回答" } },
  });
  assert.equal(bubbles.get("task-1")?.answer, null);
});

test("T-UF5-6 回答气泡：很快结束的回合（从未观察到运行中）也能弹出；running 时不弹", () => {
  // 基线时正在运行 → seenTurnKey=null，等这一轮结束。
  let bubbles: ReadonlyMap<string, FloatingAnswerBubbleState> = reduceFloatingAnswerBubbles(
    new Map(),
    {
      ownerKey: "task-2",
      latestTurn: { turnKey: "turn-1", running: true, answer: null },
    },
  );
  assert.equal(bubbles.get("task-2")?.seenTurnKey, null);
  // 一次渲染批次里直接从未开始变成已结束。
  bubbles = reduceFloatingAnswerBubbles(bubbles, {
    ownerKey: "task-2",
    latestTurn: { turnKey: "turn-1", running: false, answer: { rowId: 7, text: "秒回" } },
  });
  assert.deepEqual(bubbles.get("task-2")?.answer, { rowId: 7, text: "秒回" });

  // 运行中的回合不弹气泡。
  const runningBubbles = reduceFloatingAnswerBubbles(bubbles, {
    ownerKey: "task-3",
    latestTurn: { turnKey: "turn-9", running: true, answer: null },
  });
  assert.equal(runningBubbles.get("task-3")?.answer, null);
});

test("T-UF5-7 离开浮窗形态重建基线：已弹出气泡保留，基线清空", () => {
  const withBubble = reduceFloatingAnswerBubbles(
    reduceFloatingAnswerBubbles(new Map(), {
      ownerKey: "task-4",
      latestTurn: { turnKey: "turn-1", running: false, answer: null },
    }),
    {
      ownerKey: "task-4",
      latestTurn: { turnKey: "turn-2", running: false, answer: { rowId: 3, text: "回答" } },
    },
  );
  const rebaselined = rebaselineFloatingAnswerBubbles(withBubble);
  assert.equal(rebaselined.get("task-4")?.seenTurnKey, undefined);
  assert.deepEqual(rebaselined.get("task-4")?.answer, { rowId: 3, text: "回答" });
  // 幂等：没有基线时返回同一引用（不触发重渲染）。
  assert.equal(rebaselineFloatingAnswerBubbles(rebaselined), rebaselined);
});

test("T-UF5-8 回答气泡预览去 markdown：代码块/链接/强调去掉，snake_case 保留下划线", () => {
  assert.equal(
    resolveFloatingAnswerPreview(
      "## 标题\n\n看 `code` 和 [链接](https://x/y) 与 **粗体**\n```js\nx\n```",
    ),
    "标题 看 code 和 链接 与 粗体",
  );
  assert.equal(
    resolveFloatingAnswerPreview("改 `snake_case_name` 字段"),
    "改 snake_case_name 字段",
  );
});

/* ---------------- 3. fullViewSlot 投影 ---------------- */

test("T-UF5-9 fullView 状态记录按 workspace 身份 + 对话 owner 隔离", () => {
  const key = "t-uf5-workspace-key";
  assert.equal(peekTaskSidePaneFullView(key, "task-a"), null);
  saveTaskSidePaneFullView(key, "task-a", { surface: "side-pane", floating: "collapsed" });
  assert.deepEqual(peekTaskSidePaneFullView(key, "task-a"), {
    surface: "side-pane",
    floating: "collapsed",
  });
  // 另一个 owner 不受影响；草稿 owner 用 __draft__ 键。
  assert.equal(peekTaskSidePaneFullView(key, "task-b"), null);
  saveTaskSidePaneFullView(key, null, { surface: "conversation", floating: "collapsed" });
  assert.deepEqual(peekTaskSidePaneFullView(key, null), {
    surface: "conversation",
    floating: "collapsed",
  });
  // 传 null 删除该 owner 的记录，不影响其它 owner。
  saveTaskSidePaneFullView(key, "task-a", null);
  assert.equal(peekTaskSidePaneFullView(key, "task-a"), null);
  assert.notEqual(peekTaskSidePaneFullView(key, null), null);
});

test("T-UF5-10 fullViewSlot 形状：面板提供唯一内容区 slot，宿主按它定位", () => {
  const panel = readUiSource("app-shell/AnimatedSidePanePanel.tsx");
  // 面板：slot ref 只在 tab 栏下方的内容区挂一次，并带稳定 data 标记。
  assert.match(panel, /fullViewSlotRef\?: \(element: HTMLDivElement \| null\) => void;/);
  assert.equal(
    panel.match(/ref=\{fullViewSlotRef\}/g)?.length,
    1,
    "fullViewSlotRef 必须只挂在内容区一处",
  );
  assert.match(panel, /data-side-pane-content-slot=""/);

  const shell = readUiSource("app-shell/WorkspaceShellLayout.tsx");
  // 壳层：slot 元素是 state，先交给面板 ref，再交给宿主 slotElement。
  assert.match(shell, /const \[fullViewSlotElement, setFullViewSlotElement\] = useState/);
  assert.match(shell, /fullViewSlotRef=\{setFullViewSlotElement\}/);
  assert.match(shell, /slotElement=\{fullViewSlotElement\}/);
  // 宿主模式由状态投影得出，不在壳层里手写三元。
  assert.match(
    shell,
    /const fullViewMode: SidePaneFullViewHostMode = resolveSidePaneFullViewHostMode\(activeFullView\)/,
  );

  const host = readUiSource("side-pane-full-view/ConversationHost.tsx");
  // 宿主：没有 slot 或 normal 模式时不写几何（退出后自然回到静态布局）。
  assert.match(host, /if \(mode === "normal" \|\| !slotElement\) \{/);
  assert.match(host, /const isFloating = isFloatingPresentation\(mode\);/);
});

test("T-UF5-11 双投影消费面：SessionPane 与 V4WorkspaceChatArea 都从 context 读形态", () => {
  const sessionPane = readUiSource("v4/SessionPane.tsx");
  assert.match(sessionPane, /const panePresentation = useConversationPanePresentation\(\);/);
  assert.match(
    sessionPane,
    /const isFloatingPresentation = isFloatingPresentationOf\(panePresentation\.presentation\);/,
  );
  // 浮窗形态下草稿栏与推荐提示不进浮窗，时间线按浮窗形态上报输入区高度。
  assert.match(sessionPane, /contextHeader=\{isDraft && !isFloatingPresentation \?/);
  assert.match(sessionPane, /floatingComposerDock=\{isFloatingPresentation\}/);
  assert.match(sessionPane, /onLatestTurnSummaryChange=\{/);

  const chatArea = readUiSource("v4/V4WorkspaceChatArea.tsx");
  assert.match(chatArea, /const \{ presentation \} = useConversationPanePresentation\(\);/);
  assert.match(
    chatArea,
    /const soloPaneId = presentation === "floating" && paneCount > 1 \? focusedPaneId : null;/,
  );
  // solo 只隐藏不卸载（hidden 而非条件渲染），分屏草稿不丢。
  assert.match(chatArea, /hidden=\{soloPaneId !== null && leaf\.paneId !== soloPaneId\}/);

  const workbench = readUiSource("v4/WorkbenchPane.tsx");
  assert.match(workbench, /hidden && "hidden"/);

  const timeline = readUiSource("v4/ConversationTimeline.tsx");
  assert.match(timeline, /--v4-floating-composer-dock-height/);
  assert.match(timeline, /floatingComposerDockRef\.current \|\|/);
});

/* ---------------- 4. shortcutCommands 注册形状 ---------------- */

test("T-UF5-12 toggleSidePaneFullView 注册：window 通道 + CmdOrCtrl+Shift+f + 不撞既有键", () => {
  const entry = SHORTCUT_COMMANDS.find((command) => command.id === "toggleSidePaneFullView");
  assert.ok(entry, "命令表必须登记 toggleSidePaneFullView");
  assert.equal(entry.channel, "window");
  assert.deepEqual(getDefaultShortcutBindings("toggleSidePaneFullView"), ["CmdOrCtrl+Shift+f"]);
  assert.equal(entry.scope, undefined, "全局作用域（缺省 global）");
  // 默认绑定不得与任何既有命令重复。
  const duplicated = SHORTCUT_COMMANDS.filter(
    (command) =>
      command.id !== "toggleSidePaneFullView" &&
      command.defaultBindings.some((binding) => binding === "CmdOrCtrl+Shift+f"),
  );
  assert.deepEqual(duplicated, []);
});

test("T-UF5-13 快捷键接线形状：App 只对桌面下发处理器，Web 设置页不展示该行", () => {
  const app = readUiSource("App.tsx");
  assert.match(
    app,
    /const toggleSidePaneFullViewShortcutLabel = useShortcutCommandLabel\("toggleSidePaneFullView"\);/,
  );
  assert.match(app, /const supportsSidePaneFullView = Boolean\(isDesktop\);/);
  assert.match(
    app,
    /toggleSidePaneFullView: supportsSidePaneFullView\s*\n\s*\? \(\) => runVisibleWorkspaceCommand\(handleToggleSidePaneFullView\)\s*\n\s*: null,/,
  );
  assert.match(
    app,
    /sidePaneFullView=\{supportsSidePaneFullView \? sidePaneFullView : undefined\}/,
  );

  const settings = readUiSource("settings/ShortcutSettingsSection.tsx");
  assert.match(
    settings,
    /if \(entry\.id === "toggleSidePaneFullView" && !isDesktop\) return false;/,
  );
});

test("T-UF5-14 进入/退出链路：面板关闭时先开面板再进入，按钮与快捷键共用 controller", () => {
  const app = readUiSource("App.tsx");
  assert.match(app, /if \(!sidePaneFullView\.fullView && !isSidePaneOpen\) \{/);
  assert.match(app, /sidePaneFullView\.enter\(\);/);
  assert.match(app, /sidePaneFullView\.toggle\(\);/);

  const shell = readUiSource("app-shell/WorkspaceShellLayout.tsx");
  assert.match(shell, /active: isFullView,\s*\n\s*onToggle: fullViewController\.toggle,/);
  assert.match(shell, /onSelectSurface: fullViewController\.setSurface,/);
});

/* ---------------- 5. i18n 对称 ---------------- */

const SIDE_PANE_FULL_VIEW_KEYS = [
  "sidePane.fullView.enter",
  "sidePane.fullView.exit",
  "sidePane.fullView.openAnswer",
  "sidePane.fullView.minimize",
  "sidePane.fullView.restore",
  "sidePane.fullView.openConversation",
  "sidePane.fullView.handle",
  "sidePane.fullView.expandMessages",
  "sidePane.fullView.collapseMessages",
  "sidePane.fullView.statusRunning",
  "sidePane.fullView.statusIdle",
  "settings.shortcuts.command.toggleSidePaneFullView",
];

test("T-UF5-15 完整视图 i18n 键在 zh-CN / en-US 双侧对称且非空", () => {
  const readLocale = (locale: string) =>
    readFileSync(
      path.join(repoRoot, "packages", "ui", "src", "i18n", "locales", `${locale}.ts`),
      "utf8",
    );
  const zh = readLocale("zh-CN");
  const en = readLocale("en-US");
  for (const key of SIDE_PANE_FULL_VIEW_KEYS) {
    const pattern = new RegExp(`"${key.replaceAll(".", "\\.")}": "([^"]+)"`);
    assert.ok(pattern.test(zh), `zh-CN 缺少 ${key}`);
    assert.ok(pattern.test(en), `en-US 缺少 ${key}`);
  }
});
