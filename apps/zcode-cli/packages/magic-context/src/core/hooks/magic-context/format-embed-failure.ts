import type { EmbeddingFailure } from "../../deferred/embedding-failure.js";
import { renderEmbeddingFailure, type UserFacingTextStyle } from "../../shared/user-facing-codes.js";

export function formatEmbedFailureSummary(
    embedded: number,
    remaining: number,
    failure?: EmbeddingFailure,
    style: UserFacingTextStyle = "markdown",
): string {
    const historyBlocks = `history block${embedded === 1 ? "" : "s"}`;
    const progress = `Indexed ${embedded} ${historyBlocks}; ${remaining} remain.`;
    return `${progress} ${renderEmbeddingFailure(failure?.class ?? "empty_result", style)}`;
}
