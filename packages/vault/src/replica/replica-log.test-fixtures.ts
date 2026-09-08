// ONE SPELLING for what every gateway-log suite has to do before it can assert
// anything: make a captured commit, put a row in a replicated table, plant the
// owner and a device, and compare two copies of a table by value.
//
// `log.test.ts`, `log-retention.test.ts` and `change-log.test.ts` each wrote
// their own; a commit helper that rolls back differently from its neighbour is
// how two suites end up asserting about two different mechanisms.
import type { VaultDb } from "../db.js";
import { beginReplicaCommit, endReplicaCommit } from "./change-log.js";
import type { ReplicaCaptureResult } from "./log.js";

export type Sqlite = VaultDb["vault"];

/** Run `write` inside one captured commit, the way every canonical path does. */
export function capturedCommit(
  db: VaultDb,
  producer: string,
  write: (vault: Sqlite) => void
): ReplicaCaptureResult | undefined {
  db.vault.exec("BEGIN");
  const handle = beginReplicaCommit(db.vault, { producer });
  try {
    write(db.vault);
    const captured = endReplicaCommit(db.vault, handle);
    db.vault.exec("COMMIT");
    return captured;
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

/** A row in a replicated table, with nothing interesting about it. */
export function insertScheme(vault: Sqlite, id: string, title = id): void {
  vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES (?, ?, ?, '1')`
    )
    .run(id, `urn:${id}`, title);
}

/** The owner and one enrolled device — the parents a private row hangs from. */
export function insertOwnerAndDevice(vault: Sqlite, deviceName: string): void {
  vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('p1', 'person', 'Owner', '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z')`
    )
    .run();
  vault
    .prepare(
      `INSERT INTO access_device (device_id, owner_party_id, name, enrolled_at)
       VALUES ('d1', 'p1', ?, '2026-01-01T00:00:00.000Z')`
    )
    .run(deviceName);
}

/** Value-level digest of one table, order-independent — the comparator. */
export function tableDigest(vault: Sqlite, table: string): string {
  const columns = (
    vault.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  ).map((column) => column.name);
  const quoted = columns.map((name) => `quote("${name}")`).join(" || '|' || ");
  const rows = vault
    .prepare(`SELECT ${quoted} AS row FROM "${table}"`)
    .all() as { row: string }[];
  return rows
    .map((row) => row.row)
    .sort()
    .join("\n");
}
