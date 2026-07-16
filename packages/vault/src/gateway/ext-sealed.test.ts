// Ext-band sealed columns (issue #298 item 9): a blueprint app that declares
// `sealed: [...]` on its own ext.tables gets the full Locker treatment —
// ciphertext at rest via the seal sweep, placeholder in default reads,
// plaintext only under the reveal verb, hash tokens in the journal, and a
// hard refusal to make a sealed column searchable.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, type Gateway } from './gateway.js';
import { applyExtBand, extCommandDefinitions, seedExtDraft } from './ext.js';
import { resealVaultKey } from './reseal.js';
import { ExtSpecError, type ExtTableSpec } from '../schema/ext.js';
import { isSealedValue, readSealKeyFingerprint } from '../schema/sealed.js';
import type { Credential } from './types.js';

const APP = 'keypass';
const PURPOSE = 'dpv:ServiceProvision';

let db: VaultDb;
let boot: BootstrapResult;
let gw: Gateway;
let owner: Credential;

const CRED_TABLE: ExtTableSpec = {
  name: 'credential',
  columns: [
    { name: 'credential_id', type: 'text', primaryKey: true },
    { name: 'label', type: 'text', notNull: true },
    { name: 'api_key', type: 'text' },
  ],
  searchable: ['label'],
  sealed: ['api_key'],
};

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function installApp(spec: ExtTableSpec = CRED_TABLE): void {
  applyExtBand(db, APP, [spec], 'live');
  for (const def of extCommandDefinitions(APP)) gw.registerCommand(def);
}

function addCredential(apiKey = 'ghp_secret_TOKEN_123'): string {
  const out = gw.invoke(owner, {
    command: `ext.${APP}.insert`,
    input: { table: 'credential', values: { label: 'GitHub', api_key: apiKey } },
    purpose: PURPOSE,
  });
  expect(out.status).toBe('executed');
  return (out as { output: { id: string } }).output.id;
}

// ── declaration validation ──────────────────────────────────────────────

test('a sealed column that is also searchable is refused at declaration', () => {
  expect(() =>
    applyExtBand(
      db,
      APP,
      [{ ...CRED_TABLE, searchable: ['label', 'api_key'], sealed: ['api_key'] }],
      'live',
    ),
  ).toThrow(ExtSpecError);
});

test('a sealed non-text column is refused', () => {
  const spec: ExtTableSpec = {
    name: 'credential',
    columns: [
      { name: 'credential_id', type: 'text', primaryKey: true },
      { name: 'secret_num', type: 'integer' },
    ],
    sealed: ['secret_num'],
  };
  expect(() => applyExtBand(db, APP, [spec], 'live')).toThrow(/must be text/);
});

// ── the six enforcement points ──────────────────────────────────────────

test('a declared ext secret is ciphertext at rest', () => {
  installApp();
  const id = addCredential();
  const raw = db.vault
    .prepare('SELECT api_key, label FROM ext_keypass_credential WHERE credential_id = ?')
    .get(id) as { api_key: string; label: string };
  expect(isSealedValue(raw.api_key)).toBe(true);
  expect(raw.label).toBe('GitHub'); // unsealed column stays plain + searchable
});

test('a default read shows the placeholder, not the ciphertext', () => {
  installApp();
  addCredential();
  const app = enrollApp(db, { name: 'reader' });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts[PURPOSE] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: `ext.${APP}`, table: 'credential', verbs: 'read' }],
  });
  const reader: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
  const res = gw.read(reader, { entity: `ext.${APP}.credential`, purpose: PURPOSE });
  expect(res.rows[0]?.['api_key']).toBe('«sealed»');
  expect(res.rows[0]?.['label']).toBe('GitHub');
});

test('the owner reveals the ext secret under the reveal verb', () => {
  installApp();
  const id = addCredential('ghp_reveal_me');
  const out = gw.reveal(owner, {
    entity: `ext.${APP}.credential`,
    entityId: id,
    columns: ['api_key'],
    purpose: PURPOSE,
  });
  expect(out.values['api_key']).toBe('ghp_reveal_me');
});

