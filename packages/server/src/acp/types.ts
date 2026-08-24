/*
 * Shared types for this package's harness wrappers.
 *
 * The canonical definitions live in `@centraid/server/engine`
 * (`turn.ts`) so the backend-agnostic run engine can speak the same
 * contract without depending on this backend package. Re-exported here so
 * agent-runtime's own modules (and back-compat consumers that import from
 * `@centraid/server/acp`) keep their existing import paths.
 */

export type { HarnessKind, HarnessPrefs } from "@centraid/server/engine";
