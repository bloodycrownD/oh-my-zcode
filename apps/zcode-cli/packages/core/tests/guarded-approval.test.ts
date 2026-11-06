import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  createSessionEvent,
  createSessionId,
  createToolCallId,
  reduce,
  SessionEventType,
  type CollaborationMode,
  type ExecutionShellSelection,
  type PermissionBrokerResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRequestedPayload,
  type PermissionRuleset,
  type SessionEvent,
} from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { PermissionService } from "../src/permission/service.js";
import { createManualPermissionBroker } from "../src/permission/broker.js";
import {
  createDoomLoopGateState,
  type DoomLoopCheckMode,
} from "../src/tool/executor/doom-loop-gate.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

const POSIX: ExecutionShellSelection = {
  dialect: "posix",
  source: "auto-detected",
  display: { name: "bash" },
};
function harness(
  options: {
    mode?: CollaborationMode;
    answer?: (request: PermissionBrokerRequest) => Promise<PermissionBrokerResult>;
    noBroker?: boolean;
    deferredBroker?: PermissionBrokerPort;
    hookInput?: unknown;
    permissionHookInput?: unknown;
    timeoutMs?: number;
    validateInput?: ToolEntry["validateInput"];
    prepareApproval?: ToolEntry["prepareApproval"];
    resolvePermissionCapability?: ToolEntry["resolvePermissionCapability"];
    projectRules?: PermissionRuleset;
    /** 开启 doom-loop 门（每次 harness 各造一份会话级状态）。 */
    doomLoopCheck?: DoomLoopCheckMode;
    /** PermissionRequest hook 退赛（不表态），让竞速只剩用户/broker 应答方。 */
    permissionHookForfeits?: boolean;
    onPublished?: (
      requestId: string,
      broker: ReturnType<typeof createManualPermissionBroker>,
    ) => void;
    /** 只声明静态 bashShellSelection、不传 getter（SA-B12 的兜底路径）。 */
    staticShellSelection?: boolean;
    /** PermissionRequest hook 每轮返回的改写输入；用尽后该轮不再表态（让 broker 应答）。 */
    permissionHookInputs?: readonly unknown[];
    /** 覆盖工具级 permission 声明（askOptions / alwaysAsk / permission 名）。 */
    toolPermission?: ToolEntry["permission"];
    /** 判定服务替身：构造生产不存在的判定组合（比如非 guarded 的 user-once 决策）。 */
    permissionService?: PermissionService;
    /** plan 模式的 isPlanEnabled 来源（Plan 下 MCP ask 的 no-always-allow 日志断言）。 */
    planEnabled?: boolean;
    /** PreToolUse 不表态：否则它的整体 allow 会把 plan/build 的 ask 改成 hook.PreToolUse.ask。 */
    preToolHookForfeits?: boolean;
  } = {},
) {
  const registry = createToolRegistry();
  const handler = vi.fn(async (_input: unknown, _context: ToolExecutionContext) => ({
    stdout: "controlled handler result",
    stderr: "",
    exitCode: 0,
    interrupted: false,
  }));
  registry.register({
    ...bashToolEntry,
    handler,
    outputSchema: undefined,
    ...(options.toolPermission ? { permission: options.toolPermission } : {}),
    ...(options.validateInput ? { validateInput: options.validateInput } : {}),
    ...(options.prepareApproval ? { prepareApproval: options.prepareApproval } : {}),
    ...(options.resolvePermissionCapability
      ? { resolvePermissionCapability: options.resolvePermissionCapability }
      : {}),
  });
  const events: SessionEvent[] = [];
  const requests: PermissionBrokerRequest[] = [];
  const shell = structuredClone(POSIX);
  // 日志捕获沿用 permission-logging.test.ts 的形状：只注入 spy，不改产品日志出口。
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  let mode = options.mode ?? "guarded";
  let cwd = "/workspace/original";
  let permissionRequestHookCalls = 0;
  const hooks = vi.fn(async (input: unknown) => {
    const hookEventName = (input as { hookEventName?: string }).hookEventName;
    if (hookEventName === "PreToolUse" && options.preToolHookForfeits) {
      return { additionalContexts: [] };
    }
    // 轮次化改写（SA-C6）：第 N 次 PermissionRequest 给出第 N 份改写，用尽即退赛。
    // 其余事件（PreToolUse）表态 ask——与 permissionHookInput 的既有行为一致，
    // 避免它的整体 allow 把这里要测的 build/项目 ask 直接抹成放行。
    if (options.permissionHookInputs) {
      if (hookEventName !== "PermissionRequest") {
        return { additionalContexts: [], permissionBehavior: "ask" as const };
      }
      const rewritten = options.permissionHookInputs[permissionRequestHookCalls];
      permissionRequestHookCalls += 1;
      return rewritten === undefined
        ? { additionalContexts: [] }
        : {
            additionalContexts: [],
            permissionBehavior: "ask" as const,
            permissionRequestResult: { behavior: "allow" as const, updatedInput: rewritten },
          };
    }
    // 退赛：PermissionRequest hook 不返回任何表态（permissionBehavior/result），
    // 竞速里只剩 broker 应答方——否则 hook 的 allow 会先于 broker 胜出，
    // 「用户点了本会话总是允许」的路径根本走不到。
    if (hookEventName === "PermissionRequest" && options.permissionHookForfeits) {
      return { additionalContexts: [] };
    }
    return {
      additionalContexts: [],
      permissionBehavior:
        options.permissionHookInput === undefined ? ("allow" as const) : ("ask" as const),
      ...(hookEventName === "PreToolUse" && options.hookInput !== undefined
        ? { updatedInput: options.hookInput }
        : {}),
      ...(hookEventName === "PermissionRequest" && options.permissionHookInput !== undefined
        ? {
            permissionRequestResult: {
              behavior: "allow" as const,
              updatedInput: options.permissionHookInput,
            },
          }
        : {}),
    };
  });
  const saveProjectPermission = vi.fn();
  const broker = createManualPermissionBroker({
    onRequest: (request) => {
      requests.push(request);
    },
  });
  const doomLoopCheck = options.doomLoopCheck;
  const doomLoop = doomLoopCheck === undefined ? undefined : createDoomLoopGateState();
  const executor = createToolExecutor({
    registry,
    getMode: () => mode,
    getWorkingDirectory: () => cwd,
    sessionId: createSessionId("guarded"),
    permissionService: options.permissionService ?? new PermissionService(),
    logger,
    permissionTimeoutMs: options.timeoutMs,
    sessionStore: {
      getSession: async () => ({ projectID: "guarded-project" }),
      getProjectPermission: async () => options.projectRules ?? { allow: [{ toolName: "Bash" }] },
      saveProjectPermission,
    } as never,
    hookRunner: { run: hooks },
    ...(options.staticShellSelection
      ? { bashShellSelection: shell }
      : { getBashShellSelection: () => shell }),
    // 生产环境 supportsPermissionFullAccess 为真：普通 ask 的 PermissionRequested 会带
    // fullAccessSupported，单次确认则不得携带。这个端口是两条断言的区分前提。
    sessionModePort: {
      supportsPermissionFullAccess: () => true,
      isPlanEnabled: () => options.planEnabled ?? false,
      getMode: () => mode,
      getPrePlanMode: () => undefined,
      enterPlanMode: async () => ({ mode: "plan" as const, previousMode: mode }),
      exitPlanMode: async () => ({ mode: "build" as const, previousMode: mode }),
    },
    ...(doomLoop === undefined || doomLoopCheck === undefined
      ? {}
      : { doomLoop, doomLoopCheck }),
    ...(!options.noBroker
      ? {
          permissionBroker:
            options.deferredBroker ??
            (options.answer
              ? {
                  requestPermission: async (request: PermissionBrokerRequest) => {
                    requests.push(request);
                    return options.answer!(request);
                  },
                }
              : broker),
        }
      : {}),
    emitEvent: async (event) => {
      events.push(event);
      if (event.type === SessionEventType.PermissionRequested) {
        options.onPublished?.(event.payload.requestId!, broker);
      }
    },
  });
  const execute = (command = "rm -rf build", signal?: AbortSignal) =>
    executor.execute(
      { id: createToolCallId("guarded"), name: "Bash", input: { command } },
      { signal },
    );
  return {
    setCwd: (next: string) => {
      cwd = next;
    },
    setMode: (next: CollaborationMode) => {
      mode = next;
    },
    executor,
    execute,
    handler,
    hooks,
    broker,
    requests,
    events,
    shell,
    logger,
    saveProjectPermission,
    ...(doomLoop === undefined ? {} : { doomLoop }),
  };
}

