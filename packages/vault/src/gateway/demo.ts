// Demo-data purge (issue #290 phase 1) — the second half of the scenario
// contract: loading demo data is only safe because unloading it is one act.
// Purge walks the seed registry, hard-deletes the physical rows, and runs the
// same lifecycle duties any hard delete owes (end-date links, drop tags and
// collection entries — the sweep's doctrine, issue #272/#274). Provenance
// records the purge; receipts stay: history is never rewritten.

import { nowIso } from '../ids.js';
import type { VaultDb } from '../db.js';
import { resolveEntity } from '../schema/tables.js';
import { cleanupPolyRefs } from '../schema/poly-refs.js';
import { SEED_PURGE_ACTIVITY } from '../schema/seed.js';
import { pkColumn } from './execution.js';
import { writeProvenance, writeReceipt } from './evidence.js';
import type { Identity } from './types.js';

export interface DemoPurgeResult {
  /** Physical rows deleted. */
  purged: number;
  /** Registry rows whose entity was already gone (deleted through an app). */
  missing: number;
  /** Rows a non-demo FK still references — left in place, still registered. */
  blocked: { entityType: string; entityId: string }[];
  receiptId: string;
}

interface SeedRow {
  seed_id: string;
  app_id: string;
  target_type: string;
  target_id: string;
}

/** Rows seeded per app — the "demo data present" surface. */
export function demoStatus(db: VaultDb): { appId: string; rows: number }[] {
  const rows = db.vault
    .prepare(`SELECT app_id, count(*) AS n FROM consent_seed_row GROUP BY app_id ORDER BY app_id`)
    .all() as { app_id: string; n: number }[];
  return rows.map((r) => ({ appId: r.app_id, rows: r.n }));
}

/**
 * Purge every seeded row (optionally one app's). Deletion runs newest-first
 * (seed ids are UUIDv7, so registry order IS insertion order and children
 * seeded after their parents delete before them), then repeats until a pass
 * makes no progress — whatever remains is held by a NON-demo reference and
 * is reported blocked rather than force-deleted: the owner may have built
 * real data on top of a demo row, and honest refusal beats a broken FK web.
 */
export function purgeDemoRows(db: VaultDb, owner: Identity, appId?: string): DemoPurgeResult {
  const now = nowIso();
  const rows = db.vault
    .prepare(
      `SELECT seed_id, app_id, target_type, target_id FROM consent_seed_row
        ${appId ? 'WHERE app_id = ?' : ''} ORDER BY seed_id DESC`,
    )
    .all(...(appId ? [appId] : [])) as unknown as SeedRow[];

  const dropSeed = db.vault.prepare('DELETE FROM consent_seed_row WHERE seed_id = ?');

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
      if (!ref || ref.file !== 'vault') {
        // An unresolvable registry row (e.g. a purged ext band) has nothing
        // left to delete — retire the registry entry.
        dropSeed.run(row.seed_id);
        missing += 1;
        progressed = true;
        continue;
      }
      const pk = pkColumn(db.vault, ref.physical);
      try {
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
      } catch {
        // FK constraint: something still references this row. Another pass
        // may free it (a sibling demo row deletes first); otherwise report.
        blocked.push(row);
      }
    }
    remaining = blocked;
  }

  for (const row of purgedIds) {
    writeProvenance(db.journal, owner, row.target_type, row.target_id, SEED_PURGE_ACTIVITY);
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act consent.demo_purge',
    objectType: 'consent.seed_row',
    objectId: appId ?? null,
    purpose: null,
    decision: 'allow',
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
    blocked: remaining.map((r) => ({ entityType: r.target_type, entityId: r.target_id })),
    receiptId,
  };
}