test('the journal holds a hash token for the nested ext secret, never the value', () => {
  installApp();
  const secret = 'ghp_never_in_journal';
  addCredential(secret);
  const rows = db.journal.prepare('SELECT input_json FROM agent_command_invocation').all() as {
    input_json: string;
  }[];
  const all = rows.map((r) => r.input_json).join('\n');
  expect(all).not.toContain(secret);
  expect(all).toContain('sealed:sha256:'); // redacted, not dropped
});

test('a read scope cannot reveal an ext secret — the reveal verb is separate', () => {
  installApp();
  const id = addCredential();
  const app = enrollApp(db, { name: 'reader' });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts[PURPOSE] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: `ext.${APP}`, table: 'credential', verbs: 'read' }],
  });
  const reader: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
  expect(() =>
    gw.reveal(reader, {
      entity: `ext.${APP}.credential`,
      entityId: id,
      columns: ['api_key'],
      purpose: PURPOSE,
    }),
  ).toThrow();
});

// ── retro-seal + rotation ───────────────────────────────────────────────

test('declaring sealed on an already-populated column seals the existing rows', () => {
  // Install WITHOUT sealing, write plaintext, then declare it sealed.
  installApp({ ...CRED_TABLE, sealed: [] });
  const id = addCredential('plaintext_at_first');
  db.vault
    .prepare('UPDATE ext_keypass_credential SET label = ? WHERE credential_id = ?')
    .run('Updated before sealing', id);
  expect(
    db.vault
      .prepare(
        `SELECT old_values_json FROM replica_change
          WHERE entity = ? AND old_values_json LIKE '%plaintext_at_first%'`,
      )
      .get(`ext.${APP}.credential`),
  ).toBeDefined();
  let raw = db.vault
    .prepare('SELECT api_key FROM ext_keypass_credential WHERE credential_id = ?')
    .get(id) as { api_key: string };
  expect(isSealedValue(raw.api_key)).toBe(false);
  applyExtBand(db, APP, [CRED_TABLE], 'live'); // now sealed
  raw = db.vault
    .prepare('SELECT api_key FROM ext_keypass_credential WHERE credential_id = ?')
    .get(id) as { api_key: string };
  expect(isSealedValue(raw.api_key)).toBe(true);
  expect(
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM replica_change
          WHERE entity = ? AND json_extract(old_values_json, '$.api_key') IS NOT NULL`,
      )
      .get(`ext.${APP}.credential`),
  ).toEqual({ n: 0 });
  expect(readSealKeyFingerprint(db.vault)).not.toBeNull();
  // and it still reveals to the original plaintext
  const out = gw.reveal(owner, {
    entity: `ext.${APP}.credential`,
    entityId: id,
    columns: ['api_key'],
    purpose: PURPOSE,
  });
  expect(out.values['api_key']).toBe('plaintext_at_first');
});

test('reseal rotates ext sealed cells alongside canonical ones', () => {
  installApp();
  const id = addCredential('rotate_this_key');
  const result = resealVaultKey(db);
  expect(result.resealedCells).toBeGreaterThanOrEqual(1);
  const out = gw.reveal(owner, {
    entity: `ext.${APP}.credential`,
    entityId: id,
    columns: ['api_key'],
    purpose: PURPOSE,
  });
  expect(out.values['api_key']).toBe('rotate_this_key');
});

test('draft-band writes seal too', () => {
  installApp();
  seedExtDraft(db, APP, [CRED_TABLE]);
  const out = gw.invoke(owner, {
    command: `ext.${APP}.insert`,
    input: {
      table: 'credential',
      values: { label: 'Draft', api_key: 'draft_secret' },
      band: 'draft',
    },
    purpose: PURPOSE,
  });
  expect(out.status).toBe('executed');
  const id = (out as { output: { id: string } }).output.id;
  const raw = db.vault
    .prepare('SELECT api_key FROM extdraft_keypass_credential WHERE credential_id = ?')
    .get(id) as { api_key: string };
  expect(isSealedValue(raw.api_key)).toBe(true);
});
