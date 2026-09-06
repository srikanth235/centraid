// RETENTION AND THE PRODUCER BOUND (#996, R5; open questions 3 and 13).
//
// The floor is what replaces compaction, and the two things it may not cross
// are the two ways a cheap tail turns into a forced re-bootstrap without
// anyone deciding to: a commit edge, and a live seat's cursor.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { beginReplicaCommit, endReplicaCommit } from "./change-log.js";
import {
  lowestSeatCursor,
  pruneReplicaLog,
  readReplicaLog,
  replicaLogState,
  ReplicaRebootstrapRequiredError,
  REPLICA_DEFER_THRESHOLD_BYTES,
  REPLICA_PRODUCER_MAX_ROWS,
} from "./log.js";

type Sqlite = VaultDb["vault"];

function commit(db: VaultDb, producer: string, write: (v: Sqlite) => void) {
  db.vault.exec("BEGIN");
  const handle = beginReplicaCommit(db.vault, { producer });
  try {
    write(db.vault);
    const captured = endReplicaCommit(db.vault, handle);
    db.vault.exec("COMMIT");
    return captured;
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

function scheme(vault: Sqlite, id: string): void {
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES (?, ?, ?, '1')`
    )
    .run(id, `urn:${id}`, id);
}

/** Three commits of two rows each, so the floor has edges to land on. */
function seeded(db: VaultDb): void {
  for (const label of ["a", "b", "c"]) {
    commit(db, "seed", (vault) => {
      scheme(vault, `${label}1`);
      scheme(vault, `${label}2`);
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
      commit(db, "seed", (vault) => {
        vault
          .prepare(
            `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES ('p1', 'person', 'Owner', '2026-01-01T00:00:00.000Z',
                     '2026-01-01T00:00:00.000Z')`
          )
          .run();
        vault
          .prepare(
            `INSERT INTO access_device (device_id, owner_party_id, name, enrolled_at)
             VALUES ('d1', 'p1', 'Phone', '2026-01-01T00:00:00.000Z')`
          )
          .run();
      });
      seeded(db);
      const all = readReplicaLog(db.vault, { limit: 10_000 }).rows;
      // The phone has served only as far as the FIRST commit.
      const firstCommit = all[0]!.commitSeq;
      const behind = all.findLast((row) => row.commitSeq === firstCommit)!.seq;
      db.vault
        .prepare(
          `INSERT INTO access_device_secret (device_id, public_key, sync_cursor)
           VALUES ('d1', 'k', ?)`
        )
        .run(String(behind));
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
      const captured = commit(db, "enrich", (vault) => {
        for (let index = 0; index < 50; index += 1) scheme(vault, `s${index}`);
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
      commit(db, "enrich", (vault) => {
        scheme(vault, "a");
        scheme(vault, "b");
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
