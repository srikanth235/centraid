import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Per-device HTTP bearer tokens (issue #376) — the HTTP twin of the iroh
 * device-key ACL. Proves the whole lane end-to-end against a real
 * `serve()` daemon: ticket → HTTP redemption → device token → confined
 * caller, the admin/shared token's behavior is untouched, a burned ticket
 * stays burned, and a forged device-identity header never survives the
 * listener.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUTHED_DEVICE_HEADER, type BearerAuthorization } from '@centraid/app-engine';
import { serve, type GatewayServeHandle } from './serve.ts';
import { EnrollmentStore } from './enrollment-store.ts';
import { PairingTicketStore, encodePairingTicket } from './pairing-store.ts';
import { DeviceTokenStore } from './device-token-store.ts';
import { PAIR_ROUTE_PATH } from '../routes/pair-routes.ts';
import type { GatewayPaths } from '../paths.ts';

const ADMIN_TOKEN = 'admin-shared-token-for-tests';

let dataDir: string;
let handle: GatewayServeHandle;
let enrollments: EnrollmentStore;
let tickets: PairingTicketStore;
let deviceTokens: DeviceTokenStore;
let vaultA: string;

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, 'vault'), prefsFile: path.join(dir, 'prefs.json') };
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

beforeEach(async () => {
  dataDir = await tempDir(`device-tok-gateway-${crypto.randomUUID()}-`);
  enrollments = EnrollmentStore.open(path.join(dataDir, 'devices.json'));
  tickets = PairingTicketStore.open(path.join(dataDir, 'pairing-tickets.json'));
  deviceTokens = DeviceTokenStore.open(path.join(dataDir, 'device-tokens.json'));

  handle = await serve({
    paths: pathsUnder(dataDir),
    token: ADMIN_TOKEN,
    // No iroh transport in this harness — only the HTTP-stamped device
    // header should ever resolve a device key.
    deviceAccess: {
      deviceKeyFor: () => undefined,
      vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
    },
    devicePairing: { enrollments, tickets, deviceTokens },
    authorizeBearer: (bearer): BearerAuthorization | undefined => {
      if (timingSafeStrEqual(bearer, ADMIN_TOKEN)) return { plane: 'admin' };
      const device = deviceTokens.authorize(bearer);
      return device ? { plane: 'device', deviceKey: device.deviceKey } : undefined;
    },
  });
  vaultA = handle.vaults.defaultVaultId();
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

function mintTicket(vaultId: string, trust: 'full' | 'readonly' = 'full'): string {
  const minted = tickets.mint(vaultId, undefined, trust);
  return encodePairingTicket({
    v: 1,
    kind: 'centraid-gw-pair',
    gw: 'test-gw-ticket',
    t: minted.ticketId,
    s: minted.secret,
    vaultName: 'test',
    exp: minted.expiresAt,
  });
}

async function redeem(
  ticket: string,
  deviceLabel = 'Test phone',
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${handle.url}${PAIR_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, deviceLabel, ...extra }),
  });
}

test('(a) HTTP redemption happy path returns a working device token', async () => {
  const ticket = mintTicket(vaultA);
  const res = await redeem(ticket);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    deviceToken: string;
    deviceKey: string;
    vaultId: string;
    vaultName: string;
  };
  expect(body.ok).toBe(true);
  expect(body.deviceToken).toMatch(/^cdt_/);
  expect(body.deviceKey).toMatch(/^http:/);
  expect(body.vaultId).toBe(vaultA);

  // The minted token actually authenticates against the gateway.
  const statusRes = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: { Authorization: `Bearer ${body.deviceToken}` },
  });
  expect(statusRes.status).toBe(200);
  expect(await statusRes.json()).toMatchObject({ vaultId: vaultA });
});

test('redemption itself needs no bearer at all — the ticket secret is the auth', async () => {
  const ticket = mintTicket(vaultA);
  const res = await redeem(ticket); // deliberately no Authorization header
  expect(res.status).toBe(200);
});

