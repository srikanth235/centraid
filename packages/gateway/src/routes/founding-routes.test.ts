import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseRecoveryKit, wrapRecoveryKit } from '@centraid/backup';
import { ROUTES } from '@centraid/protocol';
import { KeyStore } from '@centraid/vault';
import { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { daemonLayoutFor } from '../cli/paths.js';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { PairingTicketStore, parseFoundingTicket } from '../serve/pairing-store.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { makeFoundingRouteHandler } from './founding-routes.js';

// Each test bootstraps a real encrypted vault and gateway database. The hosted
// runner's slowest filesystem class can exceed the gateway project's 30s default.
vi.setConfig({ testTimeout: 60_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test('founding ticket is single-outstanding and initialize enrolls one verified owner', async () => {
  const dataDir = await tempDir('founding-route-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const layout = daemonLayoutFor(dataDir);
  const database = GatewayDatabase.open(dataDir);
  cleanups.push(() => database.close());
  const registry = openVaultRegistry({
    rootDir: layout.vaultDir,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  cleanups.push(() => registry.stop());
  const enrollments = EnrollmentStore.open(database);
  const tickets = PairingTicketStore.open(database);
  const recoveryKit = new RecoveryKitStateStore(database);
  let injectFoundingCrash = false;
  const handler = makeFoundingRouteHandler({
    vaults: registry,
    enrollments,
    tickets,
    keys: new KeyStore(layout.keysDir),
    recoveryKit,
    canMintFoundingTicket: () => true,
    deviceAccess: {
      deviceKeyFor: (req) =>
        typeof req.headers['x-test-endpoint'] === 'string'
          ? req.headers['x-test-endpoint']
          : undefined,
      vaultsFor: (endpointId) => enrollments.vaultsFor(endpointId),
    },
    endpointTicket: () => 'live-endpoint-ticket',
    beforeFoundingEnrollment: () => {
      if (!injectFoundingCrash) return;
      injectFoundingCrash = false;
      throw new Error('injected founding crash');
    },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const first = (await (
    await fetch(`${base}/centraid/_gateway/founding/ticket`, { method: 'POST' })
  ).json()) as { ticket: string };
  const second = (await (
    await fetch(`${base}/centraid/_gateway/founding/ticket`, { method: 'POST' })
  ).json()) as { ticket: string };
  const firstPayload = parseFoundingTicket(first.ticket);
  const secondPayload = parseFoundingTicket(second.ticket);
  expect(firstPayload).toBeDefined();
  expect(secondPayload).toBeDefined();
  expect(tickets.redeemFounding(firstPayload!.t, firstPayload!.s)).toBe(false);

  injectFoundingCrash = true;
  const crashedResponse = await fetch(`${base}/centraid/_vault/vaults:initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-endpoint': 'founder-device' },
    body: JSON.stringify({
      ticket: second.ticket,
      name: 'Family',
      password: 'correct horse battery staple',
      deviceName: 'Owner laptop',
      platform: 'desktop',
    }),
  });
  expect(crashedResponse.status).toBe(500);
  expect(registry.isFresh()).toBe(true);
  expect(tickets.hasOpenFoundingWindow()).toBe(true);
  expect(tickets.pendingFoundingVaults()).toEqual([]);
  expect(enrollments.list()).toEqual([]);

  const initializedResponse = await fetch(`${base}/centraid/_vault/vaults:initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-endpoint': 'founder-device' },
    body: JSON.stringify({
      ticket: second.ticket,
      name: 'Family',
      password: 'correct horse battery staple',
      deviceName: 'Owner laptop',
      platform: 'desktop',
    }),
  });
  expect(initializedResponse.status).toBe(201);
  const initialized = (await initializedResponse.json()) as {
    vault: { vaultId: string; name: string };
    kit: unknown;
    fingerprint: string;
  };
  expect(registry.list()).toEqual([initialized.vault]);
  expect(enrollments.get('founder-device', initialized.vault.vaultId)?.trust).toBe('owner');
  expect(tickets.pendingFoundingVaults()).toEqual([]);
  expect(parseRecoveryKit(initialized.kit, 'correct horse battery staple').targets).toEqual([]);
  expect(JSON.stringify(initialized.kit)).not.toContain(
    new KeyStore(layout.keysDir).export('keyring.key')!.toString('utf8'),
  );
  expect(recoveryKit.ceremonyIncomplete()).toBe(true);

  const refused = await fetch(`${base}/centraid/_vault/vaults:initialize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-endpoint': 'other-device' },
    body: JSON.stringify({
      ticket: second.ticket,
      password: 'another password',
    }),
  });
  expect(refused.status).toBe(409);

  const noConsent = await fetch(`${base}/centraid/_vault/vaults:initialize/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-endpoint': 'founder-device' },
    body: JSON.stringify({
      kit: initialized.kit,
      password: 'correct horse battery staple',
    }),
  });
  expect(noConsent.status).toBe(409);

  const verified = await fetch(`${base}/centraid/_vault/vaults:initialize/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-endpoint': 'founder-device' },
    body: JSON.stringify({
      kit: initialized.kit,
      password: 'correct horse battery staple',
      lossConsent: true,
    }),
  });
  expect(verified.status).toBe(200);
  expect(await recoveryKit.status()).toMatchObject({
    confirmedAt: expect.any(Number),
    kitFingerprint: initialized.fingerprint,
  });
  expect(recoveryKit.ceremonyIncomplete()).toBe(false);
});

test('founding routes fail closed at every ceremony boundary and accept safe defaults', async () => {
  const dataDir = await tempDir('founding-route-boundaries-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const layout = daemonLayoutFor(dataDir);
  const database = GatewayDatabase.open(dataDir);
  cleanups.push(() => database.close());
  const registry = openVaultRegistry({
    rootDir: layout.vaultDir,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  cleanups.push(() => registry.stop());
  const enrollments = EnrollmentStore.open(database);
  const tickets = PairingTicketStore.open(database);
  const recoveryKit = new RecoveryKitStateStore(database);
  const keys = new KeyStore(layout.keysDir);
  let possession = false;
  let endpointTicket: string | undefined;
  const handler = makeFoundingRouteHandler({
    vaults: registry,
    enrollments,
    tickets,
    keys,
    recoveryKit,
    canMintFoundingTicket: () => possession,
    deviceAccess: {
      deviceKeyFor: (req) =>
        typeof req.headers['x-test-endpoint'] === 'string'
          ? req.headers['x-test-endpoint']
          : undefined,
      vaultsFor: (endpointId) => enrollments.vaultsFor(endpointId),
    },
    endpointTicket: () => endpointTicket,
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, body?: unknown, endpointId?: string): Promise<Response> =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(endpointId ? { 'x-test-endpoint': endpointId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  expect((await fetch(`${base}/not-a-founding-route`)).status).toBe(404);
  expect((await fetch(`${base}${ROUTES.gatewayFoundingTicket}`)).status).toBe(405);
  expect((await post(ROUTES.gatewayFoundingTicket)).status).toBe(403);

  possession = true;
  expect((await post(ROUTES.gatewayFoundingTicket)).status).toBe(409);
  endpointTicket = 'live-endpoint-ticket';

  const malformed = await fetch(`${base}${ROUTES.vaultInitialize}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-endpoint': 'founder-device' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect((await post(ROUTES.vaultInitialize, {})).status).toBe(403);
  expect((await post(ROUTES.vaultInitializeVerify, {}, 'stranger')).status).toBe(403);
  expect((await post(ROUTES.vaultRestore, {}, 'founder-device')).status).toBe(400);
  expect(
    (
      await post(
        ROUTES.vaultRestore,
        { apiKey: 'provider-key', kit: {}, password: 'password', ticket: 'bad-ticket' },
        'founder-device',
      )
    ).status,
  ).toBe(403);

  const emptyRestoreTicket = (await (await post(ROUTES.gatewayFoundingTicket)).json()) as {
    ticket: string;
  };
  const emptyRestoreKit = wrapRecoveryKit(
    {
      version: 1,
      kind: 'centraid-recovery-kit',
      createdAt: new Date().toISOString(),
      keyring: {
        version: 1,
        active: 1,
        epochs: [
          {
            epoch: 1,
            key: Buffer.alloc(32, 7).toString('base64'),
            createdAt: new Date().toISOString(),
          },
        ],
      },
      targets: [],
    },
    'password',
  );
  const emptyRestore = await post(
    ROUTES.vaultRestore,
    {
      apiKey: 'provider-key',
      kit: emptyRestoreKit,
      password: 'password',
      ticket: emptyRestoreTicket.ticket,
    },
    'founder-device',
  );
  expect(emptyRestore.status).toBe(400);
  expect(await emptyRestore.json()).toMatchObject({ error: 'restore_failed' });

  expect((await post(ROUTES.vaultInitialize, {}, 'founder-device')).status).toBe(400);
  expect(
    (
      await post(
        ROUTES.vaultInitialize,
        { password: 'password', ticket: 'bad-ticket' },
        'founder-device',
      )
    ).status,
  ).toBe(403);

  const foundingTicket = (await (await post(ROUTES.gatewayFoundingTicket)).json()) as {
    ticket: string;
  };
  const initialized = await post(
    ROUTES.vaultInitialize,
    { password: 'password', ticket: foundingTicket.ticket },
    'founder-device',
  );
  expect(initialized.status).toBe(201);
  const initializedBody = (await initialized.json()) as {
    enrollment: { label: string };
    kit: unknown;
    vault: { name: string };
  };
  expect(initializedBody.vault.name).toBe('Personal');
  expect(initializedBody.enrollment.label).toMatch(/^founder founder-de/);

  expect((await post(ROUTES.gatewayFoundingTicket)).status).toBe(409);
  expect(
    (
      await post(
        ROUTES.vaultInitializeVerify,
        { kit: initializedBody.kit, lossConsent: true },
        'founder-device',
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await post(
        ROUTES.vaultInitializeVerify,
        { kit: {}, lossConsent: true, password: 'password' },
        'founder-device',
      )
    ).status,
  ).toBe(400);

  const otherDocument = parseRecoveryKit(initializedBody.kit, 'password');
  otherDocument.keyring.epochs[0]!.key = Buffer.alloc(32, 9).toString('base64');
  const otherKit = wrapRecoveryKit(otherDocument, 'password');
  const mismatch = await post(
    ROUTES.vaultInitializeVerify,
    { kit: otherKit, lossConsent: true, password: 'password' },
    'founder-device',
  );
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: 'kit_mismatch' });
});
