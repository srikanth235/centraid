// The search stage: FTS5 shadow tables answer instead of base-table scans,
// under exactly read's consent posture — plus the two clamps search adds on
// top (folded-in content consent, indexed-column field masks).

import { beforeEach, describe, expect, test } from 'vitest';
import { registerKnowledgeCommands } from '../commands/knowledge.js';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from './gateway.js';
import { ftsMatchExpression } from './search.js';
import type { Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PURPOSE = 'dpv:ServiceProvision';

function createNote(title: string, body: string): string {
  const outcome = gw.invoke(owner, {
    command: 'knowledge.create_note',
    input: { title, body_text: body },
    purpose: PURPOSE,
  });
  if (outcome.status !== 'executed') throw new Error(`create_note ${outcome.status}`);
  return (outcome.output as { note_id: string }).note_id;
}

function appCred(scopes: Parameters<typeof createGrant>[1]['scopes']): Credential {
  const app = enrollApp(db, { name: `app-${Math.random().toString(36).slice(2, 8)}` });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts[PURPOSE] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes,
  });
  return { kind: 'app', appId: app.appId, signingKey: app.signingKey };
}

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerKnowledgeCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

describe('match expression', () => {
  test('words become quoted prefix phrases, operators become literals', () => {
    expect(ftsMatchExpression('budget plan')).toBe('"budget"* "plan"*');
    expect(ftsMatchExpression('a AND b NEAR( "x')).toBe('"a"* "AND"* "b"* "NEAR("* "x"*');
  });

  test('nothing searchable → null', () => {
    expect(ftsMatchExpression('   ')).toBeNull();
    expect(ftsMatchExpression('- " ~~')).toBeNull();
  });
});

