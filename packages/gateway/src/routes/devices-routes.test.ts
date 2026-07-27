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
import { makeDevicesRouteHandler } from './devices-routes.js';

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function harness(): Promise<{
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
    trust: 'owner',
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
        trust: 'owner',
      },
    ],
  });
});

test('owner mints a full-trust iroh ticket; ordinary devices cannot delegate', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    trust: 'owner',
  });
  f.enrollments.enroll({
    endpointId: 'full-key',
    vaultId: 'vault-a',
    label: 'Member',
    trust: 'full',
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
    trust: 'full',
  });
});

test('revocation cascades web sessions and closes the iroh transport', async () => {
  const f = await harness();
  const owner = f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    trust: 'owner',
  });
  const member = f.enrollments.enroll({
    endpointId: 'member-key',
    vaultId: 'vault-a',
    label: 'Member',
    trust: 'full',
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

test('revoking the last owner requires typing the vault name exactly', async () => {
  const f = await harness();
  const owner = f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    trust: 'owner',
  });
  const url = `${f.base}/centraid/_gateway/devices/${encodeURIComponent(owner.enrollmentId)}`;

  const missing = await fetch(url, {
    method: 'DELETE',
    headers: deviceHeaders(owner.endpointId),
  });
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ error: 'last_owner_confirmation_required' });

  const wrong = await fetch(url, {
    method: 'DELETE',
    headers: deviceHeaders(owner.endpointId),
    body: JSON.stringify({ confirmLastOwner: 'personal' }),
  });
  expect(wrong.status).toBe(409);

  const confirmed = await fetch(url, {
    method: 'DELETE',
    headers: deviceHeaders(owner.endpointId),
    body: JSON.stringify({ confirmLastOwner: 'Personal' }),
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
    trust: 'full',
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
