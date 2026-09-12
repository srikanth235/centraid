/*
 * DERIVED DATA IS NOT AUTOMATICALLY LOCAL DATA (#1014, B10, ruling R-1014-5).
 *
 * The finding was that enrichment writes replicate to every seat: 512-float
 * vectors and a provenance stamp per derivation, appended to the log for every
 * seat, on a 50k library. The tempting rule — "derived data does not
 * replicate" — is wrong, and this file is the audit that says why.
 *
 * THE TEST THAT ACTUALLY DECIDES IT is not "was this derived?" but "does a
 * SEAT READ IT, or does a replicated row point at it?" A seat holds `vault.db`
 * whole: no row filters and no field masks (#996, R1), so a table travels or
 * it does not, and a replicated table may not reference a private one.
 *
 * Each row below is that judgement, pinned. Flipping one is an edit to this
 * file with a reason, never a silent consequence of adding a column.
 */

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { LOCAL_TABLES } from "./local-tables.js";
import { isPrivateTable, isReplicatedTable } from "./private-tables.js";

interface Judgement {
  readonly table: string;
  readonly replicated: boolean;
  /** What makes the answer the one it is. */
  readonly because: string;
}

const DERIVED_TABLES: readonly Judgement[] = [
  {
    table: "enrich_embedding",
    replicated: true,
    because:
      "the seat's offline face ranking is `vec_distance_cosine` over these " +
      "bytes (docs/mobile-offline.md); sqlite-vec is bundled and loaded on " +
      "the phone for exactly this",
  },
  {
    table: "enrich_derivation",
    replicated: true,
    because:
      "`core_content_text.derivation_id` REFERENCES it, and that table " +
      "replicates — a replicated row may not point at a private table " +
      "(#996, R4); it is also what the seat shows as a value's provenance",
  },
  {
    table: "enrich_request",
    replicated: false,
    because: "the enrichment queue is gateway WORK, and no seat reads it",
  },
  {
    table: "enrich_target_failure",
    replicated: false,
    because:
      "one host's count of what IT could not derive; a restore re-derives " +
      "it by attempting the work again",
  },
  {
    table: "media_asset_phash",
    replicated: true,
    because:
      "the seat's library page reads `media.asset_phash` for its duplicate " +
      "shelf",
  },
  {
    table: "media_face_cluster",
    replicated: true,
    because:
      "PhotosPeopleView walks `media_face_cluster` on the seat for the " +
      "unnamed-group shelf",
  },
  {
    table: "media_memory",
    replicated: true,
    because: "the seat's Memories screen reads it",
  },
  {
    table: "media_memory_member",
    replicated: true,
    because: "the members of a memory the seat renders",
  },
];

describe("derived enrichment tables", () => {
  test("every one of them is classified as this audit says", () => {
    for (const entry of DERIVED_TABLES) {
      expect(
        isReplicatedTable(entry.table),
        `${entry.table}: ${entry.because}`
      ).toBe(entry.replicated);
      expect(isPrivateTable(entry.table), entry.table).toBe(!entry.replicated);
    }
  });

  test("the audit names tables a fresh vault really carries", () => {
    // Not vacuous: a renamed table must fail here rather than pass by absence.
    const db = openVaultDb();
    try {
      const physical = new Set(
        (
          db.vault
            .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
            .all() as { name: string }[]
        ).map((row) => row.name)
      );
      for (const entry of DERIVED_TABLES)
        expect(physical.has(entry.table), entry.table).toBe(true);
    } finally {
      db.vault.close();
    }
  });

  test("a derived table that no seat reads is ALSO unregistered", () => {
    // Private means "does not reach a seat"; unregistered means "outside the
    // canonical walk" — no export, no change-log trigger, no consent scope.
    // A gateway-local failure counter is both; the enrichment QUEUE is not,
    // because a member's explicit request is data they made.
    expect(LOCAL_TABLES.has("enrich_target_failure")).toBe(true);
    expect(LOCAL_TABLES.has("enrich_request")).toBe(false);
  });
});
