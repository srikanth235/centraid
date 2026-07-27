import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Device enrollment + pairing tickets (issue #289 phase 2).
 *
 * The enrollment store is the whole ACL (device key ↔ vault, one bit) and
 * the ticket store is the SSH-bootstrap ceremony; both are cross-process
 * gateway.db rows (admin CLI and daemon share one control plane), so
 * cross-handle visibility and burn-on-first-attempt are load-bearing.
 */

import { afterEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EnrollmentStore } from './enrollment-store.js';
import { PairingTicketStore, encodePairingTicket, parsePairingTicket } from './pairing-store.js';
import { GatewayDatabase } from './gateway-db.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempFile(name: string): Promise<string> {
  const dir = await tempDir(`device-plane-${crypto.randomUUID()}-`);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('enrollment: multi-vault = multiple rows; revoke by row or by key', async () => {
  const file = await tempFile('gateway.db');
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
  const file = await tempFile('gateway.db');
  const daemon = EnrollmentStore.open(file, { statTtlMs: 0 });
  expect(daemon.isEnrolled('ep-new')).toBe(false);

  // The admin CLI (separate process = separate store instance) enrolls.
  const cli = EnrollmentStore.open(file);
  cli.enroll({ endpointId: 'ep-new', vaultId: 'v1', label: 'new device' });

  expect(daemon.vaultsFor('ep-new')).toEqual(['v1']);
  expect((await fs.stat(file)).isFile()).toBe(true);
});

test('enrollment: replica checkpoints only advance within their bootstrap epoch', async () => {
  const file = await tempFile('gateway.db');
  const store = EnrollmentStore.open(file);
  store.enroll({
    endpointId: 'ep-device',
    vaultId: 'v1',
    label: 'laptop',
    rememberDevice: true,
  });

  const boot = store.resetCheckpoint('ep-device', 'v1', {
    epoch: 'epoch-a',
    seq: 7,
    schemaEpoch: 2,
  });
  expect(boot).toMatchObject({ epoch: 'epoch-a', seq: 7, schemaEpoch: 2 });
  expect(
    store.advanceCheckpoint('ep-device', 'v1', {
      epoch: 'epoch-a',
      seq: 9,
      schemaEpoch: 2,
    }),
  ).toMatchObject({ seq: 9 });
  expect(() =>
    store.advanceCheckpoint('ep-device', 'v1', {
      epoch: 'epoch-a',
      seq: 8,
      schemaEpoch: 2,
    }),
  ).toThrow(/monotonically/);
  expect(() =>
    store.advanceCheckpoint('ep-device', 'v1', {
      epoch: 'epoch-b',
      seq: 10,
      schemaEpoch: 2,
    }),
  ).toThrow(/rebootstrap/);

  const reopened = EnrollmentStore.open(file);
  expect(reopened.get('ep-device', 'v1')?.checkpoint).toMatchObject({
    epoch: 'epoch-a',
    seq: 9,
  });
});

test('enrollment: a stale daemon checkpoint cannot resurrect a CLI revocation', async () => {
  const file = await tempFile('gateway.db');
  const daemon = EnrollmentStore.open(file);
  const row = daemon.enroll({
    endpointId: 'ep-lost',
    vaultId: 'v1',
    label: 'lost laptop',
    rememberDevice: true,
  });
  daemon.resetCheckpoint('ep-lost', 'v1', {
    epoch: 'epoch-a',
    seq: 4,
    schemaEpoch: 2,
  });

  const cli = EnrollmentStore.open(file);
  expect(cli.revoke(row.enrollmentId)).toHaveLength(1);
  expect(() =>
    daemon.advanceCheckpoint('ep-lost', 'v1', {
      epoch: 'epoch-a',
      seq: 5,
      schemaEpoch: 2,
    }),
  ).toThrow(/not enrolled/);
  expect(EnrollmentStore.open(file).get('ep-lost', 'v1')).toBeUndefined();
  await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('enrollment: gateway.db replaces the old lock directory', async () => {
  const file = await tempFile('gateway.db');
  const store = EnrollmentStore.open(file);
  store.enroll({ endpointId: 'device', vaultId: 'v1', label: 'Laptop' });
  await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(path.basename(store.gatewayDatabase.file)).toBe('gateway.db');
});

test('enrollment: remember, trust, and Companion grants persist across re-pair', async () => {
  const file = await tempFile('gateway.db');
  const store = EnrollmentStore.open(file);
  store.enroll({
    endpointId: 'ep-session',
    vaultId: 'v1',
    label: 'borrowed tablet',
    trust: 'readonly',
    rememberDevice: false,
    grantProfile: ['locker', 'notes'],
  });
  expect(EnrollmentStore.open(file).get('ep-session', 'v1')).toMatchObject({
    trust: 'readonly',
    rememberDevice: false,
    grantProfile: ['locker', 'notes'],
  });
  store.enroll({
    endpointId: 'ep-session',
    vaultId: 'v1',
    label: 'borrowed tablet',
    grantProfile: ['tasks'],
  });
  expect(EnrollmentStore.open(file).get('ep-session', 'v1')?.grantProfile).toEqual(['tasks']);
  expect(
    store.enroll({ endpointId: 'ep-default', vaultId: 'v1', label: 'default device' }),
  ).toMatchObject({ rememberDevice: false });

  // Re-pairing the same endpoint as a non-extension full client clears a sticky
  // companion allow-list (omit grantProfile must not leave the old clamp).
  store.enroll({
    endpointId: 'ep-session',
    vaultId: 'v1',
    label: 'full desktop',
    platform: 'desktop',
  });
  expect(EnrollmentStore.open(file).get('ep-session', 'v1')?.grantProfile).toBeUndefined();
});

test('enrollment: obsolete JSON registries are not read or rewritten', async () => {
  const file = await tempFile('devices.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      enrollments: [
        {
          enrollmentId: 'legacy-row',
          endpointId: 'legacy-key',
          vaultId: 'v1',
          label: 'Older device',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
  );

  expect(EnrollmentStore.open(file).get('legacy-key', 'v1')).toBeUndefined();
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 1 });
});

test('pairing tickets: one-time, secret-checked, TTL-bound', async () => {
  const file = await tempFile('gateway.db');
  const store = PairingTicketStore.open(file);

  const minted = store.mint('v1');
  expect(store.listActive()).toHaveLength(1);

  // A guessed secret must not burn the ticket before the secret is verified.
  expect(store.redeem(minted.ticketId, 'guessed')).toBeUndefined();
  expect(store.redeem(minted.ticketId, minted.secret)).toEqual({
    vaultId: 'v1',
    trust: 'full',
  });

  const second = store.mint('v2');
  expect(store.redeem(second.ticketId, second.secret)).toEqual({ vaultId: 'v2', trust: 'full' });
  // …and it burned on success.
  expect(store.redeem(second.ticketId, second.secret)).toBeUndefined();

  // Expiry: a stale ticket never redeems.
  const brief = store.mint('v3', 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(store.redeem(brief.ticketId, brief.secret)).toBeUndefined();
});

test('ticket redemption and enrollment commit atomically and one row wins concurrency', async () => {
  const file = await tempFile('gateway.db');
  const gateway = GatewayDatabase.open(path.dirname(file));
  cleanups.push(() => gateway.close());
  const tickets = PairingTicketStore.open(gateway);
  const enrollments = EnrollmentStore.open(gateway);
  const first = tickets.mint('v1');

  expect(() =>
    tickets.redeemAndEnroll(
      first.ticketId,
      first.secret,
      enrollments,
      { endpointId: 'phone', label: 'Phone' },
      () => {
        throw new Error('injected crash');
      },
    ),
  ).toThrow('injected crash');
  expect(tickets.listActive()).toHaveLength(1);
  expect(enrollments.get('phone', 'v1')).toBeUndefined();

  expect(
    tickets.redeemAndEnroll(first.ticketId, first.secret, enrollments, {
      endpointId: 'phone',
      label: 'Phone',
    }),
  ).toMatchObject({ endpointId: 'phone', vaultId: 'v1' });

  const raced = tickets.mint('v1');
  const results = await Promise.all([
    Promise.resolve().then(() =>
      tickets.redeemAndEnroll(raced.ticketId, raced.secret, enrollments, {
        endpointId: 'tablet-a',
        label: 'Tablet A',
      }),
    ),
    Promise.resolve().then(() =>
      tickets.redeemAndEnroll(raced.ticketId, raced.secret, enrollments, {
        endpointId: 'tablet-b',
        label: 'Tablet B',
      }),
    ),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

test('founding redemption rolls back on an injected crash and uses the deleted rowcount', async () => {
  const file = await tempFile('gateway.db');
  const gateway = GatewayDatabase.open(path.dirname(file));
  cleanups.push(() => gateway.close());
  const tickets = PairingTicketStore.open(gateway);
  const enrollments = EnrollmentStore.open(gateway);
  const founding = tickets.mintFounding();

  expect(() =>
    tickets.redeemFoundingAndEnroll(
      founding.ticketId,
      founding.secret,
      enrollments,
      { endpointId: 'founder', vaultId: 'v1', label: 'Founder' },
      () => {
        throw new Error('injected crash');
      },
    ),
  ).toThrow('injected crash');
  expect(tickets.hasActiveFounding()).toBe(true);
  expect(enrollments.list()).toEqual([]);

  const raced = await Promise.all([
    Promise.resolve().then(() =>
      tickets.redeemFoundingAndEnroll(founding.ticketId, founding.secret, enrollments, {
        endpointId: 'founder-a',
        vaultId: 'v1',
        label: 'Founder A',
      }),
    ),
    Promise.resolve().then(() =>
      tickets.redeemFoundingAndEnroll(founding.ticketId, founding.secret, enrollments, {
        endpointId: 'founder-b',
        vaultId: 'v1',
        label: 'Founder B',
      }),
    ),
  ]);
  expect(raced.filter(Boolean)).toHaveLength(1);
  const row = gateway.db
    .prepare("SELECT COUNT(*) AS count FROM devices WHERE endpoint_id LIKE 'founder-%'")
    .get() as { count: number };
  expect(row.count).toBe(1);
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
