import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTunnelClient, startLocalProxy, tunnelRequest } from './client.js';
import type { TunnelClient } from './client.js';
import { startDesktopTunnel } from './desktop-tunnel.js';
import type { DesktopTunnelHandle } from './desktop-tunnel.js';
import { DeviceStore, sanitizeDeviceName } from './device-store.js';
import { parsePairQrPayload } from './protocol.js';

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = crypto.randomBytes(16).toString('hex');

// A stand-in for the loopback gateway: bearer-gated HTML + module
// subresource + JSON echo + SSE — the exact request shapes that were broken
// on mobile (issue #263 P0s #2 and #3).
function startFakeGateway(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url === '/centraid/demo/') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><script type="module" src="app.js"></script></html>');
      return;
    }
    if (req.url === '/centraid/demo/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('import "./kit.js";');
      return;
    }
    if (req.url === '/centraid/_changes') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
      setTimeout(() => res.write('data: {"n":2}\n\n'), 120);
      setTimeout(() => res.end(), 260);
      return;
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('device store', () => {
  it('persists, replaces on re-pair, and revokes', () => {
    const dir = tempDirSync('centraid-tunnel-');
    const file = path.join(dir, 'devices.json');
    const store = DeviceStore.open(file);
    const a = store.add({
      name: 'Pixel',
      platform: 'android',
      endpointId: 'ep-a',
    });
    store.add({ name: 'iPhone', platform: 'ios', endpointId: 'ep-b' });
    expect(DeviceStore.open(file).list()).toHaveLength(2);

    // Re-pairing the same endpoint replaces, never duplicates.
    const a2 = store.add({
      name: 'Pixel 9',
      platform: 'android',
      endpointId: 'ep-a',
    });
    expect(store.list()).toHaveLength(2);
    expect(store.findByEndpointId('ep-a')?.name).toBe('Pixel 9');
    expect(a2.deviceId).not.toBe(a.deviceId);

    expect(store.remove(a2.deviceId)?.endpointId).toBe('ep-a');
    expect(DeviceStore.open(file).findByEndpointId('ep-a')).toBeUndefined();
  });

  it('sanitizes device names', () => {
    expect(sanitizeDeviceName('  Srikanth\u0000s iPhone\n ')).toBe('Srikanths iPhone');
    expect(sanitizeDeviceName('\u0007')).toBe('Phone');
    expect(sanitizeDeviceName('x'.repeat(200))).toHaveLength(64);
  });
});

