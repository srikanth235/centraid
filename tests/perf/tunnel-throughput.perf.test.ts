import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {
  createTunnelClient,
  DeviceStore,
  parsePairQrPayload,
  startDesktopTunnel,
  startLocalProxy,
} from '@centraid/tunnel';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, onTestFinished, test } from 'vitest';

const OWNER = 'tests/perf/tunnel-throughput.perf.test.ts';

test('a paired local QUIC tunnel stays above the nightly payload throughput floor', async () => {
  const token = crypto.randomBytes(16).toString('hex');
  const payload = Buffer.alloc(16 * 1024 * 1024, 0x5a);
  const gateway = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(payload.length));
    res.end(payload);
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => gateway.close(() => resolve())));
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('perf gateway did not bind');

  const root = await tempDir('tunnel-throughput-');
  const store = DeviceStore.open(path.join(root, 'devices.json'));
  const desktop = await startDesktopTunnel({
    upstream: () => ({ baseUrl: `http://127.0.0.1:${address.port}`, token }),
    deviceStore: store,
    desktopName: 'Perf desktop',
    relays: 'disabled',
  });
  onTestFinished(() => desktop.close());
  const phone = await createTunnelClient({ relays: 'disabled' });
  onTestFinished(() => phone.close());
  const pairing = parsePairQrPayload(desktop.beginPairing().qrPayload);
  if (!pairing) throw new Error('invalid pairing payload');
  expect(
    await phone.pair(pairing.ticket, {
      code: pairing.code,
      deviceName: 'Perf phone',
      platform: 'test',
    }),
  ).toMatchObject({ ok: true });

  const connection = await phone.connect(desktop.ticket());
  onTestFinished(() => connection.close(0n, []));
  const proxy = await startLocalProxy(() => Promise.resolve(connection));
  onTestFinished(() => proxy.close());

  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${proxy.port}/payload.bin`);
  const reader = response.body!.getReader();
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
  }
  const durationMs = performance.now() - started;
  const mibPerSecond = received / (1024 * 1024) / (durationMs / 1_000);
  const throughputFloor = 5;
  const passed = response.status === 200 && received === payload.length && mibPerSecond >= 5;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Tunnel payload throughput',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'throughput', value: mibPerSecond, unit: 'MiB/s', budget: throughputFloor },
      { name: 'payload', value: received, unit: 'bytes', budget: payload.length },
      { name: 'wall clock', value: durationMs, unit: 'ms' },
    ],
  });
  expect(response.status).toBe(200);
  expect(received).toBe(payload.length);
  expect(mibPerSecond).toBeGreaterThanOrEqual(throughputFloor);
});
