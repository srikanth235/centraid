// ReadRequest.orderBy (issue #262): ordering is what turns a bounded read
// into a recent window. Column and direction are validated like filter
// columns — caller strings never become SQL text.

import { beforeEach, expect, test } from 'vitest';
import { registerKnowledgeCommands } from '../commands/knowledge.js';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { compileFilters, compileOrderBy } from './filters.js';
import { createGateway, Gateway } from './gateway.js';
import type { Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PURPOSE = 'dpv:ServiceProvision';

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerKnowledgeCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  for (const [title, updated] of [
    ['oldest', '2026-01-01T00:00:00Z'],
    ['newest', '2026-03-01T00:00:00Z'],
    ['middle', '2026-02-01T00:00:00Z'],
  ] as const) {
    gw.invoke(owner, {
      command: 'knowledge.create_note',
      input: { title, body_text: `body of ${title}` },
      purpose: PURPOSE,
    });
    db.vault
      .prepare('UPDATE knowledge_note SET updated_at = ? WHERE title = ?')
      .run(updated, title);
  }
});

test('orderBy + limit reads the recent window, not arbitrary rows', () => {
  const result = gw.read(owner, {
    entity: 'knowledge.note',
    orderBy: { column: 'updated_at', dir: 'desc' },
    limit: 2,
    purpose: PURPOSE,
  });
  expect(result.rows.map((r) => r.title)).toEqual(['newest', 'middle']);
});

test('default direction is ascending', () => {
  const result = gw.read(owner, {
    entity: 'knowledge.note',
    orderBy: { column: 'updated_at' },
    purpose: PURPOSE,
  });
  expect(result.rows.map((r) => r.title)).toEqual(['oldest', 'middle', 'newest']);
});

test('UUIDv7 id order is insertion (time) order', () => {
  const result = gw.read(owner, {
    entity: 'knowledge.note',
    orderBy: { column: 'note_id', dir: 'desc' },
    limit: 1,
    purpose: PURPOSE,
  });
  // `middle` was created last (its timestamp was backdated after insert).
  expect(result.rows[0]?.title).toBe('middle');
});

test('unknown order column or direction never reaches SQL', () => {
  expect(() =>
    gw.read(owner, {
      entity: 'knowledge.note',
      orderBy: { column: 'updated_at; DROP TABLE knowledge_note', dir: 'desc' },
      purpose: PURPOSE,
    }),
  ).toThrow(/unknown order column/);
  expect(() =>
    gw.read(owner, {
      entity: 'knowledge.note',
      orderBy: { column: 'updated_at', dir: 'sideways' as 'asc' },
      purpose: PURPOSE,
    }),
  ).toThrow(/unknown order direction/);
});

test('ordering composes with caller filters', () => {
  const result = gw.read(owner, {
    entity: 'knowledge.note',
    where: [{ column: 'title', op: 'ne', value: 'newest' }],
    orderBy: { column: 'updated_at', dir: 'desc' },
    purpose: PURPOSE,
  });
  expect(result.rows.map((r) => r.title)).toEqual(['middle', 'oldest']);
});

test('ties use the exposed scalar primary key before LIMIT', () => {
  db.vault.prepare('UPDATE knowledge_note SET updated_at = ?').run('2026-04-01T00:00:00Z');
  const expected = db.vault
    .prepare('SELECT note_id FROM knowledge_note ORDER BY note_id COLLATE BINARY ASC LIMIT 2')
    .all()
    .map((row) => String((row as { note_id: string }).note_id));

  const result = gw.read(owner, {
    entity: 'knowledge.note',
    orderBy: { column: 'updated_at', dir: 'desc' },
    limit: 2,
    purpose: PURPOSE,
  });
  expect(result.rows.map((row) => row.note_id)).toEqual(expected);
});

test('fixed query grammar overrides a declared NOCASE collation with BINARY', () => {
  db.vault.exec(`
    CREATE TABLE _read_collation_probe (
      probe_id TEXT PRIMARY KEY,
      label TEXT COLLATE NOCASE NOT NULL
    );
    INSERT INTO _read_collation_probe(probe_id, label)
    VALUES ('z', 'Alpha'), ('a', 'alpha');
  `);

  const filter = compileFilters(
    db.vault,
    '_read_collation_probe',
    [{ column: 'label', op: 'eq', value: 'alpha' }],
    '2026-01-01T00:00:00.000Z',
  );
  const filtered = db.vault
    .prepare(`SELECT label FROM _read_collation_probe WHERE ${filter.where}`)
    .all(...filter.params);
  expect(filtered.map((row) => (row as { label: string }).label)).toEqual(['alpha']);

  const order = compileOrderBy(db.vault, '_read_collation_probe', { column: 'label' }, 'probe_id');
  const ordered = db.vault
    .prepare(`SELECT label FROM _read_collation_probe${order}`)
    .all()
    .map((row) => (row as { label: string }).label);
  expect(ordered).toEqual(['Alpha', 'alpha']);
});
