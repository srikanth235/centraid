// governance: allow-repo-hygiene file-size-limit one sweep pipeline; splitting it scatters a single transaction's reasoning across files.

import { liveBlobShas } from "../blob/read.js";
import { sweepBlobStaging } from "../blob/staging.js";
import { shaOfBlobUri } from "../blob/store.js";
import { partyForReach } from "../commands/contact-reach.js";
import { RELATIONS_SCHEME_URI } from "../commands/links.js";
import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { writeScopeTombstones } from "../install-memory.js";
import { contentReferenceExists } from "../schema/content-references.js";
import { entitySupertypeMembers } from "../schema/entity.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { writeProvenance, writeReceipt } from "./evidence.js";
import { retainExtBand } from "./ext.js";
import { tableColumns } from "./filters.js";
import type { FilterClause, Identity } from "./types.js";

export interface RevocationResult {
  grantId: string;
  appId: string | null;
  parkedDropped: number;
  extRetained: string[];
  receiptId: string;
}

export function revokeGrantCascade(
  db: VaultDb,
  owner: Identity,
  grantId: string,
  dropParked: (grantId: string) => number
): RevocationResult {
  const now = nowIso();
  const grant = db.vault
    .prepare(
      "SELECT grant_id, app_id, grantee_party_id FROM access_grant WHERE grant_id = ?"
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
      `UPDATE access_grant SET status='revoked', revoked_at=? WHERE grant_id=?`
    )
    .run(now, grantId);
  const revokedScopes = db.vault
    .prepare(
      `SELECT entity, verbs, row_filter_json, field_mask_json
         FROM access_grant_scope WHERE grant_id = ?`
    )
    .all(grantId) as {
    entity: string;
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
            schema: s.entity.includes(".")
              ? s.entity.slice(0, s.entity.indexOf("."))
              : s.entity,
            ...(s.entity.includes(".")
              ? { table: s.entity.slice(s.entity.indexOf(".") + 1) }
              : {}),
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
  let extRetained: string[] = [];
  let centraidAppId: string | null = null;
  if (grant.app_id !== null) {
    const appRow = db.vault
      .prepare("SELECT name FROM access_app WHERE app_id = ?")
      .get(grant.app_id) as { name: string } | undefined;
    centraidAppId = appRow?.name ?? null;
    const stillGranted = db.vault
      .prepare(
        `SELECT count(*) AS n FROM access_grant WHERE app_id = ? AND status = 'active' AND revoked_at IS NULL`
      )
      .get(grant.app_id) as { n: number };
    if (stillGranted.n === 0 && centraidAppId) {
      extRetained = retainExtBand(db, centraidAppId);
    }
  }
  const parkedDropped = dropParked(grantId);
  const receiptId = writeReceipt(db.audit, {
    grantId,
    invocationId: null,
    action: "act access.revoke_grant",
    objectType: "access.grant",
    objectId: grantId,
    purpose: null,
    decision: "allow",
    detail: {
      parkedDropped,
      extRetained,
      tombstoned,
      revokedBy: owner.partyId,
    },
  });
  writeProvenance(db.audit, owner, "access.grant", grantId, "owner.revoke");
  return {
    grantId,
    appId: centraidAppId,
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
  retentionRefused: RetentionRefusal[];
  contentBlockedByLineage: string[];
  assetsBlockedByLineage: string[];
  blobsReclaimed: number;
  stagingExpired: number;
  authorityRevoked: number;
  skipped: SweepSkip[];
  receiptId: string;
}

export interface SweepSkip {
  entity: string;
  id: string;
  reason: string;
}

function purgeOneRow(
  db: VaultDb,
  skipped: SweepSkip[],
  entity: string,
  id: string,
  body: () => void
): boolean {
  db.vault.exec("SAVEPOINT sweep_row");
  try {
    body();
    db.vault.exec("RELEASE sweep_row");
    return true;
  } catch (error) {
    db.vault.exec("ROLLBACK TO sweep_row");
    db.vault.exec("RELEASE sweep_row");
    skipped.push({
      entity,
      id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface RetentionRefusal {
  entity: string;
  reason: string;
}

const RETENTION_REFUSALS: ReadonlyMap<string, string> = new Map([
  [
    "media.asset",
    "media assets are purged by the trash lifecycle, never by blanket retention: no created_at exists to measure against, and edit lineage (source_asset_id) plus face regions block raw deletes",
  ],
]);

function enforceRetention(
  db: VaultDb,
  owner: Identity,
  now: string,
  skipped: SweepSkip[]
): {
  deleted: number;
  refused: RetentionRefusal[];
  reclaimed: number;
  authorityRevoked: number;
} {
  const policies = db.vault
    .prepare(
      `SELECT entity, retention_days, rule_json FROM access_policy
        WHERE kind = 'retention' AND retention_days IS NOT NULL
          AND effective_from <= ?
        ORDER BY priority ASC`
    )
    .all(now) as {
    entity: string;
    retention_days: number;
    rule_json: string;
  }[];
  let deleted = 0;
  let reclaimed = 0;
  let authorityRevoked = 0;
  const refused: RetentionRefusal[] = [];
  for (const policy of policies) {
    const entity = resolveEntity(policy.entity, db.vault)
      ? policy.entity
      : (listVaultEntities(db.vault).find(
          (logical) =>
            resolveEntity(logical, db.vault)?.physical === policy.entity
        ) ?? policy.entity);
    const standingRefusal = RETENTION_REFUSALS.get(entity);
    if (standingRefusal !== undefined) {
      refused.push({ entity, reason: standingRefusal });
      continue;
    }
    const ref = resolveEntity(entity, db.vault);
    if (!ref) {
      refused.push({
        entity,
        reason: `no entity named "${policy.entity}" exists in this vault to retain`,
      });
      continue;
    }
    const purge = retentionPurgerFor(entity);
    if (!purge) {
      refused.push({
        entity,
        reason: `no purge routine exists for ${entity}: retention deletes through the purge path or not at all, so that a retained row leaves the same provenance, receipts and reclaimed bytes a trash purge does`,
      });
      continue;
    }
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
    const pk = primaryKeyColumn(db, ref.physical);
    if (!pk) {
      refused.push({
        entity,
        reason: `${ref.physical} has no single-column primary key to purge rows by`,
      });
      continue;
    }
    const lapsed = db.vault
      .prepare(
        `SELECT "${pk}" AS id FROM "${ref.physical}"
          WHERE "${tsColumn}" < ? ORDER BY "${tsColumn}" LIMIT ?`
      )
      .all(cutoff, PURGE_BATCH) as { id: string }[];
    for (const row of lapsed) {
      const done = purgeOneRow(db, skipped, entity, row.id, () => {
        const outcome = purge(db, owner, entity, ref.physical, pk, row.id);
        reclaimed += outcome.reclaimed;
        authorityRevoked += outcome.authorityRevoked;
      });
      if (done) deleted += 1;
    }
  }
  return { deleted, refused, reclaimed, authorityRevoked };
}

interface RetentionPurgeOutcome {
  reclaimed: number;
  authorityRevoked: number;
}

type RetentionPurger = (
  db: VaultDb,
  owner: Identity,
  entity: string,
  physical: string,
  pk: string,
  id: string
) => RetentionPurgeOutcome;

function retentionPurgerFor(entity: string): RetentionPurger | undefined {
  if (entity === "core.content_item")
    return (db, owner, _entity, _physical, _pk, id) => {
      const purge = purgeContentItem(db, owner, id);
      if (purge.blockedByAssetId !== null)
        throw new Error(
          `content ${id} is the source of edit lineage on asset ${purge.blockedByAssetId}`
        );
      return {
        reclaimed: purge.reclaimed,
        authorityRevoked: purge.authorityRevoked,
      };
    };
  if (!ENTITY_KINDS.has(entity)) return undefined;
  return (db, owner, logical, physical, pk, id) => {
    db.vault.prepare(`DELETE FROM "${physical}" WHERE "${pk}" = ?`).run(id);
    writeProvenance(db.audit, owner, logical, id, "sweep.retention");
    return {
      reclaimed: 0,
      authorityRevoked: receiptPurgeRevocations(db, owner, logical, id),
    };
  };
}

const ENTITY_KINDS: ReadonlySet<string> = new Set(
  entitySupertypeMembers().map(([logical]) => logical)
);

function primaryKeyColumn(db: VaultDb, physical: string): string | undefined {
  const cols = db.vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as { name: string; pk: number }[];
  const keys = cols.filter((c) => c.pk > 0);
  return keys.length === 1 ? keys[0]?.name : undefined;
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

const CONTENT_RENTED_ELSEWHERE_SQL = `SELECT (
  ${contentReferenceExists({
    idExpression: ":content_id",
    live: true,
    includeDocumentHead: false,
  })
    .map((clause) => `EXISTS(${clause})`)
    .join("\n  OR ")}
) AS n`;

function contentRentedElsewhere(db: VaultDb, contentId: string): boolean {
  const row = db.vault.prepare(CONTENT_RENTED_ELSEWHERE_SQL).get({
    content_id: contentId,
  }) as {
    n: number;
  };
  return row.n > 0;
}

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

function isLineageSource(db: VaultDb, assetId: string): boolean {
  const row = db.vault
    .prepare(
      "SELECT 1 AS present FROM media_asset WHERE source_asset_id = ? LIMIT 1"
    )
    .get(assetId) as { present: number } | undefined;
  return row !== undefined;
}

function deleteAssetRow(db: VaultDb, owner: Identity, assetId: string): number {
  db.vault
    .prepare("DELETE FROM media_face_region WHERE asset_id = ?")
    .run(assetId);
  db.vault.prepare("DELETE FROM media_asset WHERE asset_id = ?").run(assetId);
  writeProvenance(db.audit, owner, "media.asset", assetId, "sweep.purge");
  return receiptPurgeRevocations(db, owner, "media.asset", assetId);
}

interface ContentPurgeResult {
  reclaimed: number;
  blockedByAssetId: string | null;
  authorityRevoked: number;
}

function purgeContentItem(
  db: VaultDb,
  owner: Identity,
  contentId: string
): ContentPurgeResult {
  let reclaimed = 0;
  let authorityRevoked = 0;
  const asset = db.vault
    .prepare("SELECT asset_id FROM media_asset WHERE content_id = ?")
    .get(contentId) as { asset_id: string } | undefined;
  if (asset) {
    if (isLineageSource(db, asset.asset_id))
      return {
        reclaimed: 0,
        blockedByAssetId: asset.asset_id,
        authorityRevoked: 0,
      };
    authorityRevoked += deleteAssetRow(db, owner, asset.asset_id);
  }
  db.vault
    .prepare(
      "UPDATE core_collection SET cover_content_id = NULL WHERE cover_content_id = ?"
    )
    .run(contentId);
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
  writeProvenance(
    db.audit,
    owner,
    "core.content_item",
    contentId,
    "sweep.purge"
  );
  authorityRevoked += receiptPurgeRevocations(
    db,
    owner,
    "core.content_item",
    contentId
  );
  return { reclaimed, blockedByAssetId: null, authorityRevoked };
}

const DOMAIN_TRASH_TABLES: readonly {
  physical: string;
  idCol: string;
  entity: string;
  dependents?: readonly { table: string; column: string }[];
  orderBy?: string;
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
  {
    physical: "schedule_task",
    idCol: "task_id",
    entity: "schedule.task",
    orderBy: "parent_task_id IS NULL, task_id",
  },
  {
    physical: "locker_item",
    idCol: "item_id",
    entity: "locker.item",
    dependents: [
      { table: "locker_item_field", column: "item_id" },
      { table: "locker_item_address", column: "item_id" },
      { table: "locker_item_passkey", column: "item_id" },
      { table: "locker_item_alias", column: "item_id" },
    ],
  },
  {
    physical: "core_event",
    idCol: "event_id",
    entity: "core.event",
    dependents: [
      { table: "schedule_attendee", column: "event_id" },
      { table: "schedule_event_ext", column: "event_id" },
    ],
  },
];

function receiptPurgeRevocations(
  db: VaultDb,
  owner: Identity,
  entityType: string,
  entityId: string
): number {
  const ended = db.vault
    .prepare(
      `SELECT authority_id, principal_kind, principal_id, subject_type,
              subject_id, verb, decision, revoked_reason
         FROM share_authority
        WHERE revoked_at IS NOT NULL AND receipt_id IS NULL
          AND revoked_reason IN ('subject-purged','principal-purged')
          AND ((subject_type = ? AND subject_id = ?)
               OR (revoked_reason = 'principal-purged' AND principal_id = ?))`
    )
    .all(entityType, entityId, entityId) as {
    authority_id: string;
    principal_kind: string;
    principal_id: string;
    subject_type: string;
    subject_id: string;
    verb: string;
    decision: string;
    revoked_reason: string;
  }[];
  const stamp = db.vault.prepare(
    "UPDATE share_authority SET receipt_id = ? WHERE authority_id = ?"
  );
  for (const row of ended) {
    const receiptId = writeReceipt(db.audit, {
      grantId: row.authority_id,
      invocationId: null,
      action: "act share.revoke",
      objectType: "share.authority",
      objectId: row.authority_id,
      purpose: null,
      decision: "allow",
      detail: {
        cause: row.revoked_reason,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        principalKind: row.principal_kind,
        principalId: row.principal_id,
        verb: row.verb,
        answered: row.decision,
        revokedBy: owner.partyId,
      },
    });
    stamp.run(receiptId, row.authority_id);
  }
  return ended.length;
}

function revokeExpiredAuthority(
  db: VaultDb,
  owner: Identity,
  now: string
): number {
  const expired = db.vault
    .prepare(
      `SELECT authority_id, principal_kind, principal_id, subject_type,
              subject_id, verb, decision, expires_at
         FROM share_authority
        WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at`
    )
    .all(now) as {
    authority_id: string;
    principal_kind: string;
    principal_id: string;
    subject_type: string;
    subject_id: string;
    verb: string;
    decision: string;
    expires_at: string;
  }[];
  const revoke = db.vault.prepare(
    `UPDATE share_authority SET revoked_at = ?, revoked_reason = 'expired', receipt_id = ?
      WHERE authority_id = ? AND revoked_at IS NULL`
  );
  for (const row of expired) {
    const receiptId = writeReceipt(db.audit, {
      grantId: row.authority_id,
      invocationId: null,
      action: "act share.revoke",
      objectType: "share.authority",
      objectId: row.authority_id,
      purpose: null,
      decision: "allow",
      detail: {
        cause: "expired",
        expiresAt: row.expires_at,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        principalKind: row.principal_kind,
        principalId: row.principal_id,
        verb: row.verb,
        answered: row.decision,
        revokedBy: owner.partyId,
      },
    });
    revoke.run(now, receiptId, row.authority_id);
  }
  return expired.length;
}

function purgeDomainTrash(
  db: VaultDb,
  owner: Identity,
  now: string,
  limit: number,
  skipped: SweepSkip[]
): { purged: number; authorityRevoked: number } {
  let purged = 0;
  let authorityRevoked = 0;
  for (const t of DOMAIN_TRASH_TABLES) {
    const order = t.orderBy ? ` ORDER BY ${t.orderBy}` : " ORDER BY purge_at";
    const lapsed = db.vault
      .prepare(
        t.physical === "people_profile"
          ? `SELECT "${t.idCol}" AS id, party_id AS party_id FROM "${t.physical}" WHERE purge_at IS NOT NULL AND purge_at <= ?${order} LIMIT ?`
          : `SELECT "${t.idCol}" AS id FROM "${t.physical}" WHERE purge_at IS NOT NULL AND purge_at <= ?${order} LIMIT ?`
      )
      .all(now, limit) as { id: string; party_id?: string }[];
    for (const row of lapsed) {
      const done = purgeOneRow(db, skipped, t.entity, row.id, () => {
        for (const dependent of t.dependents ?? [])
          db.vault
            .prepare(
              `DELETE FROM "${dependent.table}" WHERE "${dependent.column}" = ?`
            )
            .run(row.id);
        db.vault
          .prepare(`DELETE FROM "${t.physical}" WHERE "${t.idCol}" = ?`)
          .run(row.id);
        writeProvenance(db.audit, owner, t.entity, row.id, "sweep.purge");
        authorityRevoked += receiptPurgeRevocations(
          db,
          owner,
          t.entity,
          row.id
        );
        if (t.physical === "people_profile" && row.party_id)
          authorityRevoked += purgePartyRow(db, owner, row.party_id);
      });
      if (done) purged += 1;
    }
  }
  return { purged, authorityRevoked };
}

function purgePartyRow(db: VaultDb, owner: Identity, partyId: string): number {
  const ownerRow = db.vault
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string } | undefined;
  if (!ownerRow || ownerRow.self_party_id === partyId) return 0;
  const party = db.vault
    .prepare("SELECT kind FROM core_party WHERE party_id = ?")
    .get(partyId) as { kind: string } | undefined;
  if (!party || party.kind !== "person") return 0;
  for (const table of [
    "core_party_identifier",
    "people_important_date",
  ] as const)
    db.vault.prepare(`DELETE FROM "${table}" WHERE party_id = ?`).run(partyId);
  try {
    db.vault.prepare("DELETE FROM core_party WHERE party_id = ?").run(partyId);
  } catch (error) {
    throw new Error(
      `core.party ${partyId} cannot be erased while these rows still name it: ${partyBlockers(
        db,
        partyId
      ).join(", ")}`,
      { cause: error }
    );
  }
  writeProvenance(db.audit, owner, "core.party", partyId, "sweep.purge");
  return receiptPurgeRevocations(db, owner, "core.party", partyId);
}

function partyBlockers(db: VaultDb, partyId: string): string[] {
  const blockers: string[] = [];
  const tables = db.vault
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != 'core_party'`
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    const fks = db.vault
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`)
      .all() as { table: string; from: string; on_delete: string }[];
    for (const fk of fks) {
      if (fk.table !== "core_party") continue;
      if (fk.on_delete === "SET NULL" || fk.on_delete === "CASCADE") continue;
      const row = db.vault
        .prepare(
          `SELECT count(*) AS n FROM ${JSON.stringify(name)} WHERE ${JSON.stringify(fk.from)} = ?`
        )
        .get(partyId) as { n: number };
      if (row.n > 0) blockers.push(`${name}.${fk.from} (${row.n})`);
    }
  }
  return blockers;
}

function purgeLapsedAssets(
  db: VaultDb,
  owner: Identity,
  now: string,
  limit: number,
  skipped: SweepSkip[]
): { purged: number; blocked: string[]; authorityRevoked: number } {
  let authorityRevoked = 0;
  const pending = new Set(
    (
      db.vault
        .prepare(
          `SELECT asset_id FROM media_asset
            WHERE purge_at IS NOT NULL AND purge_at <= ?
            ORDER BY purge_at LIMIT ?`
        )
        .all(now, limit) as { asset_id: string }[]
    ).map((row) => row.asset_id)
  );
  const children = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const row of db.vault
    .prepare(
      `SELECT asset_id, source_asset_id FROM media_asset
        WHERE source_asset_id IS NOT NULL`
    )
    .all() as { asset_id: string; source_asset_id: string }[]) {
    if (!pending.has(row.source_asset_id)) continue;
    children.set(row.source_asset_id, [
      ...(children.get(row.source_asset_id) ?? []),
      row.asset_id,
    ]);
    parentOf.set(row.asset_id, row.source_asset_id);
  }
  const blocking = new Map<string, number>();
  for (const assetId of pending)
    blocking.set(assetId, children.get(assetId)?.length ?? 0);
  const ready = [...pending].filter((assetId) => blocking.get(assetId) === 0);
  let purged = 0;
  while (ready.length > 0) {
    const assetId = ready.pop()!;
    const done = purgeOneRow(db, skipped, "media.asset", assetId, () => {
      authorityRevoked += deleteAssetRow(db, owner, assetId);
    });
    pending.delete(assetId);
    if (!done) continue;
    purged += 1;
    const parent = parentOf.get(assetId);
    if (parent === undefined || !pending.has(parent)) continue;
    const remaining = (blocking.get(parent) ?? 1) - 1;
    blocking.set(parent, remaining);
    if (remaining === 0) ready.push(parent);
  }
  return { purged, blocked: [...pending], authorityRevoked };
}

const PURGE_BATCH = 5_000;

export function sweepLifecycle(db: VaultDb, owner: Identity): SweepResult {
  const now = nowIso();
  let blobsReclaimed = 0;
  let authorityRevoked = 0;
  const skipped: SweepSkip[] = [];
  const contentBlockedByLineage: string[] = [];
  const grants = db.vault
    .prepare(
      `UPDATE access_grant SET status='expired'
        WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?`
    )
    .run(now);
  const purgeable = db.vault
    .prepare(
      `SELECT content_id FROM core_content_item
        WHERE purge_at IS NOT NULL AND purge_at <= ?
        ORDER BY purge_at LIMIT ?`
    )
    .all(now, PURGE_BATCH) as { content_id: string }[];
  const lapsedNotes = db.vault
    .prepare(
      `SELECT note_id FROM knowledge_note
        WHERE purge_at IS NOT NULL AND purge_at <= ?
        ORDER BY purge_at LIMIT ?`
    )
    .all(now, PURGE_BATCH) as { note_id: string }[];
  let notesPurged = 0;
  for (const n of lapsedNotes) {
    const done = purgeOneRow(db, skipped, "knowledge.note", n.note_id, () => {
      db.vault
        .prepare("DELETE FROM knowledge_note WHERE note_id = ?")
        .run(n.note_id);
      writeProvenance(
        db.audit,
        owner,
        "knowledge.note",
        n.note_id,
        "sweep.purge"
      );
      authorityRevoked += receiptPurgeRevocations(
        db,
        owner,
        "knowledge.note",
        n.note_id
      );
    });
    if (done) notesPurged += 1;
  }
  const revisesId = revisesConceptId(db);
  const lapsedDocuments = db.vault
    .prepare(
      `SELECT document_id, current_content_id FROM core_document
        WHERE purge_at IS NOT NULL AND purge_at <= ?
        ORDER BY purge_at LIMIT ?`
    )
    .all(now, PURGE_BATCH) as {
    document_id: string;
    current_content_id: string;
  }[];
  let documentsPurged = 0;
  for (const doc of lapsedDocuments) {
    const chain = revisesId
      ? documentChain(db, doc.current_content_id, revisesId)
      : [doc.current_content_id];
    const done = purgeOneRow(
      db,
      skipped,
      "core.document",
      doc.document_id,
      () => {
        db.vault
          .prepare("DELETE FROM core_document WHERE document_id = ?")
          .run(doc.document_id);
        writeProvenance(
          db.audit,
          owner,
          "core.document",
          doc.document_id,
          "sweep.purge"
        );
        authorityRevoked += receiptPurgeRevocations(
          db,
          owner,
          "core.document",
          doc.document_id
        );
      }
    );
    if (!done) continue;
    documentsPurged += 1;
    for (const contentId of chain) {
      if (contentRentedElsewhere(db, contentId)) continue;
      if (
        revisesId &&
        ownedByAnotherLiveDocument(db, contentId, doc.document_id, revisesId)
      )
        continue;
      purgeOneRow(db, skipped, "core.content_item", contentId, () => {
        const purge = purgeContentItem(db, owner, contentId);
        blobsReclaimed += purge.reclaimed;
        authorityRevoked += purge.authorityRevoked;
        if (purge.blockedByAssetId !== null)
          contentBlockedByLineage.push(contentId);
      });
    }
  }
  let contentPurged = 0;
  for (const row of purgeable) {
    if (contentRentedElsewhere(db, row.content_id)) continue;
    purgeOneRow(db, skipped, "core.content_item", row.content_id, () => {
      const purge = purgeContentItem(db, owner, row.content_id);
      blobsReclaimed += purge.reclaimed;
      authorityRevoked += purge.authorityRevoked;
      if (purge.blockedByAssetId === null) contentPurged += 1;
      else contentBlockedByLineage.push(row.content_id);
    });
  }
  const lapsedAssets = purgeLapsedAssets(db, owner, now, PURGE_BATCH, skipped);
  authorityRevoked += lapsedAssets.authorityRevoked;
  const domainTrash = purgeDomainTrash(db, owner, now, PURGE_BATCH, skipped);
  const domainRowsPurged = domainTrash.purged;
  authorityRevoked += domainTrash.authorityRevoked;
  authorityRevoked += revokeExpiredAuthority(db, owner, now);
  db.vault
    .prepare(
      `UPDATE social_thread SET last_message_at =
         (SELECT MAX(sent_at) FROM social_message WHERE social_message.thread_id = social_thread.thread_id)
        WHERE last_message_at IS NOT
         (SELECT MAX(sent_at) FROM social_message WHERE social_message.thread_id = social_thread.thread_id)`
    )
    .run();
  const retention = enforceRetention(db, owner, now, skipped);
  const retentionDeleted = retention.deleted;
  blobsReclaimed += retention.reclaimed;
  authorityRevoked += retention.authorityRevoked;
  const staging = sweepBlobStaging(db, { now });
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act access.lifecycle_sweep",
    objectType: "access.policy",
    objectId: null,
    purpose: null,
    decision: "allow",
    detail: {
      grantsExpired: Number(grants.changes),
      contentPurged,
      assetsPurged: lapsedAssets.purged,
      notesPurged,
      documentsPurged,
      domainRowsPurged,
      retentionDeleted,
      retentionRefused: retention.refused,
      contentBlockedByLineage,
      assetsBlockedByLineage: lapsedAssets.blocked,
      blobsReclaimed,
      stagingExpired: staging.expired.length,
      authorityRevoked,
      skipped,
    },
  });
  return {
    grantsExpired: Number(grants.changes),
    contentPurged,
    assetsPurged: lapsedAssets.purged,
    notesPurged,
    documentsPurged,
    domainRowsPurged,
    retentionDeleted,
    retentionRefused: retention.refused,
    contentBlockedByLineage,
    assetsBlockedByLineage: lapsedAssets.blocked,
    blobsReclaimed,
    stagingExpired: staging.expired.length,
    authorityRevoked,
    skipped,
    receiptId,
  };
}

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
  writeProvenance(db.audit, importer, entityType, entityId, `import.${batch}`, {
    external_id: externalId,
  });
  return entityId;
}

export function resolveHandle(
  db: VaultDb,
  scheme: string,
  value: string
): string | null {
  return partyForReach(db.vault, scheme, value, nowIso());
}
