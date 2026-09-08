// governance: allow-repo-hygiene file-size-limit one sweep pipeline; splitting it scatters a single transaction's reasoning across files.
// Standing duties (§10). Not request-shaped; still writes receipts.

import { liveBlobShas } from "../blob/read.js";
import { sweepBlobStaging } from "../blob/staging.js";
import { shaOfBlobUri } from "../blob/store.js";
import { partyForReach } from "../commands/contact-reach.js";
import { RELATIONS_SCHEME_URI } from "../commands/links.js";
import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { contentReferenceExists } from "../schema/content-references.js";
import { writeProvenance, writeAuthorityReceipt } from "./evidence.js";
import type { Identity } from "./types.js";

export interface RevocationResult {
  /** The `share_authority` row that was withdrawn (#928, one id space). */
  authorityId: string;
  /** The principal it answered about — an automation's own id. */
  principalId: string;
  parkedDropped: number;
  receiptId: string;
}

/**
 * Withdraw ONE standing answer (#928, AP-one-id-space). Revoke is instant, and
 * what it leaves behind is the point: the row stays as history with
 * `revoked_at` stamped, so "asked and told no" never reads as "never asked",
 * and every receipt naming it survives. Parked work that rode the answer is
 * dropped by the caller's callback, which owns the parked queue.
 *
 * The ext band is not touched here: a first-party app holds no answer to
 * withdraw (#928 A1), and its band is retained when the APP is retired —
 * `retainExtBand`, called from the uninstall path.
 */
export function revokeAuthorityCascade(
  db: VaultDb,
  owner: Identity,
  authorityId: string,
  dropParked: (authorityId: string) => number
): RevocationResult {
  const now = nowIso();
  const answer = db.vault
    .prepare(
      `SELECT authority_id, principal_id FROM share_authority
        WHERE authority_id = ? AND principal_kind = 'automation'`
    )
    .get(authorityId) as
    | { authority_id: string; principal_id: string }
    | undefined;
  if (!answer) throw new Error(`no standing answer ${authorityId}`);
  db.vault
    .prepare(
      `UPDATE share_authority SET revoked_at = ?
        WHERE authority_id = ? AND revoked_at IS NULL`
    )
    .run(now, authorityId);
  const parkedDropped = dropParked(authorityId);
  const receiptId = writeAuthorityReceipt(db, {
    authorityId,
    invocationId: null,
    action: "act share.revoke_authority",
    objectType: "share.authority",
    objectId: authorityId,
    decision: "allow",
    detail: { parkedDropped, revokedBy: owner.partyId },
  });
  writeProvenance(
    db.audit,
    owner,
    "share.authority",
    authorityId,
    "owner.revoke"
  );
  return {
    authorityId,
    principalId: answer.principal_id,
    parkedDropped,
    receiptId,
  };
}

export interface SweepResult {
  contentPurged: number;
  assetsPurged: number;
  notesPurged: number;
  documentsPurged: number;
  domainRowsPurged: number;
  /** Lineage-blocked (#711): `purge_at` stays lapsed, retried next sweep. */
  contentBlockedByLineage: string[];
  assetsBlockedByLineage: string[];
  blobsReclaimed: number;
  /** Unclaimed `blob_staging` rows past the TTL, dropped with their bytes. */
  stagingExpired: number;
  /**
   * Answers the sweep ended: the purge of a subject revokes every live answer
   * about it through the `core_entity` trigger (#916 E2), and an answer past
   * its own `expires_at` is revoked here (review 6.1). Each one is receipted.
   */
  authorityRevoked: number;
  /**
   * Rows this pass could not finish, each with the reason (#916, review
   * 1.2/10.5). A named skip is what keeps ONE wedged row from stopping every
   * later pass forever — the sweep used to run in autocommit with no
   * isolation, so a single FK refusal aborted the tick and every tick after.
   */
  skipped: SweepSkip[];
  receiptId: string;
}

export interface SweepSkip {
  entity: string;
  id: string;
  reason: string;
}

/**
 * One row, one savepoint (#916, review 1.2/10.5). The sweep is the only
 * mutator outside the command pipeline, and it used to be the only untransacted
 * one: a purge that threw left its provenance committed and its mutation half
 * done. Everything a row's purge does — the delete, its provenance, the
 * receipts for the answers it ended — either lands together or not at all, and
 * the failure becomes a named skip rather than a dead sweep.
 */
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