test('Companion pairing requires and server-enforces the selected module grants', async () => {
  const missingTicket = mintTicket(vaultA);
  const missing = await redeem(missingTicket, 'Companion', { platform: 'extension' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ ok: false, error: 'malformed_request' });

  const ticket = mintTicket(vaultA);
  const paired = await redeem(ticket, 'Companion', {
    platform: 'extension',
    grantProfile: ['locker'],
  });
  expect(paired.status).toBe(200);
  const body = (await paired.json()) as {
    deviceToken: string;
    deviceKey: string;
    enrollmentId: string;
  };
  expect(enrollments.get(body.deviceKey, vaultA)?.grantProfile).toEqual(['locker']);

  const status = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: { Authorization: `Bearer ${body.deviceToken}` },
  });
  expect(status.status).toBe(200);

  const count = await fetch(`${handle.url}/centraid/_vault/blocking`, {
    headers: { Authorization: `Bearer ${body.deviceToken}` },
  });
  expect(count.status).toBe(200);
  expect(await count.json()).toMatchObject({ count: 0 });

  const modules = await fetch(`${handle.url}/centraid/_vault/apps`, {
    headers: { Authorization: `Bearer ${body.deviceToken}` },
  });
  expect(modules.status).toBe(200);
  expect(await modules.json()).toMatchObject({
    modules: expect.arrayContaining([
      { id: 'locker', state: 'unavailable' },
      { id: 'notes', state: 'revoked' },
    ]),
  });

  const ownerSurface = await fetch(`${handle.url}/centraid/_vault/vaults`, {
    headers: { Authorization: `Bearer ${body.deviceToken}` },
  });
  expect(ownerSurface.status).toBe(403);
  expect(await ownerSurface.json()).toMatchObject({ error: 'companion_profile' });

  const lockerBlob = await fetch(`${handle.url}/centraid/_vault/blobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${body.deviceToken}`,
      'content-type': 'image/png',
    },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(lockerBlob.status).toBe(403);

  const docsTicket = mintTicket(vaultA);
  const docsPair = await redeem(docsTicket, 'Docs Companion', {
    platform: 'extension',
    grantProfile: ['docs'],
  });
  const docs = (await docsPair.json()) as { deviceToken: string; enrollmentId: string };
  const docsBlob = await fetch(`${handle.url}/centraid/_vault/blobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${docs.deviceToken}`,
      'content-type': 'image/png',
    },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(docsBlob.status).toBe(200);
  expect(await docsBlob.json()).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

  const notesTool = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${body.deviceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ app: 'notes', query: 'list' }),
  });
  expect(notesTool.status).toBe(403);
  expect(await notesTool.json()).toMatchObject({ code: 'app_session_scope' });

  const unbundledLockerAction = await fetch(`${handle.url}/centraid/_tool/centraid_write`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${body.deviceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ app: 'locker', action: 'trash-item', input: { item_id: 'item-1' } }),
  });
  expect(unbundledLockerAction.status).toBe(403);
  expect(await unbundledLockerAction.json()).toMatchObject({ code: 'app_session_scope' });

  const otherDevice = await fetch(
    `${handle.url}/centraid/_gateway/devices/${encodeURIComponent(docs.enrollmentId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${body.deviceToken}` },
    },
  );
  expect(otherDevice.status).toBe(403);
  expect(await otherDevice.json()).toMatchObject({ error: 'companion_profile' });

  const unpair = await fetch(
    `${handle.url}/centraid/_gateway/devices/${encodeURIComponent(body.enrollmentId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${body.deviceToken}` },
    },
  );
  expect(unpair.status).toBe(200);
  expect(await unpair.json()).toEqual({ removed: true });
  expect(enrollments.get(body.deviceKey, vaultA)).toBeUndefined();
});

test('(b) device-token caller is confined: a non-enrolled vault is 403', async () => {
  const vaultB = handle.vaults.create('Second').vaultId;
  const ticket = mintTicket(vaultA);
  const body = (await (await redeem(ticket)).json()) as { deviceToken: string };

  const denied = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: { Authorization: `Bearer ${body.deviceToken}`, 'x-centraid-vault': vaultB },
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: 'vault_not_enrolled' });
});

