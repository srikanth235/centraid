// The Vault Atlas — Browse write side (issue #441 Part B, B3; THE hard
// requirement). Row CRUD for the owner's generic table editor, registered as
// three commands — `atlas.insert_row` / `atlas.update_row` / `atlas.delete_row`
// — through the ordinary §10 command pipeline.
//
// Why commands, not raw SQL: the pipeline (`runContractAndExecute`) is the one
// journalled write path apps use, and routing Browse edits through it buys,
// wholesale, everything that makes a hand-edit safe on a replicated vault:
//   - the database-level `trg_replica_*` change triggers fire on the handler's
//     writes inside the same transaction, so a replica pulled after a Browse
//     edit sees it (this is the acceptance criterion "a replica pulled after an
//     edit sees the change"; a raw side-channel UPDATE would bypass the change
//     log and corrupt replica sync — deletions leak, PITR loses writes);
//   - `consent_provenance` is stamped for every `ctx.wrote`, and because the
//     owner-device credential carries `provAgentKind='owner'`, a Browse edit is
//     recorded as an OPERATOR act (agent_kind='owner', prov_activity
//     `command.atlas.insert_row|update_row|delete_row`) — distinguishable from
//     app/agent writes;
//   - the seal sweep, polymorphic-write validation, and dangling-link sweep all
//     run; STRICT NOT NULL / CHECK violations surface as a rolled-back failure.
//
// The handlers add the Browse-specific policy the pipeline does not know about:
// unknown tables are refused, sealed columns refuse writes, machinery bands are
// read-only unless explicitly unlocked, and a delete refuses when engine-FK
// dependents exist (returning the dependent payload so the confirmation dialog
// can show it), while polymorphic pointers are swept exactly as a purge would.

import type { DatabaseSync } from 'node:sqlite';
import { packKindOf } from '../schema/atlas.js';
import { browseDependents } from '../schema/atlas-browse-refs.js';
import { primaryKeyColumns, resolveBrowseTable } from '../schema/atlas-browse.js';
import { cleanupPolyRefs } from '../schema/poly-refs.js';
import { sealedColumnsOf } from '../schema/sealed.js';
import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

/** The owner schema all three Browse-edit commands sit under. */
export const ATLAS_OWNER_SCHEMA = 'atlas';

type Bindable = string | number | null;

/** A value a Browse edit may bind — JSON scalars only; the STRICT table CHECKs
 * the rest. Booleans map to 0/1; anything richer is a clean 4xx, not a crash. */
function bindable(table: string, column: string, value: unknown): Bindable {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`${table}.${column}: values must be a string, number, boolean, or null`);
}

/**
 * Guard a write target: resolve the logical name (reject unknown), refuse
 * sealed-column writes, and refuse machinery bands unless the request carries
 * an explicit `unlockMachinery: true`. Returns the physical name + pk columns.
 */
function guardWriteTarget(
  vault: DatabaseSync,
  table: string,
  touched: readonly string[],
  unlockMachinery: boolean,
): { physical: string; schema: string; logical: string; pks: string[] } {
  const ref = resolveBrowseTable(vault, table);
  const logical = `${ref.schema}.${ref.table}`;
  if (packKindOf(ref.schema) === 'machinery' && !unlockMachinery) {
    throw new Error(
      `${table} is a machinery band — read-only by default; resend with unlockMachinery:true to edit`,
    );
  }
  const sealed = new Set(sealedColumnsOf(logical, vault));
  for (const col of touched) {
    if (sealed.has(col)) {
      throw new Error(
        `${table}.${col} is a sealed column — reveal/reseal it through its own path, not Browse`,
      );
    }
  }
  return {
    physical: ref.physical,
    schema: ref.schema,
    logical,
    pks: primaryKeyColumns(vault, ref.physical),
  };
}

/** The engine-FK-dependents refusal shape — the route turns it into a 409. */
export interface AtlasDependentsRefusal {
  code: 'has_dependents';
  dependents: ReturnType<typeof browseDependents>['dependents'];
  totalRows: number;
}

export class AtlasDeleteBlockedError extends Error {
  constructor(readonly payload: AtlasDependentsRefusal) {
    super('row has dependents');
    this.name = 'AtlasDeleteBlockedError';
  }
}

const SHARED = {
  ownerSchema: ATLAS_OWNER_SCHEMA,
  outputSchema: { type: 'object' } as Record<string, unknown>,
  preconditions: [],
  postconditions: [],
  idempotency: 'retry-safe' as const,
  risk: 'medium' as const,
};

const UNLOCK_PROP = { type: 'boolean' } as const;

