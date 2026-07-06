// The staging spine (issue #290 phase 2) — every path into the vault flows
// through it: source → candidates → staging band → review → publish/discard.
// Staging is what turns import from a scary irreversible act into the same
// draft→publish gesture the builder taught: candidates land as sync_import_row
// rows with a computed disposition, the owner reviews the diff, and publish
// applies them in one transaction with per-entity provenance and one batch
// receipt.
//
// Dispositions come from two layers of identity:
//   1. the universal external-id map (sync_external_entity) — a mapped id
//      whose content hash is unchanged skips; a changed one stages an update
//      (the vault-wins policy: upstream changes are REVIEWED, never applied
//      silently);
//   2. a per-entity-type probe against domain-native keys (ical_uid,
//      resolveHandle, external_id columns) — how a pre-map vault adopts rows
//      it already holds instead of duplicating them.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { releaseBatchHold } from '../blob/staging.js';
import { nowIso, uuidv7 } from '../ids.js';
import { pkColumn } from '../gateway/execution.js';
import { writeProvenance, writeReceipt } from './../gateway/evidence.js';
import { resolveEntity } from '../schema/tables.js';
import {
  isSealedValue,
  sealAad,
  sealValue,
  sealedColumnsOf,
  sealedPayloadFieldsOf,
  stampSealKeyFingerprint,
  unsealValue,
} from '../schema/sealed.js';
import type { Identity } from '../gateway/types.js';

/** AAD of one sealed payload field in the draft band. */
export function payloadAad(rowId: string, field: string): string {
  return sealAad('sync_import_row', `payload.${field}`, rowId);
}

/** One parsed unit from a source, before dispositioning. */
export interface StageCandidate {
  /** Logical entity the payload publishes into, e.g. `core.event`. */
  entityType: string;
  /** Source-native identity — `(connection, external_id)` is the sync key. */
  externalId: string;
  /** Parsed, source-shaped payload the publisher understands. */
  payload: Record<string, unknown>;
}

/** A row another vault row was written for during publish. */
export interface PublishedWrite {
  type: string;
  id: string;
}

/**
 * Per-entity-type applier. `probe` adopts rows the vault already holds via
 * domain-native keys; `create`/`update` are the only writers and report
 * every row they touched so the spine stamps provenance for each.
 */
export interface Publisher {
  entityType: string;
  probe(
    vault: DatabaseSync,
    payload: Record<string, unknown>,
  ): { entityId: string; disposition: 'update' | 'skip'; note?: string } | null;
  create(
    vault: DatabaseSync,
    ownerPartyId: string,
    payload: Record<string, unknown>,
    now: string,
  ): { entityId: string; wrote: PublishedWrite[] };
  update(
    vault: DatabaseSync,
    entityId: string,
    payload: Record<string, unknown>,
    now: string,
    ownerPartyId: string,
  ): { wrote: PublishedWrite[] };
}

