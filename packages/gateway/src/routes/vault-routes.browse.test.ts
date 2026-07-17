// The Vault Atlas Browse routes (issue #441 Part B, B3): the owner-gated
// table editor over HTTP. The read/write policy is proven in packages/vault;
// here we prove the route surface — the picker, keyset rows, column metadata,
// a journalled insert that comes back on a read, and the dependent-blocked
// delete returning a 409 with the polymorphic + engine payload.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { makeVaultRouteHandler } from './vault-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-browse-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

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

const B = '/centraid/_vault/atlas/browse';

test('GET /browse/tables lists vault tables with pack classification', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}${B}/tables`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    tables: Array<{ logical: string; machinery: boolean; packKind: string }>;
  };
  const party = body.tables.find((t) => t.logical === 'core.party');
  expect(party?.machinery).toBe(false);
  expect(body.tables.some((t) => t.logical === 'blob.custody_state' && t.machinery)).toBe(true);
});

test('GET /browse/columns marks FK targets and sealed columns', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}${B}/columns?table=locker.item`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    columns: Array<{ name: string; sealed: boolean }>;
    displayField: string;
  };
  expect(body.columns.find((c) => c.name === 'password')?.sealed).toBe(true);
});

test('an unknown table 404s on a read route', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}${B}/columns?table=nope.table`);
  expect(res.status).toBe(404);
});

test('POST /browse/insert writes through the journalled path and reads back', async () => {
  const { base } = await setup();
  const insert = await fetch(`${base}${B}/insert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      table: 'core.concept_scheme',
      values: { scheme_id: 'S9', uri: 'urn:x:s9', title: 'Browse Scheme', version: '1' },
    }),
  });
  expect(insert.status).toBe(200);
  expect(((await insert.json()) as { ok: boolean; id: string }).id).toBe('S9');

  const row = await fetch(`${base}${B}/row?table=core.concept_scheme&id=S9`);
  expect(row.status).toBe(200);
  expect(((await row.json()) as { row: { title: string } }).row.title).toBe('Browse Scheme');
});

test('POST /browse/delete refuses with 409 + dependents when engine FKs point in', async () => {
  const { base, plane } = await setup();
  const now = new Date().toISOString();
  plane.db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('px','person','Ravi',?,?, '1.3')`,
    )
    .run(now, now);
  plane.db.vault
    .prepare(
      `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, is_primary, valid_from)
       VALUES ('idx','px','email','ravi@example.com',1,?)`,
    )
    .run(now);
  // A polymorphic pointer too, to prove the payload carries BOTH mechanisms.
  plane.db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES ('sx','urn:sx','Tags','1')`,
    )
    .run();
  plane.db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label) VALUES ('cx','sx','fam','Family')`,
    )
    .run();
  plane.db.vault
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
       VALUES ('tx','core.party','px','cx',?)`,
    )
    .run(now);

  const res = await fetch(`${base}${B}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'core.party', id: 'px' }),
  });
  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: string;
    dependents: Array<{ via: string; mechanism: string }>;
  };
  expect(body.error).toBe('has_dependents');
  expect(
    body.dependents.some((d) => d.mechanism === 'fk' && d.via === 'core_party_identifier.party_id'),
  ).toBe(true);
  expect(body.dependents.some((d) => d.mechanism === 'poly' && d.via.startsWith('core_tag.'))).toBe(
    true,
  );
});

test('POST /browse/delete on a machinery band without unlock fails 400', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}${B}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'blob.custody_state', id: 'nope' }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(/machinery/);
});
