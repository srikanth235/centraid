import { tempDir } from '@centraid/test-kit/temp-dir';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { PairingTicketStore, parsePairingTicket } from '../serve/pairing-store.js';
import { hashControlToken, WebControlSessionStore } from '../serve/web-session-store.js';
import { makeDevicesRouteHandler, type DevicesRouteDeps } from './devices-routes.js';

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function harness(
  overrides: Partial<Pick<DevicesRouteDeps, 'endpointTicket' | 'isUninitialized'>> = {},
): Promise<{
  base: string;
  enrollments: EnrollmentStore;
  tickets: PairingTicketStore;
  sessions: WebControlSessionStore;
  onEndpointRevoked: ReturnType<typeof vi.fn>;
}> {
  const dir = await tempDir('devices-routes-');
  dirs.push(dir);
  const database = GatewayDatabase.open(dir);
  databases.push(database);
  const enrollments = EnrollmentStore.open(database);
  const tickets = PairingTicketStore.open(database);
  const sessions = WebControlSessionStore.open(database);
  const onEndpointRevoked = vi.fn();
  const handler = makeDevicesRouteHandler({
    enrollments,
    tickets,
    vaultName: (vaultId) => (vaultId === 'vault-a' ? 'Personal' : undefined),
    endpointTicket: () => 'endpoint-ticket',
    onEndpointRevoked,
    ...overrides,
  });
  const server = http.createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    enrollments,
    tickets,
    sessions,
    onEndpointRevoked,
  };
}

function deviceHeaders(endpointId: string): Record<string, string> {
  return { [AUTHED_DEVICE_HEADER]: endpointId, 'content-type': 'application/json' };
}

test('roster requires a proved identity and exposes only enrolled iroh rows', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner laptop',
    role: 'admin',
  });
  f.enrollments.enroll({
    endpointId: 'other-key',
    vaultId: 'vault-b',
    label: 'Other vault',
  });

  expect((await fetch(`${f.base}/centraid/_gateway/devices`)).status).toBe(403);
  const response = await fetch(`${f.base}/centraid/_gateway/devices`, {
    headers: deviceHeaders('owner-key'),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    devices: [
      {
        endpointId: 'owner-key',
        transport: 'iroh',
        vaultId: 'vault-a',
        current: true,
        role: 'admin',
      },
    ],
  });
});

test('owner mints a full-role iroh ticket; ordinary devices cannot delegate', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  f.enrollments.enroll({
    endpointId: 'full-key',
    vaultId: 'vault-a',
    label: 'Member',
    role: 'write',
  });
  const body = JSON.stringify({ vaultId: 'vault-a' });
  const anonymous = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    body,
  });
  expect(anonymous.status).toBe(403);

  const denied = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('full-key'),
    body,
  });
  expect(denied.status).toBe(403);

  const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body,
  });
  expect(minted.status).toBe(200);
  const payload = (await minted.json()) as { ticket: string };
  const parsed = parsePairingTicket(payload.ticket);
  expect(parsed).toBeDefined();
  if (!parsed) throw new Error('ticket did not parse');
  expect(parsed.gw).toBe('endpoint-ticket');
  expect(f.tickets.redeem(parsed.t, parsed.s)).toMatchObject({
    vaultId: 'vault-a',
    role: 'write',
  });
});

test('an owner may delegate owner role — a second admin device is grantable', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });

  const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a', role: 'admin' }),
  });
  expect(minted.status).toBe(200);
  const payload = (await minted.json()) as { ticket: string; role: string };
  expect(payload.role).toBe('admin');
  const parsed = parsePairingTicket(payload.ticket);
  if (!parsed) throw new Error('ticket did not parse');
  expect(f.tickets.redeem(parsed.t, parsed.s)).toMatchObject({
    vaultId: 'vault-a',
    role: 'admin',
  });

  const nonsense = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a', role: 'superuser' }),
  });
  expect(nonsense.status).toBe(400);
  expect(await nonsense.json()).toMatchObject({ error: 'invalid_role' });
});

