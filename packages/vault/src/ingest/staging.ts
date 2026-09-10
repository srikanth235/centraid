// Candidates land as sync_import_row rows with a computed disposition; publish
// applies them in one transaction, with provenance and one batch receipt.
//
// Dispositions come from two layers: the external-id map, where an unchanged
// content hash skips and a changed one stages an UPDATE for review (vault-wins
// — upstream never applies silently); and a per-entity probe on domain-native
// keys, which is how a pre-map vault adopts rows instead of duplicating them.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { releaseBatchHold } from "../blob/staging.js";
import type { VaultDb } from "../db.js";
import { pkColumn } from "../gateway/execution.js";
import type { Identity } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import {
  isSealedValue,
  sealAad,
  sealValue,
  sealedColumnsOf,
  sealedPayloadFieldsOf,
  stampSealKeyFingerprint,
  unsealValue,
} from "../schema/sealed.js";
import { resolveEntity } from "../schema/tables.js";
import {
  writeProvenance,
  writeAuthorityReceipt,
} from "./../gateway/evidence.js";

export function payloadAad(rowId: string, field: string): string {
  return sealAad("sync_import_row", `payload.${field}`, rowId);
}

export interface StageCandidate {
  entityType: string;
  /** `(connection, external_id)` is the sync key. */
  externalId: string;
  payload: Record<string, unknown>;
}

export interface PublishedWrite {
  type: string;
  id: string;
}

/** `create`/`update` must report every row they touched, for provenance. */
export interface Publisher {
  entityType: string;
  probe: (
    vault: DatabaseSync,
    payload: Record<string, unknown>
  ) => {
    entityId: string;
    disposition: "update" | "skip";
    note?: string;
  } | null;
  create: (
    vault: DatabaseSync,
    ownerPartyId: string,
    payload: Record<string, unknown>,
    now: string
  ) => { entityId: string; wrote: PublishedWrite[] };
  update: (
    vault: DatabaseSync,
    entityId: string,
    payload: Record<string, unknown>,
    now: string,
    ownerPartyId: string
  ) => { wrote: PublishedWrite[] };
}

export interface StageResult {
  connectionId: string;
  batchId: string;
  staged: {
    create: number;
    update: number;
    skip: number;
    "merge-candidate": number;
  };
  total: number;
  receiptId: string;
}

export interface PublishResult {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
  failed: { externalId: string; error: string }[];
  receiptId: string;
}

/** Sorted keys, so the hash is stable across key order. */
export function payloadHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]])
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Find-or-create; file drops key on (kind, label). */
export function ensureConnectionTx(
  vault: DatabaseSync,
  options: { kind: string; label: string; principal?: string }
): string {
  const existing = vault
    .prepare(
      "SELECT connection_id FROM sync_connection WHERE kind = ? AND label = ?"
    )
    .get(options.kind, options.label) as { connection_id: string } | undefined;
  if (existing) return existing.connection_id;
  const connectionId = uuidv7();
  vault
    .prepare(
      `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at, last_run_at)
       VALUES (?, ?, ?, ?, 'active', 'staged', ?, NULL)`
    )
    .run(
      connectionId,
      options.kind,
      options.label,
      options.principal ?? null,
      nowIso()
    );
  return connectionId;
}

export function ensureConnection(
  db: VaultDb,
  options: { kind: string; label: string; principal?: string }
): string {
  return ensureConnectionTx(db.vault, options);
}

/**
 * HOW OFTEN ONE ROW IS RE-STAGED AFTER PUBLISH REFUSED IT (#1014, B8).
 *
 * A row that threw inside `applyBatchTx` left no map entry, so the next pull
 * staged the same external id again, it failed again, and the member got a
 * fresh review draft every poll forever while `sync_import_row` grew without
 * bound. The count is durable — it rides the batch receipt's own summary, the
 * one place a failure was already recorded — and past the cap the candidate is
 * staged as a `skip` that says so instead of a `create` that cannot land.
 */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** How many recent receipts the attempt count is summed over. */
const PUBLISH_FAILURE_LOOKBACK_BATCHES = 50;

