// Verbatim port of upstream `agents/historian.ts` (Step 20, C group).
// Byte-for-byte.
//
// These are agent identifiers, not config keys: the runner passes one as
// `HiddenRunIdentity.agent` / `.kind` so the host adapter can route the
// side-car request to the right historian model lane (and so a run log can be
// attributed). `historian-editor` is the optional second pass
// (`historianTwoPass`) and `historian-recomp` is `/ctx-recomp` (Step 22).

export const HISTORIAN_AGENT = "historian";
export const HISTORIAN_RECOMP_AGENT = "historian-recomp";
export const HISTORIAN_EDITOR_AGENT = "historian-editor";