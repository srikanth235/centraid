/*
 * The doctor integrity-scrub check library (issue #839 W1.2) — barrel.
 *
 * Re-exports the reusable invariant checks and the scrub orchestrator so
 * in-package callers (the `doctor` CLI verb, the scheduled background scrub)
 * and, once `@centraid/server` publishes a `./doctor` subpath, out-of-package
 * callers (the crash lane) import from one stable surface.
 */

export {
  DEFAULT_CAS_SAMPLE_SIZE,
  checkCasRehash,
  checkDatabaseIntegrity,
  checkHardlinkRefcounts,
  checkReplicaJournalConsistency,
  hasError,
  hasWarning,
  runIntegrityScrub,
} from "./integrity-checks.js";
export type {
  CasRehashInput,
  DatabaseTarget,
  DoctorVaultTarget,
  FindingLevel,
  IntegrityCheckName,
  IntegrityFinding,
  IntegrityScrubInput,
  ReplicaJournalInput,
  VaultCasRoot,
} from "./integrity-checks.js";
