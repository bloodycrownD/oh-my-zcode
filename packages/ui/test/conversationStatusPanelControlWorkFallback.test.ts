// T-S2（bugfix-batch-20261009 / ③ 前台子智能体手动关闭）：
// buildConversationStatusPanelModel 在 controlWork 未命中时回退 subagent.agentId
// 作为 controlWorkId，并保留 waiting / 缺 agentId / 重复身份的既有不猜测语义。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// 被测模块经 `@/lib/planToolCall.js` 别名导入（packages/ui/tsconfig.json 的
// paths），而仓库根 `test:v4-perf` 直接以 `tsx --test` 运行且根目录没有
// tsconfig.json，别名不生效。这里在导入被测模块前挂同步 resolve 钩子把 `@/`
// 落到真实文件——与 core scripts 里 registerHooks 兜底 dist 同一范式。
// 别名写的是 `.js` 后缀（NodeNext 规范），真实文件是 `.ts`，故按候选依次探测。
const UI_SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
function resolveAlias(specifier: string): string | undefined {
  const relative = specifier.slice("@/".length);
  for (const candidate of [
    `${UI_SRC_ROOT}${relative}`,
    `${UI_SRC_ROOT}${relative.replace(/\.js$/, ".ts")}`,
    `${UI_SRC_ROOT}${relative.replace(/\.js$/, ".tsx")}`,
  ]) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return undefined;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const url = resolveAlias(specifier);
      if (url) return { shortCircuit: true, url };
    }
    return nextResolve(specifier, context);
  },
});

const { buildConversationStatusPanelModel } =
  await import("../src/v4/conversationStatusPanelModel.js");
import type {
  BackgroundWorkSummary,
  RunningSubagentSummary,
} from "@zcode/shared/zcode-protocol-v4";

function subagent(overrides: Partial<RunningSubagentSummary> = {}): RunningSubagentSummary {
  return {
    childSessionId: "subagent_agent_1",
    agentId: "agent_1",
    subagentType: "general-purpose",
    title: "Explore theme",
    status: "running",
    ...overrides,
  };
}

function build(
  runningSubagents: readonly RunningSubagentSummary[],
  backgroundWorks: readonly BackgroundWorkSummary[] = [],
) {
  return buildConversationStatusPanelModel({ backgroundWorks, runningSubagents });
}

test("controlWork 未命中且 agentId 存在时回退到 agentId 作为 controlWorkId", () => {
  const model = build([subagent()]);
  assert.equal(model.runningSubagentWorks.length, 1);
  const row = model.runningSubagentWorks[0]!;
  assert.equal(row.controlWorkId, "agent_1");
  assert.equal(row.cancellable, true);
  // 回退只补控制句柄，不改写投影自身的身份字段。
  assert.equal(row.agentId, "agent_1");
  assert.equal(row.childSessionId, "subagent_agent_1");
});

test("status 为 waiting 时不回退，避免误停等待中的子智能体", () => {
  const model = build([subagent({ status: "waiting" })]);
  const row = model.runningSubagentWorks[0]!;
  assert.equal(row.controlWorkId, undefined);
  assert.equal(row.cancellable, undefined);
});

test("缺 agentId 时构造不出 stopTask 的 taskId，宁可不给控制", () => {
  const model = build([subagent({ agentId: undefined })]);
  assert.equal(model.runningSubagentWorks[0]!.controlWorkId, undefined);
});

/** 一条 running 的 subagent backgroundWork（精确联接键 = childSessionId）。 */
function work(overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary {
  return {
    kind: "subagent",
    workId: "work_1",
    childSessionId: "subagent_agent_1",
    status: "running",
    title: "Explore theme",
    startedAt: 1,
    anchorRowId: null,
    ...overrides,
  };
}

test("命中 controlWork 时仍走原联接路径，回退不抢场", () => {
  const model = build([subagent()], [work({ cancellable: false })]);
  const row = model.runningSubagentWorks[0]!;
  assert.equal(row.controlWorkId, "work_1");
  assert.equal(row.cancellable, false);
});

test("backgrounded 侧 cancel 入口在任何偏斜下都不许消失（既有语义不回退）", () => {
  // 已结束的 subagent work 不是 running，精确联接本就缺席；此时运行中的投影行
  // 仍应通过 agentId 回退拿到控制句柄。
  const model = build(
    [subagent()],
    [work({ workId: "work_done", childSessionId: "subagent_other", status: "cancelled" })],
  );
  assert.equal(model.runningSubagentWorks[0]!.controlWorkId, "agent_1");
});