/** Full BFS over live `revises`: R3 restore can cycle, so the seen-set is load-bearing. */
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

/**
 * The ONE content-reference list minus `core_document`: "still in a live
 * document's HISTORY" is the chain walk above. Generated, never hand-written —
 * a twin falls behind the list it mirrors (#883).
 */
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

/** sha256 dedup: a superseded revision can coincide with a live page. */
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

/** Edit-lineage self-FK (#711): trashed children count, the FK has no ON DELETE. */
function isLineageSource(db: VaultDb, assetId: string): boolean {
  const row = db.vault
    .prepare(
      "SELECT 1 AS present FROM media_asset WHERE source_asset_id = ? LIMIT 1"
    )
    .get(assetId) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Face regions have no CASCADE from the asset, so they go by hand; a region is
 * itself an entity, so everything pointing AT one (its face vector, its
 * derivation stamps) cascades away with it (#916). Callers must already know
 * this is not a lineage source.
 *
 * PROVENANCE AFTER THE MUTATION (#916, review 1.2/10.5): written first, it
 * claimed a purge that had not happened yet — and, in the untransacted sweep
 * this replaced, one that might never happen.
 */
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

/** Derivatives and CAS first (FK), then the row; every pointer at it cascades (#296, #916). */
function purgeContentItem(
  db: VaultDb,
  owner: Identity,
  contentId: string
): ContentPurgeResult {
  let reclaimed = 0;
  let authorityRevoked = 0;
  // The asset references the content NOT NULL: purging one purges both.
  const asset = db.vault
    .prepare("SELECT asset_id FROM media_asset WHERE content_id = ?")
    .get(contentId) as { asset_id: string } | undefined;
  if (asset) {
    // Edit lineage (#711): NULLing the child's column forges "camera
    // original", cascading destroys an untrashed photograph. Decline the whole
    // content item (content_id FK NOT NULL), as `media.purge_asset` does;
    // `purge_at` stays lapsed and the skip is named in the receipt.
    if (isLineageSource(db, asset.asset_id))
      return {
        reclaimed: 0,
        blockedByAssetId: asset.asset_id,
        authorityRevoked: 0,
      };
    authorityRevoked += deleteAssetRow(db, owner, asset.asset_id);
  }
  // A cover pointing at these bytes goes dark, or the FK refuses.
  db.vault
    .prepare(
      "UPDATE core_collection SET cover_content_id = NULL WHERE cover_content_id = ?"
    )
    .run(contentId);
  // Derivatives go with their parent (#296), registry rows first for the FK;
  // sha256 is UNIQUE on content items, so nothing else claims the original.
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
  // Bytes go only when their FINAL claim disappears (#750). sha256 is not
  // unique across derivatives, so re-derive the live set AFTER the deletes; a
  // skipped sha falls to the orphan sweep.
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

/** Soft-delete tables with no bespoke purge (#441): the next domain is one entry here. */
const DOMAIN_TRASH_TABLES: readonly {
  physical: string;
  idCol: string;
  entity: string;
  /** Engine FKs with no `ON DELETE CASCADE`: ignoring them aborts the sweep. */
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
  // Tasks and Agenda (#883). `schedule_task` first: a purged parent must not
  // strand a sub-task referencing it.
  {
    physical: "schedule_task",
    idCol: "task_id",
    entity: "schedule.task",
    // Sub-tasks before parents: `parent_task_id` self-references with no
    // cascade.
    orderBy: "parent_task_id IS NULL, task_id",
  },
  // Locker (#916, review 1.3). `locker.item` had a trash pair and a purge
  // COMMAND, and nothing that ran when the window lapsed: a trashed password
  // sat in the vault forever while every other domain's trash emptied. Its
  // sidecars have no cascade from the item, so they go first.
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

/**
 * A purged subject ENDS the standing answers about it, dated and receipted
 * (#883). The ENDING is the engine's since #916 (E2): a `BEFORE DELETE`
 * trigger on `core_entity` stamps `revoked_at` and a `revoked_reason` on every
 * live answer naming the purged row, so it cannot be forgotten at a call site
 * the way a hand-called sweep could. What is left here is the RECEIPT — the
 * member-facing record of a share that ended without anyone saying so — read
 * back from the rows the trigger just marked.
 */
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
    const receiptId = writeAuthorityReceipt(db, {
      authorityId: row.authority_id,
      invocationId: null,
      action: "act share.revoke",
      objectType: "share.authority",
      objectId: row.authority_id,
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

/**
 * An answer past its own end date is over (#916, review 6.1). `expires_at` was
 * written at every "until Friday" grant and read by nothing, so a time-boxed
 * share answered yes forever. The resolvers now exclude it the moment it
 * lapses; this is what makes the row SAY so, and leaves the member a receipt.
 */
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
    const receiptId = writeAuthorityReceipt(db, {
      authorityId: row.authority_id,
      invocationId: null,
      action: "act share.revoke",
      objectType: "share.authority",
      objectId: row.authority_id,
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

/**
 * The purge of a lapsed trashed row: ONE delete, per row, in its own savepoint
 * (#916). Every pointer at the row is a composite foreign key into
 * `core_entity`, so the engine sweeps or refuses; provenance follows the
 * mutation; a refusal is a NAMED SKIP, not a dead sweep (review 1.2/10.5).
 */
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

/**
 * A purged person's PARTY row, deleted like any other entity (#916, D1).
 *
 * What this replaced walked every foreign key onto `core_party` and, wherever
 * the column was NOT NULL, deleted the referencing row — swallowing whatever
 * refused. That destroyed other people's money: the splits of a shared expense
 * name a party, so erasing a friend silently left Σ splits ≠ the amount
 * (review 1.4, adversarial BUG-1/BUG-2). The schema now decides instead:
 * pointers that are merely attribution are `ON DELETE SET NULL`, and the money
 * and authority rows are `RESTRICT`. So the delete is ORDINARY, and when the
 * member still has ledgers naming this person the ENGINE refuses it — which is
 * the right answer, and the one the caller can act on, because the blockers
 * are named.
 */
function purgePartyRow(db: VaultDb, owner: Identity, partyId: string): number {
  const ownerRow = db.vault
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string } | undefined;
  if (!ownerRow || ownerRow.self_party_id === partyId) return 0;
  const party = db.vault
    .prepare("SELECT kind FROM core_party WHERE party_id = ?")
    .get(partyId) as { kind: string } | undefined;
  if (!party || party.kind !== "person") return 0;
  // THE PERSON'S OWN ROWS GO WITH THEM, DELIBERATELY. An identifier, a
  // birthday and a way to reach someone are facts ABOUT this person and say
  // nothing without them — leaving them behind is how a "purged" person keeps
  // turning up in the agenda and the reach index (#864). Money and authority
  // are NOT here: those are other people's records, and the engine refuses the
  // delete while they name this party (#916, D1).
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

/**
 * WHICH rows refused the erasure, for the denial to name. A refusal a member
 * cannot act on is indistinguishable from a bug, so the engine's one-line
 * "FOREIGN KEY constraint failed" is turned back into the list of tables that
 * still point at the person.
 */
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

/**
 * Derived copies first (#711). Self-FK: never hand SQLite a delete it will
 * refuse; skip a lapsed source whose child is not lapsed. ONE PASS OVER THE
 * LINEAGE, NOT ONE PER GENERATION (#883): the dependency is a DAG in
 * `media_asset.source_asset_id`, read ONCE and drained leaves-first in Kahn's
 * order, because re-asking SQLite per blocked asset costs O(n^2) per tick.
 */
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
  // Children of the pending set, one indexed sweep. A child OUTSIDE it never
  // leaves, so its parent stays blocked — the "lapsed source, unlapsed child"
  // rule, decided by counting.
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

/**
 * Rows one lifecycle sweep purges from any ONE lapsed set (#883). Every purge
 * SELECT stays bounded: the gateway is one process with one vault handle, so
 * an unbounded pass over an emptied year-3 trash IS the gateway. The GDPR
 * promise holds — rows go oldest-first, and the next tick takes the rest.
 */
const PURGE_BATCH = 5_000;

/** Lapse standing answers and execute `purge_at` deletions. */
export function sweepLifecycle(db: VaultDb, owner: Identity): SweepResult {
  const now = nowIso();
  let blobsReclaimed = 0;
  let authorityRevoked = 0;
  const skipped: SweepSkip[] = [];
  const contentBlockedByLineage: string[] = [];
  const purgeable = db.vault
    .prepare(
      `SELECT content_id FROM core_content_item
        WHERE purge_at IS NOT NULL AND purge_at <= ?
        ORDER BY purge_at LIMIT ?`
    )
    .all(now, PURGE_BATCH) as { content_id: string }[];
  // Purges are the one hard delete outside the command pipeline. Notes FIRST
  // (#308): a note rents its body NOT NULL, so the row goes before this pass
  // frees the bytes.
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
  // Documents next (#352), same NOT NULL reason; each chain item is judged at
  // purge, not while the document lives.
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
    // THE LAST-MOMENT RENTED CHECK (#916, review 1.2). The direct pass used to
    // call the purge without it, so a lapsed content item that some live row
    // still rents — a note's body, a document's page — threw a foreign key
    // error mid-sweep and, in the untransacted sweep this replaced, wedged
    // every later pass forever.
    if (contentRentedElsewhere(db, row.content_id)) continue;
    purgeOneRow(db, skipped, "core.content_item", row.content_id, () => {
      const purge = purgeContentItem(db, owner, row.content_id);
      blobsReclaimed += purge.reclaimed;
      authorityRevoked += purge.authorityRevoked;
      if (purge.blockedByAssetId === null) contentPurged += 1;
      else contentBlockedByLineage.push(row.content_id);
    });
  }
  // A lapsed trashed asset purges while its bytes stay rented elsewhere
  // (#274): meaning and byte custody have independent lifecycles.
  const lapsedAssets = purgeLapsedAssets(db, owner, now, PURGE_BATCH, skipped);
  authorityRevoked += lapsedAssets.authorityRevoked;
  // After the content/asset passes: a row referencing purged bytes goes last.
  const domainTrash = purgeDomainTrash(db, owner, now, PURGE_BATCH, skipped);
  const domainRowsPurged = domainTrash.purged;
  authorityRevoked += domainTrash.authorityRevoked;
  // An answer that ran out of time ends here, receipted (review 6.1).
  authorityRevoked += revokeExpiredAuthority(db, owner, now);
  // Heal the rebuildable projection (#441 A3). KEEP THE PREDICATE (#883):
  // unqualified, this dirties every thread row every tick — WAL pages, replica
  // rows, woken devices — to fix the few that drifted. `IS NOT`, not `<>`, so
  // a thread whose last message was deleted is left alone.
  db.vault
    .prepare(
      `UPDATE social_thread SET last_message_at =
         (SELECT MAX(sent_at) FROM social_message WHERE social_message.thread_id = social_thread.thread_id)
        WHERE last_message_at IS NOT
         (SELECT MAX(sent_at) FROM social_message WHERE social_message.thread_id = social_thread.thread_id)`
    )
    .run();
  // Staging TTL (#296): a batch hold pins past it.
  const staging = sweepBlobStaging(db, { now });
  const receiptId = writeAuthorityReceipt(db, {
    authorityId: null,
    invocationId: null,
    action: "act access.lifecycle_sweep",
    objectType: "core.vault",
    objectId: null,
    decision: "allow",
    detail: {
      contentPurged,
      assetsPurged: lapsedAssets.purged,
      notesPurged,
      documentsPurged,
      domainRowsPurged,
      // Declined, not died on (#711).
      contentBlockedByLineage,
      assetsBlockedByLineage: lapsedAssets.blocked,
      blobsReclaimed,
      stagingExpired: staging.expired.length,
      authorityRevoked,
      skipped,
    },
  });
  return {
    contentPurged,
    assetsPurged: lapsedAssets.purged,
    notesPurged,
    documentsPurged,
    domainRowsPurged,
    contentBlockedByLineage,
    assetsBlockedByLineage: lapsedAssets.blocked,
    blobsReclaimed,
    stagingExpired: staging.expired.length,
    authorityRevoked,
    skipped,
    receiptId,
  };
}

/** Import-batch dedupe on `external_id`; null means already imported. */
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
  // Reach schemes resolve through `social_contact_channel`, identity keys
  // through the register: one call over two stores.
  return partyForReach(db.vault, scheme, value, nowIso());
}
