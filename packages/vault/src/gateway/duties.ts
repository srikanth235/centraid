// Standing duties (§10) — the work between requests. Not request-shaped, but
// each duty still writes receipts and provenance like any caller would.
//
// Implemented here: revocation cascade, lifecycle sweeps (expiry, purge_at,
// retention policy), ingest customs. Confirmation routing lives on the
// Gateway (the pause is gateway state); the view service in views.ts; file
// custody in custody.ts; export & portability in portability.ts.

import type { VaultDb } from '../db.js';
import { nowIso } from '../ids.js';
import { resolveEntity } from '../schema/tables.js';
import { deleteAppExt } from './custody.js';
import { writeProvenance, writeReceipt } from './evidence.js';
import { tableColumns } from './filters.js';
import type { Identity } from './types.js';

export interface RevocationResult {
  grantId: string;
  viewsRevoked: number;
  parkedDropped: number;
  appExtDeleted: boolean;
  receiptId: string;
}

/**
 * Revocation cascade: revoking a grant is instant and total. The grant goes
 * dark, the grantee app's registered views are invalidated, parked
 * invocations under it are dropped, and once its last grant dies the app's
 * extension file is deleted (uninstall = revoke grant + delete file, R09) —
 * while the model, history and receipts remain (the §11 success test).
 */
export function revokeGrantCascade(
  db: VaultDb,
  owner: Identity,
  grantId: string,
  dropParked: (grantId: string) => number,
): RevocationResult {
  const now = nowIso();
  const grant = db.vault
    .prepare('SELECT grant_id, app_id FROM consent_access_grant WHERE grant_id = ?')
    .get(grantId) as { grant_id: string; app_id: string | null } | undefined;
  if (!grant) throw new Error(`no grant ${grantId}`);
  db.vault
    .prepare(`UPDATE consent_access_grant SET status='revoked', revoked_at=? WHERE grant_id=?`)
    .run(now, grantId);
  let viewsRevoked = 0;
  let appExtDeleted = false;
  if (grant.app_id !== null) {
    const stillGranted = db.vault
      .prepare(
        `SELECT count(*) AS n FROM consent_access_grant WHERE app_id = ? AND status = 'active' AND revoked_at IS NULL`,
      )
      .get(grant.app_id) as { n: number };
    if (stillGranted.n === 0) {
      const res = db.vault
        .prepare(`UPDATE consent_app_view SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL`)
        .run(now, grant.app_id);
      viewsRevoked = Number(res.changes);
      appExtDeleted = deleteAppExt(db, grant.app_id);
    }
  }
  const parkedDropped = dropParked(grantId);
  const receiptId = writeReceipt(db.journal, {
    grantId,
    invocationId: null,
    action: 'act consent.revoke_grant',
    objectType: 'consent.access_grant',
    objectId: grantId,
    purpose: null,
    decision: 'allow',
    detail: { viewsRevoked, parkedDropped, appExtDeleted, revokedBy: owner.partyId },
  });
  writeProvenance(db.journal, owner, 'consent.access_grant', grantId, 'owner.revoke');
  return { grantId, viewsRevoked, parkedDropped, appExtDeleted, receiptId };
}

export interface SweepResult {
  grantsExpired: number;
  sharesExpired: number;
  contentPurged: number;
  retentionDeleted: number;
  receiptId: string;
}

/**
 * consent.policy kind='retention': delete rows older than retention_days in
 * the policy's schema.table. The timestamp column comes from
 * rule_json.timestamp_column (default created_at) and must exist — a
 * misconfigured policy deletes nothing rather than the wrong thing.
 */
function enforceRetention(db: VaultDb, now: string): number {
  const policies = db.vault
    .prepare(
      `SELECT applies_schema, applies_table, retention_days, rule_json FROM consent_policy
        WHERE kind = 'retention' AND retention_days IS NOT NULL AND applies_table IS NOT NULL
          AND effective_from <= ?
        ORDER BY priority ASC`,
    )
    .all(now) as {
    applies_schema: string;
    applies_table: string;
    retention_days: number;
    rule_json: string;
  }[];
  let deleted = 0;
  for (const policy of policies) {
    const ref = resolveEntity(`${policy.applies_schema}.${policy.applies_table}`);
    if (!ref || ref.file !== 'vault') continue;
    const rule = JSON.parse(policy.rule_json) as { timestamp_column?: string };
    const tsColumn = rule.timestamp_column ?? 'created_at';
    if (!tableColumns(db.vault, ref.physical).has(tsColumn)) continue;
    const cutoff = new Date(Date.parse(now) - policy.retention_days * 86_400_000).toISOString();
    const result = db.vault
      .prepare(`DELETE FROM "${ref.physical}" WHERE "${tsColumn}" < ?`)
      .run(cutoff);
    deleted += Number(result.changes);
  }
  return deleted;
}

