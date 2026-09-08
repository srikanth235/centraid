// Logical ↔ physical name resolution over the entity catalog.
// The declarations themselves live in `entity-catalog.ts`.

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

/**
 * The member-facing name (and, for ontology kinds, the blurb) of a registered
 * entity. `undefined` for anything the registry does not carry — including an
 * ext-band table, which is an app's own and never named by this file.
 */
export function entityDeclaration(
  logical: string
): VaultEntityDeclaration | undefined {
  const dot = logical.indexOf(".");
  if (dot <= 0) return undefined;
  const schema = logical.slice(0, dot);
  const table = logical.slice(dot + 1);
  return declaredIn(VAULT_ENTITIES, schema, table);
}

/**
 * OWN keys only. The registry is an allow-list before it is a name table, and
 * a plain object inherits `constructor` and `toString` from its prototype — so
 * a `[schema]?.[table]` probe would answer truthy for `core.constructor` and
 * hand a caller a physical table name the registry never declared.
 */
function declaredIn(
  registry: EntityRegistry,
  schema: string,
  table: string
): VaultEntityDeclaration | undefined {
  if (!Object.hasOwn(registry, schema)) return undefined;
  const entities = registry[schema]!;
  return Object.hasOwn(entities, table) ? entities[table] : undefined;
}

/**
 * THE LABEL GATE (#883, ruling O-label). An entity with no label declaration
 * fails here rather than reaching a surface that has to invent one — which is
 * how the same table came to be named in four maps by hand. Takes the registry
 * so the gate can be demonstrated red against a scratch one.
 *
 * Names are unique within a pack: two rows called "Tasks" in one section of the
 * Atlas is not a display bug to fix downstream, it is two entities the member
 * cannot tell apart.
 */
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

/**
 * The gate, once per process. Called by the schema build (`migrateVault`), so
 * an unlabelled entity fails when the vault is opened rather than when a
 * surface tries to draw it.
 */
export function assertVaultRegistryLabels(): void {
  if (labelsChecked) return;
  assertRegistryLabels(VAULT_ENTITIES, "vault");
  labelsChecked = true;
}

/**
 * The audit band's readable streams, by logical name. Names only: the band's
 * shape is `schema/audit.ts`'s, and nothing here may enumerate it.
 */
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
  /** Physical SQLite table name, e.g. `core_party`. */
  physical: string;
}

/**
 * Resolve a logical `schema.table` name. Returns undefined for anything not
 * in the registry — callers treat that as a denial, never as SQL.
 *
 * Ext-band names (`ext.<appId>.<table>`, draft twin `extdraft.…`) resolve
 * only when the caller passes its vault handle — the dynamic half lives in
 * `access_app_ext`. Both bands report the consent schema `ext.<appId>`:
 * the draft copy is the same data class under the same grant.
 */
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
  // The AUDIT band RESOLVES but is not ENUMERATED (#916). It is excluded from
  // the registry so the export walk and the replica change log leave it alone
  // — it is this vault's evidence, not the member's data to copy — but a grant
  // may still name `access.provenance`, and the activity read is exactly that
  // read. Excluding it from the walk and refusing to resolve it are two
  // different decisions; only the first is the band's.
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
      // Pre-v5 file or a non-vault handle: no dynamic half to consult.
    }
  }
  return undefined;
}

/**
 * All logical vault-file entity names, `schema.table`. With a handle, the
 * live ext band is enumerated too (retained tables included — export covers
 * everything); the draft band is scratch and never enumerated.
 */
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
