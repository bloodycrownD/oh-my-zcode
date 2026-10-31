import type { RequestVerificationReason } from "@zcode/shared";
import type { ModelRequestAuth } from "@zcode/contracts";
import type { Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * FORK(D-4)：上游 v3.16 新增的「每个模型请求 attempt 前按需刷新 Provider 运行时鉴权头」
 * 整条链路依赖官方账号面（`ZCodeProviderAccountAccess` 与 `AgentRuntimeInternal.providerRuntimeHeadersPort`），
 * 而 fork 已把账号面整体移除，runtime 上也不存在该端口。
 *
 * 这里保留同名函数与原签名（3 个调用方 sample-model / project-memory-recall / child-client-ports 测试
 * 都不必改动），恒返回 `undefined`，语义即「没有需要刷新的运行时头」——与账号面删除前的
 * 「端口缺席则跳过」分支完全一致。
 */
export function createRefreshRuntimeHeadersBeforeModelAttempt(
  _runtime: AgentRuntimeInternal,
  _input: {
    abortSignal?: AbortSignal;
    model: Model;
    traceContext: TraceContext;
  },
):
  | ((attemptInput: {
      accountAccess?: unknown;
      expectedAccountScope?: string;
      rejectedProjectTokenFingerprint?: string;
      attempt: number;
      reason?: RequestVerificationReason;
      abortSignal?: AbortSignal;
    }) => Promise<{
      headersApplied: boolean;
      requestAuth?: ModelRequestAuth;
    }>)
  | undefined {
  return undefined;
}
