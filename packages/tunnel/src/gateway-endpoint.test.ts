/*
 * Gateway iroh endpoint (issue #289 phase 3).
 *
 * Boots a real gateway endpoint on loopback (relays disabled — offline),
 * fronted by a fake HTTP gateway that records the headers it receives,
 * and proves the trust story end-to-end:
 *
 *   - unenrolled device keys are refused at the QUIC layer;
 *   - ticket redemption over `centraid/gw-pair/1` enrolls the caller and
 *     answers the version-handshake material;
 *   - forwarded requests carry the injected device-identity headers, and
 *     a client-supplied copy of those headers is stripped (no spoofing);
 *   - revocation lands on live connections (per-stream authorize).
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTunnelClient, tunnelRequest } from './client.js';
import type { TunnelClient } from './client.js';
import { startGatewayEndpoint } from './gateway-endpoint.js';
import type { GatewayEndpointHandle, GatewayPairResponse } from './gateway-endpoint.js';
import { TUNNEL_AUTH_MODE_HEADER, TUNNEL_AUTH_WEB_SESSION } from './protocol.js';

const TOKEN = crypto.randomBytes(16).toString('hex');
const PROOF = crypto.randomBytes(16).toString('hex');

interface SeenRequest {
  url: string;
  device?: string;
  proof?: string;
  authorization?: string;
  cookie?: string;
  tunnelAuthMode?: string;
}

function startFakeGateway(seen: SeenRequest[]): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    if (
      (req.headers.authorization ?? '') !== `Bearer ${TOKEN}` &&
      req.headers.cookie !== '__centraid_app=test-session'
    ) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    seen.push({
      url: req.url ?? '',
      ...(typeof req.headers.authorization === 'string'
        ? { authorization: req.headers.authorization }
        : {}),
      ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
      ...(typeof req.headers[TUNNEL_AUTH_MODE_HEADER] === 'string'
        ? { tunnelAuthMode: req.headers[TUNNEL_AUTH_MODE_HEADER] }
        : {}),
      ...(typeof req.headers['x-centraid-device'] === 'string'
        ? { device: req.headers['x-centraid-device'] }
        : {}),
      ...(typeof req.headers['x-centraid-device-proof'] === 'string'
        ? { proof: req.headers['x-centraid-device-proof'] }
        : {}),
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('gateway endpoint', () => {
  const seen: SeenRequest[] = [];
  const enrolled = new Set<string>();
  const tickets = new Map<string, { secret: string; vaultId: string }>();
  let gateway: { server: http.Server; baseUrl: string };
  let endpoint: GatewayEndpointHandle;
  let device: TunnelClient;

  beforeAll(async () => {
    gateway = await startFakeGateway(seen);
    endpoint = await startGatewayEndpoint({
      upstream: () => ({ baseUrl: gateway.baseUrl, token: TOKEN }),
      authorize: (endpointId) => enrolled.has(endpointId),
      pair: (request, endpointId): GatewayPairResponse => {
        const ticket = tickets.get(request.ticketId);
        if (!ticket || ticket.secret !== request.secret) {
          return { ok: false, error: 'invalid_ticket' };
        }
        tickets.delete(request.ticketId);
        enrolled.add(endpointId);
        return {
          ok: true,
          gatewayName: 'test-vps',
          vaultId: ticket.vaultId,
          vaultName: 'Family',
          version: '0.1.0',
          schemaEpoch: 1,
        };
      },
      requestHeaders: (endpointId) => ({
        'x-centraid-device': endpointId,
        'x-centraid-device-proof': PROOF,
      }),
      relays: 'disabled',
    });
    device = await createTunnelClient({ relays: 'disabled' });
  });

  afterAll(async () => {
    await device.close();
    await endpoint.close();
    gateway.server.close();
  });

  it('refuses tunnel connections from unenrolled device keys', async () => {
    const connection = await device.connect(endpoint.ticket());
    await expect(async () => {
      await tunnelRequest(connection, { method: 'GET', target: '/centraid/_apps' });
      await connection.closed();
      await tunnelRequest(connection, { method: 'GET', target: '/centraid/_apps' });
    }).rejects.toThrow();
  });

  it('redeems a ticket exactly once and answers the handshake material', async () => {
    tickets.set('t1', { secret: 's3cret', vaultId: 'v-family' });

    const wrong = await device.pairGateway(endpoint.ticket(), {
      ticketId: 't1',
      secret: 'guess',
      deviceName: 'Mallory',
      platform: 'test',
    });
    expect(wrong.ok).toBe(false);

    const ok = await device.pairGateway(endpoint.ticket(), {
      ticketId: 't1',
      secret: 's3cret',
      deviceName: 'Priya laptop',
      platform: 'test',
    });
    expect(ok).toMatchObject({
      ok: true,
      vaultId: 'v-family',
      vaultName: 'Family',
      version: '0.1.0',
      schemaEpoch: 1,
    });
    expect(enrolled.has(device.endpointId)).toBe(true);

    // Burned: the same ticket never redeems twice (Mallory used it up? No —
    // success consumed it).
    const replay = await device.pairGateway(endpoint.ticket(), {
      ticketId: 't1',
      secret: 's3cret',
      deviceName: 'Replay',
      platform: 'test',
    });
    expect(replay.ok).toBe(false);
  });

  it('stamps the QUIC-proved device identity and strips spoofed copies', async () => {
    const connection = await device.connect(endpoint.ticket());
    seen.length = 0;
    const res = await tunnelRequest(connection, {
      method: 'GET',
      target: '/centraid/_apps',
      // A malicious client claims to be another device — must be stripped.
      headers: {
        'x-centraid-device': 'someone-else',
        'x-centraid-device-proof': 'forged',
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: '/centraid/_apps',
      device: device.endpointId,
      proof: PROOF,
    });
  });

  it('defers generated-app auth to its scoped web session and strips the mode marker', async () => {
    const connection = await device.connect(endpoint.ticket());
    seen.length = 0;
    const res = await tunnelRequest(connection, {
      method: 'GET',
      target: '/centraid/todos/',
      headers: {
        cookie: '__centraid_app=test-session',
        [TUNNEL_AUTH_MODE_HEADER]: TUNNEL_AUTH_WEB_SESSION,
      },
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      cookie: '__centraid_app=test-session',
      device: device.endpointId,
    });
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.tunnelAuthMode).toBeUndefined();
  });

  it('revocation lands on live connections', async () => {
    const connection = await device.connect(endpoint.ticket());
    const before = await tunnelRequest(connection, { method: 'GET', target: '/centraid/_apps' });
    expect(before.status).toBe(200);

    enrolled.delete(device.endpointId);
    await expect(async () => {
      await tunnelRequest(connection, { method: 'GET', target: '/centraid/_apps' });
      await connection.closed();
      await tunnelRequest(connection, { method: 'GET', target: '/centraid/_apps' });
    }).rejects.toThrow();
    enrolled.add(device.endpointId);
  });
});
