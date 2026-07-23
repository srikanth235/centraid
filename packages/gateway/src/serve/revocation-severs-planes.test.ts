import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Issue #505 phase 7 — revocation severs EVERY plane in one action.
 *
 * With the shared admin token retired, the durable credential surface is:
 * per-device HTTP tokens (the `direct` tier), device-bound web control/app
 * cookies (the browser topology), and live iroh transports. A single
 * `DELETE /centraid/_gateway/devices/:id` — the wire twin of `centraid-gateway
 * devices revoke` — must cut all three at once. This drives a real `serve()`
 * daemon: pair a direct-tier device over HTTP, mint a device token, establish
 * a device-bound control cookie, prove both work, then revoke once and assert
 * the token dies, the cookie stops authorizing, and the iroh transport hook
 * fires — no plane rides its TTL past the revocation.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BearerAuthorization } from '@centraid/app-engine';
import { serve, type GatewayServeHandle } from './serve.ts';
import { EnrollmentStore } from './enrollment-store.ts';
import { PairingTicketStore, encodePairingTicket } from './pairing-store.ts';
import { DeviceTokenStore } from './device-token-store.ts';
import { PAIR_ROUTE_PATH } from '../routes/pair-routes.ts';
import type { GatewayPaths } from '../paths.ts';

// The ephemeral per-boot loopback secret the endpoint host forwards with — in
// the daemon it is minted fresh and never persisted; a test pins a known value
// exactly like the desktop's detached-gateway spawn does (CENTRAID_GATEWAY_TOKEN).
const LOOPBACK_SECRET = 'loopback-secret-for-tests';
const SHELL_ORIGIN = 'http://127.0.0.1:4173';

let dataDir: string;
let handle: GatewayServeHandle;
let enrollments: EnrollmentStore;
let tickets: PairingTicketStore;
let deviceTokens: DeviceTokenStore;
let onEndpointRevoked: ReturnType<typeof vi.fn>;
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
  dataDir = await tempDir(`revoke-planes-${crypto.randomUUID()}-`);
  enrollments = EnrollmentStore.open(path.join(dataDir, 'devices.json'));
  tickets = PairingTicketStore.open(path.join(dataDir, 'pairing-tickets.json'));
  deviceTokens = DeviceTokenStore.open(path.join(dataDir, 'device-tokens.json'));
  onEndpointRevoked = vi.fn();

  handle = await serve({
    paths: pathsUnder(dataDir),
    token: LOOPBACK_SECRET,
    deviceAccess: {
      deviceKeyFor: () => undefined,
      vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
    },
    devicePairing: { enrollments, tickets, deviceTokens, onEndpointRevoked },
    authorizeBearer: (bearer): BearerAuthorization | undefined => {
      if (timingSafeStrEqual(bearer, LOOPBACK_SECRET)) return { plane: 'admin' };
      const device = deviceTokens.authorize(bearer);
      return device ? { plane: 'device', deviceKey: device.deviceKey } : undefined;
    },
    // The web-session plane's revocation hook: a device-bound cookie is dead
    // the moment its enrollment leaves the store.
    webSessions: {
      controlsFile: path.join(dataDir, 'web-sessions.json'),
      isDeviceValid: (key) => enrollments.isEnrolled(key),
    },
  });
  vaultA = handle.vaults.defaultVaultId();
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function pairDirectDevice(): Promise<{
  deviceToken: string;
  deviceKey: string;
  enrollmentId: string;
}> {
  const minted = tickets.mint(vaultA, undefined, 'full');
  const ticket = encodePairingTicket({
    v: 1,
    kind: 'centraid-gw-pair',
    gw: 'test-gw-ticket',
    t: minted.ticketId,
    s: minted.secret,
    vaultName: 'test',
    exp: minted.expiresAt,
  });
  const res = await fetch(`${handle.url}${PAIR_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, deviceLabel: 'Tailscale laptop' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { deviceToken: string; deviceKey: string; enrollmentId: string };
}

/** Establish a control cookie bound to the caller's device key. */
async function establishDeviceCookie(deviceToken: string): Promise<string> {
  const res = await fetch(`${handle.url}/centraid/_web/control`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, Origin: SHELL_ORIGIN },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('__centraid_control');
  return setCookie.split(';')[0] ?? '';
}

async function controlCookieWorks(cookie: string): Promise<boolean> {
  const proxied = await fetch(
    `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
    { headers: { Cookie: cookie, Origin: SHELL_ORIGIN } },
  );
  return proxied.status === 200;
}

test('one revoke severs the device token, the device cookie, and the iroh transport', async () => {
  const device = await pairDirectDevice();
  const cookie = await establishDeviceCookie(device.deviceToken);

  // All three planes are live before revocation.
  expect(deviceTokens.authorize(device.deviceToken)).toEqual({ deviceKey: device.deviceKey });
  expect(await controlCookieWorks(cookie)).toBe(true);
  const tokenProbe = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: { Authorization: `Bearer ${device.deviceToken}` },
  });
  expect(tokenProbe.status).toBe(200);

  // A single landlord revoke over HTTP (admin plane = the loopback secret).
  const revoke = await fetch(
    `${handle.url}/centraid/_gateway/devices/${encodeURIComponent(device.enrollmentId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${LOOPBACK_SECRET}` } },
  );
  expect(revoke.status).toBe(200);
  expect(await revoke.json()).toEqual({ removed: true });

  // Plane 1 — the per-device HTTP token is dead.
  expect(deviceTokens.authorize(device.deviceToken)).toBeUndefined();
  const tokenAfter = await fetch(`${handle.url}/centraid/_vault/status`, {
    headers: { Authorization: `Bearer ${device.deviceToken}` },
  });
  expect(tokenAfter.status).toBe(401);

  // Plane 2 — the device-bound control cookie stops authorizing at once.
  expect(await controlCookieWorks(cookie)).toBe(false);

  // Plane 3 — the live iroh transport for that endpoint is torn down.
  expect(onEndpointRevoked).toHaveBeenCalledWith(device.deviceKey);

  // The enrollment itself is gone.
  expect(enrollments.get(device.deviceKey, vaultA)).toBeUndefined();
});
