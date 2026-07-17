// governance: allow-repo-hygiene file-size-limit standing duties are one cohesive sweep pipeline (revocation, lifecycle purge incl. the document-chain purge, retention, ingest); splitting mid-sweep would scatter one transaction's worth of reasoning across files.
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
import { RELATIONS_SCHEME_URI } from '../commands/links.js';
import { cleanupPolyRefs } from '../schema/poly-refs.js';
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
    .prepare(
      'SELECT grant_id, app_id, grantee_party_id FROM consent_access_grant WHERE grant_id = ?',
    )
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
          revokedScopes.map((s) => ({
            schema: s.schema_name,
            table: s.table_name,
            verbs: s.verbs,
          })),
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
  /** Trashed documents whose grace window lapsed (issue #352). */
  documentsPurged: number;
  /**
   * Lapsed trashed rows of the domain content tables that carry the uniform
   * soft-delete pair (People + Tally, issue #441 A4), purged table-driven with
   * their polymorphic references cleaned.
   */
  domainRowsPurged: number;
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

/** The `revises` relation concept id, or null when nothing ever seeded it. */
function revisesConceptId(db: VaultDb): string | null {
  const row = db.vault
    .prepare(
      `SELECT c.concept_id FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = ? AND c.notation = 'revises'`,
    )
    .get(RELATIONS_SCHEME_URI) as { concept_id: string } | undefined;
  return row?.concept_id ?? null;
}

/**
 * Every content item reachable from a document's head through live
 * `revises` links (NEW content item -> OLD content item) — a full
 * reachability walk (BFS, every outgoing edge), not a single linked path.
 * Restoring an old version gives that version's content id a NEW outgoing
 * edge (restore IS a revision, rule R3), so a node CAN end up with more
 * than one outgoing edge over a document's lifetime, and the graph CAN
 * cycle back through content already visited — the seen-set is load-
 * bearing, not defensive: without it this does not terminate.
 */
function documentChain(db: VaultDb, headContentId: string, revisesId: string): string[] {
  const seen = new Set<string>([headContentId]);
  const queue: string[] = [headContentId];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const next = db.vault
      .prepare(
        `SELECT to_id FROM core_link
          WHERE from_type = 'core.content_item' AND from_id = ? AND to_type = 'core.content_item'
            AND relation_concept_id = ? AND valid_to IS NULL`,
      )
      .all(cur, revisesId) as { to_id: string }[];
    for (const n of next) {
      if (!seen.has(n.to_id)) {
        seen.add(n.to_id);
        queue.push(n.to_id);
      }
    }
  }
  return [...seen];
}

/**
 * True when some canonical row besides core_document still rents these
 * bytes — the serve-side twin of media.ts CONTENT_REFERENCES minus the
 * core_document row itself (the document purge pass below already knows the
 * answer for its OWN row; this asks about everything else).
 */
function contentRentedElsewhere(db: VaultDb, contentId: string): boolean {
  const row = db.vault
    .prepare(
      `SELECT (
         EXISTS(SELECT 1 FROM core_attachment WHERE content_id = ?)
         OR EXISTS(SELECT 1 FROM core_party WHERE avatar_content_id = ?)
         OR EXISTS(SELECT 1 FROM knowledge_note WHERE body_content_id = ? AND deleted_at IS NULL)
         OR EXISTS(SELECT 1 FROM social_message WHERE body_content_id = ?)
         OR EXISTS(SELECT 1 FROM business_invoice WHERE pdf_content_id = ?)
         OR EXISTS(SELECT 1 FROM home_warranty WHERE terms_content_id = ?)
         OR EXISTS(SELECT 1 FROM home_maintenance_plan WHERE instructions_content_id = ?)
         OR EXISTS(SELECT 1 FROM media_media_asset WHERE content_id = ? AND deleted_at IS NULL)
       ) AS n`,
    )
    .get(
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
    ) as {
    n: number;
  };
  return row.n > 0;
}

/**
 * True when some OTHER live document's own chain still reaches this content
 * id — sha256 dedup (or two documents deliberately sharing bytes) means a
 * superseded revision of the document being purged can coincide with a
 * live page of a different one.
 */
function ownedByAnotherLiveDocument(
  db: VaultDb,
  contentId: string,
  excludeDocumentId: string,
  revisesId: string,
): boolean {
  const others = db.vault
    .prepare(
      `SELECT current_content_id FROM core_document WHERE document_id != ? AND deleted_at IS NULL`,
    )
    .all(excludeDocumentId) as { current_content_id: string }[];
  return others.some((o) => documentChain(db, o.current_content_id, revisesId).includes(contentId));
}

/**
 * Hard-delete one content item: derivative registry rows + their CAS bytes
 * first (the FK), then the row itself, then end-date/drop whatever else
 * pointed at it (issues #296, #272, #274). Shared by the generic
 * core_content_item purge and the document-chain purge below — a purged
 * content item is purged the same way regardless of which wrapper decided
 * it was time. Returns CAS blobs reclaimed.
 */
