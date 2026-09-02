/** Barrel so in-package callers import from one stable surface. Widen it only when a caller needs the symbol — knip flags dead re-exports. */

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
