export type DurablePath =
  | "journalled-vault-write"
  | "cas-blob-landing"
  | "wal-checkpoint"
  | "automation-claim";

export interface CrashBoundary {
  readonly id: string;
  readonly path: DurablePath;
  readonly seam: string;
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

export const CRASH_BOUNDARY_BY_ID: Readonly<
  Record<CrashBoundaryId, CrashBoundary>
> = Object.fromEntries(
  CRASH_BOUNDARIES.map((boundary) => [boundary.id, boundary])
) as Record<CrashBoundaryId, CrashBoundary>;
