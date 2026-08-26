// Demo-data purge (#290): loading is safe because unloading is one act.
// Same lifecycle duties as any hard delete (#272/#274). Provenance records
// the purge; receipts stay — history is never rewritten.

import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { cleanupPolyRefs } from "../schema/poly-refs.js";
import { SEED_PURGE_ACTIVITY } from "../schema/seed.js";
import { resolveEntity } from "../schema/tables.js";
import { writeProvenance, writeReceipt } from "./evidence.js";
import { pkColumn } from "./execution.js";
import type { Identity } from "./types.js";

export interface DemoPurgeResult {
  purged: number;
  missing: number;
  /** Non-demo FK still holds these — left in place, still registered. */
  blocked: { entityType: string; entityId: string }[];
  receiptId: string;
}

/**
 * Clear these FIRST or the parent FK refuses. Same doctrine as
 * gateway/duties.ts: derivatives go with their parent. Without this, a
 * seeded image's `core_content_derivative` hostage-holds the content item
 * and one-click purge reports blocked forever. Only rebuildable projections
 * (thumb/phash regenerate from bytes).
 */
const DEPENDENT_ROWS: Record<string, { table: string; column: string }[]> = {
  "core.content_item": [
    { table: "core_content_derivative", column: "content_id" },
  ],
  // Import rows cannot outlive the batch (FK). Without this, Photos' staged
  // face proposals (#712) block purge forever. Not rebuildable, but the
  // batch is going — a line item of a deleted batch describes nothing.
  "sync.import_batch": [{ table: "sync_import_row", column: "batch_id" }],
};

interface SeedRow {
  seed_id: string;
  app_id: string;
  target_type: string;
  target_id: string;
}

export function demoStatus(db: VaultDb): { appId: string; rows: number }[] {
  const rows = db.vault
    .prepare(
      `SELECT app_id, count(*) AS n FROM consent_seed_row GROUP BY app_id ORDER BY app_id`
    )
    .all() as { app_id: string; n: number }[];
  return rows.map((r) => ({ appId: r.app_id, rows: r.n }));
}

/**
 * Newest-first (UUIDv7 = insertion order, children after parents), then
 * repeat until a pass makes no progress. Remainder is a NON-demo FK —
 * refuse rather than force-delete; the owner may have built on a demo row.
 */
export function purgeDemoRows(
  db: VaultDb,
  owner: Identity,
  appId?: string
): DemoPurgeResult {
  const now = nowIso();
  const rows = db.vault
    .prepare(
      `SELECT seed_id, app_id, target_type, target_id FROM consent_seed_row
        ${appId ? "WHERE app_id = ?" : ""} ORDER BY seed_id DESC`
    )
    .all(...(appId ? [appId] : [])) as unknown as SeedRow[];

  const dropSeed = db.vault.prepare(
    "DELETE FROM consent_seed_row WHERE seed_id = ?"
  );

  let purged = 0;
  let missing = 0;
  const purgedIds: SeedRow[] = [];
  let remaining = rows;
  let progressed = true;
  while (progressed && remaining.length > 0) {
    progressed = false;
    const blocked: SeedRow[] = [];
    for (const row of remaining) {
      const ref = resolveEntity(row.target_type, db.vault);
      if (!ref || ref.file !== "vault") {
        // Unresolvable (purged ext band): retire the registry entry.
        dropSeed.run(row.seed_id);
        missing += 1;
        progressed = true;
        continue;
      }
      const pk = pkColumn(db.vault, ref.physical);
      // Savepoint: derived rows stay if the parent is blocked.
      db.vault.exec("SAVEPOINT demo_purge_row");
      try {
        for (const dep of DEPENDENT_ROWS[row.target_type] ?? [])
          db.vault
            .prepare(`DELETE FROM "${dep.table}" WHERE "${dep.column}" = ?`)
            .run(row.target_id);
        const res = db.vault
          .prepare(`DELETE FROM "${ref.physical}" WHERE "${pk}" = ?`)
          .run(row.target_id);
        if (Number(res.changes) === 0) missing += 1;
        else {
          purged += 1;
          purgedIds.push(row);
          cleanupPolyRefs(db.vault, now, row.target_type, row.target_id);
        }
        dropSeed.run(row.seed_id);
        progressed = true;
        db.vault.exec("RELEASE demo_purge_row");
      } catch {
        // FK still holds. Another pass may free it; otherwise report.
        db.vault.exec("ROLLBACK TO demo_purge_row");
        db.vault.exec("RELEASE demo_purge_row");
        blocked.push(row);
      }
    }
    remaining = blocked;
  }

  for (const row of purgedIds) {
    writeProvenance(
      db.journal,
      owner,
      row.target_type,
      row.target_id,
      SEED_PURGE_ACTIVITY
    );
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: "act consent.demo_purge",
    objectType: "consent.seed_row",
    objectId: appId ?? null,
    purpose: null,
    decision: "allow",
    detail: {
      purged,
      missing,
      blocked: remaining.map((r) => `${r.target_type}:${r.target_id}`),
      by: owner.partyId,
    },
  });
  return {
    purged,
    missing,
    blocked: remaining.map((r) => ({
      entityType: r.target_type,
      entityId: r.target_id,
    })),
    receiptId,
  };
}
