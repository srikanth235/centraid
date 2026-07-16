// The reseal maintenance verb (issue #298 item 8): decrypt-with-old,
// encrypt-with-new, one transaction, receipted. `sealed:v1:` gave the
// version seam; this is the machinery that walks it — a DEK compromise or
// an algorithm bump finally has a migration path instead of a shrug.
//
// Scope honesty: rotation covers every sealed CELL — live sealed columns
// (SEALED_COLUMNS) and staged draft payloads (SEALED_PAYLOAD_FIELDS). It
// REFUSES while a remote CAS is attached: its per-blob keys are wrapped by
// the current vault key, and rotating that registry belongs in the same
// atomic gesture. Drain/detach the remote tier first.
//
// Crash safety: the new key lands in a `<file>.next` sidecar BEFORE the
// sweep commits, and the commit itself flips the stamped fingerprint. An
// interruption between commit and the final rename is healed at next open —
// `resolveSealKey` promotes a matching sidecar automatically.

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import type { VaultDb } from '../db.js';
import { readBlobStoreSettings } from '../db.js';
import { payloadAad } from '../ingest/staging.js';
import {
  SEALED_COLUMNS,
  SEALED_PAYLOAD_FIELDS,
  isSealedValue,
  sealAad,
  sealKeyFileFor,
  sealKeyFingerprint,
  sealValue,
  sealedColumnsOf,
  sealedPayloadFieldsOf,
  stampSealKeyFingerprint,
  unsealValue,
  writeSealKeyFile,
} from '../schema/sealed.js';
import { resolveEntity } from '../schema/tables.js';
import { writeReceipt } from './evidence.js';
import { pkColumn } from './execution.js';

/**
 * Every logical entity that may hold sealed cells: the canonical static
 * registry plus each live ext table that declared a `sealed` column. Draft
 * ext bands are the builder's scratch copy — reseal covers durable data.
 */
function sealedEntities(db: VaultDb): string[] {
  const entities = Object.keys(SEALED_COLUMNS);
  try {
    const rows = db.vault
      .prepare(`SELECT app_id, table_name, spec_json FROM consent_app_ext WHERE band = 'live'`)
      .all() as { app_id: string; table_name: string; spec_json: string }[];
    for (const row of rows) {
      const sealed = (JSON.parse(row.spec_json) as { sealed?: unknown }).sealed;
      if (Array.isArray(sealed) && sealed.length > 0) {
        entities.push(`ext.${row.app_id}.${row.table_name}`);
      }
    }
  } catch {
    // no ext band (older vault) — canonical entities are the whole set
  }
  return entities;
}

export interface ResealResult {
  /** Sealed cells re-encrypted, live band. */
  resealedCells: number;
  /** Sealed staged payload fields re-encrypted, draft band. */
  resealedStaged: number;
  oldFingerprint: string;
  newFingerprint: string;
  receiptId: string;
}

/**
 * Rotate the vault's DEK: every sealed cell decrypts with the current key
 * and re-encrypts with a fresh one, atomically. Owner/admin gesture only —
 * this is not a registered command, so no app or agent can ever reach it.
 */
export function resealVaultKey(db: VaultDb, now: string = new Date().toISOString()): ResealResult {
  const blobSettings = readBlobStoreSettings(db.vault);
  if (blobSettings.kind === 's3') {
    throw new Error(
      'reseal refused: blob_store.encrypt is mandatory while remote CAS is configured — drain and detach the remote tier before rotating',
    );
  }
  const oldKey = db.sealKey;
  const newKey = randomBytes(32);
  const oldFingerprint = sealKeyFingerprint(oldKey);
  const newFingerprint = sealKeyFingerprint(newKey);
  const onDisk = db.dir !== ':memory:';
  const keyFile = onDisk ? sealKeyFileFor(db.dir) : null;

  // Sidecar first: if we crash mid-sweep, the old key is still the stamped
  // one and the stale sidecar is ignored; after commit, the sidecar IS the
  // stamped key and `resolveSealKey` promotes it.
  if (keyFile) writeSealKeyFile(`${keyFile}.next`, newKey);

  let resealedCells = 0;
  let resealedStaged = 0;
  db.vault.exec('BEGIN');
  try {
    // Live band: every sealed column of every entity — canonical (static
    // registry) AND ext-band (declared in consent_app_ext, issue #298 item 9).
    for (const entity of sealedEntities(db)) {
      const cols = sealedColumnsOf(entity, db.vault);
      if (cols.length === 0) continue;
      const ref = resolveEntity(entity, db.vault);
      if (!ref || ref.file !== 'vault') continue;
      const pk = pkColumn(db.vault, ref.physical);
      const select = cols.map((c) => `"${c}"`).join(', ');
      const rows = db.vault
        .prepare(`SELECT "${pk}" AS __pk, ${select} FROM "${ref.physical}"`)
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        const id = String(row['__pk']);
        for (const col of cols) {
          const value = row[col];
          if (!isSealedValue(value)) continue;
          const aad = sealAad(ref.physical, col, id);
          db.vault
            .prepare(`UPDATE "${ref.physical}" SET "${col}" = ? WHERE "${pk}" = ?`)
            .run(sealValue(newKey, aad, unsealValue(oldKey, aad, value)), id);
          resealedCells += 1;
        }
      }
    }
    // Draft band: sealed payload fields of staged import rows.
    for (const entityType of Object.keys(SEALED_PAYLOAD_FIELDS)) {
      const fields = sealedPayloadFieldsOf(entityType);
      const rows = db.vault
        .prepare(`SELECT row_id, payload_json FROM sync_import_row WHERE entity_type = ?`)
        .all(entityType) as { row_id: string; payload_json: string }[];
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        let changed = false;
        for (const field of fields) {
          const v = payload[field];
          if (!isSealedValue(v)) continue;
          const aad = payloadAad(row.row_id, field);
          payload[field] = sealValue(newKey, aad, unsealValue(oldKey, aad, v));
          changed = true;
          resealedStaged += 1;
        }
        if (changed) {
          db.vault
            .prepare(`UPDATE sync_import_row SET payload_json = ? WHERE row_id = ?`)
            .run(JSON.stringify(payload), row.row_id);
        }
      }
    }
    // The stamped fingerprint flips with the data, in the same transaction.
    stampSealKeyFingerprint(db.vault, newKey);
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    if (keyFile) rmSync(`${keyFile}.next`, { force: true });
    throw err;
  }
  // Publish the new key: promote the sidecar and swap the live buffer in
  // place, so every holder of db.sealKey (gateway, staging) sees it.
  if (keyFile) renameSync(`${keyFile}.next`, keyFile);
  db.sealKey.set(newKey);

  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'key.rotate',
    objectType: 'core.vault',
    objectId: 'seal-key',
    purpose: null,
    decision: 'allow',
    detail: { oldFingerprint, newFingerprint, resealedCells, resealedStaged, at: now },
  });
  return { resealedCells, resealedStaged, oldFingerprint, newFingerprint, receiptId };
}
