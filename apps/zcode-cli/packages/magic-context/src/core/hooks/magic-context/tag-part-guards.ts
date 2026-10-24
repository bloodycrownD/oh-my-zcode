import { stripTagPrefix } from "./tag-content-primitives.js";

export { stripTagPrefix };

export interface ValidTextPart {
    type: string;
    text: string;
}

export interface ValidToolPart {
    type: string;
    callID: string;
    state: { output: string; input?: Record<string, unknown> };
}

/**
 * A tool part whose result is a **block array** instead of a string.
 *
 * FORK（toolsearch / native tool references）：ZCode 的 host 正投影
 * (`host/types.ts` 的 `toolResultToPart`) 在结果块数组含 `{type:"tool_reference"}`
 * 时保留块数组，不再文本化。这类结果对 Magic Context **整体不透明**：
 *   - 打标侧：`isToolPartWithOutput` 只认字符串，块数组 part 不打 §N§；
 *   - 治理侧：`tool-drop-target.ts` 通过本函数把整条 tool 弧标记为
 *     `toolTargetBypassesContentRewrite`，drop / skeleton / edit_marker 全部
 *     no-op（`canDrop()` 为 false；tool target 不提供 `setContent`）。
 *
 * 为什么必须绕过而不是「度量后 clamp」：`tool_reference` 块没有 text/content
 * 字段，任何字符串化（哪怕只是 `[dropped §N§]`）都等于删除该引用，native
 * ToolSearch 的工具定义随后无法在服务端展开；而这类结果本身很小，MC 没有
 * 必须压缩它的收益。唯一写回点是宿主反投影
 * (`apps/zcode-cli/packages/bootstrap/src/app/magic-context/projection.ts` 的
 * `toolOutputOf` / `toolOutputContentOf`)，它按原序把块数组写回 `role:"tool"` entry。
 *
 * 升级 magic-context 时 rebase：上游若引入结构化 output，必须保留这条
 * 「块数组 = 绕过」不变量，或连同两侧投影一起改成块感知的度量/写回。
 *
 * 范围说明（与 HEAD 对账）：本判定覆盖**所有**块数组（含纯文本块、图片块、
 * Anthropic 形态的 `tool_result.content` 数组），不只是含 `tool_reference` 的数组。
 * 这不是行为扩张——HEAD 的 `isToolPartWithOutput` 只认字符串 `state.output`，块数组
 * 本来就不打标、不进 clamp/drop；本函数只是把「本来就绕过」显式化，让治理侧能判定
 * `canDrop=false`、`measureReclaim` 记零回收，避免账本把没回收的内容记成已回收。
 */
export function hasStructuredToolOutput(part: unknown): boolean {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    if (p.type === "tool") {
        const state = p.state;
        if (state === null || typeof state !== "object") return false;
        return Array.isArray((state as Record<string, unknown>).output);
    }
    if (p.type === "tool_result") return Array.isArray(p.content);
    return false;
}

interface ValidFilePart {
    type: string;
    url: string;
}

export function isTextPart(part: unknown): part is ValidTextPart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "text" && typeof p.text === "string";
}

/**
 * A tool part MC may tag/clamp/drop: `type:"tool"` with a STRING `state.output`.
 *
 * FORK（toolsearch / native tool references）：`typeof output === "string"` 是
 * **有意**的排除门槛，不是遗漏。块数组结果（含 `tool_reference`）经
 * `hasStructuredToolOutput` 识别后由 `tool-drop-target.ts` 整弧绕过：它们既不该
 * 被 §N§ 打标，也不该被压成 `[dropped §N§]`（引用块没有 text 字段，字符串化
 * 即删除）。不要为「让它们也能治理」而直接把本判定放宽成 `Array.isArray`：
 * 下游 `byteSize`/`stripTagPrefix`/`prependTag` 全是字符串面，放宽会在打标点
 * 把块数组写坏；真要治理必须连同度量与写回一起做成块感知的。
 */
export function isToolPartWithOutput(part: unknown): part is ValidToolPart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool" || typeof p.callID !== "string") return false;
    if (p.state === null || typeof p.state !== "object") return false;
    return typeof (p.state as Record<string, unknown>).output === "string";
}

export function isFilePart(part: unknown): part is ValidFilePart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "file" && typeof p.url === "string";
}

export function buildFileSourceContent(parts: unknown[]): string | null {
    const content = parts
        .filter(isTextPart)
        .map((part) => stripTagPrefix(part.text))
        .join("\n")
        .trim();

    return content.length > 0 ? content : null;
}
