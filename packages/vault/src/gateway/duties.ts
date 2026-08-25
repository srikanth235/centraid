// governance: allow-repo-hygiene file-size-limit standing duties are one cohesive sweep pipeline (revocation, lifecycle purge incl. the document-chain purge, retention, ingest); splitting mid-sweep would scatter one transaction's worth of reasoning across files.
// Standing duties (§10): revocation, lifecycle, ingest. Not request-shaped; still writes receipts.

import { liveBlobShas } from "../blob/read.js";
import { sweepBlobStaging } from "../blob/staging.js";
import { shaOfBlobUri } from "../blob/store.js";
import { RELATIONS_SCHEME_URI } from "../commands/links.js";
import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { writeScopeTombstones } from "../install-memory.js";
import { cleanupPolyRefs } from "../schema/poly-refs.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { writeProvenance, writeReceipt } from "./evidence.js";
import { retainExtBand } from "./ext.js";
import { tableColumns } from "./filters.js";
import type { FilterClause, Identity } from "./types.js";

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

/** Revoke is instant; ext band is RETAINED when the last grant dies (#286). Model/history/receipts always survive. */
export function revokeGrantCascade(
  db: VaultDb,
  owner: Identity,
  grantId: string,
  dropParked: (grantId: string) => number
): RevocationResult {
  const now = nowIso();
  const grant = db.vault
    .prepare(
      "SELECT grant_id, app_id, grantee_party_id FROM consent_access_grant WHERE grant_id = ?"
    )
    .get(grantId) as
    | {
        grant_id: string;
        app_id: string | null;
        grantee_party_id: string | null;
      }
    | undefined;
  if (!grant) throw new Error(`no grant ${grantId}`);
  db.vault
    .prepare(
      `UPDATE consent_access_grant SET status='revoked', revoked_at=? WHERE grant_id=?`
    )
    .run(now, grantId);
  // The owner's "no" outlives the grant row (#308): tombstone each revoked
  // scope so the install-grant top-up cannot silently re-mint it. Uninstall
  // clears them — a reinstall is fresh consent.
  const revokedScopes = db.vault
    .prepare(
      `SELECT schema_name, table_name, verbs, row_filter_json, field_mask_json
         FROM consent_grant_scope WHERE grant_id = ?`
    )
    .all(grantId) as {
    schema_name: string;
    table_name: string | null;
    verbs: string;
    row_filter_json: string | null;
    field_mask_json: string | null;
  }[];
  const tombstoned =
    grant.app_id !== null || grant.grantee_party_id !== null
      ? writeScopeTombstones(
          db,
          grant.app_id === null
            ? { granteePartyId: grant.grantee_party_id as string }
            : { appId: grant.app_id },
          revokedScopes.map((s) => ({
            schema: s.schema_name,
            ...(s.table_name === null ? {} : { table: s.table_name }),
            verbs: s.verbs as "read" | "read+act" | "act" | "reveal",
            ...(s.row_filter_json
              ? { rowFilter: JSON.parse(s.row_filter_json) as FilterClause[] }
              : {}),
            ...(s.field_mask_json
              ? { fieldMask: JSON.parse(s.field_mask_json) as string[] }
              : {}),
          }))
        )
      : 0;
  let viewsRevoked = 0;
  let extRetained: string[] = [];
  let centraidAppId: string | null = null;
  if (grant.app_id !== null) {
    // consent_app.app_id is a row uuid; the ext band keys on the Centraid app
    // id, which enrollment carries as `name`.
    const appRow = db.vault
      .prepare("SELECT name FROM consent_app WHERE app_id = ?")
      .get(grant.app_id) as { name: string } | undefined;
    centraidAppId = appRow?.name ?? null;
    const stillGranted = db.vault
      .prepare(
        `SELECT count(*) AS n FROM consent_access_grant WHERE app_id = ? AND status = 'active' AND revoked_at IS NULL`
      )
      .get(grant.app_id) as { n: number };
    if (stillGranted.n === 0) {
      const res = db.vault
        .prepare(
          `UPDATE consent_app_view SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL`
        )
        .run(now, grant.app_id);
      viewsRevoked = Number(res.changes);
      if (centraidAppId) extRetained = retainExtBand(db, centraidAppId);
    }
  }
  const parkedDropped = dropParked(grantId);
  const receiptId = writeReceipt(db.journal, {
    grantId,
    invocationId: null,
    action: "act consent.revoke_grant",
    objectType: "consent.access_grant",
    objectId: grantId,
    purpose: null,
    decision: "allow",
    detail: {
      viewsRevoked,
      parkedDropped,
      extRetained,
      tombstoned,
      revokedBy: owner.partyId,
    },
  });
  writeProvenance(
    db.journal,
    owner,
    "consent.access_grant",
    grantId,
    "owner.revoke"
  );
  return {
    grantId,
    appId: centraidAppId,
    viewsRevoked,
    parkedDropped,
    extRetained,
    receiptId,
  };
}

