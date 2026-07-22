import { expect, test } from 'vitest';
import http from 'node:http';
import { GATEWAY_SCHEMA_EPOCH, GATEWAY_VERSION, ROUTES } from '@centraid/protocol';
import { getHealth, handshake, listApps } from './client.ts';

function startMockGateway(): Promise<{
  url: string;
  token: string;
  close: () => Promise<void>;
}> {
  const token = 'test-token-abc';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers.authorization ?? '';
    if (url.pathname === ROUTES.gatewayInfo) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version: GATEWAY_VERSION,
          schemaEpoch: GATEWAY_SCHEMA_EPOCH,
          instanceId: 'mock-1',
          capabilities: {
            webSessions: true,
            devicePairing: true,
            tunnel: false,
            backupWal: true,
          },
        }),
      );
      return;
    }
    if (url.pathname === ROUTES.gatewayHealth) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'healthy' }));
      return;
    }
    if (url.pathname === ROUTES.appsList) {
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'alpha' }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        token,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          }),
      });
    });
  });
}

test('CLI client handshake + list against a real HTTP gateway surface', async () => {
  const gw = await startMockGateway();
  try {
    const hs = await handshake({ baseUrl: gw.url, token: gw.token });
    expect(hs.ok).toBe(true);
    if (!hs.ok) return;
    expect(hs.info.version).toBe(GATEWAY_VERSION);
    expect(hs.info.capabilities?.webSessions).toBe(true);

    const health = await getHealth({ baseUrl: gw.url, token: gw.token });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true });

    const apps = await listApps({ baseUrl: gw.url, token: gw.token });
    expect(apps.status).toBe(200);
    expect(apps.body).toEqual([{ id: 'alpha' }]);

    const denied = await listApps({ baseUrl: gw.url, token: 'wrong' });
    expect(denied.status).toBe(401);
  } finally {
    await gw.close();
  }
});