function insertRow(): CommandDefinition {
  return {
    ...SHARED,
    name: 'atlas.insert_row',
    inputSchema: {
      type: 'object',
      required: ['table', 'values'],
      properties: {
        table: { type: 'string' },
        values: { type: 'object' },
        unlockMachinery: UNLOCK_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx: HandlerCtx) => {
      const input = ctx.input as {
        table: string;
        values: Record<string, unknown>;
        unlockMachinery?: boolean;
      };
      const values: Record<string, unknown> = { ...input.values };
      const target = guardWriteTarget(
        ctx.db,
        input.table,
        Object.keys(values),
        input.unlockMachinery === true,
      );
      // Auto-mint a single TEXT pk when absent — the same courtesy the ext
      // trio extends; composite pks must be supplied in full (STRICT enforces).
      if (target.pks.length === 1) {
        const pk = target.pks[0]!;
        if (values[pk] === undefined || values[pk] === null || values[pk] === '') {
          values[pk] = ctx.newId();
        }
      }
      const names = Object.keys(values);
      if (names.length === 0) throw new Error(`${input.table}: nothing to insert`);
      ctx.db
        .prepare(
          `INSERT INTO "${target.physical}" (${names.map((n) => `"${n}"`).join(', ')})
           VALUES (${names.map(() => '?').join(', ')})`,
        )
        .run(...names.map((n) => bindable(input.table, n, values[n])));
      const id = rowIdOf(target.pks, values);
      ctx.wrote(target.logical, id);
      return { id };
    },
  };
}

function updateRow(): CommandDefinition {
  return {
    ...SHARED,
    name: 'atlas.update_row',
    inputSchema: {
      type: 'object',
      required: ['table', 'id', 'set'],
      properties: {
        table: { type: 'string' },
        id: { type: 'string' },
        set: { type: 'object' },
        unlockMachinery: UNLOCK_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx: HandlerCtx) => {
      const input = ctx.input as {
        table: string;
        id: string;
        set: Record<string, unknown>;
        unlockMachinery?: boolean;
      };
      const names = Object.keys(input.set);
      if (names.length === 0) throw new Error(`${input.table}: nothing to set`);
      const target = guardWriteTarget(ctx.db, input.table, names, input.unlockMachinery === true);
      for (const col of names) {
        if (target.pks.includes(col))
          throw new Error(`${input.table}: the primary key is immutable`);
      }
      const { where, bind } = pkWhere(input.table, target.pks, input.id);
      const result = ctx.db
        .prepare(
          `UPDATE "${target.physical}" SET ${names.map((n) => `"${n}" = ?`).join(', ')} WHERE ${where}`,
        )
        .run(...names.map((n) => bindable(input.table, n, input.set[n])), ...bind);
      if (Number(result.changes) === 0) throw new Error(`${input.table}: no row ${input.id}`);
      ctx.wrote(target.logical, input.id);
      return { id: input.id };
    },
  };
}

function deleteRow(): CommandDefinition {
  return {
    ...SHARED,
    name: 'atlas.delete_row',
    risk: 'high',
    inputSchema: {
      type: 'object',
      required: ['table', 'id'],
      properties: {
        table: { type: 'string' },
        id: { type: 'string' },
        unlockMachinery: UNLOCK_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx: HandlerCtx) => {
      const input = ctx.input as { table: string; id: string; unlockMachinery?: boolean };
      const target = guardWriteTarget(ctx.db, input.table, [], input.unlockMachinery === true);
      // Engine-FK dependents BLOCK the delete — with the full dependent payload
      // (engine + polymorphic) so the confirmation dialog is honest. SQLite's
      // own FK enforcement would also reject, but a structured refusal beats a
      // raw constraint string.
      const deps = browseDependents(ctx.db, target.logical, input.id);
      if (deps.hasEngineDependents) {
        throw new AtlasDeleteBlockedError({
          code: 'has_dependents',
          dependents: deps.dependents,
          totalRows: deps.totalRows,
        });
      }
      const { where, bind } = pkWhere(input.table, target.pks, input.id);
      const result = ctx.db.prepare(`DELETE FROM "${target.physical}" WHERE ${where}`).run(...bind);
      if (Number(result.changes) === 0) throw new Error(`${input.table}: no row ${input.id}`);
      // Sweep the polymorphic pointers at the just-deleted row exactly as a
      // purge would (issue #441 A1) — tags/curation/annotations/attachments
      // delete, shares revoke, links end-date — so a Browse delete never
      // leaves the orphans A1 exists to prevent. (The pipeline's own sweep
      // covers core_link; cleanupPolyRefs is idempotent over it.)
      cleanupPolyRefs(ctx.db, ctx.now, target.logical, input.id);
      ctx.wrote(target.logical, input.id);
      return { id: input.id, sweptDependents: deps.dependents };
    },
  };
}

/** The row id a `ctx.wrote` provenance record uses: the single pk, or a JSON
 * array of composite pk values (matching the replica trigger's rowId shape). */
function rowIdOf(pks: string[], values: Record<string, unknown>): string {
  if (pks.length === 1) return String(values[pks[0]!]);
  if (pks.length === 0) return String(values['rowid'] ?? '');
  return JSON.stringify(pks.map((p) => values[p]));
}

/** Build the pk WHERE clause + bound params from a Browse id (single or JSON). */
function pkWhere(table: string, pks: string[], id: string): { where: string; bind: Bindable[] } {
  if (pks.length <= 1) {
    return { where: pks.length === 1 ? `"${pks[0]}" = ?` : `rowid = ?`, bind: [id] };
  }
  let parts: unknown;
  try {
    parts = JSON.parse(id);
  } catch {
    throw new Error(`${table}: composite key needs a JSON array of ${pks.length} values`);
  }
  if (!Array.isArray(parts) || parts.length !== pks.length) {
    throw new Error(`${table}: composite key needs ${pks.length} values`);
  }
  return {
    where: pks.map((c) => `"${c}" = ?`).join(' AND '),
    bind: parts.map((p) => (typeof p === 'number' ? p : String(p))),
  };
}

/** Register the three Browse-edit commands (issue #441 B3). */
export function registerAtlasCommands(gateway: Gateway): void {
  gateway.registerCommand(insertRow());
  gateway.registerCommand(updateRow());
  gateway.registerCommand(deleteRow());
}
