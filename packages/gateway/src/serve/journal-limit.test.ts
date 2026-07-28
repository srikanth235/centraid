import { describe, expect, it } from "vitest";

import {
  JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS,
  JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS,
  JOURNAL_ARCHIVE_WINDOW_LADDER,
  decideJournalArchive,
} from "./journal-limit.js";

// The size-triggered ledger archive (issue #544). Two properties carry the
// whole feature: with no limit set the behaviour must be indistinguishable
// from before, and with one set the window must never reach inside the floor
// no matter how low the limit or how long it stays exceeded.

const GB = 1024 ** 3;

describe("decideJournalArchive — no limit set", () => {
  it("reproduces the pre-#544 cadence exactly: daily gate, widest window", () => {
    expect(
      decideJournalArchive({
        journalBytes: 900 * GB,
        limitBytes: null,
        rung: 0,
        dailyGateElapsed: true,
      })
    ).toStrictEqual({
      run: true,
      windowDays: JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS,
      nextRung: 0,
      overLimit: false,
      atFloor: false,
    });
  });

  it("does not run before the daily gate elapses", () => {
    expect(
      decideJournalArchive({
        journalBytes: 900 * GB,
        limitBytes: null,
        rung: 0,
        dailyGateElapsed: false,
      }).run
    ).toBe(false);
  });
});

describe("decideJournalArchive — over the limit", () => {
  it("bypasses the daily gate", () => {
    const decision = decideJournalArchive({
      journalBytes: 2 * GB,
      limitBytes: GB,
      rung: 0,
      dailyGateElapsed: false,
    });
    expect(decision.run).toBe(true);
    expect(decision.overLimit).toBe(true);
  });

  it("narrows one rung per over-limit sweep and stops at the floor", () => {
    const seen: number[] = [];
    let rung = 0;
    // Ten consecutive over-limit sweeps — far more than the ladder is long.
    for (let i = 0; i < 10; i += 1) {
      const decision = decideJournalArchive({
        journalBytes: 2 * GB,
        limitBytes: GB,
        rung,
        dailyGateElapsed: false,
      });
      seen.push(decision.windowDays);
      rung = decision.nextRung;
    }
    expect(seen.slice(0, JOURNAL_ARCHIVE_WINDOW_LADDER.length)).toStrictEqual([
      ...JOURNAL_ARCHIVE_WINDOW_LADDER,
    ]);
    // Archival must never eat the window the owner is working in.
    expect(
      seen.every((days) => days >= JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS)
    ).toBe(true);
    expect(seen.at(-1)).toBe(JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS);
  });

  it('flags the floor so the plane and the UI can say "still over"', () => {
    const decision = decideJournalArchive({
      journalBytes: 2 * GB,
      limitBytes: GB,
      rung: JOURNAL_ARCHIVE_WINDOW_LADDER.length - 1,
      dailyGateElapsed: false,
    });
    expect(decision.atFloor).toBe(true);
    expect(decision.windowDays).toBe(JOURNAL_ARCHIVE_FLOOR_WINDOW_DAYS);
  });

  it("resets the ladder once the file is back under, so a spike is not permanent", () => {
    const narrowed = decideJournalArchive({
      journalBytes: 2 * GB,
      limitBytes: GB,
      rung: 2,
      dailyGateElapsed: false,
    });
    expect(narrowed.windowDays).toBeLessThan(
      JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS
    );

    const recovered = decideJournalArchive({
      journalBytes: GB / 2,
      limitBytes: GB,
      rung: narrowed.nextRung,
      dailyGateElapsed: true,
    });
    expect(recovered).toMatchObject({
      nextRung: 0,
      windowDays: JOURNAL_ARCHIVE_DEFAULT_WINDOW_DAYS,
      overLimit: false,
    });
  });

  it("treats exactly-at-the-limit as under it", () => {
    expect(
      decideJournalArchive({
        journalBytes: GB,
        limitBytes: GB,
        rung: 0,
        dailyGateElapsed: false,
      })
    ).toMatchObject({ run: false, overLimit: false });
  });

  it("clamps a corrupt rung into the ladder rather than indexing past it", () => {
    for (const rung of [-3, 99]) {
      const decision = decideJournalArchive({
        journalBytes: 2 * GB,
        limitBytes: GB,
        rung,
        dailyGateElapsed: false,
      });
      expect(JOURNAL_ARCHIVE_WINDOW_LADDER).toContain(decision.windowDays);
    }
  });
});
