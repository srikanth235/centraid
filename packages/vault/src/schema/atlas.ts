// The Vault Atlas mapping (#441): table → kind → pack. DERIVED from
// `VAULT_TABLES`/`JOURNAL_TABLES`, never hand-listed; all this module adds is
// ONTOLOGY packs (life data) versus MACHINERY bands (plumbing).

import {
  JOURNAL_ENTITIES,
  JOURNAL_TABLES,
  VAULT_ENTITIES,
  VAULT_TABLES,
  entityDeclaration,
} from "./tables.js";

export type AtlasPackKind = "ontology" | "machinery";

/** Explicit, so a NEW schema fails loud rather than mis-shelving (#441). */
export const ONTOLOGY_PACKS: readonly string[] = [
  "core",
  "health",
  "finance",
  "schedule",
  "social",
  "knowledge",
  "media",
  // `home`/`business` are deliberately out of the ontology (#883, #885).
  "people",
  "locker",
  "tally",
];

/** `consent` and `agent` name tables in BOTH files and are machinery in each,
 * so keying on schema alone is correct. */
export const MACHINERY_BANDS: readonly string[] = [
  "consent",
  "agent",
  "sync",
  "enrich",
  "outbox",
  "notifications",
  "blob",
  "share",
];

export const ATLAS_PACK_LABELS: Readonly<Record<string, string>> = {
  core: "Core",
  health: "Health",
  finance: "Finance",
  schedule: "Schedule",
  social: "Social",
  knowledge: "Knowledge",
  media: "Media",
  people: "People",
  locker: "Locker",
  tally: "Tally",
  consent: "Consent",
  agent: "Agents",
  sync: "Sync",
  enrich: "Enrichment",
  outbox: "Outbox",
  notifications: "Notifications",
  blob: "Blobs",
  share: "Sharing",
};

/**
 * Name + blurb per ONTOLOGY kind, so Relations says "People — everyone you
 * know", not "core_party". The blurb-carrying subset of the registry IS the
 * ontology: machinery is named, never given a fabricated description (#883).
 */
export const ATLAS_KIND_FRIENDLY: Readonly<
  Record<string, { name: string; blurb: string }>
> = Object.fromEntries(
  [
    ...Object.entries(VAULT_ENTITIES),
    ...Object.entries(JOURNAL_ENTITIES),
  ].flatMap(([schema, entities]) =>
    Object.entries(entities).flatMap(([table, declaration]) =>
      declaration.blurb === undefined
        ? []
        : [
            [
              `${schema}.${table}`,
              { name: declaration.label, blurb: declaration.blurb },
            ] as const,
          ]
    )
  )
);

const ONTOLOGY_SET = new Set(ONTOLOGY_PACKS);
const MACHINERY_SET = new Set(MACHINERY_BANDS);

/** Undefined for a schema this module has not classified. */
export function packKindOf(schema: string): AtlasPackKind | undefined {
  if (ONTOLOGY_SET.has(schema)) return "ontology";
  if (MACHINERY_SET.has(schema)) return "machinery";
  return undefined;
}

/** Humanized out of the physical table's local name. */
export function humanizeKind(table: string): string {
  return table
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export interface AtlasTableEntry {
  /** The name grants, links and provenance store. */
  logical: string;
  schema: string;
  table: string;
  physical: string;
  file: "vault" | "journal";
  pack: string;
  packKind: AtlasPackKind;
  packLabel: string;
  /** MECHANICAL, for a Browse tab over physical tables. */
  label: string;
  /** The registry's declared name, never invented here. */
  friendly: string;
  /** Declared only for the ontology; machinery is named, never described. */
  blurb?: string;
}

function entryFor(
  schema: string,
  table: string,
  file: "vault" | "journal"
): AtlasTableEntry {
  const packKind = packKindOf(schema);
  if (packKind === undefined) {
    // Fail loud rather than mis-shelve: a new pack is added by hand.
    throw new Error(
      `atlas: unclassified schema "${schema}" — add it to ONTOLOGY_PACKS or MACHINERY_BANDS`
    );
  }
  const label = humanizeKind(table);
  const declaration = entityDeclaration(`${schema}.${table}`);
  if (!declaration) {
    // Unreachable via `atlasTables`; loud anyway, because the alternative is
    // a node drawn under an invented name.
    throw new Error(
      `atlas: ${schema}.${table} is not a registered entity — the registry names every kind (issue #883, ruling O-label)`
    );
  }
  return {
    logical: `${schema}.${table}`,
    schema,
    table,
    physical: `${schema}_${table}`,
    file,
    pack: schema,
    packKind,
    packLabel: ATLAS_PACK_LABELS[schema] ?? humanizeKind(schema),
    label,
    friendly: declaration.label,
    ...(declaration.blurb === undefined ? {} : { blurb: declaration.blurb }),
  };
}

/**
 * Every registered table mapped to its pack. Ext-band (app-declared) tables
 * are excluded: the Atlas maps the canonical ontology, not per-app scratch.
 */
export function atlasTables(): AtlasTableEntry[] {
  const out: AtlasTableEntry[] = [];
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table, "vault"));
  }
  for (const [schema, tables] of Object.entries(JOURNAL_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table, "journal"));
  }
  return out;
}

export function atlasTablesByPhysical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.physical, e]));
}

export function atlasTablesByLogical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.logical, e]));
}
