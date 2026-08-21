/*
 * The doctor integrity-scrub check library (issue #839 W1.2) — barrel.
 *
 * Re-exports the reusable invariant checks and the scrub orchestrator so
 * in-package callers (the `doctor` CLI verb, the restore drill) import from one
 * stable surface.
 *
 * This list is exactly what callers import, not everything `integrity-checks`
 * defines: a barrel that re-exports what nothing imports is dead surface, and
 * knip says so. Widen it when a caller needs the symbol, not in anticipation.
 */

export {
  checkCasRehash,
  checkReplicaJournalConsistency,
  hasError,
  runIntegrityScrub,
} from "./integrity-checks.js";
export type {
  DoctorVaultTarget,
  FindingLevel,
  IntegrityCheckName,
  IntegrityFinding,
} from "./integrity-checks.js";
