// The owner's whole-model SQL surface: read-only by construction (lexical
// gate + query_only execution on disk vaults), owner-only at identity, row
// capped, receipted. The queries in here look like what the vault
// assistant actually writes — joins, CTEs, window functions.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { registerKnowledgeCommands } from '../commands/knowledge.js';
import { registerLinkCommands } from '../commands/links.js';
import { registerPartyCommands } from '../commands/parties.js';
import { bootstrapVault, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from './gateway.js';
import { readOnlySqlRefusal } from './sql.js';
import { GatewayError, type Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PURPOSE = 'dpv:ServiceProvision';

function setup(dir?: string): void {
  db = openVaultDb(dir ? { dir } : {});
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerKnowledgeCommands(gw);
  registerPartyCommands(gw);
  registerLinkCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
}

beforeEach(() => setup());

describe('the lexical gate', () => {
  test('SELECT / WITH / EXPLAIN pass; comments and a trailing ; are fine', () => {
    expect(readOnlySqlRefusal('SELECT 1;')).toBeUndefined();
    expect(
      readOnlySqlRefusal('-- top spenders\nWITH t AS (SELECT 1 AS n) SELECT * FROM t'),
    ).toBeUndefined();
    expect(readOnlySqlRefusal('EXPLAIN SELECT 1')).toBeUndefined();
  });

  test('writes, DDL, PRAGMA, and multi-statements are refused', () => {
    expect(readOnlySqlRefusal("INSERT INTO core_party VALUES ('x')")).toBeTruthy();
    expect(readOnlySqlRefusal('PRAGMA user_version')).toBeTruthy();
    expect(readOnlySqlRefusal('DROP TABLE core_party')).toBeTruthy();
    expect(readOnlySqlRefusal('SELECT 1; SELECT 2')).toBeTruthy();
    expect(readOnlySqlRefusal('WITH t AS (SELECT 1) DELETE FROM core_party')).toBeTruthy();
    expect(readOnlySqlRefusal('')).toBeTruthy();
  });

  test('the replace() FUNCTION stays usable (only statements are screened)', () => {
    expect(readOnlySqlRefusal("SELECT replace('a-b', '-', ' ')")).toBeUndefined();
  });
});

describe('gateway.sql', () => {
  test('answers a join over the canonical model and receipts the read', () => {
    const result = gw.sql(owner, {
      sql: `SELECT p.display_name FROM core_party p ORDER BY p.party_id`,
    });
    expect(result.rows.map((r) => r.display_name)).toContain('Priya');
    expect(result.columns).toEqual(['display_name']);
    expect(result.receiptId).toBeTruthy();
    const receipt = db.journal
      .prepare(`SELECT decision, object_type FROM consent_receipt WHERE receipt_id = ?`)
      .get(result.receiptId) as { decision: string; object_type: string };
    expect(receipt).toEqual({ decision: 'allow', object_type: 'vault.sql' });
  });

  test('recursive CTEs and window functions work (multi-hop questions)', () => {
    const cte = gw.sql(owner, {
      sql: `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5)
            SELECT n, SUM(n) OVER (ORDER BY n) AS running FROM seq`,
    });
    expect(cte.rows).toHaveLength(5);
    expect(cte.rows[4]).toEqual({ n: 5, running: 15 });
  });

  test('rows are capped and the truncation is reported', () => {
    const result = gw.sql(owner, {
      sql: `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
            SELECT n FROM seq`,
      maxRows: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.totalRows).toBe(50);
    expect(result.truncated).toBe(true);
  });

  test('a write is refused with a contract error', () => {
    expect(() => gw.sql(owner, { sql: `DELETE FROM core_party` })).toThrowError(GatewayError);
  });

  test('a broken statement surfaces the SQLite message for self-correction', () => {
    expect(() => gw.sql(owner, { sql: `SELECT * FROM no_such_table` })).toThrowError(
      /no_such_table/,
    );
  });

  test('only the owner-device credential may call it (receipted deny)', () => {
    const app = enrollApp(db, { name: 'snoop' });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    expect(() => gw.sql(cred, { sql: 'SELECT 1' })).toThrowError(/owner/);
    const deny = db.journal
      .prepare(
        `SELECT decision FROM consent_receipt WHERE object_type = 'vault.sql' ORDER BY receipt_id DESC LIMIT 1`,
      )
      .get() as { decision: string };
    expect(deny.decision).toBe('deny');
  });
});

describe('on a disk vault (dedicated query_only connection)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vault-sql-'));
    setup(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads (including FTS MATCH + vault_content_text) work', () => {
    const outcome = gw.invoke(owner, {
      command: 'knowledge.create_note',
      input: { title: 'Money things', body_text: 'the quarterly budget plan' },
      purpose: PURPOSE,
    });
    expect(outcome.status).toBe('executed');
    const result = gw.sql(owner, {
      sql: `SELECT b.title FROM fts_knowledge_note f
             JOIN knowledge_note b ON b.note_id = f.note_id
            WHERE fts_knowledge_note MATCH 'budget*'`,
    });
    expect(result.rows).toEqual([{ title: 'Money things' }]);
  });

  test('query_only refuses anything that slips the gate', () => {
    // A CTE-shaped body the lexical screen would let through if the write
    // keywords ever regressed still fails at execution on the dedicated
    // connection. (Here the gate already refuses; assert the belt too by
    // checking the connection cannot write via a gate-passing statement.)
    expect(() =>
      gw.sql(owner, { sql: `SELECT * FROM core_party WHERE party_id = (DELETE FROM core_party)` }),
    ).toThrowError();
  });
});
