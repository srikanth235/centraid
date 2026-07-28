import { beforeEach, describe, expect, test } from 'vitest';

import {
  bootstrapVault,
  createGrant,
  enrollApp,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { registerLockerCommands } from '../commands/locker.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { assertNoSealedFtsColumns, type FtsEntitySpec } from '../schema/fts.js';
import {
  SEALED_PLACEHOLDER,
  SEALED_PREFIX,
  isSealedValue,
  sealAad,
  sealValue,
  unsealValue,
  ephemeralSealKey,
} from '../schema/sealed.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PURPOSE = 'dpv:ServiceProvision';
const AEAD_TAG_MISMATCH = 'Unsupported state or unable to authenticate data';

describe('sealed', () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: 'Priya' });
    gw = createGateway(db);
    registerLockerCommands(gw);
    owner = {
      kind: 'device',
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function addLogin(password = 'hunter2-Corr3ct'): string {
    const out = gw.invoke(owner, {
      command: 'locker.add_item',
      input: {
        type: 'login',
        title: 'example.com',
        username: 'priya',
        password,
        url: 'https://example.com',
        otp_seed: 'JBSWY3DPEHPK3PXP',
      },
      purpose: PURPOSE,
    });
    expect(out.status).toBe('executed');
    return (out as { output: { item_id: string } }).output.item_id;
  }

  function appWithScopes(scopes: Parameters<typeof createGrant>[1]['scopes']): Credential {
    const app = enrollApp(db, { name: 'locker-app' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts[PURPOSE] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes,
    });
    return { kind: 'app', appId: app.appId, signingKey: app.signingKey };
  }

  test('sealed values roundtrip; a swapped cell (different AAD) refuses to open', () => {
    const key = ephemeralSealKey();
    const sealed = sealValue(key, sealAad('locker_item', 'password', 'row-1'), 's3cret');
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(unsealValue(key, sealAad('locker_item', 'password', 'row-1'), sealed)).toBe('s3cret');
    expect(() => unsealValue(key, sealAad('locker_item', 'password', 'row-2'), sealed)).toThrow(
      AEAD_TAG_MISMATCH,
    );
    expect(() => unsealValue(key, sealAad('locker_item', 'cvv', 'row-1'), sealed)).toThrow(
      AEAD_TAG_MISMATCH,
    );
  });

  test('secrets are ciphertext in vault.db and placeholders in reads and SQL', () => {
    const itemId = addLogin();
    const raw = db.vault
      .prepare('SELECT password, otp_seed, username FROM locker_item WHERE item_id = ?')
      .get(itemId) as { password: string; otp_seed: string; username: string };
    expect(isSealedValue(raw.password)).toBe(true);
    expect(isSealedValue(raw.otp_seed)).toBe(true);
    expect(raw.username).toBe('priya'); // plain columns stay plain
    const read = gw.read(owner, {
      entity: 'locker.item',
      where: [{ column: 'item_id', op: 'eq', value: itemId }],
      purpose: PURPOSE,
    });
    expect(read.rows[0]?.password).toBe(SEALED_PLACEHOLDER);
    expect(read.rows[0]?.username).toBe('priya');
    const sql = gw.sql(owner, {
      sql: `SELECT password AS pw FROM locker_item WHERE item_id = '${itemId}'`,
    });
    expect(sql.rows[0]?.pw).toBe(SEALED_PLACEHOLDER);
  });

  test('the append-only journal never holds the plaintext secret', () => {
    const password = 'unique-plaintext-9f2k';
    addLogin(password);
    const tables = ['agent_command_invocation', 'consent_receipt', 'consent_provenance'];
    for (const table of tables) {
      const rows = db.journal.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(password);
    }
    const inv = db.journal
      .prepare(
        `SELECT input_json FROM agent_command_invocation ORDER BY invocation_id DESC LIMIT 1`,
      )
      .get() as { input_json: string };
    const input = JSON.parse(inv.input_json) as {
      password: string;
      title: string;
    };
    expect(input.password.startsWith('sealed:sha256:')).toBe(true);
    expect(input.title).toBe('example.com');
  });

  test('the owner reveals; the reveal is receipted per item with column names only', () => {
    const itemId = addLogin('pw-for-reveal');
    const revealed = gw.reveal(owner, {
      entity: 'locker.item',
      entityId: itemId,
      columns: ['password'],
      context: { kind: 'fill', origin: 'https://example.com' },
      purpose: PURPOSE,
    });
    expect(revealed.values.password).toBe('pw-for-reveal');
    const receipt = db.journal
      .prepare(
        'SELECT action, object_type, object_id, decision, detail_json FROM consent_receipt WHERE receipt_id = ?',
      )
      .get(revealed.receiptId) as {
      action: string;
      object_type: string;
      object_id: string;
      decision: string;
      detail_json: string;
    };
    expect(receipt).toMatchObject({
      action: 'reveal',
      object_type: 'locker.item',
      object_id: itemId,
      decision: 'allow',
    });
    expect(receipt.detail_json).not.toContain('pw-for-reveal');
    expect(JSON.parse(receipt.detail_json)).toMatchObject({
      columns: ['password'],
      context: { kind: 'fill', origin: 'https://example.com' },
    });
  });

  test('reveal fill context accepts origins only and receipts malformed attempts', () => {
    const itemId = addLogin();
    expect(() =>
      gw.reveal(owner, {
        entity: 'locker.item',
        entityId: itemId,
        columns: ['password'],
        context: { kind: 'fill', origin: 'https://example.com/login' },
        purpose: PURPOSE,
      }),
    ).toThrow(/absolute HTTP origin/u);
    const denied = db.journal
      .prepare(`SELECT decision, detail_json FROM consent_receipt ORDER BY rowid DESC LIMIT 1`)
      .get() as { decision: string; detail_json: string };
    expect(denied.decision).toBe('deny');
    expect(denied.detail_json).toContain('absolute HTTP origin');
  });

  test('read scope does not reveal; an explicit reveal scope does — clamped by its row filter', () => {
    const itemA = addLogin('secret-A');
    const itemB = addLogin('secret-B');
    const readOnlyApp = appWithScopes([{ schema: 'locker', table: 'item', verbs: 'read' }]);
    expect(() =>
      gw.reveal(readOnlyApp, {
        entity: 'locker.item',
        entityId: itemA,
        purpose: PURPOSE,
      }),
    ).toThrow(/deny/u);

    const revealApp = appWithScopes([
      { schema: 'locker', table: 'item', verbs: 'read' },
      {
        schema: 'locker',
        table: 'item',
        verbs: 'reveal',
        rowFilter: [{ column: 'item_id', op: 'eq', value: itemA }],
      },
    ]);
    const ok = gw.reveal(revealApp, {
      entity: 'locker.item',
      entityId: itemA,
      columns: ['password'],
      purpose: PURPOSE,
    });
    expect(ok.values.password).toBe('secret-A');
    expect(() =>
      gw.reveal(revealApp, {
        entity: 'locker.item',
        entityId: itemB,
        purpose: PURPOSE,
      }),
    ).toThrow(/deny/u);
    const revealOnlyApp = appWithScopes([{ schema: 'locker', table: 'item', verbs: 'reveal' }]);
    expect(() => gw.read(revealOnlyApp, { entity: 'locker.item', purpose: PURPOSE })).toThrow(
      /deny/u,
    );
  });

  test('a readonly device browses placeholders but never reveals', () => {
    const itemId = addLogin();
    const viewer = enrollDevice(db, boot.ownerPartyId, 'kiosk', 'readonly');
    const cred: Credential = {
      kind: 'device',
      deviceId: viewer.deviceId,
      deviceKey: viewer.deviceKey,
    };
    const read = gw.read(cred, {
      entity: 'locker.item',
      where: [{ column: 'item_id', op: 'eq', value: itemId }],
      purpose: PURPOSE,
    });
    expect(read.rows[0]?.password).toBe(SEALED_PLACEHOLDER);
    expect(() =>
      gw.reveal(cred, {
        entity: 'locker.item',
        entityId: itemId,
        purpose: PURPOSE,
      }),
    ).toThrow(/readonly/u);
  });

  test('parked summaries carry hash tokens, not secrets', () => {
    gw.registerCommand({
      name: 'locker.import_secret',
      ownerSchema: 'locker',
      inputSchema: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string' } },
      },
      outputSchema: { type: 'object', properties: {} },
      preconditions: [],
      postconditions: [],
      idempotency: 'once',
      risk: 'high',
      confirm: true,
      sealedInput: ['password'],
      handler: () => ({}),
    });
    const app = enrollApp(db, { name: 'importer', riskCeiling: 'low' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts[PURPOSE] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: 'locker', verbs: 'act' }],
    });
    const parked = gw.invoke(
      { kind: 'app', appId: app.appId, signingKey: app.signingKey },
      {
        command: 'locker.import_secret',
        input: { password: 'park-me-secret' },
        purpose: PURPOSE,
      },
    );
    expect(parked.status).toBe('parked');
    const summary = gw.listParked()[0];
    expect(String(summary?.input.password).startsWith('sealed:sha256:')).toBe(true);
  });

  test('a sealed column can never feed the text index', () => {
    const spec: FtsEntitySpec = {
      entity: 'locker.item',
      idColumn: 'item_id',
      columns: [{ name: 'password', kind: 'column' }],
    };
    expect(() => assertNoSealedFtsColumns(spec)).toThrow(/sealed/u);
    const okSpec: FtsEntitySpec = {
      entity: 'locker.item',
      idColumn: 'item_id',
      columns: [{ name: 'title', kind: 'column' }],
    };
    expect(() => assertNoSealedFtsColumns(okSpec)).not.toThrow();
  });

  test('locker.totp_code returns the 6 digits; the seed never crosses; the unseal is receipted', async () => {
    const { totpAt } = await import('../commands/locker.js');
    expect(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000).code).toBe('287082');

    const itemId = addLogin();
    const before = totpAt('JBSWY3DPEHPK3PXP', Date.now()).code;
    const out = gw.invoke(owner, {
      command: 'locker.totp_code',
      input: { item_id: itemId },
      purpose: PURPOSE,
    });
    const after = totpAt('JBSWY3DPEHPK3PXP', Date.now()).code;
    expect(out.status).toBe('executed');
    const output = (out as { output: { code: string; period: number } }).output;
    expect([before, after]).toContain(output.code);
    expect(output.period).toBe(30);
    const receipt = db.journal
      .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
      .get((out as { receiptId: string }).receiptId) as { detail_json: string };
    expect(JSON.parse(receipt.detail_json).unsealed).toStrictEqual(['locker.item.otp_seed']);
    expect(receipt.detail_json).not.toContain('JBSWY3DPEHPK3PXP');
  });

  test('locker.watchtower derives weak/reused/last4 inside the sealed boundary', () => {
    const weakId = addLogin('abc'); // weak: short, one class
    const reusedA = addLogin('Sam3-Passw0rd!x');
    const reusedB = addLogin('Sam3-Passw0rd!x');
    const cardOut = gw.invoke(owner, {
      command: 'locker.add_item',
      input: {
        type: 'card',
        title: 'Visa',
        card_number: '4111 1111 1111 1234',
        cvv: '321',
      },
      purpose: PURPOSE,
    });
    const cardId = (cardOut as { output: { item_id: string } }).output.item_id;

    const out = gw.invoke(owner, {
      command: 'locker.watchtower',
      input: {},
      purpose: PURPOSE,
    });
    expect(out.status).toBe('executed');
    const items = (
      out as {
        output: {
          items: {
            item_id: string;
            weak: boolean;
            reused: boolean;
            last4?: string;
          }[];
        };
      }
    ).output.items;
    const byId = new Map(items.map((i) => [i.item_id, i]));
    expect(byId.get(weakId)?.weak).toBe(true);
    expect(byId.get(reusedA)?.reused).toBe(true);
    expect(byId.get(reusedB)?.reused).toBe(true);
    expect(byId.get(cardId)?.last4).toBe('1234');
    expect(JSON.stringify(items)).not.toContain('4111');
  });

  test('a round-tripped «sealed» placeholder on edit never overwrites the secret', () => {
    const itemId = addLogin('keep-me-safe');
    const edit = gw.invoke(owner, {
      command: 'locker.edit_item',
      input: {
        item_id: itemId,
        title: 'renamed',
        password: SEALED_PLACEHOLDER,
      },
      purpose: PURPOSE,
    });
    expect(edit.status).toBe('executed');
    const revealed = gw.reveal(owner, {
      entity: 'locker.item',
      entityId: itemId,
      columns: ['password'],
      purpose: PURPOSE,
    });
    expect(revealed.values.password).toBe('keep-me-safe');
  });

  test('ctx.unseal refuses cells a command has not declared', () => {
    gw.registerCommand({
      name: 'locker.rogue_probe',
      ownerSchema: 'locker',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: { item_id: { type: 'string' } },
      },
      outputSchema: { type: 'object', properties: {} },
      preconditions: [],
      postconditions: [],
      idempotency: 'retry-safe',
      risk: 'low',
      unseals: ['locker.item.otp_seed'],
      handler: (ctx) => {
        ctx.unseal('locker.item', String((ctx.input as { item_id: string }).item_id), 'password');
        return {};
      },
    });
    const itemId = addLogin();
    const out = gw.invoke(owner, {
      command: 'locker.rogue_probe',
      input: { item_id: itemId },
      purpose: PURPOSE,
    });
    expect(out.status).toBe('failed');
    expect((out as { reason: string }).reason).toMatch(/does not declare unseal/u);
  });

  test('a password CSV stages sealed, publishes sealed, and reveals correctly', () => {
    const csv = [
      'name,url,username,password,totp,note',
      'GitHub,https://github.com,priya,gh-s3cret-!x,JBSWY3DPEHPK3PXP,work',
      'Bank,https://bank.example,priya@hey.com,b4nk-p4ss,,',
    ].join('\n');
    const staged = gw.stageImportFile(owner, {
      filename: 'bitwarden-export.csv',
      data: csv,
    });
    expect(staged.total).toBe(2);
    expect(staged.staged.create).toBe(2);
    const drafts = db.vault.prepare('SELECT payload_json FROM sync_import_row').all() as {
      payload_json: string;
    }[];
    for (const d of drafts) {
      expect(d.payload_json).not.toContain('gh-s3cret-!x');
      expect(d.payload_json).not.toContain('b4nk-p4ss');
      expect(d.payload_json).not.toContain('JBSWY3DPEHPK3PXP');
    }
    const payload = JSON.parse(drafts[0]!.payload_json) as {
      password: string;
      title: string;
    };
    expect(isSealedValue(payload.password)).toBe(true);
    expect(payload.title).toBe('GitHub'); // plain fields stay reviewable

    const published = gw.publishImport(owner, staged.batchId);
    expect(published.created).toBe(2);
    expect(published.failed).toStrictEqual([]);
    const item = db.vault
      .prepare(`SELECT item_id, password FROM locker_item WHERE title = 'GitHub'`)
      .get() as { item_id: string; password: string };
    expect(isSealedValue(item.password)).toBe(true);
    const revealed = gw.reveal(owner, {
      entity: 'locker.item',
      entityId: item.item_id,
      columns: ['password', 'otp_seed'],
      purpose: PURPOSE,
    });
    expect(revealed.values.password).toBe('gh-s3cret-!x');
    expect(revealed.values.otp_seed).toBe('JBSWY3DPEHPK3PXP');

    const stagedRows = db.vault
      .prepare('SELECT payload_json FROM sync_import_row WHERE published_entity_id IS NOT NULL')
      .all() as { payload_json: string }[];
    expect(stagedRows.length).toBeGreaterThan(0);
    for (const r of stagedRows) {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      expect('password' in p).toBe(false);
      expect('otpSeed' in p).toBe(false);
      expect(p.title).toBeDefined(); // provenance survives
    }

    const again = gw.stageImportFile(owner, {
      filename: 'bitwarden-export.csv',
      data: csv,
    });
    expect(again.staged.skip).toBe(2);
  });

  test('a bank CSV still routes to transactions — content routing, not luck', () => {
    const csv = ['date,description,amount', '2026-07-01,Coffee,-4.50'].join('\n');
    const staged = gw.stageImportFile(owner, {
      filename: 'statement.csv',
      data: csv,
    });
    expect(staged.total).toBe(1);
    const row = db.vault
      .prepare('SELECT entity_type FROM sync_import_row ORDER BY row_id DESC LIMIT 1')
      .get() as { entity_type: string };
    expect(row.entity_type).toBe('core.transaction');
  });
});
