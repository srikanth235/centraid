/*
 * THE PRE-MUTATION SNAPSHOT, MADE UNFORGETTABLE (#916, review 5.1/5.2).
 *
 * `core_entity_revision` is the vault's "what did this say before" — undo, and
 * the answer to a member asking what changed. It was written by SEVEN of a
 * hundred and eighty-three commands, each remembering to call
 * `recordEntityRevision` by hand, and the snapshot carried no link to the
 * invocation that caused it, so a revision could not be joined to the receipt,
 * the check trail, or the replica change it belongs to.
 *
 * A duty every call site has to remember is a duty that is already broken. So
 * the CAPTURE moved into the engine: temporary `BEFORE UPDATE` / `BEFORE
 * DELETE` triggers, generated from the entity registry, copy the OLD row into
 * a staging table. They fire only while an invocation is open — the same gate
 * idiom the archive pass uses — so a sweep or a migration does not fill it.
 *
 * The engine captures; the PIPELINE decides. Draining keeps the FIRST snapshot
 * per (entity, id) — the row as the command found it, not as its last of
 * several statements left it — stamps the invocation and the actor onto it,
 * and enforces the entity's declared retention.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { VAULT_ENTITIES } from "../schema/entity-catalog.js";
import { revisionPolicyOf } from "../schema/entity-declaration.js";
import { entitySupertypeMembers } from "../schema/entity.js";

/** Undo window for a snapshot the pipeline took on the command's behalf. */
const DEFAULT_UNDO_WINDOW_MS = 10_000;

/**
 * Is the machinery on THIS connection? Asked of the connection rather than
 * remembered in a set: temp objects created inside a transaction go away with
 * its rollback, and a remembered "already installed" would then be a lie.
 */
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

/**
 * Create the staging tables and the capture triggers on this connection.
 * Idempotent, and lazy: a vault nobody invokes a command on pays nothing.
 */
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
    // A revision OF a revision is noise: the snapshot table is machinery.
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

/** Open the gate for one invocation, discarding anything left behind. */
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

/**
 * Move what the triggers captured into `core_entity_revision`, one row per
 * (entity, id), and hold each entity to its declared retention.
 *
 * Runs INSIDE the invocation's transaction: a rolled-back command leaves no
 * claim that it changed anything.
 */
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
  // A command that recorded its own COMPOSITE snapshot for this row wins: an
  // expense's undo needs its splits, and the row alone would restore the
  // header and lose the money.
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

/**
 * Keep the last N snapshots of a row, per the entity's declaration (#916, D2).
 * `'forever'` is the Locker's: a swept-away previous password is a credential
 * the member can no longer recover, which is not a cache miss.
 */
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
