// The Atlas mapping is DERIVED from the registry, not hand-listed (issue
// #441 B4 item 1). These tests pin that: every registered table is mapped,
// classification is exhaustive, and physical/logical names round-trip.

import { expect, test } from 'vitest';
import { JOURNAL_TABLES, VAULT_TABLES } from './tables.js';
import {
  ATLAS_KIND_FRIENDLY,
  ATLAS_PACK_LABELS,
  MACHINERY_BANDS,
  ONTOLOGY_PACKS,
  atlasTables,
  atlasTablesByLogical,
  atlasTablesByPhysical,
  packKindOf,
} from './atlas.js';

function registrySize(): number {
  const vault = Object.values(VAULT_TABLES).reduce((n, t) => n + t.length, 0);
  const journal = Object.values(JOURNAL_TABLES).reduce((n, t) => n + t.length, 0);
  return vault + journal;
}

test('atlasTables covers exactly the registry — derived, never hand-listed', () => {
  const entries = atlasTables();
  expect(entries.length).toBe(registrySize());
  // Every logical name in the registry appears exactly once.
  const logicalFromRegistry = new Set<string>();
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const t of tables) logicalFromRegistry.add(`${schema}.${t}`);
  }
  for (const [schema, tables] of Object.entries(JOURNAL_TABLES)) {
    for (const t of tables) logicalFromRegistry.add(`${schema}.${t}`);
  }
  const logicalFromAtlas = new Set(entries.map((e) => e.logical));
  expect(logicalFromAtlas).toEqual(logicalFromRegistry);
});

test('every registered schema is classified — no unclassified pack slips through', () => {
  // atlasTables() throws on an unclassified schema; reaching here proves the
  // whole registry classifies. Additionally assert the union is exhaustive.
  const schemas = new Set([...Object.keys(VAULT_TABLES), ...Object.keys(JOURNAL_TABLES)]);
  for (const schema of schemas) {
    expect(packKindOf(schema)).toBeDefined();
    expect(ATLAS_PACK_LABELS[schema]).toBeTypeOf('string');
  }
  // Ontology and machinery partition the schema space with no overlap.
  const ontology = new Set(ONTOLOGY_PACKS);
  const machinery = new Set(MACHINERY_BANDS);
  for (const schema of schemas) {
    expect(ontology.has(schema) !== machinery.has(schema)).toBe(true);
  }
});

test('classification matches the life-data vs plumbing split', () => {
  expect(packKindOf('people')).toBe('ontology');
  expect(packKindOf('media')).toBe('ontology');
  expect(packKindOf('core')).toBe('ontology');
  expect(packKindOf('consent')).toBe('machinery');
  expect(packKindOf('blob')).toBe('machinery');
  expect(packKindOf('outbox')).toBe('machinery');
});

test('every ATLAS_KIND_FRIENDLY key is a real registry logical name — no dead keys', () => {
  // The load-bearing invariant: curated copy must never orphan. A typo or a
  // removed kind fails loud here rather than silently producing dead entries.
  const byLogical = atlasTablesByLogical();
  for (const logical of Object.keys(ATLAS_KIND_FRIENDLY)) {
    const entry = byLogical.get(logical);
    expect(entry, `curated key "${logical}" is not a registered logical name`).toBeDefined();
    // Curated copy is for the owner's life data, never for plumbing.
    expect(entry!.packKind).toBe('ontology');
  }
});

test('curated kinds carry name+blurb; uncurated kinds fall back with no blurb', () => {
  const byLogical = atlasTablesByLogical();
  // A curated kind: friendly is the curated name, blurb is the curated blurb.
  const party = byLogical.get('core.party')!;
  expect(party.friendly).toBe('People');
  expect(party.blurb).toBe(ATLAS_KIND_FRIENDLY['core.party']!.blurb);
  expect(party.friendly).not.toBe(party.label); // curated name overrode "Party".

  // An uncurated machinery kind: friendly === label, no blurb fabricated.
  const provenance = byLogical.get('consent.provenance')!;
  expect(provenance.friendly).toBe(provenance.label);
  expect(provenance.blurb).toBeUndefined();
});

test('physical/logical names derive from schema_table and index round-trips', () => {
  const byPhysical = atlasTablesByPhysical();
  const byLogical = atlasTablesByLogical();
  const party = byLogical.get('core.party');
  expect(party).toBeDefined();
  expect(party!.physical).toBe('core_party');
  expect(party!.file).toBe('vault');
  expect(party!.packKind).toBe('ontology');
  expect(byPhysical.get('core_party')).toEqual(party);

  // A journal-file audit table maps to its physical name and machinery shelf.
  const prov = byLogical.get('consent.provenance');
  expect(prov).toBeDefined();
  expect(prov!.physical).toBe('consent_provenance');
  expect(prov!.file).toBe('journal');
  expect(prov!.packKind).toBe('machinery');
});
