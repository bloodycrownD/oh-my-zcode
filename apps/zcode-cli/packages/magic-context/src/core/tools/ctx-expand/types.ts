/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-expand/types.ts`
 * （import 路径加 `.js` 后缀）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args.js";

export interface CtxExpandArgs extends ImitatedReducedArgs {
    tag?: number | string;
    start?: number;
    end?: number;
    /** Verbose range view: each message + tool call shown separately, with ordinals. */
    verbose?: boolean;
    /** Full untruncated recovery of one message (any role) by its ordinal. */
    message?: number;
}