describe('tunnel end to end', () => {
  let gateway: { server: http.Server; baseUrl: string };
  let desktop: DesktopTunnelHandle;
  let store: DeviceStore;
  let phone: TunnelClient;

  beforeAll(async () => {
    gateway = await startFakeGateway();
    const dir = tempDirSync('centraid-tunnel-');
    store = DeviceStore.open(path.join(dir, 'devices.json'));
    desktop = await startDesktopTunnel({
      upstream: () => ({ baseUrl: gateway.baseUrl, token: TOKEN }),
      deviceStore: store,
      desktopName: 'Test Desktop',
      relays: 'disabled',
    });
    phone = await createTunnelClient({ relays: 'disabled' });
  });

  afterAll(async () => {
    await phone.close();
    await desktop.close();
    gateway.server.close();
  });

  it('refuses tunnel connections from unpaired devices', async () => {
    const stranger = await createTunnelClient({ relays: 'disabled' });
    try {
      const connection = await stranger.connect(desktop.ticket());
      // The desktop closes with CLOSE_UNAUTHORIZED; the first stream use fails.
      await expect(async () => {
        await tunnelRequest(connection, {
          method: 'GET',
          target: '/centraid/demo/',
        });
        await connection.closed();
        await tunnelRequest(connection, {
          method: 'GET',
          target: '/centraid/demo/',
        });
      }).rejects.toThrow(Error);
    } finally {
      await stranger.close();
    }
  });

  it('rejects a wrong pairing code and accepts the real one exactly once', async () => {
    const pairing = desktop.beginPairing();
    const payload = parsePairQrPayload(pairing.qrPayload);
    expect(payload?.ticket).toBeTruthy();

    const wrong = await phone.pair(payload!.ticket, {
      code: 'not-the-code',
      deviceName: 'Mallory',
      platform: 'ios',
    });
    expect(wrong).toStrictEqual({ ok: false, error: 'invalid_code' });

    const ok = await phone.pair(payload!.ticket, {
      code: payload!.code,
      deviceName: 'Test iPhone',
      platform: 'ios',
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('expected successful pairing');
    expect(ok.desktopName).toBe('Test Desktop');
    expect(store.findByEndpointId(phone.endpointId)?.name).toBe('Test iPhone');

    // One-time: the code is consumed.
    const replay = await phone.pair(payload!.ticket, {
      code: payload!.code,
      deviceName: 'Replay',
      platform: 'ios',
    });
    expect(replay).toStrictEqual({ ok: false, error: 'invalid_code' });
  });

  it('forwards GET/POST with the bearer attached, through the localhost proxy', async () => {
    const connection = await phone.connect(desktop.ticket());
    const proxy = await startLocalProxy(() => Promise.resolve(connection));
    try {
      const base = `http://127.0.0.1:${proxy.port}`;

      const html = await fetch(`${base}/centraid/demo/`);
      expect(html.status).toBe(200);
      await expect(html.text()).resolves.toContain('app.js');

      // The ES-module subresource case that defeated the asset-inliner.
      const moduleResponse = await fetch(`${base}/centraid/demo/app.js`);
      expect(moduleResponse.status).toBe(200);
      await expect(moduleResponse.text()).resolves.toContain('kit.js');

      const post = await fetch(`${base}/centraid/_tool/centraid_write`, {
        method: 'POST',
        body: 'hello-through-the-pipe',
      });
      await expect(post.json()).resolves.toStrictEqual({
        echoed: 'hello-through-the-pipe',
      });

      // Concurrent requests multiplex over one QUIC connection.
      const results = await Promise.all([
        fetch(`${base}/centraid/demo/`),
        fetch(`${base}/centraid/demo/app.js`),
        fetch(`${base}/centraid/_tool/x`, { method: 'POST', body: 'z' }),
      ]);
      expect(results.map((r) => r.status)).toStrictEqual([200, 200, 200]);
    } finally {
      await proxy.close();
      connection.close(0n, []);
    }
  });

  it('streams SSE events incrementally (the EventSource P0)', async () => {
    const connection = await phone.connect(desktop.ticket());
    const proxy = await startLocalProxy(() => Promise.resolve(connection));
    try {
      const startedAt = Date.now();
      const response = await fetch(`http://127.0.0.1:${proxy.port}/centraid/_changes`);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body!.getReader();
      const arrivals: Array<{ at: number; text: string }> = [];
      const readNext = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) return;
        arrivals.push({
          at: Date.now() - startedAt,
          text: Buffer.from(value).toString('utf8'),
        });
        return readNext();
      };
      await readNext();
      expect(arrivals.length).toBeGreaterThanOrEqual(2);
      // The second event must arrive ~120ms after the first — streamed, not buffered.
      expect(arrivals.at(-1)!.at - arrivals[0]!.at).toBeGreaterThanOrEqual(80);
    } finally {
      await proxy.close();
      connection.close(0n, []);
    }
  });

  it('revocation drops live connections and blocks new ones', async () => {
    const device = store.findByEndpointId(phone.endpointId);
    expect(device).toBeTruthy();
    const connection = await phone.connect(desktop.ticket());
    const first = await tunnelRequest(connection, {
      method: 'GET',
      target: '/centraid/demo/',
    });
    expect(first.status).toBe(200);

    desktop.revokeDevice(device!.deviceId);
    await connection.closed();

    const again = await phone.connect(desktop.ticket());
    await expect(async () => {
      await tunnelRequest(again, { method: 'GET', target: '/centraid/demo/' });
      await again.closed();
      await tunnelRequest(again, { method: 'GET', target: '/centraid/demo/' });
    }).rejects.toThrow(Error);
  });

  it('answers 503 when the gateway is not running', async () => {
    const pairing = desktop.beginPairing();
    const payload = parsePairQrPayload(pairing.qrPayload)!;
    const device = await createTunnelClient({ relays: 'disabled' });
    try {
      await device.pair(payload.ticket, {
        code: payload.code,
        deviceName: 'D2',
        platform: 'android',
      });
      const brokenUpstream = await startDesktopTunnel({
        upstream: () => undefined,
        deviceStore: store,
        relays: 'disabled',
      });
      // Re-pair against the second tunnel so its allowlist admits the device.
      const p2 = brokenUpstream.beginPairing();
      const payload2 = parsePairQrPayload(p2.qrPayload)!;
      await device.pair(payload2.ticket, {
        code: payload2.code,
        deviceName: 'D2',
        platform: 'android',
      });
      const connection = await device.connect(brokenUpstream.ticket());
      const response = await tunnelRequest(connection, {
        method: 'GET',
        target: '/centraid/demo/',
      });
      expect(response.status).toBe(503);
      connection.close(0n, []);
      await brokenUpstream.close();
    } finally {
      await device.close();
    }
  });
});
