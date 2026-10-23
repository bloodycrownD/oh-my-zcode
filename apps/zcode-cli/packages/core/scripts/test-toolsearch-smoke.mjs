#!/usr/bin/env node
/**
 * phase-toolsearch 冒烟集（spec Step 20b / T-TS1+T-TS2，2026-10-22）。
 *
 * 覆盖 spec 点名的五类冒烟面（不重写上游 28 用例，只锁 omz 落地语义）：
 *   1. defer 决策纯函数——shouldDefer 分类表（内置不 defer / MCP defer / alwaysLoad 豁免 /
 *      控制入口排除 / providerNative 排除）与 resolveToolSearchMode 三态。
 *   2. searchTools 检索——select: 精确选择与关键词打分。
 *   3. 公告块投影——buildToolSearchAnnouncement 生成/增量不重发/mode off 恒空（D4：
 *      公告只随内存 entries 存续，元数据驱动 delta）。
 *   4. tool_reference 投影——local 模式展开成 <functions> 文本 + loadedToolCallIds；
 *      native 保留引用块；mode off 剥离公告条目。
 *   5. mode off 恒等（等价性证明断言 b）——buildToolExposure off 时工具全量透传、
 *      entries 逐引用共享。
 *   6. DeferredToolCall 准入——未启用拒绝 / deferred 放行解包 / 常驻拒绝。
 *   7. 按需 hydration——hydrateToolSearchContent / hydrateToolSearchAnnouncement 纯函数
 *      往返（omz 不接持久层，仅内存态校验面）。
 *
 * 运行方式：`pnpm --dir apps/zcode-cli/packages/core run test:toolsearch-smoke`
 * （tsx --test 范式，与同目录脚本一致；被测模块全是纯函数，不依赖 runtime 实例。）
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
} from "@zcode/contracts";
import { isDeferredTool, buildToolExposure, buildToolSearchAnnouncement, resolveToolSearchMode } from "../src/tool/search/exposure.js";
import { collectToolSearchHistory, projectToolReferences } from "../src/tool/search/history.js";
import { searchTools } from "../src/tool/search/search.js";
import { resolveDeferredToolCall } from "../src/tool/deferred-call.js";
import { hydrateToolSearchAnnouncement, hydrateToolSearchContent } from "../src/agent/tool-search-hydration.js";

// ── 造具 ─────────────────────────────────────────────────────────────────────

function fakeModel(overrides = {}) {
  return {
    providerId: "zhipu",
    modelId: "test-model",
    properties: { supportsToolCall: true, supportsMidConversationSystem: false },
    optionSpecs: {},
    options: {},
    ...overrides,
  };
}

function builtinEntry(name) {
  return { get: () => ({ metadata: { name, readOnly: true, concurrentSafe: true } }) };
}

const localModel = fakeModel();

function tool(name, extra = {}) {
  return { name, description: `${name} description`, inputSchema: { type: "object" }, ...extra };
}

function mcpMetadata(name) {
  return {
    name,
    readOnly: true,
    concurrentSafe: true,
    destructive: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    mcpPresentation: { serverName: "slack", toolName: "search" },
  };
}

/** ToolSearch 成功结果条目（引用块形态，local/native 投影的输入）。 */
function toolReferenceEntry(toolNames, toolCallId = "call-1") {
  return {
    message: {
      role: "tool",
      toolCallId,
      toolName: TOOL_SEARCH_NAME,
      content: toolNames.map((toolName) => ({ type: "tool_reference", toolName })),
    },
  };
}

// ── 1. defer 决策纯函数（T-TS1 分类表） ─────────────────────────────────────

