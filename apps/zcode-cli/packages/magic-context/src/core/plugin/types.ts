/**
 * Ported seam for upstream `plugin/types.ts`.
 *
 * Upstream is a four-line re-export of an OpenCode plugin type:
 *
 *     import type { Plugin } from "@opencode-ai/plugin";
 *     export type PluginContext = Parameters<Plugin>[0];
 *
 * `@opencode-ai/plugin` is on the fork's banned-dependency list (spec「依赖处理」),
 * so the shape is declared structurally instead. Step 18 audited every B-group
 * use of `PluginContext` and the only member reached for is `client`, through
 * three call sites:
 *
 *     deps.client.session.get({ path: { id: sessionId } })   // transform.ts
 *     abortSessionFailClosed(client, sessionId)              // → session.abort
 *
 * `session.get` is awaited and `.catch()`-ed, then narrowed through a cast, so
 * the response payload needs no shape here. `session.abort` is typed against the
 * real SDK contract because `ConfirmedAbortClient` (transform-postprocess-phase)
 * checks the confirmed-data result; the two declarations are kept assignable.
 * S19b wires the ZCode-side object into `TransformDeps.client` — structural
 * typing means the wiring only has to supply a compatible `session`.
 */
export interface PluginContext {
    readonly client: {
        session: {
            /** OpenCode's public session read; callers treat the payload as unknown. */
            get(args: { path: { id: string } }): Promise<unknown>;
            /** Fail-closed abort; the caller requires a confirmed `data === true`. */
            abort(args: {
                path: { id: string };
                throwOnError: true;
            }): Promise<{ data?: boolean; error?: unknown }>;
        };
    };
}