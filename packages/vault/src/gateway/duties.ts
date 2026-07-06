// Standing duties (§10) — the work between requests. Not request-shaped, but
// each duty still writes receipts and provenance like any caller would.
//
// Implemented here: revocation cascade, lifecycle sweeps (expiry, purge_at,
// retention policy), ingest customs. Confirmation routing lives on the
// Gateway (the pause is gateway state); the view service in views.ts; file
// custody in custody.ts; export & portability in portability.ts.

import type { VaultDb } from '../db.js';
import { nowIso } from '../ids.js';
import { sweepBlobStaging } from '../blob/staging.js';
import { shaOfBlobUri } from '../blob/store.js';
import { resolveEntity } from '../schema/tables.js';
import { retainExtBand } from './ext.js';
import { writeScopeTombstones } from '../install-memory.js';
import { writeProvenance, writeReceipt } from './evidence.js';
import { tableColumns } from './filters.js';
import type { Identity } from './types.js';

export interface RevocationResult {
  grantId: string;
  /** The grantee app's Centraid id (consent_app.name), when app-shaped. */
  appId: string | null;
  viewsRevoked: number;
  parkedDropped: number;
  /** Live ext tables marked `retained` because the app's last grant died. */
  extRetained: string[];
  receiptId: string;
}

/**
 * Revocation cascade: revoking a grant is instant and total. The grant goes
 * dark, the grantee app's registered views are invalidated, parked
 * invocations under it are dropped, and once its last grant dies the app's
 * ext band is RETAINED — the data stays in the vault (it is the owner's),
 * app access is gone, and the owner purges explicitly when they mean it
 * (issue #286 phase 2: uninstall = retain + purge policy) — while the
 * model, history and receipts remain (the §11 success test).
 */
export function revokeGrantCascade(
  db: VaultDb,
  owner: Identity,
  grantId: string,
  dropParked: (grantId: string) => number,
): RevocationResult {
  const now = nowIso();
  const grant = db.vault
    .prepare('SELECT grant_id, app_id, grantee_party_id FROM consent_access_grant WHERE grant_id = ?')
    .get(grantId) as
    | { grant_id: string; app_id: string | null; grantee_party_id: string | null }
    | undefined;
  if (!grant) throw new Error(`no grant ${grantId}`);
  db.vault
    .prepare(`UPDATE consent_access_grant SET status='revoked', revoked_at=? WHERE grant_id=?`)
    .run(now, grantId);
  // The owner's "no" outlives the grant row (issue #308 A4): tombstone each
  // revoked scope triple so the install-grant top-up can never silently
  // re-mint it on the next mount/sync/publish. Uninstall clears these — a
  // reinstall is a fresh consent.
  const revokedScopes = db.vault
    .prepare(`SELECT schema_name, table_name, verbs FROM consent_grant_scope WHERE grant_id = ?`)
    .all(grantId) as { schema_name: string; table_name: string | null; verbs: string }[];
  const tombstoned =
    grant.app_id !== null || grant.grantee_party_id !== null
      ? writeScopeTombstones(
          db,
          grant.app_id !== null
            ? { appId: grant.app_id }
            : { granteePartyId: grant.grantee_party_id as string },
          revokedScopes.map((s) => ({ schema: s.schema_name, table: s.table_name, verbs: s.verbs })),
        )
      : 0;
  let viewsRevoked = 0;
  let extRetained: string[] = [];
  let centraidAppId: string | null = null;
  if (grant.app_id !== null) {
    // consent_app.app_id is a row uuid; the ext band (like the code store)
    // keys on the Centraid app id, which enrollment carries as `name`.
    const appRow = db.vault
      .prepare('SELECT name FROM consent_app WHERE app_id = ?')
      .get(grant.app_id) as { name: string } | undefined;
    centraidAppId = appRow?.name ?? null;
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
      if (centraidAppId) extRetained = retainExtBand(db, centraidAppId);
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
    detail: { viewsRevoked, parkedDropped, extRetained, tombstoned, revokedBy: owner.partyId },
  });
  writeProvenance(db.journal, owner, 'consent.access_grant', grantId, 'owner.revoke');
  return { grantId, appId: centraidAppId, viewsRevoked, parkedDropped, extRetained, receiptId };
}

