// tier first. Crash safety: `<file>.next` sidecar BEFORE the sweep commits;

import { randomBytes } from "node:crypto";
import { renameSync, rmSync } from "node:fs";

import type { VaultDb } from "../db.js";
import { readBlobStoreSettings } from "../db.js";
import { payloadAad } from "../ingest/staging.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
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
} from "../schema/sealed.js";
import { resolveEntity } from "../schema/tables.js";
import { writeReceipt } from "./evidence.js";
import { pkColumn } from "./execution.js";

function sealedEntities(db: VaultDb): string[] {
  const entities = Object.keys(SEALED_COLUMNS);
  try {
    const rows = db.vault
      .prepare(
        `SELECT app_id, table_name, spec_json FROM access_app_ext WHERE band = 'live'`
      )
      .all() as { app_id: string; table_name: string; spec_json: string }[];
    for (const row of rows) {
      const sealed = (JSON.parse(row.spec_json) as { sealed?: unknown }).sealed;
      if (Array.isArray(sealed) && sealed.length > 0) {
        entities.push(`ext.${row.app_id}.${row.table_name}`);
      }
    }
  } catch {
    // Intentionally empty.
  }
  return entities;
}

export interface ResealResult {
  resealedCells: number;
  resealedStaged: number;
  oldFingerprint: string;
  newFingerprint: string;
  receiptId: string;
}

export function resealSealedCells(
  db: VaultDb,
  fromKey: Buffer,
  toKey: Buffer
): { cells: number; staged: number } {
  let cells = 0;
  let staged = 0;
  for (const entity of sealedEntities(db)) {
    const cols = sealedColumnsOf(entity, db.vault);
    if (cols.length === 0) continue;
    const ref = resolveEntity(entity, db.vault);
    if (!ref) continue;
    const pk = pkColumn(db.vault, ref.physical);
    const select = cols.map((c) => `"${c}"`).join(", ");
    const rows = db.vault
      .prepare(`SELECT "${pk}" AS __pk, ${select} FROM "${ref.physical}"`)
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row["__pk"]);
      for (const col of cols) {
        const value = row[col];
        if (!isSealedValue(value)) continue;
        const aad = sealAad(ref.physical, col, id);
        db.vault
          .prepare(
            `UPDATE "${ref.physical}" SET "${col}" = ? WHERE "${pk}" = ?`
          )
          .run(sealValue(toKey, aad, unsealValue(fromKey, aad, value)), id);
        cells += 1;
      }
    }
  }
  for (const entityType of Object.keys(SEALED_PAYLOAD_FIELDS)) {
    const fields = sealedPayloadFieldsOf(entityType);
    const rows = db.vault
      .prepare(
        `SELECT row_id, payload_json FROM sync_import_row WHERE entity_type = ?`
      )
      .all(entityType) as { row_id: string; payload_json: string }[];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      let changed = false;
      for (const field of fields) {
        const v = payload[field];
        if (!isSealedValue(v)) continue;
        const aad = payloadAad(row.row_id, field);
        payload[field] = sealValue(toKey, aad, unsealValue(fromKey, aad, v));
        changed = true;
        staged += 1;
      }
      if (changed) {
        db.vault
          .prepare(
            `UPDATE sync_import_row SET payload_json = ? WHERE row_id = ?`
          )
          .run(JSON.stringify(payload), row.row_id);
      }
    }
  }
  return { cells, staged };
}

export function resealVaultKey(
  db: VaultDb,
  now: string = new Date().toISOString()
): ResealResult {
  const blobSettings = readBlobStoreSettings(db.vault);
  if (blobSettings.kind === "s3") {
    throw new Error(
      "reseal refused: blob_store.encrypt is mandatory while remote CAS is configured — drain and detach the remote tier before rotating"
    );
  }
  const oldKey = db.sealKey;
  const newKey = randomBytes(32);
  const oldFingerprint = sealKeyFingerprint(oldKey);
  const newFingerprint = sealKeyFingerprint(newKey);
  const onDisk = db.dir !== ":memory:";
  const keyFile = onDisk ? sealKeyFileFor(db.dir) : null;

  if (keyFile) writeSealKeyFile(`${keyFile}.next`, newKey, db.keyStore);

  let resealedCells = 0;
  let resealedStaged = 0;
  db.vault.exec("BEGIN");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(db.vault);
    ({ cells: resealedCells, staged: resealedStaged } = resealSealedCells(
      db,
      oldKey,
      newKey
    ));
    stampSealKeyFingerprint(db.vault, newKey);
    endReplicaCommit(db.vault, replicaCommit);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    if (keyFile) rmSync(`${keyFile}.next`, { force: true });
    throw error;
  }
  if (keyFile) renameSync(`${keyFile}.next`, keyFile);
  db.sealKey.set(newKey);

  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "key.rotate",
    objectType: "core.vault",
    objectId: "seal-key",
    purpose: null,
    decision: "allow",
    detail: {
      oldFingerprint,
      newFingerprint,
      resealedCells,
      resealedStaged,
      at: now,
    },
  });
  return {
    resealedCells,
    resealedStaged,
    oldFingerprint,
    newFingerprint,
    receiptId,
  };
}