interface BatchFailureSummary {
  readonly failures?: { externalId: string; attempts: number }[];
}

/**
 * Publish failures per external id for one connection, read back from the
 * batch receipts. Bounded by `PUBLISH_FAILURE_LOOKBACK_BATCHES`: an id whose
 * failures have scrolled out of the window is genuinely retried, which is the
 * right answer for a provider outage measured in weeks.
 */
export function publishFailureAttempts(
  vault: DatabaseSync,
  connectionId: string
): Map<string, number> {
  const rows = vault
    .prepare(
      `SELECT summary_json FROM sync_import_batch
        WHERE connection_id = ? AND status = 'published'
        ORDER BY created_at DESC, batch_id DESC
        LIMIT ?`
    )
    .all(connectionId, PUBLISH_FAILURE_LOOKBACK_BATCHES) as {
    summary_json: string;
  }[];
  const attempts = new Map<string, number>();
  for (const row of rows) {
    let summary: BatchFailureSummary;
    try {
      summary = JSON.parse(row.summary_json) as BatchFailureSummary;
    } catch {
      continue;
    }
    for (const failure of summary.failures ?? []) {
      if (typeof failure?.externalId !== "string") continue;
      // The newest receipt already carries the running total; older ones are
      // its history, so the MAXIMUM is the count, not the sum.
      attempts.set(
        failure.externalId,
        Math.max(
          attempts.get(failure.externalId) ?? 0,
          typeof failure.attempts === "number" ? failure.attempts : 1
        )
      );
    }
  }
  return attempts;
}

/** Transaction-less staging core: callers own the transaction boundary.
 *  Nothing here touches a domain table — staging is reviewable state (#290). */