test("T-TS1a: shouldDefer 分类表——内置不 defer / MCP defer / alwaysLoad 豁免 / 控制入口与 providerNative 排除", () => {
  const builtin = { name: "Read", providerNative: undefined };
  // 内置核心工具：omz 不迁上游 handler 级 shouldDefer 标注 → 恒常驻。
  assert.equal(isDeferredTool(builtin, { name: "Read", readOnly: true }), false);
  // MCP 工具：mcpPresentation 在场 → 默认 defer。
  assert.equal(isDeferredTool({ name: "mcp__slack__search" }, mcpMetadata("mcp__slack__search")), true);
  // alwaysLoad 豁免：server 配置/工具 _meta 声明的常驻工具回 resident。
  assert.equal(
    isDeferredTool(
      { name: "mcp__slack__search" },
      { ...mcpMetadata("mcp__slack__search"), alwaysLoad: true },
    ),
    false,
  );
  // 两个控制入口永不被 defer。
  assert.equal(isDeferredTool({ name: TOOL_SEARCH_NAME }, mcpMetadata(TOOL_SEARCH_NAME)), false);
  assert.equal(
    isDeferredTool({ name: DEFERRED_TOOL_CALL_NAME }, mcpMetadata(DEFERRED_TOOL_CALL_NAME)),
    false,
  );
  // providerNative 工具不进 defer 集。
  assert.equal(isDeferredTool({ name: "web_search", providerNative: {} }, { name: "web_search" }), false);
});

test("T-TS1b: resolveToolSearchMode——off 恒 off / local 需工具调用能力 / auto 按能力升 native / native 无能力报错", () => {
  assert.equal(resolveToolSearchMode(localModel, "off"), "off");
  assert.equal(resolveToolSearchMode(localModel, "local"), "local");
  // auto：协议支持（anthropic-messages capability defaultEnabled）→ native。
  const nativeCapable = fakeModel({
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  });
  assert.equal(resolveToolSearchMode(nativeCapable, "auto"), "native");
  // auto：协议不支持 → 回 local（supportsToolCall=true）。
  assert.equal(resolveToolSearchMode(localModel, "auto"), "local");
  // native 直选但协议不支持 → 显式报错（不静默降级）。
  assert.throws(() => resolveToolSearchMode(localModel, "native"));
});

// ── 2. searchTools 检索（T-TS1 冒烟面） ─────────────────────────────────────

test("T-TS2: searchTools——select: 精确选择命中 deferred；关键词只搜 deferred 目录并按分数排序", () => {
  const catalog = [
    { name: "Read", deferred: false },
    { name: "mcp__slack__search", deferred: true, mcp: { serverName: "slack", toolName: "search" } },
    { name: "mcp__slack__post_message", deferred: true, mcp: { serverName: "slack", toolName: "post_message" } },
  ];
  const select = searchTools("select:mcp__slack__post_message", catalog);
  assert.deepEqual(select, ["mcp__slack__post_message"]);
  // 关键词返回按分数排序的 deferred 集：双词命中的 search 排在只命中 server 名的 post_message 前。
  const keyword = searchTools("slack search", catalog);
  assert.equal(keyword[0], "mcp__slack__search");
  assert.ok(keyword.includes("mcp__slack__post_message"));
  // 精确名匹配按上游语义回退完整目录（resident 也可被点名；关键词搜索仍只打 deferred）。
  assert.deepEqual(searchTools("Read", catalog), ["Read"]);
  assert.equal(searchTools("nonexistent_tool", catalog).length, 0);
});

// ── 3. 公告块投影（T-TS2 冒烟面） ───────────────────────────────────────────

test("T-TS3a: mode off 恒无公告（关闭路径零扫描）", () => {
  const announcement = buildToolSearchAnnouncement({
    model: localModel,
    mode: "off",
    tools: [tool("mcp__slack__search")],
    registry: { get: (name) => ({ metadata: mcpMetadata(name) }) },
    entries: [],
  });
  assert.equal(announcement, undefined);
});

