/**
 * Re-export of `fast-check` for property / model-based contract tests (#532).
 *
 * Import from `@centraid/test-kit/fast-check` so every package shares one pinned
 * version and the dependency lives only in test-kit (dev surface).
 */
export { default as fc } from 'fast-check';
export * from 'fast-check';