test('revocation cascades web sessions and closes the iroh transport', async () => {
  const f = await harness();
  const owner = f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const member = f.enrollments.enroll({
    endpointId: 'member-key',
    vaultId: 'vault-a',
    label: 'Member',
    role: 'write',
  });
  const tokenHash = hashControlToken('control-token');
  f.sessions.establish({
    tokenHash,
    vaultId: 'vault-a',
    shellOrigin: 'http://127.0.0.1:4173',
    deviceKey: 'member-key',
  });
  expect(f.sessions.find(tokenHash)).toBeDefined();

  const response = await fetch(
    `${f.base}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`,
    {
      method: 'DELETE',
      headers: deviceHeaders(owner.endpointId),
    },
  );
  expect(response.status).toBe(200);
  expect(f.enrollments.isEnrolled('member-key')).toBe(false);
  expect(f.sessions.find(tokenHash)).toBeUndefined();
  expect(f.onEndpointRevoked).toHaveBeenCalledWith('member-key');
});

test('revoking the last admin requires typing the vault name exactly', async () => {
  const f = await harness();
  const owner = f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`;

  const missing = await fetch(url, {
    method: 'DELETE',
    headers: deviceHeaders(owner.endpointId),
  });
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ error: 'last_admin_confirmation_required' });

  const wrong = await fetch(url, {
    method: 'DELETE',
    headers: deviceHeaders(owner.endpointId),
    body: JSON.stringify({ confirmLastAdmin: 'personal' }),
  });
  expect(wrong.status).toBe(409);

  const confirmed = await fetch(url, {
    method: 'DELETE',
    headers: deviceHeaders(owner.endpointId),
    body: JSON.stringify({ confirmLastAdmin: 'Personal' }),
  });
  expect(confirmed.status).toBe(200);
  expect(f.enrollments.listByVault('vault-a')).toEqual([]);
});

test('compute profile validates every capability and persists a valid update', async () => {
  const f = await harness();
  const device = f.enrollments.enroll({
    endpointId: 'device-key',
    vaultId: 'vault-a',
    label: 'Phone',
    role: 'write',
  });
  const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(device.enrollmentId)}/compute`;

  const invalid = await fetch(url, {
    method: 'PUT',
    headers: deviceHeaders(device.endpointId),
    body: JSON.stringify({ contributeWhileCharging: true, capabilities: { previews: true } }),
  });
  expect(invalid.status).toBe(400);

  const capabilities = {
    previews: true,
    poster: false,
    pdfText: true,
    ocr: false,
    embedding: true,
    transcript: false,
    edgeSeal: true,
    backgroundTransfer: false,
  };
  const updated = await fetch(url, {
    method: 'PUT',
    headers: deviceHeaders(device.endpointId),
    body: JSON.stringify({ contributeWhileCharging: true, capabilities }),
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    device: { compute: { contributeWhileCharging: true, capabilities } },
  });
  expect(f.enrollments.get(device.endpointId, device.vaultId)?.compute).toMatchObject({
    contributeWhileCharging: true,
    capabilities,
  });
});

/*
 * Branch coverage the #566 rewrite dropped (issue #568 item L).
 *
 * `devices-routes.test.ts` shrank from 18 tests to 5, leaving these live
 * branches unexercised: DELETE idempotency, the 405s, the foreign-vault 404,
 * peer-delete 403, self-unpair by a non-owner, `vault_required`, the
 * no-endpoint 409, and the `uninitialized` 409. Each is a refusal or a
 * safe-default that would fail silently — every one returns a plausible-
 * looking status, so nothing downstream would notice a regression.
 */

