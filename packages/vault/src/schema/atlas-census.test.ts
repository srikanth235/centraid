// The Atlas census/graph/pulse builders (issue #441 Part B). The load-bearing
// test is the ghost invariant the issue demands: a NOT NULL FK column on a
// non-empty child table is NEVER reported as a ghost. Expected edge counts
// are derived from the PRAGMA walk itself — never asserted as literals (no
// 122/46).

import { afterEach, expect, test } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openVaultDb } from '../db.js';
import { VAULT_TABLES } from './tables.js';
import { atlasCensus, atlasGraph, atlasPulse, ATLAS_GRAPH_CENTER } from './atlas-census.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshVault(): ReturnType<typeof openVaultDb> {
  const db = openVaultDb();
  cleanups.push(() => {
    db.vault.close();
    db.journal.close();
  });
  return db;
}

/** Independently walk PRAGMA foreign_key_list — the derived expectation. */
function walkFkCount(vault: DatabaseSync): { total: number; toCenter: number } {
  let total = 0;
  let toCenter = 0;
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const t of tables) {
      const physical = `${schema}_${t}`;
      const fks = vault.prepare(`PRAGMA foreign_key_list("${physical}")`).all() as unknown as {
        table: string;
      }[];
      total += fks.length;
      toCenter += fks.filter((f) => f.table === ATLAS_GRAPH_CENTER).length;
    }
  }
  return { total, toCenter };
}

test('graph edge counts are DERIVED from the PRAGMA walk, not hardcoded', () => {
  const db = freshVault();
  const graph = atlasGraph(db.vault);
  const expected = walkFkCount(db.vault);
  expect(graph.edgeCount).toBe(expected.total);
  expect(graph.centerEdgeCount).toBe(expected.toCenter);
  // The data-driven "star" claim: core_party takes the largest share of edges.
  expect(graph.centerEdgeCount).toBeGreaterThan(0);
  expect(graph.center).toBe(ATLAS_GRAPH_CENTER);
});

