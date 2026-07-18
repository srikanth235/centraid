import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { sendJson } from './route-helpers.js';

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function endpoint(body: unknown): Promise<string> {
  const server = http.createServer((_req, res) => {
    sendJson(res, 200, body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('gateway-native JSON compresses large responses asynchronously (#456 C8)', async () => {
  const body = { rows: Array.from({ length: 500 }, (_, id) => ({ id, title: `row-${id}` })) };
  const response = await fetch(await endpoint(body), { headers: { 'accept-encoding': 'br' } });
  expect(response.headers.get('content-encoding')).toBe('br');
  expect(response.headers.get('vary')).toContain('Accept-Encoding');
  expect(await response.json()).toEqual(body);
});

test('small JSON avoids compression overhead', async () => {
  const response = await fetch(await endpoint({ ok: true }), {
    headers: { 'accept-encoding': 'br' },
  });
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(await response.json()).toEqual({ ok: true });
});

test('encoding negotiation honors explicit q=0 exclusions', async () => {
  const body = { rows: Array.from({ length: 500 }, (_, id) => ({ id, title: `row-${id}` })) };
  const response = await fetch(await endpoint(body), {
    headers: { 'accept-encoding': 'br;q=0, gzip;q=0.7' },
  });
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(await response.json()).toEqual(body);
});
