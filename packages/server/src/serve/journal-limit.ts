/*
 * The size-triggered ledger archive (issue #544) — the decision half of
 * "archive early when `journal.db` gets big", kept pure so the ladder is
 * unit-testable without a plane, a sweep timer, or a real database.
 *
 * Why this exists. `journal.db` carries BOTH the audit ladder (#367 §E2) and
 * the conversation ledger (#438), and it is explicitly "the file that reaches
 * gigabytes". Both archival engines already run in `VaultPlane.runSweep`, but
 * only on a once-a-day gate with a fixed 90-day window. That is a *time*
 * policy: it says nothing about size, so a heavy month of conversations grows
 * the file for 90 days before a single row is eligible. The owner's
 * `journalLimitBytes` turns that into a size policy without changing what
 * archival is allowed to delete.
 *
 * Two things change when the file is over the limit:
 *
 *   1. The daily gate is bypassed — the next sweep archives, rather than
 *      waiting up to 24h while the file keeps growing.
 *   2. The window narrows one rung per over-limit sweep: 90 → 30 → 14 → 7
 *      days. It stops at the first rung that brings the file under the limit,
 *      and 7 days is a HARD floor. Archival must never eat the window the
 *      owner is actively working in — a limit set too low is the owner's
 *      mistake to see in the UI ("still over budget at the 7-day floor"),
 *      never a reason to seal away this morning's conversation.
 *
 * The ladder is a per-plane, in-memory position, deliberately not persisted:
 * a restart re-derives it from the file size on the next sweep, which is the
 * only input that actually matters.
 */

/** The window ladder, widest first. The last rung is the floor. */
export const JOURNAL_ARCHIVE_WINDOW_LADDER: readonly number[] = Object.freeze([
  90, 30, 14, 7,
]);

/** The widest rung — matches both engines' own defaults, so an unset limit
 *  reproduces today's behaviour byte for byte. */
export const JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS =
  JOURNAL_ARCHIVE_WINDOW_LADDER[0] as number;

/** The narrowest rung — archival never reaches inside this many days. */
export const JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS = JOURNAL_ARCHIVE_WINDOW_LADDER[
  JOURNAL_ARCHIVE_WINDOW_LADDER.length - 1
] as number;

export interface JournalArchiveDecisionInput {
  /** Current `journal.db` (+ `-wal`) size in bytes. */
  journalBytes: number;
  /** The owner's limit, or `null` when they haven't set one. */
  limitBytes: number | null;
  /** Ladder index carried from the previous sweep (0 = widest window). */
  rung: number;
  /** `true` when the plane's own once-a-day gate has elapsed. */
  dailyGateElapsed: boolean;
}

export interface JournalArchiveDecision {
  /** Whether to run both archival engines on this sweep at all. */
  run: boolean;
  /** Window to pass to `runJournalArchival` / `runConversationArchival`. */
  windowDays: number;
  /** Ladder index to carry into the next sweep. */
  nextRung: number;
  /** `true` when the size limit — not the daily gate — is why this runs. */
  overLimit: boolean;
  /** `true` when the file is still over the limit at the 7-day floor. The
   *  plane logs this once per sweep; the UI turns it into "your ledger limit
   *  is lower than the last 7 days of activity". */
  atFloor: boolean;
}

/**
 * The whole policy in one pure function.
 *
 * With no limit set, this collapses to exactly the pre-#544 behaviour: run on
 * the daily gate, at the 90-day window, ladder pinned to rung 0.
 */
export function decideJournalArchive(
  input: JournalArchiveDecisionInput
): JournalArchiveDecision {
  const { journalBytes, limitBytes, dailyGateElapsed } = input;
  const overLimit =
    limitBytes !== null && limitBytes > 0 && journalBytes > limitBytes;

  if (!overLimit) {
    // Back under the limit (or never over it): relax to the widest window so
    // the next over-limit episode starts the ladder from the top rather than
    // inheriting a narrow window from an old one.
    return {
      run: dailyGateElapsed,
      windowDays: JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS,
      nextRung: 0,
      overLimit: false,
      atFloor: false,
    };
  }

  const lastRung = JOURNAL_ARCHIVE_WINDOW_LADDER.length - 1;
  const rung = Math.min(Math.max(0, input.rung), lastRung);
  const windowDays = JOURNAL_ARCHIVE_WINDOW_LADDER[rung] as number;
  return {
    run: true,
    windowDays,
    // Advance one rung per over-limit sweep, clamped at the floor. The NEXT
    // sweep re-measures: if this pass brought the file under, `overLimit` is
    // false above and the ladder resets, so a single spike never permanently
    // narrows the window.
    nextRung: Math.min(rung + 1, lastRung),
    overLimit: true,
    atFloor: windowDays === JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS,
  };
}