export interface SweepResult {
  grantsExpired: number;
  sharesExpired: number;
  contentPurged: number;
  assetsPurged: number;
  /** Trashed notes whose grace window lapsed (issue #308 A6). */
  notesPurged: number;
  retentionDeleted: number;
  /** CAS bytes reclaimed with their purged content items (issue #296). */
  blobsReclaimed: number;
  /** Unclaimed blob_staging rows past the TTL, dropped with their bytes. */
  stagingExpired: number;
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
    const ref = resolveEntity(`${policy.applies_schema}.${policy.applies_table}`, db.vault);
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
  let blobsReclaimed = 0;
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
      `SELECT content_id, content_uri FROM core_content_item WHERE purge_at IS NOT NULL AND purge_at <= ?`,
    )
    .all(now) as { content_id: string; content_uri: string }[];
  // Purges are the one hard delete outside the command pipeline, so the
  // temporal link duty runs here too: live links onto a purged row end-date
  // rather than dangle (issue #272).
  const endDateLinks = db.vault.prepare(
    `UPDATE core_link SET valid_to = ?
      WHERE valid_to IS NULL
        AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))`,
  );
  // Tags are classification and entries are curation, not history: a tag or
  // a collection entry on a purged row says nothing once the row is gone,
  // so both delete with the row instead of dangling (issue #274).
  const dropTags = db.vault.prepare('DELETE FROM core_tag WHERE target_type = ? AND target_id = ?');
  const dropEntries = db.vault.prepare(
    'DELETE FROM core_collection_entry WHERE target_type = ? AND target_id = ?',
  );
  // Lapsed trashed notes purge FIRST (issue #308 A6): the note row rents its
  // body content (NOT NULL FK), so the row and its edges must go before the
  // content purge below can delete the body's bytes in the same pass.
  const lapsedNotes = db.vault
    .prepare('SELECT note_id FROM knowledge_note WHERE purge_at IS NOT NULL AND purge_at <= ?')
    .all(now) as { note_id: string }[];
  for (const n of lapsedNotes) {
    writeProvenance(db.journal, owner, 'knowledge.note', n.note_id, 'sweep.purge');
    dropEntries.run('knowledge.note', n.note_id);
    db.vault
      .prepare(`DELETE FROM knowledge_annotation WHERE target_type = 'knowledge.note' AND target_id = ?`)
      .run(n.note_id);
    db.vault
      .prepare(`DELETE FROM core_attachment WHERE subject_type = 'knowledge.note' AND subject_id = ?`)
      .run(n.note_id);
    db.vault.prepare('DELETE FROM knowledge_note WHERE note_id = ?').run(n.note_id);
    endDateLinks.run(now, 'knowledge.note', n.note_id, 'knowledge.note', n.note_id);
    dropTags.run('knowledge.note', n.note_id);
  }
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
      dropEntries.run('media.media_asset', asset.asset_id);
      db.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(asset.asset_id);
      endDateLinks.run(
        now,
        'media.media_asset',
        asset.asset_id,
        'media.media_asset',
        asset.asset_id,
      );
      dropTags.run('media.media_asset', asset.asset_id);
    }
    writeProvenance(db.journal, owner, 'core.content_item', row.content_id, 'sweep.purge');
    // A collection cover pointing at these bytes goes dark rather than
    // dangling (the FK would refuse the delete otherwise).
    db.vault
      .prepare('UPDATE core_collection SET cover_content_id = NULL WHERE cover_content_id = ?')
      .run(row.content_id);
    // Derivatives go with their parent (issue #296): registry rows first
    // (the FK), then their CAS bytes, then the original's bytes. sha256 is
    // UNIQUE on content items, so nothing else can claim the original —
    // remote replicas fall to the reconciliation sweep by design.
    const variants = db.vault
      .prepare(
        'SELECT sha256 FROM core_content_derivative WHERE content_id = ? AND sha256 IS NOT NULL',
      )
      .all(row.content_id) as { sha256: string }[];
    db.vault
      .prepare('DELETE FROM core_content_derivative WHERE content_id = ?')
      .run(row.content_id);
    db.vault.prepare('DELETE FROM core_content_item WHERE content_id = ?').run(row.content_id);
    for (const v of variants) {
      db.blobs.deleteLocalSync(v.sha256);
      blobsReclaimed += 1;
    }
    const originalSha = shaOfBlobUri(row.content_uri);
    if (originalSha) {
      db.blobs.deleteLocalSync(originalSha);
      blobsReclaimed += 1;
    }
    endDateLinks.run(now, 'core.content_item', row.content_id, 'core.content_item', row.content_id);
    dropTags.run('core.content_item', row.content_id);
    dropEntries.run('core.content_item', row.content_id);
  }
  // The standard soft-delete pair on domain rows (issue #274): a trashed
  // asset whose own grace window lapsed purges even while its bytes stay
  // rented elsewhere (an attachment, an avatar) — asset meaning and byte
  // custody have independent lifecycles. Assets already removed alongside
  // their purged content above are gone and don't reappear here.
  const lapsedAssets = db.vault
    .prepare('SELECT asset_id FROM media_media_asset WHERE purge_at IS NOT NULL AND purge_at <= ?')
    .all(now) as { asset_id: string }[];
  for (const a of lapsedAssets) {
    writeProvenance(db.journal, owner, 'media.media_asset', a.asset_id, 'sweep.purge');
    db.vault.prepare('DELETE FROM media_face_region WHERE asset_id = ?').run(a.asset_id);
    dropEntries.run('media.media_asset', a.asset_id);
    db.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(a.asset_id);
    endDateLinks.run(now, 'media.media_asset', a.asset_id, 'media.media_asset', a.asset_id);
    dropTags.run('media.media_asset', a.asset_id);
  }
  const retentionDeleted = enforceRetention(db, now);
  // The staging TTL (issue #296 §3): bytes nothing claimed leave with their
  // rows; a batch hold (import review in progress) pins past the TTL.
  const staging = sweepBlobStaging(db, { now });
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
      assetsPurged: lapsedAssets.length,
      notesPurged: lapsedNotes.length,
      retentionDeleted,
      blobsReclaimed,
      stagingExpired: staging.expired.length,
    },
  });
  return {
    grantsExpired: Number(grants.changes),
    sharesExpired: Number(shares.changes),
    contentPurged: purgeable.length,
    assetsPurged: lapsedAssets.length,
    notesPurged: lapsedNotes.length,
    retentionDeleted,
    blobsReclaimed,
    stagingExpired: staging.expired.length,
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
