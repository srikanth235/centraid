import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from './db.js';
import { createGateway } from './gateway/gateway.js';
import { createGrant } from './bootstrap.js';
import {
  ensureAppEnrolled,
  ensureVaultBootstrapped,
  listActiveGrants,
  lookupAppByName,
  purposeConceptId,
} from './host.js';

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
