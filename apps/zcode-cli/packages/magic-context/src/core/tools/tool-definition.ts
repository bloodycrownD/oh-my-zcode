/**
 * Step 21 — `@opencode-ai/plugin` 的 `tool()` / `ToolDefinition` 运行时值导入剥离后，
 * ctx 工具在本文件声明等价的最小结构。
 *
 * 源（`.reference/.../tools/ctx-reduce/tools.ts:2`）用 OpenCode 插件 SDK 的
 * `tool({ description, args, execute })` 工厂把描述与 zod schema 包成
 * `ToolDefinition`。fork 不依赖 OpenCode 插件 SDK，而 ZCode 侧的工具声明由
 * `@zcode/contracts`（`ctx-context.ts`）与 core 的 `ToolEntry` 拥有，因此包内只需要
 * 「描述 + zod 参数形状 + 一个 `execute(args, ctx) => Promise<string>`」这一层。
 *
 * 语义不变的部分：
 *   - `tool.schema` 是 zod 的再导出——这里直接用 zod（包内已有 `zod@4.6.5`）；
 *   - `execute` 的第二个参数携带调用身份：`sessionID` / `directory` / `callID`
 *     （源同时接受 `callId` 拼写，两者都保留，命令幂等键逐字逻辑依赖这一点）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { z } from "zod";

/** ctx 工具的执行上下文（ZCode 侧由 ToolHandlerContext 投影而来）。 */
export interface CtxToolContext {
    /** 会话 id：`ctx_reduce` / `ctx_expand` 的全部 db 读写都按它分域。 */
    sessionID: string;
    /** 工作目录（源 `toolContext.directory`）。 */
    directory?: string;
    /** 工具调用 id（源同时读 `callID` 与 `callId` 两种拼写）。 */
    callID?: string;
    callId?: string;
}

/** ctx 工具的 zod 参数形状条目。 */
export type CtxToolArgs = Record<string, z.ZodType>;

/**
 * 一个 ctx 工具：描述 + 声明形状（provider 可见的那一半由 contracts 拥有）+ execute。
 * `execute` 永远 resolve 成一段**文本**——ctx 工具不返回结构化对象。
 */
export interface CtxToolDefinition<TArgs> {
    description: string;
    /** 声明用的参数形状（zod）。运行时校验用 `object(args).passthrough()`。 */
    args: CtxToolArgs;
    execute(args: TArgs, context: CtxToolContext): Promise<string>;
}

/**
 * `tool.schema` 的等价物：源是 OpenCode 插件 SDK 对 zod 的再导出，这里就是 zod 本身。
 * 导出成 `toolSchema` 而不是让每个工具直接 `import { z }`，是为了让「剥离点」在代码
 * 里可见——将来若要换成别的校验库，只改这一处。
 */
export const toolSchema = z;