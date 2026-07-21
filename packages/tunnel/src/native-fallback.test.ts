import crypto from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { DeviceStore } from './device-store.js';
import { startPreferredDesktopTunnel } from './desktop-tunnel.js';
import { startGatewayEndpoint } from './gateway-endpoint.js';

const native = vi.hoisted(() => ({
  gateway: async () => {
    throw new Error('native artifact unavailable');
  },
  desktop: async () => {
    throw new Error('native artifact unavailable');
  },
}));

vi.mock('./native-relay.js', () => ({
  startNativeGatewayRelay: native.gateway,
  startNativeDesktopTunnel: native.desktop,
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('gateway falls back to the JS relay when the native artifact cannot load', async () => {
  const endpoint = await startGatewayEndpoint({
    secretKey: crypto.randomBytes(32),
    upstream: () => ({ baseUrl: 'http://127.0.0.1:9', token: 'owner-token' }),
    authorize: () => false,
    pair: () => ({ ok: false, error: 'disabled' }),
    nativeControl: { secret: 'control-secret' },
    relays: 'disabled',
  });
  cleanups.push(() => endpoint.close());

  expect(endpoint.endpointId).toMatch(/^[a-z0-9]+$/);
});

test('desktop falls back to the JS relay when the native artifact cannot load', async () => {
  const dir = await tempDir('centraid-native-fallback-');
  const desktop = await startPreferredDesktopTunnel({
    secretKey: crypto.randomBytes(32),
    upstream: () => ({ baseUrl: 'http://127.0.0.1:9', token: 'owner-token' }),
    deviceStore: DeviceStore.open(path.join(dir, 'devices.json')),
    relays: 'disabled',
  });
  cleanups.push(() => desktop.close());

  expect(desktop.endpointId).toMatch(/^[a-z0-9]+$/);
});