export interface StageResult {
  connectionId: string;
  batchId: string;
  staged: { create: number; update: number; skip: number; 'merge-candidate': number };
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

/** Canonical content hash of a candidate payload (sorted keys, stable). */
export function payloadHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Find-or-create a connection. File drops key on (kind, label). */
export function ensureConnectionTx(
  vault: DatabaseSync,
  options: { kind: string; label: string; principal?: string },
): string {
  const existing = vault
    .prepare('SELECT connection_id FROM sync_connection WHERE kind = ? AND label = ?')
    .get(options.kind, options.label) as { connection_id: string } | undefined;
  if (existing) return existing.connection_id;
  const connectionId = uuidv7();
  vault
    .prepare(
      `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at, last_run_at)
       VALUES (?, ?, ?, ?, 'active', 'staged', ?, NULL)`,
    )
    .run(connectionId, options.kind, options.label, options.principal ?? null, nowIso());
  return connectionId;
}

/** `ensureConnectionTx` over the vault pair — the owner-path convenience. */
export function ensureConnection(
  db: VaultDb,
  options: { kind: string; label: string; principal?: string },
): string {
  return ensureConnectionTx(db.vault, options);
}

/**
 * Disposition candidates against the map + probes and write one draft batch.
 * Nothing touches a domain table here — staging is reviewable state, one
 * receipt for the act.
 */
/**
 * Transaction-less staging core — batch + dispositioned rows. Callers own
 * the transaction boundary: `stageCandidates` wraps it in its own ACID
 * block; the `sync.stage_rows` command handler runs it inside the command
 * pipeline's transaction (issue #290 phase 3).
 */
export function stageBatchTx(
  vault: DatabaseSync,
  connectionId: string,
  candidates: StageCandidate[],
  publishers: ReadonlyMap<string, Publisher>,
  now: string,
  sealKey?: Buffer,
): { batchId: string; counts: StageResult['staged'] } {
  const batchId = uuidv7();
  const counts = { create: 0, update: 0, skip: 0, 'merge-candidate': 0 };
  // Batch row first — import rows FK onto it.
  vault
    .prepare(
      `INSERT INTO sync_import_batch (batch_id, connection_id, status, created_at, resolved_at, summary_json)
       VALUES (?, ?, 'draft', ?, NULL, '{}')`,
    )
    .run(batchId, connectionId, now);
  const insertRow = vault.prepare(
    `INSERT INTO sync_import_row
       (row_id, batch_id, seq, entity_type, external_id, payload_json, disposition, target_entity_id, published_entity_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const mapLookup = vault.prepare(
    `SELECT entity_type, entity_id, content_hash FROM sync_external_entity
      WHERE connection_id = ? AND external_id = ?`,
  );
  let seq = 0;
  for (const candidate of candidates) {
    // Hash the PLAINTEXT payload — sealing is nonce-randomized, and the
    // dedup contract ("unchanged since last import") is about content.
    const hash = payloadHash(candidate.payload);
    let disposition: 'create' | 'update' | 'skip' | 'merge-candidate' = 'create';
    let target: string | null = null;
    let note: string | null = null;
    const mapped = mapLookup.get(connectionId, candidate.externalId) as
      | { entity_type: string; entity_id: string; content_hash: string }
      | undefined;
    if (mapped) {
      target = mapped.entity_id;
      disposition = mapped.content_hash === hash ? 'skip' : 'update';
      note = mapped.content_hash === hash ? 'unchanged since last import' : 'changed upstream';
    } else {
      const probe = publishers.get(candidate.entityType)?.probe(vault, candidate.payload);
      if (probe) {
        target = probe.entityId;
        disposition = probe.disposition;
        note = probe.note ?? 'matches an existing row';
      }
    }
    counts[disposition] += 1;
    const rowId = uuidv7();
    // The draft band deserves the same protection as the live band (issue
    // #293): secret payload fields seal before the row is written. Staging
    // secrets without a key refuses outright — never plaintext-by-accident.
    const secretFields = sealedPayloadFieldsOf(candidate.entityType);
    let payload = candidate.payload;
    if (secretFields.length > 0) {
      if (!sealKey) {
        throw new Error(
          `${candidate.entityType} carries sealed fields — it stages only through the owner surface (issue #293)`,
        );
      }
      payload = { ...payload };
      let sealedAny = false;
      for (const field of secretFields) {
        const v = payload[field];
        if (typeof v === 'string' && v.length > 0 && !isSealedValue(v)) {
          payload[field] = sealValue(sealKey, payloadAad(rowId, field), v);
          sealedAny = true;
        }
      }
      // First sealed draft row = this vault now holds secrets — stamp the
      // key fingerprint in the same transaction (issue #298 item 1).
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
      note,
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
  publishers: ReadonlyMap<string, Publisher>,
): StageResult {
  const now = nowIso();
  let staged: { batchId: string; counts: StageResult['staged'] };
  db.vault.exec('BEGIN');
  try {
    staged = stageBatchTx(db.vault, connectionId, candidates, publishers, now, db.sealKey);
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  const { batchId, counts } = staged;
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act sync.stage_import',
    objectType: 'sync.import_batch',
    objectId: batchId,
    purpose: null,
    decision: 'allow',
    detail: { connectionId, ...counts, total: candidates.length, by: importer.callerId },
  });
  return { connectionId, batchId, staged: counts, total: candidates.length, receiptId };
}

/**
 * Publish a draft batch: creates and updates apply in one transaction,
 * per-entity provenance stamps `import.<connection kind>`, the external-id
 * map records every published (and adopted) row, one receipt for the batch.
 * A row whose publisher throws is recorded failed and the REST of the batch
 * still lands — partial progress is honest progress for imports.
 */
/** What `applyBatchTx` reports — the caller decides the evidence shape. */
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

/**
 * Transaction-less publish core: walk a draft batch's rows, apply creates
 * and updates, upsert the external-id map (adopted rows included, so the
 * NEXT import diffs instead of re-probing), mark the batch published.
 * Callers own the transaction AND the evidence: `publishBatch` stamps
 * `import.<kind>` provenance + a batch receipt; the `sync.publish_batch`
 * command hands the rows to the command pipeline instead.
 */
