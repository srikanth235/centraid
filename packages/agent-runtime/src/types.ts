/*
 * Shared types for the agent-runtime wrappers.
 *
 * The canonical definitions now live in `@centraid/app-engine`
 * (`turn.ts`) so the backend-agnostic run engine can speak the same
 * contract without depending on this backend package. Re-exported here so
 * agent-runtime's own modules (and back-compat consumers that import from
 * `@centraid/agent-runtime`) keep their existing import paths.
 */

export type { RunnerKind, RunnerPrefs } from '@centraid/app-engine';
