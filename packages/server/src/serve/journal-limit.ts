/*
 * Size-triggered ledger archive (#544): over the limit the daily gate is
 * bypassed and the window narrows per sweep (90 → 30 → 14 → 7). SEVEN IS A
 * HARD FLOOR — the owner's working days are never archived.
 */

export const JOURNAL_ARCHIVE_WINDOW_LADDER: readonly number[] = Object.freeze([
  90, 30, 14, 7,
]);

export const JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS =
  JOURNAL_ARCHIVE_WINDOW_LADDER[0] as number;

export const JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS = JOURNAL_ARCHIVE_WINDOW_LADDER[
  JOURNAL_ARCHIVE_WINDOW_LADDER.length - 1
] as number;

export interface JournalArchiveDecisionInput {
  journalBytes: number;
  limitBytes: number | null;
  rung: number;
  dailyGateElapsed: boolean;
}

export interface JournalArchiveDecision {
  run: boolean;
  windowDays: number;
  nextRung: number;
  overLimit: boolean;
  atFloor: boolean;
}

export function decideJournalArchive(
  input: JournalArchiveDecisionInput
): JournalArchiveDecision {
  const { journalBytes, limitBytes, dailyGateElapsed } = input;
  const overLimit =
    limitBytes !== null && limitBytes > 0 && journalBytes > limitBytes;

  if (!overLimit) {
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
    nextRung: Math.min(rung + 1, lastRung),
    overLimit: true,
    atFloor: windowDays === JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS,
  };
}
