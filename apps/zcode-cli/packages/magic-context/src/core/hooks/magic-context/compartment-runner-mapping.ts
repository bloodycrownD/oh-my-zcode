// Verbatim port of upstream `hooks/magic-context/compartment-runner-mapping.ts`
// (Step 20, C group). Byte-for-byte apart from `.js` import specifiers, which
// this fork's NodeNext module resolution requires.
//
// The dependency closure was already closed in the fork: `compartment-parser.ts`
// is B-group and `compartment-runner-types.ts` is now the real C-group module,
// so no seam import and no overlay is involved.

import type { ParsedCompartment } from "./compartment-parser.js";
import type { CandidateCompartment } from "./compartment-runner-types.js";

/** Tier/metadata fields a parsed compartment may carry, threaded to storage. */
type ParsedTierFields = Pick<
    ParsedCompartment,
    "p1" | "p2" | "p3" | "p4" | "importance" | "episodeType"
>;

function tierFieldsOf(c: ParsedTierFields): ParsedTierFields {
    return {
        p1: c.p1,
        p2: c.p2,
        p3: c.p3,
        p4: c.p4,
        importance: c.importance,
        episodeType: c.episodeType,
    };
}

export function mapParsedCompartmentsToChunk(
    compartments: Array<
        {
            startMessage: number;
            endMessage: number;
            title: string;
            content: string;
        } & ParsedTierFields
    >,
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    },
    sequenceOffset: number,
): { ok: true; compartments: CandidateCompartment[] } | { ok: false; error: string } {
    const mapped: CandidateCompartment[] = [];
    for (const [index, compartment] of compartments.entries()) {
        const startLine = chunk.lines.find((line) => line.ordinal === compartment.startMessage);
        const endLine = chunk.lines.find((line) => line.ordinal === compartment.endMessage);
        if (!startLine || !endLine) {
            return {
                ok: false,
                error: `Compartment range ${compartment.startMessage}-${compartment.endMessage} does not map to raw session lines ${chunk.startIndex}-${chunk.endIndex}`,
            };
        }
        mapped.push({
            sequence: sequenceOffset + index,
            startMessage: compartment.startMessage,
            endMessage: compartment.endMessage,
            startMessageId: startLine.messageId,
            endMessageId: endLine.messageId,
            title: compartment.title,
            content: compartment.content,
            ...tierFieldsOf(compartment),
        });
    }

    return { ok: true, compartments: mapped };
}