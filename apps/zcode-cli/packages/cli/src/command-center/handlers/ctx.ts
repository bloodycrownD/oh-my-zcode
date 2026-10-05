/**
 * `/ctx-*` 本地命令（S22）——magic-context 上下文控制面。
 *
 * ============================================================================
 * 本文件现在是薄壳
 * ============================================================================
 *
 * 核心语义（effective 开关 / 动态 import / harness 归一 / 四个命令的取数 / 参数文法 /
 * `/ctx-status` 排版）全部落在 `@zcode/bootstrap/ctx-commands`，因为同一份语义还有
 * 第二个执行面：桌面 App composer 的 `/ctx-status` 走 v4 命令通道
 * （`bootstrap/src/zcode-protocol-v4/commands/handlers/ctx.ts`）。两边共用一份实现，
 * 才谈得上「同一条命令在两个客户端做同一件事」。
 *
 * 薄壳只负责把 `CommandCenterDeps` 解析成共享实现需要的窄宿主（`CtxCommandHost`），
 * 再把返回的文本包回 `TuiSubmitPromptResult`。**输出逐字不变**——TUI 侧只认
 * `{ mode, response }`，其余全是内部细节。
 *
 * 为什么不直接 `import("@zcode/bootstrap")`：那会把整个 bootstrap 的模块图静态拉进
 * TUI 启动路径，而它今天是被 `bootstrap-loader.ts` 动态 import 刻意延后的。子路径导出
 * （`@zcode/bootstrap/ctx-commands`）让命令面只静态依赖这一小块，`@zcode/magic-context`
 * 在共享实现内部仍然是动态 import——用户显式关掉 magic-context 时，一条 `/ctx-status`
 * 不该把整棵 magic-context 模块图拉进内存。
 */

import {
  runCtxCommand,
  type CtxCommandHost,
  type CtxCommandName,
} from "@zcode/bootstrap/ctx-commands";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps } from "../types.js";

/** 四个命令的机器可读名。`slash-commands.ts` 的解析结果直接带这个名。 */
export type { CtxCommandName };

// 纯函数与参数解析器随核心实现一起下沉；这里原样再导出，让既有断言
// （`scripts/test-ctx-commands.mjs` 直接引 CLI 源码）的落点保持不变。
export { formatCtxStatus, parseExpandArgs, parseRecompArgs } from "@zcode/bootstrap/ctx-commands";

/**
 * 把 command-center 的 deps 解析成共享实现的窄宿主。
 *
 * `getApp()` 抛（会话还没就绪）时给 `null`，共享实现按「关」处理回 UNAVAILABLE——
 * 与旧实现里 `resolveSessionId` 失败回同一条文案逐字一致。
 */
async function resolveCtxCommandHost(deps: CommandCenterDeps): Promise<CtxCommandHost | null> {
  try {
    const app = await deps.getApp();
    return {
      // App 侧那一次求值的唯一可信来源；能力缺席按「关」处理。
      isMagicContextEnabled: () => app.isMagicContextEnabled?.() === true,
      sessionId: app.sessionId,
    };
  } catch {
    return null;
  }
}

/** 一条 `/ctx-*`：就地执行、只回文本，**不**走 submitPrompt。 */
export async function handleCtxCommand(
  name: CtxCommandName,
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const host = await resolveCtxCommandHost(deps);
  return { mode: deps.getMode?.(), response: await runCtxCommand(name, args, host) };
}