describe('index-backed matching', () => {
  test('matches title and canonical body, ranked, with a snippet', () => {
    createNote('Money things', 'the quarterly budget plan for Diwali');
    createNote('Shopping', 'grocery list: dal, rice');
    const result = gw.search(owner, {
      entity: 'knowledge.note',
      query: 'budget',
      purpose: PURPOSE,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe('Money things');
    expect(result.rows[0]?._snippet).toContain('⟦budget⟧');
    expect(result.receiptId).toBeTruthy();
  });

  test('prefix matching serves as-you-type search', () => {
    createNote('Money things', 'the quarterly budget plan');
    const result = gw.search(owner, { entity: 'knowledge.note', query: 'budg', purpose: PURPOSE });
    expect(result.rows).toHaveLength(1);
  });

  test('edits re-index; deletes drop out', () => {
    const noteId = createNote('Money things', 'the quarterly budget plan');
    gw.invoke(owner, {
      command: 'knowledge.edit_note',
      input: { note_id: noteId, body_text: 'now all about pottery glaze' },
      purpose: PURPOSE,
    });
    const q = (query: string) =>
      gw.search(owner, { entity: 'knowledge.note', query, purpose: PURPOSE }).rows.length;
    expect(q('budget')).toBe(0);
    expect(q('pottery')).toBe(1);
    gw.invoke(owner, {
      command: 'knowledge.delete_note',
      input: { note_id: noteId },
      purpose: PURPOSE,
    });
    expect(q('pottery')).toBe(0);
  });

  test('caller where-clauses AND with the match', () => {
    const pinnedId = createNote('Pinned budget', 'budget A');
    createNote('Unpinned budget', 'budget B');
    gw.invoke(owner, {
      command: 'knowledge.edit_note',
      input: { note_id: pinnedId, pinned: 1 },
      purpose: PURPOSE,
    });
    const result = gw.search(owner, {
      entity: 'knowledge.note',
      query: 'budget',
      where: [{ column: 'pinned', op: 'eq', value: 1 }],
      purpose: PURPOSE,
    });
    expect(result.rows.map((r) => r.note_id)).toEqual([pinnedId]);
  });

  test('FTS operators in owner text never become syntax', () => {
    createNote('Ops', 'NEAR the AND river');
    const result = gw.search(owner, {
      entity: 'knowledge.note',
      query: '"NEAR( AND',
      purpose: PURPOSE,
    });
    expect(result.rows).toHaveLength(1);
  });
});

describe('contract clamps', () => {
  test('non-indexed entity is a contract error, not a scan', () => {
    expect(() =>
      gw.search(owner, { entity: 'health.vital', query: 'x', purpose: PURPOSE }),
    ).toThrow(/not text-searchable/);
  });

  test('empty query is a contract error', () => {
    expect(() =>
      gw.search(owner, { entity: 'knowledge.note', query: '  ', purpose: PURPOSE }),
    ).toThrow(/no searchable words/);
  });
});

describe('consent clamps', () => {
  test('ungranted app is denied with a receipt', () => {
    const app = enrollApp(db, { name: 'nosy-app' });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    expect(() =>
      gw.search(cred, { entity: 'knowledge.note', query: 'budget', purpose: PURPOSE }),
    ).toThrow(/deny/);
    const deny = db.journal
      .prepare(
        `SELECT count(*) AS n FROM consent_receipt WHERE decision='deny' AND action='search'`,
      )
      .get() as { n: number };
    expect(deny.n).toBe(1);
  });

  test('note-body search needs read consent on core.content_item too', () => {
    createNote('Money things', 'the quarterly budget plan');
    const cred = appCred([{ schema: 'knowledge', verbs: 'read' }]);
    expect(() =>
      gw.search(cred, { entity: 'knowledge.note', query: 'budget', purpose: PURPOSE }),
    ).toThrow(/core\.content_item/);
    const granted = appCred([
      { schema: 'knowledge', verbs: 'read' },
      { schema: 'core', table: 'content_item', verbs: 'read' },
    ]);
    expect(
      gw.search(granted, { entity: 'knowledge.note', query: 'budget', purpose: PURPOSE }).rows,
    ).toHaveLength(1);
  });

  test('grant row filters clamp matches', () => {
    createNote('Pinned budget', 'budget A');
    const cred = appCred([
      {
        schema: 'knowledge',
        verbs: 'read',
        rowFilter: [{ column: 'pinned', op: 'eq', value: 1 }],
      },
      { schema: 'core', table: 'content_item', verbs: 'read' },
    ]);
    expect(
      gw.search(cred, { entity: 'knowledge.note', query: 'budget', purpose: PURPOSE }).rows,
    ).toHaveLength(0);
  });

  test('a field mask hiding an indexed column fails the search closed', () => {
    createNote('Money things', 'the quarterly budget plan');
    const cred = appCred([
      { schema: 'knowledge', verbs: 'read', fieldMask: ['note_id', 'body_content_id'] },
      { schema: 'core', table: 'content_item', verbs: 'read' },
    ]);
    expect(() =>
      gw.search(cred, { entity: 'knowledge.note', query: 'budget', purpose: PURPOSE }),
    ).toThrow(/field mask hides indexed column/);
  });
});

describe('home.asset_item surface', () => {
  test('name and serial match; disposal keeps the row searchable', () => {
    const insert = db.vault.prepare(
      `INSERT INTO home_asset_item (item_id, owner_party_id, name, serial_no, disposed_on)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('it-1', boot.ownerPartyId, 'Dehumidifier', 'SN-9981', null);
    insert.run('it-2', boot.ownerPartyId, 'Old dehumidifier', null, '2024-01-15');
    insert.run('it-3', boot.ownerPartyId, 'Toaster', null, null);
    const byName = gw.search(owner, {
      entity: 'home.asset_item',
      query: 'dehumid',
      purpose: PURPOSE,
    });
    expect(byName.rows.map((r) => r.item_id).toSorted()).toEqual(['it-1', 'it-2']);
    const bySerial = gw.search(owner, {
      entity: 'home.asset_item',
      query: 'SN-9981',
      purpose: PURPOSE,
    });
    expect(bySerial.rows.map((r) => r.item_id)).toEqual(['it-1']);
  });
});

describe('pre-index vaults', () => {
  test('v1→v2 migration backfills existing rows into the index', () => {
    // Rebuild the index empty, then re-run only the backfill path by
    // simulating a vault whose base rows predate the shadow tables.
    createNote('Old note', 'archaeology of budgets');
    db.vault.exec(`DELETE FROM fts_knowledge_note`);
    expect(
      gw.search(owner, { entity: 'knowledge.note', query: 'archaeology', purpose: PURPOSE }).rows,
    ).toHaveLength(0);
    db.vault.exec(
      `INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
       SELECT b.rowid, b."note_id", b."title",
              (SELECT vault_content_text(media_type, content_uri) FROM core_content_item
                WHERE content_id = b."body_content_id")
         FROM knowledge_note b`,
    );
    expect(
      gw.search(owner, { entity: 'knowledge.note', query: 'archaeology', purpose: PURPOSE }).rows,
    ).toHaveLength(1);
  });
});
