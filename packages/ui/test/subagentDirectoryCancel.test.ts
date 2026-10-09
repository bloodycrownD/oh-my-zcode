// T-S3（bugfix-batch-20261009 / ③ 前台子智能体手动关闭，Step 13 / 3c）：
// 子智能体目录页「停止」按钮的条件渲染判据。被测模块是
// lib/subagentDirectoryCancel.ts（零 `@/` 依赖的纯 model，与 perfProbe /
// memoryDiagnostics 同一可测性约定），由 SubagentDirectorySidePane.tsx 的
// DirectoryRow 消费：
//   - 上游放行（cancellable）+ running + agentId → workId = agentId，渲染停止按钮；
//   - 上游未放行（父 pane 只读 / 无 handler）→ null，不渲染；
//   - 非 running 或 agentId 缺席 → null，不渲染（与 wave-0 T-S2 的
//     controlWorkId 回退同口径：缺 agentId 构造不出 stopTask 的 taskId）。
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import {
  resolveDirectoryRowCancelWorkId,
  type SubagentDirectoryItem,
} from "../src/lib/subagentDirectoryCancel.js";

function running(overrides: Partial<SubagentDirectoryItem> = {}): SubagentDirectoryItem {
  return {
    childSessionId: "subagent_agent_1",
    agentId: "agent_1",
    subagentType: "general-purpose",
    title: "Explore theme",
    status: "running",
    ...overrides,
  } as SubagentDirectoryItem;
}

function ended(overrides: Partial<ZCodeSessionEndedSubagent> = {}): SubagentDirectoryItem {
  return {
    childSessionId: "subagent_agent_2",
    agentId: "agent_2",
    subagentType: "general-purpose",
    title: "Explore theme",
    status: "success",
    ...overrides,
  } as SubagentDirectoryItem;
}

test("上游放行 + running + agentId 存在 → workId 取 agentId（3c 停止按钮的数据源）", () => {
  assert.equal(resolveDirectoryRowCancelWorkId(running(), true), "agent_1");
});

test("上游未放行（父 pane 只读 / 无 handler 透传）→ 不渲染停止按钮", () => {
  // AnimatedSidePanePanel ← WorkspaceShellLayout 的 canCancelBackgroundWork 为
  // false 时目录页不下发 handler，此时即使 running + agentId 齐全也不渲染。
  assert.equal(resolveDirectoryRowCancelWorkId(running(), false), null);
});

test("waiting / blocked 不是可停的运行态（与状态面板回退同口径：仅 running）", () => {
  assert.equal(resolveDirectoryRowCancelWorkId(running({ status: "waiting" }), true), null);
  assert.equal(resolveDirectoryRowCancelWorkId(running({ status: "blocked" }), true), null);
});

test("已结束行走目录查询分页，没有可停的后台工作", () => {
  assert.equal(resolveDirectoryRowCancelWorkId(ended(), true), null);
  assert.equal(resolveDirectoryRowCancelWorkId(ended({ status: "cancelled" }), true), null);
});

test("缺 agentId 时构造不出 stopTask 的 taskId，宁可不给控制", () => {
  assert.equal(resolveDirectoryRowCancelWorkId(running({ agentId: undefined }), true), null);
});
