import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import {
  currentReplicaLogState,
  openVaultDb,
  pruneReplicaChanges,
  readReplicaChanges,
  REPLICA_RETENTION_DAYS,
  REPLICA_RETENTION_MAX_ENTRIES,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

/**
 * HOW MUCH HISTORY DOES 100,000 ENTRIES BUY? (issue #883 C6.)
 *
 * The change log is capped at `REPLICA_RETENTION_DAYS` of age AND
 * `REPLICA_RETENTION_MAX_ENTRIES` of volume, whichever bites first. A phone
 * that is away longer than the retained window cannot be caught up with
 * deltas: it re-bootstraps its whole library. The days number is the promise
 * the gateway makes on the wire; the entries number is what a churn-heavy
 * vault actually gets.
 *
 * Year-3 churn is not evenly spread. Repeated edits land on a few hot rows —
 * the task you keep re-titling, the note you keep re-saving — and every one of
 * those edits used to burn an entry that a catch-up replay would collapse
 * anyway. This rig measures what that costs, in the only unit that matters to
 * the member: DAYS OF HISTORY a returning phone can still resume from.
 *
 * It runs the same synthetic year of writes twice on two vaults:
 *
 *   BASELINE — the pre-#883 sweep, transcribed below. Under count pressure it
 *     deleted every superseded entry in the pressured prefix and ADVANCED THE
 *     FLOOR past it, so relieving volume pressure cost history directly.
 *   SHIPPED — `pruneReplicaChanges`, which folds those same entries into their
 *     survivors and leaves the floor alone.
 *
 * Both sweep on the same cadence with the same caps. The reported number is
 * days between the floor (the oldest cursor still servable) and "now".
 */
const OWNER = "tests/scale/replica-retention.scale.test.ts";
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Simulated days of writing. Longer than the age window, so both caps bite. */
const DAYS = 45;
/** Writes per simulated day at year-3 volume. */
const WRITES_PER_DAY = 4_000;
/** Distinct rows the churn lands on: a small hot set inside a large vault. */
const HOT_ROWS = 400;
const COLD_ROWS = 20_000;
/** Share of each day's writes that hit the hot set. */
const HOT_SHARE = 0.9;

/** Deterministic, so a regression is a real one and not a reseed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
}

function open(): VaultDb {
  const db = openVaultDb();
  onTestFinished(() => db.close());
  return db;
}

/**
 * One simulated day of writes, through the protocol-only append path: this
 * rig measures RETENTION, not trigger projection, and appending directly
 * keeps a 180,000-write year inside a test budget.
 */
function writeDay(db: VaultDb, day: number, random: () => number): void {
  const changedAt = new Date(Date.UTC(2027, 0, 1) + day * DAY_MS).toISOString();
  const vault = db.vault;
  vault.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < WRITES_PER_DAY; index += 1) {
    const hot = random() < HOT_SHARE;
    const rowId = hot
      ? `hot-${Math.floor(random() * HOT_ROWS)}`
      : `cold-${Math.floor(random() * COLD_ROWS)}`;
    vault
      .prepare(
        `INSERT INTO replica_change
           (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
         SELECT epoch, 'rig:' || ? || ':' || ?, 'schedule.task', ?, 'update', NULL, ?
           FROM replica_meta WHERE singleton = 1`
      )
      .run(day, index, rowId, changedAt);
  }
  vault.exec("COMMIT");
}

/**
 * The pre-#883 count branch, verbatim in behaviour: collapse the superseded
 * entries in the pressured window, delete the rest of that prefix, and move
 * the floor to its end. Kept here ONLY as the measurement's baseline.
 */
function baselinePrune(db: VaultDb, now: Date, maxEntries: number): void {
  const vault = db.vault;
  const epoch = currentReplicaLogState(vault).epoch;
  const cutoff = new Date(
    now.getTime() - REPLICA_RETENTION_DAYS * DAY_MS
  ).toISOString();
  const commitEnd = (through: number): number => {
    if (through <= 0) return 0;
    const group = vault
      .prepare(
        `SELECT commit_id FROM replica_change
          WHERE epoch = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`
      )
      .get(epoch, through) as { commit_id: string } | undefined;
    if (!group) return 0;
    return (
      (
        vault
          .prepare(
            `SELECT MAX(seq) AS seq FROM replica_change WHERE epoch = ? AND commit_id = ?`
          )
          .get(epoch, group.commit_id) as { seq: number | null }
      ).seq ?? 0
    );
  };
  vault.exec("BEGIN IMMEDIATE");
  let floor = 0;
  const ageThrough = commitEnd(
    (
      vault
        .prepare(
          `SELECT MAX(seq) AS seq FROM replica_change WHERE epoch = ? AND changed_at < ?`
        )
        .get(epoch, cutoff) as { seq: number | null }
    ).seq ?? 0
  );
  if (ageThrough > 0) {
    vault
      .prepare(`DELETE FROM replica_change WHERE epoch = ? AND seq <= ?`)
      .run(epoch, ageThrough);
    floor = Math.max(floor, ageThrough);
  }
  let count = (
    vault
      .prepare(`SELECT COUNT(*) AS n FROM replica_change WHERE epoch = ?`)
      .get(epoch) as { n: number }
  ).n;
  if (count > maxEntries) {
    const compactionThrough = commitEnd(
      (
        vault
          .prepare(
            `SELECT MAX(older.seq) AS seq
               FROM replica_change older
              WHERE older.epoch = ?
                AND EXISTS (
                  SELECT 1 FROM replica_change newer
                   WHERE newer.epoch = older.epoch
                     AND newer.entity = older.entity
                     AND newer.row_id = older.row_id
                     AND newer.seq > older.seq
                )`
          )
          .get(epoch) as { seq: number | null }
      ).seq ?? 0
    );
    if (compactionThrough > 0) {
      vault
        .prepare(`DELETE FROM replica_change WHERE epoch = ? AND seq <= ?`)
        .run(epoch, compactionThrough);
      floor = Math.max(floor, compactionThrough);
      count = (
        vault
          .prepare(`SELECT COUNT(*) AS n FROM replica_change WHERE epoch = ?`)
          .get(epoch) as { n: number }
      ).n;
    }
    if (count > maxEntries) {
      const countThrough = commitEnd(
        (
          vault
            .prepare(
              `SELECT seq FROM replica_change WHERE epoch = ? ORDER BY seq LIMIT 1 OFFSET ?`
            )
            .get(epoch, count - maxEntries - 1) as { seq: number }
        ).seq
      );
      vault
        .prepare(`DELETE FROM replica_change WHERE epoch = ? AND seq <= ?`)
        .run(epoch, countThrough);
      floor = Math.max(floor, countThrough);
    }
  }
  const existing = currentReplicaLogState(vault).floor.seq;
  vault
    .prepare(
      `UPDATE replica_meta SET floor_seq = ?, updated_at = ? WHERE singleton = 1`
    )
    .run(Math.max(existing, floor), now.toISOString());
  vault.exec("COMMIT");
}

