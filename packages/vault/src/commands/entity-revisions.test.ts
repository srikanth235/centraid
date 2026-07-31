// Undo-window garbage collection for the P5 revision ledger (issue #659 L1).
// The law: a pass deletes exactly the snapshots the store's own reader
// already refuses (`undo_until < now`), bounded per run.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { pruneExpiredEntityRevisions } from "./entity-revisions.js";

const NOW = "2026-07-31T00:00:00.000Z";

let db: VaultDb;

function seedRevision(id: string, undoUntil: string, undone = false): void {
  db.vault
    .prepare(
      `INSERT INTO core_entity_revision
         (revision_id, entity_type, entity_id, operation, snapshot_json,
          recorded_at, undo_until, undone_at, actor_party_id)
       VALUES (:id, 'core.party', 'party-1', 'update', '{"a":1}',
               '2026-01-01T00:00:00.000Z', :undoUntil, :undoneAt, NULL)`
    )
    .run({
      id,
      undoUntil,
      undoneAt: undone ? "2026-01-01T00:00:10.000Z" : null,
    });
}

function remaining(): string[] {
  return (
    db.vault
      .prepare("SELECT revision_id FROM core_entity_revision ORDER BY 1")
      .all() as { revision_id: string }[]
  ).map((r) => r.revision_id);
}

describe(pruneExpiredEntityRevisions, () => {
  beforeEach(() => {
    db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
  });

  test("drops only revisions whose undo window has closed", () => {
    seedRevision("rev-expired", "2026-07-30T23:59:00.000Z");
    seedRevision("rev-expired-undone", "2026-07-30T23:59:00.000Z", true);
    seedRevision("rev-open", "2026-07-31T00:00:10.000Z");

    const result = pruneExpiredEntityRevisions(db.vault, NOW);

    expect(result).toStrictEqual({ deleted: 2, capped: false });
    expect(remaining()).toStrictEqual(["rev-open"]);
  });

  test("a pass is capped and says when there is more to drain", () => {
    for (let i = 0; i < 7; i += 1)
      seedRevision(`rev-${i}`, `2026-07-30T00:00:0${i.toString()}.000Z`);

    const first = pruneExpiredEntityRevisions(db.vault, NOW, { limit: 3 });
    expect(first).toStrictEqual({ deleted: 3, capped: true });
    // Oldest first, so a capped pass drains in undo-window order.
    expect(remaining()).toStrictEqual(["rev-3", "rev-4", "rev-5", "rev-6"]);

    pruneExpiredEntityRevisions(db.vault, NOW, { limit: 3 });
    const third = pruneExpiredEntityRevisions(db.vault, NOW, { limit: 3 });
    expect(third).toStrictEqual({ deleted: 1, capped: false });
    expect(remaining()).toStrictEqual([]);
  });

  test("a pass with nothing expired writes nothing", () => {
    seedRevision("rev-open", "2026-07-31T00:00:10.000Z");
    const before = (
      db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;
    expect(pruneExpiredEntityRevisions(db.vault, NOW).deleted).toBe(0);
    expect(
      (db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }).n
    ).toBe(before);
  });
});
