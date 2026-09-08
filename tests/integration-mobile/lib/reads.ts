/*
 * READING THIS PHONE'S COPY, IN THE TIER'S OWN TERMS (#996, W5).
 *
 * `session.read(app, { entity })` is gone with the declarative plane: a read is
 * a STATEMENT over the vault's own table now, and the entity's physical name is
 * what addresses it. The suites here only ever asked for "every row of this
 * entity, with my own pending writes drawn on", so that is what this is — one
 * page, generously bounded, keyed by the entity's own id column.
 *
 * THE OVERLAY IS NOT OPTIONAL. A list read that drops it shows the member
 * everything except their own unsettled write, which is the exact thing several
 * of these suites are here to catch (R23–R25).
 */

import { vaultPhysicalTable } from "../../../packages/client/src/replica/vault-tables.js";
import type { MobileSeat } from "./seat.js";

/** One page big enough that no suite here is measuring a window. */
const EVERY_ROW = 500;

export interface EntityRows {
  rows: Array<Record<string, unknown>>;
}

/** The entity's own key column — `schedule.task` → `task_id`. */
export function entityIdColumn(entity: string): string {
  return `${entity.split(".")[1] ?? ""}_id`;
}

export async function readEntity(
  seat: MobileSeat,
  entity: string
): Promise<EntityRows> {
  const table = vaultPhysicalTable(entity);
  const idColumn = entityIdColumn(entity);
  const page = await seat.seat.page<Record<string, unknown>>(
    {
      name: `integration.${entity}`,
      select: "*",
      from: `"${table}"`,
      order: { sortColumn: idColumn, pkColumn: idColumn, descending: false },
    },
    { limit: EVERY_ROW },
    { entity, rowIdColumn: idColumn }
  );
  return { rows: page.rows };
}