describe("Guarded executor authorization boundary", () => {
  describe.each([
    ["posix", "rm -r tree", "remove-critical-path"],
    ["git-bash", "rm first second", "remove-critical-path"],
    ["cmd", "rd /S tree", "cmd-remove-tree"],
    ["cmd", "erase /P file", "cmd-delete-files"],
    ["posix", "find . -type f -delete", "find-delete"],
    ["posix", "find -d . -type f -delete", "find-delete"],
    ["posix", "find -x . -type f -delete", "find-delete"],
    ["posix", "git clean -f", "git-clean-force"],
    ["git-bash", "robocopy src dst /MIR", "robocopy-delete"],
    ["posix", "rm first --help", "remove-critical-path"],
    ["cmd", "rd target/s/q", "cmd-remove-tree"],
    ["cmd", "rd/s/q target", "cmd-remove-tree"],
    ["cmd", "del/q target\\one.txt", "cmd-delete-files"],
    ["git-bash", "env MSYS2_ARG_CONV_EXCL=/MIR robocopy /c/src /c/dst /MIR", "robocopy-delete"],
  ] as const)("deletion lifecycle: %s / %s", (dialect, command, rule) => {
    it.each([
      ["guarded", "deny", false, 1],
      ["guarded", "allow", true, 1],
      ["yolo", "deny", true, 0],
    ] as const)("%s / %s", async (mode, decision, success, requests) => {
      const h = harness({ mode });
      h.shell.dialect = dialect;
      const pending = h.execute(command);
      if (requests) {
        await vi.waitFor(() => expect(h.broker.listPendingRequests()).toHaveLength(1));
        expect(h.handler).not.toHaveBeenCalled();
        expect(h.broker.resolvePermission(h.requests[0]!.requestId, {
          decision, reason: "Keep deletion fixture",
        })).toBe(true);
      }
      const result = await pending;
      expect(result.success).toBe(success);
      expect(h.requests).toHaveLength(requests);
      if (requests) {
        expect(h.requests[0]).toMatchObject({
          approvalMode: "user-once", ruleId: `safety.bash.${rule}`, input: { command },
        });
        expect(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" })).toBe(false);
      }
      expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
      if (success) {
        expect(h.handler.mock.calls[0]?.[0]).toEqual({ command });
        expect(result.output).toMatchObject({ stdout: "controlled handler result" });
      } else expect(result.error?.message).toContain("Keep deletion fixture");
      expect(h.hooks).toHaveBeenCalled(); // PreToolUse allow 不能替代用户批准。
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
      expect(h.broker.listPendingRequests()).toEqual([]);
    });

    it("cancellation keeps files unexecuted and clears the real broker", async () => {
      const h = harness();
      h.shell.dialect = dialect;
      const controller = new AbortController();
      const result = h.execute(command, controller.signal);
      await vi.waitFor(() => expect(h.broker.listPendingRequests()).toHaveLength(1));
      controller.abort();
      expect((await result).success).toBe(false);
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
      expect(h.broker.listPendingRequests()).toEqual([]);
    });
  });

  it.each([
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const)("glob force refspec: %s / %s", async (mode, decision, success, requests) => {
    const h = harness({ mode, answer: async () => ({ decision }) });
    const command = "git push origin +refs/heads/*:refs/heads/*";
    const result = await h.execute(command);
    expect(result.success).toBe(success);
    expect(h.requests).toHaveLength(requests);
    if (requests) {
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        ruleId: "safety.bash.git-push-force",
        input: { command },
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
    if (success) expect(h.handler.mock.calls[0]?.[0]).toEqual({ command });
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });

  it("单次确认不会被工具预览的 proceed 放行", async () => {
    const prepareApproval = vi.fn(() => ({ gate: "proceed" as const }));
    const h = harness({ prepareApproval, answer: async () => ({ decision: "deny" }) });
    expect((await h.execute()).success).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(prepareApproval).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each([
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const)("CMD REM-named redirection: %s / %s", async (mode, decision, success, requests) => {
    const h = harness({ mode, answer: async () => ({ decision }) });
    h.shell.dialect = "cmd";
    const command = ">rem git reset --hard";
    const result = await h.execute(command);
    expect(result.success).toBe(success);
    expect(h.requests).toHaveLength(requests);
    if (requests) {
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        ruleId: "safety.bash.git-reset-hard",
        input: { command },
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });

  it.each([
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const)("rm trailing help/version: %s / %s", async (mode, decision, success, requests) => {
    const h = harness({ mode, answer: async () => ({ decision, reason: "Keep fixture files" }) });
    const command = "rm -rf target --help --version";
    const result = await h.execute(command);
    expect(result.success).toBe(success);
    expect(h.requests).toHaveLength(requests);
    if (requests) {
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        ruleId: "safety.bash.remove-critical-path",
        input: { command },
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
    if (!success) expect(result.error?.message).toContain("Keep fixture files");
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });

  it.each([false, true])(
    "cancels while registration is pending (deferred=%s) without late publication",
    async (deferredRegistration) => {
      const registered = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const deferredBroker = createManualPermissionBroker();
      const h = harness({
        deferredBroker: {
          requestPermission(request, options) {
            entered.resolve();
            const response = deferredRegistration
              ? registered.promise.then(() => deferredBroker.requestPermission(request, options))
              : deferredBroker.requestPermission(request, options);
            return Object.assign(response, {
              registered: registered.promise,
            });
          },
        },
      });
      const controller = new AbortController();
      let result: Awaited<ReturnType<typeof h.execute>> | undefined;
      const pending = h.execute(undefined, controller.signal).then((value) => {
        result = value;
      });
      await entered.promise;
      controller.abort();
      try {
        await vi.waitFor(() => expect(result?.error?.type).toBe(CoreErrorType.ToolCancelled));
      } finally {
        registered.resolve();
        await pending;
      }
      // 取消发生在确认窗登记完成之前：PermissionRequested 从未发布，就不能再补一条
      // 没有前驱的 PermissionResolved（孤立终态会污染投影）。事件对必须是 0/0。
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionRequested),
      ).toHaveLength(0);
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(0);
      expect(deferredBroker.listPendingRequests()).toEqual([]);
      expect(h.handler).not.toHaveBeenCalled();
    },
  );
  it("ordinary project reapproval also closes the previous request before creating a new id", async () => {
    const h = harness({
      mode: "build",
      permissionHookInput: { command: "git reset --hard" },
      projectRules: { ask: [{ toolName: "Bash" }] },
    });
    const controller = new AbortController();
    const pending = h.execute("echo original", controller.signal);
    try {
      await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      const [old, current] = h.requests;
      expect(current!.requestId).not.toBe(old!.requestId);
      expect(h.broker.resolvePermission(old!.requestId, { decision: "allow" })).toBe(false);
      h.broker.resolvePermission(current!.requestId, { decision: "allow" });
      expect((await pending).success).toBe(true);
      expect(h.handler).toHaveBeenCalledTimes(1);
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(2);
    } finally {
      controller.abort();
      await pending;
    }
  });
  // 2026-09-17 review：重判不能退回只含 runtimeScope/cwd 的缩减上下文，否则 guarded matcher 在该路径静默失效。
  it("hook rewrite recheck receives the same prepared context as the first decision", async () => {
    const contexts: unknown[] = [];
    const h = harness({
      mode: "build",
      permissionHookInput: { command: "git reset --hard" },
      projectRules: { ask: [{ toolName: "Bash" }] },
      resolvePermissionCapability: (input, context) => {
        contexts.push(context);
        return bashToolEntry.resolvePermissionCapability?.(input, context);
      },
    });
    const controller = new AbortController();
    const pending = h.execute("echo original", controller.signal);
    try {
      await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      for (const context of contexts) {
        expect(context).toMatchObject({
          mode: "build",
          bashShellSelection: h.shell,
          workingDirectory: "/workspace/original",
        });
      }
    } finally {
      controller.abort();
      await pending;
    }
  });
  it("replaces a hook-approved edited input with a fresh user-only request", async () => {
    const h = harness({ permissionHookInput: { command: "rm -rf replacement" } });
    const pending = h.execute("echo harmless");
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const [original, guarded] = h.requests;
    expect(original?.approvalMode).toBeUndefined();
    expect(guarded).toMatchObject({
      approvalMode: "user-once",
      input: { command: "rm -rf replacement" },
    });
    expect(guarded?.requestId).not.toBe(original?.requestId);
    // N4：改写重入必须留痕，且日志里的两条 requestId 与真实请求一一对应。
    expect(h.logger.debug).toHaveBeenCalledWith(
      "Permission hook rewrote the input; asking again",
      expect.objectContaining({
        event: "tool.permission.reentry",
        newRequestId: guarded?.requestId,
        requestId: original?.requestId,
        status: "waiting",
        toolName: "Bash",
      }),
    );
    // SA-A4：重问轮的「始终允许」建议必须按改写后的输入重算；沿用入口按
    // "echo harmless" 算出的那份等于把另一条命令写进项目规则（单次确认这条路径
    // 只断言建议值，落盘断言走下面 build 模式的用例——user-once 会拒绝任何规则）。
    expect(guarded?.suggestedPermissionUpdates).toEqual([
      {
        behavior: "allow",
        rules: [{ ruleContent: "rm -rf replacement", toolName: "Bash" }],
        type: "addRules",
      },
    ]);
    expect(h.broker.resolvePermission(original!.requestId, { decision: "allow" })).toBe(false);
    expect(h.broker.listPendingRequests()).toHaveLength(1);
    expect(h.handler).not.toHaveBeenCalled();
    h.broker.resolvePermission(guarded!.requestId, { decision: "deny" });
    expect((await pending).success).toBe(false);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });
  // SA-C6：hook 每轮都改写出一份不同输入。重问轮必须 skipHooks（hook 上一轮已经表过态），
  // 否则 A→B→C… 每一轮都能产出「新改写」，确认窗永远轮不完。请求数恒为 2 是收敛证据。
  it("asks again at most once even when the hook keeps rewriting the input", async () => {
    const h = harness({
      mode: "build",
      projectRules: { ask: [{ toolName: "Bash" }] },
      permissionHookInputs: [
        { command: "git reset --hard" },
        { command: "rm -rf build" },
      ],
      answer: async () => ({ decision: "deny", reason: "Stop the rewrite loop" }),
    });
    const result = await h.execute("npm run build");
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.input).toEqual({ command: "git reset --hard" });
    // skipHooks 的第二轮不再问 hook：只发生了一次 PermissionRequest 询问。
    expect(
      h.hooks.mock.calls.filter(
        ([input]) => (input as { hookEventName?: string }).hookEventName === "PermissionRequest",
      ),
    ).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });
  // N4：hook「改了个寂寞」（改写结果等于当前输入）时不再重问，但必须留一条日志——
  // 这条分支没有事件可发，静默会让排查确认窗为何没重问无从下手。
  it("ignores a hook rewrite that equals the current input and logs it", async () => {
    const h = harness({
      mode: "build",
      projectRules: { ask: [{ toolName: "Bash" }] },
      permissionHookInputs: [{ command: "npm test" }],
      answer: async () => ({ decision: "deny", reason: "Single ask" }),
    });
    const result = await h.execute("npm test");
    expect(result.success).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.logger.debug).toHaveBeenCalledWith(
      "Permission hook rewrote the input to the current input; ignoring",
      expect.objectContaining({
        event: "tool.permission.hook_rewrite_ignored",
        requestId: h.requests[0]?.requestId,
        status: "waiting",
        toolName: "Bash",
      }),
    );
    expect(h.handler).not.toHaveBeenCalled();
  });
  // fullAccessSupported（Full access 是合法选项），user-once ask 一旦带上它，用户点了
  // 「始终允许」就会拿到 InvalidInput——请求上标的 approvalMode 必须同步进事件。
  it("publishes fullAccessSupported only for non-single-use permission asks", async () => {
    const h = harness({ permissionHookInput: { command: "rm -rf replacement" } });
    const pending = h.execute("echo harmless");
    await vi.waitFor(() =>
      expect(h.events.filter((event) => event.type === SessionEventType.PermissionRequested)).toHaveLength(2),
    );
    const payloads = h.events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload);
    // 改写前的普通 ask：不带 approvalMode，支持 Full access。
    expect(payloads[0]?.approvalMode).toBeUndefined();
    expect(payloads[0]).toMatchObject({ fullAccessSupported: true });
    // 改写后的 user-once ask：带 approvalMode，且绝不能投放 Full access。
    expect(payloads[1]).toMatchObject({ approvalMode: "user-once" });
    expect(payloads[1]).not.toHaveProperty("fullAccessSupported");
    h.broker.resolvePermission(h.requests[1]!.requestId, { decision: "deny" });
    expect((await pending).success).toBe(false);
  });
  // SA-B1：hook 改写后的输入被项目 deny 规则命中时必须 fail-closed。旧实现把 deny 与 ask
  // 一起当成「需要重问」，返回 rewriteInput 让用户「允许一次」执行被 deny 的输入。
  it("fails closed when a permission-hook rewrite is denied by project rules", async () => {
    const h = harness({
      mode: "build",
      // 必须带 ruleContent：evaluateBashRules 对无 ruleContent 的规则直接判命中，
      // 原始安全命令会一开始就被 deny（broker 请求数 0），测不到改写后的重判。
      projectRules: { deny: [{ toolName: "Bash", ruleContent: "git push:*" }] },
      permissionHookInput: { command: "git push origin main" },
    });
    const result = await h.execute("npm run build");
    expect(h.requests).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.PermissionDenied);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });
  // SA-A4：hook 改写后点「始终允许」，落盘的规则必须匹配改写后的命令；按改写前的
  // 安全命令算出来的建议会把一条根本没被批准过的命令永久写进项目规则。
  it("persists the rewritten command when a rewritten ask is always-allowed", async () => {
    const h = harness({
      mode: "build",
      projectRules: { ask: [{ toolName: "Bash" }] },
      permissionHookInput: { command: "rm -rf build" },
    });
    const pending = h.execute("echo original");
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const rewritten = h.requests[1]!;
    expect(rewritten.suggestedPermissionUpdates).toEqual([
      {
        behavior: "allow",
        rules: [{ ruleContent: "rm -rf build", toolName: "Bash" }],
        type: "addRules",
      },
    ]);
    h.broker.resolvePermission(rewritten.requestId, {
      decision: "allow",
      permissionUpdates: rewritten.suggestedPermissionUpdates,
    });
    expect((await pending).success).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[0]).toEqual({ command: "rm -rf build" });
    expect(h.saveProjectPermission).toHaveBeenCalledTimes(1);
    expect(h.saveProjectPermission.mock.calls[0]?.[0]).toMatchObject({
      permission: { allow: [{ ruleContent: "rm -rf build", toolName: "Bash" }] },
      projectID: "guarded-project",
    });
    expect(JSON.stringify(h.saveProjectPermission.mock.calls[0]?.[0])).not.toContain("echo original");
  });
  // SA-D3：doom ask 只是把结论改成「再问一次」，不能顺手丢掉 guarded 已算好的
  // 单次确认与更严的风险等级。旧实现整体覆盖成 doom 自报的 medium，第 4 次危险命令
  // 于是可被 PreToolUse/PermissionRequest hook 代答，也能被写成项目规则。
  it("keeps single-use approval and the stricter risk level on a doom-loop ask", async () => {
    const h = harness({ doomLoopCheck: "ask" });
    const command = "rm -rf build";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pending = h.execute(command);
      await vi.waitFor(() => expect(h.requests).toHaveLength(attempt + 1));
      const request = h.requests[attempt]!;
      expect(request.approvalMode).toBe("user-once");
      if (attempt === 3) {
        expect(request).toMatchObject({ riskLevel: "high", ruleId: "doom_loop" });
        // 合并后仍是 user-once：文案不能承诺「本会话总是允许」。
        expect(request.reason).toContain("Allow once or deny");
      } else {
        expect(request.ruleId).toBe("safety.bash.remove-critical-path");
      }
      h.broker.resolvePermission(request.requestId, { decision: "deny" });
      expect((await pending).success).toBe(false);
    }
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });
  // N1：doom ask 的「本会话总是允许」入参是 PermissionUpdate[]（只有 type/behavior/rules），
  // 按旧字段（ruleId/decision/effect）判定谓词恒 false，整条会话豁免是死代码。
  // 用非 user-once 的 doom ask（build 模式）构造：第 4 次批准后第 5 次不得再弹窗。
  it("exempts a tool for the session after a doom-loop ask grants session rules", async () => {
    const h = harness({
      mode: "build",
      projectRules: { ask: [{ toolName: "Bash" }] },
      doomLoopCheck: "ask",
      // PermissionRequest hook 退赛：这条用例要验证的是 broker 带回的会话级规则，
      // hook 的 allow 先胜出就会绕过那次应答。
      permissionHookForfeits: true,
    });
    const command = "echo loop-safe";
    // 前 3 次：项目 ask 被 PreToolUse hook 的整体 allow 放行（本用例只验证 doom 门）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await h.execute(command)).success).toBe(true);
    }
    expect(h.requests).toEqual([]);
    expect(h.handler).toHaveBeenCalledTimes(3);

    const doomAsk = h.execute(command);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    // 非 user-once 的 doom ask 才适用会话级豁免。
    expect(h.requests[0]).toMatchObject({ ruleId: "doom_loop" });
    expect(h.requests[0]?.approvalMode).toBeUndefined();
    h.broker.resolvePermission(h.requests[0]!.requestId, {
      decision: "allow",
      sessionPermissionUpdates: [
        { behavior: "allow", rules: [{ toolName: "Bash" }], type: "addRules" },
      ],
    });
    expect((await doomAsk).success).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(4);

    // 第 5 次：exemptTools 命中，doom 门不再问；handler 直接执行。
    expect((await h.execute(command)).success).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.doomLoop?.exemptTools.has("Bash")).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(5);
  });
  // N1 反面：user-once 的 doom ask 只提供「允许一次 / 拒绝」。应答夹带会话级规则是
  // 非法形状（permission-response.ts 的 once 校验），必须硬失败，不能悄悄豁免整个会话。
  it("rejects session updates on a single-use doom-loop ask", async () => {
    const h = harness({ doomLoopCheck: "ask" });
    const command = "rm -rf build";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = h.execute(command);
      await vi.waitFor(() => expect(h.requests).toHaveLength(attempt + 1));
      h.broker.resolvePermission(h.requests[attempt]!.requestId, { decision: "allow" });
      expect((await pending).success).toBe(true);
    }
    const doomAsk = h.execute(command);
    await vi.waitFor(() => expect(h.requests).toHaveLength(4));
    expect(h.requests[3]).toMatchObject({ approvalMode: "user-once", ruleId: "doom_loop" });
    h.broker.resolvePermission(h.requests[3]!.requestId, {
      decision: "allow",
      sessionPermissionUpdates: [
        { behavior: "allow", rules: [{ toolName: "Bash" }], type: "addRules" },
      ],
    });
    const result = await doomAsk;
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.InvalidInput);
    expect(h.handler).toHaveBeenCalledTimes(3);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  // SA-B14 反面：闸门的判据是语义（user-once），不是「当前是不是 guarded」。生产目前只在
  // guarded 产出 user-once 决策，但任何非 guarded 路径产出它时都必须过同一道单次确认校验。
  it("rejects project rules for a single-use ask outside guarded mode", async () => {
    // 用真实 PermissionService 判定、只给结论补上 approvalMode：构造生产暂不存在的组合。
    const service = new PermissionService();
    const check = service.checkPermission.bind(service);
    service.checkPermission = ((context, capability, rules, policy) => ({
      ...check(context, capability, rules, policy),
      approvalMode: "user-once" as const,
    })) as PermissionService["checkPermission"];
    const h = harness({
      mode: "build",
      permissionService: service,
      permissionHookForfeits: true,
      projectRules: { ask: [{ toolName: "Bash" }] },
      answer: async () => ({
        decision: "allow",
        permissionUpdates: [
          { behavior: "allow", rules: [{ ruleContent: "npm test", toolName: "Bash" }], type: "addRules" },
        ],
      }),
    });
    const result = await h.execute("npm test");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.approvalMode).toBe("user-once");
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.InvalidInput);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  // N3（core 侧）：工具级声明 allowAlways:false 时，判定侧并没有 optionsPolicy（生产只有
  // Plan-MCP 一处赋值），闸门必须取「合并后的更严者」，否则 TUI 仍能把规则永久写进项目。
  it("rejects project rules when the tool declares no-always-allow", async () => {
    const h = harness({
      mode: "build",
      permissionHookForfeits: true,
      toolPermission: {
        ...bashToolEntry.permission!,
        alwaysAsk: true,
        askOptions: { allowAlways: false },
      },
      answer: async () => ({
        decision: "allow",
        permissionUpdates: [
          { behavior: "allow", rules: [{ ruleContent: "npm test", toolName: "Bash" }], type: "addRules" },
        ],
      }),
    });
    const result = await h.execute("npm test");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      optionsPolicy: "no-always-allow",
      ruleId: "tool.alwaysAsk",
    });
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.InvalidInput);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  // N4：evaluated 日志必须能回答「为什么这次没有始终允许」——记下判定侧的 optionsPolicy
  // （Plan 下的 MCP ask 是生产里唯一的 optionsPolicy 来源）。
  it("logs the evaluated options policy for a plan-mode MCP ask", async () => {
    const planMcp = harness({
      mode: "plan",
      planEnabled: true,
      permissionHookForfeits: true,
      preToolHookForfeits: true,
      toolPermission: { ...bashToolEntry.permission!, permission: "mcp" },
      answer: async () => ({ decision: "deny" }),
    });
    expect((await planMcp.execute("npm test")).success).toBe(false);
    expect(planMcp.requests).toHaveLength(1);
    expect(planMcp.requests[0]).toMatchObject({
      optionsPolicy: "no-always-allow",
      ruleId: "mode.plan.mcp",
    });
    expect(planMcp.logger.debug).toHaveBeenCalledWith(
      "Tool permission evaluated",
      expect.objectContaining({
        decision: "ask",
        event: "tool.permission.evaluated",
        optionsPolicy: "no-always-allow",
      }),
    );
  });
  // SA-B5：hook 改写会先合成一条 PermissionResolved(deny) 收口工具行，随后才发起重问。
  // 第二个 PermissionRequested 必须把同一工具行复位成 pending（ToolCallStatus 没有
  // waiting），否则确认窗还在、工具行却显示已拒绝。
  it("resets the projected tool row to pending when a rewrite asks again", async () => {
    const h = harness({ permissionHookInput: { command: "rm -rf replacement" } });
    const toolCallId = createToolCallId("guarded");
    const pending = h.execute("echo harmless");
    await vi.waitFor(() =>
      expect(h.events.filter((event) => event.type === SessionEventType.PermissionRequested)).toHaveLength(2),
    );
    // executor 在权限通过之后才发 ToolCallStarted；投影需要先有一行在飞工具，
    // 用 runtime 排期时同一条真实事件（ToolCallScheduled）补上，再喂给 contracts 的 reducer。
    const projection = reduce([
      createSessionEvent(SessionEventType.ToolCallScheduled, createSessionId("guarded"), {
        input: { command: "echo harmless" },
        schedule: { executionOrder: [toolCallId], parallelGroups: [[toolCallId]] },
        toolCallId,
        toolName: "Bash",
      }),
      ...h.events,
    ]);
    expect(projection.activeToolCalls[0]).toMatchObject({ status: "pending", toolCallId });
    h.broker.resolvePermission(h.requests[1]!.requestId, { decision: "deny" });
    expect((await pending).success).toBe(false);
  });
  it("reclassifies a PreToolUse edit before approval even with project allow", async () => {
    const h = harness({
      hookInput: { command: "rm -rf replacement" },
      answer: async () => ({ decision: "deny" }),
    });
    expect((await h.execute("echo harmless")).success).toBe(false);
    expect(h.requests[0]?.input).toEqual({ command: "rm -rf replacement" });
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it("does not let PreToolUse/PermissionRequest auto-allow a dangerous request", async () => {
    const h = harness();
    const pending = h.execute();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.requests[0]).toMatchObject({
      approvalMode: "user-once",
      ruleId: "safety.bash.remove-critical-path",
    });
    // SA-B2：事件载荷要与 broker 请求一致地标成 user-once，且不能投放 Full access。
    const payload = h.events.find(
      (event) => event.type === SessionEventType.PermissionRequested,
    )?.payload as PermissionRequestedPayload | undefined;
    expect(payload).toMatchObject({ approvalMode: "user-once" });
    expect(payload).not.toHaveProperty("fullAccessSupported");
    // N4：evaluated 日志要记下判定侧的 approvalMode，否则「为什么这次没有始终允许」
    // 只能靠 ruleId 猜。
    expect(h.logger.debug).toHaveBeenCalledWith(
      "Tool permission evaluated",
      expect.objectContaining({
        approvalMode: "user-once",
        decision: "ask",
        event: "tool.permission.evaluated",
        status: "waiting",
        toolName: "Bash",
      }),
    );
    expect(
      h.hooks.mock.calls.some(
        ([input]) => (input as { hookEventName?: string }).hookEventName === "PermissionRequest",
      ),
    ).toBe(false);
    h.broker.resolvePermission(h.requests[0]!.requestId, {
      decision: "deny",
      reason: "Keep my files",
    });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Keep my files");
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it("reuses the session shell selection and executes with the approved cwd exactly once", async () => {
    const h = harness();
    const pending = h.execute();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.setCwd("/workspace/changed");
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" });
    expect((await pending).success).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[1].bashShellSelection).toBe(h.shell);
    expect(h.handler.mock.calls[0]?.[1]).toMatchObject({
      bashShellSelection: { dialect: "posix" },
      workingDirectory: "/workspace/original",
    });
    expect(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" })).toBe(false);
  });
  // SA-B12：只声明静态 bashShellSelection（不传 getter）的 createToolExecutor 用法必须同样
  // 生效。旧判权只读 getter，退回 GUARDED_DEFAULT_DIALECT="posix"，Windows 的 `rd /S /Q`
  // 匹配不到 cmd-remove-tree，危险删除在 guarded 下被直接放行（不弹单次确认）。
  it("falls back to the static bash shell selection for guarded danger matching", async () => {
    const h = harness({ staticShellSelection: true });
    h.shell.dialect = "cmd";
    const command = "rd /S /Q target";
    const pending = h.execute(command);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0]).toMatchObject({
      approvalMode: "user-once",
      ruleId: "safety.bash.cmd-remove-tree",
      input: { command },
    });
    expect(h.handler).not.toHaveBeenCalled();
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "deny" });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it.each(["allow", "modify"] as const)(
    "executes a broker-approved dangerous edit once without reapproval: %s",
    async (decision) => {
      const modifiedInput = { command: "git reset --hard" };
      let responses = 0;
      const h = harness({
        answer: async () => {
          // 回归时有界失败，不让重复审批挂住测试或不断请求相同输入。
          if (++responses > 1) return { decision: "deny", reason: "Unexpected reapproval" };
          h.setMode("yolo");
          h.setCwd("/workspace/changed");
          return { decision, modifiedInput };
        },
      });
      expect((await h.execute()).success).toBe(true);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]?.mode).toBe("guarded");
      expect(h.handler).toHaveBeenCalledTimes(1);
      expect(h.handler.mock.calls[0]?.[0]).toEqual(modifiedInput);
      expect(h.handler.mock.calls[0]?.[0]).not.toBe(modifiedInput);
      expect(Object.isFrozen(h.handler.mock.calls[0]?.[0])).toBe(true);
      expect(h.handler.mock.calls[0]?.[1].bashShellSelection).toBe(h.shell);
      expect(h.handler.mock.calls[0]?.[1]).toMatchObject({
        bashShellSelection: { dialect: "posix" },
        workingDirectory: "/workspace/original",
      });
      expect(h.events.filter((e) => e.type === SessionEventType.PermissionResolved)).toHaveLength(
        1,
      );
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      decision: "allow",
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    },
    { decision: "invalid" },
    { decision: "allow", permissionUpdates: {} },
    {
      decision: "allow",
      sessionPermissionUpdates: [
        { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
      ],
    },
    { decision: "allow", reason: {} },
    { decision: "modify", modifiedInput: { command: 42 } },
    { decision: "allow", modifiedInput: { command: 42 } },
    {
      decision: "modify",
      modifiedInput: { command: "git reset --hard" },
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    },
  ])("rejects illegal/invalid/persistent responses without executing", async (answer) => {
    const h = harness({ answer: async () => answer as PermissionBrokerResult });
    expect((await h.execute()).success).toBe(false);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it("times out and removes the pending request without executing or storing rules", async () => {
    const h = harness({ timeoutMs: 10 });
    expect((await h.execute()).error?.type).toBe(CoreErrorType.PermissionTimeout);
    expect(h.requests).toHaveLength(1);
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" })).toBe(false);
  });
  it("cleans pending on cancellation", async () => {
    const h = harness();
    const abort = new AbortController();
    const pending = h.execute(undefined, abort.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    abort.abort();
    expect((await pending).error?.type).toBe(CoreErrorType.ToolCancelled);
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("mode switching does not settle an existing request", async () => {
    const h = harness();
    const pending = h.execute();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.setMode("yolo");
    expect(h.handler).not.toHaveBeenCalled();
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "deny" });
    expect((await pending).success).toBe(false);
    expect((await h.execute()).success).toBe(true);
    expect(h.requests).toHaveLength(1);
  });
  it("fails without an interactive broker", async () => {
    const h = harness({ noBroker: true });
    expect((await h.execute()).error?.type).toBe(CoreErrorType.ConfigurationError);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("original YOLO executes the same command with no new approval", async () => {
    const h = harness({ mode: "yolo" });
    expect((await h.execute()).success).toBe(true);
    expect(h.requests).toEqual([]);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[1].bashShellSelection).toBe(h.shell);
  });
  it("registers the broker before publishing a request that can be answered immediately", async () => {
    let delivered = false;
    const h = harness({
      timeoutMs: 30,
      onPublished: (id, broker) => {
        delivered = broker.resolvePermission(id, { decision: "allow" });
      },
    });
    expect((await h.execute()).success).toBe(true);
    expect(delivered).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e.type === SessionEventType.PermissionResolved)).toHaveLength(1);
  });
  it.each([
    ["guarded", "hook"],
    ["guarded", "broker"],
    ["guarded", "permission-hook"],
    ["build", "hook"],
    ["build", "permission-hook"],
    ["yolo", "hook"],
    ["yolo", "permission-hook"],
  ] as const)("keeps semantic preflight before hooks only: %s / %s", async (mode, source) => {
    const modified = { command: "echo rewritten-input" };
    const validateInput = vi.fn((input: unknown) =>
      (input as { command: string }).command === modified.command
        ? { result: false, errorCode: 123, message: "Rejected by tool semantics" }
        : undefined,
    );
    const h = harness({
      mode,
      ...(source === "hook" ? { hookInput: modified } : {}),
      ...(source === "permission-hook" ? { permissionHookInput: modified } : {}),
      ...(source === "broker"
        ? { answer: async () => ({ decision: "modify" as const, modifiedInput: modified }) }
        : {}),
      validateInput,
    });
    const command = source === "broker" ? "rm -rf build" : "echo original-input";
    const result = await h.execute(command);
    expect(result.success).toBe(true);
    expect(validateInput).toHaveBeenCalledTimes(1);
    expect(validateInput.mock.calls[0]?.[0]).toEqual({ command });
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[0]).toEqual(modified);
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it.each(["guarded", "build", "yolo"] as const)(
    "still rejects initial semantic failures before hooks in %s",
    async (mode) => {
      const validateInput = vi.fn(() => ({
        result: false,
        errorCode: 123,
        message: "Rejected by initial tool semantics",
      }));
      const h = harness({ mode, validateInput });
      const result = await h.execute();
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Rejected by initial tool semantics");
      expect(validateInput).toHaveBeenCalledTimes(1);
      expect(h.hooks).not.toHaveBeenCalled();
      expect(h.requests).toEqual([]);
      expect(h.handler).not.toHaveBeenCalled();
    },
  );
  it.each(["hook", "broker", "permission-hook"] as const)(
    "still rejects schema-invalid input rewritten by %s",
    async (source) => {
      const modified = { timeout: 1000 };
      const h = harness({
        ...(source === "hook" ? { hookInput: modified } : {}),
        ...(source === "permission-hook" ? { permissionHookInput: modified } : {}),
        ...(source === "broker"
          ? { answer: async () => ({ decision: "modify" as const, modifiedInput: modified }) }
          : {}),
      });
      const result = await h.execute(source === "broker" ? "rm -rf build" : "echo original-input");
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("inputSchema validation");
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.broker.listPendingRequests()).toEqual([]);
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
    },
  );
  it("preserves infrastructure errors without describing them as user denial", async () => {
    const h = harness({
      answer: async () => {
        throw new Error("transport unavailable");
      },
    });
    const result = await h.execute();
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    // N4：broker 故障必须与「用户拒绝」在日志里可区分。
    expect(h.logger.warn).toHaveBeenCalledWith(
      "Permission request failed",
      expect.objectContaining({
        errorMessage: "Permission request failed",
        event: "tool.permission.request_failed",
        requestId: h.requests[0]?.requestId,
        status: "failed",
        toolName: "Bash",
      }),
    );
    expect(h.handler).not.toHaveBeenCalled();
  });
});
