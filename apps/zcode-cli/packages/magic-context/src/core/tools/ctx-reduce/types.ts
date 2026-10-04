/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-reduce/types.ts`
 * （import 路径加 `.js` 后缀）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args.js";

export interface CtxReduceArgs extends ImitatedReducedArgs {
    drop?: string;
}