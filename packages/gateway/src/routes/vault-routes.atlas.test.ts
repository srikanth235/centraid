import { tempDir } from '@centraid/test-kit/temp-dir';
// The Vault Atlas owner routes (issue #441 Part B): stats / graph / pulse.
// These assert the gateway wires the vault-package builders to owner-gated
// GET routes and returns the census/graph/pulse payloads. The ghost-semantics
// and FK≠core_link invariants are proven in packages/vault; here we prove the
// route surface and that numbers are computed from the live schema.

import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { makeVaultRouteHandler } from './vault-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
async function startHandlerServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

async function setup(): Promise<{ base: string; plane: VaultPlane }> {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const plane = registry.current();
  const base = await startHandlerServer(makeVaultRouteHandler(registry));
  return { base, plane };
}

function insertParty(plane: VaultPlane, id: string, name: string): void {
  const now = new Date().toISOString();
  plane.db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, ?, ?, '1.3')`,
    )
    .run(id, name, now, now);
}

test('GET /atlas/stats returns a grouped census with ontology packs first', async () => {
  const { base, plane } = await setup();
  insertParty(plane, 'p1', 'Ravi');

  const res = await fetch(`${base}/centraid/_vault/atlas/stats`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    method: string;
    packs: Array<{ pack: string; packKind: string; file: string; rows: number; tables: unknown[] }>;
    totals: { rows: number; kinds: number; populatedKinds: number };
  };
  expect(['dbstat', 'estimate']).toContain(body.method);
  const core = body.packs.find((p) => p.pack === 'core' && p.file === 'vault');
  expect(core?.rows).toBeGreaterThanOrEqual(1);
  // Ontology packs sort ahead of machinery.
  const firstMachinery = body.packs.findIndex((p) => p.packKind === 'machinery');
  const lastOntology = body.packs.map((p) => p.packKind).lastIndexOf('ontology');
  expect(lastOntology).toBeLessThan(firstMachinery);
  expect(body.totals.kinds).toBeGreaterThan(body.totals.populatedKinds);
});

test('GET /atlas/graph carries FK edges and authored links as SEPARATE collections', async () => {
  const { base, plane } = await setup();
  insertParty(plane, 'p1', 'Ravi');
  insertParty(plane, 'p2', 'Asha');
  const now = new Date().toISOString();
  // A non-empty NOT NULL child edge, and an authored core_link.
  plane.db.vault
    .prepare(
      `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, is_primary, valid_from)
       VALUES ('id1','p1','email','ravi@example.com',1,?)`,
    )
    .run(now);
  plane.db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES ('s1','urn:kin','Kinship','1')`,
    )
    .run();
  plane.db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label) VALUES ('c1','s1','spouse','Spouse')`,
    )
    .run();
  plane.db.vault
    .prepare(
      `INSERT INTO core_link (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
       VALUES ('l1','core.party','p1','core.party','p2','c1',?,'owner')`,
    )
    .run(now);

  const res = await fetch(`${base}/centraid/_vault/atlas/graph`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    center: string;
    edgeCount: number;
    centerEdgeCount: number;
    fkEdges: Array<{
      fromTable: string;
      col: string;
      notnull: boolean;
      childRows: number;
      fill: number;
      ghost: boolean;
    }>;
    authoredLinks: Array<{
      relationLabel: string | null;
      fromType: string;
      toType: string;
      count: number;
    }>;
    island: string[];
    nodes: Array<{ physical: string; hopDistance: number | null }>;
  };

  expect(body.center).toBe('core_party');
  expect(body.edgeCount).toBe(body.fkEdges.length);
  expect(body.centerEdgeCount).toBeGreaterThan(0);

  // The populated NOT NULL edge is present and NOT a ghost.
  const populated = body.fkEdges.find(
    (e) => e.fromTable === 'core_party_identifier' && e.col === 'party_id',
  );
  expect(populated?.notnull).toBe(true);
  expect(populated?.ghost).toBe(false);
  expect(populated?.fill).toBe(populated?.childRows);

  // The authored link rides authoredLinks ONLY — never fkEdges.
  expect(body.authoredLinks).toHaveLength(1);
  expect(body.authoredLinks[0]!.relationLabel).toBe('Spouse');
  expect(body.fkEdges.some((e) => e.fromTable === 'core_link' && e.col === 'from_id')).toBe(false);

  // core_party at the centre; the locker/sync island surfaced honestly.
  expect(body.nodes.find((n) => n.physical === 'core_party')?.hopDistance).toBe(0);
  expect(body.island).toContain('locker_item');
});

test('GET /atlas/pulse buckets journal provenance writes over the window', async () => {
  const { base, plane } = await setup();
  const now = new Date().toISOString();
  plane.db.journal
    .prepare(
      `INSERT INTO consent_provenance (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, occurred_at)
       VALUES ('pv1','core.party','p1','create','owner','owner',?)`,
    )
    .run(now);

  const res = await fetch(`${base}/centraid/_vault/atlas/pulse`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    windowDays: number;
    live: boolean;
    series: Array<{ entityType: string; physical: string | null; total: number }>;
  };
  expect(body.windowDays).toBe(30);
  expect(body.live).toBe(true);
  const party = body.series.find((s) => s.entityType === 'core.party');
  expect(party?.physical).toBe('core_party');
  expect(party?.total).toBe(1);
});

test('an unknown atlas sub-route 404s', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}/centraid/_vault/atlas/nope`);
  expect(res.status).toBe(404);
});
