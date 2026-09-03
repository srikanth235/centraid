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

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/replica-retention.scale.test.ts";
const DAY_MS = 24 * 60 * 60 * 1_000;
const DAYS = 45;
const WRITES_PER_DAY = 4_000;
const HOT_ROWS = 400;
const COLD_ROWS = 20_000;
const HOT_SHARE = 0.9;

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
      writeDay(shipped, day, makeRandom(day + 1));
      writeDay(baseline, day, makeRandom(day + 1));
      const at = new Date(Date.UTC(2027, 0, 1) + day * DAY_MS);
      pruneReplicaChanges(shipped.vault, {
        now: at,
        maxEntries: REPLICA_RETENTION_MAX_ENTRIES,
      });
      baselinePrune(baseline, at, REPLICA_RETENTION_MAX_ENTRIES);
      shippedWindow.push(daysOfHistory(shipped, at));
      baselineWindow.push(daysOfHistory(baseline, at));
    }
    const durationMs = performance.now() - started;

    const steady = (values: number[]): number[] =>
      values.slice(REPLICA_RETENTION_DAYS);
    const shippedWorst = Math.min(...steady(shippedWindow));
    const baselineWorst = Math.min(...steady(baselineWindow));

    expect(shippedWorst).toBeGreaterThan(baselineWorst);
    expect(shippedWorst).toBeLessThanOrEqual(REPLICA_RETENTION_DAYS);
    const floor = currentReplicaLogState(shipped.vault).floor;
    expect(() =>
      readReplicaChanges(shipped.vault, { since: floor })
    ).not.toThrow();
    expect(shippedWorst).toBeGreaterThanOrEqual(REPLICA_RETENTION_DAYS - 2);
    expect(shippedWorst).toBeGreaterThan(baselineWorst * 3);

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Resumable replica history under year-3 churn",
      status: withinDrift ? "passed" : "failed",
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
    expect(
      withinDrift,
      `sustained drift: ${Math.round(durationMs)} ms vs drift budget ${drift} ms (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
  });
});
