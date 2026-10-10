/**
 * FORK-NOTE（bugfix-batch-20261011 / Step 12，③随行新移植）：
 * `tools/light-descriptions.ts` 的上游真身整文件复制，落位 `core/tools/`。
 *
 * 上游源：`.reference/magic-context/packages/plugin/src/tools/light-descriptions.ts`
 * （13 行源码、5 个常量）。它是 `prompt-surface-runtime.ts` 的 light 档工具描述来源，
 * fork 此前没有任何副本，因此按「deferred 无缝的上游文件」处置：整文件新移植 + 本注。
 *
 * WHAT CHANGED VS UPSTREAM
 * ────────────────────────
 * `CTX_NOTE_LIGHT_DESCRIPTION` **不搬**：ctx_note 工具属 N2 终局不做（ZCode D 组工具面
 * 只登记 ctx_reduce / ctx_expand / ctx_search / ctx_memory 四条，没有 note 的宿主面）。
 * 搬一条描述给一个不存在的工具，等于让 prompt-surface 的「已知 ctx_* 工具」集合里出现
 * 一条永不匹配的 id——`prompt_surface.tool_descriptions.ctx_note` 这类覆盖也会因此被
 * 当成合法。少一条常量，`ACTIVE_TOOL_IDS` / `LIGHT_TOOL_DESCRIPTIONS`（在同目录的
 * `../shared/prompt-surface-runtime.ts`）随之只保留四条，两边一起收口。
 *
 * 保留的**文本内**引用（不改逐字文案）：`CTX_MEMORY_LIGHT_DESCRIPTION` 末句
 * 「A pending intention with evidence is ctx_note, not memory.」与 211 行段的
 * `CTX_NOTE_GUIDANCE` 同属一类——上游把 note 当作 memory 的分流判据写进了 prose。本文件
 * 是逐字移植区，按纪律不剪辑 prose；该引用在 fork 里是**惰性**的（ctx_note 未注册，模型
 * 看不到那个工具，句子只起到「不要把待办写成记忆」的边界作用，而这条边界本身仍然正确）。
 * spec Step 18 对 211 行段的同一处置口径在此对齐；`scripts/test-prompt-surface.mjs` 的
 * 「light-description tool references close against the ZCode tool surface」断言把这条
 * 豁免显式钉成 `["ctx_note"]`——豁免集长大时那里会红。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

export const CTX_REDUCE_LIGHT_DESCRIPTION = `Stamp an item as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays readable until Magic Context clears stamped items in one sweep, newest tags are protected, and a cleared item goes to the archive (recent: a [dropped §N§] placeholder; older: removed) recoverable via ctx_expand(tag=N). The question is "does this need to stay on my desk for what comes next?" — a file you keep editing stays, the grep that found it goes. Stamp used reads/searches/outputs, acted-on build/test output, redundant dumps, extracted pasted payloads; keep user messages, your own text, unresolved errors, raw evidence, exact wording that may matter. Look at each tag; never blanket-stamp "1-50". Grammar: "3-5", "1,2,9", "1-5,8,12-15".`;

export const CTX_EXPAND_LIGHT_DESCRIPTION =
    "Recover one item with tag=N (a §N§ or dropped placeholder number), not a message ordinal; text or one tool call with full input/output. message=N and start/end are whole-message ordinals from history/search, never tag numbers. Recover raw conversation behind a <session-history> heading or around a ctx_search hit: ctx_expand(start, end) returns [N] U:/A: lines (~15K-token cap; oversized ranges return the head and where to continue). verbose=true lists messages with per-part previews to pick one; message=N returns that message in full, including a tool output released with ctx_reduce. Ranges after the last compartment are your live tail, not expandable.";

export const CTX_MEMORY_LIGHT_DESCRIPTION =
    "Durable facts about this project, shared with every agent on it and kept for the months this work lasts; active ones are already in <project-memory> as `#id: fact`. Write one standalone fact when it must not have to be found again — a rule, an architecture fact, a constraint, a config value, a naming convention — especially what cost you turns. A pending intention with evidence is ctx_note, not memory. write (content + category); update one id (content; category optional); archive one or more ids (reason optional); merge two or more ids (content); get 1–20 ids in any status.";

export const CTX_SEARCH_LIGHT_DESCRIPTION =
    'Search the archive — everything that ever happened here that is not on your desk: memories not in <project-memory>, compacted conversation, commits, notes. Phrase query as a natural-language question carrying the exact terms you expect ("where is the opencode source code path?", "why did we choose SQLite over postgres?", "how does the dreamer lease work?") — a keyword stack finds less. Sources (omit for all): memory (rules, conventions), message (compacted conversation; hits carry ordinals for ctx_expand), git_commit (when did this change), primer (reusable project Q&A the dreamer distils from recurring questions), note (parked follow-ups). Memory ids alone (`#7234`) resolve directly. from/to restrict every source to an inclusive UTC date range.';
