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

import { readFileSync } from "node:fs";

import { SEAT_LOG_MAX_PAGE } from "../../packages/core/src/protocol/seat-log.ts";
import { SNAPSHOT_EXCLUSIONS } from "../../packages/vault/src/golden-snapshot.ts";
import { REPLICA_IDEMPOTENCY_WINDOW_DAYS } from "../../packages/vault/src/replica/intents.ts";
import {
  REPLICA_DEFER_THRESHOLD_BYTES,
  REPLICA_LOCAL_TABLES,
  REPLICA_LOG_RETENTION_DAYS,
  REPLICA_LOG_RETENTION_MAX_ROWS,
  REPLICA_PRODUCER_MAX_ROWS,
  REPLICA_SEAT_HOLD_DAYS,
} from "../../packages/vault/src/replica/log.ts";
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
import {
  PRIVATE_TABLES,
  REPLICATED_COLUMN_EXCLUSIONS,
  isReplicatedTable,
} from "../../packages/vault/src/schema/private-tables.ts";
import {
  REPLICA_DDL_VERSION,
  REPLICA_SCHEMA_EPOCH,
  SEAT_SQLITE_FLOOR,
} from "../../packages/vault/src/schema/replica.ts";
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

/**
 * The corpus's own `PRAGMA user_version`, read from the manifest beside it.
 *
 * It is in THIS fixture as well as in the manifest because `crates/ontology`
 * embeds this file and nothing else: `Vault::open` has to know the accepted
 * version window without reading a repository path at runtime (#1020,
 * D-1020-A1).
 */
function goldenUserVersion(): number {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../golden/issue-929/manifest.json", import.meta.url),
      "utf8"
    )
  ) as { userVersion: number };
  return manifest.userVersion;
}

/**
 * The replicated-table ALLOW-LIST, transcribed from the source text.
 *
 * `REPLICATED_TABLE_NAMES` is deliberately NOT exported by
 * `private-tables.ts` — the module's public surface is the `isReplicatedTable`
 * predicate, because a caller that could see the set would be tempted to
 * subtract from it. The v0 tree is a pinned oracle (#1020) and adding an
 * `export` to it is not a permitted edit, so the names are read out of the
 * declaration's own text and then EVERY name is put back through the exported
 * predicate. A mis-parse therefore fails loudly here rather than shipping a
 * short allow-list into `crates/vault` (#1020, D-1020-D1-12).
 */
function replicatedTables(): string[] {
  const source = readFileSync(
    new URL(
      "../../packages/vault/src/schema/private-tables.ts",
      import.meta.url
    ),
    "utf8"
  );
  const opener =
    "const REPLICATED_TABLE_NAMES: ReadonlySet<string> = new Set([";
  const start = source.indexOf(opener);
  if (start < 0) {
    throw new Error(
      "export-v0-registries: REPLICATED_TABLE_NAMES is no longer declared the way this script reads it"
    );
  }
  const end = source.indexOf("]);", start);
  if (end < 0) {
    throw new Error(
      "export-v0-registries: the allow-list literal is unterminated"
    );
  }
  const body = source.slice(start + opener.length, end);
  const names = [...body.matchAll(/"(?<name>[A-Za-z0-9_]+)"/gu)].map(
    (match) => match.groups?.name as string
  );
  const unique = [...new Set(names)].sort();
  if (unique.length !== names.length) {
    throw new Error(
      "export-v0-registries: the allow-list literal repeats a name"
    );
  }
  // The predicate is the oracle for the parse. An ext-band prefix would pass
  // it without being in the literal, so the check is one-directional on
  // purpose: everything parsed IS replicated.
  const rejected = unique.filter((name) => !isReplicatedTable(name));
  if (rejected.length > 0) {
    throw new Error(
      `export-v0-registries: parsed names that isReplicatedTable() denies: ${rejected.join(", ")}`
    );
  }
  if (unique.length < 100) {
    throw new Error(
      `export-v0-registries: only ${unique.length} replicated table(s) parsed; the literal holds well over a hundred`
    );
  }
  return unique;
}

const exported = {
  $generatedBy: "bun contracts/tools/export-v0-registries.ts",
  $note:
    "Transcribed from packages/vault/src/schema — the v0 tree is the source " +
    "of these registries until wave 6 (#1020). The two version keys are the " +
    "ends of the window v1 accepts (D-1020-A1): `userVersion` is what the " +
    "#929 golden corpus was frozen at, `ladderUserVersion` is what a FRESH " +
    "v0 vault reaches today (VAULT_MIGRATIONS.length). A file above the " +
    "ladder head is refused as a downgrade, one below the corpus as needing " +
    "a forward migration.",
  ontologyVersion: ONTOLOGY_VERSION,
  userVersion: goldenUserVersion(),
  ladderUserVersion: VAULT_MIGRATIONS.length,
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
  // The replica plane, for `crates/vault` (#1020, D-1020-D1-12). The
  // allow-list is what a seat's copy holds; the constants are the numbers the
  // log plane is built out of, and a Rust constant that disagreed with one of
  // them would be a silent protocol change.
  replicatedTables: replicatedTables(),
  replicaConstants: {
    schemaEpoch: REPLICA_SCHEMA_EPOCH,
    ddlVersion: REPLICA_DDL_VERSION,
    seatSqliteFloor: SEAT_SQLITE_FLOOR,
    producerMaxRows: REPLICA_PRODUCER_MAX_ROWS,
    deferThresholdBytes: REPLICA_DEFER_THRESHOLD_BYTES,
    logRetentionDays: REPLICA_LOG_RETENTION_DAYS,
    logRetentionMaxRows: REPLICA_LOG_RETENTION_MAX_ROWS,
    seatHoldDays: REPLICA_SEAT_HOLD_DAYS,
    idempotencyWindowDays: REPLICA_IDEMPOTENCY_WINDOW_DAYS,
    seatLogMaxPage: SEAT_LOG_MAX_PAGE,
    localTables: [...REPLICA_LOCAL_TABLES].sort(),
    jsonKeyExclusions: [...REPLICATED_COLUMN_EXCLUSIONS]
      .map((exclusion) => ({
        table: exclusion.table,
        column: exclusion.column,
        jsonKeys: [...exclusion.jsonKeys],
      }))
      .sort((a, b) =>
        `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`)
      ),
  },
};

process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
