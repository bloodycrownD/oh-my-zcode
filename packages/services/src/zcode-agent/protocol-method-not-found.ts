/**
 * 旧 CLI 不认识某方法时的唯一判据（JSON-RPC Method not found）。
 *
 * 抽成独立文件的原因：消费方分属不同模块——magic-context 的 RPC 客户端
 * （`magic-context-workspace-methods.ts`）、prompt-language 读侧、以及
 * `zcodeAgentService` 内部的若干降级分支。留在主文件里会让抽出去的方法模块
 * 反向 import 回主文件，形成循环。
 */
export function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}
