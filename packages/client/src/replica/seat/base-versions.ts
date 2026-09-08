// THE VERSIONS A QUEUED WRITE IS AGAINST (#996, R24; #922 G5).
//
// An intent carries the `row_version` of every row it edits, and the gateway
// refuses it if the row has moved since — which is how a member is shown a
// CONFLICT rather than having their edit silently overwrite someone else's.
// The old plane captured those from the shaped store's `readWire`; a seat holds
// the vault's own tables, so it reads them from the row.
//
// CAPTURED FROM CANONICAL ROWS ONLY, deliberately, and this is the same rule
// the coordinator stated: the overlay is bypassed, because a queued edit must
// not become its own base version and a retry must observe the row that
// rejected it. `SeatWorkerQuery` without an `overlay` is exactly that read.
//
// THE PRIMARY KEY COMES FROM THE FILE. There is no entity→table→key registry
// on the seat and there must not be one — the file IS the gateway's schema, so
// `pragma_table_info` is the authoritative answer and a schema change reaches
// this without an edit here. `SeatTableKeys` makes the same argument for the
// applier; this is its main-thread twin, over the one op the worker exposes.
//
// A ROW THAT IS NOT THERE HAS NO VERSION, AND THAT IS NOT AN ERROR. A create
// names a row id nothing holds yet; an edit of a row this seat has not caught
// up to is the same shape. Both mean "no precondition to state", which is what
// the gateway reads an absent base version as.

import type { OptimisticMutation, ReplicaBaseVersion } from "../types.js";
import { vaultPhysicalTable } from "../vault-tables.js";
import type { SeatQueryPort } from "./seat-page-reader.js";

interface VersionRow {
  row_id: string;
  row_version: number | null;
}

/**
 * One entity's primary-key column, cached for the life of the seat.
 *
 * Cached rather than re-asked because a base-version capture happens on every
 * write and a `pragma_table_info` round trip per write per entity is a cost
 * with nothing behind it — the file's schema does not move under an open seat,
 * and a re-bootstrap opens a new one.
 */
export class SeatRowKeys {
  readonly #cache = new Map<string, string | undefined>();

  constructor(private readonly port: SeatQueryPort) {}

  async of(entity: string): Promise<string | undefined> {
    if (this.#cache.has(entity)) return this.#cache.get(entity);
    const table = vaultPhysicalTable(entity);
    let key: string | undefined = undefined;
    try {
      const rows = await this.port.query<{ name: string }>({
        // `pk = 1` is the FIRST key column. A row a projection addresses by one
        // id has a one-column key; a composite-key table cannot be addressed
        // that way at all, so it answers nothing rather than half a key.
        sql: `SELECT name FROM pragma_table_info(?) WHERE pk = 1`,
        bind: [table],
      });
      const composite = await this.port.query<{ n: number }>({
        sql: `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE pk > 0`,
        bind: [table],
      });
      if ((composite[0]?.n ?? 0) === 1) key = rows[0]?.name;
    } catch {
      // A table this seat's file does not have is a table with no version to
      // capture — an app whose rows have not arrived yet, or an entity the
      // grant does not carry.
      key = undefined;
    }
    this.#cache.set(entity, key);
    return key;
  }
}

/**
 * The base versions for a write's optimistic mutations, in one read per entity.
 *
 * Deduplicated by `(entity, rowId)` first: a write that touches one row twice
 * — a rename that also stamps `updated_at`, say — states one precondition, not
 * two, and two would be two chances to disagree.
 */
export async function seatBaseVersions(
  port: SeatQueryPort,
  keys: SeatRowKeys,
  mutations: readonly OptimisticMutation[]
): Promise<ReplicaBaseVersion[]> {
  const byEntity = new Map<string, Map<string, OptimisticMutation>>();
  for (const mutation of mutations) {
    const rows = byEntity.get(mutation.entity) ?? new Map();
    rows.set(mutation.rowId, mutation);
    byEntity.set(mutation.entity, rows);
  }
  const captured: ReplicaBaseVersion[] = [];
  await Promise.all(
    [...byEntity].map(async ([entity, rows]) => {
      const key = await keys.of(entity);
      if (!key) return;
      const ids = [...rows.keys()];
      const found = await port
        .query<VersionRow>({
          sql: `SELECT "${key}" AS row_id, row_version
                  FROM "${vaultPhysicalTable(entity)}"
                 WHERE "${key}" IN (${ids.map(() => "?").join(", ")})`,
          bind: ids,
        })
        .catch(() => [] as VersionRow[]);
      for (const row of found) {
        if (row.row_version === null) continue;
        const mutation = rows.get(row.row_id);
        if (!mutation) continue;
        captured.push({
          // A shape id a caller still states is carried through; a seat's own
          // mutations carry none (#996, W5).
          ...(mutation.shapeId ? { shapeId: mutation.shapeId } : {}),
          entity,
          rowId: row.row_id,
          version: row.row_version,
        });
      }
    })
  );
  return captured;
}
