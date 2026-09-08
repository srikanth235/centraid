// Vault Atlas Browse writes (#441 B3): three commands through the §10
// pipeline (`runContractAndExecute`). Not raw SQL: a side-channel UPDATE
// bypasses `trg_replica_*` and corrupts replica sync. Pipeline also stamps
// operator provenance and runs seal / poly / dangling-link sweeps.
// Extra policy: unknown tables refused, sealed columns refuse writes,
// machinery read-only unless `unlockMachinery`, delete refuses engine-FK
// dependents (structured payload), poly pointers swept as a purge.

import type { DatabaseSync } from "node:sqlite";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { browseDependents } from "../schema/atlas-browse-refs.js";
import {
  primaryKeyColumns,
  resolveBrowseTable,
  tableInfo,
} from "../schema/atlas-browse.js";
import { packKindOf } from "../schema/atlas.js";
import { sealedColumnsOf } from "../schema/sealed.js";
import { entityDeclaration } from "../schema/tables.js";

export const ATLAS_OWNER_SCHEMA = "atlas";

type Bindable = string | number | null;

/** JSON scalars only; STRICT table CHECKs the rest. Booleans map to 0/1;
 *  anything richer is a clean 4xx, not a crash. */
function bindable(table: string, column: string, value: unknown): Bindable {
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(
    `${table}.${column}: values must be a string, number, boolean, or null`
  );
}

/**
 * Resolve the logical name (reject unknown), refuse writes to a column the
 * table does not have, refuse sealed-column writes, and refuse machinery bands
 * unless `unlockMachinery: true`.
 */
