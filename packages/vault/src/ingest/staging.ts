// governance: allow-repo-hygiene file-size-limit the staging spine is one pipeline — source→candidates→band→review→publish share the disposition + provenance invariants (#290)

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
import { writeProvenance, writeReceipt } from "./../gateway/evidence.js";

export function payloadAad(rowId: string, field: string): string {
  return sealAad("sync_import_row", `payload.${field}`, rowId);
}

export interface StageCandidate {
  entityType: string;
  externalId: string;
  payload: Record<string, unknown>;
}

export interface PublishedWrite {
  type: string;
  id: string;
}

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

export function payloadHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]])
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

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
  let seq = 0;
  for (const candidate of candidates) {
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
    counts[disposition] += 1;
    const rowId = uuidv7();
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
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act sync.stage_import",
    objectType: "sync.import_batch",
    objectId: batchId,
    purpose: null,
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

export interface AppliedBatch {
  connectionId: string;
  kind: string;
  created: number;
  updated: number;
  skipped: number;
  failed: { externalId: string; error: string }[];
  provenanced: PublishedWrite[];
}

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
    if (sealedAny) stampSealKeyFingerprint(vault, sealKey);
  };

  for (const row of rows) {
    let payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const publisher = publishers.get(row.entity_type);
    try {
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
      }),
      batchId
    );
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
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act sync.publish_import",
    objectType: "sync.import_batch",
    objectId: batchId,
    purpose: null,
    decision: "allow",
    detail: { created, updated, skipped, failed, by: owner.partyId },
  });
  try {
    onProvenanceCommitted?.([
      ...new Set(applied.provenanced.map((write) => write.type)),
    ]);
  } catch {
    // Intentionally empty.
  }
  return { batchId, created, updated, skipped, failed, receiptId };
}

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
    releaseBatchHold(db.vault, batchId);
    endReplicaCommit(db.vault, replicaCommit);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act sync.discard_import",
    objectType: "sync.import_batch",
    objectId: batchId,
    purpose: null,
    decision: "allow",
    detail: { by: owner.partyId },
  });
  return { receiptId };
}