/**
 * Drop the sealed payload fields from a published batch's rows (issue #298
 * item 3). Only rows whose entity type declares sealed payload fields are
 * touched, and only the sealed keys are removed — the rest of the payload
 * stays for provenance. A published row's secret has already reached its
 * live home; keeping the staged copy is pure retention risk.
 */
export function shredPublishedSecretPayloads(vault: DatabaseSync, batchId: string): number {
  const rows = vault
    .prepare(
      `SELECT row_id, entity_type, payload_json FROM sync_import_row
        WHERE batch_id = ? AND published_entity_id IS NOT NULL`,
    )
    .all(batchId) as { row_id: string; entity_type: string; payload_json: string }[];
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
        .prepare('UPDATE sync_import_row SET payload_json = ? WHERE row_id = ?')
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
  sealKey?: Buffer,
): AppliedBatch {
  const batch = vault
    .prepare(
      `SELECT b.status, b.connection_id, c.kind FROM sync_import_batch b
         JOIN sync_connection c ON c.connection_id = b.connection_id
        WHERE b.batch_id = ?`,
    )
    .get(batchId) as { status: string; connection_id: string; kind: string } | undefined;
  if (!batch) throw new Error(`no import batch ${batchId}`);
  if (batch.status !== 'draft') throw new Error(`batch ${batchId} is ${batch.status}, not draft`);
  const rows = vault
    .prepare(
      `SELECT row_id, entity_type, external_id, payload_json, disposition, target_entity_id
         FROM sync_import_row WHERE batch_id = ? ORDER BY seq ASC`,
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
       (map_id, connection_id, external_id, entity_type, entity_id, content_hash, first_seen_at, last_seen_at, gone_upstream)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       entity_id = excluded.entity_id, content_hash = excluded.content_hash,
       last_seen_at = excluded.last_seen_at, gone_upstream = 0`,
  );
  const markRow = vault.prepare(
    `UPDATE sync_import_row SET published_entity_id = ?, note = ? WHERE row_id = ?`,
  );

  // Seal a published row's sealed columns in place — the publish path runs
  // outside the command pipeline, so the spine carries its own mini-sweep
  // (issue #293): the row-band ciphertext re-binds to the live row's AAD.
  const sealPublishedRow = (entityType: string, entityId: string): void => {
    if (!sealKey) return;
    const cols = sealedColumnsOf(entityType);
    if (cols.length === 0) return;
    const ref = resolveEntity(entityType, vault);
    if (!ref || ref.file !== 'vault') return;
    const pk = pkColumn(vault, ref.physical);
    const live = vault
      .prepare(
        `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${ref.physical}" WHERE "${pk}" = ?`,
      )
      .get(entityId) as Record<string, unknown> | undefined;
    if (!live) return;
    let sealedAny = false;
    for (const col of cols) {
      const v = live[col];
      if (typeof v !== 'string' || v.length === 0 || isSealedValue(v)) continue;
      vault
        .prepare(`UPDATE "${ref.physical}" SET "${col}" = ? WHERE "${pk}" = ?`)
        .run(sealValue(sealKey, sealAad(ref.physical, col, entityId), v), entityId);
      sealedAny = true;
    }
    // Live sealed cells now exist — stamp the key fingerprint (issue #298).
    if (sealedAny) stampSealKeyFingerprint(vault, sealKey);
  };

  for (const row of rows) {
    let payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const publisher = publishers.get(row.entity_type);
    try {
      // Secret payload fields unseal just-in-time for the publisher; a
      // key-less publish of sealed rows fails per-row, never silently.
      const secretFields = sealedPayloadFieldsOf(row.entity_type);
      if (secretFields.length > 0) {
        if (!sealKey) {
          throw new Error(
            `${row.entity_type} carries sealed fields — it publishes only through the owner surface (issue #293)`,
          );
        }
        payload = { ...payload };
        for (const field of secretFields) {
          const v = payload[field];
          if (isSealedValue(v)) {
            payload[field] = unsealValue(sealKey, payloadAad(row.row_id, field), v);
          }
        }
      }
      const hash = payloadHash(payload);
      if (row.disposition === 'create') {
        if (!publisher) throw new Error(`no publisher for ${row.entity_type}`);
        const out = publisher.create(vault, ownerPartyId, payload, now);
        sealPublishedRow(row.entity_type, out.entityId);
        created += 1;
        provenanced.push({ type: row.entity_type, id: out.entityId }, ...out.wrote);
        upsertMap.run(
          uuidv7(),
          batch.connection_id,
          row.external_id,
          row.entity_type,
          out.entityId,
          hash,
          now,
          now,
        );
        markRow.run(out.entityId, 'created', row.row_id);
      } else if (row.disposition === 'update' && row.target_entity_id) {
        if (!publisher) throw new Error(`no publisher for ${row.entity_type}`);
        const out = publisher.update(vault, row.target_entity_id, payload, now, ownerPartyId);
        sealPublishedRow(row.entity_type, row.target_entity_id);
        updated += 1;
        provenanced.push({ type: row.entity_type, id: row.target_entity_id }, ...out.wrote);
        upsertMap.run(
          uuidv7(),
          batch.connection_id,
          row.external_id,
          row.entity_type,
          row.target_entity_id,
          hash,
          now,
          now,
        );
        markRow.run(row.target_entity_id, 'updated', row.row_id);
      } else {
        // skip and merge-candidate rows publish nothing, but an adopted
        // row (probe hit) joins the map so the NEXT import syncs it.
        skipped += 1;
        if (row.target_entity_id) {
          upsertMap.run(
            uuidv7(),
            batch.connection_id,
            row.external_id,
            row.entity_type,
            row.target_entity_id,
            hash,
            now,
            now,
          );
        }
      }
    } catch (err) {
      failed.push({
        externalId: row.external_id,
        error: err instanceof Error ? err.message : String(err),
      });
      markRow.run(null, `failed: ${err instanceof Error ? err.message : String(err)}`, row.row_id);
    }
  }
  vault
    .prepare(
      `UPDATE sync_import_batch SET status = 'published', resolved_at = ?, summary_json = ? WHERE batch_id = ?`,
    )
    .run(
      now,
      JSON.stringify({ created, updated, skipped, failed: failed.length, total: rows.length }),
      batchId,
    );
  // Publish releases the batch's blob holds (issue #296): claimed shas are
  // model now; anything left (a failed row's attachment) resumes its TTL.
  releaseBatchHold(vault, batchId);
  // Shred-after-publish for secret imports (issue #298 item 3): a
  // password-CSV drop seals its rows at stage, but the sealed payload then
  // sat in sync_import_row indefinitely — a second copy of every secret,
  // outliving its purpose the moment the live row exists. Once a row with
  // sealed payload fields has published, drop its payload; the row stays for
  // provenance (external_id, published_entity_id) carrying no secret.
  shredPublishedSecretPayloads(vault, batchId);
  vault
    .prepare('UPDATE sync_connection SET last_run_at = ? WHERE connection_id = ?')
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
): PublishResult {
  const now = nowIso();
  let applied: AppliedBatch;
  db.vault.exec('BEGIN');
  try {
    applied = applyBatchTx(db.vault, batchId, publishers, owner.partyId ?? '', now, db.sealKey);
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  const { created, updated, skipped, failed } = applied;
  // `file.ics` → `import.ics`: the provenance activity names the SOURCE
  // format, not the transport — continuous with the pre-spine importers.
  const activity = `import.${applied.kind.replace(/^file\./, '')}`;
  for (const write of applied.provenanced) {
    writeProvenance(db.journal, owner, write.type, write.id, activity, undefined, 'import');
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act sync.publish_import',
    objectType: 'sync.import_batch',
    objectId: batchId,
    purpose: null,
    decision: 'allow',
    detail: { created, updated, skipped, failed, by: owner.partyId },
  });
  return { batchId, created, updated, skipped, failed, receiptId };
}

/** Discard a draft batch — rows dropped, one receipt, nothing published. */
export function discardBatch(db: VaultDb, owner: Identity, batchId: string): { receiptId: string } {
  const batch = db.vault
    .prepare('SELECT status FROM sync_import_batch WHERE batch_id = ?')
    .get(batchId) as { status: string } | undefined;
  if (!batch) throw new Error(`no import batch ${batchId}`);
  if (batch.status !== 'draft') throw new Error(`batch ${batchId} is ${batch.status}, not draft`);
  db.vault.exec('BEGIN');
  try {
    db.vault.prepare('DELETE FROM sync_import_row WHERE batch_id = ?').run(batchId);
    db.vault
      .prepare(
        `UPDATE sync_import_batch SET status = 'discarded', resolved_at = ? WHERE batch_id = ?`,
      )
      .run(nowIso(), batchId);
    // Discard releases the batch's blob holds (issue #296): nothing claimed
    // the staged bytes, so the TTL sweep reclaims them.
    releaseBatchHold(db.vault, batchId);
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act sync.discard_import',
    objectType: 'sync.import_batch',
    objectId: batchId,
    purpose: null,
    decision: 'allow',
    detail: { by: owner.partyId },
  });
  return { receiptId };
}
