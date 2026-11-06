#!/usr/bin/env node
/**
 * CLI-02 回归网：Plan 闸门只收紧、不放宽。
 *
 * 旧实现里 `checkPlanMode` 对「只读且非 destructive」直接放行（不看
 * needsApproval），对「非 destructive 的 MCP 工具」也直接放行，于是
 * Plan 模式比基础模式更宽；guarded 的单次确认又带 `!planEnabled`，
 * 开着 Plan 时被整段跳过。
 *
 * 运行：`npx tsx --test scripts/test-permission-plan-gate.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { PermissionService } = await import(
  new URL("../src/permission/service.ts", import.meta.url).href
);
const { bashToolEntry } = await import(
  new URL("../src/tool/handlers/bash.ts", import.meta.url).href
);
const { createToolExecutor } = await import(
  new URL("../src/tool/executor.ts", import.meta.url).href
);
const { createToolRegistry } = await import(
  new URL("../src/tool/registry.ts", import.meta.url).href
);
const { CoreErrorType } = await import("@zcode/contracts");

const service = new PermissionService();

const baseContext = (mode, extra = {}) => ({
  toolName: "WebFetch",
  input: { url: "https://example.com" },
  riskLevel: "low",
  mode,
  ...extra,
});

const mcpPermission = {
  permission: "mcp",
  reason: "test mcp tool",
  riskLevel: "medium",
  sideEffectScope: "workspace",
  needsApproval: true,
  patternSources: [],
  denyPriority: "beforeAsk",
};

const POSIX_SHELL = {
  dialect: "posix",
  source: "auto-detected",
  display: { name: "bash" },
};

/**
 * 生产口径的 Bash 能力：工具元数据 + `resolveBashPermissionCapability` 的运行时覆盖，
 * 与 `resolveRuntimePermissionCapability` 的合并顺序一致（SA-A7）。
 */
function bashCapability(input, mode = "guarded") {
  const runtime = bashToolEntry.resolvePermissionCapability?.(input, {
    mode,
    bashShellSelection: POSIX_SHELL,
  });
  return {
    ...bashToolEntry.metadata,
    ...runtime,
    permission: { ...bashToolEntry.permission, ...runtime?.permission },
  };
}

test("Plan 不再比基础模式更宽：只读但需审批的工具交回原模式判定", () => {
  const plan = service.checkPermission(baseContext("build", { planEnabled: true }), {
    readOnly: true,
    destructive: false,
    needsApproval: true,
  });
  const build = service.checkPermission(baseContext("build"), {
    readOnly: true,
    destructive: false,
    needsApproval: true,
  });

  assert.equal(plan.decision, "ask");
  assert.equal(plan.decision, build.decision, "Plan 与基础模式的结论必须一致");
  assert.equal(plan.ruleId, "mode.build.sideEffect");
});

