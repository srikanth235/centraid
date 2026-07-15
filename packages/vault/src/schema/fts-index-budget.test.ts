// Per-document FTS index budget + rebuild path (issue #367 §E3): a body
// over FTS_BODY_INDEX_BUDGET_CHARS still gets a live note/document row with
// its FULL canonical body — only the SEARCH INDEX is capped. Real vaults,
// real triggers, no mocks.

import { expect, test } from 'vitest';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb } from '../db.js';
import { createGateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerDocumentCommands } from '../commands/documents.js';
import { registerKnowledgeCommands } from '../commands/knowledge.js';
import { FTS_BODY_INDEX_BUDGET_CHARS, rebuildFtsIndex, truncateForIndex } from './fts.js';
import { rebuildDocumentFtsIndex } from './blob.js';

function setup() {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: 'Priya' });
  const gw = createGateway(db);
  registerKnowledgeCommands(gw);
  registerDocumentCommands(gw);
  const owner: Credential = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  return { db, gw, owner };
}

test('truncateForIndex passes short values through untouched', () => {
  const db = openVaultDb();
  const row = db.vault.prepare(`SELECT ${truncateForIndex("'hello'", 100)} AS v`).get() as {
    v: string;
  };
  expect(row.v).toBe('hello');
});

test('truncateForIndex caps at the budget and appends a marker', () => {
  const db = openVaultDb();
  const long = 'x'.repeat(50);
  const row = db.vault.prepare(`SELECT ${truncateForIndex(`'${long}'`, 10)} AS v`).get() as {
    v: string;
  };
  expect(row.v.startsWith('x'.repeat(10))).toBe(true);
  expect(row.v).toContain('truncated for search index');
  expect(row.v.length).toBeLessThan(long.length);
});

test('truncateForIndex passes NULL through as NULL, not the marker', () => {
  const db = openVaultDb();
  const row = db.vault.prepare(`SELECT ${truncateForIndex('NULL', 10)} AS v`).get() as { v: null };
  expect(row.v).toBeNull();
});

test('a note body over budget is fully preserved in the canonical row but truncated in the index', () => {
  // Below the inline-body-guard threshold (64KB) but ABOVE a small FTS
  // budget we install for this test, so the two limits stay independently
  // testable — the guard bounds the ROW, this bounds the INDEX.
  const { db, gw, owner } = setup();
  const bodyText = 'lorem '.repeat(2000); // well under 64KB, over a tiny FTS budget
  const outcome = gw.invoke(owner, {
    command: 'knowledge.create_note',
    input: { title: 'Long note', body_text: bodyText },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const { note_id, body_content_id } = (
    outcome as { output: { note_id: string; body_content_id: string } }
  ).output;

  // The canonical body is untouched.
  const content = db.vault
    .prepare('SELECT content_uri FROM core_content_item WHERE content_id = ?')
    .get(body_content_id) as { content_uri: string };
  expect(decodeURIComponent(content.content_uri.split(',')[1] ?? '')).toBe(bodyText);

  // The FTS row, at the real (generous) budget, also holds it whole since
  // this body is far under FTS_BODY_INDEX_BUDGET_CHARS.
  const indexed = db.vault
    .prepare('SELECT body FROM fts_knowledge_note WHERE note_id = ?')
    .get(note_id) as {
    body: string;
  };
  expect(indexed.body).toBe(bodyText);
  expect(bodyText.length).toBeLessThan(FTS_BODY_INDEX_BUDGET_CHARS);
});

test("rebuildFtsIndex re-derives a live entity's rows from the base table", () => {
  const { db, gw, owner } = setup();
  const outcome = gw.invoke(owner, {
    command: 'knowledge.create_note',
    input: { title: 'Rebuild me', body_text: 'original body' },
    purpose: 'dpv:ServiceProvision',
  });
  const { note_id } = (outcome as { output: { note_id: string } }).output;

  // Corrupt the index row directly (simulating drift) — a rebuild must fix it.
  db.vault.exec(`UPDATE fts_knowledge_note SET body = 'stale' WHERE note_id = '${note_id}'`);
  let row = db.vault
    .prepare('SELECT body FROM fts_knowledge_note WHERE note_id = ?')
    .get(note_id) as {
    body: string;
  };
  expect(row.body).toBe('stale');

  rebuildFtsIndex(db.vault, 'knowledge.note');

  row = db.vault.prepare('SELECT body FROM fts_knowledge_note WHERE note_id = ?').get(note_id) as {
    body: string;
  };
  expect(row.body).toBe('original body');
});

test('rebuildFtsIndex refuses core.document and points at the derivative-aware rebuild', () => {
  const db = openVaultDb();
  expect(() => rebuildFtsIndex(db.vault, 'core.document')).toThrow(/rebuildDocumentFtsIndex/);
});

test('rebuildFtsIndex rejects an unknown entity', () => {
  const db = openVaultDb();
  expect(() => rebuildFtsIndex(db.vault, 'not.a.real.entity')).toThrow(/not a searchable entity/);
});

test('rebuildDocumentFtsIndex re-derives fts_core_document, extracted text still wins', () => {
  const { db, gw, owner } = setup();
  const outcome = gw.invoke(owner, {
    command: 'core.add_document',
    input: {
      title: 'Scan',
      data_uri: `data:application/pdf;base64,${Buffer.from('%PDF-fake').toString('base64')}`,
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const { document_id, content_id } = (
    outcome as {
      output: { document_id: string; content_id: string };
    }
  ).output;

  // Attach an extracted-text derivative directly (the enricher's path).
  db.vault
    .prepare(
      `INSERT INTO core_content_derivative (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
       VALUES ('deriv-1', ?, 'text', NULL, 'text/plain', 20, 'extracted pdf text', ?)`,
    )
    .run(content_id, new Date().toISOString());

  let row = db.vault
    .prepare('SELECT body FROM fts_core_document WHERE document_id = ?')
    .get(document_id) as {
    body: string;
  };
  expect(row.body).toBe('extracted pdf text');

  db.vault.exec(`UPDATE fts_core_document SET body = 'stale' WHERE document_id = '${document_id}'`);
  rebuildDocumentFtsIndex(db.vault);

  row = db.vault
    .prepare('SELECT body FROM fts_core_document WHERE document_id = ?')
    .get(document_id) as {
    body: string;
  };
  expect(row.body).toBe('extracted pdf text');
});