function purgeContentItem(db: VaultDb, owner: Identity, now: string, contentId: string): number {
  let reclaimed = 0;
  // A trashed media asset over these bytes goes with them — the asset row
  // references the content (NOT NULL), so purging one must purge both.
  const asset = db.vault
    .prepare('SELECT asset_id FROM media_media_asset WHERE content_id = ?')
    .get(contentId) as { asset_id: string } | undefined;
  if (asset) {
    writeProvenance(db.journal, owner, 'media.media_asset', asset.asset_id, 'sweep.purge');
    db.vault.prepare('DELETE FROM media_face_region WHERE asset_id = ?').run(asset.asset_id);
    db.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(asset.asset_id);
    // Every polymorphic pointer at the asset (issue #441 A1): end-date links,
    // drop tags/entries/annotations/attachments/embeddings/sync-map/seed rows,
    // revoke shares — the registry is the complete set, not this call site.
    cleanupPolyRefs(db.vault, now, 'media.media_asset', asset.asset_id);
  }
  writeProvenance(db.journal, owner, 'core.content_item', contentId, 'sweep.purge');
  // A collection cover pointing at these bytes goes dark rather than
  // dangling (the FK would refuse the delete otherwise).
  db.vault
    .prepare('UPDATE core_collection SET cover_content_id = NULL WHERE cover_content_id = ?')
    .run(contentId);
  // Derivatives go with their parent (issue #296): registry rows first (the
  // FK), then their CAS bytes, then the original's bytes. sha256 is UNIQUE
  // on content items, so nothing else can claim the original — remote
  // replicas fall to the reconciliation sweep by design.
  const variants = db.vault
    .prepare(
      'SELECT sha256 FROM core_content_derivative WHERE content_id = ? AND sha256 IS NOT NULL',
    )
    .all(contentId) as { sha256: string }[];
  db.vault.prepare('DELETE FROM core_content_derivative WHERE content_id = ?').run(contentId);
  const contentRow = db.vault
    .prepare('SELECT content_uri FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { content_uri: string } | undefined;
  db.vault.prepare('DELETE FROM core_content_item WHERE content_id = ?').run(contentId);
  for (const v of variants) {
    db.blobs.deleteLocalSync(v.sha256);
    reclaimed += 1;
  }
  const originalSha = contentRow ? shaOfBlobUri(contentRow.content_uri) : null;
  if (originalSha) {
    db.blobs.deleteLocalSync(originalSha);
    reclaimed += 1;
  }
  // Every polymorphic pointer at the content item (issue #441 A1): end-date
  // links, drop tags/entries/annotations/attachments/embeddings/sync-map/seed
  // rows, revoke shares. cover_content_id above is a plain FK, not a poly ref.
  cleanupPolyRefs(db.vault, now, 'core.content_item', contentId);
  return reclaimed;
}

/**
 * The domain content tables that carry the uniform soft-delete pair but have
 * no bespoke purge pass of their own (People + Tally, issue #441 A4). The
 * sweep walks this list, purges every row whose grace window has lapsed, and
 * cleans each row's polymorphic references via the A1 registry — so the trash
 * lifecycle is complete BY CONSTRUCTION for these tables and the next
 * soft-deletable domain row is one entry here, not a remembered purge clause.
 * `entity` is the LOGICAL name stored in polymorphic type columns (what a memo
 * annotation on a trashed expense, or a tag on a trashed row, points at).
 * FK children with ON DELETE CASCADE (tally_expense_split) go automatically —
 * PRAGMA foreign_keys is ON (db.ts) — so no child needs manual deletion here.
 */
const DOMAIN_TRASH_TABLES: readonly { physical: string; idCol: string; entity: string }[] = [
  { physical: 'people_interaction', idCol: 'interaction_id', entity: 'people.interaction' },
  { physical: 'people_task', idCol: 'task_id', entity: 'people.task' },
  { physical: 'people_gift', idCol: 'gift_id', entity: 'people.gift' },
  { physical: 'people_important_date', idCol: 'date_id', entity: 'people.important_date' },
  { physical: 'people_relationship', idCol: 'relationship_id', entity: 'people.relationship' },
  { physical: 'people_debt', idCol: 'debt_id', entity: 'people.debt' },
  { physical: 'people_journal_entry', idCol: 'entry_id', entity: 'people.journal_entry' },
  { physical: 'tally_expense', idCol: 'expense_id', entity: 'tally.expense' },
  { physical: 'tally_settlement', idCol: 'settlement_id', entity: 'tally.settlement' },
];

/**
 * Purge lapsed trashed rows of the domain content tables (issue #441 A4).
 * Each purged row gets a `sweep.purge` provenance stamp and a full
 * `cleanupPolyRefs` pass so nothing points at a row that no longer exists.
 * Returns the total rows purged across all tables.
 */
function purgeDomainTrash(db: VaultDb, owner: Identity, now: string): number {
  let purged = 0;
  for (const t of DOMAIN_TRASH_TABLES) {
    const lapsed = db.vault
      .prepare(
        `SELECT "${t.idCol}" AS id FROM "${t.physical}" WHERE purge_at IS NOT NULL AND purge_at <= ?`,
      )
      .all(now) as { id: string }[];
    for (const row of lapsed) {
      writeProvenance(db.journal, owner, t.entity, row.id, 'sweep.purge');
      db.vault.prepare(`DELETE FROM "${t.physical}" WHERE "${t.idCol}" = ?`).run(row.id);
      cleanupPolyRefs(db.vault, now, t.entity, row.id);
      purged += 1;
    }
  }
  return purged;
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
      `SELECT content_id FROM core_content_item WHERE purge_at IS NOT NULL AND purge_at <= ?`,
    )
    .all(now) as { content_id: string }[];
  // Purges are the one hard delete outside the command pipeline, so the
  // polymorphic-cleanup duty runs here too: links onto a purged row end-date
  // (issue #272), tags/entries/annotations/attachments/embeddings/sync-map/seed
  // rows drop and shares revoke (issues #274, #441 A1). The registry in
  // schema/poly-refs.ts is the single, complete enumeration — cleanupPolyRefs
  // walks it so no purge path re-derives a partial list by hand.
  // Lapsed trashed notes purge FIRST (issue #308 A6): the note row rents its
  // body content (NOT NULL FK), so the row and its edges must go before the
  // content purge below can delete the body's bytes in the same pass.
  const lapsedNotes = db.vault
    .prepare('SELECT note_id FROM knowledge_note WHERE purge_at IS NOT NULL AND purge_at <= ?')
    .all(now) as { note_id: string }[];
  for (const n of lapsedNotes) {
    writeProvenance(db.journal, owner, 'knowledge.note', n.note_id, 'sweep.purge');
    db.vault.prepare('DELETE FROM knowledge_note WHERE note_id = ?').run(n.note_id);
    cleanupPolyRefs(db.vault, now, 'knowledge.note', n.note_id);
  }
  // Lapsed trashed documents purge next (issue #352), same reason as notes
  // above: the wrapper rents its current content (NOT NULL FK), so the row
  // must go before any of its content items can be deleted. Retention
  // stance: superseded bodies are durable while the document lives — only
  // at purge time does each chain content item get judged, and only THIS
  // document's own chain is even considered for release.
  const revisesId = revisesConceptId(db);
  const lapsedDocuments = db.vault
    .prepare(
      'SELECT document_id, current_content_id FROM core_document WHERE purge_at IS NOT NULL AND purge_at <= ?',
    )
    .all(now) as { document_id: string; current_content_id: string }[];
  for (const doc of lapsedDocuments) {
    const chain = revisesId
      ? documentChain(db, doc.current_content_id, revisesId)
      : [doc.current_content_id];
    writeProvenance(db.journal, owner, 'core.document', doc.document_id, 'sweep.purge');
    db.vault.prepare('DELETE FROM core_document WHERE document_id = ?').run(doc.document_id);
    cleanupPolyRefs(db.vault, now, 'core.document', doc.document_id);
    for (const contentId of chain) {
      if (contentRentedElsewhere(db, contentId)) continue;
      if (revisesId && ownedByAnotherLiveDocument(db, contentId, doc.document_id, revisesId))
        continue;
      blobsReclaimed += purgeContentItem(db, owner, now, contentId);
    }
  }
  for (const row of purgeable) {
    // The row disappears; its provenance trail in journal.db remains.
    blobsReclaimed += purgeContentItem(db, owner, now, row.content_id);
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
    db.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(a.asset_id);
    cleanupPolyRefs(db.vault, now, 'media.media_asset', a.asset_id);
  }
  // Lapsed trashed People/Tally content rows purge table-driven, each with its
  // polymorphic references cleaned (issue #441 A4). Runs after the content /
  // asset passes above so a row that referenced now-purged bytes is judged last.
  const domainRowsPurged = purgeDomainTrash(db, owner, now);
  // Heal the rebuildable projection social_thread.last_message_at (issue #441
  // A3), the blob_custody_state pattern: recompute it wholesale from the
  // messages so import corrections or message purges above can never leave it
  // drifted. Threads with no messages fall back to NULL.
  db.vault
    .prepare(
      `UPDATE social_thread SET last_message_at =
         (SELECT MAX(sent_at) FROM social_message WHERE social_message.thread_id = social_thread.thread_id)`,
    )
    .run();
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
      documentsPurged: lapsedDocuments.length,
      domainRowsPurged,
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
    documentsPurged: lapsedDocuments.length,
    domainRowsPurged,
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
