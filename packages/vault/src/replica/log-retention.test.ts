// RETENTION AND THE PRODUCER BOUND (#996, R5; open questions 3 and 13).
//
// The floor is what replaces compaction, and the two things it may not cross
// are the two ways a cheap tail turns into a forced re-bootstrap without
// anyone deciding to: a commit edge, and a live seat's cursor.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { bumpReplicaEpoch } from "./change-log.js";
import {
  lowestSeatCursor,
  pruneReplicaLog,
  recordSeatCursor,
  REPLICA_SEAT_HOLD_DAYS,
  readReplicaLog,
  replicaLogState,
  ReplicaRebootstrapRequiredError,
  REPLICA_DEFER_THRESHOLD_BYTES,
  REPLICA_PRODUCER_MAX_ROWS,
} from "./log.js";
import {
  capturedCommit,
  insertOwnerAndDevice,
  insertScheme,
} from "./replica-log.test-fixtures.js";

/** Three commits of two rows each, so the floor has edges to land on. */
function seeded(db: VaultDb): void {
  for (const label of ["a", "b", "c"]) {
    capturedCommit(db, "seed", (vault) => {
      insertScheme(vault, `${label}1`);
      insertScheme(vault, `${label}2`);
    });
  }
}

describe("the retention floor", () => {
  test("lands on a commit edge, never inside one", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const all = readReplicaLog(db.vault, { limit: 10_000 }).rows;
      // A count cap that falls INSIDE the middle commit.
      const firstCommit = all[0]!.commitSeq;
      const inside = all.filter(
        (row) => row.commitSeq >= firstCommit + 1
      ).length;
      const result = pruneReplicaLog(db.vault, {
        maxRows: inside - 1,
        maxAgeMs: Number.MAX_SAFE_INTEGER,
      });
      const kept = readReplicaLog(db.vault, {
        since: result.floor,
        limit: 10_000,
      }).rows;
      // Whatever survived, it survived in whole commits.
      const survivingCommits = new Set(kept.map((row) => row.commitSeq));
      for (const commitSeq of survivingCommits) {
        expect(
          kept.filter((row) => row.commitSeq === commitSeq),
          `commit ${commitSeq} is partial`
        ).toHaveLength(all.filter((row) => row.commitSeq === commitSeq).length);
      }
      expect(result.pruned).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("a seat that is behind holds the floor where it is (OQ-13)", () => {
    const db = openVaultDb();
    try {
      capturedCommit(db, "seed", (vault) => {
        insertOwnerAndDevice(vault, "Phone");
      });
      seeded(db);
      const all = readReplicaLog(db.vault, { limit: 10_000 }).rows;
      // The phone has served only as far as the FIRST commit.
      const firstCommit = all[0]!.commitSeq;
      const behind = all.findLast((row) => row.commitSeq === firstCommit)!.seq;
      db.vault
        .prepare(
          `INSERT INTO access_device_secret (device_id, public_key)
           VALUES ('d1', 'k')`
        )
        .run();
      // The door records the cursor the device SENT, with the time it asked
      // (#1014, V1): a cursor with no time on it cannot pin, because nothing
      // can tell a live seat from an abandoned one.
      expect(recordSeatCursor(db.vault, "d1", behind)).toBe(true);
      expect(lowestSeatCursor(db.vault)).toBe(behind);

      // A prune that would otherwise take everything.
      const result = pruneReplicaLog(db.vault, {
        maxRows: 0,
        maxAgeMs: 0,
        now: new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000),
      });
      expect(result.heldBySeat).toBe(behind);
      // Everything the phone has not seen is still there.
      const remaining = readReplicaLog(db.vault, {
        since: result.floor,
        limit: 10_000,
      }).rows;
      expect(remaining.map((row) => row.seq)).toStrictEqual(
        all.filter((row) => row.seq > result.floor.seq).map((row) => row.seq)
      );
      expect(result.floor.seq).toBeLessThanOrEqual(behind);
    } finally {
      db.close();
    }
  });

  test("a cursor below the floor is told to re-bootstrap, not served short", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const before = readReplicaLog(db.vault, { limit: 10_000 }).rows[0]!;
      const stale = { epoch: before.epoch, seq: before.seq - 1 };
      pruneReplicaLog(db.vault, {
        maxRows: 0,
        maxAgeMs: 0,
        now: new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000),
      });
      expect(replicaLogState(db.vault).floor.seq).toBeGreaterThan(stale.seq);
      // The point of the floor: "start over" is said out loud, not served as
      // a silently incomplete page.
      expect(() => readReplicaLog(db.vault, { since: stale })).toThrow(
        ReplicaRebootstrapRequiredError
      );
    } finally {
      db.close();
    }
  });

  test("another epoch's rows go, whatever the age", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      db.vault
        .prepare(
          `UPDATE replica_log SET epoch = 'a-previous-contract' WHERE seq <= 2`
        )
        .run();
      const result = pruneReplicaLog(db.vault, {
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        maxRows: Number.MAX_SAFE_INTEGER,
      });
      expect(result.pruned).toBe(2);
      expect(
        (
          db.vault
            .prepare(
              `SELECT COUNT(*) AS n FROM replica_log WHERE epoch = 'a-previous-contract'`
            )
            .get() as { n: number }
        ).n
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("the producer bound", () => {
  test("is denominated in rows, and the threshold in compressed bytes", () => {
    // The two numbers are measured, and the relationship between them is the
    // property: a conforming commit cannot straddle the threshold.
    expect(REPLICA_PRODUCER_MAX_ROWS).toBe(2_000);
    expect(REPLICA_DEFER_THRESHOLD_BYTES).toBe(1_000_000);
    // 2,000 rows is ~38 KB gzip-6 at year-3 shape — under 4% of the
    // threshold, which is the headroom that makes the bound sufficient.
    expect(REPLICA_PRODUCER_MAX_ROWS * 700).toBeLessThan(
      REPLICA_DEFER_THRESHOLD_BYTES * 1.5
    );
  });

  test("a conforming commit is never compressed, and never deferred", () => {
    const db = openVaultDb();
    try {
      const captured = capturedCommit(db, "enrich", (vault) => {
        for (let index = 0; index < 50; index += 1)
          insertScheme(vault, `s${index}`);
      })!;
      expect(captured.rows).toBeLessThan(REPLICA_PRODUCER_MAX_ROWS);
      // Zero is "not measured", not "measured as empty": paying gzip on the
      // write path to learn a number the bound already guarantees is the cost
      // the bound exists to avoid.
      expect(captured.compressedBytes).toBe(0);
      expect(captured.deferred).toBe(false);
      expect(
        readReplicaLog(db.vault, { limit: 10_000 }).rows.every(
          (row) => !row.deferred
        )
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  test("the flag rides on every row of the commit, not on the page", () => {
    const db = openVaultDb();
    try {
      capturedCommit(db, "enrich", (vault) => {
        insertScheme(vault, "a");
        insertScheme(vault, "b");
      });
      const rows = readReplicaLog(db.vault, { limit: 10_000 }).rows;
      const perCommit = new Map<number, Set<boolean>>();
      for (const row of rows) {
        const seen = perCommit.get(row.commitSeq) ?? new Set<boolean>();
        seen.add(row.deferred);
        perCommit.set(row.commitSeq, seen);
      }
      // A commit is the unit a seat applies, so it is the unit a seat defers:
      // one verdict per commit, never a row a seat could skip alone.
      for (const [commitSeq, verdicts] of perCommit)
        expect(verdicts.size, `commit ${commitSeq}`).toBe(1);
    } finally {
      db.close();
    }
  });
});

// THE OTHER DIRECTION OF THE HOLD (#1014, T9). A hold with no bound is a hold
// forever: one phone that is lost, wiped or never opened again pins every log
// row above its cursor, which is the unbounded growth the retention window
// exists to stop. The bound is a named constant and it is tested from both
// sides — inside the window the seat still pins, past it the prune proceeds
// and that device re-bootstraps once, visibly.
describe("the seat hold's abandonment bound", () => {
  const dayMs = 24 * 60 * 60 * 1_000;

  function seatAt(db: VaultDb, deviceId: string, seq: number, at: Date): void {
    db.vault
      .prepare(
        `INSERT OR IGNORE INTO core_party
           (party_id, kind, display_name, created_at, updated_at)
         VALUES ('p1', 'person', 'Owner', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO access_device (device_id, owner_party_id, name, enrolled_at)
         VALUES (?, 'p1', ?, '2026-01-01T00:00:00.000Z')`
      )
      .run(deviceId, deviceId);
    db.vault
      .prepare(
        `INSERT INTO access_device_secret (device_id, public_key)
         VALUES (?, ?)`
      )
      .run(deviceId, `k-${deviceId}`);
    expect(recordSeatCursor(db.vault, deviceId, seq, at)).toBe(true);
  }

  test("a device seen inside the window still pins", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const now = new Date();
      seatAt(
        db,
        "recent",
        3,
        new Date(now.getTime() - (REPLICA_SEAT_HOLD_DAYS - 1) * dayMs)
      );
      expect(lowestSeatCursor(db.vault, { now })).toBe(3);
    } finally {
      db.close();
    }
  });

  test("a device not seen for the bound stops pinning, and the prune moves", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const now = new Date();
      seatAt(
        db,
        "lost",
        3,
        new Date(now.getTime() - (REPLICA_SEAT_HOLD_DAYS + 1) * dayMs)
      );
      expect(lowestSeatCursor(db.vault, { now })).toBeUndefined();
      const result = pruneReplicaLog(db.vault, {
        maxRows: 0,
        maxAgeMs: 0,
        now: new Date(now.getTime() + 10 * dayMs),
      });
      expect(result.heldBySeat).toBeUndefined();
      expect(result.pruned).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("the lowest LIVE cursor wins, not the lowest cursor", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const now = new Date();
      seatAt(db, "live", 4, now);
      seatAt(
        db,
        "abandoned",
        1,
        new Date(now.getTime() - (REPLICA_SEAT_HOLD_DAYS + 5) * dayMs)
      );
      expect(lowestSeatCursor(db.vault, { now })).toBe(4);
    } finally {
      db.close();
    }
  });

  test("the door's record never moves a seat's cursor backwards", () => {
    const db = openVaultDb();
    try {
      const now = new Date();
      seatAt(db, "d1", 9, now);
      // A retry or an out-of-order page must not un-advance the hold.
      expect(recordSeatCursor(db.vault, "d1", 4, now)).toBe(false);
      expect(lowestSeatCursor(db.vault, { now })).toBe(9);
      expect(recordSeatCursor(db.vault, "d1", 11, now)).toBe(true);
      expect(lowestSeatCursor(db.vault, { now })).toBe(11);
    } finally {
      db.close();
    }
  });
});

// ONE FLOOR, BECAUSE THERE IS ONE LOG (#1014, G1/G2; ruling R-1014-1).
//
// There used to be two logs counted in unrelated sequence spaces — the trigger
// log ran roughly nineteen rows to the session log's one — and both pruners
// wrote `replica_meta.floor_seq`. That was the loop: a trigger-log prune
// stamped a floor far above `MAX(replica_log.seq)`, every seat cursor then
// failed `since.seq < floor` into a `retention` verdict, the snapshot stamped
// the floor back down, and the next tail said `retention` again — with nothing
// applied and nothing surfaced. An epoch bump did the same thing from the
// other direction.
//
// The repair is not a second column; it is one log. These assertions are what
// "one" has to mean: the file carries a single floor, it is derived from the
// rows this log actually holds, and nothing else may write it.
describe("one log, one floor", () => {
  function seat(db: VaultDb, deviceId: string, seq: number): void {
    db.vault
      .prepare(
        `INSERT OR IGNORE INTO core_party
           (party_id, kind, display_name, created_at, updated_at)
         VALUES ('p1', 'person', 'Owner', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO access_device (device_id, owner_party_id, name, enrolled_at)
         VALUES (?, 'p1', ?, '2026-01-01T00:00:00.000Z')`
      )
      .run(deviceId, deviceId);
    db.vault
      .prepare(
        `INSERT INTO access_device_secret (device_id, public_key) VALUES (?, ?)`
      )
      .run(deviceId, `k-${deviceId}`);
    expect(recordSeatCursor(db.vault, deviceId, seq)).toBe(true);
  }

  test("the file carries one floor column and no second sequence space", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const columns = (
        db.vault.prepare("PRAGMA table_info(replica_meta)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      expect(columns).toContain("floor_seq");
      expect(columns).not.toContain("change_floor_seq");
      expect(
        db.vault
          .prepare(
            `SELECT name FROM sqlite_sequence WHERE name LIKE 'replica\\_%' ESCAPE '\\'`
          )
          .all()
          .map((row) => (row as { name: string }).name)
      ).toStrictEqual(["replica_log"]);
    } finally {
      db.close();
    }
  });

  test("an epoch bump derives the floor from the log the file has", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const high = readReplicaLog(db.vault, { limit: 10_000 }).rows.at(-1)!.seq;
      bumpReplicaEpoch(db.vault, { reason: "one-log" });
      const meta = db.vault
        .prepare(`SELECT floor_seq FROM replica_meta WHERE singleton = 1`)
        .get() as { floor_seq: number };
      // ITS OWN high-water mark, never another counter's — which is what used
      // to skip every real row while reporting caught-up, because
      // `watermark === floor`.
      expect(meta.floor_seq).toBe(high);
      expect(replicaLogState(db.vault).watermark.seq).toBe(high);
    } finally {
      db.close();
    }
  });

  test("a prune and an epoch bump under two live seats strand neither", () => {
    const db = openVaultDb();
    try {
      seeded(db);
      const rows = readReplicaLog(db.vault, { limit: 10_000 }).rows;
      const firstCommit = rows[0]!.commitSeq;
      const behind = rows.findLast((row) => row.commitSeq === firstCommit)!.seq;
      seat(db, "phone", behind);
      seat(db, "laptop", rows.at(-1)!.seq);

      const pruned = pruneReplicaLog(db.vault, {
        maxRows: 0,
        maxAgeMs: 0,
        now: new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000),
      });
      // The seat that is furthest behind is the one that sets the floor.
      expect(pruned.heldBySeat).toBe(behind);
      expect(pruned.floor.seq).toBeLessThanOrEqual(behind);

      // NEITHER cursor is below the floor, so neither seat is told to start
      // over: a page from each is served, not refused.
      for (const cursor of [behind, rows.at(-1)!.seq]) {
        expect(() =>
          readReplicaLog(db.vault, {
            since: { epoch: rows[0]!.epoch, seq: cursor },
            limit: 10_000,
          })
        ).not.toThrow();
      }
      // And the phone still gets exactly the rows it had not applied.
      expect(
        readReplicaLog(db.vault, {
          since: { epoch: rows[0]!.epoch, seq: behind },
          limit: 10_000,
        }).rows.map((row) => row.seq)
      ).toStrictEqual(
        rows.filter((row) => row.seq > behind).map((row) => row.seq)
      );
    } finally {
      db.close();
    }
  });
});