export interface SweepResult {
  grantsExpired: number;
  contentPurged: number;
  assetsPurged: number;
  notesPurged: number;
  documentsPurged: number;
  domainRowsPurged: number;
  retentionDeleted: number;
  /** Recorded refusals, never a silent skip (#712). */
  retentionRefused: RetentionRefusal[];
  /** Lineage-blocked (#711 S8): keep lapsed `purge_at`, retry next sweep. */
  contentBlockedByLineage: string[];
  assetsBlockedByLineage: string[];
  blobsReclaimed: number;
  /** Unclaimed blob_staging rows past the TTL, dropped with their bytes. */
  stagingExpired: number;
  receiptId: string;
}

export interface RetentionRefusal {
  entity: string;
  reason: string;
}

/** Recorded refusals (#712): `media.asset` has no `created_at` and lineage FKs without ON DELETE. */
const RETENTION_REFUSALS: ReadonlyMap<string, string> = new Map([
  [
    "media.asset",
    "media assets are purged by the trash lifecycle, never by blanket retention: no created_at exists to measure against, and edit lineage (source_asset_id) plus face regions block raw deletes",
  ],
]);

/** Timestamp from `rule_json.timestamp_column`. Unserved policy is a recorded refusal, never a silent continue (#712). */
function enforceRetention(
  db: VaultDb,
  now: string
): { deleted: number; refused: RetentionRefusal[] } {
  const policies = db.vault
    .prepare(
      `SELECT applies_schema, applies_table, retention_days, rule_json FROM consent_policy
        WHERE kind = 'retention' AND retention_days IS NOT NULL AND applies_table IS NOT NULL
          AND effective_from <= ?
        ORDER BY priority ASC`
    )
    .all(now) as {
    applies_schema: string;
    applies_table: string;
    retention_days: number;
    rule_json: string;
  }[];
  let deleted = 0;
  const refused: RetentionRefusal[] = [];
  for (const policy of policies) {
    const requestedEntity = `${policy.applies_schema}.${policy.applies_table}`;
    // Imported rows may carry the PHYSICAL table where policies normally
    // store the logical one, so normalize before applying standing decisions.
    const entity = resolveEntity(requestedEntity, db.vault)
      ? requestedEntity
      : (listVaultEntities(db.vault).find(
          (logical) =>
            resolveEntity(logical, db.vault)?.physical === policy.applies_table
        ) ?? requestedEntity);
    const standingRefusal = RETENTION_REFUSALS.get(entity);
    if (standingRefusal !== undefined) {
      refused.push({ entity, reason: standingRefusal });
      continue;
    }
    const ref = resolveEntity(entity, db.vault);
    if (!ref || ref.file !== "vault") continue;
    const rule = JSON.parse(policy.rule_json) as { timestamp_column?: string };
    const tsColumn = rule.timestamp_column ?? "created_at";
    if (!tableColumns(db.vault, ref.physical).has(tsColumn)) {
      refused.push({
        entity,
        reason: `no "${tsColumn}" column exists to measure retention against; the policy deletes nothing rather than the wrong thing`,
      });
      continue;
    }
    const cutoff = new Date(
      Date.parse(now) - policy.retention_days * 86_400_000
    ).toISOString();
    const result = db.vault
      .prepare(`DELETE FROM "${ref.physical}" WHERE "${tsColumn}" < ?`)
      .run(cutoff);
    deleted += Number(result.changes);
  }
  return { deleted, refused };
}

