/*
 * HTTP-level coverage for the paired-device routes (issue #376): list +
 * revoke against REAL `EnrollmentStore` / `DeviceTokenStore` JSON files on
 * disk, exercising the caller-plane scope (admin sees all, a device sees only
 * its vaults) and the revoke → token cascade that mirrors device-admin.ts.
 */

import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import type { RouteHandler } from '../serve/build-gateway.js';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { DeviceTokenStore } from '../serve/device-token-store.js';
import { PairingTicketStore, parsePairingTicket } from '../serve/pairing-store.js';
import { makeDevicesRouteHandler } from './devices-routes.js';

const servers: http.Server[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function startHandlerServer(handler: RouteHandler): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `devices-routes-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const VAULT_NAMES: Record<string, string> = { 'vault-a': 'Alpha', 'vault-b': 'Beta' };
const vaultName = (id: string): string | undefined => VAULT_NAMES[id];

async function makeStores(): Promise<{
  enrollments: EnrollmentStore;
  deviceTokens: DeviceTokenStore;
  tickets: PairingTicketStore;
}> {
  const dir = await tempDir();
  return {
    enrollments: EnrollmentStore.open(path.join(dir, 'devices.json')),
    deviceTokens: DeviceTokenStore.open(path.join(dir, 'device-tokens.json')),
    tickets: PairingTicketStore.open(path.join(dir, 'pairing-tickets.json')),
  };
}

/** A stub iroh EndpointTicket getter for the mint path. */
const endpointTicket = (): string => 'gw-endpoint-ticket-stub';

test('GET as admin lists every vault, with transport + vaultName + current mapping', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const iroh = enrollments.enroll({
    endpointId: 'abc32key',
    vaultId: 'vault-a',
    label: 'Zed laptop',
  });
  enrollments.enroll({
    endpointId: 'http:xyz',
    vaultId: 'vault-b',
    label: 'Amy phone',
    platform: 'ios',
  });
  deviceTokens.mint({ deviceKey: 'http:xyz', label: 'Amy phone' });

  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices`);
  expect(res.status).toBe(200);
  const { devices } = (await res.json()) as { devices: Array<Record<string, unknown>> };

  // Sorted by label (no current device for an admin caller): Amy < Zed.
  expect(devices.map((d) => d.label)).toEqual(['Amy phone', 'Zed laptop']);
  const amy = devices[0]!;
  expect(amy.transport).toBe('http');
  expect(amy.vaultName).toBe('Beta');
  expect(amy.platform).toBe('ios');
  expect(amy.current).toBe(false);
  const zed = devices[1]!;
  expect(zed.deviceId).toBe(iroh.enrollmentId);
  expect(zed.transport).toBe('iroh');
  expect(zed.vaultName).toBe('Alpha');
  expect(zed.current).toBe(false);
  // No platform on the iroh row ⇒ field omitted, not undefined.
  expect('platform' in zed).toBe(false);
});

test('GET as a device lists only that device’s vaults and marks current', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  // The caller device opens vault-a; another device opens vault-b.
  enrollments.enroll({ endpointId: 'me-key', vaultId: 'vault-a', label: 'My laptop' });
  enrollments.enroll({ endpointId: 'other-key', vaultId: 'vault-b', label: 'Other phone' });

  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices`, {
    headers: { [AUTHED_DEVICE_HEADER]: 'me-key' },
  });
  const { devices } = (await res.json()) as { devices: Array<Record<string, unknown>> };
  expect(devices).toHaveLength(1);
  expect(devices[0]!.label).toBe('My laptop');
  expect(devices[0]!.current).toBe(true);
});

test('DELETE cascades: enrollment gone AND the device token revoked when no enrollment remains', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const row = enrollments.enroll({ endpointId: 'http:lone', vaultId: 'vault-a', label: 'Lone' });
  const { token } = deviceTokens.mint({ deviceKey: 'http:lone', label: 'Lone' });
  expect(deviceTokens.authorize(token)).toEqual({ deviceKey: 'http:lone' });
  const onRevoked = vi.fn();

  const base = await startHandlerServer(
    makeDevicesRouteHandler({
      enrollments,
      deviceTokens,
      tickets,
      vaultName,
      endpointTicket,
      onRevoked,
    }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/${row.enrollmentId}`, {
    method: 'DELETE',
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toEqual({ removed: true });

  expect(enrollments.list()).toHaveLength(0);
  expect(deviceTokens.authorize(token)).toBeUndefined();
  expect(onRevoked).toHaveBeenCalledWith([row]);
});

