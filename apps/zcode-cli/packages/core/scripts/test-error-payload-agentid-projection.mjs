#!/usr/bin/env node
/**
 * T-RV2（subagent-resume-visibility Step 1 / C2）——`formatContextDetail` 白名单的
 * agentId 条件投影。
 *
 * 背景：C1 让前台失败的 CoreError context 带上 agentId，但 detail（UI hover / 日志面）
 * 由 `formatContextDetail` 的白名单投影铸造；白名单不加 agentId，句柄就只存在于
 * toolHandlerFailure 通道里，UI hover 仍看不到。C2 把 agentId 加进白名单——
 * 但这是**跨工具共用面**，必须是条件投影：context 没有 agentId 时不显示
 * （formatContextPart 对空值返回 undefined，随后被 filter 剔除）。
 *
 * 两条断言各锁一侧：
 *   正向：带 context.agentId 的 wrapper CoreError → `projectExecutionErrorPayload()`
 *     的 detail 含 `agentId=<id>`；
 *   反向：无 agentId 的错误 → detail 不含 agentId 字段（逐字节钉死，证明白名单
 *     投影没有给其它工具凭空添字段）。
 *
 * 运行方式：`npx tsx --test scripts/test-error-payload-agentid-projection.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，裸 node 吃不下去）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约单实例钩子（sub/G-1 同一性断言的地基，同 test-subagent-sync-dispatch.mjs 范式）：
// error-payload.ts 对 @zcode/contracts 只有类型依赖，但 CoreError 的构造必须与本测试
// 共用同一份 createCoreError/isCoreError 实现，钩子把契约 specifier 统一改指源码。
const CONTRACTS_SRC_ROOT = fileURLToPath(new URL("../../contracts/src/", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@zcode/contracts" || specifier.startsWith("@zcode/contracts/")) {
      const relative =
        specifier === "@zcode/contracts"
          ? "index"
          : specifier.slice("@zcode/contracts/".length);
      for (const candidate of [
        `${CONTRACTS_SRC_ROOT}${relative}.ts`,
        `${CONTRACTS_SRC_ROOT}${relative}/index.ts`,
      ]) {
        if (existsSync(candidate)) {
          return { shortCircuit: true, url: pathToFileURL(candidate).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { AgentErrorCode, CoreErrorType, createCoreError } = await import(
  new URL("../../contracts/src/tools/../index.ts", import.meta.url).href
);
const { ErrorPayloadRole, projectExecutionErrorPayload, withErrorPayloadRole } = await import(
  new URL("../src/errors/error-payload.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — T-RV2 formatContextDetail agentId 投影"
      : `TEST FAIL — T-RV2 (exit code ${code})`,
  );
});

const AGENT_ID = "agent_rv2_1";

test("T-RV2a: 带 context.agentId 的 wrapper CoreError detail 含 agentId=<id>", () => {
  // 形状复刻 C1 增强版 CoreError：wrapper role、cause 挂 provider 根因帧。
  const error = createCoreError(CoreErrorType.ToolExecutionFailed, "Explore subagent failed", {
    cause: new Error("provider 500 from upstream"),
    context: withErrorPayloadRole(
      {
        code: AgentErrorCode.CHILD_RUNTIME_FAILED,
        agentId: AGENT_ID,
        agentType: "general-purpose",
        parentToolCallId: "toolu_rv2",
      },
      ErrorPayloadRole.Wrapper,
    ),
    recoverable: true,
  });

  const projected = projectExecutionErrorPayload(error);
  // 正向：白名单投影把句柄带进 detail（UI hover / 日志面）。
  assert.match(projected.detail ?? "", new RegExp(`agentId=${AGENT_ID}`));
  // 附锁投影语义不变：primary frame 仍是 cause 链上的 provider 根因（wrapper 不当选）。
  assert.equal(projected.message, "provider 500 from upstream");
});

test("T-RV2b: 无 agentId 的错误 detail 不多字段（逐字节）", () => {
  const error = createCoreError(CoreErrorType.ToolExecutionFailed, "some tool failed to run", {
    context: {
      code: "some_other_tool_failed",
      toolName: "SomeOtherTool",
    },
    recoverable: true,
  });

  const projected = projectExecutionErrorPayload(error);
  // 反向：白名单是跨工具共用面，没有 agentId 的 context 不能被投影出该字段。
  assert.doesNotMatch(projected.detail ?? "", /agentId=/);
  // detail 只含白名单内的两个键（code/toolName 不在白名单，formatContextPart 不认）。
  assert.equal(projected.detail, "code=some_other_tool_failed");
});
