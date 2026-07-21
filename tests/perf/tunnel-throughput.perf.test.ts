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
  // Measured baseline (2026-07-19, darwin arm64 loopback, 16 MiB payload):
  // 5.1–7.5 MiB/s across three runs. This exercises the JS fallback relay —
  // `startDesktopTunnel` is the pure-JS path, and neither this machine nor the
  // nightly perf lane (.github/workflows/e2e.yml builds no native addon) ships
  // `centraid-tunnel-native.*.node`, so the QUIC data plane runs boxed through
  // JS. That is precisely the plane where the Array<number> boxing regression
  // lives, so a gross reintroduction (throughput collapse) still trips here.
  // Floor = measured_min ÷ 3 ≈ 5.1 / 3 ≈ 1.7; set to 1.5 for loopback variance
  // headroom. The native fast path is NOT measured by this lane.
  const throughputFloor = 1.5;
  const passed =
    response.status === 200 && received === payload.length && mibPerSecond >= throughputFloor;
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
