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

function bindable(table: string, column: string, value: unknown): Bindable {
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(
    `${table}.${column}: values must be a string, number, boolean, or null`
  );
}

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

function refuseAppendOnly(table: string, logical: string): void {
  if (entityDeclaration(logical)?.lifecycle !== "append-only") return;
  throw new Error(
    `${table} is append-only — its rows are written once and corrected by writing another row, never edited in place (issue #916, ruling ONT-08)`
  );
}

export interface AtlasDependentsRefusal {
  code: "has_dependents" | "owns_lifecycle";
  dependents: ReturnType<typeof browseDependents>["dependents"];
  totalRows: number;
}

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
      const deps = browseDependents(ctx.db, target.logical, input.id);
      if (deps.hasEngineDependents) {
        throw new AtlasDeleteBlockedError({
          code: "has_dependents",
          dependents: deps.dependents,
          totalRows: deps.totalRows,
        });
      }
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
      ctx.wrote(target.logical, input.id);
      return { id: input.id, sweptDependents: deps.dependents };
    },
  };
}

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
