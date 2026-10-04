/**
 * Deferred seam — `config/project-security.ts` (upstream).
 *
 * Per-project security policy is not part of any port group in the spec; the A
 * group needs only the `protected_tokens` tier-override shape that
 * `storage-meta-persisted.ts` threads through its meta projection. Declared
 * locally, verbatim, rather than pulling the upstream policy module.
 */

/** Per-tier overrides for the derived `protected_tokens` floor. */
export interface ProtectedTokensTierOverrides {
    readonly user?: number;
    readonly project?: number;
}