export function stageBatchTx(
  vault: DatabaseSync,
  connectionId: string,
  candidates: StageCandidate[],
  publishers: ReadonlyMap<string, Publisher>,
  now: string,
  sealKey?: Buffer
): { batchId: string; counts: StageResult["staged"] } {
  const batchId = uuidv7();
  const counts = { create: 0, update: 0, skip: 0, "merge-candidate": 0 };
  // Batch row first — import rows FK onto it.
  vault
    .prepare(
      `INSERT INTO sync_import_batch (batch_id, connection_id, status, created_at, resolved_at, summary_json)
       VALUES (?, ?, 'draft', ?, NULL, '{}')`
    )
    .run(batchId, connectionId, now);
  const insertRow = vault.prepare(
    `INSERT INTO sync_import_row
       (row_id, batch_id, seq, entity_type, external_id, payload_json, disposition, target_entity_id, published_entity_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );
  const mapLookup = vault.prepare(
    `SELECT target_type AS entity_type, target_id AS entity_id, content_hash FROM sync_external_entity
      WHERE connection_id = ? AND external_id = ?`
  );
  // THE REVIEW QUEUE HOLDS ONE CREATABLE ENTRY PER EXTERNAL ID (#1014, B7).
  // The external-id map is written at PUBLISH, so on a review-gated connection
  // two pulls before the member answers staged the same id as `create` twice —
  // approving both created two rows, and the map's
  // `ON CONFLICT … DO UPDATE SET target_id` then orphaned the first. A draft
  // still awaiting review is as good as a map entry for this purpose.
  //
  // THE NEWEST DRAFT WINS, and every older one is retired to a `skip` saying
  // so. The other direction — keeping the old row and skipping the new one —
  // holds the same invariant but leaves a caller that has just staged a batch
  // holding a batch id that publishes nothing, and pull-then-publish is
  // exactly the shape callers have.
  const openCreateDrafts = vault.prepare(
    `SELECT r.row_id FROM sync_import_row r
       JOIN sync_import_batch b ON b.batch_id = r.batch_id
      WHERE b.connection_id = ? AND b.status = 'draft'
        AND r.external_id = ? AND r.published_entity_id IS NULL
        AND r.disposition = 'create'`
  );
  const retireDraft = vault.prepare(
    `UPDATE sync_import_row SET disposition = 'skip', note = ? WHERE row_id = ?`
  );
  const failedAttempts = publishFailureAttempts(vault, connectionId);
  let seq = 0;
  for (const candidate of candidates) {
    // Hash the PLAINTEXT: sealing is nonce-randomized, dedup is about content.
    const hash = payloadHash(candidate.payload);
    let disposition: "create" | "update" | "skip" | "merge-candidate" =
      "create";
    let target: string | null = null;
    let note: string | null = null;
    const mapped = mapLookup.get(connectionId, candidate.externalId) as
      | { entity_type: string; entity_id: string; content_hash: string }
      | undefined;
    if (mapped) {
      target = mapped.entity_id;
      disposition = mapped.content_hash === hash ? "skip" : "update";
      note =
        mapped.content_hash === hash
          ? "unchanged since last import"
          : "changed upstream";
      const localWrite = vault
        .prepare(
          `SELECT status FROM outbox_item
            WHERE connection_id = ? AND target_type = ? AND target_id = ?
              AND verb IN ('gcal.update_event','gcontacts.update_contact')
              AND status IN ('pending','approved','failed')
            ORDER BY staged_at DESC LIMIT 1`
        )
        .get(connectionId, mapped.entity_type, mapped.entity_id) as
        | { status: string }
        | undefined;
      if (mapped.content_hash !== hash && localWrite) {
        disposition = "merge-candidate";
        note =
          localWrite.status === "failed"
            ? "provider changed while a local write-back failed; local values remain canonical"
            : "provider changed while local write-back is pending; local values remain canonical";
      }
    } else {
      const probe = publishers
        .get(candidate.entityType)
        ?.probe(vault, candidate.payload);
      if (probe) {
        target = probe.entityId;
        disposition = probe.disposition;
        note = probe.note ?? "matches an existing row";
      }
    }
    const attempts = failedAttempts.get(candidate.externalId) ?? 0;
    if (attempts >= MAX_PUBLISH_ATTEMPTS) {
      // Publish has refused this row three times: staging a fourth `create`
      // buys the member another draft that cannot land (#1014, B8).
      disposition = "skip";
      note = `publishing failed ${attempts} times; not retried until the upstream row changes`;
    } else if (disposition === "create") {
      const superseded = openCreateDrafts.all(
        connectionId,
        candidate.externalId
      ) as { row_id: string }[];
      for (const draft of superseded)
        retireDraft.run(
          "superseded by a later pull of the same upstream row",
          draft.row_id
        );
    }
    counts[disposition] += 1;
    const rowId = uuidv7();
    // Secret payload fields seal BEFORE the row is written; staging without a
    // key refuses outright, never plaintext-by-accident (#293).
    const secretFields = sealedPayloadFieldsOf(candidate.entityType);
    let payload = candidate.payload;
    if (secretFields.length > 0) {
      if (!sealKey) {
        throw new Error(
          `${candidate.entityType} carries sealed fields — it stages only through the owner surface (issue #293)`
        );
      }
      payload = { ...payload };
      let sealedAny = false;
      for (const field of secretFields) {
        const v = payload[field];
        if (typeof v === "string" && v.length > 0 && !isSealedValue(v)) {
          payload[field] = sealValue(sealKey, payloadAad(rowId, field), v);
          sealedAny = true;
        }
      }
      // This vault now holds secrets — stamp the fingerprint in-transaction (#298).
      if (sealedAny) stampSealKeyFingerprint(vault, sealKey);
    }
    insertRow.run(
      rowId,
      batchId,
      seq,
      candidate.entityType,
      candidate.externalId,
      JSON.stringify(payload),
      disposition,
      target,
      note
    );
    seq += 1;
  }
  vault
    .prepare(`UPDATE sync_import_batch SET summary_json = ? WHERE batch_id = ?`)
    .run(JSON.stringify({ ...counts, total: candidates.length }), batchId);
  return { batchId, counts };
}