/**
 * Lifecycle sweep: lapse grants and shares at expires_at, execute purge_at
 * deletions (GDPR storage limitation), enforce retention policy. Run on a
 * schedule or after unlock.
 */
export function sweepLifecycle(db: VaultDb, owner: Identity): SweepResult {
  const now = nowIso();
  const grants = db.vault
    .prepare(
      `UPDATE consent_access_grant SET status='expired'
        WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(now);
  const shares = db.vault
    .prepare(
      `UPDATE consent_share SET revoked_at=?
        WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(now, now);
  const purgeable = db.vault
    .prepare(
      `SELECT content_id FROM core_content_item WHERE purge_at IS NOT NULL AND purge_at <= ?`,
    )
    .all(now) as { content_id: string }[];
  for (const row of purgeable) {
    // The row disappears; its provenance trail in journal.db remains.
    // A trashed media asset over these bytes goes with them — the asset row
    // references the content (NOT NULL), so purging one must purge both.
    const asset = db.vault
      .prepare('SELECT asset_id FROM media_media_asset WHERE content_id = ?')
      .get(row.content_id) as { asset_id: string } | undefined;
    if (asset) {
      writeProvenance(db.journal, owner, 'media.media_asset', asset.asset_id, 'sweep.purge');
      db.vault.prepare('DELETE FROM media_face_region WHERE asset_id = ?').run(asset.asset_id);
      db.vault.prepare('DELETE FROM media_album_entry WHERE asset_id = ?').run(asset.asset_id);
      db.vault
        .prepare('UPDATE media_album SET cover_asset_id = NULL WHERE cover_asset_id = ?')
        .run(asset.asset_id);
      db.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(asset.asset_id);
    }
    writeProvenance(db.journal, owner, 'core.content_item', row.content_id, 'sweep.purge');
    db.vault.prepare('DELETE FROM core_content_item WHERE content_id = ?').run(row.content_id);
  }
  const retentionDeleted = enforceRetention(db, now);
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act consent.lifecycle_sweep',
    objectType: 'consent.policy',
    objectId: null,
    purpose: null,
    decision: 'allow',
    detail: {
      grantsExpired: Number(grants.changes),
      sharesExpired: Number(shares.changes),
      contentPurged: purgeable.length,
      retentionDeleted,
    },
  });
  return {
    grantsExpired: Number(grants.changes),
    sharesExpired: Number(shares.changes),
    contentPurged: purgeable.length,
    retentionDeleted,
    receiptId,
  };
}

/**
 * Ingest customs — the border post. Import batches dedupe on external_id,
 * stamp per-row provenance, and resolve raw handles to identities via
 * party_identifier. Returns null when the external id was already imported.
 */
export function admitImportedRow(
  db: VaultDb,
  importer: Identity,
  entityType: string,
  externalIdColumn: { physical: string; column: string },
  externalId: string,
  insert: () => string,
  batch: string,
): string | null {
  const existing = db.vault
    .prepare(
      `SELECT 1 AS x FROM "${externalIdColumn.physical}" WHERE "${externalIdColumn.column}" = ?`,
    )
    .get(externalId);
  if (existing) return null;
  const entityId = insert();
  writeProvenance(db.journal, importer, entityType, entityId, `import.${batch}`, {
    external_id: externalId,
  });
  return entityId;
}

/** Resolve a raw handle (email, tel…) to a party via party_identifier. */
export function resolveHandle(db: VaultDb, scheme: string, value: string): string | null {
  const row = db.vault
    .prepare(
      `SELECT party_id FROM core_party_identifier
        WHERE scheme = ? AND value = ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY is_primary DESC LIMIT 1`,
    )
    .get(scheme, value, nowIso()) as { party_id: string } | undefined;
  return row?.party_id ?? null;
}