test('DELETE keeps the token when the device still holds another vault', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const a = enrollments.enroll({ endpointId: 'http:multi', vaultId: 'vault-a', label: 'Multi' });
  enrollments.enroll({ endpointId: 'http:multi', vaultId: 'vault-b', label: 'Multi' });
  const { token } = deviceTokens.mint({ deviceKey: 'http:multi', label: 'Multi' });

  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  await fetch(`${base}/centraid/_gateway/devices/${a.enrollmentId}`, { method: 'DELETE' });

  // vault-b row still there ⇒ key still enrolled ⇒ token survives.
  expect(enrollments.isEnrolled('http:multi')).toBe(true);
  expect(deviceTokens.authorize(token)).toEqual({ deviceKey: 'http:multi' });
});

test('DELETE of an enrollment outside a device caller’s vault → 404 and the row survives', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  enrollments.enroll({ endpointId: 'me-key', vaultId: 'vault-a', label: 'Mine' });
  const foreign = enrollments.enroll({
    endpointId: 'other-key',
    vaultId: 'vault-b',
    label: 'Theirs',
  });

  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/${foreign.enrollmentId}`, {
    method: 'DELETE',
    headers: { [AUTHED_DEVICE_HEADER]: 'me-key' },
  });
  expect(res.status).toBe(404);
  expect((await res.json()) as unknown).toEqual({ error: 'not_found' });
  // The foreign row is untouched.
  expect(enrollments.list().some((e) => e.enrollmentId === foreign.enrollmentId)).toBe(true);
});

test('DELETE of a missing id is idempotent: { removed: false }', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/does-not-exist`, { method: 'DELETE' });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toEqual({ removed: false });
});

test('405 on a bad method; non-matching path falls through', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );

  const post = await fetch(`${base}/centraid/_gateway/devices`, { method: 'POST' });
  expect(post.status).toBe(405);
  expect((await post.json()) as unknown).toEqual({ error: 'method_not_allowed' });

  const put = await fetch(`${base}/centraid/_gateway/devices/some-id`, { method: 'PUT' });
  expect(put.status).toBe(405);

  // A path this handler doesn't own ⇒ returns false ⇒ our test server 404s.
  const other = await fetch(`${base}/centraid/_gateway/health`);
  expect(other.status).toBe(404);
});

test('PUT /:id/compute persists capability advertisement and charging-only opt-in', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const row = enrollments.enroll({
    endpointId: 'http:worker',
    vaultId: 'vault-a',
    label: 'Worker phone',
  });
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const capabilities = {
    previews: true,
    poster: true,
    pdfText: true,
    ocr: false,
    embedding: false,
    transcript: true,
    edgeSeal: true,
    backgroundTransfer: true,
  };
  const response = await fetch(`${base}/centraid/_gateway/devices/${row.enrollmentId}/compute`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contributeWhileCharging: true, capabilities }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { device: { compute: Record<string, unknown> } };
  expect(body.device.compute).toMatchObject({ contributeWhileCharging: true, capabilities });
  expect(enrollments.list()[0]!.compute).toMatchObject({
    contributeWhileCharging: true,
    capabilities,
  });
});

test('PUT /:id/compute rejects incomplete capability advertisements', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const row = enrollments.enroll({ endpointId: 'worker', vaultId: 'vault-a', label: 'Worker' });
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const response = await fetch(`${base}/centraid/_gateway/devices/${row.enrollmentId}/compute`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contributeWhileCharging: true, capabilities: { poster: true } }),
  });
  expect(response.status).toBe(400);
  expect(enrollments.list()[0]!.compute).toBeUndefined();
});

