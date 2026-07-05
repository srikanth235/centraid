// Tests for the §10 responsibilities closed after the first pass: polymorphic
// ref validation (S4), contract version check (S3), retention policy sweeps,
// the view service, and file custody.

import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { uuidv7 } from '../ids.js';
import { createGateway, Gateway } from './gateway.js';
import type { CommandDefinition, Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

/** A scratch command that tags an arbitrary (type, id) pair. */
function registerTagCommand(): void {
  const def: CommandDefinition = {
    name: 'test.tag_anything',
    ownerSchema: 'finance',
    inputSchema: {
      type: 'object',
      required: ['target_type', 'target_id'],
      properties: { target_type: { type: 'string' }, target_id: { type: 'string' } },
    },
    outputSchema: { type: 'object', properties: {} },
    preconditions: [],
    postconditions: [],
    idempotency: 'retry-safe',
    risk: 'low',
    handler: (ctx) => {
      const input = ctx.input as { target_type: string; target_id: string };
      const tagId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          tagId,
          input.target_type,
          input.target_id,
          boot.concepts['anomaly'] as string,
          ctx.now,
        );
      ctx.wrote('core.tag', tagId);
      return { tag_id: tagId };
    },
  };
  gw.registerCommand(def);
}

test('S4 polymorphic validation: a tag pointing at a dead row rolls the command back', () => {
  registerTagCommand();
  const outcome = gw.invoke(owner, {
    command: 'test.tag_anything',
    input: { target_type: 'core.transaction', target_id: 'no-such-txn' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed')
    expect(outcome.reason).toContain('does not resolve to a live row');
  const tags = db.vault.prepare('SELECT count(*) AS n FROM core_tag').get() as { n: number };
  expect(tags.n).toBe(0);
});

test('S4 polymorphic validation: unknown entity name in the type column also rolls back', () => {
  registerTagCommand();
  const outcome = gw.invoke(owner, {
    command: 'test.tag_anything',
    input: { target_type: 'evil.table', target_id: 'x' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.reason).toContain('unknown entity');
});

test('S4 polymorphic validation: a live target passes', () => {
  registerTagCommand();
  const outcome = gw.invoke(owner, {
    command: 'test.tag_anything',
    input: { target_type: 'core.party', target_id: boot.ownerPartyId },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
});

test('S3 version brokering: a command registered against another ontology version is refused', () => {
  registerTagCommand();
  db.vault
    .prepare(`UPDATE agent_command SET ontology_version = '0.9' WHERE name = 'test.tag_anything'`)
    .run();
  const outcome = gw.invoke(owner, {
    command: 'test.tag_anything',
    input: { target_type: 'core.party', target_id: boot.ownerPartyId },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed')
    expect(outcome.reason).toContain('contract version 0.9 not served');
});

test('retention policy: sweep deletes rows past the window using the policy timestamp column', () => {
  const now = new Date().toISOString();
  db.vault
    .prepare(`INSERT INTO social_thread (thread_id, channel, created_at) VALUES ('th1', 'sms', ?)`)
    .run(now);
  const mkContent = (id: string, sha: string) =>
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'text/plain', 'file:///x', ?, 1, ?)`,
      )
      .run(id, sha, now);
  mkContent('c1', 'sha-old');
  mkContent('c2', 'sha-new');
  db.vault
    .prepare(
      `INSERT INTO social_message (message_id, thread_id, sender_handle, sent_at, body_content_id, delivery)
       VALUES ('m-old', 'th1', 'x@y.z', '2020-01-01T00:00:00Z', 'c1', 'read')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO social_message (message_id, thread_id, sender_handle, sent_at, body_content_id, delivery)
       VALUES ('m-new', 'th1', 'x@y.z', ?, 'c2', 'read')`,
    )
    .run(now);
  db.vault
    .prepare(
      `INSERT INTO consent_policy (policy_id, kind, applies_schema, applies_table, rule_json, retention_days, effective_from, priority)
       VALUES (?, 'retention', 'social', 'message', '{"timestamp_column":"sent_at"}', 365, '2020-01-01T00:00:00Z', 1)`,
    )
    .run(uuidv7());
  const result = gw.sweep(owner);
  expect(result.retentionDeleted).toBe(1);
  const remaining = db.vault.prepare('SELECT message_id FROM social_message').all();
  expect(remaining).toEqual([{ message_id: 'm-new' }]);
});

function calendarAppWithEvent(): { cred: Credential; appId: string } {
  const app = enrollApp(db, { name: 'agenda-widget', origin: 'generated' });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      {
        schema: 'core',
        table: 'event',
        verbs: 'read',
        fieldMask: ['event_id', 'summary', 'dtstart', 'location_place_id'],
      },
    ],
  });
  const placeId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_place (place_id, name, kind, created_at) VALUES (?, 'Clinic', 'venue', ?)`,
    )
    .run(placeId, new Date().toISOString());
  db.vault
    .prepare(
      `INSERT INTO core_event (event_id, summary, description, dtstart, status, location_place_id, sequence, created_at, updated_at)
       VALUES (?, 'Cardiology', 'secret notes', '2026-07-09T10:30:00Z', 'confirmed', ?, 0, ?, ?)`,
    )
    .run(uuidv7(), placeId, new Date().toISOString(), new Date().toISOString());
  return { cred: { kind: 'app', appId: app.appId, signingKey: app.signingKey }, appId: app.appId };
}

test('view service: registration proves joins follow declared FKs', () => {
  const { cred } = calendarAppWithEvent();
  expect(() =>
    gw.registerView(cred, {
      name: 'agenda',
      baseEntity: 'core.event',
      definition: {
        columns: ['event_id', 'summary'],
        joins: [{ entity: 'core.place', fk_column: 'summary', columns: ['name'] }], // not an FK
      },
    }),
  ).toThrow(/not a declared FK/);
  const viewId = gw.registerView(cred, {
    name: 'agenda',
    baseEntity: 'core.event',
    definition: {
      columns: ['event_id', 'summary', 'dtstart', 'description'],
      where: [{ column: 'status', op: 'eq', value: 'confirmed' }],
      joins: [{ entity: 'core.place', fk_column: 'location_place_id', columns: ['name'] }],
    },
  });
  expect(viewId).toBeTruthy();
});

test('view service: execution clamps to grant scopes — mask trims columns, join needs consent', () => {
  const { cred, appId } = calendarAppWithEvent();
  gw.registerView(cred, {
    name: 'agenda',
    baseEntity: 'core.event',
    definition: {
      columns: ['event_id', 'summary', 'description'], // description exceeds the field mask
      joins: [{ entity: 'core.place', fk_column: 'location_place_id', columns: ['name'] }],
    },
  });
  // The grant covers core.event only — the join to core.place must deny.
  expect(() => gw.queryView(cred, 'agenda', 'dpv:ServiceProvision')).toThrow(/join core.place/);
  // Widen the grant to the place table; now it executes, but the field mask
  // still strips `description` — the view cannot over-read.
  createGrant(db, {
    appId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'core', table: 'place', verbs: 'read', fieldMask: ['place_id', 'name'] }],
  });
  const result = gw.queryView(cred, 'agenda', 'dpv:ServiceProvision');
  expect(result.rows).toHaveLength(1);
  expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(['event_id', 'place_name', 'summary']);
  expect(result.rows[0]).toMatchObject({ summary: 'Cardiology', place_name: 'Clinic' });
  // Both the deny and the allow left receipts (same-ms UUIDv7s, so no order).
  const receipts = db.journal
    .prepare(
      `SELECT decision FROM consent_receipt WHERE action = 'read view:agenda' ORDER BY decision`,
    )
    .all();
  expect(receipts).toEqual([{ decision: 'allow' }, { decision: 'deny' }]);
});

// ---- file custody (needs a file-backed vault) ----

let custodyDir: string;
let fileDb: VaultDb | null = null;

afterEach(async () => {
  fileDb?.close();
  fileDb = null;
  if (custodyDir) await fs.rm(custodyDir, { recursive: true, force: true });
  custodyDir = '';
});

async function fileBackedVault(): Promise<{ gw2: Gateway; owner2: Credential }> {
  custodyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-custody-'));
  fileDb = openVaultDb({ dir: custodyDir });
  const boot2 = bootstrapVault(fileDb, { ownerName: 'Priya' });
  const gw2 = createGateway(fileDb);
  return { gw2, owner2: { kind: 'device', deviceId: boot2.deviceId, deviceKey: boot2.deviceKey } };
}

test('file custody: checkpoint, verifiable backup; ext band retained through revocation', async () => {
  const { gw2, owner2 } = await fileBackedVault();
  expect(gw2.checkpoint(owner2)).toEqual({ vault: 'truncated', journal: 'truncated' });

  const backupDir = path.join(custodyDir, 'backups');
  await fs.mkdir(backupDir);
  const backup = gw2.backup(owner2, backupDir);
  expect(existsSync(backup.vaultPath)).toBe(true);
  expect(existsSync(backup.journalPath)).toBe(true);
  expect(backup.vaultSha256).toMatch(/^[0-9a-f]{64}$/);

  // ext band: applied for the app, RETAINED (not dropped) when its last
  // grant is revoked — the data is the owner's; purging is a separate act.
  if (!fileDb) throw new Error('vault gone');
  const app = enrollApp(fileDb, { name: 'gen-app', origin: 'generated' });
  const bootRow = fileDb.vault.prepare('SELECT owner_party_id FROM core_vault').get() as {
    owner_party_id: string;
  };
  const purpose = fileDb.vault
    .prepare(`SELECT concept_id FROM core_concept WHERE notation = 'dpv:ServiceProvision'`)
    .get() as { concept_id: string };
  const grantId = createGrant(fileDb, {
    appId: app.appId,
    purposeConceptId: purpose.concept_id,
    grantedByPartyId: bootRow.owner_party_id,
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });
  gw2.applyAppExt(owner2, 'gen-app', [
    {
      name: 'scratch',
      columns: [{ name: 'scratch_id', type: 'text', primaryKey: true }],
    },
  ]);
  const revocation = gw2.revokeGrant(owner2, grantId);
  expect(revocation.extRetained).toEqual(['scratch']);
  const row = fileDb.vault
    .prepare(`SELECT status FROM consent_app_ext WHERE app_id = 'gen-app' AND table_name = 'scratch'`)
    .get() as { status: string };
  expect(row.status).toBe('retained'); // table + rows survive uninstall
});

test('file custody refuses in-memory vaults', () => {
  expect(() => gw.checkpoint(owner)).toThrow(/file-backed/);
});