function revisesConceptId(db: VaultDb): string | null {
  const row = db.vault
    .prepare(
      `SELECT c.concept_id FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = ? AND c.notation = 'revises'`
    )
    .get(RELATIONS_SCHEME_URI) as { concept_id: string } | undefined;
  return row?.concept_id ?? null;
}

/** Full BFS over live `revises` (R3 restore can cycle). Seen-set is load-bearing. */
function documentChain(
  db: VaultDb,
  headContentId: string,
  revisesId: string
): string[] {
  const seen = new Set<string>([headContentId]);
  const queue: string[] = [headContentId];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const next = db.vault
      .prepare(
        `SELECT to_id FROM core_link
          WHERE from_type = 'core.content_item' AND from_id = ? AND to_type = 'core.content_item'
            AND relation_concept_id = ? AND valid_to IS NULL`
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

/** Serve-side twin of media CONTENT_REFERENCES, minus `core_document`. */
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
         OR EXISTS(SELECT 1 FROM media_asset WHERE content_id = ? AND deleted_at IS NULL)
       ) AS n`
    )
    .get(
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
      contentId,
      contentId
    ) as {
    n: number;
  };
  return row.n > 0;
}

/** sha256 dedup: a superseded revision can coincide with another live page. */
function ownedByAnotherLiveDocument(
  db: VaultDb,
  contentId: string,
  excludeDocumentId: string,
  revisesId: string
): boolean {
  const others = db.vault
    .prepare(
      `SELECT current_content_id FROM core_document WHERE document_id != ? AND deleted_at IS NULL`
    )
    .all(excludeDocumentId) as { current_content_id: string }[];
  return others.some((o) =>
    documentChain(db, o.current_content_id, revisesId).includes(contentId)
  );
}

/** Edit-lineage self-FK (#711 S8). Trashed children count — FK has no ON DELETE. */
function isLineageSource(db: VaultDb, assetId: string): boolean {
  const row = db.vault
    .prepare(
      "SELECT 1 AS present FROM media_asset WHERE source_asset_id = ? LIMIT 1"
    )
    .get(assetId) as { present: number } | undefined;
  return row !== undefined;
}

/** Face regions have no CASCADE — delete by hand before poly-refs. Caller must already know this is not a lineage source. */
function deleteAssetRow(
  db: VaultDb,
  owner: Identity,
  now: string,
  assetId: string
): void {
  writeProvenance(db.journal, owner, "media.asset", assetId, "sweep.purge");
  // A face region is itself a polymorphic TARGET (#724). Deleting it without
  // sweeping enrich_embedding/enrich_derivation leaves an orphan FACE vector —
  // the one leftover that could match a new photograph to a deleted person.
  const regions = db.vault
    .prepare("SELECT region_id FROM media_face_region WHERE asset_id = ?")
    .all(assetId) as { region_id: string }[];
  for (const region of regions)
    cleanupPolyRefs(db.vault, now, "media.face_region", region.region_id);
  db.vault
    .prepare("DELETE FROM media_face_region WHERE asset_id = ?")
    .run(assetId);
  db.vault.prepare("DELETE FROM media_asset WHERE asset_id = ?").run(assetId);
  cleanupPolyRefs(db.vault, now, "media.asset", assetId);
}

interface ContentPurgeResult {
  /** Zero when the purge was declined. */
  reclaimed: number;
  /** The asset whose edit lineage blocked this pass, else null. */
  blockedByAssetId: string | null;
}

/** Derivatives + CAS first (FK), then the row, then poly-refs (#296/#272/#274). */
function purgeContentItem(
  db: VaultDb,
  owner: Identity,
  now: string,
  contentId: string
): ContentPurgeResult {
  let reclaimed = 0;
  // The asset row references the content NOT NULL, so purging one purges both.
  const asset = db.vault
    .prepare("SELECT asset_id FROM media_asset WHERE content_id = ?")
    .get(contentId) as { asset_id: string } | undefined;
  if (asset) {
    // Edit lineage (#711): both ways through are dishonest — NULLing the
    // child's column forges "camera original", cascading destroys a photograph
    // the owner never trashed. media.purge_asset refuses interactively for the
    // same reason; a sweep makes the SAME refusal and keeps going rather than
    // dying on the FK and taking every later duty down with it. The WHOLE
    // content item is declined because the asset's content_id FK is NOT NULL.
    // `purge_at` stays lapsed, so the next sweep retries once the copy is gone,
    // and the skip is named in the receipt — declined, never silent.
    if (isLineageSource(db, asset.asset_id))
      return { reclaimed: 0, blockedByAssetId: asset.asset_id };
    deleteAssetRow(db, owner, now, asset.asset_id);
  }
  writeProvenance(
    db.journal,
    owner,
    "core.content_item",
    contentId,
    "sweep.purge"
  );
  // A cover pointing at these bytes goes dark; the FK would refuse otherwise.
  db.vault
    .prepare(
      "UPDATE core_collection SET cover_content_id = NULL WHERE cover_content_id = ?"
    )
    .run(contentId);
  // Derivatives go with their parent (#296), registry rows first for the FK.
  // sha256 is UNIQUE on content items, so nothing else claims the original;
  // remote replicas fall to the reconciliation sweep by design.
  const variants = db.vault
    .prepare(
      "SELECT sha256 FROM core_content_derivative WHERE content_id = ? AND sha256 IS NOT NULL"
    )
    .all(contentId) as { sha256: string }[];
  db.vault
    .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
    .run(contentId);
  const contentRow = db.vault
    .prepare("SELECT content_uri FROM core_content_item WHERE content_id = ?")
    .get(contentId) as { content_uri: string } | undefined;
  db.vault
    .prepare("DELETE FROM core_content_item WHERE content_id = ?")
    .run(contentId);
  // Bytes go only when their FINAL claim disappears (#750). sha256 is UNIQUE
  // on content items but NOT on derivatives, so re-derive the live set AFTER
  // the deletes above and skip any sha another row still claims — the orphan
  // sweep reclaims a skipped copy once its last claim drops.
  const live = liveBlobShas(db.vault);
  for (const v of variants) {
    if (live.has(v.sha256)) continue;
    db.blobs.deleteLocalSync(v.sha256);
    reclaimed += 1;
  }
  const originalSha = contentRow ? shaOfBlobUri(contentRow.content_uri) : null;
  if (originalSha && !live.has(originalSha)) {
    db.blobs.deleteLocalSync(originalSha);
    reclaimed += 1;
  }
  // Every polymorphic pointer at the content item (#441). cover_content_id
  // above is a plain FK, not a poly ref.
  cleanupPolyRefs(db.vault, now, "core.content_item", contentId);
  return { reclaimed, blockedByAssetId: null };
}

/** Soft-delete tables with no bespoke purge (#441 A4). Next domain is one entry here. `entity` is the logical poly-ref name. */
const DOMAIN_TRASH_TABLES: readonly {
  physical: string;
  idCol: string;
  entity: string;
}[] = [
  {
    physical: "people_important_date",
    idCol: "date_id",
    entity: "people.important_date",
  },
  {
    physical: "people_profile",
    idCol: "profile_id",
    entity: "people.profile",
  },
  { physical: "tally_expense", idCol: "expense_id", entity: "tally.expense" },
  {
    physical: "tally_settlement",
    idCol: "settlement_id",
    entity: "tally.settlement",
  },
  {
    physical: "tally_obligation",
    idCol: "obligation_id",
    entity: "tally.obligation",
  },
];

/** `sweep.purge` stamp + `cleanupPolyRefs` so nothing points at a gone row (#441). */
function purgeDomainTrash(db: VaultDb, owner: Identity, now: string): number {
  let purged = 0;
  for (const t of DOMAIN_TRASH_TABLES) {
    const lapsed = db.vault
      .prepare(
        `SELECT "${t.idCol}" AS id FROM "${t.physical}" WHERE purge_at IS NOT NULL AND purge_at <= ?`
      )
      .all(now) as { id: string }[];
    for (const row of lapsed) {
      writeProvenance(db.journal, owner, t.entity, row.id, "sweep.purge");
      db.vault
        .prepare(`DELETE FROM "${t.physical}" WHERE "${t.idCol}" = ?`)
        .run(row.id);
      cleanupPolyRefs(db.vault, now, t.entity, row.id);
      purged += 1;
    }
  }
  return purged;
}

/** Derived copies first (#711). Self-FK: never hand SQLite a delete it will refuse. Skip a lapsed source whose child is not lapsed. */
function purgeLapsedAssets(
  db: VaultDb,
  owner: Identity,
  now: string
): { purged: number; blocked: string[] } {
  const pending = new Set(
    (
      db.vault
        .prepare(
          "SELECT asset_id FROM media_asset WHERE purge_at IS NOT NULL AND purge_at <= ?"
        )
        .all(now) as { asset_id: string }[]
    ).map((row) => row.asset_id)
  );
  let purged = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const assetId of pending) {
      if (isLineageSource(db, assetId)) continue;
      deleteAssetRow(db, owner, now, assetId);
      pending.delete(assetId);
      purged += 1;
      progressed = true;
    }
  }
  return { purged, blocked: [...pending] };
}

/** Lapse grants, execute purge_at deletions (GDPR), enforce retention. */
export function sweepLifecycle(db: VaultDb, owner: Identity): SweepResult {
  const now = nowIso();
  let blobsReclaimed = 0;
  const contentBlockedByLineage: string[] = [];
  const grants = db.vault
    .prepare(
      `UPDATE consent_access_grant SET status='expired'
        WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?`
    )
    .run(now);
  const purgeable = db.vault
    .prepare(
      `SELECT content_id FROM core_content_item WHERE purge_at IS NOT NULL AND purge_at <= ?`
    )
    .all(now) as { content_id: string }[];
  // Purges are the one hard delete outside the command pipeline, so
  // polymorphic cleanup runs here too. schema/poly-refs.ts is the single
  // complete enumeration — never re-derive a partial list by hand.
  //
  // Notes purge FIRST (#308): the note rents its body content NOT NULL, so the
  // row must go before the content purge can delete those bytes this pass.
  const lapsedNotes = db.vault
    .prepare(
      "SELECT note_id FROM knowledge_note WHERE purge_at IS NOT NULL AND purge_at <= ?"
    )
    .all(now) as { note_id: string }[];
  for (const n of lapsedNotes) {
    writeProvenance(
      db.journal,
      owner,
      "knowledge.note",
      n.note_id,
      "sweep.purge"
    );
    db.vault
      .prepare("DELETE FROM knowledge_note WHERE note_id = ?")
      .run(n.note_id);
    cleanupPolyRefs(db.vault, now, "knowledge.note", n.note_id);
  }
  // Documents next (#352), same NOT NULL reason. Retention stance: superseded
  // bodies are durable while the document lives; only at purge time is each
  // chain item judged, and only THIS document's chain is considered.
  const revisesId = revisesConceptId(db);
  const lapsedDocuments = db.vault
    .prepare(
      "SELECT document_id, current_content_id FROM core_document WHERE purge_at IS NOT NULL AND purge_at <= ?"
    )
    .all(now) as { document_id: string; current_content_id: string }[];
  for (const doc of lapsedDocuments) {
    const chain = revisesId
      ? documentChain(db, doc.current_content_id, revisesId)
      : [doc.current_content_id];
    writeProvenance(
      db.journal,
      owner,
      "core.document",
      doc.document_id,
      "sweep.purge"
    );
    db.vault
      .prepare("DELETE FROM core_document WHERE document_id = ?")
      .run(doc.document_id);
    cleanupPolyRefs(db.vault, now, "core.document", doc.document_id);
    for (const contentId of chain) {
      if (contentRentedElsewhere(db, contentId)) continue;
      if (
        revisesId &&
        ownedByAnotherLiveDocument(db, contentId, doc.document_id, revisesId)
      )
        continue;
      const purge = purgeContentItem(db, owner, now, contentId);
      blobsReclaimed += purge.reclaimed;
      if (purge.blockedByAssetId !== null)
        contentBlockedByLineage.push(contentId);
    }
  }
  let contentPurged = 0;
  for (const row of purgeable) {
    const purge = purgeContentItem(db, owner, now, row.content_id);
    blobsReclaimed += purge.reclaimed;
    if (purge.blockedByAssetId === null) contentPurged += 1;
    else contentBlockedByLineage.push(row.content_id);
  }
  // A lapsed trashed asset purges even while its bytes stay rented elsewhere
  // (#274): asset meaning and byte custody have independent lifecycles. Runs
  // AFTER the content purge, so a photograph whose derived copy lapses in the
  // same sweep gives up its asset row now while the content item behind it
  // waits one more sweep — the price of leaving the content → asset → domain
  // order alone.
  const lapsedAssets = purgeLapsedAssets(db, owner, now);
  // Runs after the content/asset passes so a row referencing now-purged bytes
  // is judged last (#441).
  const domainRowsPurged = purgeDomainTrash(db, owner, now);
  // Heal the rebuildable projection wholesale (#441 A3), so import corrections
  // and the purges above can never leave it drifted.
  db.vault
    .prepare(
      `UPDATE social_thread SET last_message_at =
         (SELECT MAX(sent_at) FROM social_message WHERE social_message.thread_id = social_thread.thread_id)`
    )
    .run();
  const retention = enforceRetention(db, now);
  const retentionDeleted = retention.deleted;
  // Staging TTL (#296): unclaimed bytes leave with their rows; a batch hold
  // pins past the TTL.
  const staging = sweepBlobStaging(db, { now });
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: "act consent.lifecycle_sweep",
    objectType: "consent.policy",
    objectId: null,
    purpose: null,
    decision: "allow",
    detail: {
      grantsExpired: Number(grants.changes),
      contentPurged,
      assetsPurged: lapsedAssets.purged,
      notesPurged: lapsedNotes.length,
      documentsPurged: lapsedDocuments.length,
      domainRowsPurged,
      retentionDeleted,
      retentionRefused: retention.refused,
      // Declined, not died on (#711): empty on an ordinary sweep.
      contentBlockedByLineage,
      assetsBlockedByLineage: lapsedAssets.blocked,
      blobsReclaimed,
      stagingExpired: staging.expired.length,
    },
  });
  return {
    grantsExpired: Number(grants.changes),
    contentPurged,
    assetsPurged: lapsedAssets.purged,
    notesPurged: lapsedNotes.length,
    documentsPurged: lapsedDocuments.length,
    domainRowsPurged,
    retentionDeleted,
    retentionRefused: retention.refused,
    contentBlockedByLineage,
    assetsBlockedByLineage: lapsedAssets.blocked,
    blobsReclaimed,
    stagingExpired: staging.expired.length,
    receiptId,
  };
}

/** Import-batch dedupe on external_id. Null = already imported. */
export function admitImportedRow(
  db: VaultDb,
  importer: Identity,
  entityType: string,
  externalIdColumn: { physical: string; column: string },
  externalId: string,
  insert: () => string,
  batch: string
): string | null {
  const existing = db.vault
    .prepare(
      `SELECT 1 AS x FROM "${externalIdColumn.physical}" WHERE "${externalIdColumn.column}" = ?`
    )
    .get(externalId);
  if (existing) return null;
  const entityId = insert();
  writeProvenance(
    db.journal,
    importer,
    entityType,
    entityId,
    `import.${batch}`,
    {
      external_id: externalId,
    }
  );
  return entityId;
}

export function resolveHandle(
  db: VaultDb,
  scheme: string,
  value: string
): string | null {
  const row = db.vault
    .prepare(
      `SELECT party_id FROM core_party_identifier
        WHERE scheme = ? AND value = ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY is_primary DESC LIMIT 1`
    )
    .get(scheme, value, nowIso()) as { party_id: string } | undefined;
  return row?.party_id ?? null;
}