test('DELETE of an already-revoked enrollment is idempotent, not an error', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const member = f.enrollments.enroll({
    endpointId: 'member-key',
    vaultId: 'vault-a',
    label: 'Member',
    role: 'write',
  });
  const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`;

  const first = await fetch(url, { method: 'DELETE', headers: deviceHeaders('owner-key') });
  expect(first.status).toBe(200);
  // A client retrying after a dropped response must not see a 404 or a 500 —
  // the row is already gone and that IS the requested end state.
  const again = await fetch(url, { method: 'DELETE', headers: deviceHeaders('owner-key') });
  expect(again.status).toBe(200);
  expect(f.enrollments.isEnrolled('member-key')).toBe(false);
});

test('every devices route refuses a wrong method with 405', async () => {
  const f = await harness();
  const owner = f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const cases: Array<[string, string]> = [
    ['/centraid/_gateway/devices', 'POST'],
    ['/centraid/_gateway/devices/ticket', 'GET'],
    [`/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`, 'PATCH'],
    [`/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}/compute`, 'POST'],
  ];
  for (const [route, method] of cases) {
    const response = await fetch(`${f.base}${route}`, {
      method,
      headers: deviceHeaders('owner-key'),
    });
    expect(response.status, `${method} ${route}`).toBe(405);
    expect(await response.json()).toMatchObject({ error: 'method_not_allowed' });
  }
});

test('an enrollment in a foreign vault 404s rather than leaking its existence', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const foreign = f.enrollments.enroll({
    endpointId: 'stranger-key',
    vaultId: 'vault-b',
    label: 'Stranger',
    role: 'admin',
  });
  for (const route of [
    `/centraid/_gateway/devices/${encodeURIComponent(foreign.enrollmentId)}`,
    `/centraid/_gateway/devices/${encodeURIComponent(foreign.enrollmentId)}/compute`,
  ]) {
    const response = await fetch(`${f.base}${route}`, {
      method: route.endsWith('/compute') ? 'PUT' : 'DELETE',
      headers: deviceHeaders('owner-key'),
      ...(route.endsWith('/compute') ? { body: JSON.stringify({}) } : {}),
    });
    expect(response.status, route).toBe(404);
  }
  expect(f.enrollments.isEnrolled('stranger-key')).toBe(true);
});

test('a full-role device cannot revoke a peer but may unpair itself', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const member = f.enrollments.enroll({
    endpointId: 'member-key',
    vaultId: 'vault-a',
    label: 'Member',
    role: 'write',
  });
  const peer = f.enrollments.enroll({
    endpointId: 'peer-key',
    vaultId: 'vault-a',
    label: 'Peer',
    role: 'write',
  });

  // This is what stops a compromised `full` device from revoking its owner.
  const denied = await fetch(
    `${f.base}/centraid/_gateway/devices/${encodeURIComponent(peer.enrollmentId)}`,
    { method: 'DELETE', headers: deviceHeaders('member-key') },
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: 'not_admin' });
  expect(f.enrollments.isEnrolled('peer-key')).toBe(true);

  // Self-unpair by a non-owner stays allowed — leaving is always the device's
  // own call.
  const selfUnpair = await fetch(
    `${f.base}/centraid/_gateway/devices/${encodeURIComponent(member.enrollmentId)}`,
    { method: 'DELETE', headers: deviceHeaders('member-key') },
  );
  expect(selfUnpair.status).toBe(200);
  expect(f.enrollments.isEnrolled('member-key')).toBe(false);
});

test('minting a ticket with no resolvable vault answers vault_required', async () => {
  const f = await harness();
  // Enrolled in a vault the handler's `vaultName` does not know, and no
  // explicit target — nothing to scope the ticket to.
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-b',
    label: 'Owner',
    role: 'admin',
  });
  const anonymousVault = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({}),
  });
  expect(anonymousVault.status).toBe(404);

  const noVaults = await harness();
  noVaults.enrollments.enroll({
    endpointId: 'lonely-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const unknownTarget = await fetch(`${noVaults.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('lonely-key'),
    body: JSON.stringify({ vaultId: 'no-such-vault' }),
  });
  expect(unknownTarget.status).toBe(400);
  expect(await unknownTarget.json()).toMatchObject({ error: 'vault_required' });
});

test('a gateway with no iroh endpoint refuses to mint a dud ticket', async () => {
  const f = await harness({ endpointTicket: () => undefined });
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a' }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'no_iroh_endpoint' });
});

test('a pre-founding gateway refuses ordinary pairing with uninitialized', async () => {
  const f = await harness({ isUninitialized: () => true });
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a' }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'uninitialized' });
});
