import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { VAULT_ENTITIES } from "../schema/entity-catalog.js";
import { revisionPolicyOf } from "../schema/entity-declaration.js";
import { entitySupertypeMembers } from "../schema/entity.js";

const DEFAULT_UNDO_WINDOW_MS = 10_000;

function installed(vault: DatabaseSync): boolean {
  return (
    vault
      .prepare(
        "SELECT 1 AS x FROM temp.sqlite_master WHERE type = 'table' AND name = '_revision_capture'"
      )
      .get() !== undefined
  );
}

function primaryKeyOf(vault: DatabaseSync, physical: string): string | null {
  const cols = vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as { name: string; pk: number }[];
  const keys = cols.filter((column) => column.pk > 0);
  return keys.length === 1 ? (keys[0]?.name ?? null) : null;
}

function columnsOf(vault: DatabaseSync, physical: string): string[] {
  return (
    vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
      name: string;
    }[]
  ).map((column) => column.name);
}

export function ensureRevisionCapture(vault: DatabaseSync): void {
  if (installed(vault)) return;
  vault.exec(`
    CREATE TEMP TABLE IF NOT EXISTS _revision_capture (
      active INTEGER PRIMARY KEY CHECK (active = 1)
    );
    CREATE TEMP TABLE IF NOT EXISTS _revision_pending (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      operation     TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `);
  for (const [logical, physical] of entitySupertypeMembers()) {
    if (logical === "core.entity_revision") continue;
    const pk = primaryKeyOf(vault, physical);
    if (!pk) continue;
    const json = columnsOf(vault, physical)
      .map((column) => `'${column}', OLD."${column}"`)
      .join(", ");
    if (json.length === 0) continue;
    for (const [event, operation] of [
      ["UPDATE", "update"],
      ["DELETE", "delete"],
    ] as const) {
      vault.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS "${physical}_revision_${operation}"
        BEFORE ${event} ON "${physical}"
        WHEN EXISTS (SELECT 1 FROM temp._revision_capture)
        BEGIN
          INSERT INTO _revision_pending
            (entity_type, entity_id, operation, snapshot_json)
          VALUES ('${logical}', OLD."${pk}", '${operation}', json_object(${json}));
        END;
      `);
    }
  }
}

export function openRevisionCapture(vault: DatabaseSync): void {
  ensureRevisionCapture(vault);
  vault.exec("DELETE FROM temp._revision_pending");
  vault.exec(
    "INSERT OR IGNORE INTO temp._revision_capture (active) VALUES (1)"
  );
}

export function closeRevisionCapture(vault: DatabaseSync): void {
  if (!installed(vault)) return;
  vault.exec("DELETE FROM temp._revision_capture");
  vault.exec("DELETE FROM temp._revision_pending");
}

export function drainRevisionCapture(
  vault: DatabaseSync,
  input: {
    invocationId: string;
    actorPartyId: string | null;
    now: string;
    undoWindowMs?: number;
  }
): number {
  if (!installed(vault)) return 0;
  const pending = vault
    .prepare(
      `SELECT entity_type, entity_id, operation, snapshot_json
         FROM temp._revision_pending p
        WHERE NOT EXISTS (
          SELECT 1 FROM core_entity_revision r
           WHERE r.invocation_id = ?
             AND r.entity_type = p.entity_type AND r.entity_id = p.entity_id)
        GROUP BY entity_type, entity_id
       HAVING seq = MIN(seq)
        ORDER BY MIN(seq)`
    )
    .all(input.invocationId) as {
    entity_type: string;
    entity_id: string;
    operation: string;
    snapshot_json: string;
  }[];
  vault.exec("DELETE FROM temp._revision_pending");
  if (pending.length === 0) return 0;
  const undoUntil = new Date(
    Date.parse(input.now) + (input.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS)
  ).toISOString();
  const insert = vault.prepare(
    `INSERT INTO core_entity_revision
       (revision_id, entity_type, entity_id, operation, snapshot_json,
        recorded_at, undo_until, undone_at, actor_party_id, invocation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  );
  for (const row of pending) {
    insert.run(
      uuidv7(),
      row.entity_type,
      row.entity_id,
      row.operation,
      row.snapshot_json,
      input.now,
      undoUntil,
      input.actorPartyId,
      input.invocationId
    );
    enforceRevisionRetention(vault, row.entity_type, row.entity_id);
  }
  return pending.length;
}

export function enforceRevisionRetention(
  vault: DatabaseSync,
  entityType: string,
  entityId: string
): void {
  const dot = entityType.indexOf(".");
  const declaration =
    dot > 0
      ? VAULT_ENTITIES[entityType.slice(0, dot)]?.[entityType.slice(dot + 1)]
      : undefined;
  if (!declaration) return;
  const policy = revisionPolicyOf(declaration);
  if (policy.retain === "forever") return;
  vault
    .prepare(
      `DELETE FROM core_entity_revision
        WHERE entity_type = ? AND entity_id = ?
          AND revision_id NOT IN (
            SELECT revision_id FROM core_entity_revision
             WHERE entity_type = ? AND entity_id = ?
             ORDER BY recorded_at DESC, revision_id DESC
             LIMIT ?
          )`
    )
    .run(entityType, entityId, entityType, entityId, policy.retain);
}
