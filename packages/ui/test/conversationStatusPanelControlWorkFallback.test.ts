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

// T-S2（sub/C-orch-1 + N-2，r2 数据流版）：重复 childSessionId 下的回退语义与可停性
// 聚合。RunningSubagentSummary 无 cancellable 字段（它只在 BackgroundWorkSummary 上，
// snapshot.ts:424 optional），重复命中时主表置 null 哨兵、组信息转存副表——行仍回退
// agentId 作为控制句柄（回退目标是任务自身 id，非按标题/时间猜测，无误停风险），
// 可停性改按副表整组聚合：组内任一 cancellable===false 即不可停，缺省视为可停
// （与精确命中路径的 !== false 对称）。
test("重复 childSessionId 仍回退 agentId，可停性按组内 cancellable 聚合", () => {
  // a) 两条 work 同 childSessionId（重复身份）→ 仍回退 agentId，不按标题/时间猜 work。
  const duplicated = build([subagent()], [work(), work({ workId: "work_2" })]);
  assert.equal(duplicated.runningSubagentWorks.length, 1, "重复身份不得补出第二行");
  const rowA = duplicated.runningSubagentWorks[0]!;
  assert.equal(rowA.controlWorkId, "agent_1");
  // b) 同组仅一条 cancellable:false → 整行不可停（任一 false → 不可停）。
  const oneFalse = build([subagent()], [work(), work({ workId: "work_2", cancellable: false })]);
  assert.equal(oneFalse.runningSubagentWorks.length, 1, "重复身份不得补出第二行");
  const rowB = oneFalse.runningSubagentWorks[0]!;
  assert.equal(rowB.controlWorkId, "agent_1");
  assert.equal(rowB.cancellable, false);
  // c) 两条均缺省 → 可停。
  const bothDefault = build([subagent()], [work(), work({ workId: "work_2" })]);
  const rowC = bothDefault.runningSubagentWorks[0]!;
  assert.equal(rowC.cancellable, true);
});
