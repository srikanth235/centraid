/**
 * Crash-consistency boundary catalog (issue #842 W1.1).
 *
 * Each entry names a durable-write seam where a real SIGKILL of a running
 * gateway must leave the vault recoverable: the acknowledged write before
 * the seam survives, the operation the crash interrupted did not
 * half-apply, no write path left an orphaned temp file, and no WAL group is
 * both counted and lost. `kill-mid-write.integration.test.ts` drives a
 * seeded schedule over this catalog (see `crash-schedule.ts`) so any red run
 * replays from its seed alone; `fixtures/kill-mid-write-child.ts` stages one
 * boundary per subprocess and asserts the invariants on real post-restart
 * state (never on logs).
 *
 * The four durable paths #842 names: journalled vault writes, WAL-shipper /
 * checkpoint commits, CAS blob landing, and the automation claim ledger.
 * The offsite backup part-upload path is a fifth durable path whose crash
 * boundary needs a backend rig it does not have here — it is reported to the
 * #842 register as a named needs-rig tier rather than staged vacuously.
 */

export type DurablePath =
  | "journalled-vault-write"
  | "cas-blob-landing"
  | "wal-checkpoint"
  | "automation-claim";

export interface CrashBoundary {
  /** Stable id; also the argv token handed to the fault child. */
  readonly id: string;
  /** Which durable write path this seam belongs to. */
  readonly path: DurablePath;
  /** The fsync/commit boundary the SIGKILL lands on. */
  readonly seam: string;
  /** The recovery invariant asserted on real post-restart state. */
  readonly invariant: string;
}

export const CRASH_BOUNDARIES = [
  {
    id: "journal-after-append",
    path: "journalled-vault-write",
    seam: "after the journal turn/item commit fsyncs, before any follow-on work",
    invariant:
      "the acknowledged turn+item is present exactly once — no half-applied append, no duplicate",
  },
  {
    id: "blob-after-stage",
    path: "cas-blob-landing",
    seam: "after the ingress spool bytes fsync and the durable offset is recorded",
    invariant:
      "the resumable ingress session recovers at its durable offset and the CAS store holds no orphaned .tmp",
  },
  {
    id: "wal-before-checkpoint",
    path: "wal-checkpoint",
    seam: "after the locker commit, immediately before the WAL checkpoint call",
    invariant:
      "the committed row survives an unrun checkpoint — no WAL group both counted and lost",
  },
  {
    id: "automation-after-claim",
    path: "automation-claim",
    seam: "after the automation run lock is claimed and committed",
    invariant:
      "the conversation exists once and a duplicate runner cannot re-claim the same turn",
  },
] as const satisfies readonly CrashBoundary[];

export type CrashBoundaryId = (typeof CRASH_BOUNDARIES)[number]["id"];

export const CRASH_BOUNDARY_IDS: readonly CrashBoundaryId[] =
  CRASH_BOUNDARIES.map((boundary) => boundary.id);

/** Boundary metadata keyed by id, for assertion messages and the receipt. */
export const CRASH_BOUNDARY_BY_ID: Readonly<
  Record<CrashBoundaryId, CrashBoundary>
> = Object.fromEntries(
  CRASH_BOUNDARIES.map((boundary) => [boundary.id, boundary])
) as Record<CrashBoundaryId, CrashBoundary>;