test("Plan 仍放行真正免审批的只读工具", () => {
  const decision = service.checkPermission(baseContext("build", { planEnabled: true }), {
    readOnly: true,
    destructive: false,
    needsApproval: false,
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.plan.readOnly");
});

test("Plan 下非 destructive MCP 改为询问且不提供始终允许", () => {
  const decision = service.checkPermission(
    {
      toolName: "mcp__demo__write",
      input: {},
      riskLevel: "medium",
      mode: "build",
      planEnabled: true,
    },
    { readOnly: false, destructive: false, needsApproval: true, permission: mcpPermission },
  );

  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "mode.plan.mcp");
  assert.equal(decision.optionsPolicy, "no-always-allow");
});

// SA-A7：旧用例传的是生产不存在的组合（readOnly:true + userApprovalRule）。真实
// `resolveBashPermissionCapability` 对 guarded 危险命令只给 userApprovalRule，readOnly 仍来自
// 工具元数据的 false，Plan 闸门会先按 `mode.plan.nonReadOnly` 直接 deny——所以
// 「guardedSingleUseAsk 补发单次确认」这一分支本就不可达，Plan 下就是 deny（更严）。
test("guarded + Plan 的危险命令直接 deny：审批不能解除 Plan 限制", () => {
  const input = { command: "rm -rf /tmp/x" };
  const capability = bashCapability(input);

  assert.equal(
    capability.userApprovalRule,
    "safety.bash.remove-critical-path",
    "guarded 危险命令必须由真实 resolver 给出单次确认规则",
  );
  // 生产 Bash 元数据是 readOnly:false；旧用例的 readOnly:true 组合生产不存在。
  assert.equal(capability.readOnly, false);
  assert.equal(capability.needsApproval, true);

  const guarded = service.checkPermission(
    { toolName: "Bash", input, riskLevel: capability.riskLevel, mode: "guarded" },
    capability,
  );
  // 不开 Plan 才走单次确认。
  assert.equal(guarded.decision, "ask");
  assert.equal(guarded.approvalMode, "user-once");

  const guardedPlan = service.checkPermission(
    {
      toolName: "Bash",
      input,
      riskLevel: capability.riskLevel,
      mode: "guarded",
      planEnabled: true,
    },
    capability,
  );
  assert.equal(guardedPlan.decision, "deny");
  assert.equal(guardedPlan.ruleId, "mode.plan.nonReadOnly");
  assert.equal(guardedPlan.approvalMode, undefined, "被 deny 的请求不该带单次确认标记");
});

test("Plan 的选项策略会收窄工具声明，且不会被工具声明放宽", async () => {
  const { resolveToolApproval } = await import(
    new URL("../src/tool/executor/approval-gate.ts", import.meta.url).href
  );
  const deps = {};
  const toolCall = { id: "t1", name: "mcp__demo__write", input: {} };
  const traceContext = {};

  const planAsk = service.checkPermission(
    {
      toolName: "mcp__demo__write",
      input: {},
      riskLevel: "medium",
      mode: "build",
      planEnabled: true,
    },
    { readOnly: false, destructive: false, needsApproval: true, permission: mcpPermission },
  );
  assert.equal(planAsk.optionsPolicy, "no-always-allow");

  // 工具声明「本会话始终允许」时，Plan 的 ask 仍不提供始终允许。
  const narrowed = resolveToolApproval(
    deps,
    toolCall,
    { permission: { askOptions: { allowAlways: "session" } } },
    {},
    traceContext,
    planAsk.optionsPolicy,
  );
  assert.equal(narrowed.gate, "ask");
  assert.equal(narrowed.optionsPolicy, "no-always-allow");

  // 没有判定要求时保持工具声明（回归：不能把所有 ask 一律收窄）。
  const declared = resolveToolApproval(
    deps,
    toolCall,
    { permission: { askOptions: { allowAlways: "session" } } },
    {},
    traceContext,
    undefined,
  );
  assert.equal(declared.optionsPolicy, "session-always-allow");

  // 工具声明更严时不会被放宽。
  const keptStrict = resolveToolApproval(
    deps,
    toolCall,
    { permission: { askOptions: { allowAlways: false } } },
    {},
    traceContext,
    undefined,
  );
  assert.equal(keptStrict.optionsPolicy, "no-always-allow");
});

// SC-C9：旧守卫是拿正则去匹配 permission-flow.ts 的源码文本——格式化或改参数名会误红，
// 把调用挪进不可达分支仍可能通过。改成真的跑一次 ask，看 broker 收到的请求。
const mcpWriteEntry = {
  capability: "test MCP write tool",
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object" },
  metadata: {
    description: "test MCP write tool",
    name: "mcp__demo__write",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 1_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  permission: mcpPermission,
  resultBudget: {
    maxInlineBytes: 1_000,
    maxModelBytes: 1_000,
    strategy: "truncate",
    preview: { direction: "head" },
  },
  timeout: { defaultMs: 1_000, allowCallOverride: false },
  cancellation: { supported: false, cleanup: "bestEffort", userVisibleMessage: "cancelled" },
  trace: {
    required: false,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
  handler: async () => ({}),
};

/**
 * 真 executor：假 registry（一条工具）+ 假 broker（记录每个请求）——判权、确认窗载荷与
 * 应答校验全部走产品代码，不 mock 中间层。
 */
function createExecutorHarness({ entry, mode = "build", planEnabled = false, answer }) {
  const registry = createToolRegistry();
  registry.register(entry);
  const requests = [];
  const events = [];
  const executor = createToolExecutor({
    registry,
    getMode: () => mode,
    getWorkingDirectory: () => ".",
    sessionId: "sess_permission_gate",
    permissionService: new PermissionService(),
    sessionModePort: {
      isPlanEnabled: () => planEnabled,
      getMode: () => mode,
      getPrePlanMode: () => undefined,
      enterPlanMode: async () => ({ mode, previousMode: mode }),
      exitPlanMode: async () => ({ mode, previousMode: mode }),
    },
    permissionBroker: {
      requestPermission: async (request) => {
        requests.push(request);
        return answer(request);
      },
    },
    emitEvent: async (event) => {
      events.push(event);
    },
  });
  return { executor, events, requests };
}

test("判定自带的选项策略真的随 ask 到达 broker 请求（行为守卫）", async () => {
  const planHarness = createExecutorHarness({
    entry: mcpWriteEntry,
    planEnabled: true,
    answer: () => ({ decision: "deny" }),
  });
  const result = await planHarness.executor.execute({
    id: "call_mcp_plan",
    name: "mcp__demo__write",
    input: {},
  });

  assert.equal(planHarness.requests.length, 1);
  assert.equal(planHarness.requests[0].ruleId, "mode.plan.mcp");
  // 判定侧的收窄必须真的上到确认窗请求，否则 UI 仍会给「始终允许」。
  assert.equal(planHarness.requests[0].optionsPolicy, "no-always-allow");
  assert.equal(result.success, false);

  // 反向对照：没有 Plan 时同一条工具照常 ask，且不带该策略——证明上一条不是恒真。
  const buildHarness = createExecutorHarness({
    entry: mcpWriteEntry,
    answer: () => ({ decision: "deny" }),
  });
  await buildHarness.executor.execute({
    id: "call_mcp_build",
    name: "mcp__demo__write",
    input: {},
  });
  assert.equal(buildHarness.requests.length, 1);
  assert.equal(buildHarness.requests[0].ruleId, "mode.build.sideEffect");
  assert.equal(buildHarness.requests[0].optionsPolicy, undefined);
});

test("user-once 应答夹带 permissionUpdates 被拒为 InvalidInput", async () => {
  const harness = createExecutorHarness({
    entry: bashToolEntry,
    mode: "guarded",
    answer: () => ({
      decision: "allow",
      // 单次确认只对这一次有效：借这次弹窗把规则永久写进项目必须被拒。
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    }),
  });

  const result = await harness.executor.execute({
    id: "call_bash_once",
    name: "Bash",
    input: { command: "rm -rf /tmp/x" },
  });

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].approvalMode, "user-once");
  assert.equal(result.success, false);
  assert.equal(result.error?.type, CoreErrorType.InvalidInput);
  assert.match(result.error?.message ?? "", /single-use requests cannot persist project rules/u);
});