export function stageCandidates(
  db: VaultDb,
  importer: Identity,
  connectionId: string,
  candidates: StageCandidate[],
  publishers: ReadonlyMap<string, Publisher>
): StageResult {
  const now = nowIso();
  let staged: { batchId: string; counts: StageResult["staged"] };
  db.vault.exec("BEGIN");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(db.vault);
    staged = stageBatchTx(
      db.vault,
      connectionId,
      candidates,
      publishers,
      now,
      db.sealKey
    );
    endReplicaCommit(db.vault, replicaCommit);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
  const { batchId, counts } = staged;
  const receiptId = writeAuthorityReceipt(db, {
    authorityId: null,
    invocationId: null,
    action: "act sync.stage_import",
    objectType: "sync.import_batch",
    objectId: batchId,
    decision: "allow",
    detail: {
      connectionId,
      ...counts,
      total: candidates.length,
      by: importer.callerId,
    },
  });
  return {
    connectionId,
    batchId,
    staged: counts,
    total: candidates.length,
    receiptId,
  };
}

/** The caller decides the evidence shape. A row whose publisher throws is
 *  recorded failed and the REST of the batch still lands. */
export interface AppliedBatch {
  connectionId: string;
  kind: string;
  created: number;
  updated: number;
  skipped: number;
  failed: { externalId: string; error: string }[];
  /** Every vault row written — the caller stamps provenance for each. */
  provenanced: PublishedWrite[];
}

/** Drops only the sealed keys (#298); the rest stays for provenance. A
 *  published secret already reached its live home. */
export function shredPublishedSecretPayloads(
  vault: DatabaseSync,
  batchId: string
): number {
  const rows = vault
    .prepare(
      `SELECT row_id, entity_type, payload_json FROM sync_import_row
        WHERE batch_id = ? AND published_entity_id IS NOT NULL`
    )
    .all(batchId) as {
    row_id: string;
    entity_type: string;
    payload_json: string;
  }[];
  let shredded = 0;
  for (const row of rows) {
    const secretFields = sealedPayloadFieldsOf(row.entity_type);
    if (secretFields.length === 0) continue;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    let changed = false;
    for (const field of secretFields) {
      if (field in payload) {
        delete payload[field];
        changed = true;
      }
    }
    if (changed) {
      vault
        .prepare("UPDATE sync_import_row SET payload_json = ? WHERE row_id = ?")
        .run(JSON.stringify(payload), row.row_id);
      shredded += 1;
    }
  }
  return shredded;
}