function guardWriteTarget(
  vault: DatabaseSync,
  table: string,
  touched: readonly string[],
  unlockMachinery: boolean
): { physical: string; schema: string; logical: string; pks: string[] } {
  const ref = resolveBrowseTable(vault, table);
  const logical = `${ref.schema}.${ref.table}`;
  if (packKindOf(ref.schema) === "machinery" && !unlockMachinery) {
    throw new Error(
      `${table} is a machinery band — read-only by default; resend with unlockMachinery:true to edit`
    );
  }
  // A COLUMN NAME IS AN IDENTIFIER, AND THE SEAL CHECK ONLY GUARDS REAL ONES.
  // The write statements interpolate these keys into quoted identifiers, so a
  // key carrying a double quote used to close the quote and smuggle a second
  // assignment in — `type" = "type", "password` set a sealed column while the
  // sealed set, asked about the whole crafted key, said no. Every touched
  // column is matched against the table's live column set FIRST: the crafted
  // key is not a column, so it never reaches the interpolation, and an
  // ordinary typo gets this refusal instead of a SQLite syntax error.
  const real = new Set(tableInfo(vault, ref.physical).map((c) => c.name));
  for (const col of touched) {
    if (!real.has(col)) {
      throw new Error(`${table}: unknown column ${JSON.stringify(col)}`);
    }
  }
  const sealed = new Set(sealedColumnsOf(logical, vault));
  for (const col of touched) {
    if (sealed.has(col)) {
      throw new Error(
        `${table}.${col} is a sealed column — reveal/reseal it through its own path, not Browse`
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

/**
 * Browse may not be the one UPDATE path an append-only table has (#916,
 * ruling ONT-08). The registry declares what a row's life may be; a table
 * whose rows are written once is corrected by writing another row, and a
 * generic editor that quietly ignored that declaration would make the
 * declaration untrue by being used. The refusal is registry-driven — nothing
 * here lists tables — and rides the pipeline, so it lands in the receipt with
 * its reason like any other denial.
 *
 * Insert and delete stay open: appending is what an append-only table is for,
 * and delete is the purge path the poly-ref sweep already backs.
 */
function refuseAppendOnly(table: string, logical: string): void {
  if (entityDeclaration(logical)?.lifecycle !== "append-only") return;
  throw new Error(
    `${table} is append-only — its rows are written once and corrected by writing another row, never edited in place (issue #916, ruling ONT-08)`
  );
}

/** Engine-FK-dependents refusal — the route turns it into a 409. */
export interface AtlasDependentsRefusal {
  /**
   * `owns_lifecycle` is the refusal Browse owes a row that is the HEAD of
   * something (#916, adversarial BUG-11): a document owns the content item it
   * points at, so deleting the row here would orphan bytes no sweep reclaims.
   * Its own command knows how to release them; Browse does not.
   */
  code: "has_dependents" | "owns_lifecycle";
  dependents: ReturnType<typeof browseDependents>["dependents"];
  totalRows: number;
}

/**
 * Rows whose delete releases something ELSE, and so belongs to the domain
 * command rather than to Browse. The forward foreign key points AT the owned
 * row, so the engine has nothing to refuse on its own.
 */
const OWNS_LIFECYCLE: Readonly<Record<string, { table: string }>> = {
  "core.document": { table: "core_content_item" },
  "media.asset": { table: "core_content_item" },
  "knowledge.note": { table: "core_content_item" },
};

export class AtlasDeleteBlockedError extends Error {
  constructor(readonly payload: AtlasDependentsRefusal) {
    super("row has dependents");
    this.name = "AtlasDeleteBlockedError";
  }
}

const SHARED = {
  ownerSchema: ATLAS_OWNER_SCHEMA,
  outputSchema: { type: "object" } as Record<string, unknown>,
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe" as const,
  risk: "medium" as const,
};

const UNLOCK_PROP = { type: "boolean" } as const;

function insertRow(): CommandDefinition {
  return {
    ...SHARED,
    name: "atlas.insert_row",
    inputSchema: {
      type: "object",
      required: ["table", "values"],
      properties: {
        table: { type: "string" },
        values: { type: "object" },
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
        input.unlockMachinery === true
      );
      // Auto-mint a single TEXT pk when absent — same courtesy as the ext
      // trio; composite pks must be supplied in full (STRICT enforces).
      if (target.pks.length === 1) {
        const pk = target.pks[0]!;
        if (
          values[pk] === undefined ||
          values[pk] === null ||
          values[pk] === ""
        ) {
          values[pk] = ctx.newId();
        }
      }
      const names = Object.keys(values);
      if (names.length === 0)
        throw new Error(`${input.table}: nothing to insert`);
      ctx.db
        .prepare(
          `INSERT INTO "${target.physical}" (${names.map((n) => `"${n}"`).join(", ")})
           VALUES (${names.map(() => "?").join(", ")})`
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
    name: "atlas.update_row",
    inputSchema: {
      type: "object",
      required: ["table", "id", "set"],
      properties: {
        table: { type: "string" },
        id: { type: "string" },
        set: { type: "object" },
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
      const target = guardWriteTarget(
        ctx.db,
        input.table,
        names,
        input.unlockMachinery === true
      );
      for (const col of names) {
        if (target.pks.includes(col))
          throw new Error(`${input.table}: the primary key is immutable`);
      }
      refuseAppendOnly(input.table, target.logical);
      const { where, bind } = pkWhere(input.table, target.pks, input.id);
      const result = ctx.db
        .prepare(
          `UPDATE "${target.physical}" SET ${names.map((n) => `"${n}" = ?`).join(", ")} WHERE ${where}`
        )
        .run(
          ...names.map((n) => bindable(input.table, n, input.set[n])),
          ...bind
        );
      if (Number(result.changes) === 0)
        throw new Error(`${input.table}: no row ${input.id}`);
      ctx.wrote(target.logical, input.id);
      return { id: input.id };
    },
  };
}

function deleteRow(): CommandDefinition {
  return {
    ...SHARED,
    name: "atlas.delete_row",
    risk: "high",
    inputSchema: {
      type: "object",
      required: ["table", "id"],
      properties: {
        table: { type: "string" },
        id: { type: "string" },
        unlockMachinery: UNLOCK_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx: HandlerCtx) => {
      const input = ctx.input as {
        table: string;
        id: string;
        unlockMachinery?: boolean;
      };
      const target = guardWriteTarget(
        ctx.db,
        input.table,
        [],
        input.unlockMachinery === true
      );
      // Engine-FK dependents BLOCK the delete — full payload so the
      // confirmation dialog is honest. SQLite FK would also reject, but a
      // structured refusal beats a raw constraint string.
      const deps = browseDependents(ctx.db, target.logical, input.id);
      if (deps.hasEngineDependents) {
        throw new AtlasDeleteBlockedError({
          code: "has_dependents",
          dependents: deps.dependents,
          totalRows: deps.totalRows,
        });
      }
      // A ROW THAT OWNS A LIFECYCLE IS NOT A ROW BROWSE MAY DELETE (#916,
      // adversarial BUG-11). Deleting a document here left the content item it
      // exclusively owned with no referrer, no trash pair, and bytes nothing
      // would ever reclaim — the forward foreign key points AT the content, so
      // the engine had nothing to say. Browse edits rows; the domain command
      // is what knows the row is the head of something.
      const owned = OWNS_LIFECYCLE[target.logical];
      if (owned) {
        throw new AtlasDeleteBlockedError({
          code: "owns_lifecycle",
          dependents: [
            {
              table: owned.table,
              via: `${target.physical} owns the row it points at`,
              count: 1,
              mechanism: "fk",
            },
          ],
          totalRows: 1,
        });
      }
      const { where, bind } = pkWhere(input.table, target.pks, input.id);
      const result = ctx.db
        .prepare(`DELETE FROM "${target.physical}" WHERE ${where}`)
        .run(...bind);
      if (Number(result.changes) === 0)
        throw new Error(`${input.table}: no row ${input.id}`);
      // Every polymorphic pointer at the just-deleted row is a composite
      // foreign key into `core_entity` since #916, so the engine sweeps what
      // #441 had to sweep by hand — and refuses the delete outright when a
      // dependent is RESTRICTed rather than leaving an orphan.
      ctx.wrote(target.logical, input.id);
      return { id: input.id, sweptDependents: deps.dependents };
    },
  };
}

/** `ctx.wrote` row id: the single pk, or a JSON array of composite pk values
 *  (matching the replica trigger's rowId shape). */
function rowIdOf(pks: string[], values: Record<string, unknown>): string {
  if (pks.length === 1) return String(values[pks[0]!]);
  if (pks.length === 0) return String(values["rowid"] ?? "");
  return JSON.stringify(pks.map((p) => values[p]));
}

function pkWhere(
  table: string,
  pks: string[],
  id: string
): { where: string; bind: Bindable[] } {
  if (pks.length <= 1) {
    return {
      where: pks.length === 1 ? `"${pks[0]}" = ?` : `rowid = ?`,
      bind: [id],
    };
  }
  let parts: unknown;
  try {
    parts = JSON.parse(id);
  } catch {
    throw new Error(
      `${table}: composite key needs a JSON array of ${pks.length} values`
    );
  }
  if (!Array.isArray(parts) || parts.length !== pks.length) {
    throw new Error(`${table}: composite key needs ${pks.length} values`);
  }
  return {
    where: pks.map((c) => `"${c}" = ?`).join(" AND "),
    bind: parts.map((p) => (typeof p === "number" ? p : String(p))),
  };
}

export function registerAtlasCommands(gateway: Gateway): void {
  gateway.registerCommand(insertRow());
  gateway.registerCommand(updateRow());
  gateway.registerCommand(deleteRow());
}