test('ticket trust is server-bound: a read-only redemption cannot self-upgrade or mutate', async () => {
  const ticket = mintTicket(vaultA, 'readonly');
  const paired = await redeem(ticket, 'Read-only tablet', { trust: 'full' });
  expect(paired.status).toBe(200);
  const body = (await paired.json()) as { deviceToken: string; trust: string };
  expect(body.trust).toBe('readonly');

  const readable = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: { Authorization: `Bearer ${body.deviceToken}` },
  });
  expect(readable.status).toBe(200);

  const mutation = await fetch(`${handle.url}/centraid/_vault/vaults/${vaultA}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${body.deviceToken}`,
      'content-type': 'application/json',
      'x-centraid-vault': vaultA,
    },
    body: JSON.stringify({ name: 'Escalated' }),
  });
  expect(mutation.status).toBe(403);
  expect(await mutation.json()).toMatchObject({ error: 'readonly_device' });
});

test('(c) GET /_vault/vaults is filtered to the device-token caller enrollments', async () => {
  handle.vaults.create('Second');
  const ticket = mintTicket(vaultA);
  const body = (await (await redeem(ticket)).json()) as { deviceToken: string };

  const listed = (await (
    await fetch(`${handle.url}/centraid/_vault/vaults`, {
      headers: { Authorization: `Bearer ${body.deviceToken}` },
    })
  ).json()) as { vaults: Array<{ vaultId: string }> };
  expect(listed.vaults.map((v) => v.vaultId)).toEqual([vaultA]);
});

test('(d) PATCH on a non-enrolled vault is refused for a device-token caller', async () => {
  const vaultB = handle.vaults.create('Second').vaultId;
  const ticket = mintTicket(vaultA);
  const body = (await (await redeem(ticket)).json()) as { deviceToken: string };

  const res = await fetch(`${handle.url}/centraid/_vault/vaults/${vaultB}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${body.deviceToken}`,
      'content-type': 'application/json',
      'x-centraid-vault': vaultB,
    },
    body: JSON.stringify({ name: 'Hijacked' }),
  });
  expect(res.status).toBe(403);
});

test('(e) the shared/admin token behavior is unchanged: sees every vault', async () => {
  const vaultB = handle.vaults.create('Second').vaultId;
  const listed = (await (
    await fetch(`${handle.url}/centraid/_vault/vaults`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    })
  ).json()) as { vaults: Array<{ vaultId: string }> };
  expect(listed.vaults.map((v) => v.vaultId).sort()).toEqual([vaultA, vaultB].sort());

  // An invalid bearer still 401s exactly as before.
  const bad = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: 'Bearer garbage' },
  });
  expect(bad.status).toBe(401);
});

test('(f) redeeming the same ticket twice fails the second time', async () => {
  const ticket = mintTicket(vaultA);
  const first = await redeem(ticket);
  expect(first.status).toBe(200);
  const second = await redeem(ticket);
  expect(second.status).toBe(403);
  expect(await second.json()).toMatchObject({ ok: false, error: 'ticket_invalid' });
});

test('(g) a forged x-centraid-authed-device header from a client is stripped', async () => {
  const vaultB = handle.vaults.create('Second').vaultId;
  // A real enrollment the header WOULD resolve to, if it were trusted.
  enrollments.enroll({ endpointId: 'http:legit-device', vaultId: vaultB, label: 'legit' });

  const res = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      [AUTHED_DEVICE_HEADER]: 'http:legit-device',
      'x-centraid-companion-grants': '',
    },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { vaultId: string };
  // The admin token still resolves the DEFAULT vault — the forged header
  // never took hold, and the admin plane never gets a device key at all.
  expect(body.vaultId).toBe(vaultA);
});

test('malformed and invalid redemption requests are refused without leaking why', async () => {
  const malformed = await fetch(`${handle.url}${PAIR_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: 'not-base64url-json', deviceLabel: 'x' }),
  });
  // A syntactically-invalid ticket string still decodes as "not a valid
  // ticket" (parsePairingTicket returns undefined) → ticket_invalid, not a
  // 400 — only a missing/mistyped FIELD is a 400.
  expect(malformed.status).toBe(403);
  expect(await malformed.json()).toMatchObject({ ok: false, error: 'ticket_invalid' });

  const missingField = await fetch(`${handle.url}${PAIR_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceLabel: 'x' }),
  });
  expect(missingField.status).toBe(400);
  expect(await missingField.json()).toMatchObject({ ok: false, error: 'malformed_request' });
});
