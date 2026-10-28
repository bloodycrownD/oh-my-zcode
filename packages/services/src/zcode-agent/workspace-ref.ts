import { resolveWorkspaceKey } from "@zcode/shared";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";

/**
 * 把 services 侧的 workspace target 投影成协议信封的 `workspace` 字段。
 *
 * 抽成独立文件的原因与 `protocol-method-not-found.ts` 同：`zcodeAgentService`
 * 里 44 处调用、以及拆出去的方法模块都要用它，留在主文件会形成环。
 */
export function buildWorkspaceRef(params: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}
