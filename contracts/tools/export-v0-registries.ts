// Export the v0 TypeScript schema registries as one language-neutral fixture
// (#1020, wave 1 lane A).
//
// The registries in `packages/vault/src/schema` are the SOURCE until wave 6
// retires the v0 tree, and v1 must not re-type them by hand: a second copy of
// "which tables never leave the gateway" is how the two answers drift. So this
// script reads the TypeScript declarations and writes them out as JSON, and
// `crates/ontology` embeds the result with `include_str!`. When a v0 registry
// changes, regenerate and commit the fixture in the same slice — nothing here
// interprets, it only transcribes.
//
// Regenerate with:
//
//   bun contracts/tools/export-v0-registries.ts > contracts/schema/v0-registries.json
//   bun run format
//
// The second step is not optional: the repository formatter owns JSON too, so
// the committed fixture is this script's output AFTER oxfmt. `git diff
// --exit-code contracts/schema` is therefore the check that the fixture is
// current, rather than a diff against raw stdout.
//
// It is `bun <path>` rather than a `bun run` script because this is v1 tooling
// living under `contracts/`, not part of v0's package scripts.

import { SNAPSHOT_EXCLUSIONS } from "../../packages/vault/src/golden-snapshot.ts";
import {
  MACHINERY_BANDS,
  ONTOLOGY_PACKS,
} from "../../packages/vault/src/schema/atlas.ts";
import {
  AUDIT_APPEND_ONLY_TABLES,
  AUDIT_BAND_TABLES,
  RETENTION_WINDOWS,
} from "../../packages/vault/src/schema/audit.ts";
import { CONTENT_REFERENCES } from "../../packages/vault/src/schema/content-references.ts";
import { DELETION_ROLES } from "../../packages/vault/src/schema/deletion-roles.ts";
import { VAULT_ENTITIES } from "../../packages/vault/src/schema/entity-catalog.ts";
import { LOCAL_TABLES } from "../../packages/vault/src/schema/local-tables.ts";
import {
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
} from "../../packages/vault/src/schema/migrate.ts";
import { PRIVATE_TABLES } from "../../packages/vault/src/schema/private-tables.ts";
import { SEALED_COLUMNS } from "../../packages/vault/src/schema/sealed.ts";

/** One registered entity, with the physical table the resolver derives. */
interface ExportedEntity {
  logical: string;
  table: string;
  label: string;
  lifecycle: string;
  projectionOf: string | null;
  deletionRoles: { column: string; parent: string; role: string }[];
}

function entities(): ExportedEntity[] {
  const rolesByTable = new Map<
    string,
    { column: string; parent: string; role: string }[]
  >();
  for (const role of DELETION_ROLES) {
    const bucket = rolesByTable.get(role.table) ?? [];
    bucket.push({
      column: role.column,
      parent: role.parent,
      role: role.role,
    });
    rolesByTable.set(role.table, bucket);
  }
  const out: ExportedEntity[] = [];
  for (const [schema, kinds] of Object.entries(VAULT_ENTITIES)) {
    for (const [name, declaration] of Object.entries(kinds)) {
      // SQLite has no namespaces: the physical name is the logical one
      // underscore-joined, exactly as `resolveEntity` derives it.
      const table = `${schema}_${name}`;
      out.push({
        logical: `${schema}.${name}`,
        table,
        label: declaration.label,
        lifecycle: declaration.lifecycle,
        projectionOf: declaration.projectionOf ?? null,
        deletionRoles: (rolesByTable.get(table) ?? []).sort((a, b) =>
          a.column.localeCompare(b.column)
        ),
      });
    }
  }
  return out.sort((a, b) => a.logical.localeCompare(b.logical));
}

function sortedRecord<T>(entries: [string, T][]): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => a.localeCompare(b))
  );
}

const exported = {
  $generatedBy: "bun contracts/tools/export-v0-registries.ts",
  $note:
    "Transcribed from packages/vault/src/schema — the v0 tree is the source " +
    "of these registries until wave 6 (#1020). `userVersion` is the file " +
    "shape a FRESH v0 vault reaches (VAULT_MIGRATIONS.length); the #929 " +
    "golden corpus was frozen one rung earlier and carries its own number in " +
    "contracts/golden/issue-929/manifest.json.",
  ontologyVersion: ONTOLOGY_VERSION,
  userVersion: VAULT_MIGRATIONS.length,
  // Life data versus plumbing, explicit so a new schema fails loud rather
  // than mis-shelving. The membership trigger into `core_entity` reads only
  // the ontology packs; a machinery-band row is not an entity in its own right.
  ontologyPacks: [...ONTOLOGY_PACKS].sort(),
  machineryBands: [...MACHINERY_BANDS].sort(),
  auditBand: {
    tables: [...AUDIT_BAND_TABLES].sort(),
    appendOnlyTables: [...AUDIT_APPEND_ONLY_TABLES].sort(),
  },
  privateTables: [...PRIVATE_TABLES]
    .map((entry) => ({
      table: entry.table,
      kind: entry.kind,
      reason: entry.reason,
    }))
    .sort((a, b) => a.table.localeCompare(b.table)),
  localTables: [...LOCAL_TABLES.entries()]
    .map(([table, reason]) => ({ table, reason }))
    .sort((a, b) => a.table.localeCompare(b.table)),
  sealedColumns: sortedRecord(
    Object.entries(SEALED_COLUMNS).map(([entity, columns]) => [
      entity,
      [...columns].sort(),
    ])
  ),
  entities: entities(),
  contentReferences: [...CONTENT_REFERENCES]
    .map((reference) => ({
      table: reference.table,
      column: reference.column,
      onlyLive: reference.onlyLive ?? null,
      documentHead: reference.documentHead === true,
    }))
    .sort((a, b) =>
      `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`)
    ),
  retentionWindows: sortedRecord(
    Object.entries(RETENTION_WINDOWS).map(([band, window]) => [
      band,
      { days: window.days, duty: window.duty },
    ])
  ),
  snapshotExclusions: [...SNAPSHOT_EXCLUSIONS.entries()]
    .map(([table, reason]) => ({ table, reason }))
    .sort((a, b) => a.table.localeCompare(b.table)),
};

process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