/**
 * Days between the oldest entry a cursor at the floor can still read and the
 * end of the run. This is the resumable window, not merely what is on disk:
 * an entry below the floor is unreachable even while it exists.
 */
function daysOfHistory(db: VaultDb, now: Date): number {
  const state = currentReplicaLogState(db.vault);
  const oldest = db.vault
    .prepare(
      `SELECT MIN(changed_at) AS changed_at FROM replica_change
        WHERE epoch = ? AND seq > ?`
    )
    .get(state.epoch, state.floor.seq) as { changed_at: string | null };
  if (!oldest.changed_at) return 0;
  return (now.getTime() - Date.parse(oldest.changed_at)) / DAY_MS;
}

describe("replica-retention.scale", () => {
  test("compaction buys back days of resumable history at the same entry cap", async () => {
    const shipped = open();
    const baseline = open();
    const shippedWindow: number[] = [];
    const baselineWindow: number[] = [];
    const started = performance.now();
    for (let day = 0; day < DAYS; day += 1) {
      // The same stream on both vaults: only the sweep differs.
      writeDay(shipped, day, makeRandom(day + 1));
      writeDay(baseline, day, makeRandom(day + 1));
      const at = new Date(Date.UTC(2027, 0, 1) + day * DAY_MS);
      pruneReplicaChanges(shipped.vault, {
        now: at,
        maxEntries: REPLICA_RETENTION_MAX_ENTRIES,
      });
      baselinePrune(baseline, at, REPLICA_RETENTION_MAX_ENTRIES);
      // Measured after EVERY sweep, because a phone comes back on a day of
      // its own choosing. The window a sweep leaves behind is what it finds.
      shippedWindow.push(daysOfHistory(shipped, at));
      baselineWindow.push(daysOfHistory(baseline, at));
    }
    const durationMs = performance.now() - started;

    // Steady state only: the first 30 days cannot have 30 days of history.
    const steady = (values: number[]): number[] =>
      values.slice(REPLICA_RETENTION_DAYS);
    const shippedWorst = Math.min(...steady(shippedWindow));
    const baselineWorst = Math.min(...steady(baselineWindow));

    // The number that matters is the WORST day to come back on, not the best:
    // relieving entry pressure used to drop the resumable window to nothing.
    expect(shippedWorst).toBeGreaterThan(baselineWorst);
    // Compaction may buy back the days the entry cap was taking, never more
    // than the age window promises on the wire.
    expect(shippedWorst).toBeLessThanOrEqual(REPLICA_RETENTION_DAYS);
    // A cursor at the far edge of the retained window still resolves, rather
    // than throwing the retention verdict at a returning phone.
    const floor = currentReplicaLogState(shipped.vault).floor;
    expect(() =>
      readReplicaChanges(shipped.vault, { since: floor })
    ).not.toThrow();
    // Measured (this rig, 45 days x 4,000 writes, 90% of them on 400 hot rows,
    // cap 100,000): the entry cap alone left a WORST-DAY window of 5.0 days,
    // because the sweep that relieved volume pressure took the floor with it.
    // Folding that same churn holds 28.0 days -- the whole age window, less
    // the day-granularity edge of this rig's clock. Nothing was tightened:
    // REPLICA_RETENTION_DAYS and REPLICA_RETENTION_MAX_ENTRIES are unchanged,
    // and the measurement is what says they now mean what they say.
    expect(shippedWorst).toBeGreaterThanOrEqual(REPLICA_RETENTION_DAYS - 2);
    expect(shippedWorst).toBeGreaterThan(baselineWorst * 3);

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Resumable replica history under year-3 churn",
      status: "passed",
      measurements: [
        {
          name: "worst-day resumable window (compaction)",
          value: Number(shippedWorst.toFixed(2)),
          unit: "days",
          budget: REPLICA_RETENTION_DAYS,
        },
        {
          name: "worst-day resumable window (entry cap alone)",
          value: Number(baselineWorst.toFixed(2)),
          unit: "days",
        },
        {
          name: "retained entries",
          value: (
            shipped.vault
              .prepare(`SELECT COUNT(*) AS n FROM replica_change`)
              .get() as { n: number }
          ).n,
          unit: "entries",
          budget: REPLICA_RETENTION_MAX_ENTRIES,
        },
        { name: "wall clock", value: Math.round(durationMs), unit: "ms" },
      ],
    });
  });
});
