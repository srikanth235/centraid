/*
 * Device enrollment + pairing tickets (issue #289 phase 2).
 *
 * The enrollment store is the whole ACL (device key ↔ vault, one bit) and
 * the ticket store is the SSH-bootstrap ceremony; both are cross-process
 * files (admin CLI writes, daemon reads), so reload-on-mtime and
 * burn-on-first-attempt are the load-bearing behaviors.
 */

import { afterEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EnrollmentStore } from './enrollment-store.js';
import { PairingTicketStore, encodePairingTicket, parsePairingTicket } from './pairing-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `device-plane-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('enrollment: multi-vault = multiple rows; revoke by row or by key', async () => {
  const file = await tempFile('devices.json');
  const store = EnrollmentStore.open(file);

  const laptop1 = store.enroll({ endpointId: 'ep-laptop', vaultId: 'v1', label: 'laptop' });
  store.enroll({ endpointId: 'ep-laptop', vaultId: 'v2', label: 'laptop' });
  store.enroll({ endpointId: 'ep-phone', vaultId: 'v2', label: 'phone', platform: 'android' });

  expect(store.vaultsFor('ep-laptop')).toEqual(['v1', 'v2']);
  expect(store.vaultsFor('ep-phone')).toEqual(['v2']);
  expect(
    store
      .listByVault('v2')
      .map((e) => e.endpointId)
      .sort(),
  ).toEqual(['ep-laptop', 'ep-phone']);
  expect(store.isEnrolled('ep-nobody')).toBe(false);

  // Re-enrolling the same (key, vault) refreshes, never duplicates.
  store.enroll({ endpointId: 'ep-laptop', vaultId: 'v1', label: 'renamed laptop' });
  expect(store.vaultsFor('ep-laptop')).toEqual(['v1', 'v2']);
  expect(store.list().find((e) => e.enrollmentId === laptop1.enrollmentId)?.label).toBe(
    'renamed laptop',
  );

  // Revoke one row: the other vault survives.
  store.revoke(laptop1.enrollmentId);
  expect(store.vaultsFor('ep-laptop')).toEqual(['v2']);

  // Revoke by key ("lost laptop"): every row dies.
  store.enroll({ endpointId: 'ep-laptop', vaultId: 'v1', label: 'laptop' });
  const removed = store.revoke('ep-laptop');
  expect(removed).toHaveLength(2);
  expect(store.isEnrolled('ep-laptop')).toBe(false);
});

test("enrollment: a second process's writes are visible without restart", async () => {
  const file = await tempFile('devices.json');
  const daemon = EnrollmentStore.open(file);
  expect(daemon.isEnrolled('ep-new')).toBe(false);

  // The admin CLI (separate process = separate store instance) enrolls.
  const cli = EnrollmentStore.open(file);
  cli.enroll({ endpointId: 'ep-new', vaultId: 'v1', label: 'new device' });

  // Force a distinct mtime (fs timestamps can be coarse), then re-read.
  const future = new Date(Date.now() + 2000);
  await fs.utimes(file, future, future);
  expect(daemon.vaultsFor('ep-new')).toEqual(['v1']);
});

test('pairing tickets: one-time, secret-checked, TTL-bound', async () => {
  const file = await tempFile('pairing-tickets.json');
  const store = PairingTicketStore.open(file);

  const minted = store.mint('v1');
  expect(store.listActive()).toHaveLength(1);

  // Wrong secret burns the ticket — the right secret is now useless too.
  expect(store.redeem(minted.ticketId, 'guessed')).toBeUndefined();
  expect(store.redeem(minted.ticketId, minted.secret)).toBeUndefined();

  const second = store.mint('v2');
  expect(store.redeem(second.ticketId, second.secret)).toEqual({ vaultId: 'v2' });
  // …and it burned on success.
  expect(store.redeem(second.ticketId, second.secret)).toBeUndefined();

  // Expiry: a stale ticket never redeems.
  const brief = store.mint('v3', 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(store.redeem(brief.ticketId, brief.secret)).toBeUndefined();
});

test('the pasteable ticket round-trips and rejects foreign payloads', () => {
  const token = encodePairingTicket({
    v: 1,
    kind: 'centraid-gw-pair',
    gw: 'endpoint-ticket-base32',
    t: 'ticket-id',
    s: 'secret',
    vaultName: 'Family',
    exp: 123,
  });
  expect(parsePairingTicket(token)).toMatchObject({ t: 'ticket-id', vaultName: 'Family' });
  expect(parsePairingTicket('not-a-ticket')).toBeUndefined();
  expect(
    parsePairingTicket(
      Buffer.from(JSON.stringify({ v: 1, kind: 'centraid-pair' })).toString('base64url'),
    ),
  ).toBeUndefined();
});
