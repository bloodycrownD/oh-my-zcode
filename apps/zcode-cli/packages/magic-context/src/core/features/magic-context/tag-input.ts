/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/features/magic-context/
 * tag-input.ts`（16 行）。唯一改动：文档注释里的 `/**` 注释块保留，无逻辑改动。
 *
 * 16 行纯函数，`ctx-expand` 的 mode 解析与 `ctx_reduce` 共用；放在源路径下以便
 * 上游 import 逐字成立。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

export const TAG_INPUT_ERROR =
    'Error: tag must be one positive integer: 12, "12", "§12§", "§12", "tag 12", or "[dropped §12§]" (surrounding whitespace is allowed).';

/** Normalize copied transcript handles without accepting embedded or multiple numbers. */
export function parseTagInput(value: unknown): number {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === "string") {
        const text = value.trim();
        const match = /^(?:([0-9]+)|§([0-9]+)§?|tag\s+([0-9]+)|\[dropped\s+§([0-9]+)§\])$/.exec(
            text,
        );
        const number = match ? Number(match.slice(1).find((part) => part !== undefined)) : NaN;
        if (Number.isSafeInteger(number) && number > 0) return number;
    }
    throw new Error(TAG_INPUT_ERROR);
}