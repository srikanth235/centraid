import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from './db.js';
import { createGateway } from './gateway/gateway.js';
import { createGrant } from './bootstrap.js';
import {
  ensureAgentEnrolled,
  ensureAppEnrolled,
  ensureVaultBootstrapped,
  listActiveAgentGrants,
  listActiveGrants,
  listEnrolledAgents,
  lookupAgentByName,
  lookupAppByName,
  markAgentRevoked,
  purposeConceptId,
} from './host.js';
import { registerTaskCommands } from './commands/tasks.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-host-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ensureVaultBootstrapped: first boot creates, second boot recovers the same identity', () => {
  const dir = tempDir();
  const first = openVaultDb({ dir });
  const boot1 = ensureVaultBootstrapped(first, { ownerName: 'Priya' });
  expect(boot1.fresh).toBe(true);
  first.close();

  const second = openVaultDb({ dir });
  cleanups.push(() => second.close());
  const boot2 = ensureVaultBootstrapped(second, { ownerName: 'ignored on recovery' });
  expect(boot2.fresh).toBe(false);
  expect(boot2.vaultId).toBe(boot1.vaultId);
  expect(boot2.ownerPartyId).toBe(boot1.ownerPartyId);
  expect(boot2.deviceId).toBe(boot1.deviceId);
  expect(boot2.deviceKey).toBe(boot1.deviceKey);
  expect(boot2.concepts['dpv:ServiceProvision']).toBe(boot1.concepts['dpv:ServiceProvision']);
  // The recovered credential authenticates: an owner read succeeds.
  const gw = createGateway(second);
  const cred = { kind: 'device', deviceId: boot2.deviceId, deviceKey: boot2.deviceKey } as const;
  const result = gw.read(cred, { entity: 'core.party', purpose: 'dpv:ServiceProvision' });
  expect(result.rows.length).toBeGreaterThan(0);
});

test('ensureAppEnrolled is idempotent per host-side name', () => {
  const db: VaultDb = openVaultDb();
  cleanups.push(() => db.close());
  ensureVaultBootstrapped(db, { ownerName: 'Priya' });
  const first = ensureAppEnrolled(db, 'expense-tracker');
  expect(first.created).toBe(true);
  const again = ensureAppEnrolled(db, 'expense-tracker');
  expect(again.created).toBe(false);
  expect(again.appId).toBe(first.appId);
  expect(again.signingKey).toBe(first.signingKey);
  expect(lookupAppByName(db, 'expense-tracker')?.appId).toBe(first.appId);
  expect(lookupAppByName(db, 'never-registered')).toBeUndefined();
});

test('listActiveGrants surfaces purpose notation and scopes', () => {
  const db = openVaultDb();
  cleanups.push(() => db.close());
  const boot = ensureVaultBootstrapped(db, { ownerName: 'Priya' });
  const app = ensureAppEnrolled(db, 'calendar');
  expect(listActiveGrants(db, app.appId)).toEqual([]);
  const purpose = purposeConceptId(db, 'dpv:ServiceProvision');
  expect(purpose).toBe(boot.concepts['dpv:ServiceProvision']);
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: purpose as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: 'schedule', verbs: 'read+act' },
      { schema: 'core', table: 'event', verbs: 'read' },
    ],
  });
  const grants = listActiveGrants(db, app.appId);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ purpose: 'dpv:ServiceProvision', expiresAt: null });
  expect(grants[0]?.scopes).toEqual([
    { schema: 'schedule', table: null, verbs: 'read+act' },
    { schema: 'core', table: 'event', verbs: 'read' },
  ]);
});

test('ensureAgentEnrolled is idempotent per host-side name; grants match on the agent party', () => {
  const db = openVaultDb();
  cleanups.push(() => db.close());
  const boot = ensureVaultBootstrapped(db, { ownerName: 'Priya' });
  const gw = createGateway(db);
  registerTaskCommands(gw);

  const first = ensureAgentEnrolled(db, 'briefing');
  expect(first.created).toBe(true);
  const again = ensureAgentEnrolled(db, 'briefing');
  expect(again.created).toBe(false);
  expect(again.agentId).toBe(first.agentId);
  expect(again.partyId).toBe(first.partyId);
  expect(lookupAgentByName(db, 'briefing')?.agentId).toBe(first.agentId);
  expect(lookupAgentByName(db, 'never-enrolled')).toBeUndefined();

  // Deny-by-default: the enrolled agent reads nothing until a grant lands.
  const cred = {
    kind: 'agent',
    agentId: first.agentId,
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  } as const;
  expect(() =>
    gw.read(cred, { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' }),
  ).toThrow(/deny/);

  createGrant(db, {
    granteePartyId: first.partyId,
    purposeConceptId: purposeConceptId(db, 'dpv:ServiceProvision') as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const grants = listActiveAgentGrants(db, first.partyId);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ purpose: 'dpv:ServiceProvision' });

  // The grant covers reads AND typed commands under the schedule schema.
  const read = gw.read(cred, { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' });
  expect(read.rows).toEqual([]);
  const outcome = gw.invoke(cred, {
    command: 'schedule.add_task',
    input: { title: 'water the plants' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');

  // Retiring the enrollment drops authentication entirely.
  markAgentRevoked(db, first.agentId);
  expect(lookupAgentByName(db, 'briefing')).toBeUndefined();
  expect(() =>
    gw.read(cred, { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' }),
  ).toThrow(/unknown caller/);
  expect(listEnrolledAgents(db).find((a) => a.agentId === first.agentId)).toBeUndefined();
});
