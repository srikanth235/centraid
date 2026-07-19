import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createTunnelClient, tunnelRequest, type TunnelClient } from './client.js';
import { DeviceStore } from './device-store.js';
import {
  startGatewayEndpoint,
  type GatewayEndpointHandle,
  type GatewayPairResponse,
} from './gateway-endpoint.js';
import { startNativeDesktopTunnel } from './native-relay.js';

const CONTROL_SECRET = 'native-control-secret-0123456789abcdef';

describe.skipIf(process.env.CENTRAID_RUN_NATIVE_TUNNEL !== '1')('native gateway relay', () => {
  let server: http.Server;
  let endpoint: GatewayEndpointHandle;
  let client: TunnelClient;
  const boxedAuthorize = vi.fn(() => false);
  const boxedPair = vi.fn((): GatewayPairResponse => ({ ok: false }));
  const controlCalls: Array<{ path: string; endpointId: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://gateway.local');
        if (url.pathname.startsWith('/centraid/_gateway/tunnel/')) {
          if (req.headers['x-centraid-data-plane-secret'] !== CONTROL_SECRET) {
            res.writeHead(403).end();
            return;
          }
          const endpointId = url.searchParams.get('endpointId') ?? '';
          controlCalls.push({ path: url.pathname, endpointId });
          res.setHeader('content-type', 'application/json');
          if (url.pathname.endsWith('/authorize')) {
            res.end(JSON.stringify({ allowed: true, headers: { 'x-native-device': endpointId } }));
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString()) as { ticketId?: string };
          res.end(
            JSON.stringify({
              ok: request.ticketId === 'ticket',
              gatewayId: 'native-gateway',
              vaultId: 'vault',
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-seen-device': String(req.headers['x-native-device'] ?? ''),
        });
        res.end(Buffer.concat(chunks));
      })().catch((error) => res.destroy(error as Error));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    endpoint = await startGatewayEndpoint({
      secretKey: randomBytes(32),
      upstream: () => ({ baseUrl: `http://127.0.0.1:${port}`, token: 'gateway-token' }),
      authorize: boxedAuthorize,
      pair: boxedPair,
      nativeControl: { secret: CONTROL_SECRET },
      relays: 'disabled',
    });
    client = await createTunnelClient({ relays: 'disabled' });
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await endpoint?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  test('owns pairing and streamed request/response bytes inside Rust', async () => {
    await expect(
      client.pairGateway(endpoint.ticket(), {
        ticketId: 'ticket',
        secret: 'secret',
        deviceName: 'native test',
        platform: process.platform,
      }),
    ).resolves.toMatchObject({ ok: true, gatewayId: 'native-gateway' });

    const connection = await client.connect(endpoint.ticket());
    const body = randomBytes(2 * 1024 * 1024 + 17);
    const response = await tunnelRequest(connection, {
      method: 'POST',
      target: '/echo',
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-seen-device']).toBe(client.endpointId);
    expect(response.body).toEqual(body);
    expect(controlCalls.map(({ path }) => path)).toContain('/centraid/_gateway/tunnel/pair');
    expect(boxedAuthorize).not.toHaveBeenCalled();
    expect(boxedPair).not.toHaveBeenCalled();

    await endpoint.revokeEndpoint(client.endpointId);
    await expect(
      tunnelRequest(connection, {
        method: 'GET',
        target: '/revoked-live-connection',
      }),
    ).rejects.toThrow();
    connection.close(0n, []);
  }, 30_000);

  test('is the production desktop relay for legacy pairing and multi-megabyte bodies', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-native-desktop-'));
    const desktopClient = await createTunnelClient({ relays: 'disabled' });
    const port = (server.address() as AddressInfo).port;
    let upstream: { baseUrl: string; token: string } | undefined = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'desktop-gateway-token',
    };
    const paired = vi.fn();
    const desktop = await startNativeDesktopTunnel({
      secretKey: randomBytes(32),
      deviceStore: DeviceStore.open(path.join(dir, 'devices.json')),
      desktopName: 'Native desktop',
      upstream: () => upstream,
      relays: 'disabled',
      onPaired: paired,
    });
    try {
      const pairing = desktop.beginPairing();
      await expect(
        desktopClient.pair(desktop.ticket(), {
          code: pairing.code,
          deviceName: 'Native phone',
          platform: process.platform,
        }),
      ).resolves.toMatchObject({ ok: true, desktopName: 'Native desktop' });
      expect(paired).toHaveBeenCalledOnce();

      const connection = await desktopClient.connect(desktop.ticket());
      const body = randomBytes(2 * 1024 * 1024 + 31);
      const response = await tunnelRequest(connection, {
        method: 'POST',
        target: '/desktop-echo',
        body,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(body);

      upstream = undefined;
      const unavailable = await tunnelRequest(connection, {
        method: 'POST',
        target: '/desktop-offline',
        body: Buffer.from('does-not-enter-js'),
      });
      expect(unavailable.status).toBe(503);
      connection.close(0n, []);
    } finally {
      await desktopClient.close();
      await desktop.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
