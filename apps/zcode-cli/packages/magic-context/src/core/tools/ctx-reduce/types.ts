/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-reduce/types.ts`
 * （import 路径加 `.js` 后缀）。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args.js";

export interface CtxReduceArgs extends ImitatedReducedArgs {
    drop?: string;
}