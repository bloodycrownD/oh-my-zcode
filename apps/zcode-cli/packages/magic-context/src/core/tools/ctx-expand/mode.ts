/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-expand/mode.ts`
 * （103 行，import 路径加 `.js` 后缀）。逻辑零改动。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { parseTagInput } from "../../features/magic-context/tag-input.js";

export type CtxExpandOrdinalDomain = "positive" | "non-negative";

export type CtxExpandMode =
    | { kind: "tag"; tag: number }
    | { kind: "message"; message: number }
    | { kind: "range"; start: number; end: number; verbose: boolean }
    | { kind: "error"; message: string };

function isInt(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value);
}

function minOrdinal(domain: CtxExpandOrdinalDomain): number {
    return domain === "non-negative" ? 0 : 1;
}

function messageError(domain: CtxExpandOrdinalDomain): string {
    return domain === "non-negative"
        ? "Error: message must be a non-negative integer."
        : "Error: message must be a positive integer.";
}

function rangeError(domain: CtxExpandOrdinalDomain): string {
    return domain === "non-negative"
        ? "Error: provide either message=<ordinal>, or start and end (non-negative integers, start <= end)."
        : "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
}

export function resolveCtxExpandMode(
    args: {
        tag?: unknown;
        start?: unknown;
        end?: unknown;
        message?: unknown;
        verbose?: unknown;
    },
    domain: CtxExpandOrdinalDomain,
): CtxExpandMode {
    if (
        args.tag !== undefined &&
        args.tag !== null &&
        !(
            (args.tag === 0 || args.tag === "") &&
            (args.message !== undefined || args.start !== undefined)
        )
    ) {
        try {
            const tag = parseTagInput(args.tag);
            if (
                [args.message, args.start, args.end].some(
                    (value) => value !== undefined && value !== null && value !== 0,
                )
            ) {
                return {
                    kind: "error",
                    message: "Error: use tag alone, without message or start/end.",
                };
            }
            return { kind: "tag", tag };
        } catch (error) {
            return { kind: "error", message: (error as Error).message };
        }
    }
    const min = minOrdinal(domain);
    const messagePresent = args.message !== undefined && args.message !== null;
    const message = isInt(args.message) ? args.message : undefined;
    const start = isInt(args.start) ? args.start : undefined;
    const end = isInt(args.end) ? args.end : undefined;
    const messageValid = message !== undefined && message >= min;
    const rangeValid = start !== undefined && end !== undefined && start >= min && end >= start;
    const fillerPair = start === 0 && end === 0;
    const rangeNamed = rangeValid && !fillerPair;

    if (messageValid && !rangeNamed) {
        return { kind: "message", message };
    }
    if (messagePresent && !messageValid && !rangeNamed) {
        return { kind: "error", message: messageError(domain) };
    }
    if (rangeValid) {
        return {
            kind: "range",
            start,
            end,
            verbose: args.verbose === true,
        };
    }
    return { kind: "error", message: rangeError(domain) };
}