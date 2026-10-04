// FORK-DEFERRED(Batch2): `agents/magic-context-prompt.ts` 的 MEMORY_MURAL_GUIDANCE / MEMORY_MURAL_BLOCK 常量摘录，Step 31 移植真身后删除本文件
//
// WHY VERBATIM. The upstream module is 211 lines of agent system-prompt
// sections; the only member the B group names is `MEMORY_MURAL_BLOCK`, a
// two-constant composition. Both constants are USER-VISIBLE PROMPT TEXT keyed to
// the mural image format, so paraphrasing them would desynchronise the fork's
// prompt from its own renderer. Reproduced verbatim; the rest of the module (the
// `full`/`light` preset assembly, `buildPrimaryLanguageDirective` wiring) is
// E-group and reached through the host config path instead.
//
// SEMANTIC NOTE. `inject-compartments.ts:2355` only pushes this block when the
// mural wire options carry `enabled && supportsVision && dataUrl`. With
// `deferred/render-trigger.ts` answering `supportsVision: false`, this text can
// never reach the wire in the fork — it is carried so Step 31 finds the exact
// bytes the renderer expects.
//
// Step 31: delete this file and repoint `inject-compartments.ts` back at
// `../../agents/magic-context-prompt.js`.

export const MEMORY_MURAL_GUIDANCE =
    "The memory mural image lists project memories that did not fit `<project-memory>`, as compressed cues under category banners. A red cue is a prohibition (`⊘thing (reason)`), `→` means leads to. Run `ctx_search` with a cue's identifiers to recall the full memory.";

export const MEMORY_MURAL_BLOCK = `<memory-mural>\nThe project memory mural image follows.\n${MEMORY_MURAL_GUIDANCE}\n</memory-mural>`;