test("T-TS3b: local 模式生成公告带增量 metadata；已公告集合驱动 delta 不重发", () => {
  // registry 按真实分类：MCP 工具有 mcpPresentation，内置工具没有（分类表）。
  const registry = {
    get: (name) => ({
      metadata: name === "mcp__slack__search" ? mcpMetadata(name) : { name, readOnly: true },
    }),
  };
  // 控制入口必须在目录内（controlsAvailable 判定）——与恒注册面一致。
  const tools = [
    tool(TOOL_SEARCH_NAME),
    tool(DEFERRED_TOOL_CALL_NAME),
    tool("Read"),
    tool("mcp__slack__search"),
  ];
  const input = { model: localModel, mode: "local", tools, registry, entries: [] };
  const first = buildToolSearchAnnouncement(input);
  assert.ok(first, "首次目录应产出公告");
  assert.equal(first.metadata.source, "tool_search_announcement");
  assert.deepEqual([...first.metadata.toolSearchAnnouncement.addedNames], ["mcp__slack__search"]);
  assert.ok(first.content.includes("mcp__slack__search"), "公告正文列出 deferred 工具名");
  // 第二轮：entries 携带上一轮公告 → addedNames 为空 → 无新公告。
  const second = buildToolSearchAnnouncement({ ...input, entries: [first] });
  assert.equal(second, undefined);
});

// ── 4. tool_reference 投影（T-TS2 冒烟面） ─────────────────────────────────

test("T-TS4a: local 模式把引用块展开成 <functions> 文本（定义内联，loadedToolCallIds 留空）", () => {
  const tools = [
    tool("mcp__slack__search", { inputSchema: { type: "object", properties: {} } }),
  ];
  const entries = [toolReferenceEntry(["mcp__slack__search"])];
  const { entries: projected, loadedToolCallIds } = projectToolReferences(
    entries,
    "local",
    tools,
    new Set(["mcp__slack__search"]),
  );
  // local 的定义已内联进结果文本，无需 "Tool loaded." 后缀 → loadedToolCallIds 留空（上游同语义）。
  assert.equal(loadedToolCallIds.size, 0);
  const blocks = projected[0].message.content;
  const functionsBlock = blocks.find((block) => block.type === "text" && block.text.includes("<functions>"));
  assert.ok(functionsBlock, "local 模式必须展开定义文本");
  assert.ok(functionsBlock.text.includes("mcp__slack__search"));
  // 原引用块不再保留（防未加载 schema 直调）。
  assert.equal(blocks.some((block) => block.type === "tool_reference"), false);
});

test("T-TS4b: native 模式保留引用块；mode off 剥离公告条目", () => {
  const entry = toolReferenceEntry(["mcp__slack__search"]);
  const native = projectToolReferences([entry], "native", [tool("mcp__slack__search")]);
  assert.equal(native.entries[0].message.content[0].type, "tool_reference");
  assert.equal(native.loadedToolCallIds.has("call-1"), true);
  // mode off：公告 attachment 从投影剥离（关闭后历史里的公告不再上路）。
  const announcementEntry = {
    kind: "attachment",
    content: "announcement",
    metadata: { source: "tool_search_announcement", toolSearchAnnouncement: { addedNames: ["a"], removedNames: [], readdedNames: [] } },
  };
  const plain = { message: { role: "user", content: "hello" } };
  const off = projectToolReferences([announcementEntry, plain], "off", []);
  assert.deepEqual(off.entries, [plain]);
});

// ── 5. mode off 恒等（等价性证明断言 b） ───────────────────────────────────

test("T-TS5: buildToolExposure off=恒等——工具全量透传（deferLoading 剥离）、普通条目逐引用共享", () => {
  const userEntry = { message: { role: "user", content: "hi" } };
  const tools = [tool("Read"), tool("mcp__slack__search", { deferLoading: true })];
  const exposure = buildToolExposure({
    model: localModel,
    mode: "off",
    tools,
    registry: { get: (name) => (name === "Read" ? { metadata: { name: "Read", readOnly: true } } : { metadata: mcpMetadata(name) }) },
    entries: [userEntry],
  });
  assert.equal(exposure.enabled, false);
  assert.equal(exposure.context.mode, "off");
  assert.deepEqual(
    exposure.tools.map((t) => t.name),
    ["Read", "mcp__slack__search"],
  );
  // off 模式剥离 deferLoading 标记（不外泄到 provider 载荷）。
  assert.equal(exposure.tools.find((t) => t.name === "mcp__slack__search").deferLoading, undefined);
  // 普通条目逐引用共享（MC cache 前缀稳定的条件，证明 §3.2d）。
  assert.equal(exposure.entries[0], userEntry);
  // 防御性投影：off 下若历史残留引用块（理论上不可达——ToolSearch 在 off 被隐藏），
  // 引用块会被剥离并占位，不会把裸引用发给 provider。
  const legacyReference = toolReferenceEntry(["X"], "call-x");
  const stripped = projectToolReferences([legacyReference], "off", []);
  assert.equal(
    stripped.entries[0].message.content.some((block) => block.type === "tool_reference"),
    false,
  );
});