test('POST /ticket as admin mints a decodable ticket for the x-centraid-vault vault', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );

  const res = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: { 'x-centraid-vault': 'vault-a' },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    ticket: string;
    vaultId: string;
    vaultName: string;
    expiresAt: string;
  };
  expect(body.ok).toBe(true);
  expect(body.vaultId).toBe('vault-a');
  expect(body.vaultName).toBe('Alpha');
  expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);

  // The token decodes to a real pairing payload pinned to the stub endpoint.
  const decoded = parsePairingTicket(body.ticket);
  expect(decoded).toBeDefined();
  expect(decoded!.gw).toBe('gw-endpoint-ticket-stub');
  expect(decoded!.vaultName).toBe('Alpha');

  // The store now holds exactly one unredeemed ticket for that vault.
  const active = tickets.listActive();
  expect(active).toHaveLength(1);
  expect(active[0]!.vaultId).toBe('vault-a');
  expect(active[0]!.ticketId).toBe(decoded!.t);
});

test('POST /ticket as a device: enrolled vault mints, foreign vault → 404', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  enrollments.enroll({ endpointId: 'me-key', vaultId: 'vault-a', label: 'Mine' });
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );

  // Its own vault — allowed.
  const ok = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: { [AUTHED_DEVICE_HEADER]: 'me-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultId: 'vault-a' }),
  });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { vaultId: string }).vaultId).toBe('vault-a');

  // A vault it is NOT enrolled in — 404, no existence leak, no ticket minted.
  const foreign = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: { [AUTHED_DEVICE_HEADER]: 'me-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultId: 'vault-b' }),
  });
  expect(foreign.status).toBe(404);
  expect((await foreign.json()) as unknown).toEqual({ error: 'not_found' });
  expect(tickets.listActive().every((t) => t.vaultId === 'vault-a')).toBe(true);
});

test('POST /ticket binds owner-selected trust and refuses delegation from a read-only device', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  enrollments.enroll({
    endpointId: 'readonly-key',
    vaultId: 'vault-a',
    label: 'Viewer',
    trust: 'readonly',
  });
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );

  const owner = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vaultId: 'vault-a', trust: 'readonly' }),
  });
  expect(owner.status).toBe(200);
  expect(tickets.listActive()).toEqual([
    expect.objectContaining({ vaultId: 'vault-a', trust: 'readonly' }),
  ]);

  const delegated = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: {
      [AUTHED_DEVICE_HEADER]: 'readonly-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ vaultId: 'vault-a', trust: 'full' }),
  });
  expect(delegated.status).toBe(403);
  expect(await delegated.json()).toMatchObject({ error: 'readonly_device' });
  expect(tickets.listActive()).toHaveLength(1);
});

test('POST /ticket with no vault (no body, no header) → 400 vault_required', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/ticket`, { method: 'POST' });
  expect(res.status).toBe(400);
  expect((await res.json()) as unknown).toEqual({ error: 'vault_required' });
});

test('405 on GET /ticket', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/ticket`, { method: 'GET' });
  expect(res.status).toBe(405);
  expect((await res.json()) as unknown).toEqual({ error: 'method_not_allowed' });
});

test('a minted ticket round-trips through redeem(ticketId, secret)', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName, endpointTicket }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: { 'x-centraid-vault': 'vault-b' },
  });
  const { ticket } = (await res.json()) as { ticket: string };
  const decoded = parsePairingTicket(ticket)!;

  // The private half (t/s) really redeems against the store → enrolls vault-b.
  expect(tickets.redeem(decoded.t, decoded.s)).toEqual({ vaultId: 'vault-b', trust: 'full' });
  // Burned — a second redemption fails.
  expect(tickets.redeem(decoded.t, decoded.s)).toBeUndefined();
});

test('POST /ticket → 409 when the gateway has no iroh endpoint', async () => {
  const { enrollments, deviceTokens, tickets } = await makeStores();
  const base = await startHandlerServer(
    // No endpointTicket getter ⇒ can't mint a redeemable (gw-pinned) ticket.
    makeDevicesRouteHandler({ enrollments, deviceTokens, tickets, vaultName }),
  );
  const res = await fetch(`${base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: { 'x-centraid-vault': 'vault-a' },
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('no_iroh_endpoint');
  expect(tickets.listActive()).toHaveLength(0);
});
