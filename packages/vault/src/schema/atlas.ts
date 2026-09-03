import { VAULT_ENTITIES, VAULT_TABLES, entityDeclaration } from "./tables.js";

export type AtlasPackKind = "ontology" | "machinery";

export const ONTOLOGY_PACKS: readonly string[] = [
  "core",
  "schedule",
  "social",
  "knowledge",
  "media",
  "people",
  "locker",
  "tally",
];

export const MACHINERY_BANDS: readonly string[] = [
  "access",
  "agent",
  "audit",
  "ledger",
  "sync",
  "enrich",
  "outbox",
  "notifications",
  "blob",
  "share",
];

export const ATLAS_PACK_LABELS: Readonly<Record<string, string>> = {
  core: "Core",
  schedule: "Schedule",
  social: "Social",
  knowledge: "Knowledge",
  media: "Media",
  people: "People",
  locker: "Locker",
  tally: "Tally",
  access: "Access",
  agent: "Agents",
  audit: "Audit",
  ledger: "Ledger",
  sync: "Sync",
  enrich: "Enrichment",
  outbox: "Outbox",
  notifications: "Notifications",
  blob: "Blobs",
  share: "Sharing",
};

export const ATLAS_KIND_FRIENDLY: Readonly<
  Record<string, { name: string; blurb: string }>
> = Object.fromEntries(
  Object.entries(VAULT_ENTITIES).flatMap(([schema, entities]) =>
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

export function packKindOf(schema: string): AtlasPackKind | undefined {
  if (ONTOLOGY_SET.has(schema)) return "ontology";
  if (MACHINERY_SET.has(schema)) return "machinery";
  return undefined;
}

export function humanizeKind(table: string): string {
  return table
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export interface AtlasTableEntry {
  logical: string;
  schema: string;
  table: string;
  physical: string;
  pack: string;
  packKind: AtlasPackKind;
  packLabel: string;
  label: string;
  friendly: string;
  blurb?: string;
}

function entryFor(schema: string, table: string): AtlasTableEntry {
  const packKind = packKindOf(schema);
  if (packKind === undefined) {
    throw new Error(
      `atlas: unclassified schema "${schema}" — add it to ONTOLOGY_PACKS or MACHINERY_BANDS`
    );
  }
  const label = humanizeKind(table);
  const declaration = entityDeclaration(`${schema}.${table}`);
  if (!declaration) {
    throw new Error(
      `atlas: ${schema}.${table} is not a registered entity — the registry names every kind (issue #883, ruling O-label)`
    );
  }
  return {
    logical: `${schema}.${table}`,
    schema,
    table,
    physical: `${schema}_${table}`,
    pack: schema,
    packKind,
    packLabel: ATLAS_PACK_LABELS[schema] ?? humanizeKind(schema),
    label,
    friendly: declaration.label,
    ...(declaration.blurb === undefined ? {} : { blurb: declaration.blurb }),
  };
}

export function atlasTables(): AtlasTableEntry[] {
  const out: AtlasTableEntry[] = [];
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table));
  }
  return out;
}

export function atlasTablesByPhysical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.physical, e]));
}

export function atlasTablesByLogical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.logical, e]));
}