// ── 6. DeferredToolCall 准入（T-TS1 冒烟面） ───────────────────────────────

test("T-TS6: resolveDeferredToolCall——未启用拒绝 / deferred 放行解包 / 常驻拒绝", () => {
  const registry = {
    get: (name) => (name === "mcp__slack__search" ? { metadata: mcpMetadata(name) } : { metadata: { name, readOnly: true } }),
  };
  const catalog = [
    { name: "Read", deferred: false },
    { name: "mcp__slack__search", deferred: true, mcp: { serverName: "slack", toolName: "search" } },
    { name: DEFERRED_TOOL_CALL_NAME, deferred: false },
  ];
  const enabledContext = { enabled: true, mode: "local", catalog, discovered: new Set() };
  const call = { id: "t1", name: DEFERRED_TOOL_CALL_NAME, input: { name: "mcp__slack__search", input: { q: "x" } } };
  // 放行：解包到目标名与目标参数。
  const admitted = resolveDeferredToolCall(call, enabledContext, registry);
  assert.equal(admitted.error, undefined);
  assert.equal(admitted.call.name, "mcp__slack__search");
  assert.deepEqual(admitted.call.input, { q: "x" });
  // 常驻工具拒绝直调。
  const resident = resolveDeferredToolCall(
    { id: "t2", name: DEFERRED_TOOL_CALL_NAME, input: { name: "Read", input: {} } },
    enabledContext,
    registry,
  );
  assert.match(resident.error.message, /directly using its normal tool call/);
  // 未启用（off/mode 不符）整类拒绝。
  const disabled = resolveDeferredToolCall(call, { enabled: false, mode: "off", catalog, discovered: new Set() }, registry);
  assert.match(disabled.error.message, /not available/);
});

// ── 7. 按需 hydration（T-TS1 冒烟面；omz 不接持久层，纯内存校验面） ─────────

test("T-TS7: hydration 纯函数——合法内容往返、非法内容回退 undefined、公告 delta 校验", () => {
  const content = [{ type: "tool_reference", toolName: "mcp__slack__search" }];
  assert.deepEqual(hydrateToolSearchContent(content), content);
  assert.equal(hydrateToolSearchContent([{ type: "bogus" }]), undefined);
  assert.equal(hydrateToolSearchContent(undefined), undefined);
  const delta = { addedNames: ["a", "b"], removedNames: [], readdedNames: ["b"] };
  assert.deepEqual(hydrateToolSearchAnnouncement(delta), delta);
  // readded ⊄ added → schema refine 拒绝。
  assert.equal(hydrateToolSearchAnnouncement({ addedNames: [], removedNames: [], readdedNames: ["x"] }), undefined);
});

// ── 收尾：collectToolSearchHistory 的 discovered 面（公告/引用双通道） ──────

test("T-TS8: collectToolSearchHistory 从引用块与 compact 边界视图收集 discovered", () => {
  const entries = [
    toolReferenceEntry(["mcp__slack__search"]),
    // D4：compactBoundary 经窄化视图读取；omz 内存态不产该字段，此处仅验证视图读取不抛。
    { message: { role: "tool", toolCallId: "c2", toolName: "Other", content: "text-only" } },
  ];
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(entries);
  assert.deepEqual([...discovered], ["mcp__slack__search"]);
  assert.equal(preCompactDiscoveredTools.size, 0);
});
