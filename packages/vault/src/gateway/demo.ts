import type { VaultDb } from "../db.js";
import { SEED_PURGE_ACTIVITY } from "../schema/seed.js";
import { resolveEntity } from "../schema/tables.js";
import { writeProvenance, writeReceipt } from "./evidence.js";
import { pkColumn } from "./execution.js";
import type { Identity } from "./types.js";

export interface DemoPurgeResult {
  purged: number;
  missing: number;
  blocked: { entityType: string; entityId: string }[];
  receiptId: string;
}

const DEPENDENT_ROWS: Record<string, { table: string; column: string }[]> = {
  "core.content_item": [
    { table: "core_content_derivative", column: "content_id" },
  ],
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
      `SELECT app_id, count(*) AS n FROM access_seed_row GROUP BY app_id ORDER BY app_id`
    )
    .all() as { app_id: string; n: number }[];
  return rows.map((r) => ({ appId: r.app_id, rows: r.n }));
}

export function purgeDemoRows(
  db: VaultDb,
  owner: Identity,
  appId?: string
): DemoPurgeResult {
  const rows = db.vault
    .prepare(
      `SELECT seed_id, app_id, target_type, target_id FROM access_seed_row
        ${appId ? "WHERE app_id = ?" : ""} ORDER BY seed_id DESC`
    )
    .all(...(appId ? [appId] : [])) as unknown as SeedRow[];

  const dropSeed = db.vault.prepare(
    "DELETE FROM access_seed_row WHERE seed_id = ?"
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
      if (!ref) {
        dropSeed.run(row.seed_id);
        missing += 1;
        progressed = true;
        continue;
      }
      const pk = pkColumn(db.vault, ref.physical);
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
        }
        dropSeed.run(row.seed_id);
        progressed = true;
        db.vault.exec("RELEASE demo_purge_row");
      } catch {
        db.vault.exec("ROLLBACK TO demo_purge_row");
        db.vault.exec("RELEASE demo_purge_row");
        blocked.push(row);
      }
    }
    remaining = blocked;
  }

  for (const row of purgedIds) {
    writeProvenance(
      db.audit,
      owner,
      row.target_type,
      row.target_id,
      SEED_PURGE_ACTIVITY
    );
  }
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act access.demo_purge",
    objectType: "access.seed_row",
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
