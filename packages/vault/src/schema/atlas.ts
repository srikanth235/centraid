// The Vault Atlas mapping (issue #441 Part B, B4 item 1): table → kind → pack
// classification for the Operations "ontology at a glance" surface. This is
// the one small new artifact all three Atlas tabs (Kinds / Relations /
// Browse) share.
//
// The mapping is DERIVED from the logical↔physical registry (`tables.ts`) —
// it never hand-lists tables. `VAULT_TABLES` and `JOURNAL_TABLES` are the
// single source of truth for which tables exist; this module only adds the
// centraid-specific meaning a generic DB editor throws away: which schemas
// are ONTOLOGY packs (the owner's life data — people, documents, photos…)
// versus MACHINERY bands (the plumbing — consent, agents, sync, blobs, the
// journal). Life data vs plumbing is the visual statement the Kinds tab and
// the machinery shelf make (issue #441 B1).

import { JOURNAL_TABLES, VAULT_TABLES } from './tables.js';

/** Ontology packs — the owner's life data, one section per pack in Kinds. */
export type AtlasPackKind = 'ontology' | 'machinery';

/**
 * The ontology packs (issue #441 B1): every schema whose tables are the
 * owner's actual knowledge. Everything else in the registry is machinery.
 * Kept as an explicit set so a NEW pack schema fails loud (unclassified)
 * rather than silently landing in the wrong shelf — see `atlasTables`.
 */
export const ONTOLOGY_PACKS: readonly string[] = [
  'core',
  'health',
  'finance',
  'schedule',
  'social',
  'knowledge',
  'media',
  'home',
  'business',
  'people',
  'locker',
  'tally',
];

/**
 * Machinery bands (issue #441 B1 "machinery shelf"): the plumbing schemas.
 * `consent` and `agent` name tables in BOTH files — the vault-file consent
 * plane and the journal-file audit stream — and both are machinery, so a
 * schema-keyed classification is correct regardless of file.
 */
export const MACHINERY_BANDS: readonly string[] = [
  'consent',
  'agent',
  'sync',
  'enrich',
  'outbox',
  'blob',
];

/** Human labels per pack — the serif vocabulary the census sentence uses. */
export const ATLAS_PACK_LABELS: Readonly<Record<string, string>> = {
  core: 'Core',
  health: 'Health',
  finance: 'Finance',
  schedule: 'Schedule',
  social: 'Social',
  knowledge: 'Knowledge',
  media: 'Media',
  home: 'Home',
  business: 'Business',
  people: 'People',
  locker: 'Locker',
  tally: 'Tally',
  consent: 'Consent',
  agent: 'Agents',
  sync: 'Sync',
  enrich: 'Enrichment',
  outbox: 'Outbox',
  blob: 'Blobs',
};

const ONTOLOGY_SET = new Set(ONTOLOGY_PACKS);
const MACHINERY_SET = new Set(MACHINERY_BANDS);

/** Which shelf a schema belongs to, or undefined for an unknown schema. */
export function packKindOf(schema: string): AtlasPackKind | undefined {
  if (ONTOLOGY_SET.has(schema)) return 'ontology';
  if (MACHINERY_SET.has(schema)) return 'machinery';
  return undefined;
}

/** A human-friendly kind label out of the physical table's local name. */
export function humanizeKind(table: string): string {
  return table
    .split('_')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/** One row of the Atlas mapping: a physical table with its pack identity. */
export interface AtlasTableEntry {
  /** Logical `schema.table`, the name grants/links/provenance store. */
  logical: string;
  /** SQLite schema half of the logical name (the pack). */
  schema: string;
  /** SQLite table half of the logical name (the kind). */
  table: string;
  /** Physical SQLite table name, e.g. `core_party`. */
  physical: string;
  /** Which file the table lives in. */
  file: 'vault' | 'journal';
  /** The pack (== schema); named separately so callers read intent, not SQL. */
  pack: string;
  /** Ontology (life data) vs machinery (plumbing). */
  packKind: AtlasPackKind;
  /** The pack's human label. */
  packLabel: string;
  /** The kind's human label. */
  label: string;
}

function entryFor(schema: string, table: string, file: 'vault' | 'journal'): AtlasTableEntry {
  const packKind = packKindOf(schema);
  if (packKind === undefined) {
    // A schema the registry lists but this module hasn't classified — fail
    // loud rather than mis-shelve. Adding a pack means adding it to
    // ONTOLOGY_PACKS or MACHINERY_BANDS (and its label), by design.
    throw new Error(
      `atlas: unclassified schema "${schema}" — add it to ONTOLOGY_PACKS or MACHINERY_BANDS`,
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
    label: humanizeKind(table),
  };
}

/**
 * Every registered table, mapped to its pack — derived from `VAULT_TABLES`
 * and `JOURNAL_TABLES`, never hand-listed. Vault-file tables first, then the
 * journal's audit bands. Ext-band (app-declared) tables are NOT included:
 * the Atlas maps the canonical ontology, not per-app scratch schemas.
 */
export function atlasTables(): AtlasTableEntry[] {
  const out: AtlasTableEntry[] = [];
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table, 'vault'));
  }
  for (const [schema, tables] of Object.entries(JOURNAL_TABLES)) {
    for (const table of tables) out.push(entryFor(schema, table, 'journal'));
  }
  return out;
}

/** Index the mapping by physical table name (both files). */
export function atlasTablesByPhysical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.physical, e]));
}

/** Index the mapping by logical `schema.table` name. */
export function atlasTablesByLogical(): Map<string, AtlasTableEntry> {
  return new Map(atlasTables().map((e) => [e.logical, e]));
}