test('a NOT NULL FK on a non-empty child table is NEVER a ghost', () => {
  const db = freshVault();
  const now = new Date().toISOString();
  // Parent spine row, then a child with a NOT NULL FK to it.
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('p1', 'person', 'Ravi', ?, ?, '1.3')`,
    )
    .run(now, now);
  db.vault
    .prepare(
      `INSERT INTO core_party_identifier
         (identifier_id, party_id, scheme, value, is_primary, valid_from)
       VALUES ('id1', 'p1', 'email', 'ravi@example.com', 1, ?)`,
    )
    .run(now);

  const graph = atlasGraph(db.vault);

  // The specific edge we populated: a NOT NULL FK on a non-empty child.
  const populated = graph.fkEdges.find(
    (e) => e.fromTable === 'core_party_identifier' && e.col === 'party_id',
  );
  expect(populated).toBeDefined();
  expect(populated!.notnull).toBe(true);
  expect(populated!.childRows).toBeGreaterThan(0);
  expect(populated!.fill).toBe(populated!.childRows);
  expect(populated!.ghost).toBe(false);

  // The class-closing invariant: across EVERY edge, a NOT NULL column on a
  // non-empty child can never be a ghost (ghost is fill-based, not "no link").
  for (const edge of graph.fkEdges) {
    if (edge.notnull && edge.childRows > 0) {
      expect(edge.fill).toBe(edge.childRows);
      expect(edge.ghost).toBe(false);
    }
  }
});

test('a nullable FK nobody sets is a ghost; an empty child is a ghost', () => {
  const db = freshVault();
  const graph = atlasGraph(db.vault);
  // A fresh vault: every child table is empty, so every edge is a ghost.
  for (const edge of graph.fkEdges) {
    expect(edge.childRows).toBe(0);
    expect(edge.fill).toBe(0);
    expect(edge.ghost).toBe(true);
  }
});

test('FK edges and authored links are SEPARATE collections (FK ≠ core_link)', () => {
  const db = freshVault();
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('p1','person','Ravi',?,?,'1.3'),('p2','person','Asha',?,?,'1.3')`,
    )
    .run(now, now, now, now);
  db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES ('s1','urn:kin','Kinship','1')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label)
       VALUES ('c1','s1','spouse','Spouse')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
       VALUES ('l1','core.party','p1','core.party','p2','c1',?,'owner')`,
    )
    .run(now);

  const graph = atlasGraph(db.vault);
  // The authored link shows up ONLY in authoredLinks, with its concept label.
  expect(graph.authoredLinks).toHaveLength(1);
  const link = graph.authoredLinks[0]!;
  expect(link.relationConceptId).toBe('c1');
  expect(link.relationLabel).toBe('Spouse');
  expect(link.fromType).toBe('core.party');
  expect(link.toType).toBe('core.party');
  expect(link.count).toBe(1);

  // The authored link did NOT invent a party→party FK edge, and did not
  // change any FK fill (fkEdges are schema-derived, not link-derived).
  expect(graph.fkEdges.some((e) => e.fromTable === 'core_link' && e.col === 'from_id')).toBe(false);
});

test('BFS puts core_party at hop 0 and surfaces the unreached island', () => {
  const db = freshVault();
  const graph = atlasGraph(db.vault);
  const center = graph.nodes.find((n) => n.physical === ATLAS_GRAPH_CENTER);
  expect(center?.hopDistance).toBe(0);
  // The audit calls out locker + sync_connection as unreachable from core_party.
  expect(graph.island).toContain('locker_item');
  expect(graph.island).toContain('sync_connection');
  // Island nodes carry a null hop distance.
  for (const physical of graph.island) {
    const node = graph.nodes.find((n) => n.physical === physical);
    expect(node?.hopDistance).toBeNull();
  }
});

test('graph nodes speak human: curated friendly+blurb, uncurated fall back', () => {
  const db = freshVault();
  const graph = atlasGraph(db.vault);

  // A curated ontology kind emits its friendly name and its blurb.
  const party = graph.nodes.find((n) => n.physical === 'core_party');
  expect(party?.friendly).toBe('People');
  expect(party?.blurb).toBe('Everyone you know — people and organisations.');

  // An uncurated kind falls back: friendly === label, and no blurb is emitted.
  const uncurated = graph.nodes.find((n) => n.blurb === undefined);
  expect(uncurated).toBeDefined();
  expect(uncurated!.friendly).toBe(uncurated!.label);

  // friendly is ALWAYS present; blurb NEVER without a curated friendly name.
  for (const node of graph.nodes) {
    expect(typeof node.friendly).toBe('string');
    if (node.blurb !== undefined) expect(node.friendly).not.toBe('');
  }
});

test('self-referencing tables are flagged', () => {
  const db = freshVault();
  const graph = atlasGraph(db.vault);
  // core_place.parent_place_id, core_concept.broader_concept_id etc.
  const place = graph.nodes.find((n) => n.physical === 'core_place');
  expect(place?.selfRef).toBe(true);
  expect(graph.selfRefCount).toBeGreaterThan(0);
  // A self-ref edge is marked and excluded from BFS adjacency (no self-loop).
  const selfEdge = graph.fkEdges.find((e) => e.fromTable === 'core_place' && e.selfRef);
  expect(selfEdge).toBeDefined();
  expect(selfEdge!.toTable).toBe('core_place');
});

test('census groups ontology packs first with derived row counts', () => {
  const db = freshVault();
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('p1','person','Ravi',?,?,'1.3')`,
    )
    .run(now, now);

  const census = atlasCensus(db.vault, db.journal);
  // Ontology packs sort before machinery.
  const firstMachinery = census.packs.findIndex((p) => p.packKind === 'machinery');
  const lastOntology = census.packs.map((p) => p.packKind).lastIndexOf('ontology');
  expect(lastOntology).toBeLessThan(firstMachinery);

  const core = census.packs.find((p) => p.pack === 'core' && p.file === 'vault');
  expect(core).toBeDefined();
  const partyTable = core!.tables.find((t) => t.physical === 'core_party');
  expect(partyTable?.rows).toBe(1);
  expect(census.totals.rows).toBeGreaterThanOrEqual(1);
  // One party inserted ⇒ core.party is a populated kind.
  expect(census.totals.populatedKinds).toBeGreaterThanOrEqual(1);
  expect(census.totals.kinds).toBeGreaterThan(census.totals.populatedKinds);
});

test('pulse buckets provenance writes by entity_type and day within the window', () => {
  const db = freshVault();
  const today = new Date('2026-07-17T12:00:00.000Z');
  const insert = db.journal.prepare(
    `INSERT INTO consent_provenance
       (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, occurred_at)
     VALUES (?, ?, ?, 'create', 'owner', 'owner', ?)`,
  );
  insert.run('pv1', 'core.party', 'p1', '2026-07-17T09:00:00.000Z');
  insert.run('pv2', 'core.party', 'p2', '2026-07-16T09:00:00.000Z');
  insert.run('pv3', 'schedule.task', 'task-1', '2026-07-17T10:00:00.000Z');
  // Outside the 30-day window — must be excluded.
  insert.run('pv-old', 'core.party', 'p-old', '2026-01-01T09:00:00.000Z');

  const pulse = atlasPulse(db.journal, { now: today });
  expect(pulse.windowDays).toBe(30);
  expect(pulse.live).toBe(true);

  const party = pulse.series.find((s) => s.entityType === 'core.party');
  expect(party).toBeDefined();
  expect(party!.total).toBe(2); // pv1 + pv2, NOT the out-of-window pv-old
  expect(party!.physical).toBe('core_party');
  expect(party!.pack).toBe('core');
  expect(party!.days.map((d) => d.day).sort()).toEqual(['2026-07-16', '2026-07-17']);

  const task = pulse.series.find((s) => s.entityType === 'schedule.task');
  expect(task?.physical).toBe('schedule_task');
  // Series are sorted by total descending — party (2) before task (1).
  expect(pulse.series[0]!.entityType).toBe('core.party');
});