export function applyBatchTx(
  vault: DatabaseSync,
  batchId: string,
  publishers: ReadonlyMap<string, Publisher>,
  ownerPartyId: string,
  now: string,
  sealKey?: Buffer
): AppliedBatch {
  const batch = vault
    .prepare(
      `SELECT b.status, b.connection_id, c.kind FROM sync_import_batch b
         JOIN sync_connection c ON c.connection_id = b.connection_id
        WHERE b.batch_id = ?`
    )
    .get(batchId) as
    | { status: string; connection_id: string; kind: string }
    | undefined;
  if (!batch) throw new Error(`no import batch ${batchId}`);
  if (batch.status !== "draft")
    throw new Error(`batch ${batchId} is ${batch.status}, not draft`);
  const rows = vault
    .prepare(
      `SELECT row_id, entity_type, external_id, payload_json, disposition, target_entity_id
         FROM sync_import_row WHERE batch_id = ? ORDER BY seq ASC`
    )
    .all(batchId) as {
    row_id: string;
    entity_type: string;
    external_id: string;
    payload_json: string;
    disposition: string;
    target_entity_id: string | null;
  }[];

  const provenanced: PublishedWrite[] = [];
  // Read BEFORE this batch's own receipt is written, so the count is the
  // history behind it (#1014, B8).
  const priorAttempts = publishFailureAttempts(vault, batch.connection_id);
  const failed: { externalId: string; error: string }[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const upsertMap = vault.prepare(
    `INSERT INTO sync_external_entity
       (map_id, connection_id, external_id, target_type, target_id, content_hash, first_seen_at, last_seen_at, gone_upstream)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       target_id = excluded.target_id, content_hash = excluded.content_hash,
       last_seen_at = excluded.last_seen_at, gone_upstream = 0`
  );
  const markRow = vault.prepare(
    `UPDATE sync_import_row SET published_entity_id = ?, note = ? WHERE row_id = ?`
  );

  // Publish runs OUTSIDE the command pipeline, so the spine seals in place (#293).
  const sealPublishedRow = (entityType: string, entityId: string): void => {
    if (!sealKey) return;
    const cols = sealedColumnsOf(entityType);
    if (cols.length === 0) return;
    const ref = resolveEntity(entityType, vault);
    if (!ref) return;
    const pk = pkColumn(vault, ref.physical);
    const live = vault
      .prepare(
        `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${ref.physical}" WHERE "${pk}" = ?`
      )
      .get(entityId) as Record<string, unknown> | undefined;
    if (!live) return;
    let sealedAny = false;
    for (const col of cols) {
      const v = live[col];
      if (typeof v !== "string" || v.length === 0 || isSealedValue(v)) continue;
      vault
        .prepare(`UPDATE "${ref.physical}" SET "${col}" = ? WHERE "${pk}" = ?`)
        .run(
          sealValue(sealKey, sealAad(ref.physical, col, entityId), v),
          entityId
        );
      sealedAny = true;
    }
    // Live sealed cells now exist (#298).
    if (sealedAny) stampSealKeyFingerprint(vault, sealKey);
  };

  for (const row of rows) {
    let payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const publisher = publishers.get(row.entity_type);
    try {
      // Unseal just-in-time; a key-less publish fails per-row, never silently.
      const secretFields = sealedPayloadFieldsOf(row.entity_type);
      if (secretFields.length > 0) {
        if (!sealKey) {
          throw new Error(
            `${row.entity_type} carries sealed fields — it publishes only through the owner surface (issue #293)`
          );
        }
        payload = { ...payload };
        for (const field of secretFields) {
          const v = payload[field];
          if (isSealedValue(v)) {
            payload[field] = unsealValue(
              sealKey,
              payloadAad(row.row_id, field),
              v
            );
          }
        }
      }
      const hash = payloadHash(payload);
      if (row.disposition === "create") {
        if (!publisher) throw new Error(`no publisher for ${row.entity_type}`);
        const out = publisher.create(vault, ownerPartyId, payload, now);
        sealPublishedRow(row.entity_type, out.entityId);
        created += 1;
        provenanced.push(
          { type: row.entity_type, id: out.entityId },
          ...out.wrote
        );
        upsertMap.run(
          uuidv7(),
          batch.connection_id,
          row.external_id,
          row.entity_type,
          out.entityId,
          hash,
          now,
          now
        );
        markRow.run(out.entityId, "created", row.row_id);
      } else if (row.disposition === "update" && row.target_entity_id) {
        if (!publisher) throw new Error(`no publisher for ${row.entity_type}`);
        const out = publisher.update(
          vault,
          row.target_entity_id,
          payload,
          now,
          ownerPartyId
        );
        sealPublishedRow(row.entity_type, row.target_entity_id);
        updated += 1;
        provenanced.push(
          { type: row.entity_type, id: row.target_entity_id },
          ...out.wrote
        );
        upsertMap.run(
          uuidv7(),
          batch.connection_id,
          row.external_id,
          row.entity_type,
          row.target_entity_id,
          hash,
          now,
          now
        );
        markRow.run(row.target_entity_id, "updated", row.row_id);
      } else {
        // A plain skip advances the source map; a merge candidate deliberately
        // does not, so the conflict stays visible on the next pull.
        skipped += 1;
        if (row.target_entity_id && row.disposition === "skip") {
          upsertMap.run(
            uuidv7(),
            batch.connection_id,
            row.external_id,
            row.entity_type,
            row.target_entity_id,
            hash,
            now,
            now
          );
        }
      }
    } catch (error) {
      failed.push({
        externalId: row.external_id,
        error: error instanceof Error ? error.message : String(error),
      });
      markRow.run(
        null,
        `failed: ${error instanceof Error ? error.message : String(error)}`,
        row.row_id
      );
    }
  }
  vault
    .prepare(
      `UPDATE sync_import_batch SET status = 'published', resolved_at = ?, summary_json = ? WHERE batch_id = ?`
    )
    .run(
      now,
      JSON.stringify({
        created,
        updated,
        skipped,
        failed: failed.length,
        total: rows.length,
        // The durable attempt counter (#1014, B8). It rides the receipt, the
        // one place a publish failure was already recorded, so a row that
        // cannot land stops being re-staged without a second table.
        ...(failed.length === 0
          ? {}
          : {
              failures: failed.map((entry) => ({
                externalId: entry.externalId,
                attempts: (priorAttempts.get(entry.externalId) ?? 0) + 1,
                error: entry.error,
              })),
            }),
      }),
      batchId
    );
  // A failed row's attachment resumes its TTL (#296).
  releaseBatchHold(vault, batchId);
  shredPublishedSecretPayloads(vault, batchId);
  vault
    .prepare(
      "UPDATE sync_connection SET last_run_at = ? WHERE connection_id = ?"
    )
    .run(now, batch.connection_id);
  return {
    connectionId: batch.connection_id,
    kind: batch.kind,
    created,
    updated,
    skipped,
    failed,
    provenanced,
  };
}

export function publishBatch(
  db: VaultDb,
  owner: Identity,
  batchId: string,
  publishers: ReadonlyMap<string, Publisher>,
  onProvenanceCommitted?: (entityTypes: readonly string[]) => void
): PublishResult {
  const now = nowIso();
  let applied: AppliedBatch;
  db.vault.exec("BEGIN");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(db.vault);
    applied = applyBatchTx(
      db.vault,
      batchId,
      publishers,
      owner.partyId ?? "",
      now,
      db.sealKey
    );
    endReplicaCommit(db.vault, replicaCommit);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
  const { created, updated, skipped, failed } = applied;
  // The provenance activity names the SOURCE format, not the transport.
  const activity = `import.${applied.kind.replace(/^file\./u, "")}`;
  for (const write of applied.provenanced) {
    writeProvenance(
      db.audit,
      owner,
      write.type,
      write.id,
      activity,
      undefined,
      "import"
    );
  }
  const receiptId = writeAuthorityReceipt(db, {
    authorityId: null,
    invocationId: null,
    action: "act sync.publish_import",
    objectType: "sync.import_batch",
    objectId: batchId,
    decision: "allow",
    detail: { created, updated, skipped, failed, by: owner.partyId },
  });
  try {
    onProvenanceCommitted?.([
      ...new Set(applied.provenanced.map((write) => write.type)),
    ]);
  } catch {
    // Hint only; the change-feed cursor and cron poll remain authoritative.
  }
  return { batchId, created, updated, skipped, failed, receiptId };
}

/** Discard a draft batch — rows dropped, one receipt, nothing published. */
export function discardBatch(
  db: VaultDb,
  owner: Identity,
  batchId: string
): { receiptId: string } {
  const batch = db.vault
    .prepare("SELECT status FROM sync_import_batch WHERE batch_id = ?")
    .get(batchId) as { status: string } | undefined;
  if (!batch) throw new Error(`no import batch ${batchId}`);
  if (batch.status !== "draft")
    throw new Error(`batch ${batchId} is ${batch.status}, not draft`);
  db.vault.exec("BEGIN");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(db.vault);
    db.vault
      .prepare("DELETE FROM sync_import_row WHERE batch_id = ?")
      .run(batchId);
    db.vault
      .prepare(
        `UPDATE sync_import_batch SET status = 'discarded', resolved_at = ? WHERE batch_id = ?`
      )
      .run(nowIso(), batchId);
    // Nothing claimed the staged bytes, so the TTL sweep reclaims them (#296).
    releaseBatchHold(db.vault, batchId);
    endReplicaCommit(db.vault, replicaCommit);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
  const receiptId = writeAuthorityReceipt(db, {
    authorityId: null,
    invocationId: null,
    action: "act sync.discard_import",
    objectType: "sync.import_batch",
    objectId: batchId,
    decision: "allow",
    detail: { by: owner.partyId },
  });
  return { receiptId };
}
