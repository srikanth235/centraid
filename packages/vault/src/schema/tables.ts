import type { DatabaseSync } from "node:sqlite";

import { VAULT_ENTITIES, VAULT_TABLES } from "./entity-catalog.js";
import type {
  EntityRegistry,
  VaultEntityDeclaration,
} from "./entity-catalog.js";
import { parseExtLogical } from "./ext.js";

export {
  VAULT_ENTITIES,
  VAULT_TABLES,
  type EntityLifecycle,
  type VaultEntityDeclaration,
} from "./entity-catalog.js";
export { LOCAL_TABLES } from "./local-tables.js";

export function entityDeclaration(
  logical: string
): VaultEntityDeclaration | undefined {
  const dot = logical.indexOf(".");
  if (dot <= 0) return undefined;
  const schema = logical.slice(0, dot);
  const table = logical.slice(dot + 1);
  return declaredIn(VAULT_ENTITIES, schema, table);
}

function declaredIn(
  registry: EntityRegistry,
  schema: string,
  table: string
): VaultEntityDeclaration | undefined {
  if (!Object.hasOwn(registry, schema)) return undefined;
  const entities = registry[schema]!;
  return Object.hasOwn(entities, table) ? entities[table] : undefined;
}

export function assertRegistryLabels(
  registry: EntityRegistry,
  file = "vault"
): void {
  for (const [schema, entities] of Object.entries(registry)) {
    const seen = new Map<string, string>();
    for (const [table, declaration] of Object.entries(entities)) {
      const label = declaration.label;
      if (typeof label !== "string" || label.trim().length === 0) {
        throw new Error(
          `${file} registry: ${schema}.${table} has no label — every entity declares the one name every surface shows (issue #883, ruling O-label)`
        );
      }
      const clash = seen.get(label);
      if (clash !== undefined) {
        throw new Error(
          `${file} registry: ${schema}.${table} and ${schema}.${clash} are both called "${label}" — one name per entity (issue #883, ruling O-label)`
        );
      }
      seen.set(label, table);
      const blurb = declaration.blurb;
      if (blurb !== undefined && blurb.trim().length === 0) {
        throw new Error(
          `${file} registry: ${schema}.${table} declares an empty blurb — leave it out rather than fabricating one`
        );
      }
    }
  }
}

let labelsChecked = false;

export function assertVaultRegistryLabels(): void {
  if (labelsChecked) return;
  assertRegistryLabels(VAULT_ENTITIES, "vault");
  labelsChecked = true;
}

const AUDIT_BAND_ENTITIES: ReadonlySet<string> = new Set([
  "access.provenance",
  "access.receipt",
  "agent.command_invocation",
  "agent.invocation_check",
  "agent.evidence",
  "agent.explanation",
]);

export interface EntityRef {
  schema: string;
  table: string;
  physical: string;
}

export function resolveEntity(
  logical: string,
  vault?: DatabaseSync
): EntityRef | undefined {
  const dot = logical.indexOf(".");
  if (dot <= 0) return undefined;
  const schema = logical.slice(0, dot);
  const table = logical.slice(dot + 1);
  if (declaredIn(VAULT_ENTITIES, schema, table)) {
    return { schema, table, physical: `${schema}_${table}` };
  }
  if (AUDIT_BAND_ENTITIES.has(logical)) {
    return { schema, table, physical: `${schema}_${table}` };
  }
  const ext = parseExtLogical(logical);
  if (ext && vault) {
    try {
      const row = vault
        .prepare(
          `SELECT physical FROM access_app_ext WHERE app_id = ? AND band = ? AND table_name = ?`
        )
        .get(ext.appId, ext.band, ext.table) as
        | { physical: string }
        | undefined;
      if (row) {
        return {
          schema: `ext.${ext.appId}`,
          table: ext.table,
          physical: row.physical,
        };
      }
    } catch {
      // Intentionally empty.
    }
  }
  return undefined;
}

export function listVaultEntities(vault?: DatabaseSync): string[] {
  const canonical = Object.entries(VAULT_TABLES).flatMap(([schema, tables]) =>
    tables.map((t) => `${schema}.${t}`)
  );
  if (!vault) return canonical;
  try {
    const rows = vault
      .prepare(
        `SELECT app_id, table_name FROM access_app_ext WHERE band = 'live' ORDER BY app_id, table_name`
      )
      .all() as { app_id: string; table_name: string }[];
    return [
      ...canonical,
      ...rows.map((r) => `ext.${r.app_id}.${r.table_name}`),
    ];
  } catch {
    return canonical;
  }
}
